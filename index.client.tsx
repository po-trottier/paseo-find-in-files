import type { PluginClientContext, PluginSurfaceProps, PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { createPreviewStore, PreviewPanel } from "./client/preview";
import type { PreviewTarget } from "./client/preview";
import { SearchPanel } from "./client/search";
import { FindSettings } from "./client/settings";
import { registerSearchShortcut } from "./client/web";
import { snippetSource } from "./shared/contracts";

export default function contribute(client: PluginClientContext) {
  const preview = createPreviewStore();
  const shortcut = registerSearchShortcut(client);
  function openPreview(workspaceId: string, target: PreviewTarget) {
    preview.select(workspaceId, target);
    client.openPanel("preview", { workspaceId });
  }
  function Search(props: PluginWorkspacePanelProps) {
    return <SearchPanel {...props} onPreview={openPreview} />;
  }
  function Preview(props: PluginWorkspacePanelProps) {
    return <PreviewPanel {...props} store={preview} />;
  }
  function Settings(props: PluginSurfaceProps) {
    return <FindSettings {...props} shortcut={shortcut} />;
  }
  const removeSettings = client.addSettingsScreen({
    id: "preferences",
    title: "Settings",
    icon: "Search",
    Component: Settings,
  });
  const removeSearch = client.addWorkspacePanel({
    id: "search",
    title: "Search",
    icon: "Search",
    locations: ["explorer"],
    Component: Search,
  });
  const removePreview = client.addWorkspacePanel({
    id: "preview",
    title: "Search preview",
    icon: "FileSearch",
    locations: ["workspace"],
    Component: Preview,
  });
  const removeSnippets = client.addAttachmentSource(snippetSource);
  const removeCommand = client.addCommandCenterItem({
    id: "find-in-files",
    title: "Find in files",
    icon: "Search",
    context: "workspace",
    keywords: ["search", "files", "text", "grep"],
    onSelect({ openPanel }) {
      openPanel("search", { location: "explorer" });
    },
  });
  return async () => {
    removeSnippets();
    removeCommand();
    removeSearch();
    removePreview();
    removeSettings();
    preview.clear();
    await shortcut.dispose();
  };
}
