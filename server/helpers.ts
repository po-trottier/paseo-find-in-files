import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { TextDecoder } from "node:util";
import { MAX_FILE_BYTES } from "./files";

const utf8 = new TextDecoder("utf-8", { fatal: true });

export type ResolvedWorkspaceFile = { absolutePath: string; relativePath: string };
export type WorkspaceFile =
  | { kind: "text"; path: string; content: string }
  | { kind: "binary"; path: string }
  | { kind: "too-large"; path: string; maxBytes: number };

function assertRelativePath(relativePath: string): void {
  const segments = relativePath.split(process.platform === "win32" ? /[\\/]/ : "/");
  if (!relativePath || /[\x00-\x1f\x7f]/.test(relativePath) || path.isAbsolute(relativePath) || path.win32.isAbsolute(relativePath) || /^[A-Za-z]:/.test(relativePath) || relativePath.split(/[\\/]/).includes("..")) {
    throw new Error("The file path must stay inside the workspace.");
  }
  if (process.platform === "win32" && segments.some((segment) => /[<>:"|?*]|[. ]$/.test(segment) || /^(?:con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:[. ]|$)/i.test(segment))) {
    throw new Error("The file path uses unsafe Windows syntax.");
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
  const beforeOpen = await stat(file.absolutePath);
  if (beforeOpen.size > MAX_FILE_BYTES) return { kind: "too-large", path: file.relativePath, maxBytes: MAX_FILE_BYTES };
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
