// question.create with an optional first free-text answer: the question and its revision 1 text
// answer are written in one transaction through the shared answer rules (source ui, the human
// actor), or nothing is written. Only the owner's UI may send the answer. Placement, frozen-block,
// revision and legacy rules stay as for a plain create. Commands run over real temp stores.
//
// Inputs are built by functions, so the extra `answerText` field type-checks before and after the
// contract gains it; new output and stored fields are read with matchers, not typed properties.
import { afterEach, describe, expect, it } from "vitest";
import { canonicalJson } from "../shared/canonical";
import type { Activation, Option } from "../shared/model";
import { createRoadmapCommands, UI_ORIGIN, type StoreOpener, type WriteOrigin } from "./sessions";
import { openProjectStore } from "./store-root";
import { fixedClock, NOW_ISO, nextId, opt } from "./test-support/build";
import { fakeDirectory } from "./test-support/fake-dir";
import { BLK_NEXT, BLK_OPEN, blocksFor, seedGrilling } from "./test-support/grilling";
import { err, makeProject, ok, type TestProject } from "./test-support/service";

const P = "prj_test";
const ANSWER = "Use the existing Postgres cluster.\nKeep the read replica.";
const CHAT: WriteOrigin = { source: "chat", actor: { kind: "agent", agentId: "agent-planner-1" } };

let project: TestProject | undefined;
afterEach(async () => {
  await project?.cleanup();
  project = undefined;
});

interface CreateFields {
  title: string;
  options?: Option[];
  allowFreeText?: boolean;
  context?: string;
  recommendedOptionId?: string;
  activatedBy?: Activation[];
  blockId?: string;
  answerText?: string;
}

async function setup() {
  project = await makeProject();
  const dir = fakeDirectory({ projects: [{ projectId: P, projectRootPath: project.root, projectKind: "git" }] });
  const storeOptions = { now: fixedClock, newId: nextId, log: () => undefined };
  const commands = createRoadmapCommands({ directory: () => dir, now: fixedClock, newId: nextId, storeOptions });
  const open: StoreOpener = (projectId) => openProjectStore(dir, projectId, storeOptions);
  ok(await commands.init(open, { projectId: P }, UI_ORIGIN));
  const revision = async () => ok(await commands.version(open, { projectId: P }, UI_ORIGIN)).revision!;
  const data = async () => {
    const read = await (await open(P)).read();
    if (read.status !== "ok") throw new Error(`expected ok store, got ${read.status}`);
    return read.data;
  };
  const snapshot = async () => ({ revision: await revision(), text: canonicalJson(await data()) });
  const newSession = async (title = "Create with answer") =>
    ok(await commands.sessionCreate(open, { projectId: P, expectedRevision: await revision(), title }, UI_ORIGIN)).sessionId;
  /** The add-question form's request by default: no options, free text allowed, no context, no relations. */
  const input = (sessionId: string, expectedRevision: number, f: CreateFields) => ({
    projectId: P,
    expectedRevision,
    sessionId,
    title: f.title,
    context: f.context ?? "",
    options: f.options ?? [],
    allowFreeText: f.allowFreeText ?? true,
    ...(f.recommendedOptionId !== undefined ? { recommendedOptionId: f.recommendedOptionId } : {}),
    activatedBy: f.activatedBy ?? [],
    invalidatedBy: [],
    ...(f.blockId !== undefined ? { blockId: f.blockId } : {}),
    ...(f.answerText !== undefined ? { answerText: f.answerText } : {}),
  });
  const create = async (sessionId: string, f: CreateFields, origin: WriteOrigin = UI_ORIGIN, expectedRevision?: number) =>
    commands.questionCreate(open, input(sessionId, expectedRevision ?? (await revision()), f), origin);
  const stored = async (sessionId: string) => {
    const s = (await data()).sessions.find((x) => x.id === sessionId);
    if (s === undefined) throw new Error(`session ${sessionId} not found`);
    return s;
  };
  const storedQuestion = async (sessionId: string, questionId: string) => {
    const q = (await stored(sessionId)).questions.find((x) => x.id === questionId);
    if (q === undefined) throw new Error(`question ${questionId} not found`);
    return q;
  };
  const view = async (sessionId: string) => ok(await commands.sessionGet(open, { projectId: P, sessionId }, UI_ORIGIN));
  /** A session with blocks: Q1 (options a/b, no free text) in the open block. */
  const blockSession = async () => {
    const sessionId = await newSession();
    const q1 = ok(await create(sessionId, { title: "Which database?", options: [opt("a"), opt("b")], allowFreeText: false, blockId: BLK_OPEN })).questionId;
    return { sessionId, q1 };
  };
  return { commands, open, revision, data, snapshot, newSession, create, stored, storedQuestion, view, blockSession };
}

type T = Awaited<ReturnType<typeof setup>>;

async function expectNoWrite(t: T, before: { revision: number; text: string }) {
  expect(await t.snapshot()).toEqual(before);
}

describe("question.create with answerText", () => {
  it("writes the question with the given fields and a revision 1 text answer from the UI and the human actor, in one revision bump", async () => {
    const t = await setup();
    const { sessionId } = await t.blockSession();
    const before = await t.revision();
    const out = ok(await t.create(sessionId, { title: "Where do sessions live?", blockId: BLK_OPEN, answerText: ANSWER }));
    expect(out.revision).toBe(before + 1);
    expect(await t.revision()).toBe(before + 1);
    expect(out).toMatchObject({ rev: 1 });

    const q = await t.storedQuestion(sessionId, out.questionId);
    expect(q).toMatchObject({ title: "Where do sessions live?", context: "", options: [], allowFreeText: true, blockId: BLK_OPEN, activatedBy: [], invalidatedBy: [] });
    expect(q.revisions).toEqual([{ rev: 1, text: ANSWER, source: "ui", actor: { kind: "human" }, at: NOW_ISO }]);
    expect(q.answer).toEqual(q.revisions[0]);
    expect(q.validity).toBe("valid");

    const v = (await t.view(sessionId)).questions.find((x) => x.question.id === out.questionId);
    expect(v).toMatchObject({ visibility: "active", status: "answered" });
  });

  it("without answerText the question is unanswered and the output carries no rev", async () => {
    const t = await setup();
    const { sessionId } = await t.blockSession();
    const before = await t.revision();
    const out = ok(await t.create(sessionId, { title: "Where do sessions live?", blockId: BLK_OPEN }));
    expect(out.revision).toBe(before + 1);
    expect(out).not.toHaveProperty("rev");
    const q = await t.storedQuestion(sessionId, out.questionId);
    expect(q.answer).toBeUndefined();
    expect(q.revisions).toEqual([]);
    expect(q.validity).toBe("unanswered");
  });

  it("stores options, the recommendation and the context as sent alongside the text answer (positive control with options)", async () => {
    const t = await setup();
    const { sessionId } = await t.blockSession();
    const options = [opt("x"), { id: "y", label: "Option y", description: "Because y is cheaper." }];
    const out = ok(
      await t.create(sessionId, {
        title: "Which queue?",
        context: "We already run one broker.",
        options,
        recommendedOptionId: "y",
        allowFreeText: true,
        blockId: BLK_OPEN,
        answerText: "Neither: a cron job is enough.",
      }),
    );
    expect(out).toMatchObject({ rev: 1 });
    const q = await t.storedQuestion(sessionId, out.questionId);
    expect(q).toMatchObject({ title: "Which queue?", context: "We already run one broker.", options, recommendedOptionId: "y", allowFreeText: true });
    expect(q.answer).toMatchObject({ rev: 1, text: "Neither: a cron job is enough.", source: "ui", actor: { kind: "human" } });
    expect(q.answer).not.toHaveProperty("optionId");
    expect(q.answer).not.toHaveProperty("defaulted");
  });

  it("answerText on a question without free text is refused by the answer rules and nothing is written (no half-written pair)", async () => {
    const t = await setup();
    const { sessionId } = await t.blockSession();
    const before = await t.snapshot();
    const res = await t.create(sessionId, { title: "Which region?", options: [opt("eu"), opt("us")], allowFreeText: false, blockId: BLK_OPEN, answerText: "eu-west" });
    expect(err(res).code).toBe("invalid_input");
    await expectNoWrite(t, before);
  });

  it("answerText on a question created inactive (its activation option is not chosen) is question_inactive and nothing is written", async () => {
    const t = await setup();
    const { sessionId, q1 } = await t.blockSession();
    ok(await t.commands.questionAnswer(t.open, { projectId: P, expectedRevision: await t.revision(), sessionId, questionId: q1, optionId: "a" }, UI_ORIGIN));
    const before = await t.snapshot();
    const res = await t.create(sessionId, {
      title: "Which replica count?",
      activatedBy: [{ parent: { sessionId, questionId: q1 }, optionIds: ["b"] }],
      blockId: BLK_OPEN,
      answerText: "Two",
    });
    expect(err(res).code).toBe("question_inactive");
    await expectNoWrite(t, before);
  });

  it("answerText on a question activated by the chosen option is written and the question is active and answered", async () => {
    const t = await setup();
    const { sessionId, q1 } = await t.blockSession();
    ok(await t.commands.questionAnswer(t.open, { projectId: P, expectedRevision: await t.revision(), sessionId, questionId: q1, optionId: "b" }, UI_ORIGIN));
    const out = ok(
      await t.create(sessionId, {
        title: "Which replica count?",
        activatedBy: [{ parent: { sessionId, questionId: q1 }, optionIds: ["b"] }],
        blockId: BLK_OPEN,
        answerText: "Two",
      }),
    );
    expect(out).toMatchObject({ rev: 1 });
    const v = (await t.view(sessionId)).questions.find((x) => x.question.id === out.questionId);
    expect(v).toMatchObject({ visibility: "active", status: "answered" });
  });

  it("answerText from a chat origin is invalid_input and nothing is written", async () => {
    const t = await setup();
    const { sessionId } = await t.blockSession();
    const before = await t.snapshot();
    for (const origin of [CHAT, { ...CHAT, quoted: "Use Postgres" }, { source: "chat", actor: { kind: "agent" } } satisfies WriteOrigin]) {
      expect(err(await t.create(sessionId, { title: "Where do sessions live?", blockId: BLK_OPEN, answerText: ANSWER }, origin)).code).toBe("invalid_input");
    }
    await expectNoWrite(t, before);
  });

  it("a chat origin without answerText still creates the question as before (positive control)", async () => {
    const t = await setup();
    const { sessionId } = await t.blockSession();
    const out = ok(await t.create(sessionId, { title: "Where do sessions live?", blockId: BLK_OPEN }, CHAT));
    expect((await t.storedQuestion(sessionId, out.questionId)).answer).toBeUndefined();
  });
});

describe("question.create with answerText keeps the placement, frozen and revision rules", () => {
  it("into an accepted block it is block_frozen and nothing is written; into the next open block it succeeds", async () => {
    const t = await setup();
    const { sessionId } = await t.blockSession();
    await seedGrilling(t.open, P, sessionId, { blocks: blocksFor(true) });
    const before = await t.snapshot();
    expect(err(await t.create(sessionId, { title: "Late question", blockId: BLK_OPEN, answerText: ANSWER })).code).toBe("block_frozen");
    await expectNoWrite(t, before);

    const out = ok(await t.create(sessionId, { title: "Late question", blockId: BLK_NEXT, answerText: ANSWER }));
    expect(out).toMatchObject({ rev: 1 });
    expect(await t.storedQuestion(sessionId, out.questionId)).toMatchObject({ blockId: BLK_NEXT, answer: { rev: 1, text: ANSWER } });
  });

  it("a stale expectedRevision is revision_conflict and nothing is written", async () => {
    const t = await setup();
    const { sessionId } = await t.blockSession();
    const before = await t.snapshot();
    const res = await t.create(sessionId, { title: "Where do sessions live?", blockId: BLK_OPEN, answerText: ANSWER }, UI_ORIGIN, before.revision - 1);
    expect(err(res).code).toBe("revision_conflict");
    await expectNoWrite(t, before);
  });

  it("a legacy session without blocks gains no blocks; the question is created as before, with the text answer when given", async () => {
    const t = await setup();
    const sessionId = await t.newSession("Legacy");
    const plain = ok(await t.create(sessionId, { title: "Legacy without answer" }));
    expect((await t.storedQuestion(sessionId, plain.questionId)).answer).toBeUndefined();

    const answered = ok(await t.create(sessionId, { title: "Legacy with answer", answerText: ANSWER }));
    expect(answered).toMatchObject({ rev: 1 });
    const s = await t.stored(sessionId);
    expect(s).not.toHaveProperty("blocks");
    expect(s.questions.find((q) => q.id === answered.questionId)).toMatchObject({ answer: { rev: 1, text: ANSWER, source: "ui", actor: { kind: "human" } } });
    expect(s.questions.find((q) => q.id === answered.questionId)).not.toHaveProperty("blockId");
  });
});

describe("derived state after question.create with answerText", () => {
  it("the open-block summary preview shows the new answer as Q<n> text: with indented lines", async () => {
    const t = await setup();
    const { sessionId } = await t.blockSession();
    const out = ok(await t.create(sessionId, { title: "Where do sessions live?", blockId: BLK_OPEN, answerText: ANSWER }));
    const n = (await t.view(sessionId)).questions.find((x) => x.question.id === out.questionId)?.number;
    expect(n).toBe(2);
    const preview = (await t.view(sessionId)).openBlockPreview;
    expect(preview).toContain("Q1 unanswered");
    expect(preview).toContain("Q2 text:\n  Use the existing Postgres cluster.\n  Keep the read replica.");
  });

  it("visibilityChanged reports the same questions as a create without answerText", async () => {
    const plainRun = await setup();
    const a = await plainRun.blockSession();
    const plain = ok(await plainRun.create(a.sessionId, { title: "Where do sessions live?", blockId: BLK_OPEN }));
    await project?.cleanup();
    project = undefined;

    const answerRun = await setup();
    const b = await answerRun.blockSession();
    const answered = ok(await answerRun.create(b.sessionId, { title: "Where do sessions live?", blockId: BLK_OPEN, answerText: ANSWER }));
    const ids = (refs: Array<{ questionId: string }>, own: string) => refs.map((r) => (r.questionId === own ? "new" : "other"));
    expect(ids(answered.visibilityChanged, answered.questionId)).toEqual(ids(plain.visibilityChanged, plain.questionId));
  });
});
