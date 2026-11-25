// question.out_of_scope through the commands layer over real temp stores: a stored validity
// distinct from skipped, counted separately, clearing the question's own staleness while keeping
// its answer history and discussion. Answered invalidation dependents are marked stale for review,
// transitively (an already stale one stays stale), and activation children are hidden. A mark is
// refused for inactive and cancelled questions and allowed on a question of an accepted block. Plan
// rules are unchanged: an out-of-scope basis question makes a draft ineligible, and a mark never
// approves anything.
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalJson } from "../shared/canonical";
import type { Question, RoadmapData } from "../shared/model";
import { createRoadmapCommands, UI_ORIGIN, type StoreOpener } from "./sessions";
import { openProjectStore } from "./store-root";
import { fixedClock, nextId, opt } from "./test-support/build";
import { fakeDirectory } from "./test-support/fake-dir";
import { makePlanProject, type PlanProject } from "./test-support/plans";
import { err, makeProject, ok, type TestProject } from "./test-support/service";

const P = "prj_test";
const ab = [opt("a"), opt("b")];

let project: TestProject | undefined;
let planProject: PlanProject | undefined;
afterEach(async () => {
  await project?.cleanup();
  project = undefined;
  await planProject?.cleanup();
  planProject = undefined;
});

async function setup() {
  project = await makeProject();
  const proj = project;
  const dir = fakeDirectory({ projects: [{ projectId: P, projectRootPath: proj.root, projectKind: "git" }] });
  const storeOptions = { now: fixedClock, newId: nextId, log: (m: string, e?: unknown) => void proj.logs.push([m, e]) };
  const commands = createRoadmapCommands({ directory: () => dir, now: fixedClock, newId: nextId, storeOptions });
  const open: StoreOpener = (projectId) => openProjectStore(dir, projectId, storeOptions);
  ok(await commands.init(open, { projectId: P }, UI_ORIGIN));
  const revision = async () => ok(await commands.version(open, { projectId: P }, UI_ORIGIN)).revision!;
  const at = async () => ({ projectId: P, expectedRevision: await revision() });
  const data = async (): Promise<RoadmapData> => {
    const read = await (await open(P)).read();
    if (read.status !== "ok") throw new Error(`expected ok store, got ${read.status}`);
    return read.data;
  };
  const question = async (sessionId: string, questionId: string): Promise<Question> => {
    const found = (await data()).sessions.find((s) => s.id === sessionId)?.questions.find((x) => x.id === questionId);
    if (found === undefined) throw new Error(`no question ${sessionId}/${questionId}`);
    return found;
  };
  const newSession = async (title = "Scope") => ok(await commands.sessionCreate(open, { ...(await at()), title }, UI_ORIGIN)).sessionId;
  const create = async (sessionId: string, title: string, extra: { blockId?: string; activatedBy?: Question["activatedBy"]; invalidatedBy?: Question["invalidatedBy"] } = {}) =>
    ok(
      await commands.questionCreate(
        open,
        { ...(await at()), sessionId, title, context: "", options: ab, allowFreeText: false, activatedBy: extra.activatedBy ?? [], invalidatedBy: extra.invalidatedBy ?? [], ...(extra.blockId ? { blockId: extra.blockId } : {}) },
        UI_ORIGIN,
      ),
    ).questionId;
  const answer = async (sessionId: string, questionId: string, optionId: string) =>
    ok(await commands.questionAnswer(open, { ...(await at()), sessionId, questionId, optionId }, UI_ORIGIN));
  const outOfScope = async (sessionId: string, questionId: string, reason?: string) =>
    commands.questionOutOfScope(open, { ...(await at()), sessionId, questionId, ...(reason !== undefined ? { reason } : {}) }, UI_ORIGIN);
  const snapshot = async () => ({ revision: await revision(), text: canonicalJson(await data()) });
  return { commands, open, revision, at, data, question, newSession, create, answer, outOfScope, snapshot };
}

describe("question.out_of_scope", () => {
  it("records out_of_scope distinct from skipped: status, catalog and counts report each separately", async () => {
    const h = await setup();
    const s = await h.newSession();
    const q1 = await h.create(s, "Q1");
    const q2 = await h.create(s, "Q2");
    await h.create(s, "Q3");
    ok(await h.commands.questionSkip(h.open, { ...(await h.at()), sessionId: s, questionId: q1 }, UI_ORIGIN));
    const before = await h.revision();
    const out = ok(await h.outOfScope(s, q2));
    expect(out.revision).toBe(before + 1);
    expect(out.visibilityChanged).toEqual([]);

    expect((await h.question(s, q1)).validity).toBe("skipped");
    expect((await h.question(s, q2)).validity).toBe("out_of_scope");
    const view = ok(await h.commands.sessionGet(h.open, { projectId: P, sessionId: s }, UI_ORIGIN));
    expect(view.questions.map((x) => x.status)).toEqual(["skipped", "out_of_scope", "open"]);
    expect(view.catalog.find((c) => c.ref.questionId === q2)?.status).toBe("out_of_scope");
    const overview = ok(await h.commands.overview(h.open, { projectId: P }, UI_ORIGIN));
    expect(overview.sessions.find((x) => x.id === s)?.counts).toEqual({ open: 1, answered: 0, stale: 0, skipped: 1, inactive: 0, out_of_scope: 1 });
  });

  it("clears the question's own staleness and keeps its answer, revisions and discussion", async () => {
    const h = await setup();
    const s = await h.newSession();
    const up = await h.create(s, "Upstream");
    const down = await h.create(s, "Downstream", { invalidatedBy: [{ upstream: { sessionId: s, questionId: up } }] });
    await h.answer(s, up, "a");
    await h.answer(s, down, "a");
    ok(await h.commands.questionDiscuss(h.open, { ...(await h.at()), sessionId: s, questionId: down, text: "context" }, UI_ORIGIN));
    await h.answer(s, up, "b");
    const stale = await h.question(s, down);
    expect(stale.validity).toBe("stale");

    ok(await h.outOfScope(s, down));
    const marked = await h.question(s, down);
    expect(marked.validity).toBe("out_of_scope");
    expect(marked.stale).toBeUndefined();
    expect(marked.answer).toEqual(stale.answer);
    expect(marked.revisions).toEqual(stale.revisions);
    expect(marked.discussion).toEqual(stale.discussion);
  });

  // Children reconsider a parent that goes out of scope: answered invalidation dependents become
  // stale (the cause shape is covered in out-of-scope-stale.test.ts); an already stale one stays stale.
  it("marks answered dependents stale, transitively, and keeps an already-stale dependent stale", async () => {
    const h = await setup();
    const s = await h.newSession();
    const a = await h.create(s, "A");
    const b = await h.create(s, "B", { invalidatedBy: [{ upstream: { sessionId: s, questionId: a } }] });
    const c = await h.create(s, "C", { invalidatedBy: [{ upstream: { sessionId: s, questionId: b } }] });
    await h.answer(s, a, "a");
    await h.answer(s, b, "a");
    await h.answer(s, c, "a");
    ok(await h.outOfScope(s, b));
    const cAfter = await h.question(s, c);
    expect(cAfter.validity).toBe("stale");
    expect(cAfter.stale).toMatchObject({ causeSessionId: s, causeQuestionId: b });
    expect(cAfter.revisions.map((r) => r.optionId)).toEqual(["a"]);

    // A dependent made stale earlier stays stale with its answer history.
    const s2 = await h.newSession("Second");
    const x = await h.create(s2, "X");
    const y = await h.create(s2, "Y", { invalidatedBy: [{ upstream: { sessionId: s2, questionId: x } }] });
    const z = await h.create(s2, "Z", { invalidatedBy: [{ upstream: { sessionId: s2, questionId: y } }] });
    await h.answer(s2, x, "a");
    await h.answer(s2, y, "a");
    await h.answer(s2, z, "a");
    await h.answer(s2, y, "b");
    const zStale = await h.question(s2, z);
    expect(zStale.validity).toBe("stale");
    ok(await h.outOfScope(s2, y));
    const zAfter = await h.question(s2, z);
    expect(zAfter.validity).toBe("stale");
    expect(zAfter.revisions).toEqual(zStale.revisions);
  });

  it("hides the activation children of the marked question and reports them", async () => {
    const h = await setup();
    const s = await h.newSession();
    const parent = await h.create(s, "Parent");
    const child = await h.create(s, "Child", { activatedBy: [{ parent: { sessionId: s, questionId: parent }, optionIds: ["a"] }] });
    await h.answer(s, parent, "a");
    const out = ok(await h.outOfScope(s, parent));
    expect(out.visibilityChanged).toEqual([{ sessionId: s, questionId: child }]);
    const view = ok(await h.commands.sessionGet(h.open, { projectId: P, sessionId: s }, UI_ORIGIN));
    expect(view.questions.find((x) => x.question.id === child)?.status).toBe("inactive");
  });

  it("a UI reason is kept as a discussion note by the human; without a reason no note is added", async () => {
    const h = await setup();
    const s = await h.newSession();
    const q1 = await h.create(s, "Q1");
    const q2 = await h.create(s, "Q2");
    ok(await h.outOfScope(s, q1, "not in this release"));
    const notes = (await h.question(s, q1)).discussion;
    expect(notes).toHaveLength(1);
    expect(notes[0].text).toContain("not in this release");
    expect(notes[0].actor.kind).toBe("human");
    ok(await h.outOfScope(s, q2));
    expect((await h.question(s, q2)).discussion).toEqual([]);
  });

  it("refuses an inactive question with question_inactive and no write", async () => {
    const h = await setup();
    const s = await h.newSession();
    const parent = await h.create(s, "Parent");
    const child = await h.create(s, "Child", { activatedBy: [{ parent: { sessionId: s, questionId: parent }, optionIds: ["b"] }] });
    const before = await h.snapshot();
    expect(err(await h.outOfScope(s, child)).code).toBe("question_inactive");
    expect(await h.snapshot()).toEqual(before);
  });

  it("refuses a cancelled question with decision_cancelled and no write", async () => {
    const h = await setup();
    const s = await h.newSession();
    const q1 = await h.create(s, "Q1");
    ok(await h.commands.decisionCancel(h.open, { ...(await h.at()), sessionId: s, questionId: q1, reason: "dropped" }, UI_ORIGIN));
    const before = await h.snapshot();
    expect(err(await h.outOfScope(s, q1)).code).toBe("decision_cancelled");
    expect(await h.snapshot()).toEqual(before);
  });

  it("is allowed on a question of an accepted block, whose definition stays unchanged", async () => {
    const h = await setup();
    const s = await h.newSession("Blocked");
    const q1 = await h.create(s, "Q1", { blockId: "b1" });
    await h.answer(s, q1, "a");
    ok(await h.commands.blockAccept(h.open, { ...(await h.at()), sessionId: s, blockId: "b1" }, UI_ORIGIN));
    const accepted = await h.question(s, q1);
    ok(await h.outOfScope(s, q1));
    const marked = await h.question(s, q1);
    expect(marked.validity).toBe("out_of_scope");
    // The accepted definition and the answer history stay unchanged; how the mark itself is
    // recorded is not pinned here.
    const frozen = (x: Question) => ({
      id: x.id, order: x.order, number: x.number, blockId: x.blockId, title: x.title, context: x.context, options: x.options,
      recommendedOptionId: x.recommendedOptionId, allowFreeText: x.allowFreeText, definitionRev: x.definitionRev,
      activatedBy: x.activatedBy, invalidatedBy: x.invalidatedBy, answer: x.answer, revisions: x.revisions,
    });
    expect(frozen(marked)).toEqual(frozen(accepted));
  });

  it("refuses an unknown question with not_found", async () => {
    const h = await setup();
    const s = await h.newSession();
    expect(err(await h.outOfScope(s, "no-such-question")).code).toBe("not_found");
  });
});

describe("plan rules are unchanged by out of scope", () => {
  it("an out-of-scope basis question makes a draft ineligible, naming the question", async () => {
    planProject = await makePlanProject();
    const t = planProject;
    const seed = await t.seedAnswered();
    ok(await t.project.service.questionOutOfScope(t.project.paseo, { projectId: t.P, expectedRevision: await t.revision(), ...seed.q2 }));
    const drafted = await t.plans.draft(
      t.open,
      { projectId: t.P, expectedRevision: await t.revision(), title: "Rollout", sessionIds: [seed.sessionId], markdown: "# Rollout", tasks: [{ id: "t1", title: "Build", description: "do" }] },
      UI_ORIGIN,
    );
    const e = err(drafted);
    expect(e.code).toBe("plan_ineligible");
    expect(JSON.stringify(e.details)).toContain(seed.q2.questionId);
  });

  it("marking a basis question out of scope approves nothing, and the drafted revision cannot be approved afterwards", async () => {
    planProject = await makePlanProject();
    const t = planProject;
    const seed = await t.seedAnswered();
    const draft = ok(
      await t.plans.draft(
        t.open,
        { projectId: t.P, expectedRevision: await t.revision(), title: "Rollout", sessionIds: [seed.sessionId], markdown: "# Rollout", tasks: [{ id: "t1", title: "Build", description: "do" }] },
        UI_ORIGIN,
      ),
    );
    const receipts = async () => (await readdir(join(t.stateDir, "approvals", t.P, draft.planId)).catch(() => [] as string[])).filter((n) => n.endsWith(".json"));
    const planBefore = ok(await t.plans.get(t.open, { projectId: t.P, planId: draft.planId }));

    ok(await t.project.service.questionOutOfScope(t.project.paseo, { projectId: t.P, expectedRevision: await t.revision(), ...seed.q2, reason: "later" }));
    expect(await receipts()).toEqual([]);
    const planAfter = ok(await t.plans.get(t.open, { projectId: t.P, planId: draft.planId }));
    expect(canonicalJson(planAfter.plan)).toBe(canonicalJson(planBefore.plan));
    expect(planAfter.approvals).toEqual([]);
    expect(planAfter.approval).not.toBe("current");

    const refused = await t.plans.approve(t.open, { projectId: t.P, planId: draft.planId, rev: draft.rev, contentHash: draft.contentHash }, UI_ORIGIN);
    expect(refused.ok).toBe(false);
    expect(await receipts()).toEqual([]);
  });
});
