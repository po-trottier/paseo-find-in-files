import { defineAttachmentSource, defineRpc, PluginAttachmentSearchPayloadSchema } from "@getpaseo/plugin";
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
  /** A window of the line. `textStart` is its offset in the line. `start` and `end` are offsets in the full line. */
  text: z.string(),
  textStart: z.number().int().nonnegative(),
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
    /** `version` is a hash of the file bytes. `file.write` uses it to detect changes on disk. */
    z.object({ kind: z.literal("text"), path: z.string(), content: z.string(), version: z.string() }),
    z.object({ kind: z.literal("binary"), path: z.string() }),
    z.object({ kind: z.literal("too-large"), path: z.string(), maxBytes: z.number().int().positive() }),
  ]),
});

export const fileWrite = defineRpc({
  name: "file.write",
  input: fileInputSchema.extend({
    content: z.string().max(1024 * 1024),
    baseVersion: z.string().min(1).max(200),
    force: z.boolean().optional(),
  }),
  output: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("saved"), version: z.string() }),
    z.object({ kind: z.literal("conflict") }),
  ]),
});

export const workspaceLocate = defineRpc({
  name: "workspace.locate",
  input: z.object({ workspaceId: z.string().min(1) }),
  output: z.object({ workspacePath: z.string(), projectId: z.string().nullable() }),
});

export const snippetAdd = defineRpc({
  name: "snippet.add",
  input: fileInputSchema.extend({
    startLine: z.number().int().min(1),
    endLine: z.number().int().min(1),
    text: z.string().max(256 * 1024),
  }),
  output: z.object({ id: z.string() }),
});

export const snippetSearch = defineRpc({
  name: "snippet.search",
  input: z.object({ query: z.string() }),
  output: PluginAttachmentSearchPayloadSchema,
});

export const snippetSource = defineAttachmentSource({
  id: "selection",
  title: "Find in Files selection",
  icon: "FileSearch",
  pickerTitle: "Attach a preview selection",
  searchPlaceholder: "Filter by path or text",
  search: snippetSearch,
});

/** The text that "Add to context" and "Copy" produce for lines of a file. */
export function formatSnippet(relativePath: string, startLine: number, endLine: number, text: string): string {
  const lines = startLine === endLine ? `line ${startLine}` : `lines ${startLine}-${endLine}`;
  const language = /\.([A-Za-z0-9]+)$/.exec(relativePath)?.[1]?.toLowerCase() ?? "";
  const longestRun = Math.max(2, ...Array.from(text.matchAll(/`+/g), (match) => match[0].length));
  const fence = "`".repeat(longestRun + 1);
  return `${relativePath} ${lines}:\n${fence}${language}\n${text}\n${fence}`;
}

export type SearchInput = z.infer<typeof searchInputSchema>;
export type SearchMatch = z.infer<typeof matchSchema>;
