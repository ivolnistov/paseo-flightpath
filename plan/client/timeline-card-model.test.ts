// Timeline card model (Stage 5 T5.3): pure view → card state, sharing the panel's helpers.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { applyAnswer } from "../shared/graph";
import type { Ref, RoadmapData, Session } from "../shared/model";
import { loadBranching, NOW_ISO, pick, r } from "../server/test-support/build";
import { buildSessionView } from "../server/views";
import { relationLines, staleCauseText } from "./layout";
import { cardModel } from "./timeline-card-model";

const data = (sessions: Session[]): RoadmapData => ({
  meta: { version: 2, projectId: "prj_test", createdAt: NOW_ISO, links: [], sessionIds: sessions.map((s) => s.id), planIds: [], featureIds: [], runIds: [], settings: {} },
  sessions,
  plans: [],
  features: [],
  runs: [],
  delegations: [],
});
const viewOf = (sessions: Session[], sessionId: string) => buildSessionView(data(sessions), 1, sessionId);
const qvOf = (view: ReturnType<typeof viewOf>, id: string) => {
  const qv = view.questions.find((x) => x.question.id === id);
  if (!qv) throw new Error(`fixture lacks ${id}`);
  return qv;
};
const answerAll = (steps: Array<[Ref, string]>) => steps.reduce((s, [ref, o]) => applyAnswer(s, ref, pick(o)).sessions, loadBranching());
const questionModel = (view: ReturnType<typeof viewOf>, id: string) => {
  const model = cardModel(view, id);
  if (model.kind !== "question") throw new Error(`expected a question model for ${id}, got ${model.kind}`);
  return model;
};

describe("cardModel (T5.3)", () => {
  it("a null view or an unknown question is missing", () => {
    expect(cardModel(null, "q1")).toEqual({ kind: "missing" });
    expect(cardModel(viewOf(loadBranching(), "s1"), "q99")).toEqual({ kind: "missing" });
  });

  it("an inactive question cannot be answered; an active one can", () => {
    const view = viewOf(loadBranching(), "s1");
    expect(qvOf(view, "q2").visibility).toBe("inactive"); // fixture: q2 active only when q1 = b
    const inactive = questionModel(view, "q2");
    expect(inactive.canAnswer).toBe(false);
    expect(inactive.question).toEqual(qvOf(view, "q2"));
    expect(qvOf(view, "q1").visibility).toBe("active");
    expect(questionModel(view, "q1").canAnswer).toBe(true);
  });

  it("a stale question carries the panel's stale text and stays answerable while active", () => {
    const view = viewOf(answerAll([[r("s1", "q1"), "a"], [r("s1", "q3"), "c"], [r("s1", "q1"), "b"]]), "s1");
    const stale = questionModel(view, "q3");
    expect(stale.staleText).toBe(staleCauseText(qvOf(view, "q3"), view));
    expect(stale.staleText).toBe("Stale: Root choice changed (rev 2)");
    expect(stale.canAnswer).toBe(true);
    expect(questionModel(view, "q1").staleText).toBeNull();
  });

  it("relation lines equal the panel helper output, including external parents", () => {
    const s1 = viewOf(loadBranching(), "s1");
    expect(questionModel(s1, "q3").relationLines).toEqual(relationLines(qvOf(s1, "q3"), s1));
    const s2 = viewOf(loadBranching(), "s2");
    const external = relationLines(qvOf(s2, "x1"), s2);
    expect(external.length).toBeGreaterThan(0);
    expect(questionModel(s2, "x1").relationLines).toEqual(external);
  });

  it("does not import React, React Native or the plugin client", () => {
    const src = readFileSync(new URL("./timeline-card-model.ts", import.meta.url), "utf8");
    expect(src).not.toMatch(/from\s+["'](react-native|react|@getpaseo\/plugin\/client[^"']*)["']/);
  });
});
