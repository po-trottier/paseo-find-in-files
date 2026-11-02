import {
  highlightCodeWithBudget,
  HIGHLIGHT_MAX_SOURCE_BYTES,
  isLanguageSupported,
  type HighlightToken,
} from "@getpaseo/highlight";

const HIGHLIGHT_BUDGET_MS = 200;
const MAX_LINE_TOKENS = 256;

// React Native's Promise polyfill requires the executor form.
const yieldToClient = () => new Promise< void>((resolve) => { setTimeout(resolve, 0); });

export async function highlightPreview(
  content: string,
  filename: string,
  signal?: { readonly aborted: boolean },
): Promise<HighlightToken[][] | null> {
  if (signal?.aborted || !isLanguageSupported(filename)) return null;
  // Let the plain preview and its initial line jump render before the parser starts.
  await yieldToClient();
  const deadline = Date.now() + HIGHLIGHT_BUDGET_MS;
  try {
    if (signal?.aborted || content.length > HIGHLIGHT_MAX_SOURCE_BYTES) return null;
    let bytes = 0;
    for (const character of content) {
      const point = character.codePointAt(0)!;
      bytes += point < 0x80 ? 1 : point < 0x800 ? 2 : point < 0x10000 ? 3 : 4;
      if (bytes > HIGHLIGHT_MAX_SOURCE_BYTES) return null;
    }
    return await highlightCodeWithBudget(content.replace(/\r\n?/g, "\n"), filename, {
      yieldToEventLoop: yieldToClient,
      signal: {
        get aborted() { return Boolean(signal?.aborted) || Date.now() >= deadline; },
      },
    });
  } catch {
    return null;
  }
}

function expandFrom(text: string, column: number, tabSize: number): string {
  let previous = 0;
  return text.replace(/[\t\r\n]/g, (character: string, offset: number) => {
    column += offset - previous;
    previous = offset + 1;
    if (character !== "\t") {
      column = 0;
      return character;
    }
    const width = tabSize - column % tabSize;
    column += width;
    return " ".repeat(width);
  });
}

export function expandTabs(text: string, tabSize = 4): string {
  return expandFrom(text, 0, tabSize);
}

/** Map a UTF-16 source offset to its offset after tab expansion. */
export function expandedOffset(text: string, offset: number, tabSize = 4): number {
  let column = 0;
  let expanded = 0;
  const end = Math.max(0, Math.min(text.length, offset));
  for (let index = 0; index < end; index += 1) {
    const character = text.charCodeAt(index);
    if (character === 9) {
      const width = tabSize - column % tabSize;
      column += width;
      expanded += width;
    } else {
      expanded += 1;
      column = character === 10 || character === 13 ? 0 : column + 1;
    }
  }
  return expanded;
}

export type PreviewSpan = HighlightToken & { matched: boolean };

export function previewSpans(
  text: string,
  tokens?: readonly HighlightToken[],
  match?: { start: number; end: number },
): PreviewSpan[] {
  const result: PreviewSpan[] = [];
  const start = match ? Math.max(0, Math.min(text.length, match.start)) : -1;
  const end = match ? Math.min(text.length, Math.max(start + ((text.codePointAt(start) ?? 0) > 0xffff ? 2 : 1), match.end)) : -1;
  // ponytail: Use plain text above 256 tokens per line. Add span virtualization only if needed.
  const source = tokens && tokens.length <= MAX_LINE_TOKENS ? tokens : [{ text, style: null }];
  let offset = 0;
  let column = 0;
  for (const token of source) {
    const tokenEnd = offset + token.text.length;
    let cursor = offset;
    while (cursor < tokenEnd) {
      const matched = cursor >= start && cursor < end;
      const boundary = cursor < start ? Math.min(tokenEnd, start) : matched ? Math.min(tokenEnd, end) : tokenEnd;
      const value = expandFrom(token.text.slice(cursor - offset, boundary - offset), column, 4);
      result.push({ text: value, style: token.style, matched });
      column += value.length;
      cursor = boundary;
    }
    offset = tokenEnd;
  }
  if (match && start === text.length) result.push({ text: "│", style: null, matched: true });
  return result;
}

export function surfaceColorScheme(surface: string): "light" | "dark" {
  if (!/^#[\da-f]{3,4}$|^#[\da-f]{6}([\da-f]{2})?$/i.test(surface)) return "dark";
  const hex = surface.length <= 5 ? [...surface.slice(1, 4)].map((channel) => channel + channel).join("") : surface.slice(1, 7);
  const channels = [0, 2, 4].map((offset) => {
    const channel = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722 > 0.179 ? "light" : "dark";
}
