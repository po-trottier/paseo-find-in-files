import { isUtf8 } from "node:buffer";
import { constants, type Dir, type Stats } from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import { setImmediate as yieldTurn } from "node:timers/promises";
import ignore, { type Ignore } from "ignore";

export const MAX_FILE_BYTES = 1024 * 1024;
export type WalkFile = { relativePath: string; size: number; mtimeMs: number };
export type IndexFileRead = { bytes: Buffer | null; retry: boolean };

export function checkAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw Object.assign(new Error("The search was aborted."), { name: "AbortError" });
}

async function read(context: Safety, relativePath: string): Promise<IndexFileRead> {
  let handle: FileHandle | undefined;
  try {
    const file = await inspect(context, relativePath);
    if (!file) return { bytes: null, retry: false };
    handle = await io(() => fs.open(file.absolutePath,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)));
    const opened = await io(() => handle!.stat());
    if (!opened.isFile() || opened.size > MAX_FILE_BYTES) return { bytes: null, retry: false };
    if (opened.size !== file.info.size || opened.dev !== file.info.dev || opened.ino !== file.info.ino) {
      return { bytes: null, retry: true };
    }
    const current = await inspect(context, relativePath);
    if (!current || current.info.dev !== opened.dev || current.info.ino !== opened.ino
      || current.info.size !== opened.size || current.info.mtimeMs !== opened.mtimeMs) return { bytes: null, retry: true };
    const bytes = Buffer.allocUnsafe(opened.size);
    let offset = 0;
    const prefixLength = Math.min(bytes.length, BINARY_PREFIX_BYTES);
    while (offset < prefixLength) {
      const result = await io(() => handle!.read(bytes, offset, prefixLength - offset, offset));
      if (!result.bytesRead) return { bytes: null, retry: true };
      offset += result.bytesRead;
    }
    if (bytes.subarray(0, prefixLength).includes(0)) return { bytes: null, retry: false };
    while (offset < bytes.length) {
      const result = await io(() => handle!.read(bytes, offset, Math.min(64 * 1024, bytes.length - offset), offset));
      if (!result.bytesRead) return { bytes: null, retry: true };
      offset += result.bytesRead;
    }
    const finished = await io(() => handle!.stat());
    if (finished.size > MAX_FILE_BYTES) return { bytes: null, retry: false };
    if (finished.size !== opened.size || finished.mtimeMs !== opened.mtimeMs) return { bytes: null, retry: true };
    return { bytes: isUtf8(bytes) ? bytes : null, retry: false };
  } catch (error) {
    return { bytes: null, retry: !["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "") };
  } finally {
    if (handle) await io(() => handle!.close()).catch(() => {});
  }
}

export async function readIndexFile(directory: string, relativePath: string): Promise<IndexFileRead> {
  return new WorkspaceFiles(directory).read(relativePath);
}

export async function readSearchFile(directory: string, relativePath: string): Promise<Buffer | null> {
  return (await readIndexFile(directory, relativePath)).bytes;
}

const IO_LIMIT = 16;
const BINARY_PREFIX_BYTES = 8192;
let activeIo = 0;
const waitingIo: (() => void)[] = [];

async function io<T>(operation: () => Promise<T>): Promise<T> {
  if (activeIo < IO_LIMIT) activeIo++;
  else {
    const { promise, resolve } = Promise.withResolvers<void>();
    waitingIo.push(resolve);
    await promise;
  }
  try {
    return await operation();
  } finally {
    const next = waitingIo.shift();
    if (next) next();
    else activeIo--;
  }
}

function comparable(value: string): string {
  const resolved = path.resolve(process.platform === "win32"
    ? value.replace(/^\\\\\?\\UNC\\/i, "\\\\").replace(/^\\\\\?\\/, "")
    : value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function contains(directory: string, target: string): boolean {
  const relative = path.relative(comparable(directory), comparable(target));
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function segments(relativePath: string): string[] | null {
  if (!relativePath || /[\x00-\x1f\x7f]/.test(relativePath) || path.isAbsolute(relativePath)
    || path.win32.isAbsolute(relativePath) || /^[A-Za-z]:/.test(relativePath)) return null;
  const parts = relativePath.split(process.platform === "win32" ? /[\\/]/ : "/");
  if (parts.some((part) => !part || part === "." || part === ".." || part.toLowerCase() === ".git")) return null;
  if (process.platform === "win32" && parts.some((part) => /[<>:"|?*]|[. ]$/.test(part)
    || /^(?:con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:[. ]|$)/i.test(part))) return null;
  return parts;
}

type Safety = { root: string; blockedCloudRoots: string[] };
let cloudEnvironment = "";
let cloudDirectories: Promise<string[][]> = Promise.resolve([]);

async function safety(directory: string): Promise<Safety> {
  const root = await io(() => fs.realpath(directory));
  const environment = [process.env.OneDrive, process.env.OneDriveCommercial, process.env.OneDriveConsumer];
  const key = JSON.stringify(environment);
  if (key !== cloudEnvironment) {
    cloudEnvironment = key;
    cloudDirectories = (async () => {
      const directories: string[][] = [];
      for (const value of environment) {
        if (!value || !path.isAbsolute(value)) continue;
        const lexical = path.resolve(value);
        const canonical = await io(() => fs.realpath(lexical)).catch(() => lexical);
        directories.push([lexical, canonical]);
      }
      return directories;
    })();
  }
  const blockedCloudRoots = (await cloudDirectories)
    .filter((roots) => !roots.some((cloudRoot) => contains(cloudRoot, root)))
    .flat();
  return { root, blockedCloudRoots };
}

function blocked(context: Safety, absolutePath: string): boolean {
  return context.blockedCloudRoots.some((cloudRoot) => contains(cloudRoot, absolutePath));
}

async function inspect(context: Safety, relativePath: string, kind: "file" | "directory" | "entry" = "file"): Promise<{ absolutePath: string; info: Stats } | null> {
  const parts = relativePath ? segments(relativePath) : kind === "directory" ? [] : null;
  if (!parts) return null;
  const absolutePath = path.join(context.root, ...parts);
  if (blocked(context, absolutePath)) return null;
  const info = await io(() => fs.lstat(absolutePath));
  if (info.isSymbolicLink() || (kind === "directory" ? !info.isDirectory()
    : kind === "file" ? !info.isFile() : !info.isFile() && !info.isDirectory())) return null;
  if (info.isFile() && info.size > MAX_FILE_BYTES) return null;
  const canonical = await io(() => fs.realpath(absolutePath));
  if (!contains(context.root, canonical) || blocked(context, canonical)
    || comparable(canonical) !== comparable(absolutePath)) return null;
  return { absolutePath, info };
}

type Rules = { prefix: string; patterns: string[]; matcher: Ignore; uses: number; parent: Rules | null };

function ignored(rules: Rules | null, relativePath: string, directory: boolean): boolean {
  for (let current = rules; current; current = current.parent) {
    // ponytail: bound the library's path cache. Recreate it after 2048 tests.
    if (current.uses++ >= 2048) {
      current.matcher = ignore({ ignorecase: process.platform === "win32" }).add(current.patterns);
      current.uses = 0;
    }
    const result = current.matcher.test(relativePath.slice(current.prefix.length) + (directory ? "/" : ""));
    if (result.ignored) return true;
    if (result.unignored) return false;
  }
  return false;
}

export class WorkspaceFiles {
  partial = false;
  private readonly context: Promise<Safety>;

  constructor(directory: string) {
    this.context = safety(directory);
    void this.context.catch(() => {});
  }

  async read(relativePath: string): Promise<IndexFileRead> {
    if (!segments(relativePath)) return { bytes: null, retry: false };
    try {
      return await read(await this.context, relativePath);
    } catch {
      return { bytes: null, retry: true };
    }
  }

  async eligible(relativePath: string, signal?: AbortSignal): Promise<"file" | "directory" | null> {
    const parts = segments(relativePath);
    if (!parts) return null;
    checkAborted(signal);
    const context = await this.context;
    let directory = await this.directory(context, "", null, signal);
    if (!directory) return null;
    for (let index = 0; index < parts.length; index++) {
      checkAborted(signal);
      const relative = parts.slice(0, index + 1).join("/");
      const entry = await inspect(context, relative, "entry").catch((error: NodeJS.ErrnoException) => {
        if (["ENOENT", "ENOTDIR"].includes(error.code ?? "")) return null;
        if (["EACCES", "EPERM"].includes(error.code ?? "")) { this.partial = true; return null; }
        throw error;
      });
      if (!entry || ignored(directory.rules, relative, entry.info.isDirectory())) return null;
      if (entry.info.isDirectory()) {
        directory = await this.directory(context, relative, directory.rules, signal);
        if (!directory) return null;
        if (index === parts.length - 1) return "directory";
      } else {
        return index === parts.length - 1 ? "file" : null;
      }
    }
    return null;
  }

  async *walk(signal?: AbortSignal): AsyncGenerator<WalkFile> {
    checkAborted(signal);
    const context = await this.context;
    const access = this;
    async function* visit(relativeDirectory: string, parent: Rules | null): AsyncGenerator<WalkFile> {
      let stream: Dir | undefined;
      try {
        const directory = await access.directory(context, relativeDirectory, parent, signal);
        if (!directory) return;
        const prefix = relativeDirectory ? `${relativeDirectory}/` : "";
        stream = await io(() => fs.opendir(directory.absolutePath, { bufferSize: IO_LIMIT }));
        let done = false;
        while (!done) {
          checkAborted(signal);
          const entries = [];
          for (let index = 0; index < IO_LIMIT; index++) {
            checkAborted(signal);
            const entry = await io(() => stream!.read());
            if (!entry) { done = true; break; }
            entries.push(entry);
          }
          const files = await Promise.all(entries.map(async (entry) => {
            checkAborted(signal);
            const relativePath = `${prefix}${entry.name}`;
            const absolutePath = path.join(context.root, relativePath);
            if (!segments(relativePath) || entry.isSymbolicLink() || blocked(context, absolutePath)) return null;
            const info = await io(() => fs.lstat(absolutePath)).catch((error: NodeJS.ErrnoException) => {
              if (["ENOENT", "ENOTDIR"].includes(error.code ?? "")) return null;
              throw error;
            });
            checkAborted(signal);
            if (!info || info.isSymbolicLink()) return null;
            const isDirectory = info.isDirectory();
            if ((!isDirectory && (!info.isFile() || info.size > MAX_FILE_BYTES))
              || ignored(directory.rules, relativePath, isDirectory)) return null;
            return { relativePath, info, isDirectory };
          }));
          for (const file of files) {
            checkAborted(signal);
            if (!file) continue;
            if (file.isDirectory) yield* visit(file.relativePath, directory.rules);
            else yield { relativePath: file.relativePath, size: file.info.size, mtimeMs: file.info.mtimeMs };
          }
          await yieldTurn();
        }
      } catch (error) {
        checkAborted(signal);
        const code = (error as NodeJS.ErrnoException).code ?? "";
        if (!relativeDirectory || !["ENOENT", "ENOTDIR", "EACCES", "EPERM"].includes(code)) throw error;
        if (["EACCES", "EPERM"].includes(code)) access.partial = true;
      } finally {
        if (stream) await io(() => stream!.close()).catch(() => {});
      }
    }
    yield* visit("", null);
  }

  private async directory(context: Safety, relativeDirectory: string, parent: Rules | null, signal?: AbortSignal): Promise<{ absolutePath: string; rules: Rules | null } | null> {
    checkAborted(signal);
    try {
      const directory = await inspect(context, relativeDirectory, "directory");
      if (!directory) return null;
      if (relativeDirectory) {
        const marker = await io(() => fs.lstat(path.join(directory.absolutePath, ".git"))).catch((error: NodeJS.ErrnoException) => {
          if (["ENOENT", "ENOTDIR"].includes(error.code ?? "")) return null;
          throw error;
        });
        checkAborted(signal);
        if (marker) return null;
      }
      const prefix = relativeDirectory ? `${relativeDirectory}/` : "";
      const patterns: string[] = [];
      for (const name of [".gitignore", ".ignore"]) {
        checkAborted(signal);
        const { bytes, retry } = await read(context, `${prefix}${name}`);
        if (retry) {
          if (!relativeDirectory) throw new Error(`Cannot read the workspace ignore file: ${prefix}${name}`);
          this.partial = true;
          return null;
        }
        if (bytes) for (const pattern of bytes.toString("utf8").split(/\r?\n/)) patterns.push(pattern);
      }
      const rules = patterns.length
        ? { prefix, patterns, matcher: ignore({ ignorecase: process.platform === "win32" }).add(patterns), uses: 0, parent }
        : parent;
      return { absolutePath: directory.absolutePath, rules };
    } catch (error) {
      checkAborted(signal);
      const code = (error as NodeJS.ErrnoException).code ?? "";
      if (!relativeDirectory || !["ENOENT", "ENOTDIR", "EACCES", "EPERM"].includes(code)) throw error;
      if (["EACCES", "EPERM"].includes(code)) this.partial = true;
      return null;
    }
  }
}

export async function* walkWorkspace(directory: string, signal?: AbortSignal): AsyncGenerator<WalkFile> {
  yield* new WorkspaceFiles(directory).walk(signal);
}
