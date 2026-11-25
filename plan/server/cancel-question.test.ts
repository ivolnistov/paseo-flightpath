// roadmap_cancel_question: the agent cancels on its own an unanswered question or any dependent
// (answered or not, transitively, across sessions) of a decision that was cancelled; any other
// answered decision needs the human's quoted words. The record is an ordinary append-only
// cancellation attributed to the calling agent; the UI decision.cancel stays human-only. Tool table
// run directly over real temp stores.
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { canonicalJson } from "../shared/canonical";
import type { Question, Ref, RoadmapData } from "../shared/model";
import { buildTools, TOOL_NAMES } from "./mcp-tools";
import { createRoadmapCommands, UI_ORIGIN, type StoreOpener, type WriteOrigin } from "./sessions";
import { openProjectStore } from "./store-root";
import { buildBlockSummary } from "./summary";
import { fixedClock, nextId, opt } from "./test-support/build";
import { fakeDirectory } from "./test-support/fake-dir";
import { err, makeProject, ok, type TestProject } from "./test-support/service";

const P = "prj_test";
const AGENT = "agent-cancel";
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
  const tools = buildTools(commands);
  const tool = (name: string) => {
    const found = tools.find((x) => x.name === name);
    if (found === undefined) throw new Error(`tool ${name} missing`);
    return found;
  };
  const revision = async () => ok(await commands.version(open, { projectId: P }, UI_ORIGIN)).revision!;
  const at = async () => ({ projectId: P, expectedRevision: await revision() });
  const data = async (): Promise<RoadmapData> => {
    const read = await (await open(P)).read();
    if (read.status !== "ok") throw new Error(`expected ok store, got ${read.status}`);
    return read.data;
  };
  const newSession = async (title: string) => ok(await commands.sessionCreate(open, { ...(await at()), title }, UI_ORIGIN)).sessionId;
  const create = async (sessionId: string, title: string, extra: Partial<Pick<Question, "activatedBy" | "invalidatedBy">> & { blockId?: string } = {}): Promise<Ref> => ({
    sessionId,
    questionId: ok(await commands.questionCreate(open, { ...(await at()), sessionId, title, context: "", options: ab, allowFreeText: false, activatedBy: [], invalidatedBy: [], ...extra }, UI_ORIGIN)).questionId,
  });
  const answer = async (ref: Ref, optionId: string) => ok(await commands.questionAnswer(open, { ...(await at()), ...ref, optionId }, UI_ORIGIN));
  const uiCancel = async (ref: Ref, reason: string) => ok(await commands.decisionCancel(open, { ...(await at()), ...ref, reason }, UI_ORIGIN));
  const origin: WriteOrigin = { source: "chat", actor: { kind: "agent", agentId: AGENT } };
  const bound = { open, projectId: P, origin, agentId: AGENT, workspaceId: "ws-1" };
  const cancel = async (ref: Ref, reason: string, extra: { quoted?: string; expectedRevision?: number; ctx?: typeof bound } = {}) =>
    tool("roadmap_cancel_question").run(
      { expectedRevision: extra.expectedRevision ?? (await revision()), ...ref, reason, ...(extra.quoted !== undefined ? { quoted: extra.quoted } : {}) },
      extra.ctx ?? bound,
    );
  const snapshot = async () => ({ revision: await revision(), text: canonicalJson(await data()) });
  const records = async () => (await data()).meta.cancellations ?? [];
  return { commands, open, tool, revision, at, data, newSession, create, answer, uiCancel, cancel, snapshot, records, bound };
}

describe("the tool", () => {
  it("is listed with a strict input: reason required, quoted optional and non-empty, no project", async () => {
    const t = await setup();
    expect(TOOL_NAMES).toContain("roadmap_cancel_question");
    const input = t.tool("roadmap_cancel_question").input;
    const base = { expectedRevision: 2, sessionId: "s1", questionId: "q1", reason: "superseded" };
    expect(input.safeParse(base).success).toBe(true);
    expect(input.safeParse({ ...base, quoted: "drop it" }).success).toBe(true);
    expect(input.safeParse({ ...base, quoted: "" }).success).toBe(false);
    expect(input.safeParse({ ...base, reason: "" }).success).toBe(false);
    const { reason: _r, ...noReason } = base;
    expect(input.safeParse(noReason).success).toBe(false);
    const { expectedRevision: _e, ...noRevision } = base;
    expect(input.safeParse(noRevision).success).toBe(false);
    expect(input.safeParse({ ...base, projectId: "prj_other" }).success).toBe(false);
  });

  it("its description keeps the UI-only approval rule and the quoting rule", async () => {
    const t = await setup();
    const description = t.tool("roadmap_cancel_question").description;
    expect(description).toContain("only in the Paseo UI");
    expect(description).toContain("quoted");
  });
});

describe("what the agent may cancel", () => {
  it("an unanswered question, on its own: one record attributed to the calling agent, with the trimmed reason", async () => {
    const t = await setup();
    const s = await t.newSession("S");
    const q = await t.create(s, "Open question");
    const out = await t.cancel(q, "  superseded by Q2  ");
    expect(out.ok).toBe(true);
    const records = await t.records();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ ref: q, reason: "superseded by Q2", actor: { kind: "agent", agentId: AGENT } });
  });

  it("an answered decision outside a cancelled chain is refused without the human's quoted words, and allowed with them", async () => {
    const t = await setup();
    const s = await t.newSession("S");
    const q = await t.create(s, "Answered");
    await t.answer(q, "a");
    const before = await t.snapshot();
    expect(err(await t.cancel(q, "drop it")).code).toBe("invalid_input");
    expect(await t.snapshot()).toEqual(before);

    expect((await t.cancel(q, "drop it", { quoted: "yes, cancel that one" })).ok).toBe(true);
    expect((await t.records())[0]).toMatchObject({ ref: q, actor: { kind: "agent", agentId: AGENT } });
  });

  it("any dependent of a cancelled decision, answered or not, transitively and across sessions, without quoted words", async () => {
    const t = await setup();
    const s = await t.newSession("Root");
    const root = await t.create(s, "Root");
    const child = await t.create(s, "Child", { activatedBy: [{ parent: root, optionIds: ["a"] }] });
    const dep = await t.create(s, "Dep", { invalidatedBy: [{ upstream: root }] });
    const grand = await t.create(s, "Grand", { invalidatedBy: [{ upstream: dep }] });
    const other = await t.newSession("Other");
    const cross = await t.create(other, "Cross", { invalidatedBy: [{ upstream: root }] });
    for (const ref of [root, child, dep, grand, cross]) await t.answer(ref, "a");

    // Before the parent is cancelled, an answered dependent needs quoted words like any decision.
    expect(err(await t.cancel(dep, "parent going away")).code).toBe("invalid_input");

    await t.uiCancel(root, "changed direction");
    for (const ref of [child, dep, grand, cross]) expect((await t.cancel(ref, "parent cancelled")).ok, ref.questionId).toBe(true);
    const records = await t.records();
    expect(records.map((r) => r.actor.kind)).toEqual(["human", "agent", "agent", "agent", "agent"]);
  });

  it("an answered decision unrelated to the cancelled one still needs quoted words", async () => {
    const t = await setup();
    const s = await t.newSession("S");
    const root = await t.create(s, "Root");
    const unrelated = await t.create(s, "Unrelated");
    await t.answer(root, "a");
    await t.answer(unrelated, "a");
    await t.uiCancel(root, "changed direction");
    expect(err(await t.cancel(unrelated, "cleanup")).code).toBe("invalid_input");
  });
});

describe("refusals write nothing", () => {
  it("a grant without a bound agent cannot cancel", async () => {
    const t = await setup();
    const s = await t.newSession("S");
    const q = await t.create(s, "Open question");
    const before = await t.snapshot();
    const unbound: WriteOrigin = { source: "chat", actor: { kind: "agent" } };
    const out = await t.tool("roadmap_cancel_question").run({ expectedRevision: before.revision, ...q, reason: "superseded" }, { open: t.open, projectId: P, origin: unbound });
    expect(err(out).code).toBe("invalid_input");
    expect(await t.snapshot()).toEqual(before);
  });

  it("an already cancelled decision is decision_cancelled; a stale revision is revision_conflict; an unknown question is not_found", async () => {
    const t = await setup();
    const s = await t.newSession("S");
    const q = await t.create(s, "Open question");
    ok(await t.cancel(q, "superseded"));
    let before = await t.snapshot();
    expect(err(await t.cancel(q, "again")).code).toBe("decision_cancelled");
    expect(await t.snapshot()).toEqual(before);

    const q2 = await t.create(s, "Another");
    before = await t.snapshot();
    expect(err(await t.cancel(q2, "superseded", { expectedRevision: before.revision - 1 })).code).toBe("revision_conflict");
    expect(err(await t.cancel({ sessionId: s, questionId: "no-such-question" }, "superseded")).code).toBe("not_found");
    expect(await t.snapshot()).toEqual(before);
  });

  it("the UI decision.cancel stays human-only: a chat origin is still refused", async () => {
    const t = await setup();
    const s = await t.newSession("S");
    const q = await t.create(s, "Open question");
    const out = await t.commands.decisionCancel(t.open, { ...(await t.at()), ...q, reason: "x" }, t.bound.origin);
    expect(err(out).code).toBe("invalid_input");
  });
});

describe("an agent cancellation is an ordinary cancellation", () => {
  it("the block summary marks the question (cancelled), and its dependents are listed for review", async () => {
    const t = await setup();
    const s = await t.newSession("Blocked");
    const q1 = await t.create(s, "Q1", { blockId: "b1" });
    const q2 = await t.create(s, "Q2", { blockId: "b1", invalidatedBy: [{ upstream: q1 }] });
    await t.answer(q2, "a");
    ok(await t.cancel(q1, "superseded"));
    expect(buildBlockSummary(await t.data(), s, "b1").split("\n")).toContain("Q1 unanswered (cancelled)");
    const view = ok(await t.commands.sessionGet(t.open, { projectId: P, sessionId: s }, UI_ORIGIN));
    const RefS = z.object({ sessionId: z.string(), questionId: z.string() });
    const listed = z.looseObject({ dependents: z.array(z.union([RefS, z.looseObject({ ref: RefS })])) }).parse(view.cancellations[0]).dependents;
    expect(listed.map((d) => ("ref" in d ? d.ref : d))).toEqual([q2]);
  });
});
