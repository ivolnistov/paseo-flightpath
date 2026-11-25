// Automatic grilling S1/G1 (task card §2, §3.4 R1–R5): the UI-only planner rebind and reopen
// contracts, their stage list, the grilling view enum and the strict SessionView extension, and the
// two new error codes. The contracts are read through ./rpc (which re-exports ./rpc-grilling), so a
// missing export fails per case instead of failing collection.
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  GRILLING_STATUSES,
  GrillingView,
  RPC_ERROR_CODES,
  RpcError,
  SessionPlannerSet,
  SessionReopen,
  SessionView,
  STAGE_G_CONTRACTS,
} from "./rpc";
import { Mutation } from "./rpc-base";
import { Id } from "./model";
import { binding, continuationIn, need, pauseSnapshot } from "../server/test-support/grilling";
import { NOW_ISO } from "../server/test-support/build";

/** The 15 statuses of the task card's state → view table, in its order. */
const STATUSES = [
  "no_planner",
  "idle",
  "waiting_for_answers",
  "waiting_for_accept",
  "accepted_waiting_for_pause",
  "answering",
  "continued",
  "outcome_unknown",
  "chat_moved_on",
  "pause_lost",
  "card_mismatch",
  "unsupported",
  "planner_changed",
  "needs_manual",
  "complete",
] as const;

const isContractList = (v: unknown): v is ReadonlyArray<{ name: string }> =>
  Array.isArray(v) && v.every((c: unknown) => typeof c === "object" && c !== null && typeof Reflect.get(c, "name") === "string");

describe("R1 contract names and shapes", () => {
  const input = { projectId: "prj_test", expectedRevision: 4, sessionId: "s1", agentId: "agent-planner-1" };

  it("session.planner.set takes projectId, expectedRevision, sessionId and agentId and returns { revision, epoch }", () => {
    const c = need(SessionPlannerSet, "shared/rpc.SessionPlannerSet");
    expect(c.name).toBe("session.planner.set");
    expect(c.input.parse(input)).toEqual(input);
    expect(c.input.parse({ ...input, agentId: "a" })).toEqual({ ...input, agentId: "a" });
    for (const k of ["projectId", "expectedRevision", "sessionId", "agentId"] as const) {
      const { [k]: _drop, ...missing } = input;
      expect(c.input.safeParse(missing).success, `missing ${k}`).toBe(false);
    }
    expect(c.input.safeParse({ ...input, agentId: "" }).success).toBe(false);
    expect(c.input.safeParse({ ...input, expectedRevision: 0 }).success).toBe(false);
    expect(c.output.safeParse({ ok: true, value: { revision: 5, epoch: 1 } }).success).toBe(true);
    expect(c.output.safeParse({ ok: true, value: { revision: 5 } }).success).toBe(false);
    expect(c.output.safeParse({ ok: true, value: { revision: 5, epoch: 0 } }).success).toBe(false);
    expect(c.output.safeParse({ ok: false, error: { code: "not_found", message: "no session" } }).success).toBe(true);
  });

  it("an extra workspaceId on session.planner.set is treated exactly like an extra key on any Mutation input", () => {
    const c = need(SessionPlannerSet, "shared/rpc.SessionPlannerSet");
    const extra = { ...input, workspaceId: "ws-smuggled" };
    const control = Mutation.extend({ sessionId: Id, agentId: Id }).safeParse(extra);
    const actual = c.input.safeParse(extra);
    expect(actual.success).toBe(control.success);
    if (actual.success && control.success) expect(actual.data).toEqual(control.data);
    // Whatever Mutation does with the key, it never reaches the parsed input as authority.
    if (actual.success) expect("workspaceId" in actual.data).toBe(false);
  });

  it("session.reopen takes projectId, expectedRevision and sessionId and returns { revision }", () => {
    const c = need(SessionReopen, "shared/rpc.SessionReopen");
    const reopen = { projectId: "prj_test", expectedRevision: 9, sessionId: "s1" };
    expect(c.name).toBe("session.reopen");
    expect(c.input.parse(reopen)).toEqual(reopen);
    const { sessionId: _s, ...noSession } = reopen;
    expect(c.input.safeParse(noSession).success).toBe(false);
    expect(c.output.safeParse({ ok: true, value: { revision: 10 } }).success).toBe(true);
    expect(c.output.safeParse({ ok: true, value: {} }).success).toBe(false);
  });
});

describe("R2 STAGE_G_CONTRACTS", () => {
  it("is exactly [SessionPlannerSet, SessionReopen] and disjoint from every other stage list", async () => {
    const list = need(STAGE_G_CONTRACTS, "shared/rpc.STAGE_G_CONTRACTS");
    expect(list).toHaveLength(2);
    expect(list[0]).toBe(SessionPlannerSet);
    expect(list[1]).toBe(SessionReopen);
    const rpc = await import("./rpc");
    const others = Object.entries(rpc).flatMap(([k, v]): ReadonlyArray<{ name: string }> => (/^STAGE.*_CONTRACTS$/.test(k) && k !== "STAGE_G_CONTRACTS" && isContractList(v) ? v : []));
    expect(others.length).toBeGreaterThan(0);
    const names = new Set(others.map((c) => c.name));
    for (const c of list) expect(names.has(c.name), c.name).toBe(false);
  });

  it("./rpc-grilling holds the same contract objects that ./rpc re-exports, imports ./rpc-base and never ./rpc", async () => {
    vi.resetModules();
    const grilling: Record<string, unknown> = await import("./rpc-grilling").catch((e: unknown) => {
      throw new Error(`missing module shared/rpc-grilling.ts: ${String(e)}`);
    });
    for (const [key, value] of Object.entries(grilling)) expect(value, `rpc-grilling.${key}`).toBeDefined();
    const rpc = await import("./rpc");
    expect(rpc.SessionPlannerSet).toBe(grilling.SessionPlannerSet);
    expect(rpc.SessionReopen).toBe(grilling.SessionReopen);
    for (const c of rpc.STAGE_G_CONTRACTS) expect(c, "no initialisation cycle").toBeDefined();
    const froms = [...readFileSync(new URL("./rpc-grilling.ts", import.meta.url), "utf8").matchAll(/^import\s+(?:type\s+)?[^;]*?from\s+"([^"]+)";/gms)].map(
      (m) => m[1],
    );
    expect(froms).not.toContain("./rpc");
    expect(froms).toContain("./rpc-base");
  });
});

describe("R3 SessionView carries the grilling fields", () => {
  const session = {
    id: "s1",
    title: "Grilling",
    createdAt: NOW_ISO,
    status: "active",
    blocks: [
      { id: "blk-open", order: 0, state: "accepted", openedAt: NOW_ISO, acceptedAt: NOW_ISO, acceptedBy: { kind: "human" } },
      { id: "blk-next", order: 1, state: "open", openedAt: NOW_ISO },
    ],
  };
  const view = (s: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
    revision: 3,
    session: s,
    questions: [],
    links: [],
    catalog: [],
    cancellations: [],
    ...extra,
  });
  const grilling = { status: "answering", manualRecovery: false, operationId: "op-1", plannerAgentId: "agent-planner-1", epoch: 2 };
  const full = {
    ...session,
    planner: binding({ epoch: 2, boundBy: "ui" }),
    plannerHistory: [binding()],
    continuation: continuationIn("resolving", { target: { agentId: "agent-planner-1", epoch: 2 } }),
    continuations: [continuationIn("superseded", { reason: "rebind" })],
  };

  it("parses a view with planner, plannerHistory, continuation, continuations and grilling, keeping each value", () => {
    need(GrillingView, "shared/rpc.GrillingView");
    const parsed = SessionView.safeParse(view(full, { grilling }));
    expect(parsed.success, parsed.success ? "" : JSON.stringify(parsed.error.issues)).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.session).toEqual(full);
    expect(parsed.data.grilling).toEqual(grilling);
  });

  it("still parses without any grilling field and still rejects an unknown session key and malformed grilling records", () => {
    need(GrillingView, "shared/rpc.GrillingView");
    const plain = SessionView.parse(view(session));
    expect("grilling" in plain).toBe(false);
    expect(Object.keys(plain.session).sort()).toEqual(["blocks", "createdAt", "id", "status", "title"]);
    expect(SessionView.safeParse(view({ ...session, extra: 1 })).success).toBe(false);
    expect(SessionView.safeParse(view({ ...full, planner: { ...binding(), epoch: 0 } })).success).toBe(false);
    expect(SessionView.safeParse(view({ ...full, continuation: { ...continuationIn("resolving"), pause: { ...pauseSnapshot(), extra: 1 } } })).success).toBe(false);
    expect(SessionView.safeParse(view(full, { grilling: { ...grilling, status: "waiting" } })).success).toBe(false);
  });
});

describe("R4 GrillingView", () => {
  it("its status enum is exactly GRILLING_STATUSES, the 15 statuses of the card's table in order", () => {
    const statuses = need(GRILLING_STATUSES, "shared/rpc.GRILLING_STATUSES");
    expect(statuses).toEqual(STATUSES);
    const schema = need(GrillingView, "shared/rpc.GrillingView");
    const status = schema.shape.status;
    expect(status.options).toEqual(STATUSES);
  });

  it("requires status and manualRecovery, keeps the optional fields, and is strict", () => {
    const schema: z.ZodType = need(GrillingView, "shared/rpc.GrillingView");
    const minimal = { status: "no_planner", manualRecovery: true };
    const all = { status: "pause_lost", manualRecovery: true, reason: "no_pause", operationId: "op-1", plannerAgentId: "a", epoch: 1 };
    expect(schema.parse(minimal)).toEqual(minimal);
    expect(schema.parse(all)).toEqual(all);
    expect(schema.safeParse({ status: "idle" }).success).toBe(false);
    expect(schema.safeParse({ manualRecovery: false }).success).toBe(false);
    expect(schema.safeParse({ ...minimal, extra: 1 }).success).toBe(false);
    expect(schema.safeParse({ ...all, epoch: 0 }).success).toBe(false);
    expect(schema.safeParse({ ...all, operationId: "" }).success).toBe(false);
  });
});

describe("R5 error codes", () => {
  it("RPC_ERROR_CODES contain planner_bound and stale_operation, and the error envelope parses both", () => {
    expect(RPC_ERROR_CODES).toContain("planner_bound");
    expect(RPC_ERROR_CODES).toContain("stale_operation");
    expect(RpcError.safeParse({ code: "planner_bound", message: "not the planner" }).success).toBe(true);
    expect(RpcError.safeParse({ code: "stale_operation", message: "stale", details: { state: "resumed" } }).success).toBe(true);
  });
});

// R3: a discussion planner's view carries the roadmap tools state.
describe("GrillingView tools state", () => {
  const base = { status: "idle", manualRecovery: false, plannerAgentId: "agent-1", epoch: 1 };
  it("accepts the four tools states and rejects any other", async () => {
    const { GrillingView } = await import("./rpc-grilling");
    for (const tools of ["attached", "pending", "not_attached", "unknown"]) expect(GrillingView.safeParse({ ...base, tools }).success, tools).toBe(true);
    expect(GrillingView.safeParse({ ...base, tools: "maybe" }).success).toBe(false);
    expect(GrillingView.safeParse(base).success).toBe(true);
  });
});
