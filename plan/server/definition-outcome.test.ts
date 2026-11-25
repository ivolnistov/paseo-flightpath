// Editing the definition of a skipped or out-of-scope question (for example removing the option it
// was once answered with) keeps the owner's explicit outcome, the answer history and any review
// marker: the earlier answer is never brought back as a stale answer, and the edit does not fail.
// An answered question still becomes stale when its chosen option is removed (control).
import { afterEach, describe, expect, it } from "vitest";
import type { Question, Ref, RoadmapData } from "../shared/model";
import { createRoadmapCommands, UI_ORIGIN, type StoreOpener } from "./sessions";
import { openProjectStore } from "./store-root";
import { fixedClock, nextId, opt } from "./test-support/build";
import { fakeDirectory } from "./test-support/fake-dir";
import { makeProject, ok, type TestProject } from "./test-support/service";

const P = "prj_test";
const abc = [opt("a"), opt("b"), opt("c")];

let project: TestProject | undefined;
afterEach(async () => {
  await project?.cleanup();
  project = undefined;
});

async function setup() {
  project = await makeProject();
  const dir = fakeDirectory({ projects: [{ projectId: P, projectRootPath: project.root, projectKind: "git" }] });
  const storeOptions = { now: fixedClock, newId: nextId, log: () => undefined };
  const commands = createRoadmapCommands({ directory: () => dir, now: fixedClock, newId: nextId, storeOptions });
  const open: StoreOpener = (projectId) => openProjectStore(dir, projectId, storeOptions);
  ok(await commands.init(open, { projectId: P }, UI_ORIGIN));
  const at = async () => ({ projectId: P, expectedRevision: ok(await commands.version(open, { projectId: P }, UI_ORIGIN)).revision! });
  const data = async (): Promise<RoadmapData> => {
    const read = await (await open(P)).read();
    if (read.status !== "ok") throw new Error("store not ok");
    return read.data;
  };
  const stored = async (ref: Ref): Promise<Question> => (await data()).sessions.find((s) => s.id === ref.sessionId)!.questions.find((q) => q.id === ref.questionId)!;
  const sessionId = ok(await commands.sessionCreate(open, { ...(await at()), title: "Definitions" }, UI_ORIGIN)).sessionId;
  const create = async (title: string, invalidatedBy: Question["invalidatedBy"] = [], allowFreeText = false): Promise<Ref> => ({
    sessionId,
    questionId: ok(await commands.questionCreate(open, { ...(await at()), sessionId, title, context: "", options: abc, allowFreeText, activatedBy: [], invalidatedBy }, UI_ORIGIN)).questionId,
  });
  const answer = async (ref: Ref, a: { optionId?: string; text?: string }) => ok(await commands.questionAnswer(open, { ...(await at()), ...ref, ...a }, UI_ORIGIN));
  const update = async (ref: Ref, patch: Record<string, unknown>) => commands.questionUpdate(open, { ...(await at()), ...ref, patch }, UI_ORIGIN);
  return { commands, open, at, data, stored, create, answer, update };
}

describe("a definition edit on a question with an explicit outcome", () => {
  it("a skipped question keeps its outcome and history when its earlier option is removed", async () => {
    const t = await setup();
    const q = await t.create("Skipped");
    await t.answer(q, { optionId: "a" });
    ok(await t.commands.questionSkip(t.open, { ...(await t.at()), ...q }, UI_ORIGIN));
    const before = await t.stored(q);
    ok(await t.update(q, { options: [opt("b"), opt("c")] }));
    const after = await t.stored(q);
    expect(after.validity).toBe("skipped");
    expect(after.stale).toBeUndefined();
    expect(after.answer).toEqual(before.answer);
    expect(after.revisions).toEqual(before.revisions);
    expect(after.definitionRev).toBe(before.definitionRev + 1);
  });

  it("an out-of-scope question keeps its outcome, history and events when its earlier option is removed", async () => {
    const t = await setup();
    const q = await t.create("Out of scope");
    await t.answer(q, { optionId: "a" });
    ok(await t.commands.questionOutOfScope(t.open, { ...(await t.at()), ...q }, UI_ORIGIN));
    const before = await t.stored(q);
    const marks = (await t.data()).meta.outOfScopeMarks;
    ok(await t.update(q, { options: [opt("b"), opt("c")] }));
    const after = await t.stored(q);
    expect(after.validity).toBe("out_of_scope");
    expect(after.stale).toBeUndefined();
    expect(after.revisions).toEqual(before.revisions);
    expect((await t.data()).meta.outOfScopeMarks).toEqual(marks);
  });

  it("a skipped free-text answer keeps the outcome when free text is turned off", async () => {
    const t = await setup();
    const q = await t.create("Free text", [], true);
    await t.answer(q, { text: "my words" });
    ok(await t.commands.questionSkip(t.open, { ...(await t.at()), ...q }, UI_ORIGIN));
    ok(await t.update(q, { allowFreeText: false }));
    expect((await t.stored(q)).validity).toBe("skipped");
  });

  it("a review marker survives the edit, which does not fail", async () => {
    const t = await setup();
    const parent = await t.create("Parent");
    const q = await t.create("Skipped under review", [{ upstream: parent }]);
    await t.answer(parent, { optionId: "a" });
    await t.answer(q, { optionId: "a" });
    ok(await t.commands.questionSkip(t.open, { ...(await t.at()), ...q }, UI_ORIGIN));
    await t.answer(parent, { optionId: "b" });
    const review = (await t.stored(q)).review;
    expect(review).toBeDefined();
    const out = await t.update(q, { options: [opt("b"), opt("c")] });
    expect(out.ok, out.ok ? "" : `${out.error.code}: ${out.error.message}`).toBe(true);
    const after = await t.stored(q);
    expect(after.validity).toBe("skipped");
    expect(after.review).toEqual(review);
  });

  it("control: an answered question still becomes stale when its chosen option is removed", async () => {
    const t = await setup();
    const q = await t.create("Answered");
    await t.answer(q, { optionId: "a" });
    ok(await t.update(q, { options: [opt("b"), opt("c")] }));
    expect((await t.stored(q)).validity).toBe("stale");
  });
});
