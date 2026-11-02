import { mkdtemp, mkdir, open, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { SearchInput } from "../shared/contracts";
import { planQuery, trigrams } from "./planner";
import { verifyFiles } from "./verify";

const input: SearchInput = { workspaceId: "test", query: "hit", regex: false, caseSensitive: false, wholeWord: false };

describe("trigram query plans", () => {
  it("folds ASCII bytes and packs unique sorted trigrams", () => {
    expect(trigrams(Buffer.from("ABCaBC"))).toEqual(Uint32Array.of(0x616263, 0x626361, 0x636162));
    expect(trigrams(Buffer.from([255, 65, 0]))).toEqual(Uint32Array.of(0xff6100));
    expect(trigrams(Buffer.from("ab"))).toEqual(new Uint32Array());
    expect(planQuery("AbCd", false).alternatives).toEqual([trigrams(Buffer.from("abcd"))]);
    expect(planQuery("ab", false).alternatives).toBeNull();
  });

  it("keeps Unicode folding conservative without discarding safe ASCII trigrams", () => {
    expect(planQuery("CAFÉ", false).alternatives).toBeNull();
    expect(planQuery("CAFÉ", true).alternatives).toBeNull();
    expect(planQuery("CAFÉ", false, true).alternatives).toEqual([trigrams(Buffer.from("CAFÉ"))]);
    expect(planQuery("Kss", false).alternatives).toBeNull();
    expect(planQuery("Kss", false, true).alternatives).toEqual([trigrams(Buffer.from("kss"))]);
    expect(planQuery("_REMIX_FAILURE_DIALOG_SHOWN", false).alternatives?.[0].length).toBeGreaterThan(0);
    for (const text of ["Kabc", "ſabc"]) {
      const plan = planQuery(text.startsWith("K") ? "Kabc" : "Sabc", false);
      const indexed = new Set(trigrams(Buffer.from(text)));
      expect(plan.alternatives).not.toBeNull();
      expect(plan.alternatives!.some((required) => required.every((value) => indexed.has(value)))).toBe(true);
    }
  });

  it("collects required top-level runs and complete alternative branches", () => {
    expect(planQuery("^alpha.*omega$", true, true).alternatives).toEqual([
      Uint32Array.from(new Set([...trigrams(Buffer.from("alpha")), ...trigrams(Buffer.from("omega"))])).sort(),
    ]);
    expect(planQuery("alpha|omega", true, true).alternatives).toEqual([trigrams(Buffer.from("alpha")), trigrams(Buffer.from("omega"))]);
    expect(planQuery("alpha|x?", true, true).alternatives).toBeNull();
    expect(planQuery("(?:alpha|omega)", true, true).alternatives).toBeNull();
    expect(planQuery("alpha(?:x|y)?omega", true, true).alternatives).toEqual(planQuery("alpha.*omega", true, true).alternatives);
    expect(planQuery("[abc]", true, true).alternatives).toBeNull();
    expect(planQuery("\\w+", true, true).alternatives).toBeNull();
    expect(planQuery("alpha\\qomega", true, true).alternatives).toBeNull();
  });

  it("does not require optional atoms or confuse escaped metacharacters", () => {
    expect(planQuery("abc?", true, true).alternatives).toBeNull();
    expect(planQuery("abcd?", true, true).alternatives).toEqual([trigrams(Buffer.from("abc"))]);
    expect(planQuery("abc{0,3}", true, true).alternatives).toBeNull();
    expect(planQuery("abcd{1,3}", true, true).alternatives).toEqual([trigrams(Buffer.from("abcd"))]);
    expect(planQuery("alpha\\.omega", true, true).alternatives).toEqual([trigrams(Buffer.from("alpha.omega"))]);
    expect(planQuery("alpha\\?*omega", true, true).alternatives).toEqual(planQuery("alpha.*omega", true, true).alternatives);
    expect(planQuery("\\x61bc", true, true).alternatives).toBeNull();
    expect(planQuery("alpha\\u{61}omega", true, true).alternatives).toEqual(planQuery("alpha.*omega", true, true).alternatives);
  });
});

describe("isolated file verification", () => {
  it("uses Unicode whole words, case options, UTF-16 offsets, and CRLF line numbers", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "paseo-search-worker-"));
    try {
      await writeFile(path.join(root, "words.txt"), "hit hit_ hité _hit 2hit HIT\r\né😀 hit\rfinal hit");
      const insensitive = await verifyFiles(root, ["words.txt"], { ...input, wholeWord: true }, new AbortController().signal);
      expect(insensitive.files[0].matches).toEqual([
        { line: 1, text: "hit hit_ hité _hit 2hit HIT", textStart: 0, start: 0, end: 3 },
        { line: 1, text: "hit hit_ hité _hit 2hit HIT", textStart: 0, start: 24, end: 27 },
        { line: 2, text: "é😀 hit", textStart: 0, start: 4, end: 7 },
        { line: 3, text: "final hit", textStart: 0, start: 6, end: 9 },
      ]);
      const sensitive = await verifyFiles(root, ["words.txt"], { ...input, caseSensitive: true, wholeWord: true }, new AbortController().signal);
      expect(sensitive.totalMatches).toBe(3);
      expect(insensitive.totalFiles).toBe(1);
      expect(insensitive.truncated).toBe(false);
      expect((await verifyFiles(root, ["words.txt"], { ...input, query: "hit\nHIT" }, new AbortController().signal)).totalMatches).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("verifies Unicode equivalents, literal syntax, and zero-length codepoint positions", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "paseo-search-worker-"));
    try {
      await writeFile(path.join(root, "unicode.txt"), "Kabc ſabc\r\na+b [x]");
      await writeFile(path.join(root, "empty.txt"), "😀a");
      for (const [query, start] of [["Kabc", 0], ["Sabc", 5]] as const) {
        const result = await verifyFiles(root, ["unicode.txt"], { ...input, query }, new AbortController().signal);
        expect(result.files[0].matches[0]).toEqual({ line: 1, text: "\u212Aabc ſabc", textStart: 0, start, end: start + 4 });
      }
      const literal = await verifyFiles(root, ["unicode.txt"], { ...input, query: "a+b [x]" }, new AbortController().signal);
      expect(literal.files[0].matches[0]).toEqual({ line: 2, text: "a+b [x]", textStart: 0, start: 0, end: 7 });
      const empty = await verifyFiles(root, ["empty.txt"], { ...input, query: "(?:)", regex: true }, new AbortController().signal);
      expect(empty.files[0].matches.map(({ start, end }) => [start, end])).toEqual([[0, 0], [2, 2], [3, 3]]);
      const greedy = await verifyFiles(root, ["empty.txt"], { ...input, query: ".*", regex: true }, new AbortController().signal);
      expect(greedy.files[0].matches.map(({ start, end }) => [start, end])).toEqual([[0, 3], [3, 3]]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("removes the UTF-8 BOM and preserves POSIX backslashes in file names", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "paseo-search-worker-"));
    try {
      await writeFile(path.join(root, "bom.txt"), "\uFEFFhit\r\nnext");
      const bom = await verifyFiles(root, ["bom.txt"], { ...input, query: "^hit$", regex: true }, new AbortController().signal);
      expect(bom.files[0].matches).toEqual([{ line: 1, text: "hit", textStart: 0, start: 0, end: 3 }]);
      if (process.platform !== "win32") {
        const name = "part\\name.txt";
        await writeFile(path.join(root, name), "hit");
        const result = await verifyFiles(root, [name], { ...input, include: "*.txt" }, new AbortController().signal);
        expect(result.files.map((file) => file.path)).toEqual([name]);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("returns a window of long lines so one minified file cannot fill the result budget", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "paseo-search-worker-"));
    try {
      const filler = "x".repeat(300_000);
      // The window starts 40 code units before a match. Here that lands on the low surrogate of 😀.
      await writeFile(path.join(root, "min.json"), `${filler}hit${filler}😀${"y".repeat(39)}hit${filler}hit`);
      await writeFile(path.join(root, "later.ts"), "hit");
      const result = await verifyFiles(root, ["min.json", "later.ts"], input, new AbortController().signal);
      expect(result.truncated).toBe(false);
      expect(result.files.map((file) => [file.path, file.matches.length])).toEqual([["min.json", 3], ["later.ts", 1]]);
      for (const match of result.files[0].matches) {
        expect(match.text.length).toBeLessThanOrEqual(300);
        expect(match.text.slice(match.start - match.textStart, match.end - match.textStart)).toBe("hit");
      }
      expect(result.files[0].matches[1].text.startsWith("😀y")).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("skips binary and oversized candidates and applies include/exclude globs", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "paseo-search-worker-"));
    try {
      await mkdir(path.join(root, "src", "skip"), { recursive: true });
      await mkdir(path.join(root, ".git"));
      for (const name of ["main.ts", "src/view.tsx", "src/note.txt", "src/skip/hide.ts", ".git/config"]) await writeFile(path.join(root, name), "hit");
      await writeFile(path.join(root, "binary.ts"), Buffer.from([104, 105, 116, 0]));
      await writeFile(path.join(root, "invalid.ts"), Buffer.from([104, 105, 116, 255]));
      const oversized = await open(path.join(root, "oversized.ts"), "w");
      try {
        await oversized.write("hit");
        await oversized.truncate(1024 * 1024 + 1);
      } finally {
        await oversized.close();
      }
      const candidates = ["main.ts", "src/view.tsx", "src/note.txt", "src/skip/hide.ts", "binary.ts", "invalid.ts", "oversized.ts", ".git/config", "../outside.ts", path.join(root, "main.ts"), "main.ts"];
      const result = await verifyFiles(root, candidates, { ...input, include: "*.{ts,tsx}", exclude: "**/skip/**" }, new AbortController().signal);
      expect(result.files.map((file) => file.path)).toEqual(["main.ts", "src/view.tsx"]);
      expect(result.totalMatches).toBe(2);
      expect(result.truncated).toBe(false);
      expect((await verifyFiles(root, candidates, { ...input, include: "src/v?ew.*" }, new AbortController().signal)).files.map((file) => file.path)).toEqual(["src/view.tsx"]);
      expect((await verifyFiles(root, candidates, { ...input, exclude: "skip" }, new AbortController().signal)).files.some((file) => file.path === "src/skip/hide.ts")).toBe(false);
      const disappeared = await verifyFiles(root, ["main.ts", "missing.ts"], input, new AbortController().signal);
      expect(disappeared.totalMatches).toBe(1);
      expect(disappeared.truncated).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("blocks cloud roots unless the workspace is inside the cloud root", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "paseo-search-worker-"));
    const cloud = path.join(root, "cloud");
    vi.stubEnv("OneDrive", cloud);
    vi.stubEnv("OneDriveCommercial", "");
    vi.stubEnv("OneDriveConsumer", "");
    try {
      await mkdir(cloud);
      await writeFile(path.join(root, "local.txt"), "hit");
      await writeFile(path.join(cloud, "remote.txt"), "hit");
      const outer = await verifyFiles(root, ["local.txt", "cloud/remote.txt"], input, new AbortController().signal);
      expect(outer.files.map((file) => file.path)).toEqual(["local.txt"]);
      const inner = await verifyFiles(cloud, ["remote.txt"], input, new AbortController().signal);
      expect(inner.files.map((file) => file.path)).toEqual(["remote.txt"]);
    } finally {
      vi.unstubAllEnvs();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects directory symlinks before it reads content", async ({ skip }) => {
    const sandbox = await mkdtemp(path.join(tmpdir(), "paseo-search-worker-"));
    const root = path.join(sandbox, "root");
    const outside = path.join(sandbox, "outside");
    try {
      await mkdir(root);
      await mkdir(outside);
      await writeFile(path.join(outside, "secret.txt"), "hit");
      try {
        await symlink(outside, path.join(root, "escape"), process.platform === "win32" ? "junction" : "dir");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EPERM") return skip("The operating system denied directory link creation.");
        throw error;
      }
      const result = await verifyFiles(root, ["escape/secret.txt"], input, new AbortController().signal);
      expect(result.totalMatches).toBe(0);
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  });

  it("rejects file symlinks before it reads content", async ({ skip }) => {
    const sandbox = await mkdtemp(path.join(tmpdir(), "paseo-search-worker-"));
    const root = path.join(sandbox, "root");
    try {
      await mkdir(root);
      await writeFile(path.join(sandbox, "secret.txt"), "hit");
      try {
        await symlink(path.join(sandbox, "secret.txt"), path.join(root, "escape.txt"), "file");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EPERM") return skip("The operating system denied file link creation.");
        throw error;
      }
      expect((await verifyFiles(root, ["escape.txt"], input, new AbortController().signal)).totalMatches).toBe(0);
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  });

  it("reports regex errors, rejects excessive glob expansion, and cancels its own worker", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "paseo-search-worker-"));
    try {
      await expect(verifyFiles(root, [], { ...input, regex: true, query: "[" }, new AbortController().signal)).rejects.toThrow("Invalid regular expression");
      await expect(verifyFiles(root, [], { ...input, include: "{1..1000000}" }, new AbortController().signal)).rejects.toThrow("Invalid include glob");
      await expect(verifyFiles(root, [], { ...input, include: "{" + "a,".repeat(257) + "z}" }, new AbortController().signal)).rejects.toThrow("256 brace expansions");
      const controller = new AbortController();
      const pending = verifyFiles(root, [], input, controller.signal);
      const assertion = expect(pending).rejects.toMatchObject({ name: "AbortError", message: "Search canceled." });
      controller.abort();
      await assertion;
      await expect(verifyFiles(root, [], input, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
