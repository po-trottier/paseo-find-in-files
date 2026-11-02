import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

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
  }),
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
export type SearchEvent =
  | { type: "matches"; path: string; matches: SearchMatch[] }
  | { type: "done"; totalMatches: number; totalFiles: number; truncated: boolean }
  | { type: "error"; message: string };
export type SearchMatch = z.infer<typeof matchSchema>;
