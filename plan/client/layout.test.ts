// Pure layout helpers only: no React Native import, node environment.
import { describe, expect, it } from "vitest";
import { applyAnswer } from "../shared/graph";
import type { Question, RoadmapData, Ref, Session } from "../shared/model";
import type { Validity } from "../shared/model";
import { questionStatus } from "../shared/status";
import { act, inv, loadBranching, NOW_ISO, pick, q, r, session } from "../server/test-support/build";
import { buildSessionView } from "../server/views";
import { columnsByDepth, compactRows, conflictMessage, edgesBetween, relationLines, staleCauseText } from "./layout";

const data = (sessions: Session[]): RoadmapData => ({
  meta: { version: 2, projectId: "prj_test", createdAt: NOW_ISO, links: [], sessionIds: sessions.map((s) => s.id), planIds: [], featureIds: [], runIds: [], settings: {} },
  sessions,
  plans: [],
  features: [],
  runs: [],
  delegations: [],
});
const viewOf = (sessions: Session[], sessionId: string) => buildSessionView(data(sessions), 1, sessionId);
const qvOf = (view: ReturnType<typeof viewOf>, id: string) => view.questions.find((x) => x.question.id === id)!;
const answerAll = (steps: Array<[Ref, string]>) => steps.reduce((s, [ref, o]) => applyAnswer(s, ref, pick(o)).sessions, loadBranching());
const ids = (cols: Array<Array<{ question: Question }>>) => cols.map((c) => c.map((x) => x.question.id));

describe("layout helpers", () => {
  it("columnsByDepth groups by depth, each column by order", () => {
    expect(ids(columnsByDepth(viewOf(loadBranching(), "s1").questions))).toEqual([["q1"], ["q2", "q3"], ["q4"]]);
  });

  it("compactRows lists each question once, children after parents, indent = depth capped at 4", () => {
    const rows = compactRows(viewOf(loadBranching(), "s1").questions);
    const order = rows.map((x) => x.question.question.id);
    expect([...order].sort()).toEqual(["q1", "q2", "q3", "q4"]);
    expect(order.indexOf("q1")).toBeLessThan(order.indexOf("q2"));
    expect(order.indexOf("q1")).toBeLessThan(order.indexOf("q3"));
    expect(order.indexOf("q3")).toBeLessThan(order.indexOf("q4"));
    expect(Object.fromEntries(rows.map((x) => [x.question.question.id, x.indent]))).toEqual({ q1: 0, q2: 1, q3: 1, q4: 2 });

    const chain = session(
      "c",
      Array.from({ length: 6 }, (_, i) => q(`c${i}`, i === 0 ? {} : { invalidatedBy: [inv(r("c", `c${i - 1}`))] })),
    );
    const chainRows = compactRows(viewOf([chain], "c").questions);
    expect(chainRows.map((x) => [x.question.question.id, x.indent])).toEqual([
      ["c0", 0],
      ["c1", 1],
      ["c2", 2],
      ["c3", 3],
      ["c4", 4],
      ["c5", 4],
    ]);
  });

  it("relationLines names external parents with their session and reports missing refs", () => {
    const sessions = loadBranching();
    const view = viewOf(sessions, "s2");
    expect(relationLines(qvOf(view, "x1"), view)).toEqual([
      { kind: "activation", text: "Active when Synthetic branching session / Branch B follow-up = Yes", external: true },
      { kind: "invalidation", text: "Invalidated by Synthetic branching session / Root choice", external: true },
    ]);

    const dangling = structuredClone(qvOf(view, "x1"));
    dangling.question.activatedBy = [act(r("s1", "q99"), "yes")];
    const lines = relationLines(dangling, view);
    expect(lines.find((l) => l.kind === "activation")?.text).toContain("<missing question>");
  });

  it("edgesBetween(view, 0) holds the labelled activation and invalidation edges into depth 1", () => {
    const edges = edgesBetween(viewOf(loadBranching(), "s1"), 0);
    const key = (e: { to: Ref }) => e.to.questionId;
    expect([...edges].sort((a, b) => key(a).localeCompare(key(b)))).toEqual([
      { from: r("s1", "q1"), to: r("s1", "q2"), kind: "activation", label: "Option B" },
      { from: r("s1", "q1"), to: r("s1", "q3"), kind: "invalidation", label: "invalidates" },
    ]);
  });

  it("staleCauseText names the cause question and rev; null when not stale", () => {
    const sessions = answerAll([[r("s1", "q1"), "a"], [r("s1", "q3"), "c"], [r("s1", "q1"), "b"]]);
    const view = viewOf(sessions, "s1");
    expect(staleCauseText(qvOf(view, "q3"), view)).toBe("Stale: Root choice changed (rev 2)");
    expect(staleCauseText(qvOf(view, "q1"), view)).toBeNull();
  });

  it("conflictMessage maps the listed codes and falls back to the message", () => {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- deliberately raw error codes, including unknown ones, to test the fallback
    const m = (code: string) => conflictMessage({ code, message: `raw ${code}` } as never);
    expect(m("revision_conflict")).toBe("Changed elsewhere; reloaded. Review and retry.");
    expect(m("relation_cycle")).toBe("That relation would create a cycle.");
    expect(m("unresolved_ref")).toBe("Referenced question no longer exists.");
    expect(m("question_inactive")).toBe("Question is inactive.");
    expect(m("store_invalid")).toBe("raw store_invalid");
  });

  it("questionStatus: inactive wins, otherwise validity maps to a status", () => {
    const expected: Record<Validity, string> = { unanswered: "open", valid: "answered", stale: "stale", skipped: "skipped", out_of_scope: "out_of_scope" };
    for (const validity of Object.keys(expected).filter((k): k is Validity => Object.hasOwn(expected, k))) {
      expect(questionStatus("inactive", validity)).toBe("inactive");
      expect(questionStatus("active", validity)).toBe(expected[validity]);
    }
  });

  it("does not import React Native", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("./layout.ts", import.meta.url), "utf8");
    expect(src).not.toMatch(/from\s+["'](react-native|react|@getpaseo\/plugin\/client[^"']*)["']/);
  });
});
