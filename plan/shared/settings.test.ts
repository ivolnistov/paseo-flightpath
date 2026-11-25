// Tracker settings v2 (Stage 4 P4.6, O3): version, defaults and the v1 → v2 migration.
import { describe, expect, it } from "vitest";
import { roadmapSettings, trackerSettings, type RoadmapSettings } from "./settings";

describe("trackerSettings v2", () => {
  it("is version 2 and defaults closeByProject to {}", () => {
    expect(trackerSettings.version).toBe(2);
    expect(trackerSettings.schema.parse({})).toEqual({ provider: "none", mode: "dry-run", closeByProject: {} });
  });

  it("migrates v1 values by adding closeByProject: {} and keeps every v1 field", async () => {
    const v1 = { provider: "snailorbit", mode: "live", projectKey: "SYN" };
    const migrated = await trackerSettings.migrate!(v1, 1);
    expect(migrated).toEqual({ ...v1, closeByProject: {} });
    expect(trackerSettings.schema.parse(migrated)).toEqual({ ...v1, closeByProject: {} });
  });

  it("validates closeByProject keys and entries strictly", () => {
    const base = { provider: "snailorbit", mode: "live", projectKey: "SYN" };
    expect(trackerSettings.schema.safeParse({ ...base, closeByProject: { SYN: { field: "State", value: "Done" } } }).success).toBe(true);
    expect(trackerSettings.schema.safeParse({ ...base, closeByProject: { "bad key": { field: "State", value: "Done" } } }).success).toBe(false);
    expect(trackerSettings.schema.safeParse({ ...base, closeByProject: { SYN: { field: "", value: "Done" } } }).success).toBe(false);
    expect(trackerSettings.schema.safeParse({ ...base, closeByProject: { SYN: { field: "State", value: "Done", extra: 1 } } }).success).toBe(false);
  });
});

// Roadmap host settings (redesign Stage R0.3, task card §4). Only the card's defaults and value
// types are asserted; bounds of the timeout and buffer values and unknown-key handling are not
// specified and are left open.
// Discussion settings raise the definition to version 2; every v1 field and default is unchanged.
describe("roadmapSettings v2 base fields", () => {
  const DEFAULTS = { repairCeiling: 30, checkTimeoutMs: 600000, reviewTimeoutMs: 1800000, maxBuffer: 10485760, discussionLanguages: [] };
  const ok = (values: unknown) => roadmapSettings.schema.safeParse(values).success;

  it("is the host-scoped `roadmap` definition at version 2", () => {
    expect(roadmapSettings.id).toBe("roadmap");
    expect(roadmapSettings.scope).toBe("host");
    expect(roadmapSettings.version).toBe(2);
    expect(roadmapSettings.id).not.toBe(trackerSettings.id);
  });

  it("defaults the runner bounds and the repair ceiling, and leaves optional fields absent", () => {
    const parsed: RoadmapSettings = roadmapSettings.schema.parse({});
    expect(parsed).toEqual(DEFAULTS);
    for (const key of ["dodTemplate", "reviewCommand", "baseRef"]) expect(parsed).not.toHaveProperty(key);
  });

  it("keeps every provided value", () => {
    const values = {
      dodTemplate: "- [check] npm test\nGlobal criterion",
      repairCeiling: 5,
      reviewCommand: "review-wrapper --json",
      checkTimeoutMs: 1000,
      reviewTimeoutMs: 2000,
      maxBuffer: 4096,
      baseRef: "main",
      discussionLanguages: ["Deutsch"],
    };
    expect(roadmapSettings.schema.parse(values)).toEqual(values);
    expect(roadmapSettings.schema.parse({ repairCeiling: 1 })).toEqual({ ...DEFAULTS, repairCeiling: 1 });
    expect(roadmapSettings.schema.parse({ dodTemplate: "" })).toEqual({ ...DEFAULTS, dodTemplate: "" });
  });

  it("requires repairCeiling to be an integer of at least 1", () => {
    for (const repairCeiling of [0, -1, 1.5, "30", null, Number.NaN]) {
      expect(ok({ repairCeiling }), String(repairCeiling)).toBe(false);
    }
    expect(ok({ repairCeiling: 1 })).toBe(true);
    expect(ok({ repairCeiling: 1000 })).toBe(true);
  });

  it("rejects wrongly typed values without coercion", () => {
    expect(ok({ checkTimeoutMs: "600000" })).toBe(false);
    expect(ok({ reviewTimeoutMs: "1800000" })).toBe(false);
    expect(ok({ maxBuffer: "10485760" })).toBe(false);
    expect(ok({ dodTemplate: 1 })).toBe(false);
    expect(ok({ reviewCommand: ["review"] })).toBe(false);
    expect(ok({ baseRef: false })).toBe(false);
  });
});

// Stage R3.4 (task card 2026-10-29 R3 §5.1): roadmap.coordinatorProfile is an optional string read by
// delegated starts; absent by default, so existing settings still parse.
describe("R3.4 roadmap.coordinatorProfile", () => {
  it("is optional (absent by default) and keeps a given profile id", () => {
    const defaults = roadmapSettings.schema.parse({});
    expect("coordinatorProfile" in defaults && defaults.coordinatorProfile !== undefined).toBe(false);
    const withProfile: RoadmapSettings = roadmapSettings.schema.parse({ coordinatorProfile: "team-coordinator" });
    expect(withProfile.coordinatorProfile).toBe("team-coordinator");
    expect(withProfile.repairCeiling, "control: existing defaults unchanged").toBe(30);
    expect(roadmapSettings.schema.safeParse({ coordinatorProfile: 7 }).success).toBe(false);
  });
});

// Discussion settings: the saved profile one-click Discuss uses, and a reserved translation profile.
describe("roadmapSettings discussion profiles", () => {
  it("accepts a discussion profile and a translation profile, both absent by default and never empty", () => {
    const values = { discussionProfile: "team-research", translationProfile: "translator" };
    expect(roadmapSettings.schema.parse(values)).toMatchObject(values);
    const parsed = roadmapSettings.schema.parse({});
    expect(parsed).not.toHaveProperty("discussionProfile");
    expect(parsed).not.toHaveProperty("translationProfile");
    expect(roadmapSettings.schema.safeParse({ discussionProfile: "" }).success).toBe(false);
    expect(roadmapSettings.schema.safeParse({ translationProfile: "" }).success).toBe(false);
    expect(roadmapSettings.schema.safeParse({ discussionProfile: 1 }).success).toBe(false);
  });

  it("migrates stored v1 values unchanged", async () => {
    const v1 = { dodTemplate: "- [check] npm test", repairCeiling: 5, reviewCommand: "review", baseRef: "main", coordinatorProfile: "team-coordinator" };
    expect(typeof roadmapSettings.migrate).toBe("function");
    const migrated = await roadmapSettings.migrate!(v1, 1);
    expect(migrated).toEqual(v1);
    expect(roadmapSettings.schema.parse(migrated)).toMatchObject(v1);
  });
});

// Discussion languages (owner choice, 2026-11-08): English is always offered and is the default;
// settings list only the additional languages, none by default; stored earlier values keep reading.
describe("roadmapSettings discussion languages", () => {
  it("lists no additional language by default and keeps configured ones", () => {
    expect(roadmapSettings.schema.parse({})).toMatchObject({ discussionLanguages: [] });
    expect(roadmapSettings.schema.parse({ discussionLanguages: ["Русский", "Deutsch"] })).toMatchObject({ discussionLanguages: ["Русский", "Deutsch"] });
  });

  it("stored version 2 values carry over with no additional language", async () => {
    const v2 = { repairCeiling: 7, discussionProfile: "team-research", translationProfile: "translator" };
    const migrated = await roadmapSettings.migrate!(v2, 2);
    expect(roadmapSettings.schema.parse(migrated)).toMatchObject({ ...v2, discussionLanguages: [] });
  });
});

// Review regression (KensAI c0025): the offered list Discuss validates against. English is always first
// and never repeated from settings; labels are trimmed, empty and repeated ones dropped, order kept.
describe("discussion language choices", () => {
  it("offers English first, then the configured labels trimmed, without English, empties or repeats", async () => {
    const mod: unknown = await import("./settings");
    const pick = (name: string): unknown => (typeof mod === "object" && mod !== null ? Object.entries(mod).find(([k]) => k === name)?.[1] : undefined);
    const choices = pick("discussionLanguageChoices");
    const english = pick("isEnglishLabel");
    if (typeof choices !== "function" || typeof english !== "function") throw new Error("missing export: settings.discussionLanguageChoices / isEnglishLabel");
    expect(Reflect.apply(choices, undefined, [[" Русский ", "english", "EN", "", "Русский", "Deutsch"]])).toEqual(["English", "Русский", "Deutsch"]);
    expect(Reflect.apply(choices, undefined, [[]])).toEqual(["English"]);
    for (const v of ["en", " English ", "EN"]) expect(Reflect.apply(english, undefined, [v]), v).toBe(true);
    for (const v of ["Englisch", "eng", "Русский"]) expect(Reflect.apply(english, undefined, [v]), v).toBe(false);
  });
});
