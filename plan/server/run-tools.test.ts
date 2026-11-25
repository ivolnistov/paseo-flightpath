// Stage R3.4 (task card 2026-10-29 R3 §5.2, §5.3): MCP run tools for the bound coordinator. Every tool
// needs a bound grant (ctx.agentId); run-scoped tools carry the runToken (mismatch → run_stale). No tool
// approves, verifies, accepts, pauses, resumes, reworks, cancels or grants budget. Tools are exercised
// through the table (no network); registration in the endpoint is R3.5.
// Interface choice (reported; the card names the tools, not the factory or argument keys):
// `buildRunTools(runs, { paseo: () => PaseoApi | null })` in server/run-tools.ts; run-scoped inputs
// `{ runId, runToken, taskId? , state? }`, roadmap_start `{ scope, featureId?, quoted }`,
// roadmap_feature_bind `{ featureId }`.
import { afterEach, describe, expect, it } from "vitest";
import type { ExecutionRun, Feature } from "../shared/model";
import { roadmapSettings } from "../shared/settings";
import { UI_ORIGIN, type WriteOrigin } from "./sessions";
import { fixedClock, NOW_ISO, nextId } from "./test-support/build";
import { makePlanProject, type PlanProject } from "./test-support/plans";
import { z } from "zod";

/** R4 successor c0038: when true, the fake SDK rejects replacement steers (set per test, reset after each). */
let replacementSendFails = false;

// Readers for the tool values these tests assert (every accessed field is validated; absence stays absent).
const RunNext = z.object({ ready: z.array(z.string()), blocked: z.array(z.object({ code: z.string(), taskId: z.string().optional() })) });
const Started = z.object({ started: z.array(z.string()).optional() });

let t: PlanProject | undefined;
afterEach(async () => {
  await t?.cleanup();
  t = undefined;
});
const ok = <T>(r: { ok: true; value: T } | { ok: false; error: { code: string; message: string } }): T => {
  if (!r.ok) throw new Error(`expected ok, got ${r.error.code}: ${r.error.message}`);
  return r.value;
};
const TOOL_NAMES = ["roadmap_run_next", "roadmap_task_claim", "roadmap_task_progress", "roadmap_run_ack", "roadmap_start", "roadmap_feature_bind"];
const CHAT = (agentId?: string): WriteOrigin => ({ source: "chat", actor: { kind: "agent", ...(agentId ? { agentId } : {}) } });

const loadTools = async () => {
  const mod: Record<string, unknown> = await import("./run-tools");
  expect(typeof mod.buildRunTools, "server/run-tools exports buildRunTools").toBe("function");
  return import("./run-tools");
};

/** A running run for feature "Search" (t1; t2 depends on t1) bound to coordinator agent-c. */
async function setup(opts: { coordinatorProfile?: string; extraDeps?: Record<string, unknown> } = {}) {
  t = await makePlanProject();
  const s = t;
  const seed = await s.seedAnswered();
  const { createFeatureCommands } = await import("./features");
  const deps = { directory: () => { throw new Error("unused"); }, now: fixedClock, newId: nextId, storeOptions: { now: fixedClock, newId: nextId } };
  const features = createFeatureCommands(deps);
  const featureId = ok(await features.create(s.open, { projectId: s.P, expectedRevision: await s.revision(), title: "Search", description: "", kind: "feature" }, UI_ORIGIN)).featureId;
  const otherId = ok(await features.create(s.open, { projectId: s.P, expectedRevision: await s.revision(), title: "Other", description: "", kind: "feature" }, UI_ORIGIN)).featureId;
  const tasks = [{ id: "t1", title: "Build", description: "", dod: "x" }, { id: "t2", title: "Ship", description: "", dod: "y", dependsOn: ["t1"] }];
  const d = ok(await s.plans.draft(s.open, { projectId: s.P, expectedRevision: await s.revision(), featureId, title: "Rollout", sessionIds: [seed.sessionId], markdown: "# R", tasks }, UI_ORIGIN));
  await (await s.open(s.P)).transact(await s.revision(), (draft) => {
    const f = draft.features.find((x) => x.id === featureId)!;
    f.grillSessionId = seed.sessionId;
    f.coordinator = { agentId: "agent-c", workspaceId: "ws-1", boundAt: NOW_ISO, profileRef: "team-coordinator" };
    draft.plans.find((p) => p.id === d.planId)!.grillSessionId = seed.sessionId;
  });
  ok(await s.plans.approve(s.open, { projectId: s.P, planId: d.planId, rev: 1, contentHash: d.contentHash }, UI_ORIGIN));
  const { createRunCommands } = await import("./runs");
  const timeline: Array<{ item: { type: string; text: string }; timestamp: string; seqStart: number; seqEnd: number; provider: string; sourceSeqRanges: never[]; collapsed: never[] }> = [];
  // One fake SDK (R3.4 completion): timeline for verifyUserMessage, plus config/workspaces/agents for a
  // delegated staged start. Every SDK call is recorded in order with the run count at send time.
  // Recorded SDK calls, discriminated by op (args exactly as recorded).
  const sdk: Array<{ runsAtCall?: number } & ({ op: "send"; args: { agentId: string; prompt: string } } | { op: "archive"; args: { agentId: string } } | { op: "workspaces.create" | "agents.create"; args?: unknown })> = [];
  const paseo = {
    config: { get: async () => ({ revision: "r1", config: { agentProfiles: [{ id: "team-coordinator", name: "Coordinator", provider: "claude", model: "opus" }] } }) },
    workspaces: {
      create: async (o: unknown) => {
        sdk.push({ op: "workspaces.create", args: o });
        return { id: "ws-new", projectId: s.P, directory: "/synthetic/wt", name: "roadmap", status: null, agents: { create: async (a: unknown) => (sdk.push({ op: "agents.create", args: a }), { id: "agent-new" }) } };
      },
    },
    agents: {
      ref: (agentId: string) => ({
        timeline: { refetch: async () => ({ entries: timeline }) },
        send: async (prompt: string) => {
          // R4 successor c0038: a test may make a replacement steer fail (delivery failure path).
          if (replacementSendFails && /replacement/i.test(prompt)) throw new Error("agent offline");
          const read = await (await s.open(s.P)).read();
          sdk.push({ op: "send", args: { agentId, prompt }, runsAtCall: read.status === "ok" ? read.data.runs.length : -1 });
          return {};
        },
        archive: async () => (sdk.push({ op: "archive", args: { agentId } }), {}),
      }),
    },
  };
  const runs = createRunCommands({
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- partial PaseoApi test stub: only the members this test exercises exist
    ...deps, approvals: s.approvals, identity: async () => null, paseo: () => paseo as never, ...(opts.extraDeps ?? {}),
    settings: async () => roadmapSettings.schema.parse(opts.coordinatorProfile ? { coordinatorProfile: opts.coordinatorProfile } : {}),
  });
  ok(await runs.start(s.open, { projectId: s.P, expectedRevision: await s.revision(), featureId }, UI_ORIGIN));
  const data = async () => {
    const read = await (await s.open(s.P)).read();
    if (read.status !== "ok") throw new Error("store not ok");
    return read.data;
  };
  const run = async (): Promise<ExecutionRun> => (await data()).runs[0];
  const feature = async (id = featureId): Promise<Feature> => (await data()).features.find((f) => f.id === id)!;
  const { buildRunTools } = await loadTools();
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- partial PaseoApi test stub: only the members this test exercises exist
  const tools = buildRunTools(runs, { paseo: () => paseo as never });
  const tool = (name: string) => {
    const found = tools.find((x) => x.name === name);
    expect(found, `${name} is defined`).toBeDefined();
    return found!;
  };
  /**
   * The trusted context the endpoint produces from the caller's bound grant: agentId and workspaceId
   * (never input). `null` means an UNBOUND grant: a JS default would replace an explicit `undefined`
   * with the coordinator, so the unbound cases pass `null` (R3.4 verification repair).
   */
  const call = async (name: string, args: Record<string, unknown>, bound: string | null = "agent-c", workspaceId: string | null | undefined = bound === "agent-c" ? "ws-1" : undefined) => {
    const agentId = bound ?? undefined;
    const tl = tool(name);
    const parsed = tl.input.safeParse(args);
    if (!parsed.success) {
      // Typed like a domain error (details optional) so callers can read `error.details` on either branch.
      const invalid: { ok: false; error: { code: string; message: string; details?: unknown } } = { ok: false, error: { code: "invalid_arguments", message: parsed.error.message } };
      return invalid;
    }
    return tl.run(parsed.data, { open: s.open, projectId: s.P, origin: CHAT(agentId), ...(agentId ? { agentId, ...(workspaceId !== undefined ? { workspaceId } : {}) } : {}) });
  };
  const snapshot = async () => ({ revision: await s.revision(), data: JSON.stringify(await data()) });
  /** "Other" becomes a delegated-start candidate: planned by an approved, current, bound plan; no coordinator, no run. */
  const planOther = async () => {
    const od = ok(await s.plans.draft(s.open, { projectId: s.P, expectedRevision: await s.revision(), featureId: otherId, title: "Other plan", sessionIds: [seed.sessionId], markdown: "# O", tasks: [{ id: "o1", title: "Do", description: "", dod: "x" }] }, UI_ORIGIN));
    await (await s.open(s.P)).transact(await s.revision(), (draft) => {
      draft.features.find((x) => x.id === otherId)!.grillSessionId = seed.sessionId;
      draft.plans.find((p) => p.id === od.planId)!.grillSessionId = seed.sessionId;
    });
    ok(await s.plans.approve(s.open, { projectId: s.P, planId: od.planId, rev: 1, contentHash: od.contentHash }, UI_ORIGIN));
    expect((await feature(otherId)).status, "precondition: candidate planned").toBe("planned");
    return od;
  };
  const say = (seq: number, text: string) => timeline.push({ item: { type: "user_message", text }, timestamp: NOW_ISO, seqStart: seq, seqEnd: seq, provider: "claude", sourceSeqRanges: [], collapsed: [] });
  return { ...s, seed, featureId, otherId, d, runs, tools, tool, call, run, feature, data, snapshot, timeline, sdk, planOther, say };
}

describe("R3.4 run tool table", () => {
  it("defines exactly the six run tools; none approves, verifies, accepts, pauses, resumes, reworks, cancels or grants budget", async () => {
    const s = await setup();
    expect(s.tools.map((x) => x.name).sort()).toEqual([...TOOL_NAMES].sort());
    for (const x of s.tools) expect(x.name).not.toMatch(/approve|verify|accept|pause|resume|rework|cancel|budget/);
  });

  it("run-scoped tools require the runToken in their input", async () => {
    const s = await setup();
    const r = await s.run();
    for (const name of ["roadmap_run_next", "roadmap_task_claim", "roadmap_task_progress", "roadmap_run_ack"]) {
      expect(s.tool(name).input.safeParse({ runId: r.id, taskId: "t1", state: "in_progress" }).success, name).toBe(false);
    }
  });
});

describe("R3.4 run tools behaviour", () => {
  it("an unbound grant is refused (invalid_input); a stale token is run_stale", async () => {
    const s = await setup();
    const r = await s.run();
    const unbound = await s.call("roadmap_run_next", { runId: r.id, runToken: r.runToken }, null);
    expect(unbound.ok).toBe(false);
    expect(unbound.ok ? "" : unbound.error.code).toBe("invalid_input");
    const stale = await s.call("roadmap_run_next", { runId: r.id, runToken: "not-the-token" });
    expect(stale.ok ? "" : stale.error.code).toBe("run_stale");
  });

  it("next honours readiness and claim refuses a task that is not ready, or any task while the run is paused", async () => {
    const s = await setup();
    const r = await s.run();
    const next = await s.call("roadmap_run_next", { runId: r.id, runToken: r.runToken });
    expect(next.ok).toBe(true);
    expect(JSON.stringify(next)).toContain("t1");
    // R3 corrective (DeepSeek c0008): exact readiness, t2 waits for the unverified t1.
    const nextValue = RunNext.parse(ok(next));
    expect(nextValue.ready).toEqual(["t1"]);
    expect(nextValue.blocked).toContainEqual(expect.objectContaining({ code: "dependency_not_verified", taskId: "t2" }));
    const notReady = await s.call("roadmap_task_claim", { runId: r.id, runToken: r.runToken, taskId: "t2" });
    expect(notReady.ok ? "" : notReady.error.code).toBe("run_not_ready");
    ok(await s.runs.pause(s.open, { projectId: s.P, expectedRevision: await s.revision(), runId: r.id, runToken: r.runToken }, UI_ORIGIN));
    const paused = await s.call("roadmap_task_claim", { runId: r.id, runToken: r.runToken, taskId: "t1" });
    expect(paused.ok ? "" : paused.error.code).toBe("run_not_ready");
  });

  it("claim records the claiming agent; progress done never verifies the task", async () => {
    const s = await setup();
    const r = await s.run();
    ok(await s.call("roadmap_task_claim", { runId: r.id, runToken: r.runToken, taskId: "t1" }));
    expect((await s.run()).tasks[0]).toMatchObject({ taskId: "t1", agentId: "agent-c" });
    await s.call("roadmap_task_progress", { runId: r.id, runToken: r.runToken, taskId: "t1", state: "done" });
    expect((await s.run()).tasks[0].state).not.toBe("verified");
  });

  it("roadmap_start without a verified user message is delegation_unverified and writes nothing", async () => {
    const s = await setup();
    const before = await s.snapshot();
    const out = await s.call("roadmap_start", { scope: "feature", featureId: s.otherId, quoted: "you may start Other" });
    expect(out.ok ? "" : out.error.code).toBe("delegation_unverified");
    expect(await s.snapshot()).toEqual(before);
    expect((await s.data()).delegations).toEqual([]);
  });

  it("roadmap_feature_bind binds the calling chat, is idempotent, and refuses when another coordinator is bound", async () => {
    const s = await setup();
    ok(await s.call("roadmap_feature_bind", { featureId: s.otherId }, "agent-x"));
    expect((await s.feature(s.otherId)).coordinator?.agentId).toBe("agent-x");
    ok(await s.call("roadmap_feature_bind", { featureId: s.otherId }, "agent-x"));
    expect((await s.feature(s.otherId)).coordinator?.agentId).toBe("agent-x");
    const before = await s.snapshot();
    const other = await s.call("roadmap_feature_bind", { featureId: s.otherId }, "agent-y");
    expect(other.ok).toBe(false);
    expect(await s.snapshot()).toEqual(before);
    const unbound = await s.call("roadmap_feature_bind", { featureId: s.otherId }, null);
    expect(unbound.ok).toBe(false);
  });
});

// R3.4 completion (root): delegated starts through roadmap_start with a real (fake-timeline) user
// message, the coordinatorProfile wiring, ack identity and cross-feature authority.
describe("R3.4 delegated starts, ack and authority", () => {
  const SKIPPED = "delegated start skipped: no coordinator profile configured";

  it("a verified quote records the delegation; without a coordinator profile the candidate gets one skipped note per unchanged cause and no run", async () => {
    const s = await setup();
    await s.planOther();
    s.say(5, "Yes, you may start Other when it is ready.");
    const runsBefore = (await s.data()).runs.length;
    ok(await s.call("roadmap_start", { scope: "feature", featureId: s.otherId, quoted: "you may start Other" }));
    const delegations = (await s.data()).delegations;
    expect(delegations).toHaveLength(1);
    expect(delegations[0]).toMatchObject({ scope: "feature", featureId: s.otherId, provenance: { agentId: "agent-c", seqStart: 5, quoted: "you may start Other" } });
    const notes = () => s.feature(s.otherId).then((f) => f.events.filter((e) => e.kind === "note"));
    expect((await notes()).map((e) => e.reason)).toEqual([SKIPPED]);
    expect((await s.data()).runs.length, "never launched unbound").toBe(runsBefore);
    expect(s.sdk.filter((c) => c.op !== "send"), "no SDK creation").toEqual([]);
    s.say(7, "Again: you may start Other.");
    ok(await s.call("roadmap_start", { scope: "feature", featureId: s.otherId, quoted: "you may start Other" }));
    expect((await notes()).map((e) => e.reason), "no repeat while the same reason is the latest note").toEqual([SKIPPED]);
  });

  it("with roadmap.coordinatorProfile configured, a verified delegation starts the candidate through the staged SDK sequence with startAuth delegation", async () => {
    const s = await setup({ coordinatorProfile: "team-coordinator" });
    await s.planOther();
    s.say(5, "you may start Other");
    // R3.5 (card §6.2a C): the setup's pre-bound start now sends its own run prompt; assert the delta.
    const sdkBefore = s.sdk.length;
    ok(await s.call("roadmap_start", { scope: "feature", featureId: s.otherId, quoted: "you may start Other" }));
    const data = await s.data();
    const delegation = data.delegations[0];
    const run = data.runs.find((r) => r.featureId === s.otherId);
    expect(run, "the candidate run exists").toBeDefined();
    expect(run!.startAuth).toMatchObject({ kind: "delegation", delegationId: delegation.id });
    const delta = s.sdk.slice(sdkBefore);
    expect(delta.map((c) => c.op)).toEqual(["workspaces.create", "agents.create", "send"]);
    expect(delta[2].runsAtCall, "the prompt is sent only after the run is committed").toBe(data.runs.length);
    expect((await s.feature(s.otherId)).coordinator?.agentId).toBe("agent-new");
    expect((await s.feature(s.otherId)).events.some((e) => e.kind === "note" && e.reason === SKIPPED)).toBe(false);
  });

  it("roadmap_run_ack: a stale token is run_stale; the claiming agent's ack is appended once; another agent cannot ack for the task", async () => {
    const s = await setup();
    const r = await s.run();
    ok(await s.call("roadmap_task_claim", { runId: r.id, runToken: r.runToken, taskId: "t1" }));
    const stale = await s.call("roadmap_run_ack", { runId: r.id, runToken: "not-the-token", taskId: "t1" });
    expect(stale.ok ? "" : stale.error.code).toBe("run_stale");
    ok(await s.call("roadmap_run_ack", { runId: r.id, runToken: r.runToken, taskId: "t1" }));
    ok(await s.call("roadmap_run_ack", { runId: r.id, runToken: r.runToken, taskId: "t1" }));
    const acks = (await s.run()).acks;
    expect(acks.filter((a) => a.taskId === "t1" && a.agentId === "agent-c")).toHaveLength(1);
    const before = await s.snapshot();
    const forged = await s.call("roadmap_run_ack", { runId: r.id, runToken: r.runToken, taskId: "t1" }, "agent-z");
    expect(forged.ok).toBe(false);
    expect(await s.snapshot()).toEqual(before);
  });

  it("a coordinator bound to another feature cannot drive this run (contract question: card says 'bound grant required', not 'this feature's coordinator')", async () => {
    const s = await setup();
    const r = await s.run();
    const before = await s.snapshot();
    for (const [name, args] of [
      ["roadmap_run_next", { runId: r.id, runToken: r.runToken }],
      ["roadmap_task_claim", { runId: r.id, runToken: r.runToken, taskId: "t1" }],
    ] as const) {
      const out = await s.call(name, args, "agent-of-another-feature");
      expect(out.ok, name).toBe(false);
    }
    expect(await s.snapshot()).toEqual(before);
  });
});

// R3.4 authority matrix (card §5.2 "Run tool authority matrix", settled). Coordinator: ctx.agentId is the
// feature coordinator (agent-c, workspace ws-1). Crew: a bound grant whose non-null ctx.workspaceId equals
// the coordinator's (ws-1). Foreign: any other bound agent. Order: unbound, then runToken, then role,
// then readiness. Refusal reasons are details under invalid_input (no new error codes asserted).
describe("R3.4 run tool authority matrix", () => {
  const code = (out: { ok: boolean; error?: { code: string } }) => (out.ok ? "ok" : out.error!.code);

  it("next is coordinator-only: crew and foreign are invalid_input (not_coordinator)", async () => {
    const s = await setup();
    const r = await s.run();
    ok(await s.call("roadmap_run_next", { runId: r.id, runToken: r.runToken }));
    for (const [agentId, ws] of [["agent-w", "ws-1"], ["agent-f", "ws-9"]] as const) {
      const out = await s.call("roadmap_run_next", { runId: r.id, runToken: r.runToken }, agentId, ws);
      expect(code(out), agentId).toBe("invalid_input");
      expect(JSON.stringify(out), agentId).toContain("not_coordinator");
    }
  });

  it("a crew member (same non-null workspace) self-claims; it cannot name another agentId; a null-workspace grant is not crew", async () => {
    const s = await setup();
    const r = await s.run();
    const before = await s.snapshot();
    expect(code(await s.call("roadmap_task_claim", { runId: r.id, runToken: r.runToken, taskId: "t1", agentId: "agent-v" }, "agent-w", "ws-1")), "crew naming another").toBe("invalid_input");
    expect(code(await s.call("roadmap_task_claim", { runId: r.id, runToken: r.runToken, taskId: "t1" }, "agent-n", null)), "null workspace is not crew").not.toBe("ok");
    expect(await s.snapshot()).toEqual(before);
    ok(await s.call("roadmap_task_claim", { runId: r.id, runToken: r.runToken, taskId: "t1" }, "agent-w", "ws-1"));
    expect((await s.run()).tasks[0]).toMatchObject({ taskId: "t1", agentId: "agent-w" });
    const again = await s.call("roadmap_task_claim", { runId: r.id, runToken: r.runToken, taskId: "t1" });
    expect(code(again), "already claimed").toBe("run_not_ready");
    expect(JSON.stringify(again)).toContain("task_claimed");
  });

  it("coordinator dispatch sets TaskRun.agentId; only the assigned worker (or the coordinator) reports progress; ack is self-only and idempotent", async () => {
    const s = await setup();
    const r = await s.run();
    ok(await s.call("roadmap_task_claim", { runId: r.id, runToken: r.runToken, taskId: "t1", agentId: "agent-w" }));
    expect((await s.run()).tasks[0]).toMatchObject({ taskId: "t1", agentId: "agent-w" });
    const progress = (agentId: string, ws: string | null) => s.call("roadmap_task_progress", { runId: r.id, runToken: r.runToken, taskId: "t1", state: "in_progress" }, agentId, ws);
    const other = await progress("agent-z", "ws-1");
    expect(code(other)).toBe("invalid_input");
    expect(JSON.stringify(other)).toContain("not_task_agent");
    ok(await progress("agent-w", "ws-1"));
    const ack = (agentId: string, ws: string | null) => s.call("roadmap_run_ack", { runId: r.id, runToken: r.runToken, taskId: "t1" }, agentId, ws);
    const coordAck = await ack("agent-c", "ws-1");
    expect(code(coordAck), "the coordinator never acks on a worker's behalf").toBe("invalid_input");
    expect(JSON.stringify(coordAck)).toContain("not_task_agent");
    ok(await ack("agent-w", "ws-1"));
    ok(await ack("agent-w", "ws-1"));
    expect((await s.run()).acks.filter((a) => a.taskId === "t1")).toEqual([expect.objectContaining({ taskId: "t1", agentId: "agent-w" })]);
  });

  it("a stale token is run_stale before the role check, also for a foreign agent", async () => {
    const s = await setup();
    const r = await s.run();
    for (const [name, args] of [
      ["roadmap_run_next", { runId: r.id, runToken: "not-the-token" }],
      ["roadmap_task_claim", { runId: r.id, runToken: "not-the-token", taskId: "t1" }],
    ] as const) {
      expect(code(await s.call(name, args, "agent-f", "ws-9")), name).toBe("run_stale");
    }
    expect(code(await s.call("roadmap_run_next", { runId: r.id, runToken: "not-the-token" }, null)), "unbound is checked first").toBe("invalid_input");
  });
});

// Stage R3.5 (card §6.2 D): roadmap_task_progress done opens a server-owned cycle and starts the
// runners through RunDeps.runners (the orchestrator); the agent never self-verifies.
describe("R3.5 progress done starts the runners", () => {
  it("progress done opens a cycle (checks_pending) and calls runners.start once with that cycle and binding", async () => {
    const identity = { headCommit: "a".repeat(40), indexTreeHash: "b".repeat(64), worktreeTreeHash: "c".repeat(64), untrackedHash: "d".repeat(64) };
    const starts: Array<{ taskId: string; cycleId: string; binding: { worktree: unknown } }> = [];
    const s = await setup({ extraDeps: { identity: async () => identity, runners: { start: (x: never) => void starts.push(x), cancel: () => undefined, dispose: async () => undefined } } });
    const r = await s.run();
    ok(await s.call("roadmap_task_claim", { runId: r.id, runToken: r.runToken, taskId: "t1" }));
    ok(await s.call("roadmap_task_progress", { runId: r.id, runToken: r.runToken, taskId: "t1", state: "in_progress" }));
    ok(await s.call("roadmap_task_progress", { runId: r.id, runToken: r.runToken, taskId: "t1", state: "done" }));
    expect((await s.run()).tasks[0].state).toBe("checks_pending");
    expect(starts).toHaveLength(1);
    const started = (await s.run()).events.filter((e) => e.kind === "cycle_started").at(-1)!.detail;
    expect(starts[0]).toMatchObject({ taskId: "t1", cycleId: started, binding: { worktree: identity } });
    expect((await s.run()).tasks[0].state).not.toBe("verified");
  });
});

// R3 corrective (card §6.3 control "basis cancellation blocks dispatch", DeepSeek c0024): once the
// approved basis is cancelled, roadmap_run_next lists approval_not_current and roadmap_task_claim is
// run_not_ready with no write.
describe("R3 corrective: basis cancellation blocks dispatch (c0024)", () => {
  it("after decisionCancel, next reports approval_not_current and claim is refused with no write", async () => {
    const s = await setup();
    const r = await s.run();
    const cancelled = await s.project.service.decisionCancel(s.project.paseo, { projectId: s.P, expectedRevision: await s.revision(), ...s.seed.q1, reason: "Dropped" });
    if (!cancelled.ok) throw new Error(`cancel failed: ${cancelled.error.code}`);
    const next = RunNext.parse(ok(await s.call("roadmap_run_next", { runId: r.id, runToken: r.runToken })));
    expect(next.ready).toEqual([]);
    expect(next.blocked.map((b) => b.code)).toContain("approval_not_current");
    const before = await s.snapshot();
    const claim = await s.call("roadmap_task_claim", { runId: r.id, runToken: r.runToken, taskId: "t1" });
    expect(claim.ok ? "" : claim.error.code).toBe("run_not_ready");
    expect(JSON.stringify(claim.ok ? {} : claim.error.details)).toContain("approval_not_current");
    expect(await s.snapshot()).toEqual(before);
  });
});

// R3 corrective (DeepSeek c0013, root ruling): featureId is required iff scope is "feature".
// roadmap_start with scope "roadmap" and a featureId is refused before the provenance check and
// records nothing; the lower command refuses the same input.
describe("R3 corrective: roadmap_start scope and featureId agree (c0013)", () => {
  it("roadmap scope with a featureId is refused at the tool and at the command, with no delegation and no start", async () => {
    const s = await setup({ coordinatorProfile: "team-coordinator" });
    await s.planOther();
    s.say(5, "you may start everything");
    const before = await s.snapshot();
    const sdkBefore = s.sdk.length;
    const out = await s.call("roadmap_start", { scope: "roadmap", featureId: s.otherId, quoted: "you may start everything" });
    expect(out.ok).toBe(false);
    expect(["invalid_arguments", "invalid_input"]).toContain(out.ok ? "" : out.error.code);
    const direct = await s.runs.startDelegated(s.open, { projectId: s.P, scope: "roadmap", featureId: s.otherId, quoted: "you may start everything" }, { agentId: "agent-c", workspaceId: "ws-1" }, null);
    expect(direct.ok ? "" : direct.error.code, "the command refuses before provenance (no paseo given)").toBe("invalid_input");
    expect(await s.snapshot()).toEqual(before);
    expect(s.sdk.slice(sdkBefore)).toEqual([]);
    expect((await s.data()).delegations).toEqual([]);
  });

  it("control: feature scope without featureId stays invalid_input; feature scope with featureId is accepted", async () => {
    const s = await setup();
    s.say(5, "you may start Other");
    const missing = await s.runs.startDelegated(s.open, { projectId: s.P, scope: "feature", quoted: "you may start Other" }, { agentId: "agent-c", workspaceId: "ws-1" }, null);
    expect(missing.ok ? "" : missing.error.code).toBe("invalid_input");
    expect(s.tool("roadmap_start").input.safeParse({ scope: "feature", featureId: s.otherId, quoted: "q" }).success).toBe(true);
    expect(s.tool("roadmap_start").input.safeParse({ scope: "roadmap", quoted: "q" }).success).toBe(true);
  });
});

// Stage R4.3 (task card §4): roadmap_feature_bind turns a QUEUED replacement request into
// `requested` (history note naming the bind; becauseOf kept) and, after commit, sends exactly one
// replacement steer to the bound chat; a repeated bind or an already requested feature sends none.
describe("R4.3 queued → requested on roadmap_feature_bind", () => {
  const queue = async (s: Awaited<ReturnType<typeof setup>>, featureId: string, state: "queued" | "requested") =>
    (await s.open(s.P)).transact(await s.revision(), (draft) => {
      // MODELLED STATE (labelled): the request a cancelled prerequisite left on an unbound feature.
      const feature = draft.features.find((f) => f.id === featureId);
      if (!feature) throw new Error("modelled feature missing");
      feature.replacementRequested = { at: NOW_ISO, becauseOf: "f-root", state };
    });
  const replacementSends = (s: Awaited<ReturnType<typeof setup>>) =>
    s.sdk.filter((c) => c.op === "send" && /replacement/i.test(c.args.prompt));

  it("a queued request becomes requested on bind, with a bind note, and one steer to the bound chat after commit", async () => {
    const s = await setup();
    await queue(s, s.otherId, "queued");
    ok(await s.call("roadmap_feature_bind", { featureId: s.otherId }, "agent-x"));
    const f = await s.feature(s.otherId);
    expect((f as Record<string, any>).replacementRequested).toMatchObject({ state: "requested", becauseOf: "f-root" });
    expect(f.events.some((e) => e.kind === "note" && /bind|bound/i.test(JSON.stringify(e)) && /replacement/i.test(JSON.stringify(e)))).toBe(true);
    const sends = replacementSends(s);
    expect(sends).toHaveLength(1);
    const first = sends[0];
    expect(first.op === "send" ? first.args.agentId : first).toBe("agent-x");
    ok(await s.call("roadmap_feature_bind", { featureId: s.otherId }, "agent-x"));
    expect(replacementSends(s), "an idempotent re-bind sends nothing more").toHaveLength(1);
  });

  // R4 successor KensAI c0038: a replacement steer that fails after an agent bound the chat records the
  // delivery-failure note with the agent that raised the request, not a human.
  it("a failed replacement steer after an agent's bind records the 'not delivered' note with that agent as actor", async () => {
    const s = await setup();
    await queue(s, s.otherId, "queued");
    replacementSendFails = true;
    try {
      ok(await s.call("roadmap_feature_bind", { featureId: s.otherId }, "agent-x"));
    } finally {
      replacementSendFails = false;
    }
    const f = await s.feature(s.otherId);
    const failed = f.events.filter((e) => e.kind === "note" && /replacement request not delivered/.test(String((e as { reason?: string }).reason)));
    expect(failed, "one delivery-failure note").toHaveLength(1);
    expect(failed[0].actor).toEqual({ kind: "agent", agentId: "agent-x" });
  });

  it("an already requested feature gets no steer on bind", async () => {
    const s = await setup();
    await queue(s, s.otherId, "requested");
    ok(await s.call("roadmap_feature_bind", { featureId: s.otherId }, "agent-x"));
    expect(replacementSends(s)).toEqual([]);
  });
});

// ======================= Stage R4.4 (task card §5.0, §5.3) =======================
// Placement note (reported): the revoke and traversal integrations live here because this file's
// setup already provides the verified-quote timeline, the coordinatorProfile and the fake SDK that
// records workspaces.create / agents.create / send, as card §5.3 requires for the runs tests.

/** Extra approved, planned, unbound features on top of `setup` (real temp store, real ApprovalStore). */
async function r44(opts: { profile?: boolean } = {}) {
  const s = await setup(opts.profile === false ? {} : { coordinatorProfile: "team-coordinator" });
  const { createFeatureCommands } = await import("./features");
  const base = { directory: () => { throw new Error("unused"); }, now: fixedClock, newId: nextId, storeOptions: { now: fixedClock, newId: nextId } };
  const featureCmds = createFeatureCommands(base);
  const { createPlanCommands } = await import("./plans");
  // PlanDeps.afterApprove composed as index.server.ts does (fire-and-forget), with the sweep captured.
  let swept: Promise<unknown> = Promise.resolve();
  const plans = createPlanCommands({ ...base, approvals: s.approvals, afterApprove: (projectId: string) => void (swept = s.runs.sweep(s.open, { projectId })) } as Parameters<typeof createPlanCommands>[0]);
  const create = async (title: string, dependsOn: string[] = []) =>
    ok(await featureCmds.create(s.open, { projectId: s.P, expectedRevision: await s.revision(), title, description: "", kind: "feature", ...(dependsOn.length ? { dependsOn } : {}) }, UI_ORIGIN)).featureId;
  type TaskIn = { id: string; title: string; description: string; dod: string; parallel?: boolean };
  const draftFor = async (featureId: string, title: string, tasks: TaskIn[] = [{ id: "x1", title: "One", description: "", dod: "x" }, { id: "x2", title: "Two", description: "", dod: "y" }]) => {
    const d = ok(await plans.draft(s.open, { projectId: s.P, expectedRevision: await s.revision(), featureId, title, sessionIds: [s.seed.sessionId], markdown: `# ${title}`, tasks }, UI_ORIGIN));
    await (await s.open(s.P)).transact(await s.revision(), (draft) => {
      draft.features.find((x) => x.id === featureId)!.grillSessionId = s.seed.sessionId;
      draft.plans.find((p) => p.id === d.planId)!.grillSessionId = s.seed.sessionId;
    });
    return d;
  };
  /** A plan on its OWN grilling basis session (so its approval can be made non-current alone). */
  const draftOn = async (featureId: string, title: string, sessionId: string) => {
    const d = ok(await plans.draft(s.open, { projectId: s.P, expectedRevision: await s.revision(), featureId, title, sessionIds: [sessionId], markdown: `# ${title}`, tasks: [{ id: "x1", title: "One", description: "", dod: "x" }] }, UI_ORIGIN));
    await (await s.open(s.P)).transact(await s.revision(), (draft) => {
      draft.features.find((x) => x.id === featureId)!.grillSessionId = sessionId;
      draft.plans.find((p) => p.id === d.planId)!.grillSessionId = sessionId;
    });
    return d;
  };
  const approve = async (d: { planId: string; contentHash: string }) => {
    ok(await plans.approve(s.open, { projectId: s.P, planId: d.planId, rev: 1, contentHash: d.contentHash }, UI_ORIGIN));
    await swept;
  };
  const ready = async (title: string, dependsOn: string[] = [], tasks?: TaskIn[], sessionId?: string) => {
    const id = await create(title, dependsOn);
    const d = sessionId ? await draftOn(id, `${title} plan`, sessionId) : await draftFor(id, `${title} plan`, tasks);
    await approve(d);
    return { id, d };
  };
  const delegate = async (scope: "feature" | "roadmap", featureId?: string, seq = 50) => {
    const quoted = `you may start ${scope} ${seq}`;
    s.say(seq, quoted);
    return Started.parse(ok(await s.call("roadmap_start", { scope, ...(featureId ? { featureId } : {}), quoted })));
  };
  const runOf = async (featureId: string) => (await s.data()).runs.find((r) => r.featureId === featureId && r.state !== "ended");
  const newestDelegation = async () => (await s.data()).delegations.at(-1)!;
  const revoke = async (delegationId: string) => ok(await s.runs.revokeDelegation(s.open, { projectId: s.P, expectedRevision: await s.revision(), delegationId }, UI_ORIGIN));
  const reorder = async (order: string[]) => ok(await featureCmds.reorder(s.open, { projectId: s.P, expectedRevision: await s.revision(), order }, UI_ORIGIN));
  const notesOf = async (featureId: string) => (await s.feature(featureId)).events.filter((e) => e.kind === "note");
  return { ...s, plans, featureCmds, create, draftFor, approve, ready, delegate, runOf, newestDelegation, revoke, reorder, notesOf, swept: () => swept };
}
const code = (r: { ok: boolean; error?: { code: string } }) => (r.ok ? "ok" : r.error!.code);
const blockedCodes = (v: unknown) => JSON.stringify(v);

describe("R4.4 revoke stops new dispatch; a new covering delegation restores it (§5.0)", () => {
  for (const scope of ["feature", "roadmap"] as const) {
    it(`${scope} scope: after revoke the run is byte-identical, in-flight progress is accepted, claim and resume are start_unauthorised; a different-id covering delegation restores them without rewriting startAuth`, async () => {
      const w = await r44();
      // x2 is granted parallel, so after restoration it is claimable while x1 is still in progress
      // (verification repair: without the grant the restored claim is legitimately parallel_not_granted).
      const f = await w.ready("Third", [], [{ id: "x1", title: "One", description: "", dod: "x" }, { id: "x2", title: "Two", description: "", dod: "y", parallel: true }]);
      await w.delegate(scope, scope === "feature" ? f.id : undefined);
      const run0 = (await w.runOf(f.id))!;
      expect(run0, "the delegated start ran").toBeDefined();
      const original = run0.startAuth;
      expect(original).toMatchObject({ kind: "delegation" });
      const coordinator = (await w.feature(f.id)).coordinator!;
      const as = [coordinator.agentId, coordinator.workspaceId] as const;
      ok(await w.call("roadmap_task_claim", { runId: run0.id, runToken: run0.runToken, taskId: "x1" }, ...as));
      const before = JSON.stringify(await w.runOf(f.id));
      await w.revoke((await w.newestDelegation()).id);
      expect(JSON.stringify(await w.runOf(f.id)), "revoke does not touch the run").toBe(before);
      ok(await w.call("roadmap_task_progress", { runId: run0.id, runToken: run0.runToken, taskId: "x1", state: "in_progress" }, ...as));
      const snap = await w.snapshot();
      const claim = await w.call("roadmap_task_claim", { runId: run0.id, runToken: run0.runToken, taskId: "x2" }, ...as);
      expect(code(claim)).toBe("run_not_ready");
      expect(blockedCodes(claim.ok ? {} : claim.error.details)).toContain("start_unauthorised");
      expect(await w.snapshot(), "a refused claim writes nothing").toEqual(snap);
      expect(blockedCodes(ok(await w.runs.get(w.open, { projectId: w.P, runId: run0.id })))).toContain("start_unauthorised");
      ok(await w.runs.pause(w.open, { projectId: w.P, expectedRevision: await w.revision(), runId: run0.id, runToken: run0.runToken }, UI_ORIGIN));
      const sendsBefore = w.sdk.filter((c) => c.op === "send").length;
      const resume = await w.runs.resume(w.open, { projectId: w.P, expectedRevision: await w.revision(), runId: run0.id, runToken: run0.runToken }, UI_ORIGIN);
      expect(code(resume)).toBe("run_not_ready");
      expect(blockedCodes(resume.ok ? {} : resume.error.details)).toContain("start_unauthorised");
      expect(w.sdk.filter((c) => c.op === "send").length, "nothing sent").toBe(sendsBefore);
      // A new verified covering delegation with a different id restores dispatch.
      await w.delegate(scope, scope === "feature" ? f.id : undefined, 60);
      expect((await w.newestDelegation()).id).not.toBe(original.delegationId);
      const sendsAtRenewal = w.sdk.filter((c) => c.op === "send").length;
      ok(await w.runs.resume(w.open, { projectId: w.P, expectedRevision: await w.revision(), runId: run0.id, runToken: run0.runToken }, UI_ORIGIN));
      expect(w.sdk.filter((c) => c.op === "send").length, "no steer on resume: the run prompt was delivered (nothing unresolved)").toBe(sendsAtRenewal);
      ok(await w.call("roadmap_task_claim", { runId: run0.id, runToken: run0.runToken, taskId: "x2" }, ...as));
      expect(blockedCodes(ok(await w.runs.get(w.open, { projectId: w.P, runId: run0.id })))).not.toContain("start_unauthorised");
      expect((await w.runOf(f.id))!.startAuth, "startAuth is never rewritten").toEqual(original);
    });
  }

  it("UI-started control: claims and readiness are identical before and after any revoke", async () => {
    const w = await r44();
    const f = await w.ready("Third");
    await w.delegate("roadmap");
    const ui = (await w.run()); // the setup's UI-started Search run
    expect(ui.startAuth.kind).toBe("ui");
    // Readiness only (the view's store `revision` legitimately moves with the revoke write).
    const readiness = async () => {
      const v = ok(await w.runs.get(w.open, { projectId: w.P, runId: ui.id })) as { ready: unknown; blocked: unknown };
      return JSON.stringify({ ready: v.ready, blocked: v.blocked });
    };
    const viewBefore = await readiness();
    await w.revoke((await w.newestDelegation()).id);
    expect(await readiness()).toBe(viewBefore);
    ok(await w.call("roadmap_task_claim", { runId: ui.id, runToken: ui.runToken, taskId: "t1" }));
    expect(f.id).toBeDefined();
  });

  it("after revoke no new start happens, also via an approval → sweep", async () => {
    const w = await r44();
    await w.ready("Third");
    await w.delegate("roadmap");
    await w.revoke((await w.newestDelegation()).id);
    const later = await w.create("Later");
    const d = await w.draftFor(later, "Later plan");
    await w.approve(d);
    expect(await w.runOf(later), "a revoked roadmap delegation starts nothing").toBeUndefined();
  });

  it("a prerequisite-paused delegated run is not resumed by the sweep after revoke", async () => {
    const w = await r44();
    const pre = await w.create("Pre");
    const dep = await w.ready("Dependent", [pre]);
    await w.delegate("feature", dep.id);
    const r = (await w.runOf(dep.id))!;
    expect(r).toMatchObject({ state: "paused", pauseReason: "prerequisite_not_done" });
    await w.revoke((await w.newestDelegation()).id);
    await (await w.open(w.P)).transact(await w.revision(), (draft) => {
      draft.features.find((x) => x.id === pre)!.status = "done"; // MODELLED STATE (labelled)
    });
    await w.runs.sweep(w.open, { projectId: w.P });
    expect(await w.runOf(dep.id)).toMatchObject({ state: "paused", pauseReason: "prerequisite_not_done" });
  });

  // R4 successor KensAI c0050: the restore direction at the sweep. After the starting delegation is revoked,
  // a NEW covering delegation (different id) restores the authority, so the sweep resumes the run once the
  // prerequisite is done (the sweep must use the covering delegation, not the one that started the run).
  it("a new covering delegation restores the sweep: the prerequisite-paused run resumes once the prerequisite is done", async () => {
    const w = await r44();
    const pre = await w.create("Pre");
    const dep = await w.ready("Dependent", [pre]);
    await w.delegate("feature", dep.id);
    const r = (await w.runOf(dep.id))!;
    expect(r).toMatchObject({ state: "paused", pauseReason: "prerequisite_not_done" });
    const original = await w.newestDelegation();
    await w.revoke(original.id);
    await w.delegate("feature", dep.id, 60);
    const renewed = await w.newestDelegation();
    expect(renewed.id, "precondition: a different, unrevoked covering delegation").not.toBe(original.id);
    expect(renewed.revokedAt).toBeUndefined();
    expect((await w.runOf(dep.id))!.id, "precondition: no second run").toBe(r.id);
    await (await w.open(w.P)).transact(await w.revision(), (draft) => {
      draft.features.find((x) => x.id === pre)!.status = "done"; // MODELLED STATE (labelled)
    });
    await w.runs.sweep(w.open, { projectId: w.P });
    expect((await w.runOf(dep.id))!.state).toBe("running");
  });
});

describe("R4.4 traversal through the actual approval → sweep composition (§5.1, §5.3)", () => {
  it("two ready features reordered F2 before F1: one roadmap delegation starts [F2, F1], each with that delegation id, one create and one post-commit send each", async () => {
    const w = await r44();
    const f1 = await w.ready("F1");
    const f2 = await w.ready("F2");
    const order = (await w.data()).features.map((x) => x.id).filter((id) => id !== f1.id && id !== f2.id);
    await w.reorder([f2.id, f1.id, ...order]);
    const opsBefore = w.sdk.length;
    const out = await w.delegate("roadmap");
    const del = await w.newestDelegation();
    expect((out.started ?? []).filter((id) => id === f1.id || id === f2.id)).toEqual([f2.id, f1.id]);
    for (const id of [f1.id, f2.id]) expect((await w.runOf(id))!.startAuth).toMatchObject({ kind: "delegation", delegationId: del.id });
    const ops = w.sdk.slice(opsBefore);
    expect(ops.filter((c) => c.op === "workspaces.create")).toHaveLength(2);
    expect(ops.filter((c) => c.op === "send")).toHaveLength(2);
    const sendIdx = ops.map((c, i) => (c.op === "send" ? i : -1)).filter((i) => i >= 0);
    const createIdx = ops.map((c, i) => (c.op === "agents.create" ? i : -1)).filter((i) => i >= 0);
    expect(createIdx[0] < sendIdx[0] && sendIdx[0] < createIdx[1] && createIdx[1] < sendIdx[1], JSON.stringify(ops.map((c) => c.op))).toBe(true);
    for (const send of ops.filter((c) => c.op === "send")) expect(send.runsAtCall, "each send after its run committed").toBeGreaterThan(0);
  });

  it("F3 only drafted at delegation time is not started; approving F3 starts it in the triggered sweep under the same delegation", async () => {
    const w = await r44();
    const f3 = await w.create("F3");
    const d3 = await w.draftFor(f3, "F3 plan");
    await w.delegate("roadmap");
    expect(await w.runOf(f3)).toBeUndefined();
    const del = await w.newestDelegation();
    await w.approve(d3);
    expect((await w.runOf(f3))?.startAuth).toMatchObject({ kind: "delegation", delegationId: del.id });
  });

  it("exclusions: deferred, cancelled, a copied approval without its receipt file, and a feature with a live run never start; each gets at most one note", async () => {
    const w = await r44();
    const deferred = await w.ready("Deferred");
    const cancelled = await w.ready("Cancelled");
    const copied = await w.ready("Copied");
    await (await w.open(w.P)).transact(await w.revision(), (draft) => {
      // MODELLED STATE (labelled)
      const d = draft.features.find((x) => x.id === deferred.id)! as Feature & { statusBeforeDefer?: string };
      d.statusBeforeDefer = "planned";
      d.status = "deferred";
      draft.features.find((x) => x.id === cancelled.id)!.status = "cancelled";
    });
    const { rm } = await import("node:fs/promises");
    await rm(w.env.receiptPath({ projectId: w.P, planId: copied.d.planId, planRev: 1 })); // the approval copy stays
    const uiRunsBefore = (await w.data()).runs.filter((r) => r.featureId === w.featureId).length;
    await w.delegate("roadmap");
    for (const f of [deferred, cancelled, copied]) {
      expect(await w.runOf(f.id), f.id).toBeUndefined();
      expect((await w.notesOf(f.id)).length, `${f.id} at most one note`).toBeLessThanOrEqual(1);
    }
    expect((await w.data()).runs.filter((r) => r.featureId === w.featureId).length, "the live UI run is not started again").toBe(uiRunsBefore);
  });

  it("no binding and no coordinatorProfile: no run and exactly one note per unchanged cause", async () => {
    const w = await r44({ profile: false });
    const f = await w.ready("Lonely");
    await w.delegate("roadmap");
    await w.delegate("roadmap", undefined, 70);
    expect(await w.runOf(f.id)).toBeUndefined();
    expect((await w.notesOf(f.id)).length).toBe(1);
  });

  it("F5 depending on an unfinished F1 starts paused (prerequisite_not_done) and is resumed by the sweep once F1 is done", async () => {
    const w = await r44();
    const f1 = await w.create("F1 unfinished");
    const f5 = await w.ready("F5", [f1]);
    await w.delegate("roadmap");
    expect(await w.runOf(f5.id)).toMatchObject({ state: "paused", pauseReason: "prerequisite_not_done" });
    await (await w.open(w.P)).transact(await w.revision(), (draft) => {
      draft.features.find((x) => x.id === f1)!.status = "done"; // MODELLED STATE (labelled)
    });
    await w.runs.sweep(w.open, { projectId: w.P });
    expect((await w.runOf(f5.id))!.state).toBe("running");
  });
});

describe("R4.4 roadmap_start description (§5.2)", () => {
  it("names roadmap order, later-approved starts at the next sweep, revoke stopping new starts and dispatch, a new delegation restoring them, and that unapproved features never start", async () => {
    const s = await setup();
    const d = s.tool("roadmap_start").description;
    expect(d).toMatch(/roadmap order/i);
    expect(d).toMatch(/later[- ]approved|approved later/i);
    expect(d).toMatch(/revok/i);
    expect(d).toMatch(/dispatch|claim/i);
    expect(d).toMatch(/new delegation/i);
    expect(d).toMatch(/unapproved|not approved|non-current/i);
  });
});

// ---- R4.4 independent verification (T) ----
describe("R4.4 verification: non-current candidate, feature-scope revoke and approval", () => {
  it("a candidate whose approved basis was later cancelled (its OWN basis session) is excluded by the delegated start and gets at most one note; the others still start", async () => {
    const w = await r44();
    const basis = await w.seedAnswered();
    const stale = await w.ready("Stale", [], undefined, basis.sessionId);
    const fresh = await w.ready("Fresh");
    const out = await w.project.service.decisionCancel(w.project.paseo, { projectId: w.P, expectedRevision: await w.revision(), ...basis.q1, reason: "Dropped" });
    if (!out.ok) throw new Error(`cancel failed: ${out.error.code}`);
    await w.delegate("roadmap");
    expect(await w.runOf(stale.id), "non-current: never started").toBeUndefined();
    expect((await w.notesOf(stale.id)).length).toBeLessThanOrEqual(1);
    expect(await w.runOf(fresh.id), "control: a current candidate starts").toBeDefined();
  });

  it("a revoked FEATURE-scope delegation starts nothing when that feature is approved later (approval → sweep)", async () => {
    const w = await r44();
    const later = await w.create("Later");
    const d = await w.draftFor(later, "Later plan");
    await w.delegate("feature", later);
    expect(await w.runOf(later)).toBeUndefined();
    await w.revoke((await w.newestDelegation()).id);
    await w.approve(d);
    expect(await w.runOf(later)).toBeUndefined();
  });
});
