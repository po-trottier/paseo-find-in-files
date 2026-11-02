import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, readFile, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { TextDecoder } from "node:util";
import { MAX_FILE_BYTES } from "./files";

const utf8 = new TextDecoder("utf-8", { fatal: true });

export type ResolvedWorkspaceFile = { absolutePath: string; relativePath: string };
export type WorkspaceFile =
  | { kind: "text"; path: string; content: string; version: string }
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
      return { kind: "text", path: file.relativePath, content: utf8.decode(bytes), version: fileVersion(bytes) };
    } catch {
      return { kind: "binary", path: file.relativePath };
    }
  } finally {
    await handle.close();
  }
}

function fileVersion(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

const BOM = Buffer.from([0xef, 0xbb, 0xbf]);

/**
 * Replaces the text of an existing workspace file. Returns a conflict when the bytes on disk no longer
 * match `baseVersion`, unless `force` is set. A byte order mark on the old file is kept.
 */
export async function writeWorkspaceFile(directory: string, relativePath: string, content: string, baseVersion: string, force = false): Promise<{ kind: "saved"; version: string } | { kind: "conflict" }> {
  const file = await resolveWorkspaceFile(directory, relativePath);
  // ponytail: the version check and the write are not atomic. A change in between is overwritten.
  const current = await readFile(file.absolutePath);
  if (!force && fileVersion(current) !== baseVersion) return { kind: "conflict" };
  const bytes = Buffer.concat([current.subarray(0, 3).equals(BOM) ? BOM : Buffer.alloc(0), Buffer.from(content, "utf8")]);
  if (bytes.length > MAX_FILE_BYTES) throw new Error(`The file exceeds the ${MAX_FILE_BYTES / 1024} KiB edit limit.`);
  await writeFile(file.absolutePath, bytes);
  return { kind: "saved", version: fileVersion(bytes) };
}
