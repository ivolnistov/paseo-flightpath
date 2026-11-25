// What the owner and the agent read on a dependent of an out-of-scope question in another session:
// the stale cause text names the parent as gone out of scope (an answer change keeps the revision
// text), and the dependent's own row names its out-of-scope upstream questions with their numbers.
import { afterEach, describe, expect, it } from "vitest";
import { refKey, type Question, type Ref } from "../shared/model";
import { staleCauseText } from "../client/layout";
import { createRoadmapCommands, UI_ORIGIN, type StoreOpener } from "./sessions";
import { openProjectStore } from "./store-root";
import { fixedClock, nextId, opt } from "./test-support/build";
import { fakeDirectory } from "./test-support/fake-dir";
import { makeProject, ok, type TestProject } from "./test-support/service";

const P = "prj_test";
const ab = [opt("a"), opt("b")];

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
  const newSession = async (title: string) => ok(await commands.sessionCreate(open, { ...(await at()), title }, UI_ORIGIN)).sessionId;
  const create = async (sessionId: string, title: string, invalidatedBy: Question["invalidatedBy"] = []): Promise<Ref> => ({
    sessionId,
    questionId: ok(await commands.questionCreate(open, { ...(await at()), sessionId, title, context: "", options: ab, allowFreeText: false, activatedBy: [], invalidatedBy }, UI_ORIGIN)).questionId,
  });
  const answer = async (ref: Ref, optionId: string) => ok(await commands.questionAnswer(open, { ...(await at()), ...ref, optionId }, UI_ORIGIN));
  const mark = async (ref: Ref) => ok(await commands.questionOutOfScope(open, { ...(await at()), ...ref }, UI_ORIGIN));
  const view = async (sessionId: string) => ok(await commands.sessionGet(open, { projectId: P, sessionId }, UI_ORIGIN));
  const rowOf = async (ref: Ref) => {
    const v = await view(ref.sessionId);
    return { v, row: v.questions.find((x) => x.question.id === ref.questionId)! };
  };
  return { newSession, create, answer, mark, view, rowOf };
}

describe("a dependent in another session", () => {
  it("reads 'went out of scope' as its stale cause and lists the out-of-scope upstream with its number", async () => {
    const t = await setup();
    const s = await t.newSession("Parent");
    await t.create(s, "Earlier");
    const parent = await t.create(s, "Export format");
    const other = await t.newSession("Child");
    const child = await t.create(other, "Export button", [{ upstream: parent }]);
    await t.answer(parent, "a");
    await t.answer(child, "a");
    await t.mark(parent);

    const { v, row } = await t.rowOf(child);
    expect(row.status).toBe("stale");
    expect(staleCauseText(row, v)).toBe("Stale: Export format went out of scope");
    expect(row.outOfScopeUpstream).toEqual([{ ref: parent, number: 2 }]);
  });

  it("an answer change keeps the revision wording", async () => {
    const t = await setup();
    const s = await t.newSession("Parent");
    const parent = await t.create(s, "Export format");
    const other = await t.newSession("Child");
    const child = await t.create(other, "Export button", [{ upstream: parent }]);
    await t.answer(parent, "a");
    await t.answer(child, "a");
    await t.answer(parent, "b");
    const { v, row } = await t.rowOf(child);
    expect(staleCauseText(row, v)).toBe("Stale: Export format changed (rev 2)");
    expect(row.outOfScopeUpstream).toBeUndefined();
  });

  it("names every out-of-scope upstream, from its own and from another session", async () => {
    const t = await setup();
    const s = await t.newSession("Parent");
    const remote = await t.create(s, "Remote parent");
    const other = await t.newSession("Child");
    const local = await t.create(other, "Local parent");
    const child = await t.create(other, "Child", [{ upstream: remote }, { upstream: local }]);
    for (const ref of [remote, local, child]) await t.answer(ref, "a");
    await t.mark(remote);
    await t.mark(local);
    const { row } = await t.rowOf(child);
    const upstream = [...(row.outOfScopeUpstream ?? [])].sort((a, b) => refKey(a.ref).localeCompare(refKey(b.ref)));
    expect(upstream).toEqual([{ ref: remote, number: 1 }, { ref: local, number: 1 }].sort((a, b) => refKey(a.ref).localeCompare(refKey(b.ref))));
  });

  it("the upstream listing ends when the parent is answered again", async () => {
    const t = await setup();
    const s = await t.newSession("Parent");
    const parent = await t.create(s, "Export format");
    const other = await t.newSession("Child");
    const child = await t.create(other, "Export button", [{ upstream: parent }]);
    await t.answer(parent, "a");
    await t.answer(child, "a");
    await t.mark(parent);
    await t.answer(parent, "a");
    expect((await t.rowOf(child)).row.outOfScopeUpstream).toBeUndefined();
  });
});
