// Stage R2.2 (task card 2026-10-29 §3.2, §3.3): a bound plan.draft creates the server-owned
// grilling sessions inside its transaction. A feature-kind feature gets one "[feature]" session,
// each plan one "[plan]" session (both at most once), and every grill: true task a "[task:<id>]"
// session carried per task id while the task keeps grill: true. The links are part of the v2
// content hash; the sessions never join sessionIds or basedOn (§6 G2). Legacy drafts create nothing.
// Real temp stores, synthetic data through the real commands.
import { afterEach, describe, expect, it } from "vitest";
import { isV2Revision, type PlanRevision, type PlanRevisionV2, type Session } from "../shared/model";
import { PlanDraft } from "../shared/rpc";
import { contentHash, contentHashV2 } from "./plan-hash";
import { UI_ORIGIN } from "./sessions";
import { fixedClock, nextId } from "./test-support/build";
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
function err<T>(r: R<T>) {
  if (r.ok) throw new Error(`expected an error, got ${JSON.stringify(r.value)}`);
  return r.error;
}
const v2 = (rev: PlanRevision | undefined): PlanRevisionV2 => {
  if (rev === undefined || !isV2Revision(rev)) throw new Error("expected a schema 2 revision");
  return rev;
};
const bodyOf = (r: PlanRevisionV2) => ({ markdown: r.markdown, tasks: r.tasks, basedOn: r.basedOn, decisionSnapshotHash: r.decisionSnapshotHash });

type TaskIn = { id?: string; title: string; description: string; dependsOn?: string[]; grill?: boolean; dod?: string };

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
  const feature = async (title: string, kind: "feature" | "bug" = "feature") =>
    ok(await features.create(s.open, { projectId: s.P, expectedRevision: await s.revision(), title, description: "", kind }, UI_ORIGIN)).featureId;
  const data = async () => {
    const read = await (await s.open(s.P)).read();
    if (read.status !== "ok") throw new Error("store not ok");
    return read.data;
  };
  const draft = async (x: { planId?: string; featureId?: string; title?: string; sessionIds?: string[]; tasks?: TaskIn[]; markdown?: string }) =>
    s.plans.draft(
      s.open,
      {
        projectId: s.P, expectedRevision: await s.revision(), title: x.title ?? "Rollout", sessionIds: x.sessionIds ?? [seed.sessionId],
        markdown: x.markdown ?? "# Rollout", tasks: x.tasks ?? [{ id: "t1", title: "Build", description: "do", dod: "Done" }],
        ...(x.planId !== undefined ? { planId: x.planId } : {}), ...(x.featureId !== undefined ? { featureId: x.featureId } : {}),
      },
      UI_ORIGIN,
    );
  const planOf = async (planId: string) => (await data()).plans.find((p) => p.id === planId)!;
  const featureOf = async (featureId: string) => (await data()).features.find((f) => f.id === featureId)!;
  const sessionIds = async () => (await data()).sessions.map((x) => x.id);
  /** Sessions present now that were not in `before`. */
  const created = async (before: string[]): Promise<Session[]> => (await data()).sessions.filter((x) => !before.includes(x.id));
  const latest = async (planId: string) => v2((await planOf(planId)).revisions.at(-1));
  const taskOf = async (planId: string, taskId: string) => (await latest(planId)).tasks.find((x) => x.id === taskId)!;
  const snapshot = async () => ({ revision: await s.revision(), data: JSON.stringify(await data()) });
  const get = (planId: string) => s.plans.get(s.open, { projectId: s.P, planId });
  return { ...s, seed, get, features, feature, data, draft, planOf, featureOf, sessionIds, created, latest, taskOf, snapshot };
}

const expectEmptyActive = (x: Session, title: string) => {
  expect(x.title).toBe(title);
  expect(x.status).toBe("active");
  expect(x.questions).toEqual([]);
};

describe("R2.2 feature and plan grilling sessions on a bound draft", () => {
  it("the first bound draft of a feature-kind feature creates exactly one [feature] and one [plan] session and links them", async () => {
    const s = await setup();
    const f = await s.feature("Search");
    const before = await s.sessionIds();
    const d = ok(await s.draft({ featureId: f, title: "Rollout" }));
    const made = await s.created(before);
    expect(made.map((x) => x.title).sort()).toEqual(["[feature] Search", "[plan] Rollout"]);
    const fs = made.find((x) => x.title === "[feature] Search")!;
    const ps = made.find((x) => x.title === "[plan] Rollout")!;
    expectEmptyActive(fs, "[feature] Search");
    expectEmptyActive(ps, "[plan] Rollout");
    expect((await s.featureOf(f)).grillSessionId).toBe(fs.id);
    expect((await s.planOf(d.planId)).grillSessionId).toBe(ps.id);
  });

  it("a second draft of the same plan creates no session and keeps both links", async () => {
    const s = await setup();
    const f = await s.feature("Search");
    const d = ok(await s.draft({ featureId: f }));
    const links = { feature: (await s.featureOf(f)).grillSessionId, plan: (await s.planOf(d.planId)).grillSessionId };
    expect(typeof links.feature, "precondition: first draft linked the feature").toBe("string");
    const before = await s.sessionIds();
    const d2 = ok(await s.draft({ planId: d.planId, featureId: f, title: "Rollout renamed", markdown: "# Rollout v2" }));
    expect(d2.rev).toBe(2);
    expect(await s.created(before)).toEqual([]);
    expect((await s.featureOf(f)).grillSessionId).toBe(links.feature);
    expect((await s.planOf(d.planId)).grillSessionId).toBe(links.plan);
  });

  it("a bug feature gets only the [plan] session; the feature stays unlinked", async () => {
    const s = await setup();
    const b = await s.feature("Crash", "bug");
    const before = await s.sessionIds();
    const d = ok(await s.draft({ featureId: b, title: "Fix" }));
    const made = await s.created(before);
    expect(made.map((x) => x.title)).toEqual(["[plan] Fix"]);
    expect((await s.featureOf(b)).grillSessionId).toBeUndefined();
    expect((await s.planOf(d.planId)).grillSessionId).toBe(made[0].id);
  });

  // R2 corrective c0011 (card §8.2, owner Q1 option 2: one plan per feature): this case formerly
  // expected a second plan with its own [plan] session; it now expects the refusal.
  it("a second new plan for the same feature is refused (feature_has_plan) and creates nothing; the first plan's feature session is unchanged", async () => {
    const s = await setup();
    const f = await s.feature("Search");
    const d1 = ok(await s.draft({ featureId: f, title: "One" }));
    const featureLink = (await s.featureOf(f)).grillSessionId;
    expect(typeof featureLink, "precondition: the first plan linked the feature session").toBe("string");
    const before = await s.snapshot();
    const e = err(await s.draft({ featureId: f, title: "Two" }));
    expect(e.code).toBe("invalid_input");
    expect(e.details).toEqual({ reason: "feature_has_plan", featureId: f, planId: d1.planId });
    expect(await s.snapshot(), "no plan, session or link is written").toEqual(before);
    expect((await s.featureOf(f)).grillSessionId).toBe(featureLink);
    expect((await s.data()).plans.filter((p) => p.featureId === f).map((p) => p.id)).toEqual([d1.planId]);
  });

  it("binding an existing legacy plan to a feature that already has a plan is refused (feature_has_plan) with no write", async () => {
    const s = await setup();
    const f = await s.feature("Search");
    const d1 = ok(await s.draft({ featureId: f, title: "One" }));
    const legacy = ok(await s.draft({ title: "Legacy", tasks: [{ id: "l1", title: "L", description: "" }] }));
    const before = await s.snapshot();
    const e = err(await s.draft({ planId: legacy.planId, featureId: f, title: "Legacy" }));
    expect(e.code).toBe("invalid_input");
    expect(e.details).toEqual({ reason: "feature_has_plan", featureId: f, planId: d1.planId });
    expect(await s.snapshot()).toEqual(before);
    expect("featureId" in (await s.planOf(legacy.planId))).toBe(false);
  });

  it("control: the single bound plan of a feature can still be redrafted, and another feature can get its own plan", async () => {
    const s = await setup();
    const f = await s.feature("Search");
    const d1 = ok(await s.draft({ featureId: f, title: "One" }));
    expect(ok(await s.draft({ planId: d1.planId, featureId: f, title: "One", markdown: "# One v2" })).rev).toBe(2);
    const g = await s.feature("Other");
    ok(await s.draft({ featureId: g, title: "Two" }));
    const legacy = ok(await s.draft({ title: "Legacy", tasks: [{ id: "l1", title: "L", description: "" }] }));
    const h = await s.feature("Third");
    expect(ok(await s.draft({ planId: legacy.planId, featureId: h, title: "Legacy" })).rev, "binding a legacy plan to a free feature").toBe(2);
  });

  it("an existing link to a missing session is kept, not silently replaced", async () => {
    const s = await setup();
    const f = await s.feature("Search");
    await (await s.open(s.P)).transact(await s.revision(), (draft) => {
      draft.features.find((x) => x.id === f)!.grillSessionId = "ghost-session";
    });
    const before = await s.sessionIds();
    const d = ok(await s.draft({ featureId: f, title: "Rollout" }));
    expect((await s.created(before)).map((x) => x.title), "only the plan session is created").toEqual(["[plan] Rollout"]);
    expect((await s.featureOf(f)).grillSessionId).toBe("ghost-session");
    const view = ok(await s.get(d.planId));
    expect(view.blockers[0]).toEqual({ code: "grilling_required", sessionId: "ghost-session" });
  });

  it("grilling sessions do not join sessionIds or basedOn; the caller's basis stays the basis", async () => {
    const s = await setup();
    const f = await s.feature("Search");
    const d = ok(await s.draft({ featureId: f }));
    const plan = await s.planOf(d.planId);
    expect(plan.sessionIds).toEqual([s.seed.sessionId]);
    const rev = v2(plan.revisions[0]);
    expect([...new Set(rev.basedOn.map((b) => b.sessionId))]).toEqual([s.seed.sessionId]);
    const grilling = [plan.grillSessionId, (await s.featureOf(f)).grillSessionId];
    for (const g of grilling) expect(typeof g).toBe("string");
    for (const b of rev.basedOn) expect(grilling).not.toContain(b.sessionId);
  });

  it("a caller may explicitly select a grilling session as basis; it is then an ordinary basis session", async () => {
    const s = await setup();
    const f = await s.feature("Search");
    const d = ok(await s.draft({ featureId: f }));
    const planSession = (await s.planOf(d.planId)).grillSessionId!;
    expect(typeof planSession, "precondition: the plan session exists").toBe("string");
    const { service, paseo } = s.project;
    const qOut = await service.questionCreate(paseo, {
      projectId: s.P, expectedRevision: await s.revision(), sessionId: planSession, title: "Rollout window", context: "",
      options: [{ id: "a", label: "Night" }], allowFreeText: false, activatedBy: [], invalidatedBy: [],
    });
    const questionId = ok(qOut).questionId;
    ok(await service.questionAnswer(paseo, { projectId: s.P, expectedRevision: await s.revision(), sessionId: planSession, questionId, optionId: "a" }));
    ok(await s.draft({ planId: d.planId, featureId: f, sessionIds: [s.seed.sessionId, planSession] }));
    const plan = await s.planOf(d.planId);
    expect(plan.sessionIds).toEqual([s.seed.sessionId, planSession]);
    expect(v2(plan.revisions.at(-1)).basedOn.map((b) => `${b.sessionId}/${b.questionId}`)).toContain(`${planSession}/${questionId}`);
    expect(plan.grillSessionId).toBe(planSession);
  });

  it("legacy draft: no session is created and the body and hash are the shipped legacy ones", async () => {
    const s = await setup();
    await s.feature("Search");
    const before = await s.sessionIds();
    const d = ok(await s.draft({ tasks: [{ id: "t1", title: "Build", description: "do" }] }));
    expect(await s.created(before)).toEqual([]);
    const plan = await s.planOf(d.planId);
    expect("grillSessionId" in plan).toBe(false);
    const rev = plan.revisions[0];
    expect(isV2Revision(rev)).toBe(false);
    expect(rev.tasks).toEqual([{ id: "t1", title: "Build", description: "do" }]);
    expect(rev.contentHash).toBe(contentHash({ markdown: rev.markdown, tasks: rev.tasks, basedOn: rev.basedOn, decisionSnapshotHash: rev.decisionSnapshotHash }));
    expect(Object.keys(rev).sort()).toEqual(["basedOn", "contentHash", "createdAt", "decisionSnapshotHash", "markdown", "rev", "tasks"]);
  });

  it("a rejected bound draft creates no session, link or plan (invalid graph, ineligible basis, unknown feature)", async () => {
    const s = await setup();
    const f = await s.feature("Search");
    const { service, paseo } = s.project;
    const open = ok(await service.sessionCreate(paseo, { projectId: s.P, expectedRevision: await s.revision(), title: "Undecided" })).sessionId;
    ok(
      await service.questionCreate(paseo, {
        projectId: s.P, expectedRevision: await s.revision(), sessionId: open, title: "Open", context: "",
        options: [{ id: "a", label: "A" }], allowFreeText: false, activatedBy: [], invalidatedBy: [],
      }),
    );
    const attempts: Array<[() => ReturnType<typeof s.draft>, string]> = [
      [() => s.draft({ featureId: f, tasks: [{ id: "t1", title: "A", description: "", dependsOn: ["missing"], grill: true }] }), "invalid_input"],
      [() => s.draft({ featureId: f, tasks: [{ id: "t1", title: "A", description: "", grill: true }, { id: "t1", title: "B", description: "" }] }), "invalid_input"],
      [() => s.draft({ featureId: f, sessionIds: [open], tasks: [{ id: "t1", title: "A", description: "", grill: true }] }), "plan_ineligible"],
      [() => s.draft({ featureId: "missing", tasks: [{ id: "t1", title: "A", description: "", grill: true }] }), "not_found"],
    ];
    for (const [attempt, code] of attempts) {
      const before = await s.snapshot();
      expect(err(await attempt()).code).toBe(code);
      expect(await s.snapshot()).toEqual(before);
    }
    expect((await s.featureOf(f)).grillSessionId).toBeUndefined();
    // Positive control: the same feature with a valid draft creates its sessions.
    const before = await s.sessionIds();
    ok(await s.draft({ featureId: f, tasks: [{ id: "t1", title: "A", description: "", grill: true }] }));
    expect((await s.created(before)).map((x) => x.title).sort()).toEqual(["[feature] Search", "[plan] Rollout", "[task:t1] A"]);
  });
});

describe("R2.2 task grilling sessions", () => {
  it("grill: true creates [task:<id>] and sets grillSessionId; grill: false gets no link; the link is part of contentHashV2", async () => {
    const s = await setup();
    const f = await s.feature("Search");
    const before = await s.sessionIds();
    const d = ok(await s.draft({ featureId: f, tasks: [{ id: "t1", title: "Build", description: "do", grill: true, dod: "x" }, { id: "t2", title: "Ship", description: "", dod: "y" }] }));
    const made = await s.created(before);
    const ts = made.find((x) => x.title === "[task:t1] Build");
    expect(ts, made.map((x) => x.title).join(",")).toBeDefined();
    expectEmptyActive(ts!, "[task:t1] Build");
    expect(made).toHaveLength(3);
    const rev = await s.latest(d.planId);
    expect(rev.tasks[0]).toEqual({ id: "t1", title: "Build", description: "do", dependsOn: [], parallel: false, completion: "auto", grill: true, grillSessionId: ts!.id, dod: "x" });
    expect(rev.tasks[1]).toEqual({ id: "t2", title: "Ship", description: "", dependsOn: [], parallel: false, completion: "auto", grill: false, dod: "y" });
    expect("grillSessionId" in rev.tasks[1]).toBe(false);
    expect(rev.contentHash).toBe(contentHashV2(bodyOf(rev)));
    const withoutLinks = { ...bodyOf(rev), tasks: rev.tasks.map(({ grillSessionId: _g, ...rest }) => rest) };
    expect(rev.contentHash, "the link changes the hash").not.toBe(contentHashV2(withoutLinks));
    expect(d.contentHash).toBe(rev.contentHash);
  });

  it("per task id: carry while grill stays true (rename included), drop on false (session kept), fresh id when true again", async () => {
    const s = await setup();
    const f = await s.feature("Search");
    const d = ok(await s.draft({ featureId: f, tasks: [{ id: "t1", title: "Build", description: "do", grill: true, dod: "x" }] }));
    const first = (await s.taskOf(d.planId, "t1")).grillSessionId;
    expect(typeof first).toBe("string");

    // Carry: same id, renamed task, still grill: true; no session created.
    let before = await s.sessionIds();
    ok(await s.draft({ planId: d.planId, featureId: f, tasks: [{ id: "t1", title: "Build it", description: "changed", grill: true, dod: "x" }] }));
    expect((await s.taskOf(d.planId, "t1")).grillSessionId).toBe(first);
    expect(await s.created(before)).toEqual([]);

    // Drop: grill: false removes the link; the session stays in the store.
    ok(await s.draft({ planId: d.planId, featureId: f, tasks: [{ id: "t1", title: "Build it", description: "changed", grill: false, dod: "x" }] }));
    const dropped = await s.taskOf(d.planId, "t1");
    expect("grillSessionId" in dropped).toBe(false);
    expect(await s.sessionIds()).toContain(first);

    // True again: a new session, no resurrection of the dropped link.
    before = await s.sessionIds();
    ok(await s.draft({ planId: d.planId, featureId: f, tasks: [{ id: "t1", title: "Build it", description: "changed", grill: true, dod: "x" }] }));
    const again = (await s.taskOf(d.planId, "t1")).grillSessionId;
    expect(typeof again).toBe("string");
    expect(again).not.toBe(first);
    expect((await s.created(before)).map((x) => [x.id, x.title])).toEqual([[again, "[task:t1] Build it"]]);
    expect(await s.sessionIds()).toContain(first);

    // Earlier revisions are frozen: rev 1 still names the first session.
    const plan = await s.planOf(d.planId);
    expect(v2(plan.revisions[0]).tasks[0].grillSessionId).toBe(first);
  });

  it("carry-over is per task id: a task under a new id gets its own session; a sibling's link is never borrowed", async () => {
    const s = await setup();
    const f = await s.feature("Search");
    const d = ok(await s.draft({ featureId: f, tasks: [{ id: "t1", title: "Build", description: "do", grill: true, dod: "x" }] }));
    const t1 = (await s.taskOf(d.planId, "t1")).grillSessionId;
    const before = await s.sessionIds();
    ok(
      await s.draft({
        planId: d.planId, featureId: f,
        tasks: [{ id: "t9", title: "Build", description: "do", grill: true, dod: "x" }, { id: "t1", title: "Build", description: "do", grill: true, dod: "x" }],
      }),
    );
    const t9 = (await s.taskOf(d.planId, "t9")).grillSessionId;
    expect((await s.taskOf(d.planId, "t1")).grillSessionId).toBe(t1);
    expect(typeof t9).toBe("string");
    expect(t9).not.toBe(t1);
    expect((await s.created(before)).map((x) => [x.id, x.title])).toEqual([[t9, "[task:t9] Build"]]);
  });

  it("plan.get blockers carry the created feature, plan and task session ids", async () => {
    const s = await setup();
    const f = await s.feature("Search");
    const d = ok(await s.draft({ featureId: f, tasks: [{ id: "t1", title: "Build", description: "do", grill: true }] }));
    const plan = await s.planOf(d.planId);
    const featureSession = (await s.featureOf(f)).grillSessionId;
    const taskSession = (await s.taskOf(d.planId, "t1")).grillSessionId;
    for (const id of [featureSession, plan.grillSessionId, taskSession]) expect(typeof id).toBe("string");
    expect(ok(await s.get(d.planId)).blockers).toEqual([
      { code: "dod_missing", taskId: "t1" },
      { code: "grilling_required", sessionId: featureSession },
      { code: "grilling_required", sessionId: plan.grillSessionId },
      { code: "grilling_required", taskId: "t1", sessionId: taskSession },
    ]);
  });

  it("client-supplied grillSessionId is rejected by the strict plan.draft contract (UI input)", () => {
    const base = { projectId: "prj_test", expectedRevision: 1, title: "P", sessionIds: ["s1"], markdown: "# P", featureId: "f1" };
    expect(PlanDraft.input.safeParse({ ...base, tasks: [{ id: "t1", title: "A", description: "", grill: true }] }).success, "control").toBe(true);
    expect(PlanDraft.input.safeParse({ ...base, tasks: [{ id: "t1", title: "A", description: "", grill: true, grillSessionId: "s9" }] }).success).toBe(false);
  });
});
