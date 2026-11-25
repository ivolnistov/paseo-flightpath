// An answered dependent whose explicit outcome is "skipped" or "out of scope" keeps that outcome
// when its parent changes (an ordinary answer change or the parent going out of scope); the change
// is shown separately as a review-needed marker naming the parent. Its prior answer, answer history
// and out-of-scope events are kept. The change still reaches further dependents, so downstream plan
// approval currency follows as today. Activation-only children are hidden, not marked, exactly as
// for answered dependents; questions without an answer are not marked, like staleness.
//
// The marker is read from the session view (the same view roadmap_get_session returns) as
// `review: { causeSessionId, causeQuestionId, ... }`, with the parent's new revision as `causeRev`
// for an answer change, and no `causeRev` (but the out-of-scope mark) for an out-of-scope parent.
// How a review is resolved is not specified here.
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { Answer, refKey, type Question, type Ref, type RoadmapData } from "../shared/model";
import { buildTools } from "./mcp-tools";
import { createRoadmapCommands, UI_ORIGIN, type StoreOpener, type WriteOrigin } from "./sessions";
import { openProjectStore } from "./store-root";
import { fixedClock, nextId, opt } from "./test-support/build";
import { fakeDirectory } from "./test-support/fake-dir";
import { makePlanProject, type PlanProject } from "./test-support/plans";
import { makeProject, ok, type TestProject } from "./test-support/service";

const P = "prj_test";
const ab = [opt("a"), opt("b")];
const CHAT: WriteOrigin = { source: "chat", actor: { kind: "agent", agentId: "agent-review" } };

const Review = z.looseObject({
  causeSessionId: z.string(),
  causeQuestionId: z.string(),
  causeRev: z.number().int().optional(),
  causeKind: z.string().optional(),
  causeMarkId: z.string().optional(),
});
const Row = z.looseObject({
  question: z.looseObject({ id: z.string(), validity: z.string(), answer: Answer.optional(), revisions: z.array(Answer) }),
  status: z.string(),
  review: Review.optional(),
  priorAnswer: Answer.optional(),
  currentAnswer: Answer.optional(),
  outOfScopeEvents: z.array(z.looseObject({ source: z.string() })).optional(),
});
const View = z.looseObject({ questions: z.array(Row) });

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
  const dir = fakeDirectory({ projects: [{ projectId: P, projectRootPath: project.root, projectKind: "git" }] });
  const storeOptions = { now: fixedClock, newId: nextId, log: () => undefined };
  const commands = createRoadmapCommands({ directory: () => dir, now: fixedClock, newId: nextId, storeOptions });
  const open: StoreOpener = (projectId) => openProjectStore(dir, projectId, storeOptions);
  ok(await commands.init(open, { projectId: P }, UI_ORIGIN));
  const tools = buildTools(commands);
  const getSession = tools.find((x) => x.name === "roadmap_get_session")!;
  const revision = async () => ok(await commands.version(open, { projectId: P }, UI_ORIGIN)).revision!;
  const at = async () => ({ projectId: P, expectedRevision: await revision() });
  const data = async (): Promise<RoadmapData> => {
    const read = await (await open(P)).read();
    if (read.status !== "ok") throw new Error(`expected ok store, got ${read.status}`);
    return read.data;
  };
  const stored = async (ref: Ref): Promise<Question> => (await data()).sessions.find((s) => s.id === ref.sessionId)!.questions.find((q) => q.id === ref.questionId)!;
  const newSession = async (title: string) => ok(await commands.sessionCreate(open, { ...(await at()), title }, UI_ORIGIN)).sessionId;
  const create = async (sessionId: string, title: string, extra: Partial<Pick<Question, "activatedBy" | "invalidatedBy">> = {}): Promise<Ref> => ({
    sessionId,
    questionId: ok(await commands.questionCreate(open, { ...(await at()), sessionId, title, context: "", options: ab, allowFreeText: false, activatedBy: [], invalidatedBy: [], ...extra }, UI_ORIGIN)).questionId,
  });
  const answer = async (ref: Ref, optionId: string) => ok(await commands.questionAnswer(open, { ...(await at()), ...ref, optionId }, UI_ORIGIN));
  const skip = async (ref: Ref) => ok(await commands.questionSkip(open, { ...(await at()), ...ref }, UI_ORIGIN));
  const outOfScope = async (ref: Ref) => ok(await commands.questionOutOfScope(open, { ...(await at()), ...ref }, UI_ORIGIN));
  const row = async (ref: Ref) => View.parse(ok(await getSession.run({ sessionId: ref.sessionId }, { open, projectId: P, origin: CHAT }))).questions.find((x) => x.question.id === ref.questionId)!;
  const markId = async (ref: Ref) => (await data()).meta.outOfScopeMarks?.filter((m) => refKey(m.ref) === refKey(ref)).at(-1)?.id;
  return { commands, open, revision, at, data, stored, newSession, create, answer, skip, outOfScope, row, markId };
}

type H = Awaited<ReturnType<typeof setup>>;

/** Parent P with dependents: skipped S, out-of-scope O, valid V (control), and a skipped X in another session. */
async function family(h: H) {
  const s = await h.newSession("Family");
  const parent = await h.create(s, "Parent");
  const skipped = await h.create(s, "Skipped child", { invalidatedBy: [{ upstream: parent }] });
  const scoped = await h.create(s, "Out-of-scope child", { invalidatedBy: [{ upstream: parent }] });
  const valid = await h.create(s, "Valid child", { invalidatedBy: [{ upstream: parent }] });
  const other = await h.newSession("Elsewhere");
  const cross = await h.create(other, "Skipped child elsewhere", { invalidatedBy: [{ upstream: parent }] });
  for (const ref of [parent, skipped, scoped, valid, cross]) await h.answer(ref, "a");
  await h.skip(skipped);
  await h.outOfScope(scoped);
  await h.skip(cross);
  return { parent, skipped, scoped, valid, cross };
}

describe("a parent's answer changes", () => {
  it("skipped and out-of-scope dependents keep their outcome, answers and events, and gain a review marker naming the parent's new revision", async () => {
    const h = await setup();
    const f = await family(h);
    const before = new Map<string, Question>();
    for (const ref of [f.skipped, f.scoped, f.cross]) before.set(refKey(ref), await h.stored(ref));
    const scopedEvents = (await h.row(f.scoped)).outOfScopeEvents;

    await h.answer(f.parent, "b");

    for (const [ref, outcome] of [[f.skipped, "skipped"], [f.scoped, "out_of_scope"], [f.cross, "skipped"]] as const) {
      const r = await h.row(ref);
      expect(r.status, refKey(ref)).toBe(outcome);
      expect(r.question.validity, refKey(ref)).toBe(outcome);
      expect(r.review, refKey(ref)).toMatchObject({ causeSessionId: f.parent.sessionId, causeQuestionId: f.parent.questionId, causeRev: 2 });
      const was = before.get(refKey(ref))!;
      expect(r.question.answer, refKey(ref)).toEqual(was.answer);
      expect(r.question.revisions, refKey(ref)).toEqual(was.revisions);
    }
    const scoped = await h.row(f.scoped);
    expect(scoped.priorAnswer).toMatchObject({ rev: 1, optionId: "a" });
    expect(scoped.currentAnswer).toBeUndefined();
    expect(scoped.outOfScopeEvents).toEqual(scopedEvents);
    // The valid dependent becomes stale exactly as before.
    expect((await h.row(f.valid)).status).toBe("stale");
    expect((await h.row(f.valid)).review).toBeUndefined();
  });

  it("re-answering with the same value marks nothing", async () => {
    const h = await setup();
    const f = await family(h);
    await h.answer(f.parent, "a");
    for (const ref of [f.skipped, f.scoped, f.cross]) expect((await h.row(ref)).review, refKey(ref)).toBeUndefined();
  });

  it("a later parent change keeps the outcome and a marker; closing and reopening the session keeps both", async () => {
    const h = await setup();
    const f = await family(h);
    await h.answer(f.parent, "b");
    await h.answer(f.parent, "a");
    const r = await h.row(f.skipped);
    expect(r.status).toBe("skipped");
    expect(r.review).toMatchObject({ causeSessionId: f.parent.sessionId, causeQuestionId: f.parent.questionId });

    const store = await h.open(P);
    await store.transact(await h.revision(), (d) => {
      d.sessions.find((x) => x.id === f.skipped.sessionId)!.status = "closed";
    });
    ok(await h.commands.sessionReopen(h.open, { ...(await h.at()), sessionId: f.skipped.sessionId }, UI_ORIGIN));
    const reopened = await h.row(f.skipped);
    expect(reopened.status).toBe("skipped");
    expect(reopened.review).toMatchObject({ causeQuestionId: f.parent.questionId });
  });
});

describe("a parent goes out of scope", () => {
  it("skipped and out-of-scope dependents keep their outcome and gain a review marker with the out-of-scope cause and no causeRev", async () => {
    const h = await setup();
    const f = await family(h);
    await h.outOfScope(f.parent);
    const id = await h.markId(f.parent);
    expect(id).toBeDefined();
    for (const [ref, outcome] of [[f.skipped, "skipped"], [f.scoped, "out_of_scope"], [f.cross, "skipped"]] as const) {
      const r = await h.row(ref);
      expect(r.status, refKey(ref)).toBe(outcome);
      expect(r.review, refKey(ref)).toMatchObject({ causeSessionId: f.parent.sessionId, causeQuestionId: f.parent.questionId, causeKind: "out_of_scope", causeMarkId: id });
      expect(r.review?.causeRev, refKey(ref)).toBeUndefined();
    }
    expect((await h.row(f.valid)).status).toBe("stale");
  });
});

describe("what is not marked", () => {
  it("an activation-only child is hidden and keeps its outcome without a marker", async () => {
    const h = await setup();
    const s = await h.newSession("Activation");
    const parent = await h.create(s, "Parent");
    const child = await h.create(s, "Shown when a", { activatedBy: [{ parent, optionIds: ["a"] }] });
    await h.answer(parent, "a");
    await h.answer(child, "a");
    await h.skip(child);
    const before = await h.stored(child);
    await h.answer(parent, "b");
    const r = await h.row(child);
    expect(r.status).toBe("inactive");
    expect(r.question.validity).toBe("skipped");
    expect(r.review).toBeUndefined();
    expect(await h.stored(child)).toEqual(before);
  });

  it("a skipped dependent that was never answered is untouched", async () => {
    const h = await setup();
    const s = await h.newSession("Unanswered");
    const parent = await h.create(s, "Parent");
    const child = await h.create(s, "Never answered", { invalidatedBy: [{ upstream: parent }] });
    await h.answer(parent, "a");
    await h.skip(child);
    const before = await h.stored(child);
    await h.answer(parent, "b");
    expect(await h.stored(child)).toEqual(before);
    expect((await h.row(child)).review).toBeUndefined();
  });
});

describe("downstream plan currency", () => {
  it("a change through a skipped dependent still reaches its own dependents: an approved plan on them stops being current; the skipped one keeps its outcome", async () => {
    planProject = await makePlanProject();
    const t = planProject;
    const { service, paseo } = t.project;
    const at = async () => ({ projectId: t.P, expectedRevision: await t.revision() });
    const mk = async (sessionId: string, title: string, invalidatedBy: Question["invalidatedBy"] = []) =>
      ok(await service.questionCreate(paseo, { ...(await at()), sessionId, title, context: "", options: ab, allowFreeText: false, activatedBy: [], invalidatedBy })).questionId;
    const sA = ok(await service.sessionCreate(paseo, { ...(await at()), title: "Parent" })).sessionId;
    const sB = ok(await service.sessionCreate(paseo, { ...(await at()), title: "Skipped middle" })).sessionId;
    const sC = ok(await service.sessionCreate(paseo, { ...(await at()), title: "Plan basis" })).sessionId;
    const parent = { sessionId: sA, questionId: await mk(sA, "Parent") };
    const middle = { sessionId: sB, questionId: await mk(sB, "Middle", [{ upstream: parent }]) };
    const leaf = { sessionId: sC, questionId: await mk(sC, "Leaf", [{ upstream: middle }]) };
    for (const ref of [parent, middle, leaf]) ok(await service.questionAnswer(paseo, { ...(await at()), ...ref, optionId: "a" }));
    ok(await service.questionSkip(paseo, { ...(await at()), ...middle }));

    const draft = ok(await t.plans.draft(t.open, { ...(await at()), title: "Rollout", sessionIds: [sC], markdown: "# Rollout", tasks: [{ id: "t1", title: "Build", description: "do" }] }, UI_ORIGIN));
    ok(await t.plans.approve(t.open, { projectId: t.P, planId: draft.planId, rev: draft.rev, contentHash: draft.contentHash }, UI_ORIGIN));
    expect(ok(await t.plans.get(t.open, { projectId: t.P, planId: draft.planId })).approval).toBe("current");
    const receipts = async () => (await readdir(join(t.stateDir, "approvals", t.P, draft.planId)).catch(() => [] as string[])).filter((n) => n.endsWith(".json"));
    const receiptsBefore = await receipts();

    ok(await service.questionAnswer(paseo, { ...(await at()), ...parent, optionId: "b" }));

    const read = await (await t.open(t.P)).read();
    if (read.status !== "ok") throw new Error("store not ok");
    const q = (ref: Ref) => read.data.sessions.find((s) => s.id === ref.sessionId)!.questions.find((x) => x.id === ref.questionId)!;
    expect(q(middle).validity).toBe("skipped");
    expect(q(leaf).validity).toBe("stale");
    const view = ok(await t.plans.get(t.open, { projectId: t.P, planId: draft.planId }));
    expect(view.approval).toBe("not_current");
    expect(view.notCurrentReasons.join("\n")).toContain(leaf.questionId);
    expect(await receipts()).toEqual(receiptsBefore);

    const middleView = ok(await service.sessionGet(paseo, { projectId: t.P, sessionId: sB }));
    const middleRow = Row.parse(middleView.questions.find((x) => x.question.id === middle.questionId));
    expect(middleRow.status).toBe("skipped");
    expect(middleRow.review).toMatchObject({ causeSessionId: sA, causeQuestionId: parent.questionId, causeRev: 2 });
  });
});
