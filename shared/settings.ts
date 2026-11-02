import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

/** What "Add to context" does: add a composer attachment, copy to the clipboard, or both. */
export const addToContextModes = ["attachment", "copy", "both"] as const;
export type AddToContextMode = typeof addToContextModes[number];

export const findDefaults: { shortcut: string; addToContext: AddToContextMode } = { shortcut: "Mod+Alt+Shift+F", addToContext: "attachment" };

export const findSettings = defineSettings({
  id: "preferences",
  scope: "host",
  version: 1,
  schema: z.object({
    shortcut: z.string().max(160).default(findDefaults.shortcut),
    addToContext: z.enum(addToContextModes).default(findDefaults.addToContext),
  }).default(findDefaults),
});
