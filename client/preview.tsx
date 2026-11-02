import { isSyntaxThemeId, resolveSyntaxColors, type HighlightToken } from "@getpaseo/highlight";
import { type PluginWorkspacePanelProps, useRpc, useSettings, useTabState } from "@getpaseo/plugin/client";
import { copyText, Icon, useToast } from "@getpaseo/plugin/client/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { ActivityIndicator, FlatList, type GestureResponderEvent, Pressable, ScrollView, Text, TextInput, type TextStyle, View } from "react-native";
import { z } from "zod";
import { fileRead, fileWrite, formatSnippet, snippetAdd } from "../shared/contracts";
import { findDefaults, findSettings } from "../shared/settings";
import { OpenInEditorButton, useEditorTargets } from "./editors";
import { expandedOffset, highlightPreview, previewSpans, surfaceColorScheme } from "./highlight";
import { withAlpha } from "./palette";
import { readPaseoSyntaxTheme, subscribePaseoSyntaxTheme, type TextPick, watchTextSelection } from "./web";

const previewTargetSchema = z.object({
  relativePath: z.string().min(1).max(32768),
  line: z.number().int().min(1).max(2147483647),
  column: z.number().int().min(1).max(2147483647),
  endColumn: z.number().int().min(1).max(2147483647).optional(),
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

export function PreviewPanel({ workspaceId, theme, layout, host, tab, revision, store }: PluginWorkspacePanelProps & { store: PreviewStore }) {
  const [state, setState] = useTabState(tab, previewStateSchema, defaultPreviewState);
  const readSelection = useCallback(() => store.read(workspaceId), [store, workspaceId]);
  const selection = useSyncExternalStore(store.subscribe, readSelection, readSelection);
  const target = selection?.target ?? state.target;
  useEffect(() => {
    if (!selection) return;
    const next = selection.target;
    if (state.target?.relativePath !== next.relativePath || state.target.line !== next.line || state.target.column !== next.column || state.target.endColumn !== next.endColumn) {
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
  const editors = useEditorTargets(workspaceId, host.id);
  const [editorError, setEditorError] = useState<string | null>(null);
  useEffect(() => setEditorError(null), [path]);
  const [editing, setEditing] = useState<Editing | null>(null);
  const writeFile = useRpc(fileWrite);
  const addSnippet = useRpc(snippetAdd);
  const settings = useSettings(findSettings);
  const mode = settings.status === "ready" ? settings.values.addToContext : findDefaults.addToContext;
  const queryClient = useQueryClient();
  const toast = useToast();
  const colors = theme.colors;
  const padding = layout.compact ? 12 : 8;
  const targetSize = layout.compact ? 44 : 30;
  const text = file.data?.kind === "text" ? file.data : null;
  const addToContext = useCallback(async (value: Snippet) => {
    if (!path) return;
    const done: string[] = [];
    try {
      if (mode !== "copy") {
        await addSnippet({ workspaceId, relativePath: path, ...value });
        done.push("added to the composer's Find in Files selection picker");
      }
      if (mode !== "attachment") {
        await copyText(formatSnippet(path, value.startLine, value.endLine, value.text));
        done.push("copied");
      }
      toast.show(`Selection ${done.join(" and ")}.`, { variant: "success" });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  }, [addSnippet, mode, path, toast, workspaceId]);
  const startEditing = () => {
    if (!text || !path) return;
    const base = text.content.replace(/\r\n?/g, "\n");
    setEditing({ path, base, draft: base, crlf: text.content.includes("\r\n"), version: text.version, saving: false, conflict: false, error: null });
  };
  const finishEditing = (editedPath: string) => {
    setEditing(null);
    void queryClient.invalidateQueries({ queryKey: ["find-in-files", "preview", workspaceId, editedPath] });
  };
  const save = async (force = false) => {
    if (!editing) return;
    setEditing({ ...editing, saving: true, error: null });
    try {
      const content = editing.crlf ? editing.draft.replace(/\r?\n/g, "\r\n") : editing.draft;
      const result = await writeFile({ workspaceId, relativePath: editing.path, content, baseVersion: editing.version, force });
      if (result.kind === "conflict") {
        setEditing((previous) => previous && { ...previous, saving: false, conflict: true });
        return;
      }
      finishEditing(editing.path);
      toast.show("Saved", { variant: "success" });
    } catch (error) {
      setEditing((previous) => previous && { ...previous, saving: false, error: error instanceof Error ? error.message : String(error) });
    }
  };
  const dirty = editing !== null && editing.draft !== editing.base;
  const shownPath = editing?.path ?? target?.relativePath;

  return (
    <View style={{ flex: 1, minHeight: 0, backgroundColor: colors.surface0 }}>
      <View style={{ padding, gap: 6, borderBottomWidth: 1, borderColor: colors.border, zIndex: 10 }}>
        <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", columnGap: 12, rowGap: 6 }}>
          <View style={{ flexDirection: "row", alignItems: "baseline", flexShrink: 1, flexGrow: 1, flexBasis: 200, minWidth: 0, gap: 10 }}>
            <Text selectable numberOfLines={2} style={{ flexShrink: 1, minWidth: 0, color: colors.foreground, fontSize: 13 }}>{shownPath ?? "Search preview"}</Text>
            {editing
              ? <Text style={{ flexShrink: 0, color: colors.foregroundMuted, fontSize: 12 }}>{dirty ? "Editing, unsaved" : "Editing"}</Text>
              : target && <Text style={{ flexShrink: 0, color: colors.foregroundMuted, fontSize: 12 }}>Line {target.line}, column {target.column}</Text>}
          </View>
          {editing ? (
            <View style={{ marginLeft: "auto", flexDirection: "row", gap: 6 }}>
              <ToolButton icon="Save" label={editing.saving ? "Saving…" : "Save"} disabled={editing.saving || !dirty} onPress={() => { void save(); }} theme={theme} layout={layout} />
              <ToolButton icon="X" label="Cancel" disabled={editing.saving} onPress={() => setEditing(null)} theme={theme} layout={layout} />
            </View>
          ) : target && (
            <View style={{ marginLeft: "auto", flexDirection: "row", gap: 6 }}>
              {text && <ToolButton icon="Pencil" label="Edit" onPress={startEditing} theme={theme} layout={layout} />}
              <OpenInEditorButton
                editors={editors}
                theme={theme}
                layout={layout}
                relativePath={target.relativePath}
                line={target.line}
                column={target.column}
                onError={(error) => setEditorError(error instanceof Error ? error.message : String(error))}
              />
            </View>
          )}
        </View>
        {editing?.conflict && (
          <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 6 }}>
            <Text style={{ color: colors.statusDanger, fontSize: 12, marginRight: "auto" }}>The file changed on disk after you started to edit it.</Text>
            <ToolButton icon="Save" label="Overwrite" disabled={editing.saving} onPress={() => { void save(true); }} theme={theme} layout={layout} />
            <ToolButton icon="RotateCcw" label="Discard and reload" disabled={editing.saving} onPress={() => finishEditing(editing.path)} theme={theme} layout={layout} />
          </View>
        )}
        {editing && target && editing.path !== target.relativePath && (
          <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>Save or cancel the edit to preview {target.relativePath}.</Text>
        )}
        {editing?.error && <Text selectable style={{ color: colors.statusDanger, fontSize: 12 }}>{editing.error}</Text>}
        {editorError && <Text selectable style={{ color: colors.statusDanger, fontSize: 12 }}>{editorError}</Text>}
      </View>
      {editing ? (
        <TextInput
          multiline
          autoFocus
          editable={!editing.saving}
          value={editing.draft}
          onChangeText={(draft) => setEditing((previous) => previous && { ...previous, draft })}
          autoCapitalize="none"
          autoCorrect={false}
          spellCheck={false}
          accessibilityLabel={`Edit ${editing.path}`}
          style={[{
            flex: 1,
            minHeight: 0,
            padding,
            color: colors.foreground,
            backgroundColor: colors.surface0,
            fontFamily: layout.platform === "ios" ? "Menlo" : "monospace",
            fontSize: 13,
            lineHeight: 20,
            textAlignVertical: "top",
          }, layout.platform === "web" ? preformattedStyle : undefined]}
        />
      ) : !target ? (
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
        <Text style={{ padding, color: colors.foregroundMuted, fontSize: 13 }}>This file is binary. Open it in an editor.</Text>
      ) : file.data.kind === "too-large" ? (
        <Text style={{ padding, color: colors.foregroundMuted, fontSize: 13 }}>This file exceeds the {Math.round(file.data.maxBytes / 1024)} KiB preview limit. Open it in an editor.</Text>
      ) : (
        <FileLines
          key={`${workspaceId}:${path}`}
          content={file.data.content}
          target={target}
          token={selection?.token ?? 0}
          revision={revision}
          theme={theme}
          layout={layout}
          onAddToContext={addToContext}
        />
      )}
    </View>
  );
}

type Editing = {
  path: string;
  /** The file text when editing started, with `\n` line ends. */
  base: string;
  draft: string;
  /** The file used `\r\n`. Save writes `\r\n` again, because text inputs return `\n`. */
  crlf: boolean;
  version: string;
  saving: boolean;
  conflict: boolean;
  error: string | null;
};

function ToolButton({ icon, label, accessibilityLabel, disabled, onPress, theme, layout }: {
  icon: string;
  label?: string;
  accessibilityLabel?: string;
  disabled?: boolean;
  onPress(): void;
  theme: PluginWorkspacePanelProps["theme"];
  layout: PluginWorkspacePanelProps["layout"];
}) {
  const colors = theme.colors;
  const size = layout.compact ? 44 : 28;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => ({
        minHeight: size,
        minWidth: size,
        paddingHorizontal: label ? 8 : 0,
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "center",
        gap: 6,
        borderRadius: 6,
        borderWidth: 1,
        borderColor: colors.border,
        backgroundColor: pressed ? colors.surface2 : colors.surface1,
        opacity: disabled ? 0.5 : 1,
      })}
    >
      <Icon name={icon} size={15} color={colors.foreground} />
      {label && <Text numberOfLines={1} style={{ color: colors.foreground, fontSize: 13 }}>{label}</Text>}
    </Pressable>
  );
}

const preformattedStyle: TextStyle & { whiteSpace: "pre" } = { whiteSpace: "pre" };

/** Token colors for Paseo's Appearance syntax theme on the given surface. */
export function useSyntaxColors(surface: string) {
  const paseoSyntaxTheme = useSyncExternalStore(subscribePaseoSyntaxTheme, readPaseoSyntaxTheme, readPaseoSyntaxTheme);
  // "one" is Paseo's own default syntax theme.
  const syntaxTheme = paseoSyntaxTheme && isSyntaxThemeId(paseoSyntaxTheme) ? paseoSyntaxTheme : "one";
  return useMemo(() => resolveSyntaxColors(syntaxTheme, surfaceColorScheme(surface)), [syntaxTheme, surface]);
}

export type Snippet = { startLine: number; endLine: number; text: string };

function FileLines({ content, target, token, revision, theme, layout, onAddToContext }: {
  content: string;
  target: PreviewTarget;
  token: number;
  revision: number;
  theme: PluginWorkspacePanelProps["theme"];
  layout: PluginWorkspacePanelProps["layout"];
  onAddToContext(snippet: Snippet): Promise<void>;
}) {
  const list = useRef<FlatList< string>>(null);
  const container = useRef<View>(null);
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const fontSize = 13;
  const rowHeight = layout.compact ? 26 : 22;
  const fontFamily = layout.platform === "ios" ? "Menlo" : "monospace";
  const file = useMemo(() => {
    const lines = content.split(/\r\n|\n|\r/);
    let longest = 0;
    for (const line of lines) longest = Math.max(longest, expandedOffset(line, line.length));
    const gutter = Math.max(42, String(lines.length).length * 9 + 16);
    return { lines, gutter, width: gutter + 24 + longest * fontSize };
  }, [content]);
  const selectedIndex = Math.min(file.lines.length - 1, Math.max(0, target.line - 1));
  const jump = useCallback(() => {
    list.current?.scrollToIndex({ index: selectedIndex, animated: false, viewPosition: 0.35 });
  }, [selectedIndex]);
  useEffect(() => {
    if (viewport.height > 0) jump();
  }, [jump, viewport.height, rowHeight, revision, token]);
  const syntaxColors = useSyntaxColors(theme.colors.surface0);
  const [highlighted, setHighlighted] = useState<{ content: string; lines: HighlightToken[][] } | null>(null);
  useEffect(() => {
    const lifetime = new AbortController();
    setHighlighted(null);
    void highlightPreview(content, target.relativePath, lifetime.signal).then((lines) => {
      if (lines && !lifetime.signal.aborted) setHighlighted({ content, lines });
    });
    return () => lifetime.abort();
  }, [content, target.relativePath]);
  const tokenLines = highlighted?.content === content ? highlighted.lines : null;
  const colors = theme.colors;

  // Two ways to pick context: line numbers in the gutter, or a text selection (desktop and web).
  const [lines, setLines] = useState<{ anchor: number; focus: number } | null>(null);
  const range = lines && { start: Math.min(lines.anchor, lines.focus), end: Math.max(lines.anchor, lines.focus) };
  const pressLine = (line: number, extend: boolean) => setLines((previous) => extend && previous
    ? { anchor: previous.anchor, focus: line }
    : previous?.anchor === line && previous.focus === line ? null : { anchor: line, focus: line });
  const scrollY = useRef(0);
  const [, setScrollTick] = useState(0);
  const [textPick, setTextPick] = useState<TextPick | null>(null);
  const pressingMenu = useRef(false);
  useEffect(() => watchTextSelection(container.current, (pick) => {
    // A press on the menu can clear the page selection before the press ends. Keep the pick until then.
    if (pressingMenu.current) return;
    setTextPick(pick && { ...pick, top: pick.top + scrollY.current });
  }), []);
  // The page shows lines with tabs expanded. Map a displayed offset back to the source line.
  const sourceOffset = (line: string, displayed: number) => {
    let offset = 0;
    while (offset < line.length && expandedOffset(line, offset + 1) <= displayed) offset++;
    return offset;
  };
  const pick: (Snippet & { top: number }) | null = textPick
    ? {
      startLine: textPick.start.line,
      endLine: textPick.end.line,
      text: file.lines.slice(textPick.start.line - 1, textPick.end.line).map((line, index, selected) => line.slice(
        index === 0 ? sourceOffset(line, textPick.start.offset) : 0,
        index === selected.length - 1 ? sourceOffset(line, textPick.end.offset) : line.length,
      )).join("\n"),
      top: textPick.top,
    }
    : range && {
      startLine: range.start,
      endLine: range.end,
      text: file.lines.slice(range.start - 1, range.end).join("\n"),
      top: range.end * rowHeight,
    };
  const [adding, setAdding] = useState(false);
  const menuHeight = layout.compact ? 44 : 30;
  const menuTop = pick && Math.max(4, Math.min(viewport.height - menuHeight - 4, pick.top - scrollY.current + 4));
  const pickLabel = textPick ? "Add selection to context" : range && (range.start === range.end ? `Add line ${range.start} to context` : `Add lines ${range.start}-${range.end} to context`);

  return (
    <View
      ref={container}
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
          extraData={[highlighted, range?.start, range?.end]}
          keyExtractor={(_, index) => String(index)}
          initialScrollIndex={selectedIndex}
          getItemLayout={(_, index) => ({ length: rowHeight, offset: rowHeight * index, index })}
          initialNumToRender={40}
          maxToRenderPerBatch={40}
          windowSize={7}
          nestedScrollEnabled
          onLayout={jump}
          scrollEventThrottle={16}
          onScroll={(event) => {
            scrollY.current = event.nativeEvent.contentOffset.y;
            if (pick) setScrollTick((tick) => tick + 1);
          }}
          renderItem={({ item, index }) => {
            const inRange = range !== null && index + 1 >= range.start && index + 1 <= range.end;
            return (
              <View
                {...({ dataSet: { line: index + 1 } } as object)}
                style={{
                  height: rowHeight,
                  flexDirection: "row",
                  alignItems: "center",
                  backgroundColor: inRange ? withAlpha(colors.accent, "45") : index === selectedIndex ? withAlpha(colors.accent, "30") : colors.surface0,
                }}
              >
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Select line ${index + 1}`}
                  accessibilityHint="Shift-click or long-press another line number to select a range."
                  onPress={({ nativeEvent }: GestureResponderEvent) => pressLine(index + 1, "shiftKey" in nativeEvent && nativeEvent.shiftKey === true)}
                  onLongPress={() => pressLine(index + 1, true)}
                  style={{ width: file.gutter, height: rowHeight, justifyContent: "center" }}
                >
                  <Text selectable={false} style={{ paddingRight: 10, textAlign: "right", color: inRange ? colors.foreground : colors.foregroundMuted, fontSize: 12, fontFamily, lineHeight: 20 }}>
                    {index + 1}
                  </Text>
                </Pressable>
                <Text
                  {...({ dataSet: { code: "" } } as object)}
                  selectable
                  numberOfLines={1}
                  style={[{ flex: 1, color: colors.foreground, fontSize, fontFamily, lineHeight: 20 }, layout.platform === "web" ? preformattedStyle : undefined]}
                >
                  {previewSpans(item, tokenLines?.[index], index === selectedIndex ? {
                    start: target.column - 1,
                    end: (target.endColumn ?? target.column + 1) - 1,
                  } : undefined).map((span, spanIndex) => (
                    <Text
                      key={spanIndex}
                      // React Native Web does not pass the font of a parent Text to a nested Text.
                      style={[{ fontFamily, fontSize }, span.matched
                        ? { color: colors.foreground, backgroundColor: withAlpha(colors.accent, "60") }
                        : { color: span.style ? syntaxColors[span.style] : colors.foreground }]}
                    >
                      {span.text}
                    </Text>
                  ))}
                </Text>
              </View>
            );
          }}
        />
      </ScrollView>
      {pick && menuTop !== null && (
        <View
          style={{
            position: "absolute",
            top: menuTop,
            left: file.gutter + 8,
            flexDirection: "row",
            gap: 4,
            padding: 3,
            borderRadius: 8,
            borderWidth: 1,
            borderColor: colors.border,
            backgroundColor: colors.surface1,
            shadowColor: "#000",
            shadowOpacity: 0.25,
            shadowRadius: 8,
            shadowOffset: { width: 0, height: 2 },
            elevation: 4,
          }}
        >
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={pickLabel ?? "Add to context"}
            disabled={adding}
            onPressIn={() => { pressingMenu.current = true; }}
            onPress={() => {
              setAdding(true);
              void onAddToContext({ startLine: pick.startLine, endLine: pick.endLine, text: pick.text }).finally(() => {
                setAdding(false);
                setLines(null);
                setTextPick(null);
                pressingMenu.current = false;
              });
            }}
            onPressOut={() => { if (!adding) setTimeout(() => { pressingMenu.current = false; }, 0); }}
            style={({ pressed }) => ({
              minHeight: menuHeight - 6,
              paddingHorizontal: 8,
              flexDirection: "row",
              alignItems: "center",
              gap: 6,
              borderRadius: 5,
              backgroundColor: pressed ? colors.surface2 : "transparent",
              opacity: adding ? 0.5 : 1,
            })}
          >
            <Icon name="MessageSquarePlus" size={15} color={colors.foreground} />
            <Text numberOfLines={1} style={{ color: colors.foreground, fontSize: 13 }}>{pickLabel}</Text>
          </Pressable>
          {!textPick && (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Clear line selection"
              onPress={() => setLines(null)}
              style={({ pressed }) => ({ minWidth: menuHeight - 6, minHeight: menuHeight - 6, alignItems: "center", justifyContent: "center", borderRadius: 5, backgroundColor: pressed ? colors.surface2 : "transparent" })}
            >
              <Icon name="X" size={14} color={colors.foregroundMuted} />
            </Pressable>
          )}
        </View>
      )}
    </View>
  );
}
