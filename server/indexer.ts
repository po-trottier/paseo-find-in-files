import { watch, type FSWatcher } from "node:fs";
import files from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setImmediate as yieldTurn } from "node:timers/promises";
import type { IndexStatus } from "../shared/index";
import { checkAborted, insideCloudRoot, WorkspaceFiles, type IndexFileRead, type WalkFile } from "./files";
import { trigrams, type QueryPlan } from "./planner";

const MAX_POSTING_ENTRIES = 32_000_000;
const MAX_TRIGRAMS = 400_000;
const MAX_DOCUMENTS = 200_000;
const MAX_PATH_UNITS = 16_000_000;
const MAX_PENDING_PATHS = 4096;
const MAX_DIRECTORIES = 64;
const WATCH_DEBOUNCE_MS = 100;

type Posting = { ids: Uint32Array; length: number };
type Document = WalkFile & { alive: boolean };

class IndexBudget {
  postingEntries = 0;
  trigramCount = 0;
  documents = 0;
  pathUnits = 0;
  pendingPaths = 0;
  private work: Promise<void> = Promise.resolve();

  run(operation: () => Promise<void>): Promise<void> {
    const result = this.work.then(operation);
    this.work = result.catch(() => {});
    return result;
  }
}

function directoryKey(directory: string): string {
  return process.platform === "win32" ? directory.toLowerCase() : directory;
}

export class IndexManager {
  private readonly indexes = new Map<string, WorkspaceIndex>();
  private readonly budget = new IndexBudget();
  private home: Promise<string> | undefined;
  private closed = false;

  async get(directory: string): Promise<WorkspaceIndex> {
    if (this.closed) throw new Error("The search indexes are closed.");
    const canonical = await files.realpath(directory);
    this.home ??= files.realpath(os.homedir()).catch(() => path.resolve(os.homedir()));
    const home = await this.home;
    if (this.closed) throw new Error("The search indexes are closed.");
    const key = directoryKey(canonical);
    const existing = this.indexes.get(key);
    if (existing) {
      this.indexes.delete(key);
      this.indexes.set(key, existing);
      return existing;
    }
    const manual = key === directoryKey(home) || key === directoryKey(path.parse(canonical).root)
      || await insideCloudRoot(canonical);
    if (this.closed) throw new Error("The search indexes are closed.");
    const raced = this.indexes.get(key);
    if (raced) return raced;
    const index = new WorkspaceIndex(canonical, this.budget, manual);
    this.indexes.set(key, index);
    if (this.indexes.size > MAX_DIRECTORIES) {
      const oldest = this.indexes.entries().next().value;
      if (oldest) {
        this.indexes.delete(oldest[0]);
        void oldest[1].close();
      }
    }
    if (!manual) index.rebuild();
    return index;
  }

  async dispose(): Promise<void> {
    this.closed = true;
    const closing = Array.from(this.indexes.values(), (index) => index.close());
    this.indexes.clear();
    await Promise.all(closing);
    await this.budget.run(async () => {});
  }
}

export class WorkspaceIndex {
  private readonly postings = new Map<number, Posting>();
  private readonly documents: Document[] = [];
  private readonly byPath = new Map<string, number>();
  private readonly dirtyPaths = new Map<string, number>();
  private readonly lifetime = new AbortController();
  private watcher: FSWatcher | undefined;
  private watcherError: string | undefined;
  private timer: NodeJS.Timeout | undefined;
  private buildTask: Promise<void> | undefined;
  private refreshTask: Promise<void> | undefined;
  private buildController: AbortController | undefined;
  private rebuildRequested = false;
  private closed = false;
  private generation = 0;
  private eventVersion = 0;
  private tombstones = 0;
  private liveDocuments = 0;
  private capped = false;
  private state: IndexStatus;

  constructor(private readonly directory: string, private readonly budget = new IndexBudget(), manual = false) {
    this.state = {
      state: manual ? "manual" : "idle",
      filesIndexed: 0,
      filesSkipped: 0,
      startedAt: null,
      finishedAt: null,
      durationMs: 0,
      partial: false,
    };
  }

  status(): IndexStatus {
    return {
      ...this.state,
      filesIndexed: this.liveDocuments,
      durationMs: this.state.startedAt === null ? 0
        : (this.state.finishedAt ?? Date.now()) - this.state.startedAt,
    };
  }

  rebuild(): void {
    if (this.closed) return;
    this.rebuildRequested = true;
    this.state = {
      state: "building", filesIndexed: 0, filesSkipped: 0,
      startedAt: Date.now(), finishedAt: null, durationMs: 0, partial: false,
    };
    this.buildController?.abort();
    clearTimeout(this.timer);
    this.timer = undefined;
    this.startWatcher();
    if (this.buildTask) return;
    // ponytail: the in-memory index rebuilds on restart. Add persistence only if needed.
    this.buildTask = this.budget.run(async () => {
      while (this.rebuildRequested && !this.closed) {
        this.rebuildRequested = false;
        this.clearIndex();
        this.clearDirty();
        this.capped = false;
        this.state = {
          state: "building", filesIndexed: 0, filesSkipped: 0,
          startedAt: Date.now(), finishedAt: null, durationMs: 0, partial: false,
        };
        const controller = new AbortController();
        this.buildController = controller;
        const access = new WorkspaceFiles(this.directory);
        const iterator = access.walk(controller.signal);
        const pending: Promise<{ file: WalkFile; result: IndexFileRead }>[] = [];
        try {
          let finished = false;
          while (!finished || pending.length) {
            while (!finished && pending.length < 16) {
              const next = await iterator.next();
              if (next.done) { finished = true; break; }
              const file = next.value;
              checkAborted(controller.signal);
              if (this.capped) { this.state.filesSkipped++; continue; }
              pending.push(access.read(file.relativePath).then((result) => ({ file, result })));
            }
            if (!pending.length) continue;
            const { file, result } = await pending.shift()!;
            checkAborted(controller.signal);
            if (!result.bytes) {
              this.state.filesSkipped++;
              this.state.partial ||= result.retry;
            } else if (!this.add(file, result.bytes)) {
              this.state.filesSkipped++;
            }
            await yieldTurn();
          }
          this.state.partial ||= access.partial;
          await this.refreshDirty(controller.signal, access);
        } catch (error) {
          if (!controller.signal.aborted) throw error;
        } finally {
          try {
            await iterator.return(undefined);
          } finally {
            await Promise.allSettled(pending);
          }
        }
        if (this.closed) return;
        if (this.rebuildRequested) return;
        const finishedAt = Date.now();
        this.state = {
          ...this.state,
          state: this.watcherError ? "stale" : "ready",
          finishedAt,
          durationMs: finishedAt - (this.state.startedAt ?? finishedAt),
          ...(this.watcherError ? { error: this.watcherError } : {}),
        };
      }
    }).catch((error: unknown) => {
      if (!this.closed) this.state = {
        ...this.state, state: "error", partial: true, finishedAt: Date.now(),
        error: error instanceof Error ? error.message : String(error),
      };
    }).finally(() => {
      this.buildController = undefined;
      this.buildTask = undefined;
      if (!this.closed && this.rebuildRequested) this.rebuild();
      else if (!this.closed && this.dirtyPaths.size) this.scheduleRefresh();
    });
  }

  async candidates(plan: QueryPlan, signal?: AbortSignal): Promise<string[]> {
    checkAborted(signal);
    checkAborted(this.lifetime.signal);
    if (!signal) return this.selectCandidates(plan, this.lifetime.signal);
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener("abort", abort, { once: true });
    this.lifetime.signal.addEventListener("abort", abort, { once: true });
    try {
      return await this.selectCandidates(plan, controller.signal);
    } finally {
      signal.removeEventListener("abort", abort);
      this.lifetime.signal.removeEventListener("abort", abort);
    }
  }

  private async selectCandidates(plan: QueryPlan, signal: AbortSignal): Promise<string[]> {
    checkAborted(signal);
    if (this.closed || this.state.state !== "ready") return this.freshCandidates(signal);
    const generation = this.generation;
    const eventVersion = this.eventVersion;
    const selected = new Set<string>();
    let pathUnits = 0;
    const add = (relativePath: string) => {
      if (selected.has(relativePath)) return;
      if (selected.size >= MAX_DOCUMENTS || pathUnits + relativePath.length > MAX_PATH_UNITS) {
        throw new Error("The search exceeds the candidate path limit (200000 files or 16 million path characters).");
      }
      selected.add(relativePath);
      pathUnits += relativePath.length;
    };
    let steps = 0;
    if (plan.alternatives === null || plan.alternatives.some((alternative) => !alternative.length)) {
      for (const document of this.documents) {
        if (document.alive) add(document.relativePath);
        if (++steps % 2048 === 0) { checkAborted(signal); await yieldTurn(); }
      }
    } else {
      for (const alternative of plan.alternatives) {
        const lists: Posting[] = [];
        for (const gram of alternative) {
          const posting = this.postings.get(gram);
          if (!posting) { lists.length = 0; break; }
          lists.push(posting);
        }
        if (!lists.length) continue;
        lists.sort((left, right) => left.length - right.length);
        let intersection = lists[0].ids.slice(0, lists[0].length);
        for (let index = 1; index < lists.length && intersection.length; index++) {
          const next = lists[index];
          let left = 0;
          let right = 0;
          let count = 0;
          while (left < intersection.length && right < next.length) {
            if (intersection[left] === next.ids[right]) {
              intersection[count++] = intersection[left++];
              right++;
            }
            else if (intersection[left] < next.ids[right]) left++;
            else right++;
            if (++steps % 4096 === 0) { checkAborted(signal); await yieldTurn(); }
          }
          intersection = intersection.subarray(0, count);
        }
        for (const id of intersection) {
          const document = this.documents[id];
          if (document?.alive) add(document.relativePath);
          if (++steps % 2048 === 0) { checkAborted(signal); await yieldTurn(); }
        }
      }
    }
    for (const relativePath of this.dirtyPaths.keys()) add(relativePath);
    if (this.state.partial) {
      const access = new WorkspaceFiles(this.directory);
      for await (const file of access.walk(signal)) {
        const id = this.byPath.get(file.relativePath);
        if (id === undefined || !this.documents[id]?.alive) add(file.relativePath);
      }
      this.state.partial ||= access.partial;
    }
    checkAborted(signal);
    if (generation !== this.generation || eventVersion !== this.eventVersion || this.state.state !== "ready") {
      return this.freshCandidates(signal);
    }
    return Array.from(selected);
  }

  async close(): Promise<void> {
    if (!this.closed) {
      this.closed = true;
      this.lifetime.abort();
      this.buildController?.abort();
      this.rebuildRequested = false;
      this.watcher?.close();
      this.watcher = undefined;
      clearTimeout(this.timer);
      this.timer = undefined;
      this.clearDirty();
      this.clearIndex();
      this.state = { ...this.state, state: "stale" };
    }
    await this.buildTask;
    await this.refreshTask;
  }

  private async freshCandidates(signal?: AbortSignal): Promise<string[]> {
    const candidates: string[] = [];
    let pathUnits = 0;
    const access = new WorkspaceFiles(this.directory);
    for await (const file of access.walk(signal)) {
      if (candidates.length >= MAX_DOCUMENTS || pathUnits + file.relativePath.length > MAX_PATH_UNITS) {
        throw new Error("The search exceeds the candidate path limit (200000 files or 16 million path characters).");
      }
      candidates.push(file.relativePath);
      pathUnits += file.relativePath.length;
    }
    this.state.partial ||= access.partial;
    return candidates;
  }

  private add(file: WalkFile, bytes: Buffer): boolean {
    if (this.capped) return false;
    const grams = trigrams(bytes);
    let newTrigrams = 0;
    let growth = 0;
    let peakGrowth = 0;
    for (const gram of grams) {
      const posting = this.postings.get(gram);
      if (!posting) {
        newTrigrams++;
        growth += 4;
        peakGrowth = Math.max(peakGrowth, growth);
      } else if (posting.length === posting.ids.length) {
        const nextCapacity = posting.ids.length * 2;
        peakGrowth = Math.max(peakGrowth, growth + nextCapacity);
        growth += nextCapacity - posting.ids.length;
      }
    }
    if (this.budget.documents >= MAX_DOCUMENTS
      || this.budget.pathUnits + file.relativePath.length > MAX_PATH_UNITS
      || this.budget.trigramCount + newTrigrams > MAX_TRIGRAMS
      || this.budget.postingEntries + peakGrowth > MAX_POSTING_ENTRIES) {
      this.capped = true;
      this.state.partial = true;
      return false;
    }
    const id = this.documents.length;
    this.documents.push({ ...file, alive: true });
    this.byPath.set(file.relativePath, id);
    this.budget.documents++;
    this.budget.pathUnits += file.relativePath.length;
    this.liveDocuments++;
    this.generation++;
    for (const gram of grams) {
      let posting = this.postings.get(gram);
      if (!posting) {
        posting = { ids: new Uint32Array(4), length: 0 };
        this.postings.set(gram, posting);
        this.budget.postingEntries += 4;
        this.budget.trigramCount++;
      } else if (posting.length === posting.ids.length) {
        const capacity = posting.ids.length * 2;
        this.budget.postingEntries += capacity;
        const grown = new Uint32Array(capacity);
        grown.set(posting.ids);
        this.budget.postingEntries -= posting.ids.length;
        posting.ids = grown;
      }
      posting.ids[posting.length++] = id;
    }
    return true;
  }

  private remove(relativePath: string): void {
    const id = this.byPath.get(relativePath);
    if (id === undefined) return;
    this.byPath.delete(relativePath);
    const document = this.documents[id];
    if (!document.alive) return;
    document.alive = false;
    this.liveDocuments--;
    this.tombstones++;
    this.generation++;
  }

  private clearIndex(): void {
    this.generation++;
    const empty = new Uint32Array(0);
    for (const posting of this.postings.values()) {
      this.budget.postingEntries -= posting.ids.length;
      posting.ids = empty;
      posting.length = 0;
    }
    this.budget.trigramCount -= this.postings.size;
    for (const document of this.documents) this.budget.pathUnits -= document.relativePath.length;
    this.budget.documents -= this.documents.length;
    this.postings.clear();
    this.documents.length = 0;
    this.byPath.clear();
    this.liveDocuments = 0;
    this.tombstones = 0;
  }

  private clearDirty(): void {
    for (const relativePath of this.dirtyPaths.keys()) this.budget.pathUnits -= relativePath.length;
    this.budget.pendingPaths -= this.dirtyPaths.size;
    this.dirtyPaths.clear();
  }

  private startWatcher(): void {
    if (this.watcher || this.closed) return;
    this.watcherError = undefined;
    try {
      this.watcher = watch(this.directory, { recursive: true }, (_event, filename) => {
        if (this.closed) return;
        const relativePath = filename?.toString().split(path.sep).join("/");
        if (relativePath?.split("/").some((part) => part.toLowerCase() === ".git")) {
          if (path.posix.basename(relativePath).toLowerCase() === ".git") this.requestRebuild();
          return;
        }
        this.eventVersion++;
        if (!relativePath || relativePath.split("/").some((part) => !part || part === "." || part === "..")
          || path.isAbsolute(relativePath) || path.win32.isAbsolute(relativePath)
          || [".gitignore", ".ignore"].includes(path.posix.basename(relativePath))) {
          this.requestRebuild();
          return;
        }
        if (!this.dirtyPaths.has(relativePath)) {
          if (this.budget.pendingPaths >= MAX_PENDING_PATHS
            || this.budget.pathUnits + relativePath.length > MAX_PATH_UNITS) {
            this.requestRebuild();
            return;
          }
          this.budget.pendingPaths++;
          this.budget.pathUnits += relativePath.length;
        }
        this.dirtyPaths.set(relativePath, this.eventVersion);
        this.scheduleRefresh();
      });
      this.watcher.on("error", (error) => {
        this.watcherError = error.message;
        this.watcher?.close();
        this.watcher = undefined;
        this.state = { ...this.state, state: "stale", error: error.message };
      });
      this.watcher.unref();
    } catch (error) {
      this.watcherError = error instanceof Error ? error.message : String(error);
      this.state = { ...this.state, state: "stale", error: this.watcherError };
    }
  }

  private requestRebuild(): void {
    this.rebuildRequested = true;
    this.state = { ...this.state, state: "stale" };
    this.scheduleRefresh();
  }

  private scheduleRefresh(): void {
    if (this.closed) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (this.buildTask) return;
      if (this.rebuildRequested) { this.rebuild(); return; }
      if (this.refreshTask) return;
      this.refreshTask = this.budget.run(async () => {
        const access = new WorkspaceFiles(this.directory);
        await this.refreshDirty(this.lifetime.signal, access);
      }).catch((error: unknown) => {
        if (!this.closed) this.state = {
          ...this.state, state: "stale", partial: true,
          error: error instanceof Error ? error.message : String(error),
        };
      }).finally(() => {
        this.refreshTask = undefined;
        if (!this.closed && this.rebuildRequested) this.rebuild();
        else if (!this.closed && this.dirtyPaths.size) this.scheduleRefresh();
      });
    }, WATCH_DEBOUNCE_MS);
    this.timer.unref();
  }

  private async refreshDirty(signal: AbortSignal, access = new WorkspaceFiles(this.directory)): Promise<void> {
    while (this.dirtyPaths.size && !this.rebuildRequested) {
      checkAborted(signal);
      const [relativePath, eventVersion] = this.dirtyPaths.entries().next().value!;
      const existing = this.byPath.has(relativePath);
      let eligible: "file" | "directory" | null = "file";
      if (!existing) eligible = await access.eligible(relativePath, signal);
      if (eligible === "directory") { this.requestRebuild(); return; }
      const info = eligible ? await files.lstat(path.join(this.directory, relativePath)).catch((error: NodeJS.ErrnoException) => {
        if (["ENOENT", "ENOTDIR"].includes(error.code ?? "")) return null;
        throw error;
      }) : null;
      checkAborted(signal);
      if (info?.isDirectory()) { this.requestRebuild(); return; }
      const result = info ? await access.read(relativePath) : { bytes: null, retry: false };
      checkAborted(signal);
      this.remove(relativePath);
      if (result.bytes && info) this.add({ relativePath, size: info.size, mtimeMs: info.mtimeMs }, result.bytes);
      else if (info) {
        this.state.filesSkipped++;
        this.state.partial ||= result.retry;
      }
      this.state.partial ||= access.partial;
      if (eventVersion === this.dirtyPaths.get(relativePath) && this.dirtyPaths.delete(relativePath)) {
        this.budget.pendingPaths--;
        this.budget.pathUnits -= relativePath.length;
      }
      if (this.documents.length && this.tombstones > this.documents.length / 4) {
        this.requestRebuild();
        return;
      }
      await yieldTurn();
    }
  }
}
