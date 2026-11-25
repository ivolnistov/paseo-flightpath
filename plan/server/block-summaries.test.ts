// Block summaries in the session view: for every accepted block the summary at acceptance (the text
// the chat was given) next to the current one, with the numbers whose lines changed since; a preview
// of the open block; and, for every cancellation, the decisions that depend on it (activation
// children and invalidation downstream, transitively, across sessions) for the agent to cancel or
// re-ask. All derived on read over real temp stores; the read fields are parsed with local schemas.
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { refKey, type Question, type Ref } from "../shared/model";
import { createRoadmapCommands, UI_ORIGIN, type StoreOpener, type WriteOrigin } from "./sessions";
import { openProjectStore } from "./store-root";
import { buildBlockSummary } from "./summary";
import { fixedClock, nextId, opt } from "./test-support/build";
import { fakeDirectory } from "./test-support/fake-dir";
import { binding, BLK_OPEN, continuationIn, seedGrilling } from "./test-support/grilling";
import { makeProject, ok, type TestProject } from "./test-support/service";

const P = "prj_test";
const ab = [opt("a"), opt("b")];
const CHAT: WriteOrigin = { source: "chat", actor: { kind: "agent" } };

const RefS = z.object({ sessionId: z.string(), questionId: z.string() });
const DependentS = z.union([RefS, z.looseObject({ ref: RefS })]);
const SummaryS = z.looseObject({
  blockId: z.string(),
  acceptedSummary: z.string(),
  currentSummary: z.string(),
  changedSinceAcceptance: z.boolean(),
  changed: z.array(z.number().int()),
});
const ViewS = z.looseObject({
  session: z.looseObject({ blocks: z.array(z.looseObject({ id: z.string(), state: z.string(), summary: z.string().optional() })).optional() }),
  cancellations: z.array(z.looseObject({ ref: RefS, dependents: z.array(DependentS) })),
  summaries: z.array(SummaryS).optional(),
  openBlockPreview: z.string().optional(),
});
const refOf = (d: z.infer<typeof DependentS>): Ref => ("ref" in d ? d.ref : d);
const sortRefs = (refs: Ref[]) => [...refs].sort((a, b) => refKey(a).localeCompare(refKey(b)));

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
  const revision = async () => ok(await commands.version(open, { projectId: P }, UI_ORIGIN)).revision!;
  const at = async () => ({ projectId: P, expectedRevision: await revision() });
  const data = async () => {
    const read = await (await open(P)).read();
    if (read.status !== "ok") throw new Error(`expected ok store, got ${read.status}`);
    return read.data;
  };
  const newSession = async (title = "Summaries") => ok(await commands.sessionCreate(open, { ...(await at()), title }, UI_ORIGIN)).sessionId;
  const batch = async (sessionId: string, blockId: string, titles: string[], extra: Array<Partial<Pick<Question, "activatedBy" | "invalidatedBy">>> = []) =>
    ok(
      await commands.questionCreateBatch(
        open,
        { ...(await at()), sessionId, blockId, questions: titles.map((title, i) => ({ title, context: "", options: ab, allowFreeText: false, activatedBy: [], invalidatedBy: [], ...(extra[i] ?? {}) })) },
        CHAT,
      ),
    ).questionIds;
  const legacy = async (sessionId: string, title: string, extra: Partial<Pick<Question, "activatedBy" | "invalidatedBy">> = {}): Promise<Ref> => ({
    sessionId,
    questionId: ok(await commands.questionCreate(open, { ...(await at()), sessionId, title, context: "", options: ab, allowFreeText: false, activatedBy: [], invalidatedBy: [], ...extra }, UI_ORIGIN)).questionId,
  });
  const answer = async (sessionId: string, questionId: string, optionId: string) =>
    ok(await commands.questionAnswer(open, { ...(await at()), sessionId, questionId, optionId }, UI_ORIGIN));
  const accept = async (sessionId: string, blockId: string) => ok(await commands.blockAccept(open, { ...(await at()), sessionId, blockId }, UI_ORIGIN));
  const cancel = async (ref: Ref, reason: string) => ok(await commands.decisionCancel(open, { ...(await at()), ...ref, reason }, UI_ORIGIN));
  const view = async (sessionId: string) => ViewS.parse(ok(await commands.sessionGet(open, { projectId: P, sessionId }, UI_ORIGIN)));
  return { commands, open, revision, at, data, newSession, batch, legacy, answer, accept, cancel, view };
}

describe("summaries of accepted blocks", () => {
  it("the summary built at acceptance is kept on the accepted block and shown unchanged while nothing changed", async () => {
    const t = await setup();
    const s = await t.newSession();
    const [q1, q2] = await t.batch(s, BLK_OPEN, ["Q1", "Q2"]);
    await t.answer(s, q1, "a");
    await t.answer(s, q2, "b");
    const atAcceptance = buildBlockSummary(await t.data(), s, BLK_OPEN);
    await t.accept(s, BLK_OPEN);

    const v = await t.view(s);
    expect(v.session.blocks?.find((b) => b.id === BLK_OPEN)?.summary).toBe(atAcceptance);
    const entry = v.summaries?.find((x) => x.blockId === BLK_OPEN);
    expect(entry).toEqual({ blockId: BLK_OPEN, acceptedSummary: atAcceptance, currentSummary: atAcceptance, changedSinceAcceptance: false, changed: [] });
  });

  it("after a change the accepted text stays what the chat was told, the current text differs, and the changed numbers are named", async () => {
    const t = await setup();
    const s = await t.newSession("Grilling");
    const [q1, q2] = await t.batch(s, BLK_OPEN, ["Q1", "Q2"]);
    await t.answer(s, q1, "a");
    await t.answer(s, q2, "b");
    await seedGrilling(t.open, P, s, { planner: binding(), continuation: continuationIn("paused") });
    await t.accept(s, BLK_OPEN);
    const told = (await t.data()).sessions.find((x) => x.id === s)!.continuation?.summary;
    expect(told).toBeDefined();

    await t.cancel({ sessionId: s, questionId: q2 }, "dropped");
    const current = buildBlockSummary(await t.data(), s, BLK_OPEN);
    expect(current).toContain("Q2 2 (cancelled)");
    const entry = (await t.view(s)).summaries?.find((x) => x.blockId === BLK_OPEN);
    expect(entry).toEqual({ blockId: BLK_OPEN, acceptedSummary: told, currentSummary: current, changedSinceAcceptance: true, changed: [2] });
  });

  it("an out-of-scope mark after acceptance is a change of that number", async () => {
    const t = await setup();
    const s = await t.newSession();
    const [q1, q2] = await t.batch(s, BLK_OPEN, ["Q1", "Q2"]);
    await t.answer(s, q1, "a");
    await t.answer(s, q2, "a");
    await t.accept(s, BLK_OPEN);
    ok(await t.commands.questionOutOfScope(t.open, { ...(await t.at()), sessionId: s, questionId: q1 }, UI_ORIGIN));
    const entry = (await t.view(s)).summaries?.find((x) => x.blockId === BLK_OPEN);
    expect(entry?.changedSinceAcceptance).toBe(true);
    expect(entry?.changed).toEqual([1]);
    expect(entry?.currentSummary).toContain("Q1 out of scope");
    expect(entry?.acceptedSummary).toContain("Q1 1");
  });

  it("a block accepted before snapshots were recorded is not reported as changed", async () => {
    const t = await setup();
    const s = await t.newSession();
    const [q1] = await t.batch(s, BLK_OPEN, ["Q1"]);
    await t.answer(s, q1, "a");
    await t.accept(s, BLK_OPEN);
    // Remove any recorded snapshot, as for a block accepted by an earlier release.
    const store = await t.open(P);
    await store.transact(await t.revision(), (d) => {
      const blocks = d.sessions.find((x) => x.id === s)!.blocks!;
      for (const b of blocks) if (b.state === "accepted") Reflect.deleteProperty(b, "summary");
    });
    const entry = (await t.view(s)).summaries?.find((x) => x.blockId === BLK_OPEN);
    expect(entry).toBeDefined();
    expect(entry?.currentSummary).toBe(buildBlockSummary(await t.data(), s, BLK_OPEN));
    expect(entry?.changedSinceAcceptance).toBe(false);
    expect(entry?.changed).toEqual([]);
  });

  it("the open block has a preview with its session numbers; a session without blocks has none", async () => {
    const t = await setup();
    const s = await t.newSession();
    const [q1] = await t.batch(s, BLK_OPEN, ["Q1"]);
    await t.answer(s, q1, "a");
    const { nextBlockId } = await t.accept(s, BLK_OPEN);
    const [q2] = await t.batch(s, nextBlockId, ["Q2"]);
    await t.answer(s, q2, "b");
    const preview = (await t.view(s)).openBlockPreview;
    expect(preview).toBeDefined();
    expect(preview!.split("\n")).toContain("Q2 2");
    expect(preview!.split("\n")).not.toContain("Q1 1");

    const plain = await t.newSession("Plain");
    await t.legacy(plain, "Legacy");
    expect((await t.view(plain)).openBlockPreview).toBeUndefined();
    expect((await t.view(plain)).summaries ?? []).toEqual([]);
  });
});

describe("dependents of a cancelled decision", () => {
  it("lists activation children and invalidation downstream, transitively and across sessions; an unrelated question is not listed", async () => {
    const t = await setup();
    const s = await t.newSession("Root");
    const root = await t.legacy(s, "Root");
    const child = await t.legacy(s, "Child", { activatedBy: [{ parent: root, optionIds: ["a"] }] });
    const dep = await t.legacy(s, "Dep", { invalidatedBy: [{ upstream: root }] });
    const grand = await t.legacy(s, "Grand", { invalidatedBy: [{ upstream: dep }] });
    await t.legacy(s, "Unrelated");
    const other = await t.newSession("Other");
    const cross = await t.legacy(other, "Cross", { invalidatedBy: [{ upstream: root }] });
    await t.answer(s, root.questionId, "a");
    await t.cancel(root, "changed direction");

    const c = (await t.view(s)).cancellations.find((x) => x.ref.questionId === root.questionId);
    expect(c).toBeDefined();
    expect(sortRefs(c!.dependents.map(refOf))).toEqual(sortRefs([child, dep, grand, cross]));
  });

  it("a cancellation without dependents lists none", async () => {
    const t = await setup();
    const s = await t.newSession("Lone");
    const lone = await t.legacy(s, "Lone");
    await t.cancel(lone, "not needed");
    expect((await t.view(s)).cancellations[0].dependents).toEqual([]);
  });
});
