// Stage R4.2 (task card 2026-10-29 R4 §3): the pure `runControls` model over design §3.6 and the
// accepted R3 contracts. Truth sources (root ruling): approval currency and the receipt come from
// plan.get (`approvalCurrent`, `approvedLatest`); readiness, acknowledgements and the run token come
// from the latest run.get (`run`). No control interrupts or cancels an agent. The module is new in
// R4.2, so it is loaded through a non-literal specifier inside each test.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

type Control = { control: string; enabled: boolean; reason?: string; taskId?: string };
type Model = (x: { feature: unknown; run: unknown; approvalCurrent: boolean; approvedLatest: boolean }) => Control[];
const modulePath = "./run-controls";
const load = async (): Promise<Model> => {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- non-literal import keeps the RN client graph out of tsconfig.node
  const mod = (await import(/* @vite-ignore */ modulePath)) as Record<string, unknown>;
  expect(typeof mod.runControls, "client/run-controls exports runControls").toBe("function");
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- non-literal import keeps the RN client graph out of tsconfig.node
  return mod.runControls as Model;
};

const AT = "2026-10-29T10:00:00.000Z";
const COORD = { agentId: "agent-c", workspaceId: "ws-1", boundAt: AT, profileRef: "team-coordinator" };
const feature = (status: string, bound = true) => ({
  id: "f-1", title: "Search", description: "", kind: "feature", status, dependsOn: [], relatedTo: [], everStarted: status === "executing",
  createdAt: AT, createdBy: { kind: "human" }, coordinatorHistory: [], events: [], ...(bound ? { coordinator: COORD } : {}),
});
type TaskState = "todo" | "claimed" | "in_progress" | "checks_pending" | "review_pending" | "awaiting_acceptance" | "verified" | "ceiling";
const runView = (state: "running" | "paused", opts: { tasks?: Array<[string, TaskState]>; unresolved?: string[] } = {}) => ({
  revision: 9,
  run: {
    id: "run-1", featureId: "f-1", planId: "plan-1", planRev: 2, runToken: "tok-latest", state,
    ...(state === "paused" ? { pauseReason: "owner", pausedAt: AT } : {}),
    startAuth: { kind: "ui", at: AT },
    tasks: (opts.tasks ?? [["t1", "in_progress"]]).map(([taskId, s]) => ({ taskId, state: s, agentId: "agent-w", failedCycles: s === "ceiling" ? 3 : 0, extraBudget: 0, unresolved: [] })),
    acks: [], events: [], lateEvidence: [],
  },
  ready: [],
  blocked: [],
  ...(opts.unresolved ? { unresolved: opts.unresolved } : {}),
});
const get = (cs: Control[], control: string, taskId?: string) => cs.filter((c) => c.control === control && (taskId === undefined || c.taskId === taskId));
const on = (cs: Control[], control: string, taskId?: string) => get(cs, control, taskId).some((c) => c.enabled);
const reasonOf = (cs: Control[], control: string) => get(cs, control).find((c) => !c.enabled)?.reason ?? "";

describe("R4.2 runControls: start", () => {
  it("is enabled only for a planned or executing feature with a current approval and no live run", async () => {
    const runControls = await load();
    expect(on(runControls({ feature: feature("planned"), run: null, approvalCurrent: true, approvedLatest: true }), "start")).toBe(true);
    expect(on(runControls({ feature: feature("executing"), run: null, approvalCurrent: true, approvedLatest: true }), "start")).toBe(true);
    expect(on(runControls({ feature: feature("planned", false), run: null, approvalCurrent: true, approvedLatest: true }), "start"), "unbound: start with a profile").toBe(true);
    expect(on(runControls({ feature: feature("planned"), run: null, approvalCurrent: false, approvedLatest: true }), "start"), "no current approval").toBe(false);
    for (const status of ["created", "done", "deferred", "cancelled"]) {
      expect(on(runControls({ feature: feature(status), run: null, approvalCurrent: true, approvedLatest: true }), "start"), status).toBe(false);
    }
    expect(on(runControls({ feature: feature("executing"), run: runView("running"), approvalCurrent: true, approvedLatest: true }), "start"), "a live run").toBe(false);
  });
});

describe("R4.2 runControls: pause, resume and stop-and-rework", () => {
  it("pause only while running, resume only while paused", async () => {
    const runControls = await load();
    const running = runControls({ feature: feature("executing"), run: runView("running"), approvalCurrent: true, approvedLatest: true });
    expect([on(running, "pause"), on(running, "resume")]).toEqual([true, false]);
    const paused = runControls({ feature: feature("executing"), run: runView("paused"), approvalCurrent: true, approvedLatest: true });
    expect([on(paused, "pause"), on(paused, "resume")]).toEqual([false, true]);
    const none = runControls({ feature: feature("planned"), run: null, approvalCurrent: true, approvedLatest: true });
    expect([on(none, "pause"), on(none, "resume")]).toEqual([false, false]);
  });

  it("stop and rework needs approvedLatest and a planned or executing feature (with or without a live run)", async () => {
    const runControls = await load();
    expect(on(runControls({ feature: feature("executing"), run: runView("running"), approvalCurrent: true, approvedLatest: true }), "stopAndRework")).toBe(true);
    expect(on(runControls({ feature: feature("planned"), run: null, approvalCurrent: true, approvedLatest: true }), "stopAndRework")).toBe(true);
    expect(on(runControls({ feature: feature("executing"), run: runView("running"), approvalCurrent: true, approvedLatest: false }), "stopAndRework")).toBe(false);
    expect(on(runControls({ feature: feature("done"), run: null, approvalCurrent: true, approvedLatest: true }), "stopAndRework")).toBe(false);
  });
});

describe("R4.2 runControls: replace coordinator", () => {
  it("bound with no live run → enabled; running → 'pause the run first'; paused with awaiting acks → 'waiting for acknowledgements'; paused and acknowledged → enabled; unbound → never enabled", async () => {
    const runControls = await load();
    expect(on(runControls({ feature: feature("planned"), run: null, approvalCurrent: true, approvedLatest: true }), "replaceCoordinator"), "no live run").toBe(true);
    const running = runControls({ feature: feature("executing"), run: runView("running"), approvalCurrent: true, approvedLatest: true });
    expect(on(running, "replaceCoordinator")).toBe(false);
    expect(reasonOf(running, "replaceCoordinator")).toMatch(/pause the run first/i);
    const waiting = runControls({ feature: feature("executing"), run: runView("paused", { unresolved: ["awaiting ack: t1 (agent-w)"] }), approvalCurrent: true, approvedLatest: true });
    expect(on(waiting, "replaceCoordinator")).toBe(false);
    expect(reasonOf(waiting, "replaceCoordinator")).toMatch(/waiting for acknowledgements/i);
    const acked = runControls({ feature: feature("executing"), run: runView("paused", { unresolved: [] }), approvalCurrent: true, approvedLatest: true });
    expect(on(acked, "replaceCoordinator")).toBe(true);
    const otherUnresolved = runControls({ feature: feature("executing"), run: runView("paused", { unresolved: ["initial prompt not delivered: offline"] }), approvalCurrent: true, approvedLatest: true });
    expect(on(otherUnresolved, "replaceCoordinator"), "only awaiting-ack lines block").toBe(true);
    expect(on(runControls({ feature: feature("planned", false), run: null, approvalCurrent: true, approvedLatest: true }), "replaceCoordinator"), "unbound").toBe(false);
  });
});

describe("R4.2 runControls: per-task grant budget and accept", () => {
  it("grantBudget only for a task at its ceiling, accept only for a task awaiting acceptance, each naming its task", async () => {
    const runControls = await load();
    const cs = runControls({
      feature: feature("executing"),
      run: runView("running", { tasks: [["t1", "ceiling"], ["t2", "awaiting_acceptance"], ["t3", "in_progress"], ["t4", "verified"]] }),
      approvalCurrent: true,
      approvedLatest: true,
    });
    expect(get(cs, "grantBudget").filter((c) => c.enabled).map((c) => c.taskId)).toEqual(["t1"]);
    expect(get(cs, "accept").filter((c) => c.enabled).map((c) => c.taskId)).toEqual(["t2"]);
    for (const t of ["t3", "t4"]) {
      expect(on(cs, "grantBudget", t), `${t} grant`).toBe(false);
      expect(on(cs, "accept", t), `${t} accept`).toBe(false);
    }
  });

  it("the controls are exactly the card's RunControl names: none interrupts or cancels an agent", async () => {
    const runControls = await load();
    const names = new Set(
      runControls({ feature: feature("executing"), run: runView("running", { tasks: [["t1", "ceiling"], ["t2", "awaiting_acceptance"]] }), approvalCurrent: true, approvedLatest: true }).map((c) => c.control),
    );
    const allowed = ["start", "openChat", "pause", "resume", "stopAndRework", "defer", "cancel", "replaceCoordinator", "grantBudget", "accept"];
    for (const n of names) expect(allowed, n).toContain(n);
    const src = readFileSync(new URL("./run-controls.tsx", import.meta.url), "utf8");
    expect(src).not.toMatch(/\.interrupt\(|\.cancel\(|interrupt:\s*true/);
  });
});

// R4 final KensAI c0012: the server refuses run.resume for any run-level blocker other than the
// pause itself (runs.ts resume → runBlockers on the run treated as running). run.get publishes those
// blockers, so a paused run with one must not offer Resume, and the reason names the blocker.
describe("R4 KensAI c0012: Resume follows run.get's run-level blockers", () => {
  const withBlocked = (blocked: Array<{ code: string; taskId?: string }>) => ({ ...runView("paused"), blocked });
  it("a paused run blocked by start_unauthorised or approval_not_current does not offer Resume and names the blocker", async () => {
    const runControls = await load();
    for (const code of ["start_unauthorised", "approval_not_current"]) {
      const cs = runControls({ feature: feature("executing"), run: withBlocked([{ code: "run_not_running" }, { code }]), approvalCurrent: true, approvedLatest: true });
      expect(on(cs, "resume"), code).toBe(false);
      expect(reasonOf(cs, "resume").replace(/ /g, "_"), code).toContain(code);
    }
  });

  it("control: only run_not_running and task-level blockers keep Resume enabled", async () => {
    const runControls = await load();
    const cs = runControls({
      feature: feature("executing"),
      run: withBlocked([{ code: "run_not_running" }, { code: "not_todo", taskId: "t1" }, { code: "ceiling", taskId: "t2" }]),
      approvalCurrent: true,
      approvedLatest: true,
    });
    expect(on(cs, "resume")).toBe(true);
  });
});
