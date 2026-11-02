import type { RpcOutput } from "@getpaseo/plugin";
import type { PluginHandlerContext, PluginServerContext } from "@getpaseo/plugin/server";
import { openEditor, readWorkspaceFile, resolveWorkspaceFile } from "./server/helpers";
import { IndexManager } from "./server/indexer";
import { planQuery } from "./server/planner";
import { verifyFiles } from "./server/verify";
import { editorOpen, fileRead, indexRebuild, indexStatus, searchRun } from "./shared/contracts";

async function workspaceDirectory(paseo: PluginHandlerContext["paseo"], workspaceId: string): Promise<string> {
  const workspace = await paseo.workspaces.ref(workspaceId).refresh();
  if (!workspace?.workspaceDirectory) throw new Error(`Workspace ${workspaceId} is not active or has no available directory.`);
  return workspace.workspaceDirectory;
}

function emptySearch(): RpcOutput<typeof searchRun> {
  return { files: [], totalMatches: 0, totalFiles: 0, truncated: false, index: { state: "idle", files: 0, partial: false } };
}

export default function contribute(server: PluginServerContext) {
  const searches = new Map<string, AbortController>();
  const indexes = new IndexManager();
  server.handle(indexStatus, async ({ workspaceId }, { paseo }) => {
    const directory = await workspaceDirectory(paseo, workspaceId);
    return (await indexes.get(directory)).status();
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
      return { ...result, index: { state: status.state, files: status.filesIndexed, partial: status.partial } };
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
  server.handle(editorOpen, async ({ workspaceId, relativePath, line, column }, { paseo }) => {
    const file = await resolveWorkspaceFile(await workspaceDirectory(paseo, workspaceId), relativePath);
    await openEditor(file.absolutePath, line, column);
    return { opened: true as const };
  });
  return async () => {
    for (const controller of searches.values()) controller.abort();
    searches.clear();
    await indexes.dispose();
  };
}
