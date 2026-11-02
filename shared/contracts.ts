import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { indexStateSchema, indexStatusSchema } from "./index";

export const searchInputSchema = z.object({
  workspaceId: z.string().min(1),
  query: z.string().max(8192),
  caseSensitive: z.boolean(),
  wholeWord: z.boolean(),
  regex: z.boolean(),
  include: z.string().max(4096).optional(),
  exclude: z.string().max(4096).optional(),
});

export const matchSchema = z.object({
  line: z.number().int().positive(),
  text: z.string(),
  start: z.number().int().nonnegative(),
  end: z.number().int().nonnegative(),
});

export const searchRun = defineRpc({
  name: "search.run",
  input: searchInputSchema.extend({ searchId: z.string().min(1).max(200) }),
  output: z.object({
    files: z.array(z.object({ path: z.string(), matches: z.array(matchSchema) })),
    totalMatches: z.number().int().nonnegative(),
    totalFiles: z.number().int().nonnegative(),
    truncated: z.boolean(),
    index: z.object({ state: indexStateSchema, files: z.number().int().nonnegative(), partial: z.boolean() }),
  }),
});

export const indexStatus = defineRpc({
  name: "index.status",
  input: z.object({ workspaceId: z.string().min(1), leaseId: z.string().min(1).max(200).optional() }),
  output: indexStatusSchema,
});

export const indexRelease = defineRpc({
  name: "index.release",
  input: z.object({ leaseId: z.string().min(1).max(200) }),
  output: z.object({ released: z.literal(true) }),
});

export const indexRebuild = defineRpc({
  name: "index.rebuild",
  input: z.object({ workspaceId: z.string().min(1) }),
  output: indexStatusSchema,
});

const fileInputSchema = z.object({
  workspaceId: z.string().min(1),
  relativePath: z.string().min(1).max(32768),
});

export const fileRead = defineRpc({
  name: "file.read",
  input: fileInputSchema,
  output: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("text"), path: z.string(), content: z.string() }),
    z.object({ kind: z.literal("binary"), path: z.string() }),
    z.object({ kind: z.literal("too-large"), path: z.string(), maxBytes: z.number().int().positive() }),
  ]),
});

export const editorOpen = defineRpc({
  name: "editor.open",
  input: fileInputSchema.extend({
    line: z.number().int().min(1).max(2147483647),
    column: z.number().int().min(1).max(2147483647),
  }),
  output: z.object({ opened: z.literal(true) }),
});

export type SearchInput = z.infer<typeof searchInputSchema>;
export type SearchMatch = z.infer<typeof matchSchema>;
