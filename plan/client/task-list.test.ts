// Stage R4.2 (task card 2026-10-29 R4 §3): `taskRows({ revision, run })` maps the bound plan's v2
// revision and the latest run.get into list rows with truthful labels: `failedCycles` are failed
// verification cycles (TaskRun.failedCycles, never reset, never "attempts"), `extraBudget` the granted
// extra cycles, `atCeiling` exactly `state === "ceiling"`, `ready` exactly from run.get.ready.
// The module is new in R4.2, so it is loaded through a non-literal specifier inside each test.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

type Row = { taskId: string; title: string; state: string; dependsOn: string[]; parallel: boolean; failedCycles: number; extraBudget: number; atCeiling: boolean; unresolvedCount: number; agentId?: string; ready: boolean };
const modulePath = "./task-list";
const load = async () => {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- non-literal import keeps the RN client graph out of tsconfig.node
  const mod = (await import(/* @vite-ignore */ modulePath)) as Record<string, unknown>;
  expect(typeof mod.taskRows, "client/task-list exports taskRows").toBe("function");
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- non-literal import keeps the RN client graph out of tsconfig.node
  return mod.taskRows as (x: { revision: unknown; run: unknown }) => Row[];
};
const AT = "2026-10-29T10:00:00.000Z";
const task = (id: string, over: Record<string, unknown> = {}) => ({ id, title: `Task ${id}`, description: "", dependsOn: [], parallel: false, completion: "auto", grill: false, dod: "x", ...over });
const REVISION = {
  rev: 2, schema: 2, createdAt: AT, markdown: "# R", contentHash: "a".repeat(64), sessionIds: ["s1"],
  tasks: [task("t1"), task("t2", { dependsOn: ["t1"], parallel: true }), task("t3", { dependsOn: ["t1"] }), task("t4")],
};
const RUN = {
  revision: 9,
  run: {
    id: "run-1", featureId: "f-1", planId: "plan-1", planRev: 2, runToken: "tok-1", state: "running", startAuth: { kind: "ui", at: AT },
    tasks: [
      { taskId: "t1", state: "ceiling", agentId: "agent-w", failedCycles: 3, extraBudget: 2, unresolved: ["checks failed", "review failed"] },
      { taskId: "t2", state: "todo", failedCycles: 0, extraBudget: 0, unresolved: [] },
      { taskId: "t3", state: "in_progress", agentId: "agent-x", failedCycles: 1, extraBudget: 0, unresolved: [] },
    ],
    acks: [], events: [], lateEvidence: [],
  },
  ready: ["t2"],
  blocked: [{ code: "dependency_not_verified", taskId: "t3" }],
};

describe("R4.2 taskRows", () => {
  it("one row per revision task in order, with the run's state, failed cycles, budget, ceiling, unresolved count, agent and exact readiness", async () => {
    const taskRows = await load();
    const rows = taskRows({ revision: REVISION, run: RUN });
    expect(rows.map((r) => r.taskId)).toEqual(["t1", "t2", "t3", "t4"]);
    expect(rows[0]).toMatchObject({ taskId: "t1", title: "Task t1", state: "ceiling", failedCycles: 3, extraBudget: 2, atCeiling: true, unresolvedCount: 2, agentId: "agent-w", ready: false });
    expect(rows[1]).toMatchObject({ taskId: "t2", state: "todo", dependsOn: ["t1"], parallel: true, atCeiling: false, ready: true });
    expect(rows[2]).toMatchObject({ taskId: "t3", state: "in_progress", failedCycles: 1, agentId: "agent-x", ready: false, dependsOn: ["t1"], parallel: false });
    expect(rows[3], "a revision task the run does not list is todo").toMatchObject({ taskId: "t4", state: "todo", failedCycles: 0, extraBudget: 0, atCeiling: false, unresolvedCount: 0, ready: false });
    expect(rows.filter((r) => r.ready).map((r) => r.taskId), "ready is exactly run.get.ready").toEqual(["t2"]);
  });

  it("without a run every task is todo, not ready, with zero failed cycles and no agent", async () => {
    const taskRows = await load();
    const rows = taskRows({ revision: REVISION, run: null });
    expect(rows.map((r) => [r.taskId, r.state, r.ready, r.failedCycles, r.extraBudget, r.atCeiling, r.agentId])).toEqual([
      ["t1", "todo", false, 0, 0, false, undefined],
      ["t2", "todo", false, 0, 0, false, undefined],
      ["t3", "todo", false, 0, 0, false, undefined],
      ["t4", "todo", false, 0, 0, false, undefined],
    ]);
  });

  it("truthful labels: the task list never calls failed verification cycles attempts", () => {
    let src = "";
    try {
      // R4 successor KensAI c0049: the label is rendered by feature-screen.tsx (task-list.tsx renders none).
      src = readFileSync(new URL("./feature-screen.tsx", import.meta.url), "utf8");
    } catch {
      src = "";
    }
    expect(src.length, "client/feature-screen.tsx exists").toBeGreaterThan(0);
    expect(src, "the rendered label names failed verification cycles").toMatch(/Failed verification cycles/);
    expect(src).not.toMatch(/attempt/i);
  });
});
