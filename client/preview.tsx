import { type PluginWorkspacePanelProps, useRpc, useTabState } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/ui";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { ActivityIndicator, FlatList, Pressable, ScrollView, Text, View } from "react-native";
import { z } from "zod";
import { editorOpen, fileRead } from "../shared/contracts";
import { withAlpha } from "./palette";

const previewTargetSchema = z.object({
  relativePath: z.string().min(1).max(32768),
  line: z.number().int().min(1).max(2147483647),
  column: z.number().int().min(1).max(2147483647),
});
export type PreviewTarget = z.infer< typeof previewTargetSchema>;
const previewStateSchema = z.object({ target: previewTargetSchema.nullable() });
const defaultPreviewState: z.infer< typeof previewStateSchema> = { target: null };
type PreviewSelection = { target: PreviewTarget; token: number };
export interface PreviewStore {
  read(workspaceId: string): PreviewSelection | null;
  subscribe(listener: () => void): () => void;
  select(workspaceId: string, target: PreviewTarget): void;
  clear(): void;
}

export function createPreviewStore(): PreviewStore {
  const targets = new Map<string, PreviewSelection>();
  const listeners = new Set<() => void>();
  let token = 0;
  return {
    read: (workspaceId) => targets.get(workspaceId) ?? null,
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    select(workspaceId, target) {
      targets.set(workspaceId, { target, token: ++token });
      for (const listener of listeners) listener();
    },
    clear() {
      targets.clear();
      listeners.clear();
    },
  };
}

export function PreviewPanel({ workspaceId, theme, layout, tab, revision, store }: PluginWorkspacePanelProps & { store: PreviewStore }) {
  const [state, setState] = useTabState(tab, previewStateSchema, defaultPreviewState);
  const readSelection = useCallback(() => store.read(workspaceId), [store, workspaceId]);
  const selection = useSyncExternalStore(store.subscribe, readSelection, readSelection);
  const target = selection?.target ?? state.target;
  useEffect(() => {
    if (!selection) return;
    const next = selection.target;
    if (state.target?.relativePath !== next.relativePath || state.target.line !== next.line || state.target.column !== next.column) {
      setState({ target: next });
    }
  }, [selection, state.target, setState]);
  const readFile = useRpc(fileRead);
  const path = target?.relativePath;
  const file = useQuery({
    queryKey: ["find-in-files", "preview", workspaceId, path],
    queryFn: () => {
      if (!path) throw new Error("Select a search result to preview the file.");
      return readFile({ workspaceId, relativePath: path });
    },
    enabled: Boolean(path),
    retry: false,
    gcTime: 0,
  });
  const openEditor = useRpc(editorOpen);
  const editor = useMutation({ mutationFn: openEditor });
  useEffect(() => editor.reset(), [path]);
  const colors = theme.colors;
  const padding = layout.compact ? 12 : 8;
  const targetSize = layout.compact ? 44 : 30;

  return (
    <View style={{ flex: 1, minHeight: 0, backgroundColor: colors.surface0 }}>
      <View style={{ padding, gap: 6, borderBottomWidth: 1, borderColor: colors.border }}>
        <Text selectable numberOfLines={2} style={{ color: colors.foreground, fontSize: 13 }}>{target?.relativePath ?? "Search preview"}</Text>
        {target && (
          <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
            <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>Line {target.line}, column {target.column}</Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Open in VS Code"
              accessibilityState={{ disabled: editor.isPending }}
              disabled={editor.isPending}
              onPress={() => editor.mutate({ workspaceId, ...target })}
              style={({ pressed }) => ({
                minHeight: targetSize,
                paddingHorizontal: 8,
                flexDirection: "row",
                alignItems: "center",
                gap: 6,
                borderRadius: 4,
                borderWidth: 1,
                borderColor: colors.border,
                opacity: editor.isPending ? 0.5 : 1,
                backgroundColor: pressed ? colors.surface2 : colors.surface1,
              })}
            >
              <Icon name="ExternalLink" size={15} color={colors.foreground} />
              <Text style={{ color: colors.foreground, fontSize: 12 }}>Open in VS Code</Text>
            </Pressable>
          </View>
        )}
        {editor.isError && <Text selectable style={{ color: colors.statusDanger, fontSize: 12 }}>{editor.error.message}</Text>}
      </View>
      {!target ? (
        <Text style={{ padding, color: colors.foregroundMuted, fontSize: 13 }}>Select a search result to preview the file.</Text>
      ) : file.isPending ? (
        <View style={{ padding, gap: 8, flexDirection: "row", alignItems: "center" }}>
          <ActivityIndicator color={colors.accent} size="small" />
          <Text style={{ color: colors.foregroundMuted, fontSize: 13 }}>Loading file…</Text>
        </View>
      ) : file.isError ? (
        <View style={{ padding, gap: 8 }}>
          <Text selectable style={{ color: colors.statusDanger, fontSize: 13 }}>{file.error.message}</Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Retry file preview"
            onPress={() => { void file.refetch(); }}
            style={{ alignSelf: "flex-start", minHeight: targetSize, paddingHorizontal: 8, justifyContent: "center", backgroundColor: colors.surface1, borderRadius: 4 }}
          >
            <Text style={{ color: colors.foreground, fontSize: 13 }}>Retry</Text>
          </Pressable>
        </View>
      ) : file.data.kind === "binary" ? (
        <Text style={{ padding, color: colors.foregroundMuted, fontSize: 13 }}>This file is binary. Open it in VS Code.</Text>
      ) : file.data.kind === "too-large" ? (
        <Text style={{ padding, color: colors.foregroundMuted, fontSize: 13 }}>This file exceeds the {Math.round(file.data.maxBytes / 1024)} KiB preview limit. Open it in VS Code.</Text>
      ) : (
        <FileLines
          key={`${workspaceId}:${path}`}
          content={file.data.content}
          selectedLine={target.line}
          token={selection?.token ?? 0}
          revision={revision}
          theme={theme}
          layout={layout}
        />
      )}
    </View>
  );
}

function FileLines({ content, selectedLine, token, revision, theme, layout }: {
  content: string;
  selectedLine: number;
  token: number;
  revision: number;
  theme: PluginWorkspacePanelProps["theme"];
  layout: PluginWorkspacePanelProps["layout"];
}) {
  const list = useRef<FlatList< string>>(null);
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const fontSize = 13;
  const rowHeight = layout.compact ? 26 : 22;
  const fontFamily = layout.platform === "ios" ? "Menlo" : "monospace";
  const file = useMemo(() => {
    const lines = content.split(/\r\n|\n|\r/);
    let longest = 0;
    for (const line of lines) {
      let columns = line.length;
      for (let index = 0; index < line.length; index += 1) {
        if (line.charCodeAt(index) === 9) columns += 7;
      }
      longest = Math.max(longest, columns);
    }
    const gutter = Math.max(42, String(lines.length).length * 9 + 16);
    return { lines, gutter, width: gutter + 24 + longest * fontSize };
  }, [content]);
  const selectedIndex = Math.min(file.lines.length - 1, Math.max(0, selectedLine - 1));
  const jump = useCallback(() => {
    list.current?.scrollToIndex({ index: selectedIndex, animated: false, viewPosition: 0.35 });
  }, [selectedIndex]);
  useEffect(() => {
    if (viewport.height > 0) jump();
  }, [jump, viewport.height, rowHeight, revision, token]);
  const colors = theme.colors;

  return (
    <View
      style={{ flex: 1, minHeight: 0, backgroundColor: colors.surface0 }}
      onLayout={(event) => {
        const { width, height } = event.nativeEvent.layout;
        setViewport((previous) => previous.width === width && previous.height === height ? previous : { width, height });
      }}
    >
      <ScrollView horizontal nestedScrollEnabled style={{ flex: 1 }} contentContainerStyle={{ height: "100%" }}>
        <FlatList
          ref={list}
          accessibilityLabel="Read-only file preview"
          style={{ width: Math.max(viewport.width, file.width), height: viewport.height, backgroundColor: colors.surface0 }}
          data={file.lines}
          extraData={selectedIndex}
          keyExtractor={(_, index) => String(index)}
          initialScrollIndex={selectedIndex}
          getItemLayout={(_, index) => ({ length: rowHeight, offset: rowHeight * index, index })}
          initialNumToRender={40}
          maxToRenderPerBatch={40}
          windowSize={7}
          nestedScrollEnabled
          onLayout={jump}
          renderItem={({ item, index }) => (
            <View style={{ height: rowHeight, flexDirection: "row", alignItems: "center", backgroundColor: index === selectedIndex ? withAlpha(colors.accent, "30") : colors.surface0 }}>
              <Text
                accessibilityLabel={`Line ${index + 1}`}
                style={{ width: file.gutter, paddingRight: 10, textAlign: "right", color: colors.foregroundMuted, fontSize: 12, fontFamily, lineHeight: 20 }}
              >
                {index + 1}
              </Text>
              <Text selectable numberOfLines={1} style={{ flex: 1, color: colors.foreground, fontSize, fontFamily, lineHeight: 20 }}>{item || " "}</Text>
            </View>
          )}
        />
      </ScrollView>
    </View>
  );
}
