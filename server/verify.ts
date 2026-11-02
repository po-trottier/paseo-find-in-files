import { Worker } from "node:worker_threads";
import { braceExpand, makeRe } from "minimatch";
import type { SearchInput, SearchMatch } from "../shared/contracts";

export type VerificationResult = {
  files: { path: string; matches: SearchMatch[] }[];
  totalMatches: number;
  totalFiles: number;
  truncated: boolean;
};

type CompiledGlob = { source: string; flags: string } | null;
type WorkerMessage = { result: VerificationResult } | { error: string };

function compileGlob(value: string | undefined, field: "include" | "exclude"): CompiledGlob {
  let pattern = value?.trim();
  if (!pattern) return null;
  try {
    if (pattern.length > 4096) throw new Error("The pattern exceeds 4096 characters.");
    pattern = pattern.split("\\").join("/");
    while (pattern.startsWith("./")) pattern = pattern.slice(2);
    const anchored = pattern.startsWith("/");
    if (anchored) pattern = pattern.slice(1);
    if (!pattern) throw new Error("The pattern is empty.");
    if (!anchored && !pattern.includes("/")) pattern = "**/" + pattern;
    if (pattern.endsWith("/")) pattern += "**";
    if (braceExpand(pattern, { braceExpandMax: 257 }).length > 256) throw new Error("The pattern exceeds 256 brace expansions.");
    const expression = makeRe(pattern, {
      dot: true,
      nonegate: true,
      nocomment: true,
      windowsPathsNoEscape: true,
      platform: "linux",
      braceExpandMax: 257,
    });
    if (!expression) throw new Error("The pattern cannot be compiled.");
    return { source: expression.source, flags: expression.flags };
  } catch (error) {
    throw new Error(`Invalid ${field} glob: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// Raw JavaScript keeps the worker independent of bundle helpers and file assets.
const workerSource = String.raw`
(async function () {
  const { parentPort, workerData } = require("node:worker_threads");
  const fs = require("node:fs/promises");
  const { constants } = require("node:fs");
  const path = require("node:path");
  const { TextDecoder } = require("node:util");
  const MAX_FILE_BYTES = 1024 * 1024;
  const MAX_MATCHES = 2000;
  const MAX_RESULT_BYTES = 2 * 1024 * 1024;
  // A result row shows a window of the line, so one long line (minified JSON) cannot fill the result budget.
  const CONTEXT_CHARS = 40;
  const SNIPPET_CHARS = 300;
  const utf8 = new TextDecoder("utf-8", { fatal: true });
  const skippedErrors = { ENOENT: true, ENOTDIR: true, EACCES: true, EPERM: true, ELOOP: true, EISDIR: true, ENXIO: true, EBUSY: true, EINVAL: true };
  let incomplete = false;

  function inside(root, candidate) {
    if (process.platform === "win32") {
      root = root.toLowerCase();
      candidate = candidate.toLowerCase();
    }
    const relative = path.relative(root, candidate);
    return relative === "" || (relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative));
  }

  function safeParts(relativePath) {
    if (typeof relativePath !== "string" || !relativePath || /[\x00-\x1f\x7f]/.test(relativePath) || path.isAbsolute(relativePath) || path.win32.isAbsolute(relativePath) || /^[A-Za-z]:/.test(relativePath)) return null;
    const parts = process.platform === "win32" ? relativePath.split(/[\\/]/) : relativePath.split("/");
    if (parts.some((part) => !part || part === "." || part === ".." || part.toLowerCase() === ".git")) return null;
    if (process.platform === "win32" && parts.some((part) => /[<>:"|?*]|[. ]$/.test(part) || /^(?:con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:[. ]|$)/i.test(part))) return null;
    return parts;
  }

  async function cloudRoots(root) {
    const blocked = [];
    for (const value of workerData.cloudRoots) {
      if (!value || !path.isAbsolute(value)) continue;
      const aliases = [path.resolve(value)];
      try { aliases.push(await fs.realpath(value)); } catch {}
      if (!aliases.some((alias) => inside(alias, root))) blocked.push(...aliases);
    }
    return blocked;
  }

  function inCloud(blocked, file) {
    return blocked.some((root) => inside(root, file));
  }

  async function segmentInfo(root, parts) {
    let current = root;
    let info;
    for (let index = 0; index < parts.length; index++) {
      current = path.join(current, parts[index]);
      info = await fs.lstat(current);
      if (info.isSymbolicLink() || (index < parts.length - 1 && !info.isDirectory())) return null;
    }
    return info;
  }

  async function readText(root, parts, blocked) {
    let handle;
    try {
      const absolutePath = path.resolve(root, ...parts);
      if (!inside(root, absolutePath) || inCloud(blocked, absolutePath)) return null;
      const before = await segmentInfo(root, parts);
      if (!before || !before.isFile() || before.size > MAX_FILE_BYTES) return null;
      const canonical = await fs.realpath(absolutePath);
      const pathKey = process.platform === "win32" ? absolutePath.toLowerCase() : absolutePath;
      const canonicalKey = process.platform === "win32" ? canonical.toLowerCase() : canonical;
      if (!inside(root, canonical) || canonicalKey !== pathKey || inCloud(blocked, canonical)) return null;
      handle = await fs.open(canonical, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
      const info = await handle.stat();
      if (!info.isFile() || info.size > MAX_FILE_BYTES) return null;
      if (info.dev !== before.dev || info.ino !== before.ino || info.size !== before.size || info.mtimeMs !== before.mtimeMs) {
        incomplete = true;
        return null;
      }
      const afterOpen = await fs.realpath(absolutePath);
      const afterOpenKey = process.platform === "win32" ? afterOpen.toLowerCase() : afterOpen;
      if (afterOpenKey !== canonicalKey || !inside(root, afterOpen) || inCloud(blocked, afterOpen) || !(await segmentInfo(root, parts))) return null;
      const bytes = Buffer.allocUnsafe(info.size);
      let length = 0;
      const prefixLength = Math.min(8192, bytes.length);
      while (length < prefixLength) {
        const read = await handle.read(bytes, length, prefixLength - length, length);
        if (!read.bytesRead) break;
        length += read.bytesRead;
      }
      if (bytes.subarray(0, length).includes(0)) return null;
      while (length < bytes.length) {
        const read = await handle.read(bytes, length, bytes.length - length, length);
        if (!read.bytesRead) break;
        length += read.bytesRead;
      }
      const finalInfo = await handle.stat();
      if (finalInfo.size > MAX_FILE_BYTES) return null;
      if (finalInfo.size !== info.size || finalInfo.mtimeMs !== info.mtimeMs || length !== info.size) {
        incomplete = true;
        return null;
      }
      try { return utf8.decode(bytes); } catch { return null; }
    } catch (error) {
      if (Object.hasOwn(skippedErrors, error && error.code)) {
        incomplete = true;
        return null;
      }
      throw error;
    } finally {
      if (handle) await handle.close();
    }
  }

  function matchesGlob(expression, relativePath) {
    if (!expression) return false;
    let end = relativePath.length;
    while (end > 0) {
      if (expression.test(relativePath.slice(0, end))) return true;
      end = relativePath.lastIndexOf("/", end - 1);
    }
    return false;
  }

  try {
    const { input } = workerData;
    const flags = input.caseSensitive ? "gu" : "giu";
    const source = input.regex ? input.query : input.query.replace(/[.*+?^$(){}|[\]\\]/g, "\\$&");
    let expression;
    try {
      expression = new RegExp(source, flags);
      if (input.wholeWord) expression = new RegExp("(?<![\\p{L}\\p{N}_])(?:" + source + ")(?![\\p{L}\\p{N}_])", flags);
    } catch (error) {
      throw new Error("Invalid regular expression: " + error.message);
    }
    const include = workerData.include && new RegExp(workerData.include.source, workerData.include.flags);
    const exclude = workerData.exclude && new RegExp(workerData.exclude.source, workerData.exclude.flags);
    const root = await fs.realpath(workerData.directory);
    if (!(await fs.stat(root)).isDirectory()) throw new Error("The workspace directory is not a directory.");
    const blocked = await cloudRoots(root);
    const files = [];
    const seen = new Set();
    let totalMatches = 0;
    let resultBytes = 256;
    let truncated = false;

    scan: for (const candidate of workerData.candidates) {
      const parts = safeParts(candidate);
      if (!parts) continue;
      const relativePath = parts.join("/");
      const key = process.platform === "win32" ? relativePath.toLowerCase() : relativePath;
      if (seen.has(key)) continue;
      seen.add(key);
      if ((include && !matchesGlob(include, relativePath)) || (exclude && matchesGlob(exclude, relativePath))) continue;
      const content = await readText(root, parts, blocked);
      if (content === null) continue;
      let file;
      let lineStart = 0;
      let lineNumber = 1;
      while (lineStart <= content.length) {
        let lineEnd = lineStart;
        while (lineEnd < content.length) {
          const code = content.charCodeAt(lineEnd);
          if (code === 10 || code === 13) break;
          lineEnd++;
        }
        const text = content.slice(lineStart, lineEnd);
        expression.lastIndex = 0;
        let match;
        while ((match = expression.exec(text)) !== null) {
          let from = match.index > CONTEXT_CHARS * 1.5 ? match.index - CONTEXT_CHARS : 0;
          if (from > 0 && (text.charCodeAt(from) & 0xfc00) === 0xdc00) from--;
          let to = Math.min(text.length, from + SNIPPET_CHARS);
          if (to < text.length && (text.charCodeAt(to - 1) & 0xfc00) === 0xd800) to--;
          const snippet = text.slice(from, to);
          const rowBytes = Buffer.byteLength(JSON.stringify(snippet), "utf8") + 112 + (file ? 0 : Buffer.byteLength(JSON.stringify(relativePath), "utf8") + 32);
          if (resultBytes + rowBytes > MAX_RESULT_BYTES || totalMatches >= MAX_MATCHES) {
            truncated = true;
            break scan;
          }
          if (!file) {
            file = { path: relativePath, matches: [] };
            files.push(file);
          }
          file.matches.push({ line: lineNumber, text: Buffer.from(snippet, "utf8").toString("utf8"), textStart: from, start: match.index, end: match.index + match[0].length });
          resultBytes += rowBytes;
          totalMatches++;
          if (totalMatches >= MAX_MATCHES) {
            truncated = true;
            break scan;
          }
          if (!match[0].length) {
            const codePoint = text.codePointAt(expression.lastIndex);
            expression.lastIndex += codePoint !== undefined && codePoint > 0xffff ? 2 : 1;
          }
        }
        if (lineEnd === content.length) break;
        lineStart = lineEnd + (content.charCodeAt(lineEnd) === 13 && content.charCodeAt(lineEnd + 1) === 10 ? 2 : 1);
        lineNumber++;
      }
    }
    parentPort.postMessage({ result: { files, totalMatches, totalFiles: files.length, truncated: truncated || incomplete } });
  } catch (error) {
    parentPort.postMessage({ error: error instanceof Error ? error.message : String(error) });
  } finally {
    parentPort.close();
  }
})();
`;

function canceled(): Error {
  const error = new Error("Search canceled.");
  error.name = "AbortError";
  return error;
}

export async function verifyFiles(
  directory: string,
  candidates: string[],
  input: SearchInput,
  signal: AbortSignal,
): Promise<VerificationResult> {
  if (signal.aborted) throw canceled();
  if (!input.query) return { files: [], totalMatches: 0, totalFiles: 0, truncated: false };
  const include = compileGlob(input.include, "include");
  const exclude = compileGlob(input.exclude, "exclude");
  if (signal.aborted) throw canceled();
  const cloudRoots = [process.env.OneDrive, process.env.OneDriveCommercial, process.env.OneDriveConsumer]
    .filter((value): value is string => typeof value === "string" && value.length > 0);
  const worker = new Worker(workerSource, {
    eval: true,
    execArgv: [],
    workerData: { directory, candidates, input, include, exclude, cloudRoots },
    resourceLimits: { maxOldGenerationSizeMb: 96, maxYoungGenerationSizeMb: 16, codeRangeSizeMb: 16 },
  });
  const { promise, resolve, reject } = Promise.withResolvers<VerificationResult>();
  let settled = false;
  let exited = false;
  let terminationRequested = false;
  const stop = () => {
    if (!exited && !terminationRequested) {
      terminationRequested = true;
      void worker.terminate().catch(() => {});
    }
  };
  const fail = (error: Error) => {
    if (settled) return;
    settled = true;
    reject(error);
  };
  const onAbort = () => { fail(canceled()); stop(); };
  const onError = (error: Error) => fail(new Error(`Search worker failed: ${error.message}`));
  const onExit = (code: number) => {
    exited = true;
    fail(new Error(`Search worker exited before it returned results (code ${code}).`));
    worker.off("message", onMessage);
    worker.off("messageerror", onMessageError);
    worker.off("error", onError);
    worker.off("exit", onExit);
  };
  const onMessageError = (error: Error) => fail(new Error(`Cannot read search results: ${error.message}`));
  const onMessage = (message: WorkerMessage) => {
    if (signal.aborted) return onAbort();
    if ("error" in message) return fail(new Error(message.error));
    if (settled) return;
    settled = true;
    resolve(message.result);
  };
  const timer = setTimeout(() => { fail(new Error("Search stopped after 15 seconds.")); stop(); }, 15000);
  worker.once("message", onMessage);
  worker.once("messageerror", onMessageError);
  worker.once("error", onError);
  worker.once("exit", onExit);
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) onAbort();
  try {
    const result = await promise;
    if (signal.aborted) throw canceled();
    return result;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
    worker.off("message", onMessage);
    worker.off("messageerror", onMessageError);
    stop();
    if (signal.aborted) throw canceled();
  }
}
