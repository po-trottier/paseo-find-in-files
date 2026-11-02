import { settingsRpc } from "@getpaseo/plugin";
import type { PluginClientContext } from "@getpaseo/plugin/client";
import { Platform } from "react-native";
import { findSettings } from "../shared/settings";
import { matchesShortcut, parseShortcut, parseWorkspacePath, shortcutFromEvent, type ShortcutKeyEvent } from "./shortcut";

type WebElement = {
  parentElement?: WebElement | null;
  closest?(selector: string): WebElement | null;
};
type WebKeyEvent = ShortcutKeyEvent & {
  defaultPrevented: boolean;
  target: WebElement | null;
  preventDefault(): void;
  stopPropagation(): void;
  stopImmediatePropagation(): void;
};
declare const window: {
  location: { pathname: string };
  navigator: { platform?: string; userAgent?: string; userAgentData?: { platform?: string } };
  localStorage?: { getItem(key: string): string | null };
  addEventListener(type: "keydown", listener: (event: WebKeyEvent) => void, capture: boolean): void;
  removeEventListener(type: "keydown", listener: (event: WebKeyEvent) => void, capture: boolean): void;
  setInterval(handler: () => void, ms: number): number;
  clearInterval(id: number): void;
};
declare const document: {
  activeElement: WebElement | null;
  querySelector(selector: string): WebElement | null;
};

export interface SearchShortcutController {
  capture(onCapture: (shortcut: string) => void, onCancel: () => void): void;
  cancelCapture(): void;
  setShortcut(value: string): void;
  dispose(): Promise<void>;
}

// ponytail: reads Paseo's internal app-settings storage key. Replace it when the plugin theme exposes syntax colors.
const APP_SETTINGS_KEY = "@paseo:app-settings";

/** Paseo's Appearance > syntax theme on desktop and web, or null when it cannot be read (native, no value). */
export function readPaseoSyntaxTheme(): string | null {
  if (Platform.OS !== "web" || typeof window === "undefined") return null;
  try {
    const value: unknown = JSON.parse(window.localStorage?.getItem(APP_SETTINGS_KEY) ?? "null");
    const theme = (value as { syntaxTheme?: unknown } | null)?.syntaxTheme;
    return typeof theme === "string" ? theme : null;
  } catch {
    return null;
  }
}

/** Paseo writes app settings in this window, which fires no storage event, so poll the small value. */
export function subscribePaseoSyntaxTheme(onChange: () => void): () => void {
  if (Platform.OS !== "web" || typeof window === "undefined") return () => {};
  const id = window.setInterval(onChange, 1000);
  return () => window.clearInterval(id);
}

export function registerSearchShortcut(client: PluginClientContext): SearchShortcutController {
  if (Platform.OS !== "web" || typeof window === "undefined" || typeof document === "undefined") {
    return { capture() {}, cancelCapture() {}, setShortcut() {}, async dispose() {} };
  }
  const isMac = /Mac|iPhone|iPad|iPod/i.test(
    window.navigator.userAgentData?.platform ?? window.navigator.platform ?? window.navigator.userAgent ?? "",
  );
  let hostId: string | null = null;
  let shortcut = parseShortcut("");
  let capture: { accept(value: string): void; cancel(): void } | null = null;
  let disposed = false;
  let settingsVersion = 0;
  const rpc = settingsRpc(findSettings.id);
  async function readSettings() {
    const version = ++settingsVersion;
    try {
      const result = await client.rpc(rpc.read, {});
      if (disposed || version !== settingsVersion) return;
      const parsed = result.status === "ready" ? findSettings.schema.safeParse(result.values) : null;
      shortcut = parsed?.success ? parseShortcut(parsed.data.shortcut) : null;
    } catch (error) {
      if (!disposed && version === settingsVersion) {
        shortcut = null;
        console.warn("[Find in files] Could not read the shortcut", error);
      }
    }
  }
  async function readHost() {
    hostId = null;
    try {
      const { self } = await client.paseo.hosts.list();
      if (!disposed) hostId = self.serverId;
    } catch (error) {
      if (!disposed) console.warn("[Find in files] Could not identify the active host", error);
    }
  }
  const settings = client.paseo.observeEvents(["status.plugin_settings_changed"]);
  const unsubscribe = settings.subscribe({
    snapshot: () => {
      void readHost();
      void readSettings();
    },
    update(event) {
      if (event.type === "status" && event.payload.status === "plugin_settings_changed"
        && event.payload.settingsId === findSettings.id) void readSettings();
    },
    error(error) {
      if (!disposed) console.warn("[Find in files] Could not observe settings", error);
    },
  });
  const terminalSelector = ".xterm, .xterm-helper-textarea, [role='terminal'], [data-testid='terminal-surface']";
  function cancelCapture() {
    const previous = capture;
    capture = null;
    previous?.cancel();
  }
  function onKeyDown(event: WebKeyEvent) {
    if (disposed || event.getModifierState?.("AltGraph")) return;
    if (capture) {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      if (event.key === "Escape" && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) {
        cancelCapture();
        return;
      }
      const value = shortcutFromEvent(event, isMac);
      if (value) {
        const previous = capture;
        capture = null;
        previous.accept(value);
      }
      return;
    }
    if (event.defaultPrevented || !matchesShortcut(shortcut, event, isMac)) return;
    if ([event.target, event.target?.parentElement, document.activeElement].some((element) => element?.closest?.(terminalSelector))
      || document.querySelector("[aria-modal='true']")) return;
    // ponytail: this uses an internal route. Replace it when the SDK exposes workspace shortcuts.
    const active = parseWorkspacePath(window.location.pathname);
    if (!active || active.hostId !== hostId) return;
    client.openPanel("search", { workspaceId: active.workspaceId, location: "explorer" });
    event.preventDefault();
    event.stopPropagation();
  }
  window.addEventListener("keydown", onKeyDown, true);
  return {
    capture(accept, cancel) {
      cancelCapture();
      if (!disposed) capture = { accept, cancel };
    },
    cancelCapture,
    setShortcut(value) {
      if (disposed) return;
      settingsVersion++;
      shortcut = parseShortcut(value);
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      capture = null;
      window.removeEventListener("keydown", onKeyDown, true);
      unsubscribe();
      await settings.release();
    },
  };
}
