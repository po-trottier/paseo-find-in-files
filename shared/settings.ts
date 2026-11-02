import { isSyntaxThemeId, type SyntaxThemeId } from "@getpaseo/highlight";
import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const findDefaults: { syntaxTheme: SyntaxThemeId; shortcut: string } = { syntaxTheme: "github", shortcut: "Mod+Alt+Shift+F" };

export const findSettings = defineSettings({
  id: "preferences",
  scope: "host",
  version: 1,
  schema: z.object({
    syntaxTheme: z.string().refine(isSyntaxThemeId, "Select a syntax theme.").default(findDefaults.syntaxTheme),
    shortcut: z.string().max(160).default(findDefaults.shortcut),
  }).default(findDefaults),
});
