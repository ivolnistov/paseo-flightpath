import { afterEach, describe, expect, it } from "vitest";
import type { Ref } from "../shared/model";
import { createRoadmapCommands, UI_ORIGIN, type QuestionBatchInput, type StoreOpener, type WriteOrigin } from "./sessions";
import { openProjectStore } from "./store-root";
import { fixedClock, nextId, opt } from "./test-support/build";
import { fakeDirectory } from "./test-support/fake-dir";
import { err, makeProject, ok, type TestProject } from "./test-support/service";

const P = "prj_test";
const ab = [opt("a"), opt("b")];
const chat = (quoted?: string): WriteOrigin => ({ source: "chat", actor: { kind: "agent" }, ...(quoted !== undefined ? { quoted } : {}) });

let project: TestProject;
afterEach(async () => {
  await project?.cleanup();
});

/** Initialised project with both the UI service and origin-aware commands over the same root. */
async function setup() {
  project = await makeProject();
  const dir = fakeDirectory({ projects: [{ projectId: P, projectRootPath: project.root, projectKind: "git" }] });
  const storeOptions = { now: fixedClock, newId: nextId, log: (m: string, e?: unknown) => void project.logs.push([m, e]) };
  const commands = createRoadmapCommands({ directory: () => dir, now: fixedClock, newId: nextId, storeOptions });
  const open: StoreOpener = (projectId) => openProjectStore(dir, projectId, storeOptions);
  const { service, paseo } = project;
  ok(await service.init(paseo, { projectId: P }));
  const revision = async () => ok(await service.version(paseo, { projectId: P })).revision!;
  const sessionId = ok(await service.sessionCreate(paseo, { projectId: P, expectedRevision: 1, title: "Origin" })).sessionId;
  // The only caller with extras passes a valid invalidatedBy.
  const create = async (title: string, extra: Partial<Parameters<typeof service.questionCreate>[1]> = {}) =>
    ok(
      await service.questionCreate(paseo, {
        projectId: P, expectedRevision: await revision(), sessionId, title, context: "", options: ab,
        allowFreeText: false, activatedBy: [], invalidatedBy: [], ...extra,
      }),
    ).questionId;
  const question = async (questionId: string) =>
    ok(await service.sessionGet(paseo, { projectId: P, sessionId })).questions.find((x) => x.question.id === questionId)!.question;
  const questionCount = async () => ok(await service.sessionGet(paseo, { projectId: P, sessionId })).questions.length;
  const answer = async (questionId: string, optionId: string, origin: WriteOrigin) =>
    commands.questionAnswer(open, { projectId: P, expectedRevision: await revision(), sessionId, questionId, optionId }, origin);
  return { service, paseo, commands, open, revision, sessionId, create, question, questionCount, answer };
}

describe("UI writes keep Stage 1 semantics", () => {
  it("the UI service records source ui, a human actor and no quoted text, one revision per mutation", async () => {
    const t = await setup();
    expect(await t.revision()).toBe(2);
    const q1 = await t.create("Root");
    expect(await t.revision()).toBe(3);
    const out = ok(await t.service.questionAnswer(t.paseo, { projectId: P, expectedRevision: 3, sessionId: t.sessionId, questionId: q1, optionId: "a" }));
    expect(out).toMatchObject({ revision: 4, rev: 1, valueChanged: true });
    ok(await t.service.questionDiscuss(t.paseo, { projectId: P, expectedRevision: 4, sessionId: t.sessionId, questionId: q1, text: "Note" }));
    const stored = await t.question(q1);
    expect(stored.revisions).toHaveLength(1);
    expect(stored.revisions[0]).toMatchObject({ source: "ui", actor: { kind: "human" } });
    expect("quoted" in stored.revisions[0]).toBe(false);
    expect(stored.discussion[0].actor).toEqual({ kind: "human" });
    expect(await t.revision()).toBe(5);
  });

  it("commands with UI_ORIGIN write exactly what the UI service writes", async () => {
    const t = await setup();
    const q1 = await t.create("Root");
    ok(await t.answer(q1, "b", UI_ORIGIN));
    const rev = (await t.question(q1)).revisions[0];
    expect(rev).toMatchObject({ source: "ui", actor: { kind: "human" }, optionId: "b" });
    expect("quoted" in rev).toBe(false);
  });
});

describe("chat writes", () => {
  it("a quoted chat answer stores source chat, an agent actor without agentId and the quote", async () => {
    const t = await setup();
    const q1 = await t.create("Root");
    ok(await t.answer(q1, "b", chat("Use B")));
    const rev = (await t.question(q1)).revisions[0];
    expect(rev).toMatchObject({ source: "chat", actor: { kind: "agent" }, quoted: "Use B", optionId: "b" });
    expect(rev.actor).toEqual({ kind: "agent" });
    expect("agentId" in rev.actor).toBe(false);
  });

  it("a chat answer with empty or missing quoted text is invalid_input and writes nothing", async () => {
    const t = await setup();
    const q1 = await t.create("Root");
    const before = await t.revision();
    expect(err(await t.answer(q1, "a", chat(""))).code).toBe("invalid_input");
    expect(err(await t.answer(q1, "a", chat())).code).toBe("invalid_input");
    expect(await t.revision()).toBe(before);
    expect((await t.question(q1)).revisions).toEqual([]);
  });

  it("a chat confirm on a stale question requires quoted text; chat discussion notes have an agent actor", async () => {
    const t = await setup();
    const q1 = await t.create("Root");
    const q3 = await t.create("Dependent", { invalidatedBy: [{ upstream: { sessionId: t.sessionId, questionId: q1 } }] });
    ok(await t.answer(q1, "a", UI_ORIGIN));
    ok(await t.answer(q3, "a", UI_ORIGIN));
    ok(await t.answer(q1, "b", UI_ORIGIN));
    expect((await t.question(q3)).validity).toBe("stale");

    const confirm = async (origin: WriteOrigin) =>
      t.commands.questionConfirm(t.open, { projectId: P, expectedRevision: await t.revision(), sessionId: t.sessionId, questionId: q3 }, origin);
    const before = await t.revision();
    expect(err(await confirm(chat())).code).toBe("invalid_input");
    expect(err(await confirm(chat(""))).code).toBe("invalid_input");
    expect(await t.revision()).toBe(before);
    expect((await t.question(q3)).validity).toBe("stale");

    ok(await confirm(chat("Still A")));
    const confirmed = await t.question(q3);
    expect(confirmed.validity).toBe("valid");
    expect(confirmed.revisions[1]).toMatchObject({ rev: 2, optionId: "a", source: "chat", actor: { kind: "agent" }, quoted: "Still A" });

    ok(
      await t.commands.questionDiscuss(
        t.open,
        { projectId: P, expectedRevision: await t.revision(), sessionId: t.sessionId, questionId: q3, text: "Agent note" },
        chat(),
      ),
    );
    const note = (await t.question(q3)).discussion.at(-1)!;
    expect(note.text).toBe("Agent note");
    expect(note.actor).toEqual({ kind: "agent" });
    expect("agentId" in note.actor).toBe(false);
  });
});

describe("questionCreateBatch", () => {
  const item = (title: string, extra: Partial<QuestionBatchInput["questions"][number]> = {}): QuestionBatchInput["questions"][number] => ({
    title, context: "", options: ab, allowFreeText: false, activatedBy: [], invalidatedBy: [], ...extra,
  });
  const batch = async (t: Awaited<ReturnType<typeof setup>>, questions: QuestionBatchInput["questions"]) =>
    t.commands.questionCreateBatch(t.open, { projectId: P, expectedRevision: await t.revision(), sessionId: t.sessionId, questions }, chat());

  it("creates items with backward batch refs and existing refs in one revision step", async () => {
    const t = await setup();
    const existing = await t.create("Existing");
    const E: Ref = { sessionId: t.sessionId, questionId: existing };
    const before = await t.revision();
    const out = ok(
      await batch(t, [
        item("First"),
        item("Second", { activatedBy: [{ parent: { batchIndex: 0 }, optionIds: ["a"] }] }),
        item("Third", { invalidatedBy: [{ upstream: { batchIndex: 1 } }, { upstream: E }] }),
      ]),
    );
    expect(out.revision).toBe(before + 1);
    expect(await t.revision()).toBe(before + 1);
    expect(out.questionIds).toHaveLength(3);
    expect(new Set([existing, ...out.questionIds]).size).toBe(4);
    const [i0, i1, i2] = out.questionIds;
    const view = ok(await t.service.sessionGet(t.paseo, { projectId: P, sessionId: t.sessionId }));
    expect(view.questions.map((x) => x.question.id)).toEqual([existing, i0, i1, i2]);
    expect(view.questions.map((x) => x.question.title)).toEqual(["Existing", "First", "Second", "Third"]);
    expect((await t.question(i1)).activatedBy).toEqual([{ parent: { sessionId: t.sessionId, questionId: i0 }, optionIds: ["a"] }]);
    expect((await t.question(i2)).invalidatedBy).toEqual([{ upstream: { sessionId: t.sessionId, questionId: i1 } }, { upstream: E }]);
    expect(out.visibilityChanged).toContainEqual({ sessionId: t.sessionId, questionId: i1 });
  });

  it("a batchIndex pointing forward or at itself is invalid_input and writes nothing", async () => {
    const t = await setup();
    const before = await t.revision();
    for (const questions of [
      [item("A", { activatedBy: [{ parent: { batchIndex: 1 }, optionIds: ["a"] }] }), item("B")],
      [item("A"), item("B", { invalidatedBy: [{ upstream: { batchIndex: 1 } }] })],
    ]) {
      expect(err(await batch(t, questions)).code).toBe("invalid_input");
      expect(await t.revision()).toBe(before);
      expect(await t.questionCount()).toBe(0);
    }
  });

  it("an unknown option in the third item's activation rolls back the whole batch", async () => {
    const t = await setup();
    const before = await t.revision();
    const out = await batch(t, [item("A"), item("B"), item("C", { activatedBy: [{ parent: { batchIndex: 0 }, optionIds: ["zzz"] }] })]);
    expect(err(out).code).toBe("unresolved_ref");
    expect(await t.revision()).toBe(before);
    expect(await t.questionCount()).toBe(0);
  });

  it("a missing existing-looking parent ref is unresolved_ref and writes nothing", async () => {
    const t = await setup();
    const before = await t.revision();
    const out = await batch(t, [item("A"), item("B", { activatedBy: [{ parent: { sessionId: t.sessionId, questionId: "nope" }, optionIds: ["a"] }] })]);
    expect(err(out).code).toBe("unresolved_ref");
    expect(await t.revision()).toBe(before);
    expect(await t.questionCount()).toBe(0);
  });
});
