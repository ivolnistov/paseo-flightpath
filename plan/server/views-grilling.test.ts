// Automatic grilling S1/G1 (task card §2 state → view table, §3.4 V1–V5, TR8, TR14): the session
// view derives a `grilling` status for sessions with blocks, copies the stored grilling fields into
// `view.session` (which must still validate against the strict SessionView), and the approval gate
// inputs ignore every grilling field and the session status. Pure functions over synthetic data.
import { describe, expect, it } from "vitest";
import { Session, type Question } from "../shared/model";
import { SessionView } from "../shared/rpc";
import { basedOnSnapshot, decisionSnapshotHash } from "./plan-hash";
import { grillingComplete } from "./plan-rules";
import { buildSessionView, grillingView } from "./views";
import { answered, NOW_ISO, q } from "./test-support/build";
import {
  ALL_STATES,
  binding,
  BLK_NEXT,
  BLK_OPEN,
  blockSession,
  continuationIn,
  expectValidSession,
  need,
  roadmapData,
  type ContState,
} from "./test-support/grilling";

/** The task card's table: stored continuation state → view status and manual recovery. */
const TABLE: ReadonlyArray<[ContState, string, boolean]> = [
  ["awaiting_pause", "waiting_for_answers", false],
  ["paused", "waiting_for_accept", false],
  ["accepted_awaiting_pause", "accepted_waiting_for_pause", false],
  ["resolving", "answering", false],
  ["resumed", "continued", false],
  ["unknown", "outcome_unknown", true],
  ["pause_answered_externally", "chat_moved_on", true],
  ["pause_lost", "pause_lost", true],
  ["pause_mismatch", "card_mismatch", true],
  ["unsupported", "unsupported", true],
  ["superseded", "planner_changed", true],
  ["needs_manual", "needs_manual", true],
  ["complete", "complete", false],
];

const viewOf = (session: Session) => buildSessionView(roadmapData([session]), 7, session.id);

describe("control: the table and fixtures", () => {
  it("control: the table covers every continuation state once; the plain block fixture builds a view", () => {
    expect(TABLE.map(([s]) => s)).toEqual([...ALL_STATES]);
    const view = viewOf(blockSession());
    expect(view.session.blocks).toEqual(blockSession().blocks);
    expect(SessionView.safeParse(view).success).toBe(true);
  });
});

describe("V1/V2 which sessions get a grilling status", () => {
  it("a legacy session (even with a planner) has no grilling key; blocks without a planner give no_planner with manual recovery", () => {
    need(grillingView, "server/views.grillingView");
    const { blocks: _b, ...legacy } = { ...blockSession({ id: "s-legacy" }), questions: [q("q1")] };
    expect("grilling" in viewOf(legacy)).toBe(false);
    const { blocks: _b2, ...legacyBound } = { ...blockSession({ id: "s-legacy-bound", planner: binding() }), questions: [] };
    expectValidSession(legacyBound, "legacy session with a planner");
    expect("grilling" in viewOf(legacyBound)).toBe(false);

    const unbound = viewOf(blockSession());
    expect(unbound.grilling).toEqual({ status: "no_planner", manualRecovery: true });
  });
});

describe("V3 the state → status table", () => {
  it("planner without a continuation is idle, with the planner's agent id and epoch", () => {
    need(grillingView, "server/views.grillingView");
    const s = blockSession({ planner: binding({ epoch: 3, boundBy: "ui" }) });
    expectValidSession(s);
    expect(viewOf(s).grilling).toEqual({ status: "idle", manualRecovery: false, plannerAgentId: "agent-planner-1", epoch: 3 });
  });

  it.each(TABLE)("%s → %s (manualRecovery %s), copying reason, operationId, plannerAgentId and epoch", (state, status, manual) => {
    need(grillingView, "server/views.grillingView");
    const s = blockSession({
      planner: binding({ agentId: "a", epoch: 1 }),
      continuation: continuationIn(state, { operationId: `op-${state}`, target: { agentId: "a", epoch: 1 }, reason: `why-${state}` }),
    });
    expectValidSession(s, state);
    const g = viewOf(s).grilling;
    expect(g).toEqual({ status, manualRecovery: manual, reason: `why-${state}`, operationId: `op-${state}`, plannerAgentId: "a", epoch: 1 });
    expect(grillingView(s)).toEqual(g);
  });

  it("a continuation without a reason gives no reason; a terminal continuation from an older epoch reports the current planner's epoch", () => {
    need(grillingView, "server/views.grillingView");
    const s = blockSession({
      planner: binding({ agentId: "agent-new", epoch: 2, boundBy: "ui" }),
      plannerHistory: [binding()],
      continuation: continuationIn("superseded"),
    });
    expectValidSession(s);
    const g = viewOf(s).grilling;
    expect(g).toEqual({ status: "planner_changed", manualRecovery: true, operationId: "op-1", plannerAgentId: "agent-new", epoch: 2 });
    expect(g !== undefined && "reason" in g).toBe(false);
  });
});

describe("V4 view.session carries the stored grilling fields", () => {
  it("planner, plannerHistory, continuation and continuations are deep-equal to the store and the view validates", () => {
    need(grillingView, "server/views.grillingView");
    const s = blockSession({
      planner: binding({ epoch: 2, boundBy: "ui", workspaceId: null }),
      plannerHistory: [binding()],
      continuation: continuationIn("resolving", { operationId: "op-2", target: { agentId: "agent-planner-1", epoch: 2 }, attempts: 2 }),
      continuations: [continuationIn("superseded", { reason: "rebind" })],
    });
    expectValidSession(s);
    const view = viewOf(s);
    expect(view.session.planner).toEqual(s.planner);
    expect(view.session.plannerHistory).toEqual(s.plannerHistory);
    expect(view.session.continuation).toEqual(s.continuation);
    expect(view.session.continuations).toEqual(s.continuations);
    const parsed = SessionView.safeParse(view);
    expect(parsed.success, parsed.success ? "" : JSON.stringify(parsed.error.issues)).toBe(true);
  });
});

describe("V5 TR14: the approval gate inputs ignore grilling fields and the session status", () => {
  const questions = (): Question[] => [
    answered(q("q1", { blockId: BLK_OPEN, order: 0, options: [{ id: "a", label: "A" }, { id: "b", label: "B" }] }), "b"),
    {
      ...q("q2", { blockId: BLK_OPEN, order: 1, allowFreeText: true }),
      answer: { rev: 1, text: "free text", source: "ui", actor: { kind: "human" }, at: NOW_ISO },
      revisions: [{ rev: 1, text: "free text", source: "ui", actor: { kind: "human" }, at: NOW_ISO }],
      validity: "valid",
    },
    answered(q("q3", { blockId: BLK_NEXT, order: 2, options: [{ id: "a", label: "A" }] }), "a"),
  ];

  it("decisionSnapshotHash, basedOnSnapshot and grillingComplete are identical with and without planner, history, continuations and with status closed", () => {
    need(grillingView, "server/views.grillingView");
    const plain = blockSession({ postAccept: true, questions: questions() });
    const grilled = blockSession({
      postAccept: true,
      questions: questions(),
      status: "closed",
      planner: binding({ epoch: 2, boundBy: "ui" }),
      plannerHistory: [binding()],
      continuation: continuationIn("complete", { target: { agentId: "agent-planner-1", epoch: 2 }, acceptedBlockId: BLK_OPEN, nextBlockId: BLK_NEXT, summary: "s" }),
      continuations: [continuationIn("superseded", { operationId: "op-0", reason: "rebind" })],
    });
    expectValidSession(plain, "plain");
    expectValidSession(grilled, "grilled");
    const ids = [plain.id];
    expect(basedOnSnapshot([plain], ids).length).toBe(3);
    expect(basedOnSnapshot([grilled], ids)).toEqual(basedOnSnapshot([plain], ids));
    expect(decisionSnapshotHash([grilled], ids)).toBe(decisionSnapshotHash([plain], ids));
    expect(grillingComplete([plain], plain.id)).toBe(true);
    expect(grillingComplete([grilled], grilled.id)).toBe(grillingComplete([plain], plain.id));
    const open = blockSession({ postAccept: true, questions: questions(), planner: binding(), continuation: continuationIn("needs_manual") });
    expectValidSession(open, "post-Accept needs_manual");
    expect(decisionSnapshotHash([open], ids)).toBe(decisionSnapshotHash([plain], ids));
  });
});
