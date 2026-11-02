import { EventEmitter } from "node:events";
import { watch as watchFileSystem, type FSWatcher, type PathLike, type WatchListener } from "node:fs";
import type * as NodeFileSystem from "node:fs";
import files from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi, type MockInstance } from "vitest";
import type { SearchInput } from "../shared/contracts";
import { MAX_FILE_BYTES, readSearchFile, walkWorkspace } from "./files";
import { IndexManager } from "./indexer";
import { planQuery } from "./planner";
import { verifyFiles } from "./verify";

vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof NodeFileSystem>();
  return { ...original, watch: vi.fn(original.watch) };
});

async function paths(directory: string): Promise<string[]> {
  const paths: string[] = [];
  for await (const file of walkWorkspace(directory)) paths.push(file.relativePath);
  return paths.sort();
}

function watchFixture() {
  const watcher = Object.assign(new EventEmitter(), { close: vi.fn(), unref: vi.fn() });
  const listeners = new Map<string, WatchListener<string>>();
  let first = true;
  let listener: WatchListener<string> | undefined;
  const spy = vi.mocked(watchFileSystem).mockReset().mockImplementation(((directory: PathLike, _options: unknown, callback: WatchListener<string>) => {
    listener = callback;
    listeners.set(path.resolve(String(directory)), callback);
    if (first) { first = false; return watcher as unknown as FSWatcher; }
    return Object.assign(new EventEmitter(), { close: vi.fn(), unref: vi.fn() }) as unknown as FSWatcher;
  }) as typeof watchFileSystem);
  return {
    watcher,
    spy,
    change(relativePath: string, event: "rename" | "change" = "change", directory?: string) {
      const callback = directory ? listeners.get(path.resolve(directory)) : listener;
      if (!callback) throw new Error("No watcher exists for this directory.");
      callback(event, relativePath);
    },
  };
}

describe("safe workspace files", () => {
  it("applies nested ignore rules and negations without entering excluded directories", async () => {
    const root = await files.mkdtemp(path.join(os.tmpdir(), "paseo-index-ignore-"));
    try {
      await files.mkdir(path.join(root, "nested", "blocked"), { recursive: true });
      await files.mkdir(path.join(root, ".git"));
      await files.writeFile(path.join(root, ".gitignore"), "*.tmp\nblocked/\n");
      await files.writeFile(path.join(root, ".ignore"), "root.txt\n");
      await files.writeFile(path.join(root, "root.txt"), "excluded");
      await files.writeFile(path.join(root, "root.tmp"), "excluded");
      await files.writeFile(path.join(root, "root.ts"), "included");
      await files.writeFile(path.join(root, ".git", "secret.txt"), "excluded");
      await files.writeFile(path.join(root, "nested", ".gitignore"), "!keep.tmp\n*.log\n");
      await files.writeFile(path.join(root, "nested", ".ignore"), "!keep.log\n");
      await files.writeFile(path.join(root, "nested", "keep.tmp"), "included");
      await files.writeFile(path.join(root, "nested", "drop.tmp"), "excluded");
      await files.writeFile(path.join(root, "nested", "keep.log"), "included");
      await files.writeFile(path.join(root, "nested", "drop.log"), "excluded");
      await files.writeFile(path.join(root, "nested", "blocked", ".gitignore"), "!secret.txt\n");
      await files.writeFile(path.join(root, "nested", "blocked", "secret.txt"), "excluded");
      const found = await paths(root);
      expect(found).toEqual([".gitignore", ".ignore", "nested/.gitignore", "nested/.ignore", "nested/keep.log", "nested/keep.tmp", "root.ts"]);
      expect(await readSearchFile(root, ".git/secret.txt")).toBeNull();
      if (process.platform !== "win32") {
        await files.writeFile(path.join(root, "a\\b.txt"), "literal backslash");
        expect(await paths(root)).toContain("a\\b.txt");
        expect((await readSearchFile(root, "a\\b.txt"))?.toString()).toBe("literal backslash");
      }
    } finally {
      await files.rm(root, { recursive: true, force: true });
    }
  });

  it("skips nested repositories and worktrees but searches the workspace repository and other hidden files", async () => {
    const root = await files.mkdtemp(path.join(os.tmpdir(), "paseo-index-nested-"));
    try {
      await files.mkdir(path.join(root, ".git"));
      await files.mkdir(path.join(root, "repository", ".git"), { recursive: true });
      await files.mkdir(path.join(root, "worktree"));
      await files.mkdir(path.join(root, ".hidden"));
      await files.writeFile(path.join(root, "root.txt"), "included");
      await files.writeFile(path.join(root, "repository", "excluded.txt"), "excluded");
      await files.writeFile(path.join(root, "worktree", ".git"), "gitdir: ../metadata\n");
      await files.writeFile(path.join(root, "worktree", "excluded.txt"), "excluded");
      await files.writeFile(path.join(root, ".hidden", "included.txt"), "included");
      expect(await paths(root)).toEqual([".hidden/included.txt", "root.txt"]);
      expect(await paths(path.join(root, "worktree"))).toEqual(["excluded.txt"]);
    } finally {
      await files.rm(root, { recursive: true, force: true });
    }
  });

  it("stats oversized content and ignore files before opening either", async () => {
    const root = await files.mkdtemp(path.join(os.tmpdir(), "paseo-index-size-"));
    let openSpy: MockInstance<typeof files.open> | undefined;
    try {
      for (const name of ["large.txt", ".ignore"]) {
        const handle = await files.open(path.join(root, name), "w");
        try { await handle.truncate(MAX_FILE_BYTES + 1); } finally { await handle.close(); }
      }
      await files.writeFile(path.join(root, "text.txt"), "allowed");
      await files.writeFile(path.join(root, "binary.bin"), Buffer.from([97, 0, 98]));
      await files.writeFile(path.join(root, "invalid.bin"), Buffer.from([255]));
      openSpy = vi.spyOn(files, "open");
      expect(await readSearchFile(root, "large.txt")).toBeNull();
      expect(await readSearchFile(root, ".ignore")).toBeNull();
      expect(await paths(root)).toEqual(["binary.bin", "invalid.bin", "text.txt"]);
      expect(openSpy.mock.calls.some(([filename]) => ["large.txt", ".ignore"].includes(path.basename(String(filename))))).toBe(false);
      expect(await readSearchFile(root, "binary.bin")).toBeNull();
      expect(await readSearchFile(root, "invalid.bin")).toBeNull();
      expect((await readSearchFile(root, "text.txt"))?.toString()).toBe("allowed");
      for (const value of ["../text.txt", "nested/../text.txt", "/absolute.txt", "C:\\absolute.txt", "C:relative.txt"]) {
        expect(await readSearchFile(root, value)).toBeNull();
      }
      const controller = new AbortController();
      controller.abort();
      await expect(walkWorkspace(root, controller.signal).next()).rejects.toMatchObject({ name: "AbortError" });
    } finally {
      openSpy?.mockRestore();
      await files.rm(root, { recursive: true, force: true });
    }
  });

  it("skips symlink directories and files without following a loop or escape", async ({ skip }) => {
    const root = await files.mkdtemp(path.join(os.tmpdir(), "paseo-index-links-"));
    const outside = await files.mkdtemp(path.join(os.tmpdir(), "paseo-index-outside-"));
    try {
      await files.writeFile(path.join(root, "text.txt"), "inside");
      await files.writeFile(path.join(outside, "secret.txt"), "outside");
      try {
        const type = process.platform === "win32" ? "junction" : "dir";
        await files.symlink(outside, path.join(root, "escape"), type);
        await files.symlink(root, path.join(root, "loop"), type);
        if (process.platform !== "win32") await files.symlink(path.join(outside, "secret.txt"), path.join(root, "linked.txt"));
      } catch (error) {
        if (["EPERM", "EACCES", "ENOTSUP"].includes((error as NodeJS.ErrnoException).code ?? "")) {
          skip("The OS did not permit a symlink or junction.");
          return;
        }
        throw error;
      }
      expect(await paths(root)).toEqual(["text.txt"]);
      expect(await readSearchFile(root, "escape/secret.txt")).toBeNull();
      expect(await readSearchFile(root, "loop/text.txt")).toBeNull();
      if (process.platform !== "win32") expect(await readSearchFile(root, "linked.txt")).toBeNull();
    } finally {
      await files.rm(root, { recursive: true, force: true });
      await files.rm(outside, { recursive: true, force: true });
    }
  });

  it("skips configured cloud subtrees unless the workspace itself is inside them", async () => {
    const root = await files.mkdtemp(path.join(os.tmpdir(), "paseo-index-cloud-"));
    const cloud = path.join(root, "Cloud");
    let openSpy: MockInstance<typeof files.open> | undefined;
    try {
      await files.mkdir(path.join(cloud, "project"), { recursive: true });
      await files.writeFile(path.join(root, "local.txt"), "local");
      await files.writeFile(path.join(cloud, ".gitignore"), "*.ignored\n");
      await files.writeFile(path.join(cloud, "project", "content.txt"), "cloud");
      vi.stubEnv("OneDrive", cloud);
      vi.stubEnv("OneDriveCommercial", cloud);
      vi.stubEnv("OneDriveConsumer", cloud);
      openSpy = vi.spyOn(files, "open");
      expect(await paths(root)).toEqual(["local.txt"]);
      expect(await readSearchFile(root, "Cloud/project/content.txt")).toBeNull();
      expect(openSpy.mock.calls.some(([filename]) => String(filename).includes(`${path.sep}Cloud${path.sep}`))).toBe(false);
      expect(await paths(path.join(cloud, "project"))).toEqual(["content.txt"]);
      expect((await readSearchFile(path.join(cloud, "project"), "content.txt"))?.toString()).toBe("cloud");
      if (process.platform === "win32") {
        vi.stubEnv("OneDrive", cloud.toUpperCase());
        expect(await paths(root)).toEqual(["local.txt"]);
      }
    } finally {
      openSpy?.mockRestore();
      vi.unstubAllEnvs();
      await files.rm(root, { recursive: true, force: true });
    }
  });
});

describe("workspace content index", () => {
  it("builds once per canonical directory and intersects folded postings", async () => {
    const root = await files.mkdtemp(path.join(os.tmpdir(), "paseo-index-build-"));
    const watch = watchFixture();
    const manager = new IndexManager();
    try {
      await files.writeFile(path.join(root, "first.txt"), "é😀 ALPHA one beta");
      await files.writeFile(path.join(root, "second.txt"), "alpha two gamma");
      await files.writeFile(path.join(root, "third.txt"), "other beta");
      await files.writeFile(path.join(root, "binary.bin"), Buffer.from([0]));
      const index = await manager.get(root);
      expect(index.status().state).toBe("building");
      expect(await manager.get(path.join(root, "."))).toBe(index);
      await vi.waitFor(() => expect(index.status().state).toBe("ready"), { timeout: 5000 });
      expect(index.status()).toMatchObject({ filesIndexed: 3, filesSkipped: 1, partial: false });
      expect((await index.candidates(planQuery("alpha", false))).sort()).toEqual(["first.txt", "second.txt"]);
      expect(await index.candidates(planQuery("alpha.*beta", true))).toEqual(["first.txt"]);
      expect((await index.candidates({ alternatives: null })).sort()).toEqual(["first.txt", "second.txt", "third.txt"]);
      expect(watch.spy).toHaveBeenCalledTimes(1);
      const input: SearchInput = { workspaceId: "test", query: "ALPHA", regex: false, caseSensitive: true, wholeWord: true };
      const selected = await index.candidates(planQuery(input.query, input.regex, input.caseSensitive));
      const verified = await verifyFiles(root, selected, input, new AbortController().signal);
      expect(verified).toEqual({
        files: [{ path: "first.txt", matches: [{ line: 1, text: "é😀 ALPHA one beta", textStart: 0, start: 4, end: 9 }] }],
        totalMatches: 1, totalFiles: 1, truncated: false,
      });
    } finally {
      await manager.dispose();
      watch.spy.mockRestore();
      await files.rm(root, { recursive: true, force: true });
    }
    expect(watch.watcher.close).toHaveBeenCalledTimes(1);
  });

  it("keeps dirty files searchable and drops old postings and deleted tombstones", async () => {
    const root = await files.mkdtemp(path.join(os.tmpdir(), "paseo-index-watch-"));
    const watch = watchFixture();
    const manager = new IndexManager();
    try {
      await files.writeFile(path.join(root, "changed.txt"), "oldneedle");
      for (let index = 0; index < 5; index++) await files.writeFile(path.join(root, `other-${index}.txt`), "unrelated");
      const index = await manager.get(root);
      await vi.waitFor(() => expect(index.status().state).toBe("ready"), { timeout: 5000 });
      await files.writeFile(path.join(root, "changed.txt"), "newneedle");
      watch.change("changed.txt");
      expect(await index.candidates(planQuery("newneedle", false))).toContain("changed.txt");
      await vi.waitFor(async () => {
        expect(await index.candidates(planQuery("oldneedle", false))).toEqual([]);
        expect(await index.candidates(planQuery("newneedle", false))).toEqual(["changed.txt"]);
      }, { timeout: 5000 });
      expect(index.status().filesIndexed).toBe(6);
      for (const query of ["newneedle", "oldneedle"]) {
        const input: SearchInput = { workspaceId: "test", query, regex: false, caseSensitive: true, wholeWord: false };
        const selected = await index.candidates(planQuery(query, false, true));
        const verified = await verifyFiles(root, selected, input, new AbortController().signal);
        expect(verified.totalMatches).toBe(query === "newneedle" ? 1 : 0);
      }
      await files.unlink(path.join(root, "changed.txt"));
      watch.change("changed.txt", "rename");
      await vi.waitFor(async () => {
        expect(await index.candidates(planQuery("newneedle", false))).toEqual([]);
        expect(index.status().filesIndexed).toBe(5);
      }, { timeout: 5000 });
      watch.watcher.emit("error", new Error("The watcher stopped."));
      expect(index.status()).toMatchObject({ state: "stale", error: "The watcher stopped." });
      await files.writeFile(path.join(root, "unwatched.txt"), "freshneedle");
      expect(await index.candidates(planQuery("freshneedle", false))).toContain("unwatched.txt");
    } finally {
      await manager.dispose();
      watch.spy.mockRestore();
      await files.rm(root, { recursive: true, force: true });
    }
  });

  it("rebuilds after ignore changes and adds files created during a build", async () => {
    const root = await files.mkdtemp(path.join(os.tmpdir(), "paseo-index-rebuild-"));
    const watch = watchFixture();
    const manager = new IndexManager();
    try {
      await files.writeFile(path.join(root, ".ignore"), "hidden.txt\n");
      await files.writeFile(path.join(root, "shown.txt"), "visiblemarker");
      await files.writeFile(path.join(root, "hidden.txt"), "hiddenmarker");
      const index = await manager.get(root);
      await files.writeFile(path.join(root, "created.txt"), "createdmarker");
      watch.change("created.txt", "rename");
      await vi.waitFor(() => expect(index.status().state).toBe("ready"), { timeout: 5000 });
      expect(await index.candidates(planQuery("createdmarker", false))).toEqual(["created.txt"]);
      expect(await index.candidates(planQuery("hiddenmarker", false))).toEqual([]);
      await files.writeFile(path.join(root, ".ignore"), "shown.txt\n");
      watch.change(".ignore");
      expect(index.status().state).toBe("stale");
      await vi.waitFor(async () => {
        expect(index.status().state).toBe("ready");
        expect(await index.candidates(planQuery("hiddenmarker", false))).toEqual(["hidden.txt"]);
        expect(await index.candidates(planQuery("visiblemarker", false))).toEqual([]);
      }, { timeout: 5000 });
    } finally {
      await manager.dispose();
      watch.spy.mockRestore();
      await files.rm(root, { recursive: true, force: true });
    }
  });

  it("rebuilds when a nested directory becomes a worktree", async () => {
    const root = await files.mkdtemp(path.join(os.tmpdir(), "paseo-index-marker-"));
    const watch = watchFixture();
    const manager = new IndexManager();
    try {
      await files.mkdir(path.join(root, "nested"));
      await files.writeFile(path.join(root, "nested", "file.txt"), "nestedmarker");
      const index = await manager.get(root);
      await vi.waitFor(() => expect(index.status().state).toBe("ready"), { timeout: 5000 });
      expect(await index.candidates(planQuery("nestedmarker", false))).toEqual(["nested/file.txt"]);
      await files.writeFile(path.join(root, "nested", ".git"), "gitdir: ../.git/worktrees/nested\n");
      watch.change("nested/.git", "rename", root);
      expect(index.status().state).toBe("stale");
      await vi.waitFor(async () => {
        expect(index.status().state).toBe("ready");
        expect(await index.candidates(planQuery("nestedmarker", false))).toEqual([]);
      }, { timeout: 5000 });
    } finally {
      await manager.dispose();
      watch.spy.mockRestore();
      await files.rm(root, { recursive: true, force: true });
    }
  });

  it("ignores watcher changes in excluded paths without rebuilding the index", async () => {
    const root = await files.mkdtemp(path.join(os.tmpdir(), "paseo-index-watch-ignore-"));
    const watch = watchFixture();
    const manager = new IndexManager();
    let metadata: MockInstance<typeof files.lstat> | undefined;
    try {
      await files.mkdir(path.join(root, "logs"));
      await files.writeFile(path.join(root, ".ignore"), "logs/\n");
      await files.writeFile(path.join(root, "indexed.txt"), "indexedmarker");
      await files.writeFile(path.join(root, "queued.txt"), "initialmarker");
      await files.writeFile(path.join(root, "logs", "output.txt"), "ignoredmarker");
      const index = await manager.get(root);
      await vi.waitFor(() => expect(index.status().state).toBe("ready"), { timeout: 5000 });
      const startedAt = index.status().startedAt;
      metadata = vi.spyOn(files, "lstat");
      await files.writeFile(path.join(root, "logs", "output.txt"), "newignoredmarker");
      await files.writeFile(path.join(root, "queued.txt"), "freshmarker");
      watch.change("logs/output.txt");
      expect(index.status().state).toBe("ready");
      watch.change("queued.txt");
      await vi.waitFor(async () => {
        expect(await index.candidates(planQuery("initialmarker", false))).toEqual([]);
        expect(await index.candidates(planQuery("freshmarker", false))).toEqual(["queued.txt"]);
      }, { timeout: 5000 });
      expect(metadata.mock.calls.some(([filename]) => String(filename) === path.join(root, "logs"))).toBe(true);
      expect(index.status().startedAt).toBe(startedAt);
      expect(index.status().state).toBe("ready");
      expect(await index.candidates(planQuery("newignoredmarker", false))).toEqual([]);
    } finally {
      await manager.dispose();
      metadata?.mockRestore();
      watch.spy.mockRestore();
      await files.rm(root, { recursive: true, force: true });
    }
  });

  it("does not automatically read or watch the home directory or a filesystem root", async () => {
    const root = await files.mkdtemp(path.join(os.tmpdir(), "paseo-index-home-"));
    const home = vi.spyOn(os, "homedir").mockReturnValue(root);
    const watch = watchFixture();
    const manager = new IndexManager();
    let openSpy: MockInstance<typeof files.open> | undefined;
    try {
      await files.writeFile(path.join(root, "home.txt"), "homemarker");
      openSpy = vi.spyOn(files, "open");
      const index = await manager.get(root);
      const filesystemRoot = await manager.get(path.parse(root).root);
      expect(index.status().state).toBe("manual");
      expect(filesystemRoot.status().state).toBe("manual");
      expect(openSpy).not.toHaveBeenCalled();
      expect(watch.spy).not.toHaveBeenCalled();
      expect(await index.candidates(planQuery("homemarker", false))).toEqual(["home.txt"]);
      expect(index.status().state).toBe("manual");
      const controller = new AbortController();
      controller.abort();
      await expect(index.candidates({ alternatives: null }, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
      index.rebuild();
      expect(index.status().state).toBe("building");
      await vi.waitFor(() => expect(index.status().state).toBe("ready"), { timeout: 5000 });
      expect(await index.candidates(planQuery("homemarker", false))).toEqual(["home.txt"]);
      await manager.dispose();
      await expect(index.candidates({ alternatives: null })).rejects.toMatchObject({ name: "AbortError" });
    } finally {
      await manager.dispose();
      openSpy?.mockRestore();
      home.mockRestore();
      watch.spy.mockRestore();
      await files.rm(root, { recursive: true, force: true });
    }
  });

  it("does not automatically index a workspace inside a OneDrive root", async () => {
    const cloud = await files.mkdtemp(path.join(os.tmpdir(), "paseo-index-cloud-"));
    const workspace = path.join(cloud, "project");
    const watch = watchFixture();
    const manager = new IndexManager();
    vi.stubEnv("OneDrive", cloud);
    vi.stubEnv("OneDriveCommercial", "");
    vi.stubEnv("OneDriveConsumer", "");
    try {
      await files.mkdir(workspace);
      await files.writeFile(path.join(workspace, "a.txt"), "cloudmarker");
      const index = await manager.get(workspace);
      expect(index.status().state).toBe("manual");
      expect(watch.spy).not.toHaveBeenCalled();
    } finally {
      await manager.dispose();
      vi.unstubAllEnvs();
      watch.spy.mockRestore();
      await files.rm(cloud, { recursive: true, force: true });
    }
  });

  it("shares one repository build with subdirectory scopes and keeps the root ignore rules", async () => {
    const root = await files.mkdtemp(path.join(os.tmpdir(), "paseo-index-scopes-"));
    const watch = watchFixture();
    const manager = new IndexManager();
    let opened: MockInstance<typeof files.opendir> | undefined;
    try {
      await files.mkdir(path.join(root, ".git"));
      await files.mkdir(path.join(root, "src"));
      await files.mkdir(path.join(root, "src-other"));
      await files.writeFile(path.join(root, ".gitignore"), "*.ignored\n");
      await files.writeFile(path.join(root, "root.txt"), "sharedneedle");
      await files.writeFile(path.join(root, "src", "keep.txt"), "sharedneedle");
      await files.writeFile(path.join(root, "src", "drop.ignored"), "sharedneedle");
      await files.writeFile(path.join(root, "src-other", "other.txt"), "sharedneedle");
      const nested = await manager.get(path.join(root, "src"), { leaseId: "nested" });
      await vi.waitFor(() => expect(nested.status().state).toBe("ready"), { timeout: 5000 });
      const whole = await manager.get(root, { leaseId: "root" });
      expect(whole.status()).toMatchObject({ filesIndexed: 4, partial: false });
      expect(nested.status().startedAt).toBe(whole.status().startedAt);
      expect(nested.status().finishedAt).toBe(whole.status().finishedAt);
      expect(watch.spy).toHaveBeenCalledTimes(1);
      opened = vi.spyOn(files, "opendir");
      expect(await nested.candidates(planQuery("sharedneedle", false))).toEqual(["keep.txt"]);
      expect(await whole.candidates(planQuery("sharedneedle", false))).toEqual(["root.txt", "src-other/other.txt", "src/keep.txt"]);
      expect(opened).not.toHaveBeenCalled();
      if (process.platform === "win32") expect(await manager.get(root.toUpperCase())).toBe(whole);
      manager.release("nested");
      manager.release("root");
    } finally {
      opened?.mockRestore();
      await manager.dispose();
      watch.spy.mockRestore();
      await files.rm(root, { recursive: true, force: true });
    }
  });

  it("unites repositories below a parent and reuses their units for another workspace", async () => {
    const root = await files.mkdtemp(path.join(os.tmpdir(), "paseo-index-union-"));
    const watch = watchFixture();
    const manager = new IndexManager();
    try {
      for (const name of ["alpha", "beta", "ignored"]) {
        await files.mkdir(path.join(root, name, ".git"), { recursive: true });
        await files.writeFile(path.join(root, name, "keep.txt"), "unionneedle");
        await files.writeFile(path.join(root, name, "drop.txt"), "unionneedle");
        await files.writeFile(path.join(root, name, ".ignore"), "drop.txt\n");
      }
      await files.writeFile(path.join(root, ".ignore"), "ignored/\n");
      await files.writeFile(path.join(root, "parent.txt"), "unionneedle");
      const parent = await manager.get(root, { leaseId: "parent" });
      await vi.waitFor(() => expect(parent.status().state).toBe("ready"), { timeout: 5000 });
      expect(await parent.candidates(planQuery("unionneedle", false))).toEqual(["alpha/keep.txt", "beta/keep.txt", "parent.txt"]);
      expect(parent.status()).toMatchObject({ filesIndexed: 6, partial: false });
      expect(watch.spy).toHaveBeenCalledTimes(3);
      const before = parent.status();
      const alpha = await manager.get(path.join(root, "alpha"), { leaseId: "alpha" });
      expect(alpha.status().state).toBe("ready");
      expect(alpha.status().filesIndexed).toBe(2);
      expect(await alpha.candidates(planQuery("unionneedle", false))).toEqual(["keep.txt"]);
      expect(watch.spy).toHaveBeenCalledTimes(3);
      expect(parent.status().startedAt).toBe(before.startedAt);
      expect(parent.status().finishedAt).toBe(before.finishedAt);
    } finally {
      await manager.dispose();
      watch.spy.mockRestore();
      await files.rm(root, { recursive: true, force: true });
    }
  });

  it("includes submodules but excludes nested worktrees from parent scopes", async () => {
    const root = await files.mkdtemp(path.join(os.tmpdir(), "paseo-index-unit-kinds-"));
    const watch = watchFixture();
    const manager = new IndexManager();
    try {
      await files.mkdir(path.join(root, ".git"));
      for (const name of ["module", "tree", "independent"]) {
        await files.mkdir(path.join(root, name));
        await files.writeFile(path.join(root, name, "file.txt"), "kindneedle");
      }
      await files.writeFile(path.join(root, "module", ".git"), "gitdir: ../.git/worktrees/owner/modules/module\n");
      await files.writeFile(path.join(root, "tree", ".git"), "gitdir: ../.git/worktrees/tree\n");
      await files.mkdir(path.join(root, "independent", ".git"));
      await files.writeFile(path.join(root, "file.txt"), "kindneedle");
      const parent = await manager.get(root);
      await vi.waitFor(() => expect(parent.status().state).toBe("ready"), { timeout: 5000 });
      expect(await parent.candidates(planQuery("kindneedle", false))).toEqual(["file.txt", "independent/file.txt", "module/file.txt"]);
      expect(watch.spy).toHaveBeenCalledTimes(3);
      const tree = await manager.get(path.join(root, "tree"));
      await vi.waitFor(() => expect(tree.status().state).toBe("ready"), { timeout: 5000 });
      expect(await tree.candidates(planQuery("kindneedle", false))).toEqual(["file.txt"]);
      expect(await parent.candidates(planQuery("kindneedle", false))).toEqual(["file.txt", "independent/file.txt", "module/file.txt"]);
      expect(watch.spy).toHaveBeenCalledTimes(4);
    } finally {
      await manager.dispose();
      watch.spy.mockRestore();
      await files.rm(root, { recursive: true, force: true });
    }
  });

  it("drops parent watcher events below a child root and lets the child apply its own ignores", async () => {
    const root = await files.mkdtemp(path.join(os.tmpdir(), "paseo-index-child-watch-"));
    const child = path.join(root, "child");
    const watch = watchFixture();
    const manager = new IndexManager();
    let opened: MockInstance<typeof files.open> | undefined;
    try {
      await files.mkdir(path.join(child, ".git"), { recursive: true });
      await files.writeFile(path.join(root, "file.txt"), "parentneedle");
      await files.writeFile(path.join(child, "file.txt"), "oldchildneedle");
      const parent = await manager.get(root);
      await vi.waitFor(() => expect(parent.status().state).toBe("ready"), { timeout: 5000 });
      const childScope = await manager.get(child);
      const parentFinished = parent.status().finishedAt;
      opened = vi.spyOn(files, "open");
      await files.writeFile(path.join(child, "file.txt"), "newchildneedle");
      watch.change("child/file.txt", "change", root);
      expect(await parent.candidates(planQuery("newchildneedle", false))).toEqual([]);
      expect(parent.status().finishedAt).toBe(parentFinished);
      expect(opened).not.toHaveBeenCalled();
      watch.change("file.txt", "change", child);
      await vi.waitFor(async () => {
        expect(await parent.candidates(planQuery("newchildneedle", false))).toEqual(["child/file.txt"]);
        expect(await childScope.candidates(planQuery("oldchildneedle", false))).toEqual([]);
      }, { timeout: 5000 });
      const childStarted = childScope.status().startedAt;
      await files.writeFile(path.join(child, ".ignore"), "file.txt\n");
      watch.change("child/.ignore", "change", root);
      expect(childScope.status().startedAt).toBe(childStarted);
      expect(parent.status().state).toBe("ready");
      watch.change(".ignore", "change", child);
      await vi.waitFor(async () => {
        expect(childScope.status().state).toBe("ready");
        expect(await parent.candidates(planQuery("newchildneedle", false))).toEqual([]);
      }, { timeout: 5000 });
      expect(watch.spy).toHaveBeenCalledTimes(2);
    } finally {
      opened?.mockRestore();
      await manager.dispose();
      watch.spy.mockRestore();
      await files.rm(root, { recursive: true, force: true });
    }
  });

  it("discovers home repositories only for queries or an explicit build and reuses built children", async () => {
    const root = await files.mkdtemp(path.join(os.tmpdir(), "paseo-index-manual-union-"));
    const home = vi.spyOn(os, "homedir").mockReturnValue(root);
    const watch = watchFixture();
    const manager = new IndexManager();
    let opened: MockInstance<typeof files.open> | undefined;
    let walked: MockInstance<typeof files.opendir> | undefined;
    try {
      for (const name of ["first", "second"]) {
        await files.mkdir(path.join(root, name, ".git"), { recursive: true });
        await files.writeFile(path.join(root, name, "file.txt"), "manualneedle");
      }
      await files.writeFile(path.join(root, "home.txt"), "manualneedle");
      opened = vi.spyOn(files, "open");
      walked = vi.spyOn(files, "opendir");
      const scope = await manager.get(root, { leaseId: "home" });
      expect(scope.status()).toMatchObject({ state: "manual", filesIndexed: 0, partial: false });
      expect(opened).not.toHaveBeenCalled();
      expect(walked).not.toHaveBeenCalled();
      expect(watch.spy).not.toHaveBeenCalled();
      expect(await scope.candidates(planQuery("manualneedle", false))).toEqual(["first/file.txt", "home.txt", "second/file.txt"]);
      expect(scope.status().state).toBe("manual");
      expect(watch.spy).not.toHaveBeenCalled();
      const first = await manager.get(path.join(root, "first"));
      await vi.waitFor(() => expect(first.status().state).toBe("ready"), { timeout: 5000 });
      walked.mockClear();
      expect(await scope.candidates(planQuery("manualneedle", false))).toEqual(["first/file.txt", "home.txt", "second/file.txt"]);
      expect(walked.mock.calls.some(([directory]) => path.resolve(String(directory)) === path.join(root, "first"))).toBe(false);
      expect(watch.spy).toHaveBeenCalledTimes(1);
      await files.mkdir(path.join(root, "second", "nested", ".git"), { recursive: true });
      await files.writeFile(path.join(root, "second", "nested", "file.txt"), "manualneedle");
      scope.rebuild();
      await vi.waitFor(() => expect(scope.status().state).toBe("ready"), { timeout: 5000 });
      expect(scope.status()).toMatchObject({ filesIndexed: 4, partial: false });
      expect(watch.spy).toHaveBeenCalledTimes(4);
      expect(await scope.candidates(planQuery("manualneedle", false))).toEqual(["first/file.txt", "home.txt", "second/file.txt", "second/nested/file.txt"]);
    } finally {
      opened?.mockRestore();
      walked?.mockRestore();
      await manager.dispose();
      watch.spy.mockRestore();
      home.mockRestore();
      await files.rm(root, { recursive: true, force: true });
    }
  });

  it("keeps cloud scopes manual when their shared root is ready and indexes an explicit cloud prefix", async () => {
    const root = await files.mkdtemp(path.join(os.tmpdir(), "paseo-index-cloud-scope-"));
    const cloud = path.join(root, "Cloud");
    const workspace = path.join(cloud, "project");
    const watch = watchFixture();
    const manager = new IndexManager();
    let opened: MockInstance<typeof files.open> | undefined;
    let walked: MockInstance<typeof files.opendir> | undefined;
    vi.stubEnv("OneDrive", cloud);
    vi.stubEnv("OneDriveCommercial", "");
    vi.stubEnv("OneDriveConsumer", "");
    try {
      await files.mkdir(path.join(root, ".git"));
      await files.mkdir(path.join(workspace, "child", ".git"), { recursive: true });
      await files.mkdir(path.join(cloud, "other"));
      await files.writeFile(path.join(root, ".gitignore"), "*.ignored\n");
      await files.writeFile(path.join(root, "local.txt"), "cloudneedle");
      await files.writeFile(path.join(workspace, "keep.txt"), "cloudneedle");
      await files.writeFile(path.join(workspace, "drop.ignored"), "cloudneedle");
      await files.writeFile(path.join(workspace, "child", "file.txt"), "cloudneedle");
      await files.writeFile(path.join(cloud, "other", "secret.txt"), "cloudneedle");
      opened = vi.spyOn(files, "open");
      walked = vi.spyOn(files, "opendir");
      const scope = await manager.get(workspace);
      expect(scope.status().state).toBe("manual");
      expect(opened).not.toHaveBeenCalled();
      expect(walked).not.toHaveBeenCalled();
      expect(watch.spy).not.toHaveBeenCalled();
      const parent = await manager.get(root);
      await vi.waitFor(() => expect(parent.status().state).toBe("ready"), { timeout: 5000 });
      expect(scope.status().state).toBe("manual");
      expect(await scope.candidates(planQuery("cloudneedle", false))).toEqual(["child/file.txt", "keep.txt"]);
      expect(await parent.candidates(planQuery("cloudneedle", false))).toEqual(["local.txt"]);
      scope.rebuild();
      await vi.waitFor(() => expect(scope.status().state).toBe("ready"), { timeout: 5000 });
      expect(await scope.candidates(planQuery("cloudneedle", false))).toEqual(["child/file.txt", "keep.txt"]);
      expect(await parent.candidates(planQuery("cloudneedle", false))).toEqual(["local.txt"]);
      expect(opened.mock.calls.some(([filename]) => String(filename).includes(`${path.sep}other${path.sep}`))).toBe(false);
      expect(watch.spy).toHaveBeenCalledTimes(2);
    } finally {
      opened?.mockRestore();
      walked?.mockRestore();
      await manager.dispose();
      watch.spy.mockRestore();
      vi.unstubAllEnvs();
      await files.rm(root, { recursive: true, force: true });
    }
  });

  it("keeps leased units through LRU eviction and releases the previous scope when a lease moves", async () => {
    const root = await files.mkdtemp(path.join(os.tmpdir(), "paseo-index-leases-"));
    const watch = watchFixture();
    const manager = new IndexManager();
    try {
      const directories: string[] = [];
      for (let index = 0; index < 67; index++) {
        const directory = path.join(root, String(index));
        await files.mkdir(path.join(directory, ".git"), { recursive: true });
        directories.push(directory);
      }
      const pinned = await manager.get(directories[0], { leaseId: "tab" });
      await vi.waitFor(() => expect(pinned.status().state).toBe("ready"), { timeout: 5000 });
      const finishedAt = pinned.status().finishedAt;
      for (const directory of directories.slice(1, 65)) {
        const scope = await manager.get(directory);
        await vi.waitFor(() => expect(scope.status().state).toBe("ready"), { timeout: 5000, interval: 5 });
      }
      expect(watch.watcher.close).not.toHaveBeenCalled();
      expect(pinned.status().finishedAt).toBe(finishedAt);
      await manager.get(directories[64], { leaseId: "tab" });
      const last = await manager.get(directories[65]);
      await vi.waitFor(() => expect(last.status().state).toBe("ready"), { timeout: 5000 });
      expect(watch.watcher.close).toHaveBeenCalledTimes(1);
      manager.release("tab");
      const released = await manager.get(directories[66], { leaseId: "temporary" });
      await vi.waitFor(() => expect(released.status().state).toBe("ready"), { timeout: 5000 });
      expect(last.status().state).toBe("ready");
      manager.release("temporary");
      expect(watch.spy).toHaveBeenCalledTimes(67);
    } finally {
      await manager.dispose();
      watch.spy.mockRestore();
      await files.rm(root, { recursive: true, force: true });
    }
  });

  it("does not automatically build a home repository for a subdirectory scope", async () => {
    const root = await files.mkdtemp(path.join(os.tmpdir(), "paseo-index-home-repository-"));
    const home = vi.spyOn(os, "homedir").mockReturnValue(root);
    const watch = watchFixture();
    const manager = new IndexManager();
    let opened: MockInstance<typeof files.open> | undefined;
    try {
      await files.mkdir(path.join(root, ".git"));
      await files.mkdir(path.join(root, "project"));
      await files.writeFile(path.join(root, ".gitignore"), "*.ignored\n");
      await files.writeFile(path.join(root, "outside.txt"), "homeneedle");
      await files.writeFile(path.join(root, "project", "keep.txt"), "homeneedle");
      await files.writeFile(path.join(root, "project", "drop.ignored"), "homeneedle");
      opened = vi.spyOn(files, "open");
      const scope = await manager.get(path.join(root, "project"));
      expect(scope.status().state).toBe("manual");
      expect(opened).not.toHaveBeenCalled();
      expect(watch.spy).not.toHaveBeenCalled();
      expect(await scope.candidates(planQuery("homeneedle", false))).toEqual(["keep.txt"]);
      expect(watch.spy).not.toHaveBeenCalled();
    } finally {
      opened?.mockRestore();
      await manager.dispose();
      home.mockRestore();
      watch.spy.mockRestore();
      await files.rm(root, { recursive: true, force: true });
    }
  });

  it("keeps unindexed files in scoped candidates when a shared unit is partial", async () => {
    const root = await files.mkdtemp(path.join(os.tmpdir(), "paseo-index-partial-scope-"));
    const watch = watchFixture();
    const manager = new IndexManager();
    const originalOpen = files.open;
    let opened: MockInstance<typeof files.open> | undefined;
    try {
      await files.mkdir(path.join(root, ".git"));
      await files.mkdir(path.join(root, "project"));
      await files.writeFile(path.join(root, "outside.txt"), "partialneedle");
      await files.writeFile(path.join(root, "project", "file.txt"), "partialneedle");
      opened = vi.spyOn(files, "open").mockImplementation(async (...args) => {
        if (String(args[0]) === path.join(root, "project", "file.txt")) {
          throw Object.assign(new Error("The file is temporarily unavailable."), { code: "EACCES" });
        }
        return originalOpen(...args);
      });
      const scope = await manager.get(path.join(root, "project"));
      await vi.waitFor(() => expect(scope.status().state).toBe("ready"), { timeout: 5000 });
      expect(scope.status()).toMatchObject({ filesIndexed: 1, partial: true });
      opened.mockRestore();
      expect(await scope.candidates(planQuery("partialneedle", false))).toEqual(["file.txt"]);
      expect(watch.spy).toHaveBeenCalledTimes(1);
    } finally {
      opened?.mockRestore();
      await manager.dispose();
      watch.spy.mockRestore();
      await files.rm(root, { recursive: true, force: true });
    }
  });
});
