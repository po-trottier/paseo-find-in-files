export interface ShortcutKeyEvent {
  key: string;
  code?: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  repeat?: boolean;
  isComposing?: boolean;
  keyCode?: number;
  getModifierState?(modifier: string): boolean;
}

export interface Shortcut {
  key: string;
  mod: boolean;
  ctrl: boolean;
  meta: boolean;
  alt: boolean;
  shift: boolean;
}

const namedKeys = [
  "Space", "Enter", "Escape", "Tab", "Backspace", "Delete", "Insert", "Home", "End",
  "PageUp", "PageDown", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Plus",
];
const codeKeys: Record<string, string> = {
  Space: "Space", Equal: "=", Minus: "-", BracketLeft: "[", BracketRight: "]", Backslash: "\\",
  Semicolon: ";", Quote: "'", Comma: ",", Period: ".", Slash: "/", Backquote: "`",
};

function normalizeKey(key: string): string | null {
  if (/^[a-z0-9]$/i.test(key) || /^F(?:[1-9]|1\d|2[0-4])$/i.test(key)) return key.toUpperCase();
  if (key.length === 1 && "-=[]\\;',./`".includes(key)) return key;
  return namedKeys.find((name) => name.toLowerCase() === key.toLowerCase()) ?? null;
}

export function parseShortcut(value: string): Shortcut | null {
  if (!value || value.length > 160) return null;
  const shortcut: Shortcut = { key: "", mod: false, ctrl: false, meta: false, alt: false, shift: false };
  for (const part of value.split("+")) {
    const modifier = part.toLowerCase();
    if (["mod", "ctrl", "meta", "alt", "shift"].includes(modifier)) {
      const name = modifier as "mod" | "ctrl" | "meta" | "alt" | "shift";
      if (shortcut[name] || shortcut.key) return null;
      shortcut[name] = true;
    } else {
      const key = normalizeKey(part);
      if (!key || shortcut.key) return null;
      shortcut.key = key;
    }
  }
  return shortcut.key && (shortcut.mod || shortcut.ctrl || shortcut.meta || shortcut.alt || /^F(?:[1-9]|1\d|2[0-4])$/.test(shortcut.key))
    ? shortcut : null;
}

function keyFromEvent(event: ShortcutKeyEvent): string | null {
  if (event.key === " ") return "Space";
  if (event.key === "+") return "Plus";
  const key = normalizeKey(event.key);
  if (key) return key;
  const code = event.code ?? "";
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  return codeKeys[code] ?? normalizeKey(code);
}

export function matchesShortcut(shortcut: Shortcut | null, event: ShortcutKeyEvent, isMac: boolean): boolean {
  if (!shortcut || event.repeat || event.isComposing || event.keyCode === 229 || event.getModifierState?.("AltGraph")) return false;
  if (event.ctrlKey !== (shortcut.ctrl || (shortcut.mod && !isMac))
    || event.metaKey !== (shortcut.meta || (shortcut.mod && isMac))
    || event.altKey !== shortcut.alt || event.shiftKey !== shortcut.shift) return false;
  return keyFromEvent(event) === shortcut.key
    || (event.altKey && event.code === `Key${shortcut.key}`);
}

export function shortcutFromEvent(event: ShortcutKeyEvent, isMac: boolean): string | null {
  if (event.repeat || event.isComposing || event.keyCode === 229 || event.getModifierState?.("AltGraph")) return null;
  const key = keyFromEvent(event);
  if (!key) return null;
  const parts: string[] = [];
  if (isMac ? event.metaKey : event.ctrlKey) parts.push("Mod");
  if (isMac && event.ctrlKey) parts.push("Ctrl");
  if (!isMac && event.metaKey) parts.push("Meta");
  if (event.altKey) parts.push("Alt");
  if (event.shiftKey) parts.push("Shift");
  parts.push(key);
  const value = parts.join("+");
  return parseShortcut(value) ? value : null;
}

export function parseWorkspacePath(pathname: string): { hostId: string; workspaceId: string } | null {
  const match = /^\/h\/([^/]+)\/workspace\/([^/]+)\/?$/.exec(pathname);
  if (!match) return null;
  try {
    const hostId = decodeURIComponent(match[1]!);
    const workspaceId = decodeURIComponent(match[2]!);
    if (!hostId || !workspaceId || /[/\\?#\u0000-\u001f\u007f]/.test(hostId + workspaceId)) return null;
    return { hostId, workspaceId };
  } catch {
    return null;
  }
}
