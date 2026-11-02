import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const findDefaults: { shortcut: string } = { shortcut: "Mod+Alt+Shift+F" };

export const findSettings = defineSettings({
  id: "preferences",
  scope: "host",
  version: 1,
  schema: z.object({
    shortcut: z.string().max(160).default(findDefaults.shortcut),
  }).default(findDefaults),
});
