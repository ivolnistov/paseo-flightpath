// A parent that becomes out of scope changes its children: every previously answered, active
// invalidation dependent (transitively and across sessions) is marked stale for review, exactly as
// a changed answer would mark it, but with a truthful cause. The cause names the out-of-scope
// question and its recorded mark, never a fictional answer revision; this holds for a parent
// without any answer revision too. Answers and history are kept, unanswered and unrelated
// questions are untouched, activation children are hidden (not stale), and a stale dependent is
// reviewed through the ordinary confirm or re-answer. Plan rules are unchanged: an approved plan
// based on an affected child stops being current through the existing currency check, even when
// the parent's session is not in the plan, and no approval is created.
//
// The stale marker references the parent, carries no causeRev, and names the cause as
// causeKind "out_of_scope" with causeMarkId equal to the id of the recorded out-of-scope mark.
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { refKey, type Question, type Ref, type RoadmapData } from "../shared/model";
import { createRoadmapCommands, UI_ORIGIN, type StoreOpener, type WriteOrigin } from "./sessions";
import { openProjectStore } from "./store-root";
import { fixedClock, nextId, opt } from "./test-support/build";
import { fakeDirectory } from "./test-support/fake-dir";
import { makePlanProject, type PlanProject } from "./test-support/plans";
import { makeProject, ok, type TestProject } from "./test-support/service";

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
  const dir = fakeDirectory({ projects: [{ projectId: P, projectRootPath: project.root, projectKind: "git" }] });
  const storeOptions = { now: fixedClock, newId: nextId, log: () => undefined };
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
  const stored = async (ref: Ref): Promise<Question> => (await data()).sessions.find((s) => s.id === ref.sessionId)!.questions.find((q) => q.id === ref.questionId)!;
  const newSession = async (title: string) => ok(await commands.sessionCreate(open, { ...(await at()), title }, UI_ORIGIN)).sessionId;
  const create = async (sessionId: string, title: string, extra: { activatedBy?: Question["activatedBy"]; invalidatedBy?: Question["invalidatedBy"] } = {}): Promise<Ref> => ({
    sessionId,
    questionId: ok(
      await commands.questionCreate(
        open,
        { ...(await at()), sessionId, title, context: "", options: ab, allowFreeText: false, activatedBy: extra.activatedBy ?? [], invalidatedBy: extra.invalidatedBy ?? [] },
        UI_ORIGIN,
      ),
    ).questionId,
  });
  const answer = async (ref: Ref, optionId: string) => ok(await commands.questionAnswer(open, { ...(await at()), ...ref, optionId }, UI_ORIGIN));
  const mark = async (ref: Ref) => ok(await commands.questionOutOfScope(open, { ...(await at()), ...ref }, UI_ORIGIN));
  const markId = async (ref: Ref): Promise<string> => {
    const marks = (await data()).meta.outOfScopeMarks ?? [];
    const found = marks.filter((m) => refKey(m.ref) === refKey(ref)).at(-1);
    if (found === undefined) throw new Error(`no out-of-scope mark for ${refKey(ref)}`);
    return found.id;
  };
  return { commands, open, revision, at, data, stored, newSession, create, answer, mark, markId };
}

/** The stale marker names the out-of-scope parent and its recorded mark, with no answer revision as cause. */
function expectOutOfScopeCause(q: Question, parent: Ref, id: string) {
  expect(q.validity, q.id).toBe("stale");
  expect(q.stale, q.id).toMatchObject({ causeSessionId: parent.sessionId, causeQuestionId: parent.questionId, causeKind: "out_of_scope", causeMarkId: id });
  expect(q.stale?.causeRev, `${q.id} must not carry a fictional causeRev`).toBeUndefined();
}

describe("an out-of-scope parent marks its answered invalidation dependents stale", () => {
  it("transitively and across sessions, with the out-of-scope cause; answers kept; unanswered and unrelated questions untouched", async () => {
    const h = await setup();
    const s = await h.newSession("Parent");
    const a = await h.create(s, "A");
    const b = await h.create(s, "B", { invalidatedBy: [{ upstream: a }] });
    const c = await h.create(s, "C", { invalidatedBy: [{ upstream: b }] });
    const unanswered = await h.create(s, "U", { invalidatedBy: [{ upstream: a }] });
    const unrelated = await h.create(s, "N");
    const t = await h.newSession("Other");
    const x = await h.create(t, "X", { invalidatedBy: [{ upstream: a }] });
    for (const ref of [a, b, c, unrelated, x]) await h.answer(ref, "a");
    const before = await h.data();
    const was = (ref: Ref) => before.sessions.find((ss) => ss.id === ref.sessionId)!.questions.find((qq) => qq.id === ref.questionId)!;

    const out = await h.commands.questionOutOfScope(h.open, { ...(await h.at()), ...a }, UI_ORIGIN);
    expect(out.ok).toBe(true);
    const id = await h.markId(a);

    for (const ref of [b, c, x]) {
      const q = await h.stored(ref);
      expectOutOfScopeCause(q, a, id);
      expect(q.answer, refKey(ref)).toEqual(was(ref).answer);
      expect(q.revisions, refKey(ref)).toEqual(was(ref).revisions);
    }
    expect(await h.stored(unanswered)).toEqual(was(unanswered));
    expect(await h.stored(unrelated)).toEqual(was(unrelated));
    expect((await h.data()).meta.cancellations ?? []).toEqual([]);
    // The parent's own history is kept and it records no new revision.
    expect((await h.stored(a)).revisions).toEqual(was(a).revisions);
  });

  it("a parent without any answer revision still marks its answered dependents stale, with no causeRev", async () => {
    const h = await setup();
    const s = await h.newSession("Parent");
    const a = await h.create(s, "A");
    const b = await h.create(s, "B", { invalidatedBy: [{ upstream: a }] });
    await h.answer(b, "a");
    await h.mark(a);
    expect((await h.stored(a)).revisions).toEqual([]);
    expectOutOfScopeCause(await h.stored(b), a, await h.markId(a));
  });

  it("an already stale dependent stays stale", async () => {
    const h = await setup();
    const s = await h.newSession("Parent");
    const up = await h.create(s, "Up");
    const a = await h.create(s, "A", { invalidatedBy: [{ upstream: up }] });
    const b = await h.create(s, "B", { invalidatedBy: [{ upstream: a }] });
    await h.answer(up, "a");
    await h.answer(a, "a");
    await h.answer(b, "a");
    await h.answer(a, "b");
    expect((await h.stored(b)).validity).toBe("stale");
    await h.mark(a);
    expect((await h.stored(b)).validity).toBe("stale");
    expect((await h.stored(b)).revisions.map((r) => r.optionId)).toEqual(["a"]);
  });

  it("activation children are hidden, not marked stale, and come back with their answers when the parent is answered again", async () => {
    const h = await setup();
    const s = await h.newSession("Parent");
    const a = await h.create(s, "A");
    const d = await h.create(s, "D", { activatedBy: [{ parent: a, optionIds: ["a"] }] });
    await h.answer(a, "a");
    await h.answer(d, "b");
    const before = await h.stored(d);
    const marked = ok(await h.commands.questionOutOfScope(h.open, { ...(await h.at()), ...a }, UI_ORIGIN));
    expect(marked.visibilityChanged).toEqual([d]);
    expect(await h.stored(d)).toEqual(before);
    const view = ok(await h.commands.sessionGet(h.open, { projectId: P, sessionId: s }, UI_ORIGIN));
    expect(view.questions.find((x) => x.question.id === d.questionId)?.status).toBe("inactive");

    await h.answer(a, "a");
    const back = ok(await h.commands.sessionGet(h.open, { projectId: P, sessionId: s }, UI_ORIGIN));
    expect(back.questions.find((x) => x.question.id === d.questionId)?.status).toBe("answered");
    expect((await h.stored(d)).revisions).toEqual(before.revisions);
  });

  it("a dependent made stale by the mark is reviewed through confirm or a new answer", async () => {
    const h = await setup();
    const s = await h.newSession("Parent");
    const a = await h.create(s, "A");
    const b = await h.create(s, "B", { invalidatedBy: [{ upstream: a }] });
    const c = await h.create(s, "C", { invalidatedBy: [{ upstream: a }] });
    for (const ref of [a, b, c]) await h.answer(ref, "a");
    await h.mark(a);

    const chat: WriteOrigin = { source: "chat", actor: { kind: "agent", agentId: "agent-review" }, quoted: "B still holds" };
    ok(await h.commands.questionConfirm(h.open, { ...(await h.at()), ...b }, chat));
    const confirmed = await h.stored(b);
    expect(confirmed.validity).toBe("valid");
    expect(confirmed.stale).toBeUndefined();
    expect(confirmed.revisions.map((r) => r.optionId)).toEqual(["a", "a"]);

    await h.answer(c, "b");
    const reanswered = await h.stored(c);
    expect(reanswered.validity).toBe("valid");
    expect(reanswered.revisions.map((r) => r.optionId)).toEqual(["a", "b"]);
  });

  it("a refused mark marks nothing stale", async () => {
    const h = await setup();
    const s = await h.newSession("Parent");
    const a = await h.create(s, "A");
    const b = await h.create(s, "B", { invalidatedBy: [{ upstream: a }] });
    await h.answer(a, "a");
    await h.answer(b, "a");
    const stale = await h.commands.questionOutOfScope(h.open, { projectId: P, expectedRevision: (await h.revision()) - 1, ...a }, UI_ORIGIN);
    expect(stale.ok).toBe(false);
    expect((await h.stored(b)).validity).toBe("valid");
  });
});

describe("existing plan currency follows an affected child", () => {
  it("an approved plan based on a child whose parent (in another session) goes out of scope is no longer current; no approval is created", async () => {
    planProject = await makePlanProject();
    const t = planProject;
    const { service, paseo } = t.project;
    const at = async () => ({ projectId: t.P, expectedRevision: await t.revision() });
    const parentSession = ok(await service.sessionCreate(paseo, { ...(await at()), title: "Parent outside the plan" })).sessionId;
    const parent = ok(
      await service.questionCreate(paseo, { ...(await at()), sessionId: parentSession, title: "Parent", context: "", options: ab, allowFreeText: false, activatedBy: [], invalidatedBy: [] }),
    ).questionId;
    ok(await service.questionAnswer(paseo, { ...(await at()), sessionId: parentSession, questionId: parent, optionId: "a" }));
    const planSession = ok(await service.sessionCreate(paseo, { ...(await at()), title: "Plan basis" })).sessionId;
    const child = ok(
      await service.questionCreate(paseo, {
        ...(await at()), sessionId: planSession, title: "Child", context: "", options: ab, allowFreeText: false, activatedBy: [],
        invalidatedBy: [{ upstream: { sessionId: parentSession, questionId: parent } }],
      }),
    ).questionId;
    ok(await service.questionAnswer(paseo, { ...(await at()), sessionId: planSession, questionId: child, optionId: "a" }));

    const draft = ok(
      await t.plans.draft(t.open, { ...(await at()), title: "Rollout", sessionIds: [planSession], markdown: "# Rollout", tasks: [{ id: "t1", title: "Build", description: "do" }] }, UI_ORIGIN),
    );
    ok(await t.plans.approve(t.open, { projectId: t.P, planId: draft.planId, rev: draft.rev, contentHash: draft.contentHash }, UI_ORIGIN));
    expect(ok(await t.plans.get(t.open, { projectId: t.P, planId: draft.planId })).approval).toBe("current");
    const receipts = async () => (await readdir(join(t.stateDir, "approvals", t.P, draft.planId)).catch(() => [] as string[])).filter((n) => n.endsWith(".json"));
    const receiptsBefore = await receipts();

    ok(await service.questionOutOfScope(paseo, { ...(await at()), sessionId: parentSession, questionId: parent }));

    const view = ok(await t.plans.get(t.open, { projectId: t.P, planId: draft.planId }));
    expect(view.approval).toBe("not_current");
    expect(view.notCurrentReasons.join("\n")).toContain(child);
    expect(await receipts()).toEqual(receiptsBefore);
  });
});
