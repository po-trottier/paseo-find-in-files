import { isSyntaxThemeId, SYNTAX_THEME_OPTIONS } from "@getpaseo/highlight";
import { type PluginSurfaceProps, useSettings } from "@getpaseo/plugin/client";
import { ScrollView, SettingsCard, SettingsRow, SettingsSection, SettingsSelect } from "@getpaseo/plugin/client/ui";
import { useEffect, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { findDefaults, findSettings } from "../shared/settings";
import type { SearchShortcutController } from "./web";

const syntaxThemes = SYNTAX_THEME_OPTIONS.map(({ id, label }): { value: string; label: string } => ({ value: id, label }));

export function FindSettings({ theme, layout, shortcut }: PluginSurfaceProps & { shortcut: SearchShortcutController }) {
  const settings = useSettings(findSettings);
  const latestSettings = useRef(settings);
  latestSettings.current = settings;
  const [capturing, setCapturing] = useState(false);
  const values = settings.status === "ready" ? settings.values : findDefaults;
  const shortcutLabel = settings.status === "ready"
    ? settings.values.shortcut || "Unassigned"
    : settings.status === "loading" ? "Loading…" : "Unavailable";
  const disabled = settings.status !== "ready" || settings.saving;
  const web = layout.platform === "web";
  const colors = theme.colors;
  const error = settings.saveError ?? (settings.status === "error" || settings.status === "invalid" ? settings.error : null);
  useEffect(() => {
    if (settings.status === "ready") shortcut.setShortcut(settings.values.shortcut);
  }, [settings.status, values.shortcut, shortcut]);
  useEffect(() => () => shortcut.cancelCapture(), [shortcut]);

  function save(changes: Partial< typeof findDefaults>) {
    const current = latestSettings.current;
    if (current.status !== "ready" || current.saving) return;
    void current.save({ ...current.values, ...changes }, current.revision).then((saved) => {
      if (saved && changes.shortcut !== undefined) shortcut.setShortcut(changes.shortcut);
    });
  }
  function startCapture() {
    if (disabled || !web || capturing) return;
    setCapturing(true);
    shortcut.capture((value) => {
      setCapturing(false);
      save({ shortcut: value });
    }, () => setCapturing(false));
  }
  const buttonStyle = {
    minHeight: layout.compact ? 44 : 36,
    paddingHorizontal: 12,
    justifyContent: "center" as const,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface1,
  };
  return (
    <ScrollView style={{ flex: 1, backgroundColor: colors.surface0 }} contentContainerStyle={{ padding: layout.compact ? 16 : 24, gap: 20 }}>
      <SettingsSection title="Find in files">
        <SettingsCard>
          <SettingsSelect
            label="Syntax theme"
            hint="Select the colors for file previews."
            value={values.syntaxTheme}
            options={syntaxThemes}
            disabled={disabled || capturing}
            onValueChange={(syntaxTheme) => { if (isSyntaxThemeId(syntaxTheme)) save({ syntaxTheme }); }}
          />
          <SettingsRow
            label="Search shortcut"
            hint={web
              ? "Use Ctrl, Command, or Alt with a key, or use F1–F24. Mod means Ctrl on Windows/Linux and Command on macOS. Escape cancels capture."
              : "Keyboard shortcuts are available in desktop and web clients."}
          >
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={capturing ? "Press the search shortcut" : `Capture search shortcut, currently ${shortcutLabel}`}
                accessibilityState={{ disabled: disabled || !web }}
                disabled={disabled || !web}
                onPress={startCapture}
                style={{ ...buttonStyle, flexGrow: 1, opacity: disabled || !web ? 0.5 : 1 }}
              >
                <Text style={{ color: capturing ? colors.accent : colors.foreground }}>
                  {capturing ? "Press a shortcut…" : shortcutLabel}
                </Text>
              </Pressable>
              {capturing && (
                <Pressable accessibilityRole="button" accessibilityLabel="Cancel shortcut capture" onPress={() => shortcut.cancelCapture()} style={buttonStyle}>
                  <Text style={{ color: colors.foreground }}>Cancel</Text>
                </Pressable>
              )}
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Clear search shortcut"
                accessibilityState={{ disabled: disabled || !web || !values.shortcut }}
                disabled={disabled || !web || !values.shortcut}
                onPress={() => {
                  shortcut.cancelCapture();
                  save({ shortcut: "" });
                }}
                style={{ ...buttonStyle, opacity: disabled || !web || !values.shortcut ? 0.5 : 1 }}
              >
                <Text style={{ color: colors.foreground }}>Clear</Text>
              </Pressable>
            </View>
          </SettingsRow>
        </SettingsCard>
      </SettingsSection>
      {settings.status === "loading" && <Text style={{ color: colors.foregroundMuted }}>Read settings…</Text>}
      {error && <Text selectable accessibilityRole="alert" style={{ color: colors.statusDanger }}>{error}</Text>}
    </ScrollView>
  );
}
