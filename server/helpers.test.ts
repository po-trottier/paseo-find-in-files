import { mkdtemp, mkdir, open, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildEditorCommand, readWorkspaceFile, resolveWorkspaceFile } from "./helpers";

describe("search helpers", () => {
  it("contains canonical files and bounds text reads", async ({ skip }) => {
    const sandbox = await mkdtemp(path.join(tmpdir(), "paseo-find-files-"));
    const root = path.join(sandbox, "root");
    const outside = path.join(sandbox, "outside");
    try {
      await mkdir(path.join(root, "nested"), { recursive: true });
      await mkdir(outside);
      await writeFile(path.join(root, "nested", "text.txt"), "é😀\n");
      await writeFile(path.join(outside, "secret.txt"), "outside");
      expect(await resolveWorkspaceFile(root, "nested/text.txt")).toEqual({ absolutePath: await realpath(path.join(root, "nested", "text.txt")), relativePath: "nested/text.txt" });
      expect(await readWorkspaceFile(root, "nested/text.txt")).toEqual({ kind: "text", path: "nested/text.txt", content: "é😀\n" });
      await writeFile(path.join(root, "nested", "bom.txt"), "\ufefffirst line");
      expect(await readWorkspaceFile(root, "nested/bom.txt")).toEqual({ kind: "text", path: "nested/bom.txt", content: "first line" });
      for (const input of ["../outside/secret.txt", "nested/../text.txt", "..\\outside\\secret.txt", path.join(root, "nested", "text.txt"), "/absolute.txt", "C:\\absolute.txt", "C:relative.txt", "\\\\server\\share\\file.txt"]) {
        await expect(resolveWorkspaceFile(root, input)).rejects.toThrow("inside the workspace");
      }
      await expect(resolveWorkspaceFile(root, "nested")).rejects.toThrow("ordinary file");
      if (process.platform === "win32") {
        for (const input of ["NUL", "COM1.txt", "nested/text.txt:secret", "nested./text.txt", "nested /text.txt"]) {
          await expect(resolveWorkspaceFile(root, input)).rejects.toThrow("unsafe Windows syntax");
        }
      }
      for (const bytes of [Buffer.from([0]), Buffer.from([195, 40])]) {
        await writeFile(path.join(root, "binary"), bytes);
        expect(await readWorkspaceFile(root, "binary")).toEqual({ kind: "binary", path: "binary" });
      }
      const large = await open(path.join(root, "large"), "w");
      try { await large.truncate(1024 * 1024 + 1); } finally { await large.close(); }
      expect(await readWorkspaceFile(root, "large")).toEqual({ kind: "too-large", path: "large", maxBytes: 1024 * 1024 });
      const linkType = process.platform === "win32" ? "junction" : "dir";
      try {
        await symlink(outside, path.join(root, "escape"), linkType);
        await symlink(path.join(root, "nested"), path.join(root, "inside"), linkType);
        await symlink(root, path.join(sandbox, "root-link"), linkType);
      } catch (error) {
        if (["EPERM", "EACCES", "ENOTSUP"].includes((error as NodeJS.ErrnoException).code ?? "")) {
          skip("The OS did not permit a symlink or junction.");
          return;
        }
        throw error;
      }
      await expect(resolveWorkspaceFile(root, "escape/secret.txt")).rejects.toThrow("inside the workspace");
      expect((await resolveWorkspaceFile(root, "inside/text.txt")).relativePath).toBe("nested/text.txt");
      expect((await resolveWorkspaceFile(path.join(sandbox, "root-link"), "nested/text.txt")).relativePath).toBe("nested/text.txt");
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  });

  it.each([
    ["win32", "C:\\Users\\me\\é #%.txt", "explorer.exe", "vscode://file/C:/Users/me/%C3%A9%20%23%25.txt:12:4"],
    ["darwin", "/Users/me/é #%.txt", "open", "vscode://file/Users/me/%C3%A9%20%23%25.txt:12:4"],
    ["linux", "/home/me/é #%.txt", "xdg-open", "vscode://file/home/me/%C3%A9%20%23%25.txt:12:4"],
    ["linux", "/home/me/a:b.txt", "xdg-open", "vscode://file/home/me/a%3Ab.txt:12:4"],
  ] as const)("builds an encoded editor URL for %s without launching it", (platform, file, command, url) => {
    expect(buildEditorCommand(file, 12, 4, platform)).toEqual({ command, args: [url], url });
  });
});
