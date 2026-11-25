// Answers on accepted blocks: the owner may re-answer, confirm, skip, mark out of scope and add notes
// on a question of an accepted block, while its accepted definition and relations, the accepted
// block record (with its summary snapshot), the cancellation records and the summary the
// continuation captured stay frozen. A re-answer creates a revision as usual, wakes no chat, and
// makes a plan approval based on it not current without touching approvals. Review markers on
// accepted questions are resolved by the same UI actions. Real temp stores through the commands.
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalJson } from "../shared/canonical";
import type { Question, Ref, RoadmapData } from "../shared/model";
import type { Result } from "../shared/rpc";
import { createRoadmapCommands, UI_ORIGIN, type StoreOpener, type WriteOrigin } from "./sessions";
import { openProjectStore } from "./store-root";
import { fixedClock, nextId, opt } from "./test-support/build";
import { fakeDirectory } from "./test-support/fake-dir";
import { binding, continuationIn, seedGrilling } from "./test-support/grilling";
import { makePlanProject, type PlanProject } from "./test-support/plans";
import { err, makeProject, ok, type TestProject } from "./test-support/service";

const P = "prj_test";
const ab = [opt("a"), opt("b")];
const CHAT: WriteOrigin = { source: "chat", actor: { kind: "agent", agentId: "agent-1" }, quoted: "keep it" };
type AfterAccept = { projectId: string; sessionId: string; operationId: string };

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
  const woken: AfterAccept[] = [];
  const commands = createRoadmapCommands({ directory: () => dir, now: fixedClock, newId: nextId, storeOptions, afterAccept: (x: AfterAccept) => void woken.push(x) });
  const open: StoreOpener = (projectId) => openProjectStore(dir, projectId, storeOptions);
  ok(await commands.init(open, { projectId: P }, UI_ORIGIN));
  const revision = async () => ok(await commands.version(open, { projectId: P }, UI_ORIGIN)).revision!;
  const at = async () => ({ projectId: P, expectedRevision: await revision() });
  const data = async (): Promise<RoadmapData> => {
    const read = await (await open(P)).read();
    if (read.status !== "ok") throw new Error(`expected ok store, got ${read.status}`);
    return read.data;
  };
  const session = async (id: string) => (await data()).sessions.find((s) => s.id === id)!;
  const stored = async (ref: Ref): Promise<Question> => (await session(ref.sessionId)).questions.find((q) => q.id === ref.questionId)!;
  const newSession = async (title: string) => ok(await commands.sessionCreate(open, { ...(await at()), title }, UI_ORIGIN)).sessionId;
  const create = async (sessionId: string, title: string, extra: Partial<Pick<Question, "activatedBy" | "invalidatedBy">> & { blockId?: string } = {}): Promise<Ref> => ({
    sessionId,
    questionId: ok(await commands.questionCreate(open, { ...(await at()), sessionId, title, context: "", options: ab, allowFreeText: false, activatedBy: [], invalidatedBy: [], ...extra }, UI_ORIGIN)).questionId,
  });
  const answer = async (ref: Ref, optionId: string, origin: WriteOrigin = UI_ORIGIN) => commands.questionAnswer(open, { ...(await at()), ...ref, optionId }, origin);
  const accept = async (sessionId: string, blockId: string) => ok(await commands.blockAccept(open, { ...(await at()), sessionId, blockId }, UI_ORIGIN));
  const snapshot = async () => ({ revision: await revision(), text: canonicalJson(await data()) });
  return { commands, open, revision, at, data, session, stored, newSession, create, answer, accept, snapshot, woken };
}

type H = Awaited<ReturnType<typeof setup>>;

/** Accepted block b1: q1 answered a; q2 answered a and invalidated by q1; q3 unanswered. */
async function acceptedBlock(h: H) {
  const s = await h.newSession("Accepted");
  const q1 = await h.create(s, "Q1", { blockId: "b1" });
  const q2 = await h.create(s, "Q2", { blockId: "b1", invalidatedBy: [{ upstream: q1 }] });
  const q3 = await h.create(s, "Q3", { blockId: "b1" });
  ok(await h.answer(q1, "a"));
  ok(await h.answer(q2, "a"));
  const { nextBlockId } = await h.accept(s, "b1");
  return { s, q1, q2, q3, nextBlockId };
}

/** The summary snapshot stored on an accepted block. */
function snapshotOf(blocks: Array<{ id: string; state: string; summary?: string }> | undefined, id: string): string | undefined {
  return blocks?.find((b) => b.id === id)?.summary;
}

/** The accepted definition: what Accept froze. */
const definition = (q: Question) => ({
  id: q.id, order: q.order, number: q.number, blockId: q.blockId, title: q.title, context: q.context, options: q.options,
  recommendedOptionId: q.recommendedOptionId, allowFreeText: q.allowFreeText, definitionRev: q.definitionRev, activatedBy: q.activatedBy, invalidatedBy: q.invalidatedBy,
});

describe("answers on an accepted block", () => {
  it("re-answer, confirm, skip, out of scope and notes are allowed; the accepted definitions and block record stay unchanged", async () => {
    const h = await setup();
    const b = await acceptedBlock(h);
    const definitionsBefore = await Promise.all([b.q1, b.q2, b.q3].map(async (r) => definition(await h.stored(r))));
    const blockBefore = canonicalJson((await h.session(b.s)).blocks!.find((x) => x.id === "b1"));

    const re = ok(await h.answer(b.q1, "b"));
    expect(re.rev).toBe(2);
    expect((await h.stored(b.q2)).validity).toBe("stale");
    ok(await h.commands.questionConfirm(h.open, { ...(await h.at()), ...b.q2 }, UI_ORIGIN));
    ok(await h.commands.questionSkip(h.open, { ...(await h.at()), ...b.q3 }, UI_ORIGIN));
    ok(await h.commands.questionDiscuss(h.open, { ...(await h.at()), ...b.q1, text: "changed after acceptance" }, UI_ORIGIN));
    ok(await h.commands.questionOutOfScope(h.open, { ...(await h.at()), ...b.q2 }, UI_ORIGIN));

    expect((await h.stored(b.q1)).revisions.map((r) => r.optionId)).toEqual(["a", "b"]);
    expect((await h.stored(b.q2)).revisions.map((r) => r.optionId)).toEqual(["a", "a"]);
    expect((await h.stored(b.q3)).validity).toBe("skipped");
    expect((await h.stored(b.q1)).discussion.map((n) => n.text)).toEqual(["changed after acceptance"]);
    expect(await Promise.all([b.q1, b.q2, b.q3].map(async (r) => definition(await h.stored(r))))).toEqual(definitionsBefore);
    expect(canonicalJson((await h.session(b.s)).blocks!.find((x) => x.id === "b1"))).toBe(blockBefore);
  });

  it("a chat answer with the human's quoted words is allowed too", async () => {
    const h = await setup();
    const b = await acceptedBlock(h);
    const out = ok(await h.answer(b.q3, "b", CHAT));
    expect(out.rev).toBe(1);
    expect((await h.stored(b.q3)).answer).toMatchObject({ optionId: "b", source: "chat", quoted: "keep it" });
  });

  it("definitions, relations and new questions stay block_frozen, with no write", async () => {
    const h = await setup();
    const b = await acceptedBlock(h);
    const attempts: Array<[string, () => Promise<Result<unknown>>]> = [
      ["update", async () => h.commands.questionUpdate(h.open, { ...(await h.at()), ...b.q1, patch: { title: "Edited" } }, UI_ORIGIN)],
      ["relation add", async () => h.commands.relationAdd(h.open, { ...(await h.at()), relation: { kind: "invalidation", target: b.q3, invalidation: { upstream: b.q1 } } }, UI_ORIGIN)],
      ["relation remove", async () => h.commands.relationRemove(h.open, { ...(await h.at()), relation: { kind: "invalidation", target: b.q2, invalidation: { upstream: b.q1 } } }, UI_ORIGIN)],
      ["create", async () => h.commands.questionCreate(h.open, { ...(await h.at()), sessionId: b.s, title: "Late", context: "", options: ab, allowFreeText: false, activatedBy: [], invalidatedBy: [], blockId: "b1" }, UI_ORIGIN)],
    ];
    for (const [name, attempt] of attempts) {
      const before = await h.snapshot();
      expect(err(await attempt()).code, name).toBe("block_frozen");
      expect(await h.snapshot(), name).toEqual(before);
    }
  });

  it("a cancelled question of an accepted block refuses answers with decision_cancelled; the cancellation records stay unchanged", async () => {
    const h = await setup();
    const b = await acceptedBlock(h);
    ok(await h.commands.decisionCancel(h.open, { ...(await h.at()), ...b.q3, reason: "dropped" }, UI_ORIGIN));
    const records = canonicalJson((await h.data()).meta.cancellations);
    const before = await h.snapshot();
    expect(err(await h.answer(b.q3, "a")).code).toBe("decision_cancelled");
    expect(err(await h.commands.questionSkip(h.open, { ...(await h.at()), ...b.q3 }, UI_ORIGIN)).code).toBe("decision_cancelled");
    expect(await h.snapshot()).toEqual(before);
    ok(await h.answer(b.q1, "b"));
    expect(canonicalJson((await h.data()).meta.cancellations)).toBe(records);
  });

  it("the summary the continuation captured and the block snapshot stay as told; the edit wakes no chat; the view reports the change", async () => {
    const h = await setup();
    const s = await h.newSession("Grilling");
    const q1 = await h.create(s, "Q1", { blockId: "blk-open" });
    ok(await h.answer(q1, "a"));
    await seedGrilling(h.open, P, s, { planner: binding(), continuation: continuationIn("paused") });
    await h.accept(s, "blk-open");
    expect(h.woken).toHaveLength(1);
    const after = await h.session(s);
    const continuation = canonicalJson(after.continuation);
    const snapshotText = snapshotOf(after.blocks, "blk-open");
    expect(snapshotText).toBeDefined();
    expect(after.continuation?.summary).toBe(snapshotText);

    ok(await h.answer(q1, "b"));
    const later = await h.session(s);
    expect(canonicalJson(later.continuation)).toBe(continuation);
    expect(snapshotOf(later.blocks, "blk-open")).toBe(snapshotText);
    expect(h.woken).toHaveLength(1);
    const view = ok(await h.commands.sessionGet(h.open, { projectId: P, sessionId: s }, UI_ORIGIN));
    const entry = (view.summaries ?? []).find((x) => x.blockId === "blk-open");
    expect(entry).toMatchObject({ acceptedSummary: snapshotText, changedSinceAcceptance: true, changed: [1] });
  });
});

describe("review markers on accepted questions", () => {
  async function reviewed(h: H) {
    const parentSession = await h.newSession("Parent");
    const parent = await h.create(parentSession, "Parent");
    const s = await h.newSession("Accepted");
    const skipped = await h.create(s, "Skipped", { blockId: "b1", invalidatedBy: [{ upstream: parent }] });
    const scoped = await h.create(s, "Scoped", { blockId: "b1", invalidatedBy: [{ upstream: parent }] });
    ok(await h.answer(parent, "a"));
    ok(await h.answer(skipped, "a"));
    ok(await h.answer(scoped, "a"));
    ok(await h.commands.questionSkip(h.open, { ...(await h.at()), ...skipped }, UI_ORIGIN));
    ok(await h.commands.questionOutOfScope(h.open, { ...(await h.at()), ...scoped }, UI_ORIGIN));
    await h.accept(s, "b1");
    ok(await h.answer(parent, "b"));
    expect((await h.stored(skipped)).review).toBeDefined();
    expect((await h.stored(scoped)).review).toBeDefined();
    return { parent, skipped, scoped };
  }

  it("a UI re-skip resolves the review and keeps the question skipped", async () => {
    const h = await setup();
    const r = await reviewed(h);
    ok(await h.commands.questionSkip(h.open, { ...(await h.at()), ...r.skipped }, UI_ORIGIN));
    const q = await h.stored(r.skipped);
    expect(q.validity).toBe("skipped");
    expect(q.review).toBeUndefined();
    expect(q.revisions.map((x) => x.optionId)).toEqual(["a"]);
  });

  it("an answer resolves the review with a new revision", async () => {
    const h = await setup();
    const r = await reviewed(h);
    ok(await h.answer(r.skipped, "b"));
    const q = await h.stored(r.skipped);
    expect(q.validity).toBe("valid");
    expect(q.review).toBeUndefined();
    expect(q.revisions.map((x) => x.optionId)).toEqual(["a", "b"]);
  });

  it("marking out of scope again resolves the review and records a second, attributed out-of-scope event", async () => {
    const h = await setup();
    const r = await reviewed(h);
    ok(await h.commands.questionOutOfScope(h.open, { ...(await h.at()), ...r.scoped }, { source: "chat", actor: { kind: "agent", agentId: "agent-1" }, quoted: "still out of scope" }));
    const q = await h.stored(r.scoped);
    expect(q.validity).toBe("out_of_scope");
    expect(q.review).toBeUndefined();
    const marks = ((await h.data()).meta.outOfScopeMarks ?? []).filter((m) => m.ref.questionId === r.scoped.questionId);
    expect(marks.map((m) => m.source)).toEqual(["ui", "chat"]);
    expect(marks[1]).toMatchObject({ actor: { kind: "agent", agentId: "agent-1" }, quoted: "still out of scope", afterRev: 1 });
  });
});

describe("plan approval follows a re-answer on an accepted block", () => {
  it("a plan approved on the accepted answers stops being current after a re-answer; no approval is created or changed", async () => {
    planProject = await makePlanProject();
    const t = planProject;
    const { service, paseo } = t.project;
    const at = async () => ({ projectId: t.P, expectedRevision: await t.revision() });
    const s = ok(await service.sessionCreate(paseo, { ...(await at()), title: "Accepted basis" })).sessionId;
    const q1 = ok(await service.questionCreate(paseo, { ...(await at()), sessionId: s, title: "Q1", context: "", options: ab, allowFreeText: false, activatedBy: [], invalidatedBy: [], blockId: "b1" })).questionId;
    ok(await service.questionAnswer(paseo, { ...(await at()), sessionId: s, questionId: q1, optionId: "a" }));
    ok(await service.blockAccept(paseo, { ...(await at()), sessionId: s, blockId: "b1" }));
    const draft = ok(await t.plans.draft(t.open, { ...(await at()), title: "Rollout", sessionIds: [s], markdown: "# Rollout", tasks: [{ id: "t1", title: "Build", description: "do" }] }, UI_ORIGIN));
    ok(await t.plans.approve(t.open, { projectId: t.P, planId: draft.planId, rev: draft.rev, contentHash: draft.contentHash }, UI_ORIGIN));
    const receipts = async () => (await readdir(join(t.stateDir, "approvals", t.P, draft.planId)).catch(() => [] as string[])).filter((n) => n.endsWith(".json"));
    const before = await receipts();
    expect(ok(await t.plans.get(t.open, { projectId: t.P, planId: draft.planId })).approval).toBe("current");

    ok(await service.questionAnswer(paseo, { ...(await at()), sessionId: s, questionId: q1, optionId: "b" }));
    const view = ok(await t.plans.get(t.open, { projectId: t.P, planId: draft.planId }));
    expect(view.approval).toBe("not_current");
    expect(await receipts()).toEqual(before);
  });
});
