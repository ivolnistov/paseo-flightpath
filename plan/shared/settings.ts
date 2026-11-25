// Host-scoped plugin settings. Tracker defaults keep the tracker off: provider "none", mode "dry-run", no close config.
import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";
import { isRecord } from "./canonical";

export const trackerSettings = defineSettings({
  id: "tracker",
  scope: "host",
  version: 2,
  schema: z.object({
    provider: z.enum(["none", "snailorbit"]).default("none"),
    mode: z.enum(["dry-run", "live"]).default("dry-run"),
    projectKey: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).optional(),
    // Per destination project: the field and final value that close an issue (O3).
    closeByProject: z
      .record(
        z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
        z.object({ field: z.string().min(1).max(200), value: z.string().min(1).max(200) }).strict(),
      )
      .default({}),
  }),
  migrate: (values, fromVersion) => (fromVersion === 1 ? { ...(isRecord(values) ? values : {}), closeByProject: {} } : values),
});
export type TrackerSettings = z.output<typeof trackerSettings.schema>;

export const DISCUSSION_LANGUAGE_MAX = 40;
export const DISCUSSION_LANGUAGES_MAX = 10;
export const ENGLISH = "English";

/** "en" or "English" in any case: the default discussion language, never stored as an additional one. */
export const isEnglishLabel = (value: string): boolean => ["en", "english"].includes(value.trim().toLowerCase());

/** The languages Discuss offers: English first, then the configured ones without English or repeats. */
export function discussionLanguageChoices(configured: readonly string[]): string[] {
  const out = [ENGLISH];
  for (const raw of configured) {
    const label = raw.trim();
    if (label !== "" && !isEnglishLabel(label) && !out.includes(label)) out.push(label);
  }
  return out;
}

// Host-scoped roadmap settings. The timeouts and buffer are runner bounds, not spend policy;
// `dodTemplate` is the global DoD template, the last source after `dod template.md` and project text.
export const roadmapSettings = defineSettings({
  id: "roadmap",
  scope: "host",
  version: 2,
  schema: z.object({
    dodTemplate: z.string().optional(),
    repairCeiling: z.number().int().min(1).default(30),
    reviewCommand: z.string().optional(),
    checkTimeoutMs: z.number().int().positive().default(600_000),
    reviewTimeoutMs: z.number().int().positive().default(1_800_000),
    maxBuffer: z.number().int().positive().default(10 * 1024 * 1024),
    baseRef: z.string().optional(),
    /** Saved agent profile id used for delegated starts that need a new coordinator (deployment setting). */
    coordinatorProfile: z.string().min(1).optional(),
    /** Saved agent profile id one-click Discuss creates the discussion chat with. */
    discussionProfile: z.string().min(1).optional(),
    /** Reserved: a saved profile id for translation. Stored only; no translation is performed. */
    translationProfile: z.string().min(1).optional(),
    /**
     * Discussion languages offered besides English, as the owner labels them. English is always
     * offered and is the default; Discuss shows a language choice only when this list is not empty.
     */
    discussionLanguages: z.array(z.string().min(1).max(DISCUSSION_LANGUAGE_MAX)).max(DISCUSSION_LANGUAGES_MAX).default([]),
  }),
  // Version 2 only adds optional or defaulted keys: stored v1 and v2 values carry over unchanged.
  migrate: (values) => values,
});
export type RoadmapSettings = z.output<typeof roadmapSettings.schema>;
