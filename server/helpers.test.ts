import { mkdtemp, mkdir, open, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { SearchEvent, SearchInput } from "../shared/contracts";
import { buildEditorCommand, parseRgLine, readWorkspaceFile, resolveWorkspaceFile, runSearch } from "./helpers";

describe("search helpers", () => {
  it("converts UTF-8 byte offsets and decodes base64 fields", () => {
    const text = "é😀 hit hit\r\n";
    for (const base64 of [false, true]) {
      const encode = (value: string) => base64 ? { bytes: Buffer.from(value).toString("base64") } : { text: value };
      const parsed = parseRgLine(JSON.stringify({
        type: "match",
        data: { path: encode("./src/café.ts"), lines: encode(text), line_number: 7, submatches: [{ start: 7, end: 10 }, { start: 11, end: 14 }] },
      }));
      expect(parsed).toEqual({
        path: "src/café.ts",
        matches: [{ line: 7, text: "é😀 hit hit", start: 4, end: 7 }, { line: 7, text: "é😀 hit hit", start: 8, end: 11 }],
        truncated: false,
      });
      expect(parsed?.matches.map((match) => match.text.slice(match.start, match.end))).toEqual(["hit", "hit"]);
    }
    expect(parseRgLine(JSON.stringify({ type: "match", data: { path: { text: "a.txt" }, lines: { bytes: Buffer.from([255, 104, 105, 116, 10]).toString("base64") }, line_number: 1, submatches: [{ start: 1, end: 4 }] } }))?.matches).toEqual([{ line: 1, text: "�hit", start: 1, end: 4 }]);
    expect(parseRgLine(JSON.stringify({ type: "summary", data: {} }))).toBeNull();
    expect(() => parseRgLine("{")).toThrow("Invalid ripgrep JSON");
    expect(() => parseRgLine(JSON.stringify({ type: "match", data: { path: { text: "a" }, lines: { text: "hit" }, line_number: 1, submatches: [{ start: 0, end: 9 }] } }))).toThrow("byte offsets");
    expect(parseRgLine(JSON.stringify({ type: "match", data: { path: { text: "a" }, lines: { text: "x".repeat(20 * 1024) }, line_number: 1, submatches: [{ start: 0, end: 1 }] } }))).toEqual({ path: "a", matches: [], truncated: true });
  });

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
      try { await large.truncate(2 * 1024 * 1024 + 1); } finally { await large.close(); }
      expect(await readWorkspaceFile(root, "large")).toEqual({ kind: "too-large", path: "large", maxBytes: 2 * 1024 * 1024 });
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

  it("finishes an empty query and suppresses an aborted query", async () => {
    const input: SearchInput = { workspaceId: "test", query: "", regex: false, caseSensitive: false, wholeWord: false };
    const events: SearchEvent[] = [];
    const push = async (event: SearchEvent) => { events.push(event); };
    const controller = new AbortController();
    await runSearch("not-a-directory", input, controller.signal, push);
    expect(events).toEqual([{ type: "done", totalMatches: 0, totalFiles: 0, truncated: false }]);
    events.length = 0;
    controller.abort();
    await runSearch("not-a-directory", { ...input, query: "hit" }, controller.signal, push);
    expect(events).toEqual([]);
  });
});
