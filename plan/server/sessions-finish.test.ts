// Finishing a discussion: only the session's planner may propose finishing (roadmap_grill_propose_finish),
// which records its summary with the skipped and out-of-scope question numbers and closes nothing;
// the owner confirms with Finish (session.finish), which closes the session and records when the
// proposal was finished; Reopen keeps working. roadmap_grill_complete is refused for a session bound
// by a discussion or carrying a proposal, and stays as shipped for other planners. The first
// question may carry tag "language". The grilling view reports the open proposal and the retries.
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { canonicalJson } from "../shared/canonical";
import type { RoadmapData } from "../shared/model";
import { GrillingView, SessionView } from "../shared/rpc";
import { buildTools, TOOL_NAMES } from "./mcp-tools";
import { createRoadmapCommands, UI_ORIGIN, type StoreOpener, type WriteOrigin } from "./sessions";
import { openProjectStore } from "./store-root";
import { fixedClock, isJsonObject, NOW_ISO, nextId, opt } from "./test-support/build";
import { fakeDirectory } from "./test-support/fake-dir";
import { manualFinish } from "./test-support/finish";
import { binding, BLK_OPEN, continuationIn, OP, OTHER_AGENT, PLANNER, seedGrilling } from "./test-support/grilling";
import { err, makeProject, ok, type TestProject } from "./test-support/service";

const P = "prj_test";
const ab = [opt("a"), opt("b")];
const SUMMARY = "Nothing left to ask.";

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
  const ctx = (agentId?: string) => ({
    open,
    projectId: P,
    origin: (agentId !== undefined ? { source: "chat", actor: { kind: "agent", agentId } } : { source: "chat", actor: { kind: "agent" } }) as WriteOrigin,
    ...(agentId !== undefined ? { agentId, workspaceId: "ws-1" } : {}),
  });
  /**
   * A planner session with blocks: Q1 skipped, Q2 out of scope, Q3 answered, Q4 hidden and skipped
   * earlier (shown only when Q3 is b). `boundBy` defaults to the shipped "ask".
   */
  const plannerSession = async (boundBy: "ask" | "discussion" = "ask") => {
    const sessionId = ok(await commands.sessionCreate(open, { ...(await at()), title: "Discussion" }, UI_ORIGIN)).sessionId;
    const ids = ok(
      await commands.questionCreateBatch(
        open,
        {
          ...(await at()),
          sessionId,
          blockId: BLK_OPEN,
          questions: [
            { title: "Q1", context: "", options: ab, allowFreeText: false, activatedBy: [], invalidatedBy: [] },
            { title: "Q2", context: "", options: ab, allowFreeText: false, activatedBy: [], invalidatedBy: [] },
            { title: "Q3", context: "", options: ab, allowFreeText: false, activatedBy: [], invalidatedBy: [] },
            { title: "Q4", context: "", options: ab, allowFreeText: false, activatedBy: [{ parent: { batchIndex: 2 }, optionIds: ["b"] }], invalidatedBy: [] },
          ],
        },
        ctx().origin,
      ),
    ).questionIds;
    const ref = (i: number) => ({ sessionId, questionId: ids[i] });
    ok(await commands.questionSkip(open, { ...(await at()), ...ref(0) }, UI_ORIGIN));
    ok(await commands.questionOutOfScope(open, { ...(await at()), ...ref(1) }, UI_ORIGIN));
    ok(await commands.questionAnswer(open, { ...(await at()), ...ref(2), optionId: "b" }, UI_ORIGIN));
    ok(await commands.questionSkip(open, { ...(await at()), ...ref(3) }, UI_ORIGIN));
    ok(await commands.questionAnswer(open, { ...(await at()), ...ref(2), optionId: "a" }, UI_ORIGIN));
    await seedGrilling(open, P, sessionId, { planner: { ...binding(), boundBy } });
    return { sessionId, ids };
  };
  const propose = async (sessionId: string, agentId: string | undefined = PLANNER, extra: { expectedRevision?: number; summary?: string } = {}) =>
    tool("roadmap_grill_propose_finish").run({ expectedRevision: extra.expectedRevision ?? (await revision()), sessionId, summary: extra.summary ?? SUMMARY }, ctx(agentId));
  const finish = async (sessionId: string, expectedRevision?: number) => commands.sessionFinish(open, manualFinish(P, expectedRevision ?? (await revision()), sessionId), UI_ORIGIN);
  const view = async (sessionId: string) => ok(await commands.sessionGet(open, { projectId: P, sessionId }, UI_ORIGIN));
  const snapshot = async () => ({ revision: await revision(), text: canonicalJson(await data()) });
  return { commands, open, tool, revision, at, data, ctx, plannerSession, propose, finish, view, snapshot };
}

describe("the propose-finish tool", () => {
  it("is listed with a strict input and keeps the no-approval rule", async () => {
    const t = await setup();
    expect(TOOL_NAMES).toContain("roadmap_grill_propose_finish");
    const input = t.tool("roadmap_grill_propose_finish").input;
    const base = { expectedRevision: 2, sessionId: "s1", summary: SUMMARY };
    expect(input.safeParse(base).success).toBe(true);
    expect(input.safeParse({ ...base, summary: "" }).success).toBe(false);
    const { expectedRevision: _e, ...noRevision } = base;
    expect(input.safeParse(noRevision).success).toBe(false);
    expect(input.safeParse({ ...base, projectId: "prj_other" }).success).toBe(false);
    expect(t.tool("roadmap_grill_propose_finish").description).toContain("no tool can approve");
  });

  it("no tool finishes or closes a session on its own", () => {
    expect(TOOL_NAMES.filter((n) => /finish|close/.test(n))).toEqual(["roadmap_grill_propose_finish"]);
  });
});

describe("the planner proposes, the owner finishes", () => {
  it("a proposal records the summary and the numbers of the active skipped and out-of-scope questions, tells the agent to wait and closes nothing", async () => {
    const t = await setup();
    const { sessionId } = await t.plannerSession();
    const out = z.looseObject({ revision: z.number(), instructions: z.string() }).parse(ok(await t.propose(sessionId)));
    expect(out.instructions).toMatch(/wait for the owner/i);

    const v = await t.view(sessionId);
    expect(v.session.status).toBe("active");
    expect(v.grilling?.finishProposal).toMatchObject({ summary: SUMMARY, skipped: [1], outOfScope: [2] });
    const stored = (await t.data()).sessions.find((s) => s.id === sessionId)!;
    expect(stored.finishProposal).toMatchObject({ at: NOW_ISO, agentId: PLANNER, summary: SUMMARY, skipped: [1], outOfScope: [2] });
    expect(stored.finishProposal?.finishedAt).toBeUndefined();
    expect(SessionView.safeParse(v).success).toBe(true);
  });

  it("Finish closes the session and records finishedAt; the open proposal leaves the grilling view; Reopen reopens and keeps the proposal as history", async () => {
    const t = await setup();
    const { sessionId } = await t.plannerSession();
    ok(await t.propose(sessionId));
    ok(await t.finish(sessionId));
    let v = await t.view(sessionId);
    expect(v.session.status).toBe("closed");
    const stored = () => t.data().then((d) => d.sessions.find((s) => s.id === sessionId)!);
    expect((await stored()).finishProposal?.finishedAt).toBe(NOW_ISO);
    expect(v.grilling?.finishProposal).toBeUndefined();
    expect(SessionView.safeParse(v).success).toBe(true);

    ok(await t.commands.sessionReopen(t.open, { ...(await t.at()), sessionId }, UI_ORIGIN));
    v = await t.view(sessionId);
    expect(v.session.status).toBe("active");
    expect((await stored()).finishProposal).toMatchObject({ summary: SUMMARY, finishedAt: NOW_ISO });
  });

  it("Finish without a proposal closes the session and records no proposal", async () => {
    const t = await setup();
    const { sessionId } = await t.plannerSession();
    ok(await t.finish(sessionId));
    const stored = (await t.data()).sessions.find((s) => s.id === sessionId)!;
    expect(stored.status).toBe("closed");
    expect(stored.finishProposal).toBeUndefined();
  });

  it("a stale revision is revision_conflict for both, with no write", async () => {
    const t = await setup();
    const { sessionId } = await t.plannerSession();
    const before = await t.snapshot();
    expect(err(await t.propose(sessionId, PLANNER, { expectedRevision: before.revision - 1 })).code).toBe("revision_conflict");
    expect(err(await t.finish(sessionId, before.revision - 1)).code).toBe("revision_conflict");
    expect(await t.snapshot()).toEqual(before);
  });
});

describe("only the planner may propose", () => {
  it("another chat, an unbound grant and a session without a planner are planner_bound, with no write", async () => {
    const t = await setup();
    const { sessionId } = await t.plannerSession();
    const before = await t.snapshot();
    expect(err(await t.propose(sessionId, OTHER_AGENT)).code).toBe("planner_bound");
    // An unbound grant carries no agent id at all.
    const unbound = await t.tool("roadmap_grill_propose_finish").run({ expectedRevision: before.revision, sessionId, summary: SUMMARY }, t.ctx());
    expect(err(unbound).code).toBe("planner_bound");
    expect(await t.snapshot()).toEqual(before);

    const plain = ok(await t.commands.sessionCreate(t.open, { ...(await t.at()), title: "No planner" }, UI_ORIGIN)).sessionId;
    expect(err(await t.propose(plain)).code).toBe("planner_bound");
  });
});

describe("roadmap_grill_complete and the owner-confirmed Finish", () => {
  const complete = async (t: Awaited<ReturnType<typeof setup>>, sessionId: string) =>
    t.tool("roadmap_grill_complete").run({ expectedRevision: await t.revision(), sessionId, operationId: OP }, t.ctx(PLANNER));

  it("is refused with invalid_input for a session whose planner is bound by a discussion; the session stays active", async () => {
    const t = await setup();
    const { sessionId } = await t.plannerSession("discussion");
    await seedGrilling(t.open, P, sessionId, { continuation: continuationIn("awaiting_pause") });
    expect(err(await complete(t, sessionId)).code).toBe("invalid_input");
    expect((await t.view(sessionId)).session.status).toBe("active");
  });

  it("is refused with invalid_input once a finish proposal exists", async () => {
    const t = await setup();
    const { sessionId } = await t.plannerSession();
    await seedGrilling(t.open, P, sessionId, { continuation: continuationIn("awaiting_pause") });
    ok(await t.propose(sessionId));
    expect(err(await complete(t, sessionId)).code).toBe("invalid_input");
    expect((await t.view(sessionId)).session.status).toBe("active");
  });

  it("still closes a shipped planner session without a proposal", async () => {
    const t = await setup();
    const { sessionId } = await t.plannerSession();
    await seedGrilling(t.open, P, sessionId, { continuation: continuationIn("awaiting_pause") });
    ok(await complete(t, sessionId));
    expect((await t.view(sessionId)).session.status).toBe("closed");
  });
});

describe("the language question", () => {
  it("roadmap_ask accepts tag language; the stored question and the view carry it; other tags are rejected", async () => {
    const t = await setup();
    const sessionId = ok(await t.commands.sessionCreate(t.open, { ...(await t.at()), title: "Language" }, UI_ORIGIN)).sessionId;
    const question = { title: "Which language should this session use?", context: "", options: [{ id: "en", label: "English" }, { id: "ru", label: "Russian" }], recommendedOptionId: "en", allowFreeText: true, activatedBy: [], invalidatedBy: [] };
    const ask = t.tool("roadmap_ask");
    expect(ask.input.safeParse({ expectedRevision: 2, sessionId, blockId: BLK_OPEN, questions: [{ ...question, tag: "language" }] }).success).toBe(true);
    expect(ask.input.safeParse({ expectedRevision: 2, sessionId, blockId: BLK_OPEN, questions: [{ ...question, tag: "priority" }] }).success).toBe(false);
    ok(await ask.run({ expectedRevision: await t.revision(), sessionId, blockId: BLK_OPEN, questions: [{ ...question, tag: "language" }, { ...question, title: "Untagged" }] }, t.ctx()));
    const stored = (await t.data()).sessions.find((s) => s.id === sessionId)!.questions;
    expect(stored.map((q) => ("tag" in q ? q.tag : undefined))).toEqual(["language", undefined]);
    const v = await t.view(sessionId);
    expect(v.questions.map((q) => ("tag" in q.question ? q.question.tag : undefined))).toEqual(["language", undefined]);
  });
});

describe("the grilling view reports retries", () => {
  it("retryCount is 0 with no lastRetry by default, and counts the recorded retries with the last one's state", async () => {
    const t = await setup();
    const { sessionId } = await t.plannerSession();
    const fresh = GrillingView.parse((await t.view(sessionId)).grilling);
    expect(fresh).toMatchObject({ retryCount: 0 });
    expect(fresh.lastRetry).toBeUndefined();

    const retry = (id: string, state: "sent" | "failed") => ({ id, at: NOW_ISO, blockId: BLK_OPEN, agentId: PLANNER, epoch: 1, state });
    await seedGrilling(t.open, P, sessionId, { retries: [retry("r1", "sent"), retry("r2", "failed")] });
    const after = GrillingView.parse((await t.view(sessionId)).grilling);
    expect(after).toMatchObject({ retryCount: 2, lastRetry: { at: NOW_ISO, state: "failed" } });
  });
});

describe("Finish is the owner's action in the panel", () => {
  it("a chat origin is refused, also a bound agent with quoted words, with no write", async () => {
    const t = await setup();
    const { sessionId } = await t.plannerSession();
    ok(await t.propose(sessionId));
    const before = await t.snapshot();
    const agent: WriteOrigin = { source: "chat", actor: { kind: "agent", agentId: PLANNER } };
    for (const origin of [agent, { ...agent, quoted: "finish it" }, { source: "chat", actor: { kind: "agent" } } as WriteOrigin]) {
      expect(err(await t.commands.sessionFinish(t.open, manualFinish(P, before.revision, sessionId), origin)).code).toBe("invalid_input");
    }
    expect(await t.snapshot()).toEqual(before);
  });
});

/** Every object inside `value` that has all the given fields with the given values. */
function findRecords(value: unknown, fields: Record<string, unknown>): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  const walk = (v: unknown) => {
    if (Array.isArray(v)) {
      for (const x of v) walk(x);
      return;
    }
    if (!isJsonObject(v)) return;
    if (Object.entries(fields).every(([k, want]) => v[k] === want)) out.push(v);
    for (const x of Object.values(v)) walk(x);
  };
  walk(value);
  return out;
}

describe("finished proposals stay in the shared history", () => {
  const FIRST = "First pass: nothing left.";
  const SECOND = "Second pass after reopening.";

  it("after Finish, Reopen and a new proposal by a rebound planner, the finished proposal stays readable with its author and finish time", async () => {
    const t = await setup();
    const { sessionId } = await t.plannerSession();
    ok(await t.propose(sessionId, PLANNER, { summary: FIRST }));
    ok(await t.finish(sessionId));
    ok(await t.commands.sessionReopen(t.open, { ...(await t.at()), sessionId }, UI_ORIGIN));
    ok(await t.commands.plannerSet(t.open, { ...(await t.at()), sessionId, agentId: OTHER_AGENT, workspaceId: "ws-2" }, UI_ORIGIN));
    ok(await t.propose(sessionId, OTHER_AGENT, { summary: SECOND }));

    const stored = (await t.data()).sessions.find((s) => s.id === sessionId)!;
    expect(findRecords(stored, { summary: FIRST, agentId: PLANNER, finishedAt: NOW_ISO }), "the finished first proposal is stored").toHaveLength(1);
    const second = findRecords(stored, { summary: SECOND, agentId: OTHER_AGENT });
    expect(second, "the open second proposal is stored").toHaveLength(1);
    expect(second[0].finishedAt).toBeUndefined();

    const v = await t.view(sessionId);
    expect(findRecords(v.session, { summary: FIRST, agentId: PLANNER, finishedAt: NOW_ISO }), "the session view shows the finished first proposal").toHaveLength(1);
    expect(v.grilling?.finishProposal).toMatchObject({ summary: SECOND });
    expect(SessionView.safeParse(v).success).toBe(true);
  });

  it("a second Finish keeps both finished proposals", async () => {
    const t = await setup();
    const { sessionId } = await t.plannerSession();
    ok(await t.propose(sessionId, PLANNER, { summary: FIRST }));
    ok(await t.finish(sessionId));
    ok(await t.commands.sessionReopen(t.open, { ...(await t.at()), sessionId }, UI_ORIGIN));
    ok(await t.propose(sessionId, PLANNER, { summary: SECOND }));
    ok(await t.finish(sessionId));
    const stored = (await t.data()).sessions.find((s) => s.id === sessionId)!;
    expect(stored.status).toBe("closed");
    for (const summary of [FIRST, SECOND]) expect(findRecords(stored, { summary, agentId: PLANNER, finishedAt: NOW_ISO }), summary).toHaveLength(1);
  });

  it("a stale revision refuses a new proposal and a Finish after reopening, leaving the history unchanged", async () => {
    const t = await setup();
    const { sessionId } = await t.plannerSession();
    ok(await t.propose(sessionId, PLANNER, { summary: FIRST }));
    ok(await t.finish(sessionId));
    ok(await t.commands.sessionReopen(t.open, { ...(await t.at()), sessionId }, UI_ORIGIN));
    const before = await t.snapshot();
    expect(err(await t.propose(sessionId, PLANNER, { summary: SECOND, expectedRevision: before.revision - 1 })).code).toBe("revision_conflict");
    expect(err(await t.finish(sessionId, before.revision - 1)).code).toBe("revision_conflict");
    expect(await t.snapshot()).toEqual(before);
    const stored = (await t.data()).sessions.find((s) => s.id === sessionId)!;
    expect(findRecords(stored, { summary: FIRST, finishedAt: NOW_ISO })).toHaveLength(1);
  });
});
