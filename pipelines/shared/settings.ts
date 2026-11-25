import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const DEFAULT_CHECK_TIMEOUT_MS = 600_000;
export const DEFAULT_MAX_OUTPUT_BYTES = 1_048_576;
export const DEFAULT_QUIESCE_TIMEOUT_MS = 30_000;

/** Host-scoped settings. `dataDir` replaces the default plugin data directory and must be absolute. */
export const pipelineSettings = defineSettings({
  id: "pipeline",
  scope: "host",
  version: 1,
  schema: z
    .object({
      dataDir: z.string().min(1).refine((value) => value.startsWith("/"), "dataDir must be an absolute path").optional(),
      checkTimeoutMs: z.number().int().positive().default(DEFAULT_CHECK_TIMEOUT_MS),
      maxOutputBytes: z.number().int().positive().default(DEFAULT_MAX_OUTPUT_BYTES),
      quiesceTimeoutMs: z.number().int().positive().default(DEFAULT_QUIESCE_TIMEOUT_MS),
    })
    .strict(),
});

export type PipelineSettings = z.output<typeof pipelineSettings.schema>;
