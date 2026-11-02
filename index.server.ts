import type { RpcOutput } from "@getpaseo/plugin";
import type { PluginHandlerContext, PluginServerContext } from "@getpaseo/plugin/server";
import { openEditor, readWorkspaceFile, resolveWorkspaceFile, runSearch } from "./server/helpers";
import { editorOpen, fileRead, searchRun } from "./shared/contracts";

async function workspaceDirectory(paseo: PluginHandlerContext["paseo"], workspaceId: string): Promise<string> {
  const workspace = await paseo.workspaces.ref(workspaceId).refresh();
  if (!workspace?.workspaceDirectory) throw new Error(`Workspace ${workspaceId} is not active or has no available directory.`);
  return workspace.workspaceDirectory;
}

export default function contribute(server: PluginServerContext) {
  const searches = new Map<string, AbortController>();
  server.handle(searchRun, async (input, { paseo }) => {
    searches.get(input.searchId)?.abort();
    const controller = new AbortController();
    searches.set(input.searchId, controller);
    const result: RpcOutput<typeof searchRun> = { files: [], totalMatches: 0, totalFiles: 0, truncated: false };
    try {
      if (!input.query) return result;
      const directory = await workspaceDirectory(paseo, input.workspaceId);
      if (controller.signal.aborted) return result;
      const files = new Map<string, (typeof result.files)[number]>();
      let error: string | undefined;
      await runSearch(directory, input, controller.signal, async (event) => {
        if (controller.signal.aborted) return;
        if (event.type === "error") {
          error = event.message;
        } else if (event.type === "done") {
          result.totalMatches = event.totalMatches;
          result.totalFiles = event.totalFiles;
          result.truncated = event.truncated;
        } else {
          let file = files.get(event.path);
          if (!file) {
            file = { path: event.path, matches: [] };
            files.set(event.path, file);
            result.files.push(file);
          }
          file.matches.push(...event.matches);
        }
      });
      if (controller.signal.aborted) return { files: [], totalMatches: 0, totalFiles: 0, truncated: false };
      if (error) throw new Error(error);
      return result;
    } catch (error) {
      if (controller.signal.aborted) return { files: [], totalMatches: 0, totalFiles: 0, truncated: false };
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
  return () => {
    for (const controller of searches.values()) controller.abort();
    searches.clear();
  };
}
