// Automatic grilling S2/G3 (task card §4.2 blockAccept, grillComplete; PLAN §3.5–§3.7; TR9, TR13,
// TR14): Accept is the only write that advances an operation. paused → resolving (the claim of
// attempt 1), awaiting_pause → accepted_awaiting_pause, a lost or unsupported pause → needs_manual,
// with the frozen block's summary recorded in the same transaction and one after-commit afterAccept
// for the two live outcomes only. roadmap_grill_complete is planner-only and fenced on the current
// operation, closes the session, and does not change the approval gate. Reopen, then a batch, mints a
// new operation. Real temp stores and the real commands; grilling fields seeded via store.transact.
import { afterEach, describe, expect, it } from "vitest";
import type { Option, Session } from "../shared/model";
import { decisionSnapshotHash } from "./plan-hash";
import { grillingComplete } from "./plan-rules";
import { createRoadmapCommands, UI_ORIGIN, type PlannerCaller, type StoreOpener, type WriteOrigin } from "./sessions";
import { openProjectStore } from "./store-root";
import { fixedClock, NOW, nextId, opt } from "./test-support/build";
import { fakeDirectory } from "./test-support/fake-dir";
import {
  binding,
  BLK_NEXT,
  BLK_OPEN,
  blocksFor,
  continuationIn,
  grillingFields,
  isPostAccept,
  need,
  OP,
  OTHER_AGENT,
  pauseSnapshot,
  PLANNER,
  seedGrilling,
  type ContState,
} from "./test-support/grilling";
import { err, makeProject, ok, type TestProject } from "./test-support/service";

const loadSummary = () =>
  import("./summary").catch((e: unknown) => {
    throw new Error(`missing module server/summary.ts: ${String(e)}`);
  });

const P = "prj_test";
const T1 = NOW.toISOString();
const T2 = "2026-10-20T11:00:00.000Z";
const ab: Option[] = [opt("a"), opt("b")];
const chat = (agentId?: string): WriteOrigin => ({ source: "chat", actor: agentId !== undefined ? { kind: "agent", agentId } : { kind: "agent" } });
const caller = (agentId = PLANNER, workspaceId: string | null = "ws-1"): PlannerCaller => ({ agentId, workspaceId });
type AfterAccept = { projectId: string; sessionId: string; operationId: string };

let project: TestProject | undefined;
let clock = new Date(T1);
afterEach(async () => {
  await project?.cleanup();
  project = undefined;
});

async function setup() {
  clock = new Date(T1);
  project = await makeProject();
  const proj = project;
  const dir = fakeDirectory({ projects: [{ projectId: P, projectRootPath: proj.root, projectKind: "git" }] });
  const storeOptions = { now: fixedClock, newId: nextId, log: (m: string, e?: unknown) => void proj.logs.push([m, e]) };
  const accepted: AfterAccept[] = [];
  const commands = createRoadmapCommands({ directory: () => dir, now: () => clock, newId: nextId, storeOptions, afterAccept: (x: AfterAccept) => void accepted.push(x) });
  const open: StoreOpener = (projectId) => openProjectStore(dir, projectId, storeOptions);
  ok(await commands.init(open, { projectId: P }, UI_ORIGIN));
  const revision = async () => ok(await commands.version(open, { projectId: P }, UI_ORIGIN)).revision!;
  const data = async () => {
    const read = await (await open(P)).read();
    if (read.status !== "ok") throw new Error(`expected an ok store, got ${read.status}`);
    return read.data;
  };
  const sessionOf = async (sessionId: string): Promise<Session> => {
    const s = (await data()).sessions.find((x) => x.id === sessionId);
    if (s === undefined) throw new Error(`session ${sessionId} not found`);
    return s;
  };
  const ask = async (sessionId: string, o: { caller?: PlannerCaller; blockId?: string } = {}) =>
    commands.questionCreateBatch(
      open,
      { projectId: P, expectedRevision: await revision(), sessionId, blockId: o.blockId ?? BLK_OPEN, questions: [{ title: "Q", context: "", options: ab, allowFreeText: false, activatedBy: [], invalidatedBy: [] }] },
      chat(o.caller?.agentId),
      o.caller,
    );
  const seeded = async (patch: Parameters<typeof seedGrilling>[3]) => {
    const sessionId = ok(await commands.sessionCreate(open, { projectId: P, expectedRevision: await revision(), title: "Grilling" }, UI_ORIGIN)).sessionId;
    ok(await ask(sessionId));
    await seedGrilling(open, P, sessionId, patch);
    return sessionId;
  };
  const accept = async (sessionId: string, blockId: string, origin: WriteOrigin = UI_ORIGIN, expectedRevision?: number) =>
    commands.blockAccept(open, { projectId: P, sessionId, blockId, expectedRevision: expectedRevision ?? (await revision()) }, origin);
  const complete = async (sessionId: string, operationId: string, c?: PlannerCaller, origin: WriteOrigin = chat(c?.agentId)) => {
    need(commands.grillComplete, "createRoadmapCommands().grillComplete");
    return commands.grillComplete(open, { projectId: P, sessionId, expectedRevision: await revision(), operationId }, origin, c);
  };
  return { commands, open, revision, data, sessionOf, ask, seeded, accept, complete, accepted };
}

describe("Accept advances the operation of its block", () => {
  it("paused → resolving: attempts + 1 (the claim of attempt 1), accepted refs, the frozen block's summary, at; afterAccept once", async () => {
    const { buildBlockSummary } = await loadSummary();
    const t = await setup();
    const prior = continuationIn("paused");
    const sid = await t.seeded({ planner: binding(), continuation: prior });
    clock = new Date(T2);
    const out = ok(await t.accept(sid, BLK_OPEN));
    const c = (await t.sessionOf(sid)).continuation;
    expect(c).toEqual({
      ...prior,
      state: "resolving",
      attempts: 1,
      acceptedBlockId: BLK_OPEN,
      nextBlockId: out.nextBlockId,
      summary: buildBlockSummary(await t.data(), sid, BLK_OPEN),
      at: T2,
    });
    expect(c?.pause).toEqual(pauseSnapshot());
    expect(t.accepted).toEqual([{ projectId: P, sessionId: sid, operationId: OP }]);
  });

  it("awaiting_pause → accepted_awaiting_pause (Accept before the card): no attempt, accepted refs, summary, at; afterAccept once", async () => {
    const { buildBlockSummary } = await loadSummary();
    const t = await setup();
    const prior = continuationIn("awaiting_pause");
    const sid = await t.seeded({ planner: binding(), continuation: prior });
    clock = new Date(T2);
    const out = ok(await t.accept(sid, BLK_OPEN));
    expect((await t.sessionOf(sid)).continuation).toEqual({
      ...prior,
      state: "accepted_awaiting_pause",
      attempts: 0,
      acceptedBlockId: BLK_OPEN,
      nextBlockId: out.nextBlockId,
      summary: buildBlockSummary(await t.data(), sid, BLK_OPEN),
      at: T2,
    });
    expect(t.accepted).toEqual([{ projectId: P, sessionId: sid, operationId: OP }]);
  });

  it.each([
    ["unsupported", "codex default mode", "unsupported: codex default mode"],
    ["pause_lost", "no_pause", "pause_lost: no_pause"],
    ["pause_mismatch", "bundled questions", "pause_mismatch: bundled questions"],
    ["pause_answered_externally", undefined, "pause_answered_externally"],
  ] as const)("%s → needs_manual with accepted refs, summary and reason %s; pause and resolution kept; no afterAccept", async (state, reason, expected) => {
    const { buildBlockSummary } = await loadSummary();
    const t = await setup();
    const prior = continuationIn(state, {
      ...(reason !== undefined ? { reason } : {}),
      ...(state === "pause_answered_externally" ? { resolution: { behavior: "deny" as const, at: T1, source: "external" as const } } : {}),
    });
    const sid = await t.seeded({ planner: binding(), continuation: prior });
    clock = new Date(T2);
    const out = ok(await t.accept(sid, BLK_OPEN));
    const c = (await t.sessionOf(sid)).continuation;
    expect(c).toMatchObject({
      operationId: OP,
      openBlockId: BLK_OPEN,
      target: prior.target,
      state: "needs_manual",
      acceptedBlockId: BLK_OPEN,
      nextBlockId: out.nextBlockId,
      summary: buildBlockSummary(await t.data(), sid, BLK_OPEN),
      reason: expected,
      attempts: prior.attempts,
    });
    expect(c?.pause).toEqual(prior.pause);
    expect(c?.resolution).toEqual(prior.resolution);
    expect(t.accepted).toEqual([]);
  });

  it.each(["superseded", "complete"] as const)("%s for the accepted block: the continuation is unchanged and afterAccept is not called", async (state) => {
    const t = await setup();
    const sid = await t.seeded({ planner: binding(), continuation: continuationIn(state) });
    const before = grillingFields(await t.sessionOf(sid));
    ok(await t.accept(sid, BLK_OPEN));
    expect(grillingFields(await t.sessionOf(sid))).toBe(before);
    expect(t.accepted).toEqual([]);
  });

  it.each(["accepted_awaiting_pause", "resolving", "resumed", "unknown", "needs_manual"] as const)(
    "%s (an operation of an earlier block): accepting the current block changes nothing and calls no afterAccept",
    async (state: ContState) => {
      const t = await setup();
      expect(isPostAccept(state)).toBe(true);
      // No batch first: a batch after a terminal operation would mint a new one for blk-next.
      const sid = await t.seeded({ planner: binding(), continuation: continuationIn(state), blocks: blocksFor(true) });
      const before = grillingFields(await t.sessionOf(sid));
      ok(await t.accept(sid, BLK_NEXT));
      expect(grillingFields(await t.sessionOf(sid))).toBe(before);
      expect(t.accepted).toEqual([]);
    },
  );

  it("an awaiting_pause operation of another block is unchanged when the current block is accepted", async () => {
    const t = await setup();
    const blocks = [
      { id: "blk-prev", order: 0, state: "accepted" as const, openedAt: T1, acceptedAt: T1, acceptedBy: { kind: "human" as const } },
      { id: BLK_OPEN, order: 1, state: "open" as const, openedAt: T1 },
    ];
    const sid = await t.seeded({ planner: binding(), continuation: continuationIn("awaiting_pause", { openBlockId: "blk-prev" }), blocks });
    const before = grillingFields(await t.sessionOf(sid));
    ok(await t.accept(sid, BLK_OPEN));
    expect(grillingFields(await t.sessionOf(sid))).toBe(before);
    expect(t.accepted).toEqual([]);
  });

  it("no afterAccept for a chat Accept, a stale revision, or a session without an operation", async () => {
    const t = await setup();
    const sid = await t.seeded({ planner: binding(), continuation: continuationIn("paused") });
    expect(err(await t.accept(sid, BLK_OPEN, chat(PLANNER))).code).toBe("invalid_input");
    expect(err(await t.accept(sid, BLK_OPEN, UI_ORIGIN, (await t.revision()) - 1)).code).toBe("revision_conflict");
    expect((await t.sessionOf(sid)).continuation?.state).toBe("paused");
    const plain = await t.seeded({ planner: binding() });
    ok(await t.accept(plain, BLK_OPEN));
    expect("continuation" in (await t.sessionOf(plain))).toBe(false);
    expect(t.accepted).toEqual([]);
  });
});

describe("grillComplete (planner-only, fenced on the current operation)", () => {
  it("a caller that is missing or not the planner gets planner_bound and nothing is written", async () => {
    const t = await setup();
    const sid = await t.seeded({ planner: binding(), continuation: continuationIn("awaiting_pause") });
    const before = await t.revision();
    expect(err(await t.complete(sid, OP)).code).toBe("planner_bound");
    expect(err(await t.complete(sid, OP, caller(OTHER_AGENT))).code).toBe("planner_bound");
    expect(await t.revision()).toBe(before);
  });

  it("no operation, another operationId, or an operation for an older planner epoch is stale_operation", async () => {
    const t = await setup();
    const none = await t.seeded({ planner: binding() });
    expect(err(await t.complete(none, OP, caller())).code).toBe("stale_operation");
    const other = await t.seeded({ planner: binding(), continuation: continuationIn("awaiting_pause") });
    const wrongOp = err(await t.complete(other, "op-other", caller()));
    expect(wrongOp.code).toBe("stale_operation");
    expect(wrongOp.details).toEqual({ state: "awaiting_pause" });
    const old = await t.seeded({
      planner: binding({ epoch: 2, boundBy: "ui" }),
      plannerHistory: [binding()],
      continuation: continuationIn("resumed", { resolution: { behavior: "allow", at: T1, source: "plugin" } }),
      blocks: blocksFor(true),
    });
    expect(err(await t.complete(old, OP, caller())).code).toBe("stale_operation");
  });

  it.each(["paused", "resolving", "unknown", "pause_answered_externally", "pause_lost", "pause_mismatch", "unsupported", "superseded", "needs_manual", "complete"] as const)(
    "state %s is stale_operation with details { state } and writes nothing",
    async (state) => {
      const t = await setup();
      const sid = await t.seeded({ planner: binding(), continuation: continuationIn(state), ...(isPostAccept(state) ? { blocks: blocksFor(true) } : {}) });
      const before = await t.revision();
      const e = err(await t.complete(sid, OP, caller()));
      expect(e.code).toBe("stale_operation");
      expect(e.details).toEqual({ state });
      expect(await t.revision()).toBe(before);
    },
  );

  it.each(["awaiting_pause", "accepted_awaiting_pause", "resumed"] as const)(
    "from %s: state complete, at now, session closed, value { revision, state }; the approval gate inputs are unchanged",
    async (state) => {
      const t = await setup();
      const prior = continuationIn(state);
      const sid = await t.seeded({ planner: binding(), continuation: prior, ...(isPostAccept(state) ? { blocks: blocksFor(true) } : {}) });
      const sessionsBefore = (await t.data()).sessions;
      const gate = { complete: grillingComplete(sessionsBefore, sid), hash: decisionSnapshotHash(sessionsBefore, [sid]) };
      const before = await t.revision();
      clock = new Date(T2);
      expect(ok(await t.complete(sid, OP, caller()))).toEqual({ revision: before + 1, state: "complete" });
      const s = await t.sessionOf(sid);
      expect(s.status).toBe("closed");
      expect(s.continuation).toEqual({ ...prior, state: "complete", at: T2 });
      const sessionsAfter = (await t.data()).sessions;
      expect(grillingComplete(sessionsAfter, sid)).toBe(gate.complete);
      expect(gate.complete, "an unanswered question keeps grilling incomplete; completion does not satisfy it").toBe(false);
      expect(decisionSnapshotHash(sessionsAfter, [sid])).toBe(gate.hash);
    },
  );

  it("after completion, a UI reopen and the planner's next batch mint a new operation; the completed one moves to history", async () => {
    const t = await setup();
    const sid = await t.seeded({ planner: binding(), continuation: continuationIn("awaiting_pause") });
    ok(await t.complete(sid, OP, caller()));
    const completed = (await t.sessionOf(sid)).continuation;
    ok(await t.commands.sessionReopen(t.open, { projectId: P, sessionId: sid, expectedRevision: await t.revision() }, UI_ORIGIN));
    const out = ok(await t.ask(sid, { caller: caller() }));
    const s = await t.sessionOf(sid);
    expect(s.status).toBe("active");
    expect(s.continuations).toEqual([completed]);
    expect(s.continuation).toMatchObject({ state: "awaiting_pause", openBlockId: BLK_OPEN, target: { agentId: PLANNER, epoch: 1 }, attempts: 0 });
    expect(s.continuation?.operationId).not.toBe(OP);
    expect(out.grilling?.operationId).toBe(s.continuation?.operationId);
  });
});

// S2 corrected KensAI review (session 01a19904): c76.
describe("S2 corrected KensAI c76", () => {
  it("c76: completing the current operation in a non-completable state names that state instead of claiming it is not the current operation", async () => {
    const t = await setup();
    const sid = await t.seeded({ planner: binding(), continuation: continuationIn("paused") });
    const e = err(await t.complete(sid, OP, caller()));
    expect(e.code).toBe("stale_operation");
    expect(e.details).toEqual({ state: "paused" });
    expect(e.message).not.toMatch(/not the current operation/);
    expect(e.message).toContain("paused");
  });
});
