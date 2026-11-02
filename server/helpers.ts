import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";
import { TextDecoder } from "node:util";
import type { SearchEvent, SearchInput, SearchMatch } from "../shared/contracts";

const MAX_MATCHES = 2000;
const MAX_JSON_BYTES = 1024 * 1024;
const MAX_LINE_BYTES = 16 * 1024;
const MAX_RESULT_BYTES = 2 * 1024 * 1024;
const MAX_BATCH_CHARS = 64 * 1024;
const MAX_BATCH_MATCHES = 64;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export type ParsedRgLine = { path: string; matches: SearchMatch[]; truncated: boolean };
export type ResolvedWorkspaceFile = { absolutePath: string; relativePath: string };
export type WorkspaceFile =
  | { kind: "text"; path: string; content: string }
  | { kind: "binary"; path: string }
  | { kind: "too-large"; path: string; maxBytes: number };

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid ripgrep JSON object.");
  }
  return value as Record<string, unknown>;
}

function rgBytes(value: unknown, field: string): Buffer {
  const data = object(value);
  if (typeof data.text === "string") return Buffer.from(data.text, "utf8");
  if (typeof data.bytes === "string" && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data.bytes)) {
    return Buffer.from(data.bytes, "base64");
  }
  throw new Error(`Invalid ripgrep ${field} field.`);
}

function assertRelativePath(relativePath: string): void {
  const segments = relativePath.split(/[\\/]/);
  if (!relativePath || /[\x00-\x1f\x7f]/.test(relativePath) || path.isAbsolute(relativePath) || path.win32.isAbsolute(relativePath) || /^[A-Za-z]:/.test(relativePath) || segments.includes("..")) {
    throw new Error("The file path must stay inside the workspace.");
  }
  if (process.platform === "win32" && segments.some((segment) => /[<>:"|?*]|[. ]$/.test(segment) || /^(?:con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:[. ]|$)/i.test(segment))) {
    throw new Error("The file path uses unsafe Windows syntax.");
  }
}

export function parseRgLine(jsonLine: string): ParsedRgLine | null {
  if (Buffer.byteLength(jsonLine, "utf8") > MAX_JSON_BYTES) {
    throw new Error("The ripgrep JSON record exceeds the 1 MiB limit.");
  }
  let message: Record<string, unknown>;
  try {
    message = object(JSON.parse(jsonLine));
  } catch (error) {
    throw new Error(`Invalid ripgrep JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (typeof message.type !== "string") throw new Error("The ripgrep JSON record has no type.");
  if (message.type !== "match") return null;
  const data = object(message.data);
  const pathBytes = rgBytes(data.path, "path");
  if (pathBytes.length > 32768) throw new Error("The ripgrep file path is too long.");
  let filePath: string;
  try {
    filePath = utf8.decode(pathBytes);
  } catch {
    throw new Error("ripgrep returned a file path that is not valid UTF-8.");
  }
  if (process.platform === "win32") filePath = filePath.replace(/\\/g, "/");
  filePath = filePath.replace(/^\.\//, "");
  assertRelativePath(filePath);
  if (!Number.isSafeInteger(data.line_number) || (data.line_number as number) < 1 || !Array.isArray(data.submatches)) {
    throw new Error("Invalid ripgrep match location.");
  }
  const bytes = rgBytes(data.lines, "lines");
  if (bytes.length > MAX_LINE_BYTES || bytes.includes(0)) return { path: filePath, matches: [], truncated: true };
  const text = bytes.toString("utf8").replace(/\r?\n$/, "");
  const matches: SearchMatch[] = [];
  for (let index = 0; index < Math.min(data.submatches.length, MAX_MATCHES); index++) {
    const value = data.submatches[index];
    const match = object(value);
    const start = match.start;
    const end = match.end;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || (start as number) < 0 || (end as number) < (start as number) || (end as number) > bytes.length) {
      throw new Error("Invalid ripgrep byte offsets.");
    }
    // ponytail: each offset scans at most 16 KiB. Use a byte map if this limit grows.
    matches.push({
      line: data.line_number as number,
      text,
      start: Math.min(text.length, bytes.subarray(0, start as number).toString("utf8").length),
      end: Math.min(text.length, bytes.subarray(0, end as number).toString("utf8").length),
    });
  }
  return { path: filePath, matches, truncated: data.submatches.length > MAX_MATCHES };
}

async function* rgLines(stream: Readable): AsyncGenerator<string | null> {
  let parts: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream as AsyncIterable<Buffer>) {
    let start = 0;
    while (start < chunk.length) {
      const newline = chunk.indexOf(10, start);
      const end = newline < 0 ? chunk.length : newline;
      size += end - start;
      if (size > MAX_JSON_BYTES) {
        yield null;
        return;
      }
      if (end > start) parts.push(chunk.subarray(start, end));
      if (newline < 0) break;
      const line = Buffer.concat(parts, size).toString("utf8");
      parts = [];
      size = 0;
      if (line) yield line;
      start = newline + 1;
    }
  }
  if (size) yield Buffer.concat(parts, size).toString("utf8");
}

export async function runSearch(
  directory: string,
  input: SearchInput,
  signal: AbortSignal,
  push: (event: SearchEvent) => Promise<void>,
): Promise<void> {
  if (signal.aborted) return;
  if (!input.query) {
    await push({ type: "done", totalMatches: 0, totalFiles: 0, truncated: false });
    return;
  }
  try {
    const root = await realpath(directory);
    if (!(await stat(root)).isDirectory()) throw new Error("The workspace directory is not a directory.");
    if (signal.aborted) return;
    const args = ["--no-config", "--json", "--line-number", input.caseSensitive ? "--case-sensitive" : "--ignore-case", "--max-columns", "300", "--max-columns-preview"];
    if (!input.regex) args.push("--fixed-strings");
    if (input.wholeWord) args.push("--word-regexp");
    const include = input.include?.trim();
    const exclude = input.exclude?.trim();
    if (include) args.push("--glob", include);
    if (exclude) args.push("--glob", `!${exclude}`);
    args.push("--", input.query, ".");
    const { promise: closed, resolve: resolveClosed } = Promise.withResolvers<{ code: number | null; signal: NodeJS.Signals | null }>();
    const child = spawn("rg", args, { cwd: root, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let processError: Error | undefined;
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { stderr += chunk.slice(0, Math.max(0, 8192 - stderr.length)); });
    child.once("error", (error) => { processError = error; });
    child.once("close", (code, exitSignal) => resolveClosed({ code, signal: exitSignal }));
    const stop = () => {
      if (!child.killed && child.exitCode === null && child.signalCode === null) child.kill();
      child.stdout.destroy();
    };
    child.stderr.on("error", (error) => { processError = error; stop(); });
    signal.addEventListener("abort", stop, { once: true });
    if (signal.aborted) stop();
    let totalMatches = 0;
    let totalResultSize = 0;
    const files = new Set<string>();
    let truncated = false;
    let capped = false;
    let pendingPath = "";
    let pending: SearchMatch[] = [];
    let pendingChars = 0;
    const flush = async () => {
      if (pending.length && !signal.aborted) await push({ type: "matches", path: pendingPath, matches: pending });
      pending = [];
      pendingChars = 0;
    };
    let failure: unknown;
    let exit: { code: number | null; signal: NodeJS.Signals | null };
    try {
      records: for await (const line of rgLines(child.stdout)) {
        if (signal.aborted) break;
        if (line === null) {
          truncated = capped = true;
          stop();
          break;
        }
        const parsed = parseRgLine(line);
        if (!parsed) continue;
        truncated ||= parsed.truncated;
        const rowSize = Buffer.byteLength(parsed.path, "utf8") + Buffer.byteLength(parsed.matches[0]?.text ?? "", "utf8") + 128;
        for (const match of parsed.matches) {
          if (signal.aborted) break records;
          if (totalResultSize + rowSize > MAX_RESULT_BYTES) {
            truncated = capped = true;
            stop();
            break records;
          }
          if (pendingPath !== parsed.path || pending.length >= MAX_BATCH_MATCHES || pendingChars + match.text.length > MAX_BATCH_CHARS) await flush();
          if (signal.aborted) break records;
          pendingPath = parsed.path;
          pending.push(match);
          pendingChars += match.text.length;
          totalResultSize += rowSize;
          totalMatches++;
          files.add(parsed.path);
          if (totalMatches >= MAX_MATCHES) {
            truncated = capped = true;
            stop();
            break records;
          }
        }
      }
    } catch (error) {
      if (!signal.aborted && !capped) failure = error;
      stop();
    } finally {
      if (signal.aborted || capped) stop();
      exit = await closed;
      signal.removeEventListener("abort", stop);
    }
    if (signal.aborted) return;
    if (processError) {
      if ((processError as NodeJS.ErrnoException).code === "ENOENT") throw new Error("ripgrep (rg) was not found on the daemon PATH.");
      throw new Error(`ripgrep failed: ${processError.message}`);
    }
    if (failure) throw failure;
    if (exit.code !== 0 && exit.code !== 1 && !(capped && child.killed && exit.signal)) {
      throw new Error(stderr.trim() || `ripgrep exited ${exit.signal ? `with signal ${exit.signal}` : `with code ${exit.code}`}.`);
    }
    await flush();
    if (!signal.aborted) await push({ type: "done", totalMatches, totalFiles: files.size, truncated });
  } catch (error) {
    if (!signal.aborted) await push({ type: "error", message: error instanceof Error ? error.message : String(error) });
  }
}

export async function resolveWorkspaceFile(directory: string, relativePath: string): Promise<ResolvedWorkspaceFile> {
  assertRelativePath(relativePath);
  const root = await realpath(directory);
  if (!(await stat(root)).isDirectory()) throw new Error("The workspace directory is not a directory.");
  const absolutePath = await realpath(path.resolve(root, relativePath));
  const relative = path.relative(root, absolutePath);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("The file path must stay inside the workspace.");
  }
  if (!(await stat(absolutePath)).isFile()) throw new Error("The workspace path is not an ordinary file.");
  return { absolutePath, relativePath: relative.split(path.sep).join("/") };
}

export async function readWorkspaceFile(directory: string, relativePath: string): Promise<WorkspaceFile> {
  const file = await resolveWorkspaceFile(directory, relativePath);
  const handle = await open(file.absolutePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error("The workspace path is not an ordinary file.");
    if (info.size > MAX_FILE_BYTES) return { kind: "too-large", path: file.relativePath, maxBytes: MAX_FILE_BYTES };
    const buffer = Buffer.allocUnsafe(info.size);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await handle.read(buffer, size, buffer.length - size, size);
      if (!bytesRead) break;
      size += bytesRead;
    }
    const finalSize = (await handle.stat()).size;
    if (finalSize > MAX_FILE_BYTES) return { kind: "too-large", path: file.relativePath, maxBytes: MAX_FILE_BYTES };
    if (finalSize !== info.size || size !== info.size) throw new Error("The file changed while it was read.");
    const bytes = buffer.subarray(0, size);
    if (bytes.includes(0)) return { kind: "binary", path: file.relativePath };
    try {
      return { kind: "text", path: file.relativePath, content: utf8.decode(bytes) };
    } catch {
      return { kind: "binary", path: file.relativePath };
    }
  } finally {
    await handle.close();
  }
}

export function buildEditorCommand(absolutePath: string, line: number, column: number, platform: NodeJS.Platform = process.platform): { command: string; args: string[]; url: string } {
  if (!Number.isInteger(line) || line < 1 || line > 2147483647 || !Number.isInteger(column) || column < 1 || column > 2147483647) {
    throw new Error("The editor line and column must be positive integers.");
  }
  const commands: Partial<Record<NodeJS.Platform, string>> = { win32: "explorer.exe", darwin: "open", linux: "xdg-open" };
  const command = commands[platform];
  if (!command) throw new Error(`The editor opener does not support ${platform}.`);
  let filePath = absolutePath;
  if (platform === "win32") {
    filePath = filePath.replace(/^\\\\\?\\UNC\\/i, "\\\\").replace(/^\\\\\?\\/, "");
    if (!/^(?:[A-Za-z]:[\\/]|\\\\[^\\]+\\[^\\]+)/.test(filePath)) throw new Error("The editor file path must be absolute.");
    filePath = filePath.replace(/\\/g, "/");
  } else if (!path.posix.isAbsolute(filePath)) {
    throw new Error("The editor file path must be absolute.");
  }
  const encoded = filePath.split("/").map((segment, index) => platform === "win32" && index === 0 && /^[A-Za-z]:$/.test(segment) ? segment : encodeURIComponent(segment)).join("/");
  const url = `vscode://file${encoded.startsWith("/") ? "" : "/"}${encoded}:${line}:${column}`;
  return { command, args: [url], url };
}

export async function openEditor(absolutePath: string, line: number, column: number): Promise<void> {
  const { command, args } = buildEditorCommand(absolutePath, line, column);
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const child = spawn(command, args, { shell: false, windowsHide: true, stdio: "ignore" });
  child.once("error", reject);
  if (process.platform === "win32") child.once("spawn", () => resolve());
  child.once("close", (code, signal) => code === 0 ? resolve() : reject(new Error(`The editor opener exited ${signal ? `with signal ${signal}` : `with code ${code}`}.`)));
  await promise;
}
