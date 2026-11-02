import { describe, expect, it } from "vitest";
import { matchesShortcut, parseShortcut, parseWorkspacePath, shortcutFromEvent, type ShortcutKeyEvent } from "./shortcut";

const base: ShortcutKeyEvent = {
  key: "F", code: "KeyF", ctrlKey: false, metaKey: false, altKey: true, shiftKey: true,
};

describe("search shortcuts", () => {
  it("parses a complete chord and rejects malformed chords", () => {
    expect(parseShortcut("Mod+Alt+Shift+F")).toEqual({
      key: "F", mod: true, ctrl: false, meta: false, alt: true, shift: true,
    });
    expect(parseShortcut("Ctrl+Meta+F12")?.key).toBe("F12");
    expect(parseShortcut("Alt+Plus")?.key).toBe("Plus");
    for (const value of ["", "Ctrl", "Ctrl++F", "Mod+Mod+F", "Mod+F+G", "Mod+F+Shift", "Mod+Unknown", "Mod+F Mod+G"]) {
      expect(parseShortcut(value)).toBeNull();
    }
  });

  it("rejects typing keys without a command modifier and accepts function keys", () => {
    for (const value of ["F", "Shift+F", "Enter", "Tab", "Space", "Shift+Enter", "1", "Shift+Plus", "F25"]) {
      expect(parseShortcut(value)).toBeNull();
    }
    for (const value of ["Ctrl+F", "Meta+F", "Alt+F", "Mod+F", "F1", "Shift+F24"]) {
      expect(parseShortcut(value)).not.toBeNull();
    }
    const plain = { ...base, altKey: false, shiftKey: false };
    expect(shortcutFromEvent(plain, false)).toBeNull();
    expect(shortcutFromEvent({ ...plain, shiftKey: true }, false)).toBeNull();
    expect(shortcutFromEvent({ ...plain, key: "Enter", code: "Enter" }, false)).toBeNull();
    expect(shortcutFromEvent({ ...plain, key: "Tab", code: "Tab" }, false)).toBeNull();
    expect(shortcutFromEvent({ ...plain, key: " ", code: "Space" }, false)).toBeNull();
    expect(shortcutFromEvent({ ...plain, key: "F24", code: "F24" }, false)).toBe("F24");
    expect(shortcutFromEvent({ ...plain, ctrlKey: true }, false)).toBe("Mod+F");
    expect(shortcutFromEvent({ ...plain, metaKey: true }, true)).toBe("Mod+F");
  });

  it("maps Mod to Control or Meta and requires the exact modifiers", () => {
    const chord = parseShortcut("Mod+Alt+Shift+F");
    expect(matchesShortcut(chord, { ...base, ctrlKey: true }, false)).toBe(true);
    expect(matchesShortcut(chord, { ...base, metaKey: true }, true)).toBe(true);
    expect(matchesShortcut(chord, { ...base, ctrlKey: true }, true)).toBe(false);
    expect(matchesShortcut(chord, { ...base, metaKey: true }, false)).toBe(false);
    expect(matchesShortcut(chord, { ...base, ctrlKey: true, metaKey: true }, false)).toBe(false);
    expect(matchesShortcut(chord, { ...base, ctrlKey: true, altKey: false }, false)).toBe(false);
    expect(matchesShortcut(chord, { ...base, ctrlKey: true, shiftKey: false }, false)).toBe(false);
    expect(matchesShortcut(chord, { ...base, ctrlKey: true, repeat: true }, false)).toBe(false);
    expect(matchesShortcut(chord, { ...base, ctrlKey: true, isComposing: true }, false)).toBe(false);
    expect(matchesShortcut(chord, { ...base, ctrlKey: true, keyCode: 229 }, false)).toBe(false);
    expect(matchesShortcut(chord, { ...base, ctrlKey: true, getModifierState: (modifier) => modifier === "AltGraph" }, false)).toBe(false);
    expect(matchesShortcut(null, { ...base, ctrlKey: true }, false)).toBe(false);
  });

  it("captures portable chords and matches Alt-modified keys", () => {
    expect(shortcutFromEvent({ ...base, ctrlKey: true }, false)).toBe("Mod+Alt+Shift+F");
    expect(shortcutFromEvent({ ...base, metaKey: true }, true)).toBe("Mod+Alt+Shift+F");
    expect(shortcutFromEvent({ ...base, ctrlKey: true, metaKey: true }, true)).toBe("Mod+Ctrl+Alt+Shift+F");
    expect(shortcutFromEvent({ ...base, ctrlKey: true, metaKey: true }, false)).toBe("Mod+Meta+Alt+Shift+F");
    const optionF = { ...base, key: "ƒ", metaKey: true };
    expect(shortcutFromEvent(optionF, true)).toBe("Mod+Alt+Shift+F");
    expect(matchesShortcut(parseShortcut("Mod+Alt+Shift+F"), optionF, true)).toBe(true);
    expect(shortcutFromEvent({ ...base, key: "Control", code: "ControlLeft", ctrlKey: true }, false)).toBeNull();
    expect(shortcutFromEvent({ ...base, isComposing: true }, false)).toBeNull();
    expect(shortcutFromEvent({ ...base, ctrlKey: true, getModifierState: (modifier) => modifier === "AltGraph" }, false)).toBeNull();
    expect(shortcutFromEvent({ ...base, key: "+", code: "Equal" }, false)).toBe("Alt+Shift+Plus");
    expect(matchesShortcut(parseShortcut("Alt+Shift+Plus"), { ...base, key: "+", code: "Equal" }, false)).toBe(true);
  });
});

describe("active workspace route", () => {
  it("decodes both segments and accepts only the workspace route", () => {
    expect(parseWorkspacePath("/h/host%20one/workspace/work%20two")).toEqual({ hostId: "host one", workspaceId: "work two" });
    expect(parseWorkspacePath("/h/host/workspace/work/")).toEqual({ hostId: "host", workspaceId: "work" });
    for (const pathname of [
      "", "/", "/settings", "/h/host", "/h/host/workspace/", "/h//workspace/work",
      "/h/host/workspace/work/agent/agent", "/h/host/workspace/work//", "/h/host/workspace/work?query",
      "/prefix/h/host/workspace/work", "/h/bad%ZZ/workspace/work", "/h/host/workspace/bad%ZZ",
      "/h/host%2Fother/workspace/work", "/h/host/workspace/work%2Fother", "/h/host/workspace/work%5Cother",
      "/h/host/workspace/work%00", "/h/host%0A/workspace/work",
    ]) {
      expect(parseWorkspacePath(pathname)).toBeNull();
    }
  });
});
