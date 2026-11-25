// What the owner and the agent see after a question is marked out of scope. Out of scope is the
// question's current outcome: its earlier answer stays in the stored history (no new answer
// revision, stored `answer` unchanged for existing readers) but is never presented as current, by
// the session view or by the current-answer link; it is exposed separately as the prior answer.
// Every question that depends on an out-of-scope question (activation children and invalidation
// downstream, transitively, across sessions) is listed for review with its number and status, so an
// impacted decision is never silently presented as reviewed. Nothing is cancelled or re-marked
// automatically, hidden activation children stay hidden, and writes keep the revision guard.
//
// The read fields are derived and additive, parsed here with local schemas:
//   QuestionView.currentAnswer?  the answer that is current (absent when out of scope)
//   QuestionView.priorAnswer?    the latest stored answer of an out-of-scope question
//   SessionView.outOfScope[]     { ref, number, dependents: { ref, number, status }[] }
//   roadmap_resolve_link         an out-of-scope answer link has no `answer`/`currentRev`, carries
//                                `priorAnswer`; a pinned revision is never current
//   QuestionView.outOfScopeEvents  every out-of-scope mark as an explicit, attributed history event
//                                { at, source, actor, quoted?, reason?, afterRev? }, kept after later
//                                answers; how the event is stored is left to the implementation
import { cp, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { canonicalJson } from "../shared/canonical";
import { Answer, refKey, type Question, type Ref } from "../shared/model";
import { buildTools, type McpToolTable } from "./mcp-tools";
import { createRoadmapCommands, UI_ORIGIN, type StoreOpener, type WriteOrigin } from "./sessions";
import { openStore } from "./store";
import { openProjectStore } from "./store-root";
import { fixedClock, nextId, opt } from "./test-support/build";
import { fakeDirectory } from "./test-support/fake-dir";
import { err, makeProject, ok, type TestProject } from "./test-support/service";

const P = "prj_test";
const FIXTURE = fileURLToPath(new URL("./fixtures/v1-store/", import.meta.url));
const FIXTURE_PID = "prj_2d93f94da090e78c";
const CHAT: WriteOrigin = { source: "chat", actor: { kind: "agent", agentId: "agent-review" } };
const ab = [opt("a"), opt("b")];

const RefS = z.object({ sessionId: z.string(), questionId: z.string() });
const Row = z.looseObject({
  question: z.looseObject({ id: z.string(), answer: Answer.optional(), revisions: z.array(Answer), validity: z.string() }),
  number: z.number().int(),
  status: z.string(),
  currentAnswer: Answer.optional(),
  priorAnswer: Answer.optional(),
  outOfScopeEvents: z
    .array(
      z.looseObject({
        at: z.string(),
        source: z.enum(["ui", "chat"]),
        actor: z.looseObject({ kind: z.enum(["human", "agent"]), agentId: z.string().optional() }),
        quoted: z.string().optional(),
        reason: z.string().optional(),
        afterRev: z.number().int().optional(),
      }),
    )
    .optional(),
});
const Dependent = z.looseObject({ ref: RefS, number: z.number().int(), status: z.string() });
const OutOfScopeEntry = z.looseObject({ ref: RefS, number: z.number().int(), dependents: z.array(Dependent) });
const View = z.looseObject({ revision: z.number().int(), questions: z.array(Row), outOfScope: z.array(OutOfScopeEntry).optional() });
const Resolved = z.looseObject({
  kind: z.enum(["question", "answer"]),
  questionId: z.string(),
  status: z.string(),
  answer: Answer.optional(),
  priorAnswer: Answer.optional(),
  currentRev: z.number().int().optional(),
  pinnedRev: z.number().int().optional(),
  current: z.boolean(),
});

let project: TestProject | undefined;
const roots: string[] = [];
afterEach(async () => {
  await project?.cleanup();
  project = undefined;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function harness(commands: ReturnType<typeof createRoadmapCommands>, open: StoreOpener, projectId: string, tools: McpToolTable) {
  const tool = (name: string) => {
    const found = tools.find((x) => x.name === name);
    if (found === undefined) throw new Error(`tool ${name} missing`);
    return found;
  };
  const ctx = { open, projectId, origin: CHAT };
  const revision = async () => ok(await commands.version(open, { projectId }, UI_ORIGIN)).revision!;
  const at = async () => ({ projectId, expectedRevision: await revision() });
  const stored = async () => {
    const read = await (await open(projectId)).read();
    if (read.status !== "ok") throw new Error(`expected ok store, got ${read.status}`);
    return read.data;
  };
  const storedQuestion = async (ref: Ref): Promise<Question> =>
    (await stored()).sessions.find((s) => s.id === ref.sessionId)!.questions.find((q) => q.id === ref.questionId)!;
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
  const markUi = async (ref: Ref, expectedRevision?: number) =>
    commands.questionOutOfScope(open, { projectId, expectedRevision: expectedRevision ?? (await revision()), ...ref }, UI_ORIGIN);
  const markUiReason = async (ref: Ref, reason: string) =>
    commands.questionOutOfScope(open, { projectId, expectedRevision: await revision(), ...ref, reason }, UI_ORIGIN);
  const markChat = async (ref: Ref, quoted: string) => tool("roadmap_out_of_scope").run({ expectedRevision: await revision(), ...ref, quoted }, ctx);
  const view = async (sessionId: string) => View.parse(ok(await tool("roadmap_get_session").run({ sessionId }, ctx)));
  const row = async (ref: Ref) => (await view(ref.sessionId)).questions.find((x) => x.question.id === ref.questionId)!;
  const entries = async (sessionId: string) => (await view(sessionId)).outOfScope ?? [];
  const resolve = async (link: string) => Resolved.parse(ok(await tool("roadmap_resolve_link").run({ link }, ctx)));
  const snapshot = async () => ({ revision: await revision(), text: canonicalJson(await stored()) });
  return { commands, revision, stored, storedQuestion, newSession, create, answer, markUi, markUiReason, markChat, view, row, entries, resolve, snapshot };
}

async function setup() {
  project = await makeProject();
  const dir = fakeDirectory({ projects: [{ projectId: P, projectRootPath: project.root, projectKind: "git" }] });
  const storeOptions = { now: fixedClock, newId: nextId, log: () => undefined };
  const commands = createRoadmapCommands({ directory: () => dir, now: fixedClock, newId: nextId, storeOptions });
  const open: StoreOpener = (projectId) => openProjectStore(dir, projectId, storeOptions);
  ok(await commands.init(open, { projectId: P }, UI_ORIGIN));
  return harness(commands, open, P, buildTools(commands));
}

const byRef = <T extends { ref: Ref }>(xs: T[]) => [...xs].sort((a, b) => refKey(a.ref).localeCompare(refKey(b.ref)));
const dependentsOf = (list: z.infer<typeof OutOfScopeEntry>[], ref: Ref) =>
  byRef(list.find((e) => e.ref.questionId === ref.questionId)?.dependents ?? []).map((d) => ({ ref: d.ref, number: d.number, status: d.status }));

describe("out of scope is the current outcome; the earlier answer is history", () => {
  it("an answered question marked out of scope shows no current answer, exposes the prior answer, and keeps the stored history", async () => {
    const h = await setup();
    const s = await h.newSession("Scope");
    const q = await h.create(s, "Export");
    await h.answer(q, "a");
    const storedBefore = await h.storedQuestion(q);
    ok(await h.markChat(q, "export is out of scope"));

    const r = await h.row(q);
    expect(r.status).toBe("out_of_scope");
    expect(r.currentAnswer).toBeUndefined();
    expect(r.priorAnswer).toMatchObject({ rev: 1, optionId: "a" });
    // Existing readers keep the stored shape: answer equals the latest revision; no revision added.
    expect(r.question.answer).toEqual(storedBefore.answer);
    expect(r.question.revisions).toEqual(storedBefore.revisions);
    const after = await h.storedQuestion(q);
    expect(after.answer).toEqual(storedBefore.answer);
    expect(after.revisions).toEqual(storedBefore.revisions);
  });

  it("the current-answer link resolves to the out-of-scope outcome, never to the old option; a pinned revision is history", async () => {
    const h = await setup();
    const s = await h.newSession("Scope");
    const q = await h.create(s, "Export");
    await h.answer(q, "a");
    ok(await h.markUi(q));
    const link = `roadmap://${P}/s/${s}/q/1/answer`;

    const current = await h.resolve(link);
    expect(current).toMatchObject({ kind: "answer", questionId: q.questionId, status: "out_of_scope", current: true });
    expect(current.answer).toBeUndefined();
    expect(current.currentRev).toBeUndefined();
    expect(current.priorAnswer).toMatchObject({ rev: 1, optionId: "a" });

    const pinned = await h.resolve(`${link}/r1`);
    expect(pinned).toMatchObject({ kind: "answer", pinnedRev: 1, current: false });
    expect(pinned.answer).toMatchObject({ rev: 1, optionId: "a" });
  });

  it("answering again after the mark makes the new answer current and ends the out-of-scope listing", async () => {
    const h = await setup();
    const s = await h.newSession("Scope");
    const q = await h.create(s, "Export");
    await h.answer(q, "a");
    ok(await h.markUi(q));
    await h.answer(q, "b");
    const r = await h.row(q);
    expect(r.status).toBe("answered");
    expect(r.currentAnswer).toMatchObject({ rev: 2, optionId: "b" });
    expect(r.priorAnswer).toBeUndefined();
    const current = await h.resolve(`roadmap://${P}/s/${s}/q/1/answer`);
    expect(current).toMatchObject({ currentRev: 2, current: true });
    expect(current.answer).toMatchObject({ rev: 2, optionId: "b" });
    expect((await h.entries(s)).map((e) => e.ref.questionId)).not.toContain(q.questionId);
  });

  it("an unanswered question marked out of scope has neither a current nor a prior answer", async () => {
    const h = await setup();
    const s = await h.newSession("Scope");
    const q = await h.create(s, "Never answered");
    ok(await h.markUi(q));
    const r = await h.row(q);
    expect(r.status).toBe("out_of_scope");
    expect(r.currentAnswer).toBeUndefined();
    expect(r.priorAnswer).toBeUndefined();
    const current = await h.resolve(`roadmap://${P}/s/${s}/q/1/answer`);
    expect(current).toMatchObject({ status: "out_of_scope", current: true });
    expect(current.answer).toBeUndefined();
    expect(current.priorAnswer).toBeUndefined();
  });

  it("answered and stale questions that are not out of scope present their answer as current", async () => {
    const h = await setup();
    const s = await h.newSession("Control");
    const up = await h.create(s, "Up");
    const down = await h.create(s, "Down", { invalidatedBy: [{ upstream: up }] });
    await h.answer(up, "a");
    await h.answer(down, "a");
    await h.answer(up, "b");
    const upRow = await h.row(up);
    expect(upRow.status).toBe("answered");
    expect(upRow.currentAnswer).toEqual(upRow.question.answer);
    expect(upRow.priorAnswer).toBeUndefined();
    const downRow = await h.row(down);
    expect(downRow.status).toBe("stale");
    expect(downRow.currentAnswer).toEqual(downRow.question.answer);
    expect(await h.entries(s)).toEqual([]);
  });
});

describe("every dependent of an out-of-scope question is listed for review", () => {
  it("lists activation children and invalidation downstream, transitively and across sessions, with numbers and statuses; hidden ones stay inactive", async () => {
    const h = await setup();
    const s = await h.newSession("Parent");
    const a = await h.create(s, "A");                                                       // Q1
    const b = await h.create(s, "B", { invalidatedBy: [{ upstream: a }] });                // Q2
    const c = await h.create(s, "C", { invalidatedBy: [{ upstream: b }] });                // Q3
    const d = await h.create(s, "D", { activatedBy: [{ parent: a, optionIds: ["a"] }] });  // Q4
    const e = await h.create(s, "E", { activatedBy: [{ parent: a, optionIds: ["b"] }] });  // Q5
    const other = await h.newSession("Other");
    const x = await h.create(other, "X", { invalidatedBy: [{ upstream: a }] });            // Q1 of Other
    await h.create(s, "Unrelated");                                                         // Q6
    for (const ref of [a, b, c, d, x]) await h.answer(ref, "a");
    const before = await h.stored();

    ok(await h.markUi(a));

    expect(dependentsOf(await h.entries(s), a)).toEqual(
      byRef([
        { ref: b, number: 2, status: "stale" },
        { ref: c, number: 3, status: "stale" },
        { ref: d, number: 4, status: "inactive" },
        { ref: e, number: 5, status: "inactive" },
        { ref: x, number: 1, status: "stale" },
      ]),
    );
    expect((await h.entries(s)).map((en) => ({ ref: en.ref, number: en.number }))).toEqual([{ ref: a, number: 1 }]);

    // Answered invalidation dependents become stale for review; every dependent keeps its answers
    // and history, hidden activation children are otherwise unchanged, and nothing is cancelled.
    const after = await h.stored();
    for (const ref of [b, c, d, e, x]) {
      const was = before.sessions.find((ss) => ss.id === ref.sessionId)!.questions.find((qq) => qq.id === ref.questionId)!;
      const now = after.sessions.find((ss) => ss.id === ref.sessionId)!.questions.find((qq) => qq.id === ref.questionId)!;
      expect({ answer: now.answer, revisions: now.revisions }, refKey(ref)).toEqual({ answer: was.answer, revisions: was.revisions });
    }
    for (const ref of [d, e]) {
      const was = before.sessions.find((ss) => ss.id === ref.sessionId)!.questions.find((qq) => qq.id === ref.questionId)!;
      expect(after.sessions.find((ss) => ss.id === ref.sessionId)!.questions.find((qq) => qq.id === ref.questionId), refKey(ref)).toEqual(was);
    }
    expect(after.meta.cancellations ?? []).toEqual([]);
  });

  it("an unanswered parent marked out of scope lists its dependents too", async () => {
    const h = await setup();
    const s = await h.newSession("Parent");
    const a = await h.create(s, "A");
    const b = await h.create(s, "B", { invalidatedBy: [{ upstream: a }] });
    const d = await h.create(s, "D", { activatedBy: [{ parent: a, optionIds: ["a"] }] });
    await h.answer(b, "a");
    ok(await h.markUi(a));
    expect(dependentsOf(await h.entries(s), a)).toEqual(
      byRef([
        { ref: b, number: 2, status: "stale" },
        { ref: d, number: 3, status: "inactive" },
      ]),
    );
  });

  it("an out-of-scope question without dependents is listed with an empty dependents list", async () => {
    const h = await setup();
    const s = await h.newSession("Lone");
    const a = await h.create(s, "A");
    ok(await h.markUi(a));
    const list = await h.entries(s);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ ref: a, number: 1, dependents: [] });
  });
});

describe("repeated marks, the revision guard and existing readers", () => {
  it("marking an out-of-scope question again changes neither its history nor the review listing", async () => {
    const h = await setup();
    const s = await h.newSession("Repeat");
    const a = await h.create(s, "A");
    const b = await h.create(s, "B", { invalidatedBy: [{ upstream: a }] });
    await h.answer(a, "a");
    await h.answer(b, "a");
    ok(await h.markUi(a));
    const storedOnce = await h.storedQuestion(a);
    const listOnce = await h.entries(s);
    const rowOnce = await h.row(a);

    // A repeat may be accepted as a no-op or refused as invalid input; either way nothing changes.
    const again = await h.markUi(a);
    if (!again.ok) expect(again.error.code).toBe("invalid_input");
    const storedTwice = await h.storedQuestion(a);
    expect({ answer: storedTwice.answer, revisions: storedTwice.revisions, validity: storedTwice.validity, stale: storedTwice.stale }).toEqual({
      answer: storedOnce.answer,
      revisions: storedOnce.revisions,
      validity: storedOnce.validity,
      stale: storedOnce.stale,
    });
    expect(await h.entries(s)).toEqual(listOnce);
    const rowTwice = await h.row(a);
    expect(rowTwice.priorAnswer).toEqual(rowOnce.priorAnswer);
    expect(rowTwice.currentAnswer).toBeUndefined();
    // Marking an already out-of-scope question is not a new outcome: no duplicate history event.
    expect(rowTwice.outOfScopeEvents ?? []).toHaveLength((rowOnce.outOfScopeEvents ?? []).length);
  });

  it("a mark with an out-of-date revision is revision_conflict and writes nothing", async () => {
    const h = await setup();
    const s = await h.newSession("Guard");
    const a = await h.create(s, "A");
    await h.answer(a, "a");
    const before = await h.snapshot();
    expect(err(await h.markUi(a, before.revision - 1)).code).toBe("revision_conflict");
    expect(await h.snapshot()).toEqual(before);
  });

  it("the v1 fixture reads with current answers for answered and stale questions, no out-of-scope entries, and no write", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "dr-oos-v1-")));
    roots.push(root);
    await cp(FIXTURE, join(root, ".decisions"), { recursive: true });
    const open: StoreOpener = async () => openStore({ storeRoot: root, projectId: FIXTURE_PID, now: fixedClock, newId: nextId, log: () => undefined });
    const commands = createRoadmapCommands({ directory: () => fakeDirectory({ projects: [] }), now: fixedClock, newId: nextId });
    const h = harness(commands, open, FIXTURE_PID, buildTools(commands));
    const before = await h.snapshot();
    for (const session of (await h.stored()).sessions) {
      const v = await h.view(session.id);
      for (const r of v.questions) {
        if (r.question.answer !== undefined && (r.status === "answered" || r.status === "stale")) expect(r.currentAnswer, r.question.id).toEqual(r.question.answer);
        expect(r.priorAnswer).toBeUndefined();
      }
      expect(v.outOfScope ?? []).toEqual([]);
    }
    expect(await h.snapshot()).toEqual(before);
  });
});

describe("an out-of-scope mark stays in the question's history after a later answer", () => {
  const QUOTE = "drop export, out of scope for this release";

  it("a UI mark is kept as an attributed event between the answer revisions, and the new answer becomes current", async () => {
    const h = await setup();
    const s = await h.newSession("History");
    const q = await h.create(s, "Export");
    await h.answer(q, "a");
    ok(await h.markUi(q));
    await h.answer(q, "b");

    const r = await h.row(q);
    expect(r.status).toBe("answered");
    expect(r.currentAnswer).toMatchObject({ rev: 2, optionId: "b" });
    expect(r.question.revisions.map((x) => x.optionId)).toEqual(["a", "b"]);
    expect(r.outOfScopeEvents).toHaveLength(1);
    expect(r.outOfScopeEvents![0]).toMatchObject({ source: "ui", actor: { kind: "human" }, afterRev: 1 });
  });

  it("a chat mark keeps the agent attribution and the human's quoted words after a later answer", async () => {
    const h = await setup();
    const s = await h.newSession("History");
    const q = await h.create(s, "Export");
    await h.answer(q, "a");
    ok(await h.markChat(q, QUOTE));
    await h.answer(q, "b");

    const events = (await h.row(q)).outOfScopeEvents ?? [];
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ source: "chat", actor: { kind: "agent", agentId: "agent-review" }, quoted: QUOTE, afterRev: 1 });
    expect((await h.storedQuestion(q)).revisions.map((x) => x.optionId)).toEqual(["a", "b"]);
  });

  it("a UI reason is kept with its event", async () => {
    const h = await setup();
    const s = await h.newSession("History");
    const q = await h.create(s, "Export");
    await h.answer(q, "a");
    ok(await h.markUiReason(q, "next release"));
    await h.answer(q, "b");
    expect((await h.row(q)).outOfScopeEvents?.[0]).toMatchObject({ source: "ui", reason: "next release", afterRev: 1 });
  });

  it("marks on an unanswered question and again after each later answer are each kept, in order", async () => {
    const h = await setup();
    const s = await h.newSession("History");
    const q = await h.create(s, "Export");
    ok(await h.markUi(q));
    await h.answer(q, "a");
    ok(await h.markChat(q, QUOTE));
    await h.answer(q, "b");

    const events = (await h.row(q)).outOfScopeEvents ?? [];
    expect(events.map((e) => ({ source: e.source, afterRev: e.afterRev }))).toEqual([
      { source: "ui", afterRev: undefined },
      { source: "chat", afterRev: 1 },
    ]);
    expect((await h.storedQuestion(q)).revisions.map((x) => x.optionId)).toEqual(["a", "b"]);
  });

  it("questions never marked out of scope carry no events, including legacy ones", async () => {
    const h = await setup();
    const s = await h.newSession("History");
    const q = await h.create(s, "Plain");
    await h.answer(q, "a");
    expect((await h.row(q)).outOfScopeEvents ?? []).toEqual([]);
  });
});
