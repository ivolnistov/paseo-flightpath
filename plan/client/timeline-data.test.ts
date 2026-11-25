// Decision timeline row data (Stage 5 T5.2): ref-only, strict, registered kind and version.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ROW_KIND, ROW_VERSION, RowData } from "./timeline-data";

const valid = { projectId: "prj_synthetic", sessionId: "s1", questionId: "q1" };

describe("timeline row data (T5.2)", () => {
  it("registers kind decision-question at schema version 1", () => {
    expect(ROW_KIND).toBe("decision-question");
    expect(ROW_VERSION).toBe(1);
  });

  it("parses ref-only data to exactly projectId, sessionId and questionId", () => {
    expect(RowData.parse(valid)).toEqual(valid);
    expect(Object.keys(RowData.parse(valid)).sort()).toEqual(["projectId", "questionId", "sessionId"]);
  });

  it("rejects extra keys, so a row can never carry question text or an answer", () => {
    const extras: Record<string, unknown> = {
      title: "Which database?",
      text: "free text",
      answer: { optionId: "a" },
      options: [{ id: "a", label: "A" }],
      version: 2,
    };
    for (const [key, value] of Object.entries(extras)) {
      expect(RowData.safeParse({ ...valid, [key]: value }).success, `extra key ${key}`).toBe(false);
    }
  });

  it("rejects empty, non-string, null and missing ids in every field", () => {
    for (const field of ["projectId", "sessionId", "questionId"] as const) {
      for (const bad of ["", 1, null]) {
        expect(RowData.safeParse({ ...valid, [field]: bad }).success, `${field} = ${JSON.stringify(bad)}`).toBe(false);
      }
      const { [field]: _omitted, ...missing } = valid;
      expect(RowData.safeParse(missing).success, `${field} missing`).toBe(false);
    }
  });

  it("does not import React, React Native or the plugin client", () => {
    const src = readFileSync(new URL("./timeline-data.ts", import.meta.url), "utf8");
    expect(src).not.toMatch(/from\s+["'](react-native|react|@getpaseo\/plugin\/client[^"']*)["']/);
  });
});

// The decision-references row: a registered kind and version, and reference-only data.
describe("decision-references row data", () => {
  const load = async () => {
    const mod: unknown = await import("./timeline-data");
    const pick = (name: string): unknown => (typeof mod === "object" && mod !== null ? Object.entries(mod).find(([k]) => k === name)?.[1] : undefined);
    const schema = pick("RefRowData");
    if (!(typeof schema === "object" && schema !== null && "safeParse" in schema && typeof schema.safeParse === "function")) throw new Error("missing export: timeline-data.RefRowData");
    const safeParse = schema.safeParse;
    const parses = (v: unknown): boolean => {
      const out: unknown = Reflect.apply(safeParse, schema, [v]);
      return typeof out === "object" && out !== null && "success" in out && out.success === true;
    };
    return { kind: pick("REF_ROW_KIND"), version: pick("REF_ROW_VERSION"), parses };
  };
  const ref = { link: "roadmap://prj_test/s/s1/q/2/answer", sessionId: "s1", number: 2, kind: "answer" };
  const data = { projectId: "prj_test", turnId: "turn-1", refs: [ref] };

  it("registers kind decision-references at version 1", async () => {
    const m = await load();
    expect(m.kind).toBe("decision-references");
    expect(m.version).toBe(1);
  });

  it("accepts references only and rejects any other field", async () => {
    const m = await load();
    expect(m.parses(data)).toBe(true);
    expect(m.parses({ ...data, text: "the agent's message" })).toBe(false);
    expect(m.parses({ ...data, refs: [{ ...ref, title: "Question title" }] })).toBe(false);
    expect(m.parses({ ...data, refs: [{ ...ref, kind: "history" }] })).toBe(false);
  });
});
