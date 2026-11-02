import { type PluginWorkspacePanelProps, useRpc } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useState, useSyncExternalStore } from "react";
import { Image, Platform, Pressable, Text, View } from "react-native";
import { workspaceLocate } from "../shared/contracts";

export type EditorTarget = { id: string; label: string; kind: string; icon?: { kind: "image"; dataUrl: string } };
type OpenTargetInput = { editorId: string; workspacePath: string; filePath?: string; line?: number; column?: number };
type EditorBridge = {
  listTargets(input: { workspacePath?: string }): Promise<EditorTarget[]>;
  openTarget(input: OpenTargetInput): Promise<void>;
};
declare const window: {
  paseoDesktop?: { editor?: Partial<EditorBridge> };
  localStorage?: { getItem(key: string): string | null; setItem(key: string, value: string): void };
};

// ponytail: Paseo's desktop editor bridge and its preferred-editor keys are internal. Replace them when the plugin API exposes editor targets.
function editorBridge(): EditorBridge | null {
  if (Platform.OS !== "web" || typeof window === "undefined") return null;
  const editor = window.paseoDesktop?.editor;
  return editor?.listTargets && editor.openTarget ? editor as EditorBridge : null;
}

const PLUGIN_KEY = "find-in-files:preferred-editor";
const PASEO_KEY = "@paseo:preferred-editor";

function storedEditor(key: string): string | null {
  try {
    return window.localStorage?.getItem(key)?.trim() || null;
  } catch {
    return null;
  }
}

// One choice for every panel: the preview menu and the result rows read the same value.
let chosenEditor: string | null | undefined;
const chosenListeners = new Set<() => void>();
function readChosen(): string | null {
  if (chosenEditor === undefined) chosenEditor = editorBridge() ? storedEditor(PLUGIN_KEY) : null;
  return chosenEditor;
}
function subscribeChosen(listener: () => void): () => void {
  chosenListeners.add(listener);
  return () => chosenListeners.delete(listener);
}
function chooseEditor(editorId: string): void {
  chosenEditor = editorId;
  try {
    window.localStorage?.setItem(PLUGIN_KEY, editorId);
  } catch {}
  for (const listener of chosenListeners) listener();
}

export function useEditorTargets(workspaceId: string, serverId: string): EditorTargets {
  const bridge = editorBridge();
  const locate = useRpc(workspaceLocate);
  const chosen = useSyncExternalStore(subscribeChosen, readChosen, readChosen);
  const query = useQuery({
    queryKey: ["find-in-files", "editors", serverId, workspaceId],
    enabled: bridge !== null,
    staleTime: 60_000,
    retry: false,
    queryFn: async () => {
      const workspace = await locate({ workspaceId });
      return { ...workspace, targets: await bridge!.listTargets({ workspacePath: workspace.workspacePath }) };
    },
  });
  const data = query.data;
  const targets = data?.targets ?? [];
  const preferredId = [
    chosen,
    data?.projectId ? storedEditor(`${PASEO_KEY}:${JSON.stringify([serverId, data.projectId])}`) : null,
    storedEditor(PASEO_KEY),
  ].find((id) => id && targets.some((target) => target.id === id)) ?? targets[0]?.id;
  const preferred = targets.find((target) => target.id === preferredId) ?? null;

  const open = useCallback(async (editorId: string, relativePath: string, line: number, column: number) => {
    if (!bridge || !data) throw new Error("Paseo desktop editors are unavailable.");
    const separator = data.workspacePath.includes("\\") ? "\\" : "/";
    const filePath = `${data.workspacePath.replace(/[\\/]+$/, "")}${separator}${relativePath.split("/").join(separator)}`;
    await bridge.openTarget({ editorId, workspacePath: data.workspacePath, filePath, line, column });
  }, [bridge, data]);
  return { targets, preferred, open, choose: chooseEditor };
}

export interface EditorTargets {
  targets: EditorTarget[];
  preferred: EditorTarget | null;
  open(editorId: string, relativePath: string, line: number, column: number): Promise<void>;
  choose(editorId: string): void;
}

export function TargetIcon({ target, color, size = 16 }: { target: EditorTarget | null; color: string; size?: number }) {
  if (target?.icon?.dataUrl) return <Image source={{ uri: target.icon.dataUrl }} style={{ width: size, height: size }} />;
  return <Icon name={target?.kind === "file-manager" ? "Folder" : "ExternalLink"} size={size - 1} color={color} />;
}

/** A split button like Paseo's header button: open in the preferred editor, or pick another one. */
export function OpenInEditorButton({ editors, theme, layout, relativePath, line, column, onError }: {
  editors: EditorTargets;
  theme: PluginWorkspacePanelProps["theme"];
  layout: PluginWorkspacePanelProps["layout"];
  relativePath: string;
  line: number;
  column: number;
  onError(error: unknown): void;
}) {
  const [menu, setMenu] = useState(false);
  const { targets, preferred } = editors;
  if (!preferred) return null;
  const colors = theme.colors;
  const size = layout.compact ? 44 : 28;
  const open = (editorId: string) => { editors.open(editorId, relativePath, line, column).catch(onError); };
  const segment = (pressed: boolean) => ({
    minHeight: size,
    minWidth: size,
    paddingHorizontal: 6,
    alignItems: "center" as const,
    justifyContent: "center" as const,
    backgroundColor: pressed ? colors.surface2 : colors.surface1,
  });
  return (
    <View style={{ zIndex: 10 }}>
      <View style={{ flexDirection: "row", borderRadius: 6, borderWidth: 1, borderColor: colors.border, overflow: "hidden" }}>
        <Pressable accessibilityRole="button" accessibilityLabel={`Open in ${preferred.label}`} onPress={() => open(preferred.id)} style={({ pressed }) => ({ ...segment(pressed), flexDirection: "row", gap: 6, paddingHorizontal: 8 })}>
          <TargetIcon target={preferred} color={colors.foreground} />
          <Text numberOfLines={1} style={{ color: colors.foreground, fontSize: 13 }}>{`Open in ${preferred.label}`}</Text>
        </Pressable>
        <View style={{ width: 1, backgroundColor: colors.border }} />
        <Pressable accessibilityRole="button" accessibilityLabel="Choose an editor" accessibilityState={{ expanded: menu }} onPress={() => setMenu(!menu)} style={({ pressed }) => segment(pressed)}>
          <Icon name="ChevronDown" size={14} color={colors.foregroundMuted} />
        </Pressable>
      </View>
      {menu && (
        <View
          accessibilityRole="menu"
          style={{ position: "absolute", top: size + 6, right: 0, minWidth: 180, paddingVertical: 4, borderRadius: 8, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface1 }}
        >
          {targets.map((target) => (
            <Pressable
              key={target.id}
              accessibilityRole="menuitem"
              accessibilityState={{ checked: target.id === preferred.id }}
              onPress={() => { setMenu(false); editors.choose(target.id); }}
              style={({ pressed, hovered }: { pressed: boolean; hovered?: boolean }) => ({
                minHeight: layout.compact ? 44 : 30,
                paddingHorizontal: 10,
                flexDirection: "row",
                alignItems: "center",
                gap: 10,
                backgroundColor: pressed || hovered ? colors.surface2 : "transparent",
              })}
            >
              <TargetIcon target={target} color={colors.foreground} />
              <Text style={{ flex: 1, color: colors.foreground, fontSize: 13 }}>{target.label}</Text>
              {target.id === preferred.id && <Icon name="Check" size={14} color={colors.foregroundMuted} />}
            </Pressable>
          ))}
        </View>
      )}
    </View>
  );
}
