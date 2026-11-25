// Automatic grilling S1/G1 (task card §2, §3.4 M1–M5): the planner binding, the continuation
// record with rules C1–C8, the live/terminal state split, the Session rules S1–S8, and byte-stable
// round trips of every existing session fixture. Synthetic data only.
//
// Cases named "control:" hold at the current baseline too: they prove the fixtures are valid
// without the new fields, so a RED case fails for the missing schema rule and not for its fixture.
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { canonicalJson } from "./canonical";
import {
  CONTINUATION_STATES,
  Continuation,
  ContinuationState,
  Feature,
  isTerminalContinuation,
  LIVE_CONTINUATION_STATES,
  PlannerBinding,
  Question,
  RoadmapDataV2,
  Session,
  TERMINAL_CONTINUATION_STATES,
} from "./model";
import {
  ACCEPTED_FORBIDDEN,
  ACCEPTED_REQUIRED,
  ALL_STATES,
  binding,
  BLK_NEXT,
  BLK_OPEN,
  blockSession,
  continuationIn,
  LIVE_STATES,
  need,
  PAUSE_REQUIRED,
  pauseSnapshot,
  roadmapData,
  SHORT_AGENT,
  SOME_ATTEMPTS,
  SUMMARY,
  TERMINAL_STATES,
  UUID_AGENT,
  without,
  ZERO_ATTEMPTS,
} from "../server/test-support/grilling";
import { NOW_ISO } from "../server/test-support/build";

const accepts = (schema: z.ZodType, value: unknown): boolean => schema.safeParse(value).success;
const issues = (schema: z.ZodType, value: unknown): string => {
  const r = schema.safeParse(value);
  return r.success ? "(parsed)" : JSON.stringify(r.error.issues.map((i) => i.message));
};

describe("control: fixtures without grilling fields are valid at the baseline", () => {
  it("control: blockSession() with one open block, and the post-Accept block pair, parse as Session", () => {
    expect(issues(Session, blockSession())).toBe("(parsed)");
    expect(issues(Session, blockSession({ postAccept: true }))).toBe("(parsed)");
    expect(issues(RoadmapDataV2, roadmapData([blockSession()]))).toBe("(parsed)");
  });
});

describe("M1 PlannerBinding", () => {
  it("accepts the fixture, a null workspace, every boundBy, a one-character and a UUID-shaped agent id", () => {
    const schema = need(PlannerBinding, "shared/model.PlannerBinding");
    for (const value of [
      binding(),
      binding({ workspaceId: null }),
      binding({ agentId: SHORT_AGENT }),
      binding({ agentId: UUID_AGENT }),
      binding({ boundBy: "draft" }),
      binding({ boundBy: "ui", epoch: 7 }),
    ]) {
      expect(issues(schema, value), JSON.stringify(value)).toBe("(parsed)");
    }
    expect(schema.parse(binding({ workspaceId: null }))).toEqual(binding({ workspaceId: null }));
  });

  it("rejects an empty agentId, epoch 0 or fractional, boundBy agent, a non-ISO boundAt, a missing field and an extra key", () => {
    const schema = need(PlannerBinding, "shared/model.PlannerBinding");
    const { epoch: _epoch, ...noEpoch } = binding();
    for (const bad of [
      binding({ agentId: "" }),
      binding({ epoch: 0 }),
      binding({ epoch: 1.5 }),
      { ...binding(), boundBy: "agent" },
      binding({ boundAt: "yesterday" }),
      noEpoch,
      { ...binding(), extra: true },
    ]) {
      expect(accepts(schema, bad), JSON.stringify(bad)).toBe(false);
    }
  });
});

describe("M2 Continuation rules C1–C8", () => {
  it("accepts the minimal fixture of every one of the 13 states", () => {
    const schema = need(Continuation, "shared/model.Continuation");
    for (const state of ALL_STATES) expect(issues(schema, continuationIn(state)), state).toBe("(parsed)");
  });

  it("accepts optional fields where no rule forbids them: a reason, a resolution with a pause, accepted refs on a terminal state", () => {
    const schema = need(Continuation, "shared/model.Continuation");
    const accepted = { acceptedBlockId: BLK_OPEN, nextBlockId: BLK_NEXT, summary: SUMMARY };
    for (const value of [
      continuationIn("unsupported", { reason: "codex default mode" }),
      continuationIn("resumed", { resolution: { behavior: "allow", at: NOW_ISO, source: "plugin" } }),
      continuationIn("pause_answered_externally", { resolution: { behavior: "deny", at: NOW_ISO, source: "host" } }),
      continuationIn("pause_lost", { ...accepted, pause: pauseSnapshot() }),
      continuationIn("superseded", { reason: "rebind", target: { agentId: UUID_AGENT, epoch: 3 } }),
      continuationIn("resolving", { attempts: 3 }),
    ]) {
      expect(issues(schema, value), JSON.stringify(value)).toBe("(parsed)");
    }
  });

  it("C1: acceptedBlockId without nextBlockId, and nextBlockId without acceptedBlockId, are rejected", () => {
    const schema = need(Continuation, "shared/model.Continuation");
    expect(accepts(schema, continuationIn("pause_lost", { acceptedBlockId: BLK_OPEN, summary: SUMMARY }))).toBe(false);
    expect(accepts(schema, continuationIn("pause_lost", { nextBlockId: BLK_NEXT }))).toBe(false);
  });

  it.each(ACCEPTED_REQUIRED)("C2: %s without the accepted refs is rejected", (state) => {
    const schema = need(Continuation, "shared/model.Continuation");
    expect(accepts(schema, without(continuationIn(state), "acceptedBlockId", "nextBlockId", "summary"))).toBe(false);
  });

  it.each(ACCEPTED_FORBIDDEN)("C3: %s with accepted refs is rejected", (state) => {
    const schema = need(Continuation, "shared/model.Continuation");
    expect(accepts(schema, continuationIn(state, { acceptedBlockId: BLK_OPEN, nextBlockId: BLK_NEXT, summary: SUMMARY }))).toBe(false);
  });

  it.each(PAUSE_REQUIRED)("C4: %s without the pause snapshot is rejected", (state) => {
    const schema = need(Continuation, "shared/model.Continuation");
    expect(accepts(schema, without(continuationIn(state), "pause", "resolution"))).toBe(false);
  });

  it("C5: a summary without acceptedBlockId, and acceptedBlockId without a summary, are rejected", () => {
    const schema = need(Continuation, "shared/model.Continuation");
    expect(accepts(schema, continuationIn("pause_lost", { summary: SUMMARY }))).toBe(false);
    expect(accepts(schema, without(continuationIn("needs_manual"), "summary"))).toBe(false);
  });

  it("C6: acceptedBlockId other than openBlockId, and nextBlockId equal to acceptedBlockId, are rejected", () => {
    const schema = need(Continuation, "shared/model.Continuation");
    expect(accepts(schema, continuationIn("needs_manual", { acceptedBlockId: "blk-other" }))).toBe(false);
    expect(accepts(schema, continuationIn("needs_manual", { nextBlockId: BLK_OPEN }))).toBe(false);
  });

  it("C7: a resolution without a pause snapshot is rejected", () => {
    const schema = need(Continuation, "shared/model.Continuation");
    expect(accepts(schema, continuationIn("pause_lost", { resolution: { behavior: "deny", at: NOW_ISO, source: "host" } }))).toBe(false);
  });

  it.each(ZERO_ATTEMPTS)("C8: %s with attempts 1 is rejected", (state) => {
    const schema = need(Continuation, "shared/model.Continuation");
    expect(accepts(schema, continuationIn(state, { attempts: 1 }))).toBe(false);
  });

  it.each(SOME_ATTEMPTS)("C8: %s with attempts 0 is rejected", (state) => {
    const schema = need(Continuation, "shared/model.Continuation");
    expect(accepts(schema, continuationIn(state, { attempts: 0 }))).toBe(false);
  });

  it("rejects an extra key, a negative or fractional attempts count, a bad target and malformed nested records", () => {
    const schema = need(Continuation, "shared/model.Continuation");
    for (const bad of [
      { ...continuationIn("awaiting_pause"), extra: 1 },
      continuationIn("pause_lost", { attempts: -1 }),
      continuationIn("pause_lost", { attempts: 1.5 }),
      continuationIn("awaiting_pause", { target: { agentId: "", epoch: 1 } }),
      continuationIn("awaiting_pause", { target: { agentId: "agent-planner-1", epoch: 0 } }),
      { ...continuationIn("awaiting_pause"), target: { agentId: "agent-planner-1", epoch: 1, workspaceId: "ws-1" } },
      { ...continuationIn("awaiting_pause"), state: "waiting" },
      continuationIn("awaiting_pause", { at: "now" }),
      { ...continuationIn("paused"), pause: { ...pauseSnapshot(), extra: 1 } },
      continuationIn("paused", { pause: pauseSnapshot({ requestId: "" }) }),
      { ...continuationIn("resumed"), resolution: { behavior: "allow", at: NOW_ISO, source: "agent" } },
      { ...continuationIn("resumed"), resolution: { behavior: "maybe", at: NOW_ISO, source: "plugin" } },
    ]) {
      expect(accepts(schema, bad), JSON.stringify(bad)).toBe(false);
    }
  });
});


describe("M3 live and terminal states", () => {
  it("CONTINUATION_STATES and the ContinuationState enum list exactly the 13 states in the card's order", () => {
    expect(need(CONTINUATION_STATES, "shared/model.CONTINUATION_STATES")).toEqual(ALL_STATES);
    expect(need(ContinuationState, "shared/model.ContinuationState").options).toEqual(ALL_STATES);
  });

  it("isTerminalContinuation is true exactly for the nine terminal states", () => {
    const isTerminal = need(isTerminalContinuation, "shared/model.isTerminalContinuation");
    for (const state of TERMINAL_STATES) expect(isTerminal(state), state).toBe(true);
    for (const state of LIVE_STATES) expect(isTerminal(state), state).toBe(false);
  });

  it("the live and terminal lists are disjoint and together are every state", () => {
    const live = need(LIVE_CONTINUATION_STATES, "shared/model.LIVE_CONTINUATION_STATES");
    const terminal = need(TERMINAL_CONTINUATION_STATES, "shared/model.TERMINAL_CONTINUATION_STATES");
    expect([...live].sort()).toEqual([...LIVE_STATES].sort());
    expect([...terminal].sort()).toEqual([...TERMINAL_STATES].sort());
    expect(live.filter((s) => terminal.includes(s))).toEqual([]);
    expect([...live, ...terminal].sort()).toEqual([...ALL_STATES].sort());
  });
});

describe("M4 Session rules S1–S7", () => {
  const planner = binding({ epoch: 2 });
  const live = continuationIn("awaiting_pause", { target: { agentId: planner.agentId, epoch: 2 } });

  it("accepts a planner on a session without blocks, a live continuation of the current planner, and a terminal one from an older epoch after a rebind", () => {
    need(PlannerBinding, "shared/model.PlannerBinding");
    const { blocks: _blocks, ...legacy } = { ...blockSession({ planner: binding() }), questions: [] };
    expect(issues(Session, legacy)).toBe("(parsed)");
    expect(issues(Session, blockSession({ planner, continuation: live }))).toBe("(parsed)");
    const rebound = blockSession({
      planner: binding({ agentId: "agent-new", boundBy: "ui", epoch: 2 }),
      plannerHistory: [binding()],
      continuation: continuationIn("superseded", { reason: "rebind" }),
    });
    expect(issues(Session, rebound)).toBe("(parsed)");
  });

  it("accepts a history of three terminal continuations with distinct operation ids beside a live current one", () => {
    need(Continuation, "shared/model.Continuation");
    const s = blockSession({
      planner,
      continuation: { ...live, operationId: "op-4" },
      continuations: [
        continuationIn("pause_lost", { operationId: "op-1", reason: "no_pause" }),
        continuationIn("superseded", { operationId: "op-2", reason: "rebind" }),
        continuationIn("pause_mismatch", { operationId: "op-3", target: { agentId: planner.agentId, epoch: 2 } }),
      ],
    });
    expect(issues(Session, s)).toBe("(parsed)");
  });

  it("S1: a continuation, or a non-empty continuations list, on a session without blocks is rejected", () => {
    need(Continuation, "shared/model.Continuation");
    const base = { ...blockSession({ planner: binding() }), questions: [] };
    const { blocks: _b, ...noBlocks } = base;
    expect(issues(Session, noBlocks)).toBe("(parsed)");
    expect(accepts(Session, { ...noBlocks, continuation: continuationIn("awaiting_pause") })).toBe(false);
    expect(accepts(Session, { ...noBlocks, continuations: [continuationIn("pause_lost")] })).toBe(false);
  });

  it("S2: a continuation or continuations without a planner is rejected", () => {
    need(Continuation, "shared/model.Continuation");
    expect(accepts(Session, blockSession({ continuation: continuationIn("awaiting_pause") }))).toBe(false);
    expect(accepts(Session, blockSession({ continuations: [continuationIn("pause_lost")] }))).toBe(false);
  });

  it("S3: openBlockId or nextBlockId naming no block, or acceptedBlockId naming an open block, is rejected", () => {
    need(Continuation, "shared/model.Continuation");
    const p = binding();
    expect(issues(Session, blockSession({ planner: p, continuation: continuationIn("needs_manual") }))).toBe("(parsed)");
    expect(accepts(Session, blockSession({ planner: p, continuation: continuationIn("awaiting_pause", { openBlockId: "blk-missing" }) }))).toBe(false);
    expect(
      accepts(Session, blockSession({ planner: p, continuation: continuationIn("needs_manual", { nextBlockId: "blk-missing" }) })),
    ).toBe(false);
    // Accepted refs naming blk-open while blk-open is still the open block (nextBlockId names an existing block).
    const openStill = {
      ...blockSession({ planner: p, continuation: continuationIn("needs_manual", { nextBlockId: "blk-prev" }) }),
      blocks: [
        { id: "blk-prev", order: 0, state: "accepted", openedAt: NOW_ISO, acceptedAt: NOW_ISO, acceptedBy: { kind: "human" } },
        { id: BLK_OPEN, order: 1, state: "open", openedAt: NOW_ISO },
      ],
    };
    expect(accepts(Session, openStill)).toBe(false);
    expect(issues(Session, { ...openStill, continuation: undefined })).toBe("(parsed)");
  });

  it("S4: a live continuation for another agent or epoch, or a terminal one from a future epoch, is rejected", () => {
    need(Continuation, "shared/model.Continuation");
    expect(accepts(Session, blockSession({ planner, continuation: { ...live, target: { agentId: "agent-B", epoch: 2 } } }))).toBe(false);
    expect(accepts(Session, blockSession({ planner, continuation: { ...live, target: { agentId: planner.agentId, epoch: 1 } } }))).toBe(false);
    expect(
      accepts(Session, blockSession({ planner, continuation: continuationIn("pause_lost", { target: { agentId: planner.agentId, epoch: 3 } }) })),
    ).toBe(false);
  });

  it("S5: a history without a planner, with non-increasing epochs, or with an epoch not below the planner's, is rejected", () => {
    need(PlannerBinding, "shared/model.PlannerBinding");
    const p3 = binding({ epoch: 3, boundBy: "ui" });
    expect(issues(Session, blockSession({ planner: p3, plannerHistory: [binding(), binding({ epoch: 2, boundBy: "ui" })] }))).toBe("(parsed)");
    expect(accepts(Session, blockSession({ plannerHistory: [binding()] }))).toBe(false);
    expect(accepts(Session, blockSession({ planner: p3, plannerHistory: [binding({ epoch: 2 }), binding()] }))).toBe(false);
    expect(accepts(Session, blockSession({ planner: p3, plannerHistory: [binding(), binding()] }))).toBe(false);
    expect(accepts(Session, blockSession({ planner: p3, plannerHistory: [binding(), binding({ epoch: 3 })] }))).toBe(false);
  });

  it.each(LIVE_STATES)("S6: a %s entry in continuations is rejected", (state) => {
    need(Continuation, "shared/model.Continuation");
    const entry = continuationIn(state, { operationId: "op-old" });
    expect(accepts(Session, blockSession({ planner: binding(), postAccept: true, continuations: [entry] }))).toBe(false);
  });

  it("S7: a repeated operationId inside continuations, or shared with the current continuation, is rejected", () => {
    need(Continuation, "shared/model.Continuation");
    const p = binding();
    const old = continuationIn("pause_lost", { operationId: "op-0" });
    expect(accepts(Session, blockSession({ planner: p, continuations: [old, { ...old }] }))).toBe(false);
    expect(accepts(Session, blockSession({ planner: p, continuation: continuationIn("awaiting_pause", { operationId: "op-0" }), continuations: [old] }))).toBe(false);
  });
});

describe("M5 S8 byte-stable round trips", () => {
  const fixtureSessions = (): Array<[string, unknown]> => {
    const out: Array<[string, unknown]> = [];
    const branching: unknown = JSON.parse(readFileSync(new URL("../server/fixtures/session-branching.json", import.meta.url), "utf8"));
    const list = z.object({ sessions: z.array(z.unknown()) }).parse(branching).sessions;
    list.forEach((s, i) => out.push([`session-branching.json#${i}`, s]));
    const gens = new URL("../server/fixtures/v1-store/generations/", import.meta.url);
    for (const gen of readdirSync(gens)) {
      const dir = new URL(`${gen}/sessions/`, gens);
      for (const file of readdirSync(dir)) out.push([`v1-store/${gen}/sessions/${file}`, JSON.parse(readFileSync(new URL(file, dir), "utf8"))]);
    }
    return out;
  };

  it("control: every existing session fixture parses as Session and re-serialises canonically byte-identical", () => {
    const all = fixtureSessions();
    expect(all.length).toBeGreaterThanOrEqual(5);
    for (const [name, raw] of all) {
      const parsed = Session.safeParse(raw);
      expect(parsed.success, name).toBe(true);
      if (parsed.success) expect(canonicalJson(parsed.data), name).toBe(canonicalJson(raw));
    }
  });

  it("a v2 roadmap holding a grilling session parses and keeps every grilling field byte-identical", () => {
    need(Continuation, "shared/model.Continuation");
    const s = blockSession({
      planner: binding({ epoch: 2, boundBy: "ui" }),
      plannerHistory: [binding()],
      continuation: continuationIn("awaiting_pause", { operationId: "op-2", target: { agentId: "agent-planner-1", epoch: 2 } }),
      continuations: [continuationIn("superseded", { reason: "rebind" })],
    });
    const data = roadmapData([s]);
    const parsed = RoadmapDataV2.safeParse(data);
    expect(parsed.success, issues(RoadmapDataV2, data)).toBe(true);
    if (parsed.success) expect(canonicalJson(parsed.data)).toBe(canonicalJson(data));
  });
});

// Finish proposal, retries and the discussion binding: additive, strict session fields.
describe("feature discussion session fields", () => {
  const T = "2026-10-20T10:00:00.000Z";
  const base = { id: "s1", title: "S", createdAt: T, status: "active" as const, questions: [] };
  it("a finish proposal records who proposed it, the summary and the skipped and out-of-scope numbers; finishedAt is optional", () => {
    const proposal = { at: T, agentId: "agent-1", summary: "Done", skipped: [1], outOfScope: [2] };
    expect(Session.safeParse({ ...base, finishProposal: proposal }).success).toBe(true);
    expect(Session.safeParse({ ...base, finishProposal: { ...proposal, finishedAt: T } }).success).toBe(true);
    expect(Session.safeParse({ ...base, finishProposal: { ...proposal, skipped: [0] } }).success).toBe(false);
    expect(Session.safeParse({ ...base, finishProposal: { ...proposal, extra: 1 } }).success).toBe(false);
    const { agentId: _a, ...anonymous } = proposal;
    expect(Session.safeParse({ ...base, finishProposal: anonymous }).success).toBe(false);
  });

  it("retries are recorded as sending, sent, failed or unknown, with who resolved an uncertain one", () => {
    const retry = { id: "r1", at: T, blockId: "b1", agentId: "agent-1", epoch: 1, state: "sent" };
    expect(Session.safeParse({ ...base, retries: [retry, { ...retry, id: "r2", state: "failed", error: "timeout" }] }).success).toBe(true);
    for (const state of ["sending", "unknown"]) expect(Session.safeParse({ ...base, retries: [{ ...retry, state }] }).success, state).toBe(true);
    for (const resolvedBy of ["user", "sweep", "timeline"]) {
      expect(Session.safeParse({ ...base, retries: [{ ...retry, operationId: "op-1", resolvedAt: T, resolvedBy }] }).success, resolvedBy).toBe(true);
    }
    expect(Session.safeParse({ ...base, retries: [{ ...retry, resolvedBy: "guess" }] }).success).toBe(false);
    expect(Session.safeParse({ ...base, retries: [{ ...retry, state: "pending" }] }).success).toBe(false);
  });

  it("a planner may be bound by a discussion; other binding kinds stay rejected", () => {
    const planner = { agentId: "agent-1", workspaceId: null, boundAt: T, epoch: 1 };
    expect(PlannerBinding.safeParse({ ...planner, boundBy: "discussion" }).success).toBe(true);
    expect(PlannerBinding.safeParse({ ...planner, boundBy: "ask" }).success).toBe(true);
    expect(PlannerBinding.safeParse({ ...planner, boundBy: "other" }).success).toBe(false);
  });

  it("a question may carry tag language and no other tag", () => {
    const q = { id: "q1", order: 0, title: "Language", context: "", options: [], allowFreeText: true, definitionRev: 1, activatedBy: [], invalidatedBy: [], revisions: [], discussion: [], validity: "unanswered" };
    expect(Question.safeParse({ ...q, tag: "language" }).success).toBe(true);
    expect(Question.safeParse({ ...q, tag: "priority" }).success).toBe(false);
  });
});

// The feature's discussion chat: a reservation while creating, a recorded failure, or the binding.
describe("Feature.discussion", () => {
  const T = "2026-10-20T10:00:00.000Z";
  const card = { id: "f1", title: "Login", description: "", kind: "feature", status: "created", dependsOn: [], relatedTo: [], everStarted: false, createdAt: T, createdBy: { kind: "human" }, coordinatorHistory: [], events: [] };
  const parses = (discussion: unknown, extra: Record<string, unknown> = {}) => {
    const shape = Feature.safeParse({ ...card, discussion, ...extra });
    return shape.success;
  };
  it("accepts creating, unresolved, failed and bound, each with its own fields, and keeps earlier bindings as history", () => {
    const creating = { state: "creating", reservationId: "r1", profileRef: "team-research", workspaceId: "wks_1", at: T };
    const failed = { state: "failed", reservationId: "r1", profileRef: "team-research", workspaceId: "wks_1", at: T, error: "password required" };
    const bound = { state: "bound", reservationId: "r1", agentId: "agent-1", workspaceId: "wks_1", boundAt: T, profileRef: "team-research" };
    const unresolved = { state: "unresolved", reservationId: "r1", profileRef: "team-research", workspaceId: "wks_1", at: T, checkedAt: T };
    expect(Feature.safeParse(card).success, "control: the card without a discussion").toBe(true);
    for (const d of [creating, failed, bound, unresolved]) expect(parses(d), d.state).toBe(true);
    expect(parses({ ...unresolved, agentId: "agent-1" }), "an unresolved creation names no agent").toBe(false);
    expect(parses(bound, { discussionHistory: [bound] })).toBe(true);
    const { error: _e, ...failedWithoutReason } = failed;
    expect(parses(failedWithoutReason)).toBe(false);
    const { agentId: _a, ...boundWithoutAgent } = bound;
    expect(parses(boundWithoutAgent)).toBe(false);
    expect(parses({ ...creating, agentId: "agent-1" })).toBe(false);
    expect(parses({ ...bound, state: "unknown" })).toBe(false);
  });
});
