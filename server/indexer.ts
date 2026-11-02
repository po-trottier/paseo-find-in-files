import { watch, type FSWatcher } from "node:fs";
import files from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setImmediate as yieldTurn } from "node:timers/promises";
import type { IndexStatus } from "../shared/index";
import { checkAborted, indexUnitRoot, insideCloudRoot, WorkspaceFiles, type IndexFileRead, type RepositoryBoundary, type WalkFile } from "./files";
import { trigrams, type QueryPlan } from "./planner";

const MAX_POSTING_ENTRIES = 32_000_000;
const MAX_TRIGRAMS = 400_000;
const MAX_DOCUMENTS = 200_000;
const MAX_PATH_UNITS = 16_000_000;
const MAX_PENDING_PATHS = 4096;
const MAX_DIRECTORIES = 64;
const MAX_SCOPES = 256;
const MAX_CHILD_ROOTS = 4096;
const MAX_AUTHORIZED_DIRECTORIES = 256;
const WATCH_DEBOUNCE_MS = 100;

type Posting = { ids: Uint32Array; length: number };
type Document = WalkFile & { alive: boolean };

class IndexBudget {
  postingEntries = 0;
  trigramCount = 0;
  documents = 0;
  pathUnits = 0;
  pendingPaths = 0;
  childRoots = 0;
  authorizedDirectories = 0;
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

function relativePath(directory: string, target: string): string {
  return path.relative(directory, target).split(path.sep).join("/");
}

function inDirectory(directory: string, target: string): boolean {
  const relative = path.relative(directoryKey(directory), directoryKey(target));
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function inPrefix(relativePath: string, prefix: string): boolean {
  return !prefix || directoryKey(relativePath).startsWith(`${directoryKey(prefix)}/`);
}

type ScopeUnit = { directory: string; index: WorkspaceIndex | undefined; parent?: WorkspaceIndex };

export class WorkspaceScope {
  explicit = false;
  partial = false;
  rebuildPending = false;
  readonly rebuiltUnits = new Set<WorkspaceIndex>();

  constructor(private readonly manager: IndexManager, readonly directory: string, public root: string,
    public manual: boolean, public cloud: boolean, public rootCloud: boolean,
    public allows: (relativePath: string, directory?: boolean) => boolean) {}

  status(): IndexStatus { return this.manager.scopeStatus(this); }
  rebuild(): void { this.manager.rebuildScope(this); }
  candidates(plan: QueryPlan, signal?: AbortSignal): Promise<string[]> {
    return this.manager.scopeCandidates(this, plan, signal);
  }
}

export class IndexManager {
  private readonly indexes = new Map<string, WorkspaceIndex>();
  private readonly scopes = new Map<string, WorkspaceScope>();
  private readonly leases = new Map<string, WorkspaceScope>();
  private readonly activeScopes = new Map<WorkspaceScope, number>();
  private readonly closing = new Set<Promise<void>>();
  private readonly budget = new IndexBudget();
  private readonly lifetime = new AbortController();
  private home: Promise<string> | undefined;
  private closed = false;
  private synchronizing = false;

  async get(directory: string, options: { leaseId?: string } = {}): Promise<WorkspaceScope> {
    if (this.closed) throw new Error("The search indexes are closed.");
    const canonical = await files.realpath(directory);
    this.home ??= files.realpath(os.homedir()).catch(() => path.resolve(os.homedir()));
    const [home, cloud, root, allows] = await Promise.all([
      this.home, insideCloudRoot(canonical), indexUnitRoot(canonical), new WorkspaceFiles(canonical).pathFilter(),
    ]);
    const rootCloud = cloud && await insideCloudRoot(root);
    if (this.closed) throw new Error("The search indexes are closed.");
    if (options.leaseId && !this.leases.has(options.leaseId) && this.leases.size >= MAX_SCOPES) {
      throw new Error("The search tab limit was reached (256 tabs).");
    }
    const key = directoryKey(canonical);
    const manual = key === directoryKey(home) || key === directoryKey(path.parse(canonical).root) || cloud
      || directoryKey(root) === directoryKey(home) || directoryKey(root) === directoryKey(path.parse(root).root);
    let scope = this.scopes.get(key);
    if (!scope) {
      if (this.scopes.size >= MAX_SCOPES) {
        const retained = new Set([...this.leases.values(), ...this.activeScopes.keys()]);
        const oldest = Array.from(this.scopes).find(([, value]) => !retained.has(value));
        if (!oldest) throw new Error("The workspace search scope limit was reached (256 workspaces).");
        this.scopes.delete(oldest[0]);
      }
      if (this.closed) throw new Error("The search indexes are closed.");
      scope = this.scopes.get(key) ?? new WorkspaceScope(this, canonical, root, manual, cloud, rootCloud, allows);
    }
    if (directoryKey(scope.root) !== directoryKey(root)) {
      scope.explicit = false;
      scope.rebuildPending = false;
      scope.rebuiltUnits.clear();
    }
    scope.root = root;
    scope.rootCloud = rootCloud;
    scope.manual = manual;
    scope.cloud = cloud;
    scope.allows = allows;
    this.scopes.delete(key);
    this.scopes.set(key, scope);
    if (options.leaseId) this.leases.set(options.leaseId, scope);
    this.activeScopes.set(scope, (this.activeScopes.get(scope) ?? 0) + 1);
    try {
      const index = this.unit(root);
      if (!scope.manual || scope.explicit) {
        if (index && ["idle", "manual"].includes(index.status().state)) index.rebuild();
        this.synchronize();
      }
    } finally {
      this.releaseActive(scope);
    }
    return scope;
  }

  release(leaseId: string): void {
    this.leases.delete(leaseId);
  }

  scopeStatus(scope: WorkspaceScope): IndexStatus {
    const units = this.scopeUnits(scope);
    const statuses = units.flatMap(({ index }) => index ? [index.status()] : []);
    const started = statuses.flatMap((status) => status.startedAt === null ? [] : [status.startedAt]);
    const finished = statuses.flatMap((status) => status.finishedAt === null ? [] : [status.finishedAt]);
    const state = scope.manual && !scope.explicit ? "manual"
      : scope.rebuildPending || statuses.some((status) => status.state === "building") ? "building"
      : statuses.some((status) => status.state === "error") ? "error"
      : statuses.some((status) => status.state === "stale") ? "stale"
      : units.some(({ index }) => !index) ? "stale"
      : statuses.some((status) => status.state === "idle" || status.state === "manual") ? "idle"
      : "ready";
    const startedAt = started.length ? Math.min(...started) : null;
    const finishedAt = state === "building" || !finished.length ? null : Math.max(...finished);
    const error = statuses.find((status) => status.error)?.error;
    return {
      state,
      filesIndexed: statuses.reduce((total, status) => total + status.filesIndexed, 0),
      filesSkipped: statuses.reduce((total, status) => total + status.filesSkipped, 0),
      startedAt, finishedAt,
      durationMs: startedAt === null ? 0 : (finishedAt ?? Date.now()) - startedAt,
      partial: scope.partial || ((!scope.manual || scope.explicit) && units.some(({ index }) => !index))
        || statuses.some((status) => status.partial),
      ...(error ? { error } : {}),
    };
  }

  rebuildScope(scope: WorkspaceScope): void {
    if (this.closed) return;
    scope.explicit = true;
    scope.partial = false;
    scope.rebuildPending = true;
    scope.rebuiltUnits.clear();
    this.activeScopes.set(scope, (this.activeScopes.get(scope) ?? 0) + 1);
    try {
      const index = this.unit(scope.root);
      if (!index) { scope.partial = true; scope.rebuildPending = false; return; }
      if (scope.cloud && !scope.rootCloud && !index.authorize(scope.directory)) scope.partial = true;
      scope.rebuiltUnits.add(index);
      index.rebuild();
    } finally {
      this.releaseActive(scope);
    }
  }

  async scopeCandidates(scope: WorkspaceScope, plan: QueryPlan, signal?: AbortSignal): Promise<string[]> {
    checkAborted(signal);
    checkAborted(this.lifetime.signal);
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    this.lifetime.signal.addEventListener("abort", abort, { once: true });
    this.activeScopes.set(scope, (this.activeScopes.get(scope) ?? 0) + 1);
    const selected = new Set<string>();
    const visited = new Set<string>();
    let pathUnits = 0;
    const add = (value: string) => {
      if (!scope.allows(value) || selected.has(value)) return;
      if (selected.size >= MAX_DOCUMENTS || pathUnits + value.length > MAX_PATH_UNITS) {
        throw new Error("The search exceeds the candidate path limit (200000 files or 16 million path characters).");
      }
      selected.add(value);
      pathUnits += value.length;
    };
    const visit = async (directory: string, prefix: string): Promise<void> => {
      checkAborted(controller.signal);
      const key = directoryKey(directory);
      if (visited.has(key)) return;
      if (visited.size >= MAX_CHILD_ROOTS) throw new Error("The search exceeds the repository limit (4096 units).");
      visited.add(key);
      const index = this.indexes.get(key);
      if (index) this.touch(key, index);
      const child = async (boundary: RepositoryBoundary) => {
        if (boundary.worktree) return;
        const childDirectory = path.join(directory, boundary.relativePath);
        if (!inDirectory(scope.directory, childDirectory)) return;
        if (!scope.allows(relativePath(scope.directory, childDirectory), true)) return;
        await visit(childDirectory, "");
      };
      const authorization = scope.cloud ? [scope.directory] : [];
      const forceFresh = scope.cloud && !scope.rootCloud && key === directoryKey(scope.root)
        && !index?.authorized(scope.directory);
      if (index) {
        const indexed = index.status().state === "ready" && !forceFresh;
        for (const value of await index.candidates(plan, controller.signal, prefix, child, authorization, forceFresh)) {
          add(relativePath(scope.directory, path.join(directory, value)));
        }
        if (indexed && index.status().state === "ready") {
          for (const boundary of index.boundaries()) await child(boundary);
        }
      } else {
        const access = new WorkspaceFiles(directory, child, authorization);
        for await (const file of access.walk(controller.signal, prefix)) {
          add(relativePath(scope.directory, path.join(directory, file.relativePath)));
        }
        scope.partial ||= access.partial;
      }
    };
    try {
      await visit(scope.root, relativePath(scope.root, scope.directory));
      checkAborted(controller.signal);
      return Array.from(selected).sort();
    } finally {
      signal?.removeEventListener("abort", abort);
      this.lifetime.signal.removeEventListener("abort", abort);
      this.releaseActive(scope);
    }
  }

  private releaseActive(scope: WorkspaceScope): void {
    const count = (this.activeScopes.get(scope) ?? 1) - 1;
    if (count) this.activeScopes.set(scope, count);
    else this.activeScopes.delete(scope);
  }

  private scopeUnits(scope: WorkspaceScope): ScopeUnit[] {
    const units: ScopeUnit[] = [];
    const seen = new Set<string>();
    const visit = (directory: string, parent?: WorkspaceIndex) => {
      const key = directoryKey(directory);
      if (seen.has(key)) return;
      seen.add(key);
      const index = this.indexes.get(key);
      units.push({ directory, index, parent });
      if (!index) return;
      for (const boundary of index.boundaries()) {
        if (boundary.worktree) continue;
        const child = path.join(directory, boundary.relativePath);
        if (inDirectory(scope.directory, child) && scope.allows(relativePath(scope.directory, child), true)) visit(child, index);
      }
    };
    visit(scope.root);
    return units;
  }

  private synchronize(): void {
    if (this.closed || this.synchronizing) return;
    this.synchronizing = true;
    try {
      for (const scope of new Set([...this.activeScopes.keys(), ...this.leases.values(), ...this.scopes.values()])) {
        const root = this.indexes.get(directoryKey(scope.root));
        if ((scope.manual && !scope.explicit) || !root || ["idle", "manual"].includes(root.status().state)) continue;
        const evict = this.activeScopes.has(scope) || scope.rebuildPending || Array.from(this.leases.values()).includes(scope);
        for (const unit of this.scopeUnits(scope)) {
          if (unit.parent?.working() || (scope.rebuildPending && unit.parent && !scope.rebuiltUnits.has(unit.parent))) continue;
          const index = unit.index ?? this.unit(unit.directory, evict);
          if (!index) continue;
          if (scope.rebuildPending && !scope.rebuiltUnits.has(index)) {
            scope.rebuiltUnits.add(index);
            index.rebuild();
          }
          if (["idle", "manual"].includes(index.status().state)) index.rebuild();
        }
        if (scope.rebuildPending && this.scopeUnits(scope).every(({ index }) => !index || !index.working())) {
          scope.rebuildPending = false;
          scope.rebuiltUnits.clear();
        }
      }
    } finally {
      this.synchronizing = false;
    }
  }

  private touch(key: string, index: WorkspaceIndex): void {
    this.indexes.delete(key);
    this.indexes.set(key, index);
  }

  private unit(directory: string, evict = true): WorkspaceIndex | undefined {
    const key = directoryKey(directory);
    const existing = this.indexes.get(key);
    if (existing) { this.touch(key, existing); return existing; }
    if (this.indexes.size >= MAX_DIRECTORIES) {
      if (!evict) return undefined;
      const pinned = new Set<string>();
      for (const scope of new Set([...this.leases.values(), ...this.activeScopes.keys()])) {
        for (const unit of this.scopeUnits(scope)) pinned.add(directoryKey(unit.directory));
      }
      const oldest = Array.from(this.indexes).find(([key, index]) => !pinned.has(key) && !index.working());
      if (!oldest) return undefined;
      this.indexes.delete(oldest[0]);
      const closing = oldest[1].close();
      this.closing.add(closing);
      void closing.finally(() => this.closing.delete(closing));
    }
    const index = new WorkspaceIndex(directory, this.budget, true, () => this.synchronize());
    this.indexes.set(key, index);
    return index;
  }

  async dispose(): Promise<void> {
    this.closed = true;
    this.lifetime.abort();
    this.leases.clear();
    this.scopes.clear();
    const closing = Array.from(this.indexes.values(), (index) => index.close());
    this.indexes.clear();
    await Promise.all([...closing, ...this.closing]);
    await this.budget.run(async () => {});
  }
}

export class WorkspaceIndex {
  private readonly postings = new Map<number, Posting>();
  private readonly documents: Document[] = [];
  private readonly byPath = new Map<string, number>();
  private readonly dirtyPaths = new Map<string, number>();
  private readonly childRoots = new Map<string, RepositoryBoundary>();
  private readonly authorizedDirectories = new Set<string>();
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

  constructor(private readonly directory: string, private readonly budget = new IndexBudget(), manual = false,
    private readonly topologyChanged: () => void = () => {}) {
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

  working(): boolean { return Boolean(this.buildTask || this.refreshTask || this.rebuildRequested); }

  boundaries(): Iterable<RepositoryBoundary> { return this.childRoots.values(); }

  authorized(directory: string): boolean {
    for (const authorized of this.authorizedDirectories) if (inDirectory(authorized, directory)) return true;
    return false;
  }

  authorize(directory: string): boolean {
    if (this.authorized(directory)) return true;
    if (this.budget.authorizedDirectories >= MAX_AUTHORIZED_DIRECTORIES
      || this.budget.pathUnits + directory.length > MAX_PATH_UNITS) return false;
    this.authorizedDirectories.add(directory);
    this.budget.authorizedDirectories++;
    this.budget.pathUnits += directory.length;
    return true;
  }

  private recordBoundary(boundary: RepositoryBoundary): void {
    const key = directoryKey(boundary.relativePath);
    const existing = this.childRoots.get(key);
    if (existing) {
      if (existing.worktree !== boundary.worktree) {
        this.childRoots.set(key, boundary);
        this.topologyChanged();
        this.eventVersion++;
      }
      return;
    }
    if (this.budget.childRoots >= MAX_CHILD_ROOTS
      || this.budget.pathUnits + boundary.relativePath.length > MAX_PATH_UNITS) {
      this.state.partial = true;
      return;
    }
    this.childRoots.set(key, boundary);
    this.budget.childRoots++;
    this.budget.pathUnits += boundary.relativePath.length;
    this.eventVersion++;
    this.topologyChanged();
  }

  private clearBoundaries(): void {
    for (const boundary of this.childRoots.values()) this.budget.pathUnits -= boundary.relativePath.length;
    this.budget.childRoots -= this.childRoots.size;
    this.childRoots.clear();
  }

  private childRoot(relativePath: string): string | undefined {
    let end = relativePath.length;
    while (end > 0) {
      const prefix = relativePath.slice(0, end);
      if (this.childRoots.has(directoryKey(prefix))) return prefix;
      end = relativePath.lastIndexOf("/", end - 1);
    }
    return undefined;
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
        this.clearBoundaries();
        this.clearDirty();
        this.capped = false;
        this.state = {
          state: "building", filesIndexed: 0, filesSkipped: 0,
          startedAt: Date.now(), finishedAt: null, durationMs: 0, partial: false,
        };
        const controller = new AbortController();
        this.buildController = controller;
        const access = new WorkspaceFiles(this.directory, (boundary) => this.recordBoundary(boundary), [...this.authorizedDirectories]);
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
      if (!this.closed) this.topologyChanged();
    });
  }

  async candidates(plan: QueryPlan, signal?: AbortSignal, prefix = "",
    onRepository?: (boundary: RepositoryBoundary) => Promise<void>, authorizedDirectories: readonly string[] = [],
    forceFresh = false): Promise<string[]> {
    checkAborted(signal);
    checkAborted(this.lifetime.signal);
    if (!signal) return this.selectCandidates(plan, this.lifetime.signal, prefix, onRepository, authorizedDirectories, forceFresh);
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener("abort", abort, { once: true });
    this.lifetime.signal.addEventListener("abort", abort, { once: true });
    try {
      return await this.selectCandidates(plan, controller.signal, prefix, onRepository, authorizedDirectories, forceFresh);
    } finally {
      signal.removeEventListener("abort", abort);
      this.lifetime.signal.removeEventListener("abort", abort);
    }
  }

  private async selectCandidates(plan: QueryPlan, signal: AbortSignal, prefix: string,
    onRepository: ((boundary: RepositoryBoundary) => Promise<void>) | undefined,
    authorizedDirectories: readonly string[], forceFresh: boolean): Promise<string[]> {
    checkAborted(signal);
    if (this.closed || this.state.state !== "ready" || forceFresh) {
      return this.freshCandidates(signal, prefix, onRepository, authorizedDirectories);
    }
    const generation = this.generation;
    const eventVersion = this.eventVersion;
    const selected = new Set<string>();
    let pathUnits = 0;
    const add = (relativePath: string) => {
      if (!inPrefix(relativePath, prefix) || this.childRoot(relativePath) || selected.has(relativePath)) return;
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
    if (this.dirtyPaths.size) {
      const access = new WorkspaceFiles(this.directory, async (boundary) => {
        this.recordBoundary(boundary);
        await onRepository?.(boundary);
      }, authorizedDirectories);
      for (const relativePath of this.dirtyPaths.keys()) {
        if (!inPrefix(relativePath, prefix) || this.childRoot(relativePath)) continue;
        if (this.byPath.has(relativePath)) add(relativePath);
        else {
          const eligible = await access.eligible(relativePath, signal);
          if (eligible === "directory") return this.freshCandidates(signal, prefix, onRepository, authorizedDirectories);
          if (eligible === "file") add(relativePath);
        }
      }
      this.state.partial ||= access.partial;
    }
    if (this.state.partial) {
      const access = new WorkspaceFiles(this.directory, async (boundary) => {
        this.recordBoundary(boundary);
        await onRepository?.(boundary);
      }, authorizedDirectories);
      for await (const file of access.walk(signal, prefix)) {
        const id = this.byPath.get(file.relativePath);
        if (id === undefined || !this.documents[id]?.alive) add(file.relativePath);
      }
      this.state.partial ||= access.partial;
    }
    checkAborted(signal);
    if (generation !== this.generation || eventVersion !== this.eventVersion || this.state.state !== "ready") {
      return this.freshCandidates(signal, prefix, onRepository, authorizedDirectories);
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
      this.clearBoundaries();
      for (const directory of this.authorizedDirectories) this.budget.pathUnits -= directory.length;
      this.budget.authorizedDirectories -= this.authorizedDirectories.size;
      this.authorizedDirectories.clear();
      this.state = { ...this.state, state: "stale" };
    }
    await this.buildTask;
    await this.refreshTask;
  }

  private async freshCandidates(signal?: AbortSignal, prefix = "",
    onRepository?: (boundary: RepositoryBoundary) => Promise<void>, authorizedDirectories: readonly string[] = []): Promise<string[]> {
    const candidates: string[] = [];
    let pathUnits = 0;
    const access = new WorkspaceFiles(this.directory, async (boundary) => {
      this.recordBoundary(boundary);
      await onRepository?.(boundary);
    }, authorizedDirectories);
    for await (const file of access.walk(signal, prefix)) {
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
        if (relativePath) {
          const child = this.childRoot(relativePath);
          if (child) {
            if (directoryKey(relativePath) === directoryKey(child)
              || directoryKey(relativePath) === `${directoryKey(child)}/.git`) this.requestRebuild();
            return;
          }
        }
        if (relativePath?.split("/").some((part) => part.toLowerCase() === ".git")) {
          if (path.posix.basename(relativePath).toLowerCase() === ".git") this.requestRebuild();
          return;
        }
        this.eventVersion++;
        if (!relativePath || relativePath.split("/").some((part) => !part || part === "." || part === "..")
          || path.isAbsolute(relativePath) || path.win32.isAbsolute(relativePath)
          || [".gitignore", ".ignore"].includes(path.posix.basename(relativePath).toLowerCase())) {
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
        const access = new WorkspaceFiles(this.directory, (boundary) => this.recordBoundary(boundary), [...this.authorizedDirectories]);
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
        if (!this.closed) this.topologyChanged();
      });
    }, WATCH_DEBOUNCE_MS);
    this.timer.unref();
  }

  private async refreshDirty(signal: AbortSignal, access = new WorkspaceFiles(this.directory,
    (boundary) => this.recordBoundary(boundary), [...this.authorizedDirectories])): Promise<void> {
    while (this.dirtyPaths.size && !this.rebuildRequested) {
      checkAborted(signal);
      const [relativePath, eventVersion] = this.dirtyPaths.entries().next().value!;
      if (this.childRoot(relativePath)) {
        this.remove(relativePath);
        this.dirtyPaths.delete(relativePath);
        this.budget.pendingPaths--;
        this.budget.pathUnits -= relativePath.length;
        continue;
      }
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
