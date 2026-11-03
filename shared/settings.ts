import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

/** What "Add to context" does: add a composer attachment, copy to the clipboard, or both. */
export const addToContextModes = ["attachment", "copy", "both"] as const;
export type AddToContextMode = typeof addToContextModes[number];

/** Preview colors are `#RRGGBB`. The preview applies its own transparency so code stays readable. */
export const hexColor = z.string().regex(/^#[\da-f]{6}$/i);
export const colorPresets = ["#3B82F6", "#A855F7", "#22C55E", "#EAB308", "#F97316", "#EC4899", "#94A3B8"] as const;

export const findDefaults: { shortcut: string; addToContext: AddToContextMode; selectionColor: string; matchColor: string } = {
  shortcut: "Mod+Alt+Shift+F",
  addToContext: "attachment",
  selectionColor: "#3B82F6",
  matchColor: "#EAB308",
};

export const findSettings = defineSettings({
  id: "preferences",
  scope: "host",
  version: 1,
  schema: z.object({
    shortcut: z.string().max(160).default(findDefaults.shortcut),
    addToContext: z.enum(addToContextModes).default(findDefaults.addToContext),
    selectionColor: hexColor.default(findDefaults.selectionColor),
    matchColor: hexColor.default(findDefaults.matchColor),
  }).default(findDefaults),
});
