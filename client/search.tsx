import type { RpcOutput } from "@getpaseo/plugin";
import {
  type PluginWorkspacePanelProps,
  useHosts,
  useRpc,
  useTabState,
} from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, FlatList, Pressable, Text, TextInput, View, type TextStyle } from "react-native";
import { z } from "zod";
import { editorOpen, indexRebuild, indexStatus, searchRun, type SearchMatch } from "../shared/contracts";
import { caseSensitiveIcon, regexIcon, wholeWordIcon } from "./icons";
import { expandTabs, expandedOffset } from "./highlight";
import { withAlpha } from "./palette";
import type { PreviewTarget } from "./preview";

const searchStateSchema = z.object({
  query: z.string().max(8192),
  caseSensitive: z.boolean(),
  wholeWord: z.boolean(),
  regex: z.boolean(),
  include: z.string().max(4096),
  exclude: z.string().max(4096),
  filtersOpen: z.boolean(),
});
const defaultSearchState: z.infer< typeof searchStateSchema> = {
  query: "",
  caseSensitive: false,
  wholeWord: false,
  regex: false,
  include: "",
  exclude: "",
  filtersOpen: false,
};
type SearchState = z.infer< typeof searchStateSchema>;
type SearchResults = RpcOutput< typeof searchRun>;
type SearchStatus =
  | { status: "idle" | "checking-index" | "paused" | "waiting" | "searching" }
  | { status: "done"; data: SearchResults }
  | { status: "error"; message: string };
type ResultRow =
  | { kind: "file"; key: string; path: string; count: number }
  | { kind: "match"; key: string; path: string; match: SearchMatch };
type SearchPanelProps = PluginWorkspacePanelProps & {
  onPreview(workspaceId: string, target: PreviewTarget): void;
};

export function SearchPanel({
  workspaceId,
  theme,
  layout,
  host,
  revision,
  tab,
  onPreview,
}: SearchPanelProps) {
  const [state, setState] = useTabState(tab, searchStateSchema, defaultSearchState);
  const stateRef = useRef(state);
  stateRef.current = state;
  const [searchId] = useState(() => `search-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`);
  const runSearch = useRpc(searchRun);
  const openEditor = useRpc(editorOpen);
  const editor = useMutation({ mutationFn: openEditor });
  const hostStatus = useHosts().find((item) => item.serverId === host.id)?.status;
  const disconnected = hostStatus !== undefined && hostStatus !== "online";
  const connection = useRef({ runSearch, disconnected });
  connection.current = { runSearch, disconnected };
  const readIndex = useRpc(indexStatus);
  const rebuildIndex = useRpc(indexRebuild);
  const queryClient = useQueryClient();
  const index = useQuery({
    queryKey: ["find-in-files", "index", workspaceId],
    queryFn: () => readIndex({ workspaceId }),
    enabled: !disconnected,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    refetchInterval: (query) => query.state.data?.state === "building" ? 1000 : false,
  });
  const initialIndex = useRef< { workspaceId: string; manual: boolean } | null>(null);
  if (index.data && initialIndex.current?.workspaceId !== workspaceId) {
    initialIndex.current = { workspaceId, manual: index.data.state === "manual" };
  }
  const initialIndexReady = initialIndex.current?.workspaceId === workspaceId;
  const initialManualIndex = initialIndexReady && initialIndex.current?.manual === true;
  const initialIndexError = !initialIndexReady && index.isError;
  const authorizedWorkspace = useRef< string | null>(null);
  const rebuildErrorIndexUpdate = useRef(0);
  const rebuild = useMutation({
    mutationFn: rebuildIndex,
    retry: false,
    onError: () => { rebuildErrorIndexUpdate.current = index.dataUpdatedAt; },
    onMutate: ({ workspaceId: rebuildWorkspaceId }) => queryClient.cancelQueries({
      queryKey: ["find-in-files", "index", rebuildWorkspaceId],
      exact: true,
    }),
    onSuccess: (data, { workspaceId: rebuildWorkspaceId }) => {
      const queryKey = ["find-in-files", "index", rebuildWorkspaceId];
      queryClient.setQueryData(queryKey, data);
      void queryClient.invalidateQueries({ queryKey, exact: true });
    },
  });
  useEffect(() => {
    if (rebuild.isError && index.dataUpdatedAt !== rebuildErrorIndexUpdate.current) rebuild.reset();
  }, [index.dataUpdatedAt, rebuild.isError, rebuild.reset]);
  const queryInput = useRef<TextInput>(null);
  const sequence = useRef(0);
  const timer = useRef<NodeJS.Timeout | number>(0);
  const pendingSearch = useRef< (() => void) | null>(null);
  const cancellations = useRef<Promise< void>>(Promise.resolve());
  const activeSearch = useRef(false);
  const [search, setSearch] = useState<SearchStatus>({ status: "idle" });
  const [retry, setRetry] = useState(0);
  const [collapsed, setCollapsed] = useState<Set< string>>(() => new Set());
  const [queryFocused, setQueryFocused] = useState(false);
  const [filterFocused, setFilterFocused] = useState< "include" | "exclude" | null>(null);
  const input = useMemo(() => ({
    workspaceId,
    searchId,
    query: state.query,
    caseSensitive: state.caseSensitive,
    wholeWord: state.wholeWord,
    regex: state.regex,
    include: state.include || undefined,
    exclude: state.exclude || undefined,
  }), [workspaceId, searchId, state.query, state.caseSensitive, state.wholeWord, state.regex, state.include, state.exclude]);

  const cancel = useCallback(() => {
    sequence.current += 1;
    clearTimeout(timer.current);
    timer.current = 0;
    pendingSearch.current = null;
    if (!activeSearch.current) return;
    activeSearch.current = false;
    const cancellation = connection.current.runSearch({
      workspaceId,
      searchId,
      query: "",
      caseSensitive: false,
      wholeWord: false,
      regex: false,
    }).then(() => undefined, () => undefined);
    cancellations.current = Promise.all([cancellations.current, cancellation]).then(() => undefined);
  }, [workspaceId, searchId]);

  useEffect(() => queryInput.current?.focus(), [revision]);
  useEffect(() => {
    const current = ++sequence.current;
    setCollapsed(new Set());
    if (!input.query) {
      setSearch({ status: "idle" });
      return cancel;
    }
    if (connection.current.disconnected) {
      setSearch({ status: "error", message: "Host is disconnected. Connect the host, then select Retry." });
      return cancel;
    }
    if (!initialIndexReady) {
      setSearch(initialIndexError
        ? { status: "error", message: "Index status is unavailable. Select Retry before search." }
        : { status: "checking-index" });
      return cancel;
    }
    const execute = () => {
      if (pendingSearch.current !== execute) return;
      authorizedWorkspace.current = workspaceId;
      clearTimeout(timer.current);
      timer.current = 0;
      pendingSearch.current = null;
      void cancellations.current.then(async () => {
        if (current !== sequence.current) return;
        if (connection.current.disconnected) {
          setSearch({ status: "error", message: "Host is disconnected. Connect the host, then select Retry." });
          return;
        }
        setSearch({ status: "searching" });
        activeSearch.current = true;
        try {
          const data = await connection.current.runSearch(input);
          if (current === sequence.current) setSearch({ status: "done", data });
        } catch (error) {
          if (current === sequence.current) {
            setSearch({
              status: "error",
              message: error instanceof Error ? error.message : "Search failed.",
            });
          }
        } finally {
          if (current === sequence.current) activeSearch.current = false;
        }
      });
    };
    pendingSearch.current = execute;
    if (initialManualIndex && authorizedWorkspace.current !== workspaceId) {
      setSearch({ status: "paused" });
    } else {
      setSearch({ status: "waiting" });
      timer.current = setTimeout(execute, 250);
    }
    return cancel;
  }, [input, cancel, retry, initialIndexReady, initialManualIndex, initialIndexError]);

  useEffect(() => {
    if (!disconnected || (!timer.current && !activeSearch.current)) return;
    cancel();
    setSearch({ status: "error", message: "Host is disconnected. Connect the host, then select Retry." });
  }, [disconnected, cancel]);

  function update(patch: Partial<SearchState>) {
    if (Object.entries(patch).every(([key, value]) => stateRef.current[key as keyof SearchState] === value)) return;
    const next = { ...stateRef.current, ...patch };
    authorizedWorkspace.current = workspaceId;
    cancel();
    editor.reset();
    stateRef.current = next;
    setState(next);
    setSearch({ status: next.query ? "waiting" : "idle" });
  }

  const rows = useMemo(() => {
    const result: ResultRow[] = [];
    if (search.status !== "done") return result;
    for (const file of search.data.files) {
      result.push({ kind: "file", key: `file:${file.path}`, path: file.path, count: file.matches.length });
      if (collapsed.has(file.path)) continue;
      for (const match of file.matches) {
        result.push({
          kind: "match",
          key: JSON.stringify([file.path, match.line, match.start, match.end]),
          path: file.path,
          match,
        });
      }
    }
    return result;
  }, [search, collapsed]);
  const targetSize = layout.compact ? 44 : 30;
  const toggleSize = layout.compact ? 36 : 22;
  const padding = layout.compact ? 12 : 8;
  const colors = theme.colors;
  // React Native Web accepts "none". Native TextStyle omits this web value.
  const noOutline = layout.platform === "web" ? { outlineStyle: "none", outlineWidth: 0 } as unknown as TextStyle : null;
  const inputStyle = {
    minHeight: targetSize,
    minWidth: 0,
    paddingHorizontal: 8,
    paddingVertical: 6,
    color: colors.foreground,
    backgroundColor: colors.surface1,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 4,
    fontSize: 13,
    ...noOutline,
  };
  const indexBusy = rebuild.isPending || index.data?.state === "building";
  const manualIndex = index.data?.state === "manual";
  const indexMessage = rebuild.isPending
    ? "Rebuilding index…"
    : rebuild.isError
      ? `Index rebuild failed: ${rebuild.error.message}`
      : index.isError
        ? `Index status unavailable: ${index.error.message}`
        : !index.data
          ? disconnected ? "Index unavailable while the host is disconnected." : "Checking index…"
          : manualIndex
            ? "Indexing is off for this folder because it is large or synced to the cloud."
            : index.data.state === "building"
              ? `Indexing… ${index.data.filesIndexed.toLocaleString()} files${index.data.partial ? " · partial index" : ""}`
              : index.data.state === "ready"
                ? `Indexed ${index.data.filesIndexed.toLocaleString()} files · ${(index.data.durationMs / 1000).toFixed(1)} s${index.data.partial ? ` · partial (${index.data.filesSkipped.toLocaleString()} files skipped)` : ""}`
                : index.data.state === "error"
                  ? `Index error: ${index.data.error ?? "Rebuild the index."}`
                  : index.data.state === "stale" ? `Index is stale · direct scan${index.data.error ? `: ${index.data.error}` : ""}` : "Index is idle · direct scan";

  return (
    <View style={{ flex: 1, minHeight: 0, backgroundColor: colors.surface0 }}>
      <View style={{ padding, gap: 4 }}>
        <View
          style={{
            minHeight: targetSize,
            flexDirection: "row",
            alignItems: "center",
            gap: 2,
            paddingRight: 3,
            backgroundColor: colors.surface1,
            borderWidth: 1,
            borderRadius: 4,
            borderColor: queryFocused ? colors.accent : colors.border,
          }}
        >
          <TextInput
            ref={queryInput}
            autoFocus
            accessibilityLabel="Find in files"
            placeholder="Search"
            placeholderTextColor={colors.foregroundMuted}
            selectionColor={colors.accent}
            value={state.query}
            maxLength={8192}
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="search"
            blurOnSubmit={false}
            onFocus={() => setQueryFocused(true)}
            onBlur={() => setQueryFocused(false)}
            onChangeText={(query) => update({ query })}
            onSubmitEditing={() => pendingSearch.current?.()}
            style={{
              flex: 1,
              minWidth: 0,
              alignSelf: "stretch",
              paddingHorizontal: 8,
              paddingVertical: 4,
              color: colors.foreground,
              fontSize: 13,
              ...noOutline,
            }}
          />
          {([
            ["caseSensitive", caseSensitiveIcon, "Match case"],
            ["wholeWord", wholeWordIcon, "Match whole word"],
            ["regex", regexIcon, "Use regular expression"],
          ] as const).map(([key, svg, label]) => (
            <Pressable
              key={key}
              accessibilityRole="checkbox"
              accessibilityLabel={label}
              accessibilityState={{ checked: state[key] }}
              onPress={() => update({ [key]: !stateRef.current[key] })}
              style={({ pressed }) => ({
                width: toggleSize,
                height: toggleSize,
                alignItems: "center",
                justifyContent: "center",
                borderWidth: 1,
                borderRadius: 3,
                borderColor: state[key] ? colors.accent : "transparent",
                backgroundColor: state[key] ? withAlpha(colors.accent, "33") : pressed ? colors.surface2 : "transparent",
              })}
            >
              <Icon icon={{ svg }} size={16} color={state[key] ? colors.foreground : colors.foregroundMuted} />
            </Pressable>
          ))}
        </View>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          {indexBusy && <ActivityIndicator size="small" color={colors.accent} />}
          <Text
            accessibilityLiveRegion="polite"
            numberOfLines={2}
            style={{ flex: 1, color: index.isError || rebuild.isError || index.data?.state === "error" ? colors.statusDanger : colors.foregroundMuted, fontSize: 11 }}
          >
            {indexMessage}
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={manualIndex ? "Build index" : "Rebuild index"}
            accessibilityState={{ disabled: disconnected || indexBusy, busy: indexBusy }}
            disabled={disconnected || indexBusy}
            onPress={() => rebuild.mutate({ workspaceId })}
            style={({ pressed }) => ({
              minWidth: targetSize,
              paddingHorizontal: manualIndex ? 8 : 0,
              flexDirection: "row",
              gap: 5,
              height: targetSize,
              alignItems: "center",
              justifyContent: "center",
              borderRadius: 3,
              opacity: disconnected || indexBusy ? 0.5 : 1,
              backgroundColor: pressed ? colors.surface2 : "transparent",
            })}
          >
            <Icon name="RefreshCw" size={14} color={colors.foregroundMuted} />
            {manualIndex && <Text style={{ color: colors.foreground, fontSize: 11 }}>Build index</Text>}
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Toggle file filters"
            accessibilityState={{ expanded: state.filtersOpen }}
            onPress={() => setState({ ...stateRef.current, filtersOpen: !stateRef.current.filtersOpen })}
            style={({ pressed }) => ({
              width: toggleSize,
              height: toggleSize,
              alignItems: "center",
              justifyContent: "center",
              borderRadius: 3,
              backgroundColor: state.filtersOpen || pressed ? colors.surface2 : "transparent",
            })}
          >
            <Icon name="Ellipsis" size={16} color={state.filtersOpen ? colors.foreground : colors.foregroundMuted} />
          </Pressable>
        </View>
        {state.filtersOpen && (
          <View style={{ gap: 5 }}>
            <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>Files to include</Text>
            <TextInput
              accessibilityLabel="Files to include, one glob pattern"
              placeholder="**/*.{ts,tsx}"
              placeholderTextColor={colors.foregroundMuted}
              selectionColor={colors.accent}
              value={state.include}
              maxLength={4096}
              autoCapitalize="none"
              autoCorrect={false}
              onChangeText={(include) => update({ include })}
              onFocus={() => setFilterFocused("include")}
              onBlur={() => setFilterFocused(null)}
              style={[inputStyle, { borderColor: filterFocused === "include" ? colors.accent : colors.border }]}
            />
            <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>Files to exclude</Text>
            <TextInput
              accessibilityLabel="Files to exclude, one glob pattern"
              placeholder="**/generated/**"
              placeholderTextColor={colors.foregroundMuted}
              selectionColor={colors.accent}
              value={state.exclude}
              maxLength={4096}
              autoCapitalize="none"
              autoCorrect={false}
              onChangeText={(exclude) => update({ exclude })}
              onFocus={() => setFilterFocused("exclude")}
              onBlur={() => setFilterFocused(null)}
              style={[inputStyle, { borderColor: filterFocused === "exclude" ? colors.accent : colors.border }]}
            />
            <Text style={{ color: colors.foregroundMuted, fontSize: 11 }}>Use one glob per field. Leave a field empty to omit it.</Text>
          </View>
        )}
      </View>
      <View style={{ flex: 1, minHeight: 0, borderTopWidth: 1, borderColor: colors.border }}>
        <View style={{ padding, gap: 6 }} accessibilityLiveRegion="polite">
          {search.status === "idle" && <Text style={{ color: colors.foregroundMuted, fontSize: 13 }}>Enter text to search this workspace.</Text>}
          {search.status === "checking-index" && <Text style={{ color: colors.foregroundMuted, fontSize: 13 }}>Search waits for the index status.</Text>}
          {search.status === "paused" && <Text style={{ color: colors.foregroundMuted, fontSize: 13 }}>Query preserved. Press Enter or edit the query to search this folder.</Text>}
          {search.status === "waiting" && <Text style={{ color: colors.foregroundMuted, fontSize: 13 }}>Search starts after a short pause.</Text>}
          {search.status === "searching" && (
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <ActivityIndicator size="small" color={colors.accent} />
              <Text style={{ color: colors.foregroundMuted, fontSize: 13 }}>Searching…</Text>
            </View>
          )}
          {search.status === "error" && (
            <>
              <Text selectable style={{ color: colors.statusDanger, fontSize: 13 }}>{search.message}</Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Retry search"
                onPress={() => {
                  authorizedWorkspace.current = workspaceId;
                  cancel();
                  if (!initialIndexReady) void index.refetch();
                  setRetry((value) => value + 1);
                }}
                style={{ alignSelf: "flex-start", minHeight: targetSize, justifyContent: "center", paddingHorizontal: 8, backgroundColor: colors.surface1, borderRadius: 4 }}
              >
                <Text style={{ color: colors.foreground, fontSize: 13 }}>Retry</Text>
              </Pressable>
            </>
          )}
          {search.status === "done" && (
            <>
              <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>
                {search.data.totalMatches} {search.data.totalMatches === 1 ? "result" : "results"} in {search.data.totalFiles} {search.data.totalFiles === 1 ? "file" : "files"}
                {search.data.index.state !== "ready" ? ` · Direct scan (index ${search.data.index.state})` : search.data.index.partial ? " · Partial index with direct scan" : ""}
              </Text>
              {search.data.truncated && <Text style={{ color: colors.statusWarning, fontSize: 12 }}>Results are truncated. Narrow the search.</Text>}
              {search.data.totalMatches === 0 && <Text style={{ color: colors.foregroundMuted, fontSize: 13 }}>{search.data.truncated ? "No results in the files that the plugin read. Search is incomplete." : "No results. Change the query or the file filters."}</Text>}
            </>
          )}
          {editor.isError && <Text selectable style={{ color: colors.statusDanger, fontSize: 12 }}>{editor.error.message}</Text>}
        </View>
        <FlatList
          style={{ flex: 1 }}
          data={rows}
          keyExtractor={(row) => row.key}
          keyboardShouldPersistTaps="handled"
          initialNumToRender={30}
          maxToRenderPerBatch={30}
          windowSize={7}
          renderItem={({ item }) => item.kind === "file" ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`${item.path}, ${item.count} ${item.count === 1 ? "occurrence" : "occurrences"}`}
              accessibilityState={{ expanded: !collapsed.has(item.path) }}
              onPress={() => setCollapsed((previous) => {
                const next = new Set(previous);
                if (next.has(item.path)) next.delete(item.path);
                else next.add(item.path);
                return next;
              })}
              style={({ pressed }) => ({
                minHeight: targetSize,
                paddingHorizontal: padding,
                flexDirection: "row",
                alignItems: "center",
                gap: 5,
                backgroundColor: pressed ? colors.surface2 : colors.surface1,
              })}
            >
              <Icon name={collapsed.has(item.path) ? "ChevronRight" : "ChevronDown"} size={14} color={colors.foregroundMuted} />
              <Text numberOfLines={1} ellipsizeMode="middle" style={{ flex: 1, color: colors.foreground, fontSize: 12 }}>{item.path}</Text>
              <Text style={{ color: colors.foregroundMuted, fontSize: 11 }}>{item.count}</Text>
            </Pressable>
          ) : (
            <MatchRow
              path={item.path}
              match={item.match}
              theme={theme}
              layout={layout}
              disabled={editor.isPending}
              onPreview={() => onPreview(workspaceId, { relativePath: item.path, line: item.match.line, column: item.match.start + 1, endColumn: item.match.end + 1 })}
              onEditor={() => editor.mutate({ workspaceId, relativePath: item.path, line: item.match.line, column: item.match.start + 1 })}
            />
          )}
        />
      </View>
    </View>
  );
}

function MatchRow({ path, match, theme, layout, disabled, onPreview, onEditor }: {
  path: string;
  match: SearchMatch;
  theme: PluginWorkspacePanelProps["theme"];
  layout: PluginWorkspacePanelProps["layout"];
  disabled: boolean;
  onPreview(): void;
  onEditor(): void;
}) {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [touch, setTouch] = useState(layout.platform !== "web");
  const visible = layout.compact || touch || hovered || focused;
  const colors = theme.colors;
  const targetSize = layout.compact ? 44 : 30;
  const text = expandTabs(match.text);
  const start = expandedOffset(match.text, match.start);
  const end = expandedOffset(match.text, match.end);
  const whitespace = layout.platform === "web" ? { whiteSpace: "pre" } as TextStyle & { whiteSpace: "pre" } : null;
  return (
    <View
      onPointerEnter={(event) => { setTouch(event.nativeEvent.pointerType !== "mouse"); setHovered(true); }}
      onPointerLeave={() => setHovered(false)}
      onTouchStart={() => setTouch(true)}
      style={{ flexDirection: "row", alignItems: "center", backgroundColor: hovered || focused ? colors.surface1 : colors.surface0 }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Preview ${path}, line ${match.line}, column ${match.start + 1}`}
        accessibilityHint={match.text}
        onPress={onPreview}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        style={({ pressed }) => ({
          flex: 1,
          minWidth: 0,
          minHeight: targetSize,
          paddingLeft: layout.compact ? 16 : 12,
          paddingRight: 6,
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
          backgroundColor: pressed ? colors.surface2 : colors.surface0,
        })}
      >
        <Text style={{ minWidth: 26, textAlign: "right", color: colors.foregroundMuted, fontSize: 11 }}>{match.line}</Text>
        <Text numberOfLines={1} style={[{ flex: 1, color: colors.foreground, fontSize: 12, fontFamily: "monospace" }, whitespace]}>
          {text.slice(0, start)}
          <Text style={{ color: colors.foreground, backgroundColor: withAlpha(colors.accent, "40") }}>{text.slice(start, end) || "│"}</Text>
          {text.slice(end)}
        </Text>
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Open ${path} in VS Code, line ${match.line}, column ${match.start + 1}`}
        accessibilityState={{ disabled }}
        disabled={disabled}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onPress={(event) => { event.stopPropagation(); onEditor(); }}
        style={({ pressed }) => ({
          width: targetSize,
          height: targetSize,
          alignItems: "center",
          justifyContent: "center",
          opacity: visible ? disabled ? 0.5 : 1 : 0,
          backgroundColor: pressed ? colors.surface2 : colors.surface0,
        })}
      >
        <Icon name="ExternalLink" size={15} color={colors.foregroundMuted} />
      </Pressable>
    </View>
  );
}
