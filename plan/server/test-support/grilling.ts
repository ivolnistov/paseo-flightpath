// Synthetic fixtures for automatic adaptive grilling, stage S1 (task card §3.3): planner bindings,
// one minimal valid continuation per state (rules C1–C8), v2 sessions with grilling blocks, and a
// helper that seeds those fields into a temp project store through `store.transact`, since S1 has
// no command that mints a continuation. Every id is synthetic; agent ids are free strings (TR7).
import { expect } from "vitest";
import type { z } from "zod";
import { canonicalJson } from "../../shared/canonical";
import {
  Session,
  type Block,
  type Continuation,
  type ContinuationState,
  type PauseSnapshot,
  type PlannerBinding,
  type Question,
  type RoadmapData,
  type Session as SessionRecord,
} from "../../shared/model";
import type { StoreOpener } from "../sessions";
import { NOW_ISO, q } from "./build";

export type Binding = z.infer<typeof PlannerBinding>;
export type Cont = z.infer<typeof Continuation>;
export type ContState = z.infer<typeof ContinuationState>;
export type Pause = z.infer<typeof PauseSnapshot>;

/**
 * The value of an export the stage adds, or a clear failure naming it. A missing named export of an
 * existing module reads as undefined under vitest, so each case fails on this line instead of a
 * TypeError further down.
 */
export function need<T>(value: T, name: string): NonNullable<T> {
  if (value === undefined || value === null) throw new Error(`missing export: ${name}`);
  return value;
}

export const PLANNER = "agent-planner-1";
export const OTHER_AGENT = "agent-B";
/** A one-character agent id and a UUID-shaped one: ids are never schema-checked as UUIDs (TR7). */
export const SHORT_AGENT = "a";
export const UUID_AGENT = "3f1c2b9e-8d7a-4c6b-9e5f-1a2b3c4d5e6f";
export const OP = "op-1";
export const BLK_OPEN = "blk-open";
export const BLK_NEXT = "blk-next";
export const PAUSE_TEXT = `Decision Roadmap: waiting for block acceptance (DR-OP-${OP})`;
export const SUMMARY = `Decision Roadmap: block 1 accepted (session "Grilling", block ${BLK_OPEN})\nq1 1`;

/** Every continuation state, in the task card's order (independent of the production constant). */
export const ALL_STATES = [
  "awaiting_pause",
  "paused",
  "accepted_awaiting_pause",
  "resolving",
  "resumed",
  "unknown",
  "pause_answered_externally",
  "pause_lost",
  "pause_mismatch",
  "unsupported",
  "superseded",
  "needs_manual",
  "complete",
] as const satisfies readonly ContState[];
export const LIVE_STATES = ["awaiting_pause", "paused", "accepted_awaiting_pause", "resolving"] as const satisfies readonly ContState[];
export const TERMINAL_STATES = [
  "resumed",
  "unknown",
  "pause_answered_externally",
  "pause_lost",
  "pause_mismatch",
  "unsupported",
  "superseded",
  "needs_manual",
  "complete",
] as const satisfies readonly ContState[];

/** C2: states that require the accepted refs (and, by C5, the summary). */
export const ACCEPTED_REQUIRED: readonly ContState[] = ["accepted_awaiting_pause", "resolving", "resumed", "unknown", "needs_manual"];
/** C3: states that forbid the accepted refs. */
export const ACCEPTED_FORBIDDEN: readonly ContState[] = ["awaiting_pause", "paused", "unsupported", "pause_mismatch"];
/** C4: states that require the pause snapshot. */
export const PAUSE_REQUIRED: readonly ContState[] = ["paused", "resolving", "resumed", "unknown", "pause_answered_externally"];
/** C8: states with `attempts === 0` and states with `attempts >= 1`. */
export const ZERO_ATTEMPTS: readonly ContState[] = ["awaiting_pause", "paused", "accepted_awaiting_pause"];
export const SOME_ATTEMPTS: readonly ContState[] = ["resolving", "resumed", "unknown"];

export function binding(overrides: Partial<Binding> = {}): Binding {
  return { agentId: PLANNER, workspaceId: "ws-1", boundAt: NOW_ISO, boundBy: "ask", epoch: 1, ...overrides };
}

export function pauseSnapshot(overrides: Partial<Pause> = {}): Pause {
  return {
    requestId: "permission-req-1",
    provider: "claude",
    name: "AskUserQuestion",
    seenAt: NOW_ISO,
    questionText: PAUSE_TEXT,
    header: "Roadmap",
    optionLabels: ["Continue", "Stop"],
    ...overrides,
  };
}

/** Whether a state's minimal fixture carries the accepted refs (only where C2 requires them). */
export const isPostAccept = (state: ContState): boolean => ACCEPTED_REQUIRED.includes(state);

/**
 * A minimal valid continuation in `state`: operation `op-1` for block `blk-open`, targeting the
 * planner at epoch 1; accepted refs and summary only where C2/C5 require them, the pause snapshot
 * only where C4 requires it, and `attempts` per C8 (1 where at least one call is required).
 */
export function continuationIn(state: ContState, overrides: Partial<Cont> = {}): Cont {
  return {
    operationId: OP,
    openBlockId: BLK_OPEN,
    target: { agentId: PLANNER, epoch: 1 },
    state,
    attempts: SOME_ATTEMPTS.includes(state) ? 1 : 0,
    at: NOW_ISO,
    ...(isPostAccept(state) ? { acceptedBlockId: BLK_OPEN, nextBlockId: BLK_NEXT, summary: SUMMARY } : {}),
    ...(PAUSE_REQUIRED.includes(state) ? { pause: pauseSnapshot() } : {}),
    ...overrides,
  };
}

/** Removes keys from a continuation fixture (to build a rule violation). */
export function without(c: Cont, ...keys: Array<keyof Cont & string>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...c };
  for (const k of keys) delete out[k];
  return out;
}

/** Blocks for a session: `blk-open` open, or after an Accept `blk-open` accepted and `blk-next` open. */
export function blocksFor(postAccept: boolean): Block[] {
  if (!postAccept) return [{ id: BLK_OPEN, order: 0, state: "open", openedAt: NOW_ISO }];
  return [
    { id: BLK_OPEN, order: 0, state: "accepted", openedAt: NOW_ISO, acceptedAt: NOW_ISO, acceptedBy: { kind: "human" } },
    { id: BLK_NEXT, order: 1, state: "open", openedAt: NOW_ISO },
  ];
}

export interface BlockSessionOptions {
  id?: string;
  title?: string;
  status?: "active" | "closed";
  /** Blocks after an Accept; defaults to whether `continuation` carries accepted refs. */
  postAccept?: boolean;
  planner?: Binding;
  plannerHistory?: Binding[];
  continuation?: Cont;
  continuations?: Cont[];
  questions?: Question[];
}

/**
 * A v2 session with grilling blocks (one question in `blk-open`) and the given optional grilling
 * fields; absent options add no key. Returned unparsed so a test can check what the schema says.
 */
export function blockSession(opts: BlockSessionOptions = {}): Session {
  const postAccept = opts.postAccept ?? opts.continuation?.acceptedBlockId !== undefined;
  return {
    id: opts.id ?? "s-grill",
    title: opts.title ?? "Grilling",
    createdAt: NOW_ISO,
    status: opts.status ?? "active",
    questions: opts.questions ?? [q("q1", { blockId: BLK_OPEN, options: [{ id: "a", label: "A" }, { id: "b", label: "B" }] })],
    blocks: blocksFor(postAccept),
    ...(opts.planner !== undefined ? { planner: opts.planner } : {}),
    ...(opts.plannerHistory !== undefined ? { plannerHistory: opts.plannerHistory } : {}),
    ...(opts.continuation !== undefined ? { continuation: opts.continuation } : {}),
    ...(opts.continuations !== undefined ? { continuations: opts.continuations } : {}),
  };
}

/** Asserts that the Session schema accepts a fixture, with the schema's own issues as the message. */
export function expectValidSession(session: unknown, label = "session fixture"): void {
  const parsed = Session.safeParse(session);
  expect(parsed.success, `${label} must be a valid Session: ${parsed.success ? "" : JSON.stringify(parsed.error.issues)}`).toBe(true);
}

/** A schema-valid v2 roadmap holding `sessions` (no plans, features, runs or delegations). */
export function roadmapData(sessions: Session[]): RoadmapData {
  return {
    meta: {
      version: 2,
      projectId: "prj_test",
      createdAt: NOW_ISO,
      links: [],
      sessionIds: sessions.map((s) => s.id),
      planIds: [],
      featureIds: [],
      runIds: [],
      settings: {},
    },
    sessions,
    plans: [],
    features: [],
    runs: [],
    delegations: [],
  };
}

/** The four grilling fields of a stored session, canonicalised (absent fields stay absent). */
export function grillingFields(session: Session | undefined): string {
  if (session === undefined) throw new Error("session not found");
  return canonicalJson({
    planner: session.planner,
    plannerHistory: session.plannerHistory,
    continuation: session.continuation,
    continuations: session.continuations,
  });
}

export interface SeedPatch {
  planner?: Binding;
  plannerHistory?: Binding[];
  continuation?: Cont;
  continuations?: Cont[];
  status?: "active" | "closed";
  /** Replace the session's blocks (e.g. `blocksFor(true)`); questions keep their block ids. */
  blocks?: Block[];
  /** Recorded retries of a manual continuation. */
  retries?: SessionRecord["retries"];
}

/**
 * Writes grilling fields into a stored session in one `store.transact` at the current revision, the
 * way `sessions-origin.test.ts` seeds state no command can create yet. The patched session is first
 * checked against the Session schema, so a schema that lacks the fields fails here by name.
 */
export async function seedGrilling(open: StoreOpener, projectId: string, sessionId: string, patch: SeedPatch): Promise<number> {
  const store = await open(projectId);
  const read = await store.read();
  if (read.status !== "ok") throw new Error(`expected an ok store, got ${read.status}`);
  const current = read.data.sessions.find((s) => s.id === sessionId);
  if (current === undefined) throw new Error(`session ${sessionId} not found`);
  expectValidSession({ ...current, ...patch }, `seeded session ${sessionId}`);
  const out = await store.transact(read.revision, (draft) => {
    const s = draft.sessions.find((x) => x.id === sessionId)!;
    Object.assign(s, patch);
  });
  return out.revision;
}
