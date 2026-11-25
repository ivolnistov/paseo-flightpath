// Automatic grilling S1/G2 (task card §3.2 draft rule, §3.4 P1–P6, TR14): a feature-bound
// plan.draft with a caller binds the grilling sessions it creates in that transaction (boundBy
// draft, epoch 1); carried and pre-existing sessions are never changed; no caller, the UI service
// and legacy drafts bind nothing; the roadmap_plan_draft tool passes the grant's agent; and the
// revision hashes do not depend on the caller. Real temp stores, synthetic data, real commands.
//
// Negative cases carry a positive anchor in the same case, so they are RED until the draft rule
// exists and then prove the negative for the right reason.
import { afterEach, describe, expect, it } from "vitest";
import { canonicalJson } from "../shared/canonical";
import { isV2Revision, type PlanRevision, type PlanRevisionV2, type Session } from "../shared/model";
import { contentHashV2 } from "./plan-hash";
import { buildPlanTools } from "./plan-tools";
import { UI_ORIGIN, type PlannerCaller, type WriteOrigin } from "./sessions";
import { fixedClock, nextId, NOW_ISO } from "./test-support/build";
import { binding, OTHER_AGENT, PLANNER, UUID_AGENT, type Binding } from "./test-support/grilling";
import { makePlanProject, type PlanProject } from "./test-support/plans";

let t: PlanProject | undefined;
afterEach(async () => {
  await t?.cleanup();
  t = undefined;
});

type R<T> = { ok: true; value: T } | { ok: false; error: { code: string; message: string; details?: unknown } };
function ok<T>(r: R<T>): T {
  if (!r.ok) throw new Error(`expected ok, got ${r.error.code}: ${r.error.message}`);
  return r.value;
}
const v2 = (rev: PlanRevision | undefined): PlanRevisionV2 => {
  if (rev === undefined || !isV2Revision(rev)) throw new Error("expected a schema 2 revision");
  return rev;
};
const chat = (agentId?: string): WriteOrigin => ({ source: "chat", actor: agentId !== undefined ? { kind: "agent", agentId } : { kind: "agent" } });
const caller = (agentId = PLANNER, workspaceId: string | null = "ws-1"): PlannerCaller => ({ agentId, workspaceId });
const drafted = (c: PlannerCaller): Binding => binding({ agentId: c.agentId, workspaceId: c.workspaceId, boundAt: NOW_ISO, boundBy: "draft", epoch: 1 });

type TaskIn = { id?: string; title: string; description: string; grill?: boolean; dod?: string };

async function setup() {
  t = await makePlanProject();
  const s = t;
  const seed = await s.seedAnswered();
  const { createFeatureCommands } = await import("./features");
  const features = createFeatureCommands({
    directory: () => {
      throw new Error("unused");
    },
    now: fixedClock,
    newId: nextId,
    storeOptions: { now: fixedClock, newId: nextId },
  });
  const feature = async (title: string) =>
    ok(await features.create(s.open, { projectId: s.P, expectedRevision: await s.revision(), title, description: "", kind: "feature" }, UI_ORIGIN)).featureId;
  const data = async () => {
    const read = await (await s.open(s.P)).read();
    if (read.status !== "ok") throw new Error("store not ok");
    return read.data;
  };
  const input = async (x: { planId?: string; featureId?: string; title?: string; tasks?: TaskIn[]; markdown?: string }) => ({
    projectId: s.P,
    expectedRevision: await s.revision(),
    title: x.title ?? "Rollout",
    sessionIds: [seed.sessionId],
    markdown: x.markdown ?? "# Rollout",
    tasks: x.tasks ?? [{ id: "t1", title: "Build", description: "do", grill: true, dod: "Done" }],
    ...(x.planId !== undefined ? { planId: x.planId } : {}),
    ...(x.featureId !== undefined ? { featureId: x.featureId } : {}),
  });
  const draft = async (x: Parameters<typeof input>[0], o: { origin?: WriteOrigin; caller?: PlannerCaller } = {}) =>
    s.plans.draft(s.open, await input(x), o.origin ?? chat(o.caller?.agentId), o.caller);
  const sessionIds = async () => (await data()).sessions.map((x) => x.id);
  const created = async (before: string[]): Promise<Session[]> => (await data()).sessions.filter((x) => !before.includes(x.id));
  const sessionOf = async (id: string | undefined): Promise<Session> => {
    const found = (await data()).sessions.find((x) => x.id === id);
    if (found === undefined) throw new Error(`session ${String(id)} not found`);
    return found;
  };
  /** The feature, plan and task grilling sessions of a bound plan, by role. */
  const grillSessions = async (featureId: string, planId: string) => {
    const d = await data();
    const plan = d.plans.find((p) => p.id === planId)!;
    const tasks = v2(plan.revisions.at(-1)).tasks;
    return {
      feature: await sessionOf(d.features.find((f) => f.id === featureId)?.grillSessionId),
      plan: await sessionOf(plan.grillSessionId),
      task: async (taskId: string) => sessionOf(tasks.find((x) => x.id === taskId)?.grillSessionId),
    };
  };
  const latest = async (planId: string) => v2((await data()).plans.find((p) => p.id === planId)!.revisions.at(-1));
  return { ...s, seed, features, feature, data, input, draft, sessionIds, created, sessionOf, grillSessions, latest };
}

describe("P1 a bound draft with a caller binds the grilling sessions it creates", () => {
  it("feature, plan and task sessions each get { ...caller, boundBy draft, epoch 1, boundAt now }; the basis session is untouched", async () => {
    const s = await setup();
    const f = await s.feature("Search");
    const before = await s.sessionIds();
    const c = caller(PLANNER, "ws-1");
    const d = ok(await s.draft({ featureId: f }, { caller: c }));
    const made = await s.created(before);
    expect(made.map((x) => x.title).sort()).toEqual(["[feature] Search", "[plan] Rollout", "[task:t1] Build"]);
    for (const session of made) expect(session.planner, session.title).toEqual(drafted(c));
    for (const session of made) expect("plannerHistory" in session, session.title).toBe(false);
    const g = await s.grillSessions(f, d.planId);
    expect(g.feature.planner).toEqual(drafted(c));
    expect(g.plan.planner).toEqual(drafted(c));
    expect((await g.task("t1")).planner).toEqual(drafted(c));
    expect("planner" in (await s.sessionOf(s.seed.sessionId))).toBe(false);
  });
});

describe("P2 carried and pre-existing sessions never change", () => {
  it("a re-draft by another caller keeps the feature, plan and carried task bindings; only the task session it creates is bound to it", async () => {
    const s = await setup();
    const f = await s.feature("Search");
    const a = caller(PLANNER, "ws-1");
    const b = caller(OTHER_AGENT, "ws-2");
    const d = ok(await s.draft({ featureId: f }, { caller: a }));
    const first = await s.grillSessions(f, d.planId);
    const kept = { feature: canonicalJson(first.feature), plan: canonicalJson(first.plan), t1: canonicalJson(await first.task("t1")) };
    expect(first.feature.planner).toEqual(drafted(a));
    ok(
      await s.draft(
        {
          planId: d.planId,
          featureId: f,
          markdown: "# Rollout v2",
          tasks: [
            { id: "t1", title: "Build", description: "do", grill: true, dod: "Done" },
            { id: "t2", title: "Ship", description: "ship", grill: true, dod: "Done" },
          ],
        },
        { caller: b },
      ),
    );
    const again = await s.grillSessions(f, d.planId);
    expect(canonicalJson(again.feature)).toBe(kept.feature);
    expect(canonicalJson(again.plan)).toBe(kept.plan);
    expect(canonicalJson(await again.task("t1"))).toBe(kept.t1);
    expect((await again.task("t2")).planner).toEqual(drafted(b));
  });

  it("sessions created by an unbound first draft stay unbound when a caller re-drafts; its new task session is bound", async () => {
    const s = await setup();
    const f = await s.feature("Search");
    const d = ok(await s.draft({ featureId: f }, { origin: UI_ORIGIN }));
    const first = await s.grillSessions(f, d.planId);
    for (const x of [first.feature, first.plan, await first.task("t1")]) expect("planner" in x, x.title).toBe(false);
    const c = caller(UUID_AGENT, null);
    ok(
      await s.draft(
        {
          planId: d.planId,
          featureId: f,
          tasks: [
            { id: "t1", title: "Build", description: "do", grill: true, dod: "Done" },
            { id: "t2", title: "Ship", description: "ship", grill: true, dod: "Done" },
          ],
        },
        { caller: c },
      ),
    );
    const again = await s.grillSessions(f, d.planId);
    for (const x of [again.feature, again.plan, await again.task("t1")]) expect("planner" in x, x.title).toBe(false);
    expect((await again.task("t2")).planner).toEqual(drafted(c));
  });
});

describe("P3/P4 no caller, the UI service and legacy drafts bind nothing", () => {
  it("P3: the UI service and an unbound chat grant create unbound sessions; a draft with a caller then binds its own", async () => {
    const s = await setup();
    const f1 = await s.feature("Via UI");
    const before1 = await s.sessionIds();
    ok(await s.ui.draft(s.project.paseo, await s.input({ featureId: f1, title: "UI plan" })));
    const ui = await s.created(before1);
    expect(ui).toHaveLength(3);
    for (const x of ui) expect("planner" in x, x.title).toBe(false);

    const f2 = await s.feature("Unbound grant");
    const before2 = await s.sessionIds();
    ok(await s.draft({ featureId: f2, title: "Grant plan" }, { origin: chat() }));
    const grant = await s.created(before2);
    expect(grant).toHaveLength(3);
    for (const x of grant) expect("planner" in x, x.title).toBe(false);

    const f3 = await s.feature("Bound");
    const before3 = await s.sessionIds();
    ok(await s.draft({ featureId: f3, title: "Bound plan" }, { caller: caller() }));
    const bound = await s.created(before3);
    expect(bound).toHaveLength(3);
    for (const x of bound) expect(x.planner, x.title).toEqual(drafted(caller()));
  });

  it("P4: a legacy draft with a caller creates no session and binds nothing; a bound draft with the same caller binds", async () => {
    const s = await setup();
    const before = await s.data();
    ok(await s.draft({ title: "Legacy", tasks: [{ title: "Old", description: "legacy" }] }, { caller: caller() }));
    const after = await s.data();
    expect(after.sessions.map((x) => x.id)).toEqual(before.sessions.map((x) => x.id));
    for (const x of after.sessions) expect("planner" in x, x.title).toBe(false);

    const f = await s.feature("Bound");
    const ids = await s.sessionIds();
    ok(await s.draft({ featureId: f }, { caller: caller() }));
    const made = await s.created(ids);
    expect(made).toHaveLength(3);
    for (const x of made) expect(x.planner, x.title).toEqual(drafted(caller()));
  });
});

describe("P5 the roadmap_plan_draft tool passes the grant's agent as caller", () => {
  it("ctx without agentId binds nothing; ctx { agentId, workspaceId } binds; an absent workspaceId binds null", async () => {
    const s = await setup();
    const tool = buildPlanTools(s.plans).find((x) => x.name === "roadmap_plan_draft");
    if (tool === undefined) throw new Error("roadmap_plan_draft missing");
    const args = async (featureId: string, title: string) => {
      const { projectId: _p, ...rest } = await s.input({ featureId, title });
      return rest;
    };

    const f1 = await s.feature("No agent");
    const b1 = await s.sessionIds();
    ok(await tool.run(await args(f1, "No agent plan"), { open: s.open, projectId: s.P, origin: chat(), workspaceId: "ws-1" }));
    for (const x of await s.created(b1)) expect("planner" in x, x.title).toBe(false);

    const f2 = await s.feature("Agent");
    const b2 = await s.sessionIds();
    ok(await tool.run(await args(f2, "Agent plan"), { open: s.open, projectId: s.P, origin: chat(PLANNER), agentId: PLANNER, workspaceId: "ws-5" }));
    const made = await s.created(b2);
    expect(made).toHaveLength(3);
    for (const x of made) expect(x.planner, x.title).toEqual(drafted(caller(PLANNER, "ws-5")));

    const f3 = await s.feature("Agent without workspace");
    const b3 = await s.sessionIds();
    ok(await tool.run(await args(f3, "Agent plan 2"), { open: s.open, projectId: s.P, origin: chat(UUID_AGENT), agentId: UUID_AGENT }));
    for (const x of await s.created(b3)) expect(x.planner, x.title).toEqual(drafted(caller(UUID_AGENT, null)));
  });
});

describe("P6 TR14: the caller never enters the revision hashes", () => {
  it("a draft with a caller binds its sessions and has the same decisionSnapshotHash and contentHash as the same draft without one", async () => {
    const s = await setup();
    const tasks: TaskIn[] = [{ id: "t1", title: "Build", description: "do", grill: false, dod: "Done" }];
    const fa = await s.feature("Without caller");
    const a = ok(await s.draft({ featureId: fa, tasks }, { origin: UI_ORIGIN }));
    const fb = await s.feature("With caller");
    const before = await s.sessionIds();
    const b = ok(await s.draft({ featureId: fb, tasks }, { caller: caller() }));
    const made = await s.created(before);
    expect(made).toHaveLength(2);
    for (const x of made) expect(x.planner, x.title).toEqual(drafted(caller()));
    const ra = await s.latest(a.planId);
    const rb = await s.latest(b.planId);
    expect(rb.decisionSnapshotHash).toBe(ra.decisionSnapshotHash);
    expect(rb.contentHash).toBe(ra.contentHash);
    expect(b.contentHash).toBe(a.contentHash);
  });

  it("with grill tasks the contentHash is exactly the v2 hash of the revision body", async () => {
    const s = await setup();
    const f = await s.feature("Grill");
    const d = ok(await s.draft({ featureId: f }, { caller: caller() }));
    const rev = await s.latest(d.planId);
    expect((await s.sessionOf(rev.tasks[0].grillSessionId)).planner).toEqual(drafted(caller()));
    expect(rev.contentHash).toBe(contentHashV2({ markdown: rev.markdown, tasks: rev.tasks, basedOn: rev.basedOn, decisionSnapshotHash: rev.decisionSnapshotHash }));
  });
});
