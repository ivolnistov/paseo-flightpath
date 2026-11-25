// The review marker as the owner and the agent see it: the block summary marks a skipped or
// out-of-scope question kept under review with "(review)" and the legend explains it; the cause
// text reads "Needs review: <parent> changed (rev N)" or "... went out of scope". The owner resolves
// it in an open block by skipping again, answering, or marking out of scope again; a repeated
// out-of-scope mark is kept as its own attributed event. Real temp stores through the commands.
import { afterEach, describe, expect, it } from "vitest";
import { staleCauseText } from "../client/layout";
import type { Question, Ref, RoadmapData } from "../shared/model";
import { createRoadmapCommands, UI_ORIGIN, type StoreOpener, type WriteOrigin } from "./sessions";
import { openProjectStore } from "./store-root";
import { buildBlockSummary, SUMMARY_LEGEND } from "./summary";
import { fixedClock, nextId, opt } from "./test-support/build";
import { fakeDirectory } from "./test-support/fake-dir";
import { err, makeProject, ok, type TestProject } from "./test-support/service";

const P = "prj_test";
const ab = [opt("a"), opt("b")];
const AGENT: WriteOrigin = { source: "chat", actor: { kind: "agent", agentId: "agent-1" }, quoted: "still out of scope" };

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
    if (read.status !== "ok") throw new Error(`expected ok store, got ${read.status}`);
    return read.data;
  };
  const stored = async (ref: Ref): Promise<Question> => (await data()).sessions.find((s) => s.id === ref.sessionId)!.questions.find((q) => q.id === ref.questionId)!;
  const answer = async (ref: Ref, optionId: string) => ok(await commands.questionAnswer(open, { ...(await at()), ...ref, optionId }, UI_ORIGIN));
  const skip = async (ref: Ref) => ok(await commands.questionSkip(open, { ...(await at()), ...ref }, UI_ORIGIN));
  const outOfScope = async (ref: Ref, origin: WriteOrigin = UI_ORIGIN) => commands.questionOutOfScope(open, { ...(await at()), ...ref }, origin);

  /** One open block b1: Parent, a skipped child and an out-of-scope child, both answered first. */
  const s = ok(await commands.sessionCreate(open, { ...(await at()), title: "Review" }, UI_ORIGIN)).sessionId;
  const mk = async (title: string, invalidatedBy: Question["invalidatedBy"] = []): Promise<Ref> => ({
    sessionId: s,
    questionId: ok(await commands.questionCreate(open, { ...(await at()), sessionId: s, title, context: "", options: ab, allowFreeText: false, activatedBy: [], invalidatedBy, blockId: "b1" }, UI_ORIGIN)).questionId,
  });
  const parent = await mk("Parent");
  const skipped = await mk("Skipped child", [{ upstream: parent }]);
  const scoped = await mk("Scoped child", [{ upstream: parent }]);
  for (const ref of [parent, skipped, scoped]) await answer(ref, "a");
  await skip(skipped);
  ok(await outOfScope(scoped));
  const view = async () => ok(await commands.sessionGet(open, { projectId: P, sessionId: s }, UI_ORIGIN));
  const row = async (ref: Ref) => {
    const v = await view();
    return { v, r: v.questions.find((x) => x.question.id === ref.questionId)! };
  };
  return { commands, open, data, stored, answer, skip, outOfScope, s, parent, skipped, scoped, row };
}

describe("how a review marker is shown", () => {
  it("the summary marks both kept outcomes with (review), and the legend explains it", async () => {
    const t = await setup();
    await t.answer(t.parent, "b");
    const lines = buildBlockSummary(await t.data(), t.s, "b1").split("\n");
    expect(lines.slice(1, 4)).toEqual(["Q1 2", "Q2 skipped (review)", "Q3 out of scope (review)"]);
    expect(SUMMARY_LEGEND).toContain("(review)");
  });

  it("the cause text names the parent's change or its going out of scope", async () => {
    const t = await setup();
    await t.answer(t.parent, "b");
    const changed = await t.row(t.skipped);
    expect(staleCauseText(changed.r, changed.v)).toBe("Needs review: Parent changed (rev 2)");

    const t2 = await setup();
    ok(await t2.outOfScope(t2.parent));
    const gone = await t2.row(t2.skipped);
    expect(staleCauseText(gone.r, gone.v)).toBe("Needs review: Parent went out of scope");
  });
});

describe("resolving a review in an open block", () => {
  it("skipping again keeps the question skipped and clears the marker", async () => {
    const t = await setup();
    await t.answer(t.parent, "b");
    await t.skip(t.skipped);
    const q = await t.stored(t.skipped);
    expect(q.validity).toBe("skipped");
    expect(q.review).toBeUndefined();
    expect(q.revisions.map((x) => x.optionId)).toEqual(["a"]);
  });

  it("answering clears the marker with a new revision", async () => {
    const t = await setup();
    await t.answer(t.parent, "b");
    await t.answer(t.skipped, "b");
    const q = await t.stored(t.skipped);
    expect(q.validity).toBe("valid");
    expect(q.review).toBeUndefined();
    expect(q.revisions.map((x) => x.optionId)).toEqual(["a", "b"]);
  });

  it("marking out of scope again clears the marker and keeps a second event attributed to who marked it", async () => {
    const t = await setup();
    await t.answer(t.parent, "b");
    ok(await t.outOfScope(t.scoped, AGENT));
    const q = await t.stored(t.scoped);
    expect(q.validity).toBe("out_of_scope");
    expect(q.review).toBeUndefined();
    const events = (await t.row(t.scoped)).r.outOfScopeEvents ?? [];
    expect(events.map((e) => e.source)).toEqual(["ui", "chat"]);
    expect(events[1]).toMatchObject({ actor: { kind: "agent", agentId: "agent-1" }, quoted: "still out of scope", afterRev: 1 });
  });

  it("marking out of scope again without a pending review is refused and records nothing", async () => {
    const t = await setup();
    const before = (await t.data()).meta.outOfScopeMarks?.length ?? 0;
    expect(err(await t.outOfScope(t.scoped)).code).toBe("invalid_input");
    expect((await t.data()).meta.outOfScopeMarks?.length ?? 0).toBe(before);
  });
});
