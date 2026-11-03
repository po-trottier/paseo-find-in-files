import type { HighlightToken } from "@getpaseo/highlight";
import { type ReactNode, useEffect, useState } from "react";
import { Text, TextInput, type TextStyle, View } from "react-native";
import { highlightPreview } from "./highlight";

const LINE_HEIGHT = 20;
const HIGHLIGHT_DELAY_MS = 150;

/**
 * A multiline code field. On web the field text is transparent over a colored copy of the visible
 * lines, so the caret and selection come from the real field. Native clients show plain text.
 */
export function EditBox({ value, onChangeText, editable, path, padding, web, fontFamily, colors, syntaxColors }: {
  value: string;
  onChangeText(value: string): void;
  editable: boolean;
  path: string;
  padding: number;
  web: boolean;
  fontFamily: string;
  colors: { foreground: string; surface0: string };
  syntaxColors: Record<string, string>;
}) {
  const [tokens, setTokens] = useState<Map<string, HighlightToken[]> | null>(null);
  const [scroll, setScroll] = useState({ x: 0, y: 0 });
  const [height, setHeight] = useState(0);
  useEffect(() => {
    if (!web) return;
    const lifetime = new AbortController();
    // Typing changes the text faster than the parser runs. Color the text after a short pause.
    const timer = setTimeout(() => {
      void highlightPreview(value, path, lifetime.signal).then((lines) => {
        if (lifetime.signal.aborted) return;
        // Key tokens by line text. A changed line shows plain until the next pass colors it.
        setTokens(lines && new Map(lines.map((line) => [line.map((token) => token.text).join(""), line])));
      });
    }, HIGHLIGHT_DELAY_MS);
    return () => {
      clearTimeout(timer);
      lifetime.abort();
    };
  }, [value, path, web]);

  const textStyle: TextStyle = { fontFamily, fontSize: 13, lineHeight: LINE_HEIGHT };
  const overlay = web && tokens !== null;
  let backdrop: ReactNode = null;
  if (overlay) {
    // Render only the visible lines. The field scrolls, and the copy follows its scroll offset.
    const lines = value.split("\n");
    const first = Math.max(0, Math.floor((scroll.y - padding) / LINE_HEIGHT));
    const last = Math.min(lines.length, first + Math.ceil(height / LINE_HEIGHT) + 2);
    const children: ReactNode[] = [];
    for (let index = first; index < last; index += 1) {
      const line = lines[index];
      for (const [spanIndex, span] of (tokens.get(line) ?? [{ text: line, style: null }]).entries()) {
        children.push(
          <Text key={`${index}:${spanIndex}`} style={[textStyle, { color: span.style ? syntaxColors[span.style] ?? colors.foreground : colors.foreground }]}>
            {span.text}
          </Text>,
        );
      }
      children.push("\n");
    }
    backdrop = (
      <View pointerEvents="none" style={{ position: "absolute", top: 0, right: 0, bottom: 0, left: 0, overflow: "hidden" }}>
        <Text
          style={[textStyle, {
            position: "absolute",
            top: padding + first * LINE_HEIGHT - scroll.y,
            left: padding - scroll.x,
            color: colors.foreground,
          }, { whiteSpace: "pre" } as TextStyle]}
        >
          {children}
        </Text>
      </View>
    );
  }

  return (
    <View
      {...({ dataSet: { findPreview: "" } } as object)}
      style={{ flex: 1, minHeight: 0, backgroundColor: colors.surface0 }}
      onLayout={(event) => setHeight(event.nativeEvent.layout.height)}
    >
      {backdrop}
      <TextInput
        multiline
        autoFocus
        editable={editable}
        value={value}
        onChangeText={onChangeText}
        onScroll={(event) => {
          const { x, y } = event.nativeEvent.contentOffset;
          setScroll((previous) => previous.x === x && previous.y === y ? previous : { x, y });
        }}
        autoCapitalize="none"
        autoCorrect={false}
        spellCheck={false}
        accessibilityLabel={`Edit ${path}`}
        selectionColor={colors.foreground}
        // The field text is transparent over the colored copy, and CSS paints the caret in the text
        // color by default. `caretColor` keeps the caret visible.
        style={[textStyle, {
          flex: 1,
          minHeight: 0,
          padding,
          color: overlay ? "transparent" : colors.foreground,
          backgroundColor: "transparent",
          textAlignVertical: "top",
        }, web ? { whiteSpace: "pre", caretColor: colors.foreground } as TextStyle : undefined]}
      />
    </View>
  );
}
