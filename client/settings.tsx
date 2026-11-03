import { type PluginSurfaceProps, useSettings } from "@getpaseo/plugin/client";
import { ScrollView, SettingsCard, SettingsRow, SettingsSection, TextInput } from "@getpaseo/plugin/client/ui";
import { useEffect, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { addToContextModes, colorPresets, findDefaults, findSettings, hexColor } from "../shared/settings";
import type { SearchShortcutController } from "./web";

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
          <SettingsRow
            label="Add to context"
            hint="Attachment adds the selection to the composer's Find in Files selection picker. Copy puts it on the clipboard as a path, line range, and code block."
          >
            <View accessibilityRole="radiogroup" style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
              {addToContextModes.map((mode) => {
                const checked = values.addToContext === mode;
                return (
                  <Pressable
                    key={mode}
                    accessibilityRole="radio"
                    accessibilityState={{ checked, disabled }}
                    disabled={disabled}
                    onPress={() => save({ addToContext: mode })}
                    style={{ ...buttonStyle, borderColor: checked ? colors.accent : colors.border, opacity: disabled ? 0.5 : 1 }}
                  >
                    <Text style={{ color: checked ? colors.accent : colors.foreground }}>{{ attachment: "Attachment", copy: "Copy", both: "Both" }[mode]}</Text>
                  </Pressable>
                );
              })}
            </View>
          </SettingsRow>
          <ColorRow
            label="Selection color"
            hint="Color of selected line numbers and selected code text in the preview."
            value={values.selectionColor}
            disabled={disabled}
            colors={colors}
            compact={layout.compact}
            onChange={(selectionColor) => save({ selectionColor })}
          />
          <ColorRow
            label="Match line color"
            hint="Color of the preview line that holds the search match, and of the matched text."
            value={values.matchColor}
            disabled={disabled}
            colors={colors}
            compact={layout.compact}
            onChange={(matchColor) => save({ matchColor })}
          />
        </SettingsCard>
      </SettingsSection>
      {settings.status === "loading" && <Text style={{ color: colors.foregroundMuted }}>Read settings…</Text>}
      {error && <Text selectable accessibilityRole="alert" style={{ color: colors.statusDanger }}>{error}</Text>}
    </ScrollView>
  );
}

/** Preset swatches and a `#RRGGBB` field. The field saves on submit or blur when the value is valid. */
function ColorRow({ label, hint, value, disabled, colors, compact, onChange }: {
  label: string;
  hint: string;
  value: string;
  disabled: boolean;
  colors: PluginSurfaceProps["theme"]["colors"];
  compact: boolean;
  onChange(color: string): void;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const valid = hexColor.safeParse(draft).success;
  const commit = () => {
    if (valid && draft.toUpperCase() !== value.toUpperCase()) onChange(draft.toUpperCase());
    else setDraft(value);
  };
  const size = compact ? 32 : 24;
  return (
    <SettingsRow label={label} hint={hint}>
      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8, opacity: disabled ? 0.5 : 1 }}>
        <View accessibilityRole="radiogroup" style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
          {colorPresets.map((preset) => {
            const checked = preset.toUpperCase() === value.toUpperCase();
            return (
              <Pressable
                key={preset}
                accessibilityRole="radio"
                accessibilityLabel={preset}
                accessibilityState={{ checked, disabled }}
                disabled={disabled}
                onPress={() => onChange(preset)}
                style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: preset, borderWidth: 2, borderColor: checked ? colors.foreground : "transparent" }}
              />
            );
          })}
        </View>
        <TextInput
          accessibilityLabel={`${label} hex value`}
          editable={!disabled}
          value={draft}
          onChangeText={setDraft}
          onSubmitEditing={commit}
          onBlur={commit}
          maxLength={7}
          autoCapitalize="characters"
          autoCorrect={false}
          placeholder="#RRGGBB"
          placeholderTextColor={colors.foregroundMuted}
          selectionColor={colors.accent}
          style={{
            width: 96,
            minHeight: compact ? 44 : 32,
            paddingHorizontal: 8,
            borderRadius: 6,
            borderWidth: 1,
            borderColor: valid ? colors.border : colors.statusDanger,
            backgroundColor: colors.surface1,
            color: colors.foreground,
            fontFamily: "monospace",
          }}
        />
        <View style={{ width: size, height: size, borderRadius: 4, backgroundColor: valid ? draft : value, borderWidth: 1, borderColor: colors.border }} />
      </View>
    </SettingsRow>
  );
}
