import type { RpcOutput } from "@getpaseo/plugin";
import type { PluginHandlerContext, PluginServerContext } from "@getpaseo/plugin/server";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { readWorkspaceFile, resolveWorkspaceFile, writeWorkspaceFile } from "./server/helpers";
import { IndexManager } from "./server/indexer";
import { planQuery } from "./server/planner";
import { verifyFiles } from "./server/verify";
import { fileRead, fileWrite, formatSnippet, indexRebuild, indexRelease, indexStatus, searchRun, snippetAdd, snippetSearch, workspaceLocate } from "./shared/contracts";
import { findSettings } from "./shared/settings";

async function workspaceDirectory(paseo: PluginHandlerContext["paseo"], workspaceId: string): Promise<string> {
  const workspace = await paseo.workspaces.ref(workspaceId).refresh();
  if (!workspace?.workspaceDirectory) throw new Error(`Workspace ${workspaceId} is not active or has no available directory.`);
  return workspace.workspaceDirectory;
}

function emptySearch(): RpcOutput<typeof searchRun> {
  return { files: [], totalMatches: 0, totalFiles: 0, truncated: false, index: { state: "idle", files: 0, partial: false } };
}

export default function contribute(server: PluginServerContext) {
  server.registerSettings(findSettings);
  const searches = new Map<string, AbortController>();
  const indexes = new IndexManager();
  server.handle(indexStatus, async ({ workspaceId, leaseId }, { paseo }) => {
    const directory = await workspaceDirectory(paseo, workspaceId);
    return (await indexes.get(directory, { leaseId })).status();
  });
  server.handle(indexRelease, ({ leaseId }) => {
    indexes.release(leaseId);
    return { released: true as const };
  });
  server.handle(indexRebuild, async ({ workspaceId }, { paseo }) => {
    const index = await indexes.get(await workspaceDirectory(paseo, workspaceId));
    index.rebuild();
    return index.status();
  });
  server.handle(searchRun, async (input, { paseo }) => {
    searches.get(input.searchId)?.abort();
    const controller = new AbortController();
    searches.set(input.searchId, controller);
    try {
      if (!input.query) return emptySearch();
      const directory = await workspaceDirectory(paseo, input.workspaceId);
      if (controller.signal.aborted) return emptySearch();
      const index = await indexes.get(directory);
      if (controller.signal.aborted) return emptySearch();
      const status = index.status();
      const candidates = await index.candidates(planQuery(input.query, input.regex, input.caseSensitive), controller.signal);
      if (controller.signal.aborted) return emptySearch();
      const result = await verifyFiles(directory, candidates, input, controller.signal);
      if (controller.signal.aborted) return emptySearch();
      return { ...result, index: { state: status.state, files: status.filesIndexed, partial: status.partial || index.status().partial } };
    } catch (error) {
      if (controller.signal.aborted) return emptySearch();
      throw error;
    } finally {
      if (searches.get(input.searchId) === controller) searches.delete(input.searchId);
    }
  });
  server.handle(fileRead, async ({ workspaceId, relativePath }, { paseo }) => {
    return readWorkspaceFile(await workspaceDirectory(paseo, workspaceId), relativePath);
  });
  server.handle(fileWrite, async ({ workspaceId, relativePath, content, baseVersion, force }, { paseo }) => {
    return writeWorkspaceFile(await workspaceDirectory(paseo, workspaceId), relativePath, content, baseVersion, force);
  });
  // ponytail: selections live in daemon memory and are lost on restart. Persist them if users need that.
  const snippets: RpcOutput<typeof snippetSearch>["items"] = [];
  server.handle(snippetAdd, async ({ workspaceId, relativePath, startLine, endLine, text }, { paseo }) => {
    const file = await resolveWorkspaceFile(await workspaceDirectory(paseo, workspaceId), relativePath);
    const lines = startLine === endLine ? `${startLine}` : `${startLine}-${endLine}`;
    const id = randomUUID();
    snippets.unshift({
      id,
      identifier: `${file.relativePath}:${lines}`,
      title: text.split("\n").map((line) => line.trim()).find(Boolean)?.slice(0, 80) ?? path.basename(file.relativePath),
      url: `${pathToFileURL(file.absolutePath).href}#L${startLine}-L${endLine}`,
      text: formatSnippet(file.relativePath, startLine, endLine, text),
      resourceType: "code-selection",
    });
    snippets.splice(50);
    return { id };
  });
  server.handle(snippetSearch, ({ query }) => {
    const needle = query.trim().toLowerCase();
    return { items: snippets.filter((item) => !needle || item.identifier.toLowerCase().includes(needle) || item.text.toLowerCase().includes(needle)) };
  });
  server.handle(workspaceLocate, async ({ workspaceId }, { paseo }) => {
    const workspace = await paseo.workspaces.ref(workspaceId).refresh();
    if (!workspace?.workspaceDirectory) throw new Error(`Workspace ${workspaceId} is not active or has no available directory.`);
    return { workspacePath: workspace.workspaceDirectory, projectId: workspace.projectId ?? null };
  });
  return async () => {
    for (const controller of searches.values()) controller.abort();
    searches.clear();
    await indexes.dispose();
  };
}
