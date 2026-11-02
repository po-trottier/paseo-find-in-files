import { z } from "zod";

export const indexStateSchema = z.enum(["idle", "manual", "building", "ready", "stale", "error"]);
export const indexStatusSchema = z.object({
  state: indexStateSchema,
  filesIndexed: z.number().int().nonnegative(),
  filesSkipped: z.number().int().nonnegative(),
  startedAt: z.number().nullable(),
  finishedAt: z.number().nullable(),
  durationMs: z.number().nonnegative(),
  partial: z.boolean(),
  error: z.string().optional(),
});
export type IndexState = z.infer<typeof indexStateSchema>;
export type IndexStatus = z.infer<typeof indexStatusSchema>;
