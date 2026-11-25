// Stage R3.4 (task card 2026-10-29 R3 §5.2, §5.3): staged coordinator start. With a profileRef and no
// bound coordinator, run.start maps the saved agent profile, creates a branch-off worktree workspace and
// an agent in it with NO prompt, commits the binding + run + planned → executing in one revalidating
// transaction, and only then sends the run prompt. A fake Paseo SDK records every call in order; the
// store is a real temp store. No real agent, workspace, process, git or network.
// Interface choice (reported): createRunCommands deps gain `paseo?: () => PaseoApi | null` (the holder's
// PaseoApi); the card fixes the SDK calls, not how runs.ts obtains the PaseoApi.
import { afterEach, describe, expect, it } from "vitest";
import type { PaseoAgentSendOptions } from "@getpaseo/client";
import type { ExecutionRun, Feature } from "../shared/model";
import { roadmapSettings } from "../shared/settings";
import { UI_ORIGIN, type WriteOrigin } from "./sessions";
import { fixedClock, isJsonObject, nextId, readJsonObject } from "./test-support/build";
import { makePlanProject, type PlanProject } from "./test-support/plans";

let t: PlanProject | undefined;
afterEach(async () => {
  await t?.cleanup();
  t = undefined;
});
type R<T> = { ok: true; value: T } | { ok: false; error: { code: string; message: string; details?: unknown } };
const ok = <T>(r: R<T>): T => {
  if (!r.ok) throw new Error(`expected ok, got ${r.error.code}: ${r.error.message}`);
  return r.value;
};
const err = <T>(r: R<T>) => {
  if (r.ok) throw new Error(`expected an error, got ${JSON.stringify(r.value)}`);
  return r.error;
};

const PROFILES = [
  { id: "team-coordinator", name: "Coordinator", provider: "claude", model: "opus", modeId: "plan", thinkingOptionId: "high", featureValues: { web: true } },
  { id: "plain", name: "Plain", provider: "codex" },
];

// Recorded SDK calls, discriminated by op (args exactly as recorded; send options are the SDK's own type).
type SendArgs = { agentId: string; prompt: string; options?: PaseoAgentSendOptions };
type Call = { runsAtCall?: number; boundAtCall?: string | undefined } & (
  | { op: "send"; args: SendArgs }
  | { op: "archive"; args: { agentId: string } }
  | { op: "workspace.ref.agents.create"; args: { workspaceId: string } }
  | { op: "workspaces.create" | "agents.create"; args: unknown }
  // Never recorded (config.get is a read, not a call); named so absence checks typecheck.
  | { op: "config.get"; args: unknown }
);
/** The args of a recorded send; any other call fails here (its prompt/agentId assertions could not hold). */
const sendOf = (c: Call | undefined): SendArgs => {
  if (c?.op !== "send") throw new Error(`expected a send call, got ${c?.op}`);
  return c.args;
};
/** Recorded args that must be an options object (agent creation). */
const objectArgs = (c: Call | undefined): Record<string, unknown> => {
  const args = c?.args;
  if (!isJsonObject(args)) throw new Error(`expected object args for ${c?.op}`);
  return args;
};

/** A feature planned by an approved, current, bound plan; no coordinator bound. */
async function setup(fake: { createFails?: boolean; agentFails?: boolean; sendFails?: () => boolean; archiveFails?: boolean; duringAgentCreate?: () => Promise<void>; duringSend?: { current?: () => Promise<void> } } = {}) {
  t = await makePlanProject();
  const s = t;
  const seed = await s.seedAnswered();
  const { createFeatureCommands } = await import("./features");
  const deps = { directory: () => { throw new Error("unused"); }, now: fixedClock, newId: nextId, storeOptions: { now: fixedClock, newId: nextId } };
  const features = createFeatureCommands(deps);
  const featureId = ok(await features.create(s.open, { projectId: s.P, expectedRevision: await s.revision(), title: "Search", description: "", kind: "feature" }, UI_ORIGIN)).featureId;
  const d = ok(await s.plans.draft(s.open, { projectId: s.P, expectedRevision: await s.revision(), featureId, title: "Rollout", sessionIds: [seed.sessionId], markdown: "# R", tasks: [{ id: "t1", title: "Build", description: "", dod: "x" }] }, UI_ORIGIN));
  await (await s.open(s.P)).transact(await s.revision(), (draft) => {
    draft.features.find((f) => f.id === featureId)!.grillSessionId = seed.sessionId;
    draft.plans.find((p) => p.id === d.planId)!.grillSessionId = seed.sessionId;
  });
  ok(await s.plans.approve(s.open, { projectId: s.P, planId: d.planId, rev: 1, contentHash: d.contentHash }, UI_ORIGIN));
  const data = async () => {
    const read = await (await s.open(s.P)).read();
    if (read.status !== "ok") throw new Error("store not ok");
    return read.data;
  };
  const feature = async (): Promise<Feature> => (await data()).features.find((f) => f.id === featureId)!;
  const runsOf = async (): Promise<ExecutionRun[]> => (await data()).runs;
  const calls: Call[] = [];
  let agentSeq = 0;
  const paseo = {
    config: { get: async () => ({ revision: "r1", config: { agentProfiles: PROFILES } }) },
    workspaces: {
      // R3.5: an existing workspace handle (coordinator replacement creates the new agent there).
      ref: (workspaceId: string) => ({
        id: workspaceId, directory: "/synthetic/wt", refresh: async () => undefined,
        agents: {
          create: async (o: unknown) => {
            calls.push({ op: "workspace.ref.agents.create", args: { workspaceId, ...(typeof o === "object" && o !== null ? o : {}) } });
            if (fake.agentFails) throw new Error("agent creation failed");
            return { id: `agent-new-${++agentSeq}` };
          },
        },
      }),
      create: async (options: unknown) => {
        calls.push({ op: "workspaces.create", args: options });
        if (fake.createFails) throw new Error("workspace creation failed");
        return {
          id: "ws-new", projectId: s.P, directory: "/synthetic/wt", name: "roadmap", status: null,
          agents: {
            create: async (o: unknown) => {
              calls.push({ op: "agents.create", args: o });
              if (fake.agentFails) throw new Error("agent creation failed");
              await fake.duringAgentCreate?.();
              return { id: `agent-new-${++agentSeq}` };
            },
          },
        };
      },
    },
    agents: {
      ref: (agentId: string) => ({
        id: agentId,
        send: async (prompt: string, options?: PaseoAgentSendOptions) => {
          const runs = await runsOf();
          calls.push({ op: "send", args: { agentId, prompt, options }, runsAtCall: runs.length, boundAtCall: (await feature()).coordinator?.agentId });
          if (fake.sendFails?.()) throw new Error("agent offline");
          await fake.duringSend?.current?.();
          return {};
        },
        archive: async () => {
          calls.push({ op: "archive", args: { agentId } });
          if (fake.archiveFails) throw new Error("archive failed");
          return {};
        },
      }),
    },
  };
  const { createRunCommands } = await import("./runs");
  const runs = createRunCommands({
    ...deps, approvals: s.approvals, settings: async () => roadmapSettings.schema.parse({}),
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- partial PaseoApi test stub: only the members this test exercises exist
    paseo: () => paseo as never,
  });
  const start = async (profileRef?: string) =>
    runs.start(s.open, { projectId: s.P, expectedRevision: await s.revision(), featureId, ...(profileRef !== undefined ? { profileRef } : {}) }, UI_ORIGIN);
  const snapshot = async () => ({ revision: await s.revision(), data: JSON.stringify(await data()) });
  const ops = () => calls.map((c) => c.op);
  return { ...s, seed, featureId, d, data, feature, runsOf, calls, ops, runs, start, snapshot };
}

describe("R3.4 staged coordinator start", () => {
  it("the coordinator module exists (R3.4)", async () => {
    const mod: Record<string, unknown> = await import("./coordinator");
    expect(typeof mod).toBe("object");
  });

  it("an unknown profile is invalid_input and creates nothing", async () => {
    const s = await setup();
    const before = await s.snapshot();
    const e = err(await s.start("no-such-profile"));
    expect(e.code).toBe("invalid_input");
    expect(s.ops().filter((op) => op !== "config.get")).toEqual([]);
    expect(await s.snapshot()).toEqual(before);
  });

  it("maps the profile, creates a branch-off worktree workspace and an agent with no prompt, commits, then sends the run prompt once", async () => {
    const s = await setup();
    const out = ok(await s.start("team-coordinator"));
    expect(s.ops()).toEqual(["workspaces.create", "agents.create", "send"]);
    expect(s.calls[0].args).toMatchObject({ source: { kind: "worktree", action: "branch-off", branchName: `roadmap/${s.featureId}` } });
    const agent = objectArgs(s.calls[1]);
    expect(agent.config).toEqual({ provider: "claude/opus", modeId: "plan", thinkingOptionId: "high", featureValues: { web: true } });
    expect(agent.title).toBe("Roadmap: Search");
    expect(agent.labels).toEqual({ "decision-roadmap.feature": s.featureId });
    for (const k of ["prompt", "initialPrompt", "message"]) expect(k in agent, `no ${k} at creation`).toBe(false);
    const send = s.calls[2];
    expect(send.runsAtCall, "the run is committed before the send").toBe(1);
    expect(send.boundAtCall, "the binding is committed before the send").toBe("agent-new-1");
    const prompt = sendOf(send).prompt;
    const runs = await s.runsOf();
    expect(runs).toHaveLength(1);
    expect(prompt).toContain(runs[0].runToken);
    expect(prompt).toMatch(/only the plugin server decides completion/i);
    expect(out.runId).toBe(runs[0].id);
    const f = await s.feature();
    expect(f.status).toBe("executing");
    expect(f.coordinator).toMatchObject({ agentId: "agent-new-1", workspaceId: "ws-new", profileRef: "team-coordinator" });
    expect(runs[0].state).toBe("running");
  });

  it("a repeated start returns the existing run without creating or sending again", async () => {
    const s = await setup();
    const first = ok(await s.start("team-coordinator"));
    const again = ok(await s.start("team-coordinator"));
    expect(again.runId).toBe(first.runId);
    expect(s.ops()).toEqual(["workspaces.create", "agents.create", "send"]);
  });

  it("an SDK creation failure is run_not_ready coordinator_unavailable with no run, no binding and no send", async () => {
    for (const fake of [{ createFails: true }, { agentFails: true }]) {
      const s = await setup(fake);
      const before = await s.snapshot();
      const e = err(await s.start("team-coordinator"));
      expect(e.code, JSON.stringify(fake)).toBe("run_not_ready");
      expect(JSON.stringify(e.details)).toContain("coordinator_unavailable");
      expect(s.ops()).not.toContain("send");
      expect(await s.snapshot()).toEqual(before);
      await t?.cleanup();
      t = undefined;
    }
  });

  it("a revalidation failure after creation archives the extra agent and never sends; an archive failure leaves a note naming the orphan", async () => {
    let bindOther: (() => Promise<void>) | undefined;
    const s = await setup({ duringAgentCreate: () => bindOther!(), archiveFails: false });
    bindOther = async () => {
      await (await s.open(s.P)).transact(await s.revision(), (draft) => {
        draft.features.find((f) => f.id === s.featureId)!.coordinator = { agentId: "agent-other", workspaceId: "ws-x", boundAt: "2026-10-29T10:00:00.000Z", profileRef: "plain" };
      });
    };
    expect((await s.start("team-coordinator")).ok).toBe(false);
    expect(s.ops()).toContain("archive");
    expect(s.ops()).not.toContain("send");
    expect(await s.runsOf()).toEqual([]);
    expect((await s.feature()).coordinator?.agentId).toBe("agent-other");

    let bindOther2: (() => Promise<void>) | undefined;
    const s2 = await setup({ duringAgentCreate: () => bindOther2!(), archiveFails: true });
    bindOther2 = async () => {
      await (await s2.open(s2.P)).transact(await s2.revision(), (draft) => {
        draft.features.find((f) => f.id === s2.featureId)!.coordinator = { agentId: "agent-other", workspaceId: "ws-x", boundAt: "2026-10-29T10:00:00.000Z", profileRef: "plain" };
      });
    };
    expect((await s2.start("team-coordinator")).ok).toBe(false);
    expect(s2.ops()).not.toContain("send");
    const notes = (await s2.feature()).events.filter((e) => e.kind === "note");
    expect(notes.some((e) => (e.reason ?? "").includes("agent-new-1")), JSON.stringify(notes)).toBe(true);
  });

  it("two concurrent starts give one binding, one run and one send; the loser's agent is archived; both callers get the winning run", async () => {
    const s = await setup();
    const [a, b] = await Promise.all([s.start("team-coordinator"), s.start("team-coordinator")]);
    // R3.4 verification (approved ruling Q19): a start that loses to a concurrent winner returns the existing run.
    const va = ok(a);
    const vb = ok(b);
    expect(vb.runId).toBe(va.runId);
    expect(vb.runToken).toBe(va.runToken);
    expect(await s.runsOf()).toHaveLength(1);
    expect(s.ops().filter((op) => op === "send")).toHaveLength(1);
    const created = s.ops().filter((op) => op === "agents.create").length;
    expect(s.ops().filter((op) => op === "archive")).toHaveLength(created - 1);
    const bound = (await s.feature()).coordinator?.agentId;
    const sentTo = sendOf(s.calls.find((c) => c.op === "send")).agentId;
    expect(sentTo).toBe(bound);
  });

  it("a send failure after the commit keeps the binding and run paused (owner) with prompt_failed and a note; run.resume re-sends once as a steer", async () => {
    let failSend = true;
    const s = await setup({ sendFails: () => failSend });
    ok(await s.start("team-coordinator"));
    const run = (await s.runsOf())[0];
    expect(run).toMatchObject({ state: "paused", pauseReason: "owner" });
    const failed = run.events.filter((e) => e.kind === "prompt_failed");
    expect(failed).toHaveLength(1);
    expect(failed[0].detail).toMatch(/^initial prompt not delivered: /);
    expect((await s.feature()).coordinator?.agentId).toBe("agent-new-1");
    expect((await s.feature()).events.some((e) => e.kind === "note")).toBe(true);
    expect(s.ops().filter((op) => op === "send"), "no automatic retry").toHaveLength(1);
    const view = ok(await s.runs.get(s.open, { projectId: s.P, runId: run.id }));
    expect(view.unresolved?.some((u) => u.startsWith("initial prompt not delivered"))).toBe(true);
    // A repeated start does not create or send.
    ok(await s.start("team-coordinator"));
    expect(s.ops().filter((op) => op === "agents.create")).toHaveLength(1);
    expect(s.ops().filter((op) => op === "send")).toHaveLength(1);
    // Resume with a failing send: still paused, still unresolved, no resumed event.
    const mut = async () => ({ projectId: s.P, expectedRevision: await s.revision(), runId: run.id, runToken: run.runToken });
    expect((await s.runs.resume(s.open, await mut(), UI_ORIGIN)).ok).toBe(false);
    let now = (await s.runsOf())[0];
    expect(now.state).toBe("paused");
    expect(now.events.some((e) => e.kind === "resumed")).toBe(false);
    // Resume with a working send: steer delivery, then resumed, running, unresolved cleared.
    failSend = false;
    ok(await s.runs.resume(s.open, await mut(), UI_ORIGIN));
    const sends = s.calls.filter((c) => c.op === "send");
    expect(sends).toHaveLength(3);
    expect(sendOf(sends.at(-1)).options?.activeTurnBehavior).toBe("steer");
    now = (await s.runsOf())[0]!;
    expect(now.state).toBe("running");
    expect(now.events.at(-1)?.kind).toBe("resumed");
    const after = ok(await s.runs.get(s.open, { projectId: s.P, runId: run.id }));
    expect(after.unresolved ?? []).toEqual([]);
  });
});

// R3.4 verification (root finding A): an undelivered run prompt is re-sent by run.resume only when the
// resume itself is allowed. A resume refused by readiness (basis no longer current) or by a stale
// expectedRevision must not send any execution prompt first.
describe("R3.4 resume never sends before its gates", () => {
  it("a resume refused by readiness or a stale expectedRevision sends nothing", async () => {
    let failSend = true;
    const s = await setup({ sendFails: () => failSend });
    ok(await s.start("team-coordinator"));
    const run = (await s.runsOf())[0];
    expect(run, "precondition: paused with an undelivered prompt").toMatchObject({ state: "paused", pauseReason: "owner" });
    const sendsBefore = s.ops().filter((op) => op === "send").length;
    failSend = false;
    // Stale expectedRevision.
    const stale = await s.runs.resume(s.open, { projectId: s.P, expectedRevision: (await s.revision()) - 1, runId: run.id, runToken: run.runToken }, UI_ORIGIN);
    expect(stale.ok).toBe(false);
    expect(s.ops().filter((op) => op === "send").length, "no send for a stale resume").toBe(sendsBefore);
    // The approved basis is cancelled: the run is no longer ready to resume.
    const cancelled = await s.project.service.decisionCancel(s.project.paseo, { projectId: s.P, expectedRevision: await s.revision(), ...s.seed.q1, reason: "Dropped" });
    if (!cancelled.ok) throw new Error(`cancel failed: ${cancelled.error.code}`);
    const refused = await s.runs.resume(s.open, { projectId: s.P, expectedRevision: await s.revision(), runId: run.id, runToken: run.runToken }, UI_ORIGIN);
    expect(refused.ok ? "ok" : refused.error.code).toBe("run_not_ready");
    expect(s.ops().filter((op) => op === "send").length, "no execution prompt before the readiness gate").toBe(sendsBefore);
    expect((await s.runsOf())[0].state).toBe("paused");
  });
});

// R3.4 final verification: a resume whose re-sent prompt is delivered but whose commit then conflicts
// (a concurrent store write) records the delivery, keeps the run paused, and a later resume does not
// send the prompt again; only a committed resume appends `resumed`.
describe("R3.4 delivered prompt with a conflicting resume commit", () => {
  it("records prompt_delivered, stays paused, and the next resume commits without a second send", async () => {
    let failSend = true;
    const during: { current?: () => Promise<void> } = {};
    const s = await setup({ sendFails: () => failSend, duringSend: during });
    ok(await s.start("team-coordinator"));
    const run = (await s.runsOf())[0];
    expect(run.state, "precondition: paused with an undelivered prompt").toBe("paused");
    failSend = false;
    // A concurrent write lands while the steer prompt is being delivered.
    during.current = async () => {
      during.current = undefined;
      await (await s.open(s.P)).transact(await s.revision(), (draft) => {
        draft.features.find((f) => f.id === s.featureId)!.description = "edited concurrently";
      });
    };
    const mut = async () => ({ projectId: s.P, expectedRevision: await s.revision(), runId: run.id, runToken: run.runToken });
    const first = await s.runs.resume(s.open, await mut(), UI_ORIGIN);
    expect(first.ok, "the conflicting commit is refused").toBe(false);
    const afterConflict = (await s.runsOf())[0];
    expect(afterConflict.state).toBe("paused");
    expect(afterConflict.events.some((e) => e.kind === "prompt_delivered")).toBe(true);
    expect(afterConflict.events.some((e) => e.kind === "resumed")).toBe(false);
    expect(ok(await s.runs.get(s.open, { projectId: s.P, runId: run.id })).unresolved ?? []).toEqual([]);
    const sendsBefore = s.ops().filter((op) => op === "send").length;
    ok(await s.runs.resume(s.open, await mut(), UI_ORIGIN));
    expect(s.ops().filter((op) => op === "send").length, "no second delivery").toBe(sendsBefore);
    const resumed = (await s.runsOf())[0];
    expect(resumed.state).toBe("running");
    expect(resumed.events.at(-1)?.kind).toBe("resumed");
  });
});

// Stage R3.5 (card §6.2 C, §6.2a): a start with an already bound coordinator sends the run prompt once
// after the commit (same failure protocol); a repeated start sends nothing.
describe("R3.5 pre-bound coordinator prompt (C)", () => {
  const bindPre = async (s: Awaited<ReturnType<typeof setup>>) =>
    (await s.open(s.P)).transact(await s.revision(), (draft) => {
      draft.features.find((f) => f.id === s.featureId)!.coordinator = { agentId: "agent-pre", workspaceId: "ws-pre", boundAt: "2026-10-29T10:00:00.000Z", profileRef: "team-coordinator" };
    });

  it("sends the run prompt once to the bound agent after the run commits; a repeated start sends nothing", async () => {
    const s = await setup();
    await bindPre(s);
    ok(await s.start());
    expect(s.ops()).toEqual(["send"]);
    const send = s.calls[0];
    expect(sendOf(send).agentId).toBe("agent-pre");
    expect(send.runsAtCall, "after the commit").toBe(1);
    expect(sendOf(send).prompt).toContain((await s.runsOf())[0].runToken);
    ok(await s.start());
    expect(s.ops()).toEqual(["send"]);
  });

  it("a failed pre-bound prompt pauses the run (owner) with prompt_failed and a note", async () => {
    const s = await setup({ sendFails: () => true });
    await bindPre(s);
    ok(await s.start());
    const run = (await s.runsOf())[0];
    expect(run).toMatchObject({ state: "paused", pauseReason: "owner" });
    expect(run.events.some((e) => e.kind === "prompt_failed")).toBe(true);
    expect((await s.feature()).events.some((e) => e.kind === "note")).toBe(true);
  });
});

// Stage R3.5 (card §6.2a "Coordinator replacement", UI only): preconditions refuse with no SDK call;
// the new agent is created in the existing workspace with no prompt; one transaction moves the old
// binding to coordinatorHistory and keeps the run and its token; the handover prompt is sent once after
// the commit; the old agent is not archived.
describe("R3.5 coordinator.replace", () => {
  async function started(fake: Parameters<typeof setup>[0] = {}) {
    const s = await setup(fake);
    ok(await s.start("team-coordinator"));
    const run = (await s.runsOf())[0];
    const replace = async (origin: WriteOrigin = UI_ORIGIN, profileRef = "plain") =>
      s.runs.replaceCoordinator(s.open, { projectId: s.P, expectedRevision: await s.revision(), featureId: s.featureId, profileRef }, origin);
    const pause = async () => ok(await s.runs.pause(s.open, { projectId: s.P, expectedRevision: await s.revision(), runId: run.id, runToken: run.runToken }, UI_ORIGIN));
    return { ...s, run, replace, pause };
  }

  it("refuses chat origin, a running run and an unknown profile with no SDK call and no write", async () => {
    const s = await started();
    expect("replaceCoordinator" in s.runs, "run commands expose replaceCoordinator (R3.5)").toBe(true);
    const sdkBefore = s.calls.length;
    const before = await s.snapshot();
    expect(err(await s.replace({ source: "chat", actor: { kind: "agent" }, quoted: "replace" })).code).toBe("invalid_input");
    const running = err(await s.replace());
    expect(running.code).toBe("invalid_input");
    expect(running.message).toMatch(/pause the run first/);
    await s.pause();
    const unknown = err(await s.replace(UI_ORIGIN, "no-such-profile"));
    expect(unknown.code).toBe("invalid_input");
    expect(s.calls.slice(sdkBefore).filter((c) => c.op !== "send")).toEqual([]);
    expect(readJsonObject((await s.snapshot()).data).features).toEqual(readJsonObject(before.data).features);
  });

  it("an unacknowledged paused run is run_not_ready (pause_unacknowledged) with no SDK call", async () => {
    const s = await started();
    await (await s.open(s.P)).transact(await s.revision(), (draft) => {
      const r = draft.runs[0];
      r.tasks[0] = { ...r.tasks[0], state: "in_progress", agentId: "agent-w" };
    });
    await s.pause();
    const sdkBefore = s.calls.filter((c) => c.op !== "send").length;
    const e = err(await s.replace());
    expect(e.code).toBe("run_not_ready");
    expect(JSON.stringify(e.details)).toContain("pause_unacknowledged");
    expect(s.calls.filter((c) => c.op !== "send").length).toBe(sdkBefore);
  });

  it("replaces the coordinator in the existing workspace, keeps the run and token, records history, then sends the handover once; the old agent is not archived", async () => {
    const s = await started();
    await s.pause();
    const old = (await s.feature()).coordinator!;
    const callsBefore = s.calls.length;
    const out = ok(await s.replace());
    const fresh = s.calls.slice(callsBefore);
    expect(fresh.map((c) => c.op).filter((op) => op !== "send")).toEqual(["workspace.ref.agents.create"]);
    expect(fresh[0].args).toMatchObject({ workspaceId: old.workspaceId });
    for (const k of ["prompt", "initialPrompt", "message"]) expect(k in objectArgs(fresh[0]), `no ${k}`).toBe(false);
    const handover = fresh.filter((c) => c.op === "send");
    expect(handover).toHaveLength(1);
    expect(sendOf(handover[0]).agentId).toBe(out.agentId);
    expect(handover[0].boundAtCall, "sent after the binding commit").toBe(out.agentId);
    expect(fresh.some((c) => c.op === "archive")).toBe(false);
    const f = await s.feature();
    expect(f.coordinator).toMatchObject({ agentId: out.agentId, workspaceId: old.workspaceId, profileRef: "plain" });
    expect(f.coordinatorHistory.at(-1)).toMatchObject({ agentId: old.agentId });
    const run = (await s.runsOf())[0];
    expect(run.id).toBe(s.run.id);
    expect(run.runToken).toBe(s.run.runToken);
  });

  // R3.5 completion: replacement failure paths (card §6.2a "Coordinator replacement").
  it("an SDK failure creating the new agent is run_not_ready (coordinator_unavailable) with no write", async () => {
    const flags = { agent: false };
    const s = await started({ get agentFails() { return flags.agent; } });
    await s.pause();
    flags.agent = true;
    const before = await s.snapshot();
    const e = err(await s.replace());
    expect(e.code).toBe("run_not_ready");
    expect(JSON.stringify(e.details)).toContain("coordinator_unavailable");
    expect(await s.snapshot()).toEqual(before);
  });

  it("a failed handover send keeps the new binding, leaves the run paused, records prompt_failed and a note", async () => {
    const flags = { send: false };
    const s = await started({ sendFails: () => flags.send });
    await s.pause();
    flags.send = true;
    const out = ok(await s.replace());
    const f = await s.feature();
    expect(f.coordinator?.agentId, "the new binding is kept").toBe(out.agentId);
    const run = (await s.runsOf())[0];
    expect(run.state).toBe("paused");
    expect(run.runToken).toBe(s.run.runToken);
    expect(run.events.filter((e) => e.kind === "prompt_failed").at(-1)?.detail ?? "").toMatch(/handover prompt not delivered/);
    expect(f.events.some((e) => e.kind === "note")).toBe(true);
  });

  it("concurrent replacements: one binding wins, history grows once, one handover send; the loser archives its own agent", async () => {
    const s = await started();
    await s.pause();
    const historyBefore = (await s.feature()).coordinatorHistory.length;
    const callsBefore = s.calls.length;
    const results = await Promise.all([s.replace(), s.replace()]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    const winner = ok(results.find((r) => r.ok)!);
    const f = await s.feature();
    expect(f.coordinator?.agentId).toBe(winner.agentId);
    expect(f.coordinatorHistory).toHaveLength(historyBefore + 1);
    const fresh = s.calls.slice(callsBefore);
    const created = fresh.filter((c) => c.op === "workspace.ref.agents.create");
    expect(created).toHaveLength(2);
    expect(fresh.filter((c) => c.op === "send"), "no second handover prompt").toHaveLength(1);
    const archived = fresh.filter((c) => c.op === "archive").map((c) => (c.op === "archive" ? c.args.agentId : undefined));
    expect(archived).toHaveLength(1);
    expect(archived[0]).not.toBe(winner.agentId);
  });

  it("the no-workspace sentinel branches off a new workspace (createCoordinator) instead of the existing-workspace path", async () => {
    const s = await started();
    // MODELLED STATE (labelled): the feature is bound with the "no-workspace" sentinel (roadmap_feature_bind bound-chat).
    await (await s.open(s.P)).transact(await s.revision(), (draft) => {
      draft.features.find((f) => f.id === s.featureId)!.coordinator!.workspaceId = "no-workspace";
    });
    await s.pause();
    const callsBefore = s.calls.length;
    const out = ok(await s.replace());
    const ops = s.calls.slice(callsBefore).map((c) => c.op);
    expect(ops).toContain("workspaces.create");
    expect(ops).not.toContain("workspace.ref.agents.create");
    expect(out.workspaceId).toBe("ws-new");
    expect((await s.feature()).coordinator).toMatchObject({ agentId: out.agentId, workspaceId: "ws-new" });
  });
});

// R3 corrective (DeepSeek c0017, root ruling): a start with a stale expectedRevision is refused
// (revision_conflict) before any SDK effect (no workspace, agent, send or archive) and writes nothing;
// an existing live run is still returned as is (idempotence and the Q19 winner path unchanged).
describe("R3 corrective: stale start has no SDK effect (c0017)", () => {
  it("a stale expectedRevision on a branch-off start refuses with no SDK call and no write", async () => {
    const s = await setup();
    const before = await s.snapshot();
    const out = await s.runs.start(s.open, { projectId: s.P, expectedRevision: (await s.revision()) - 1, featureId: s.featureId, profileRef: "team-coordinator" }, UI_ORIGIN);
    expect(out.ok ? "ok" : out.error.code).toBe("revision_conflict");
    expect(s.ops(), "no workspace, agent, send or archive").toEqual([]);
    expect(await s.snapshot()).toEqual(before);
  });

  it("control: with a live run a stale start still returns the existing run without SDK calls", async () => {
    const s = await setup();
    ok(await s.start("team-coordinator"));
    const calls = s.calls.length;
    const live = (await s.runsOf())[0];
    const again = ok(await s.runs.start(s.open, { projectId: s.P, expectedRevision: (await s.revision()) - 1, featureId: s.featureId, profileRef: "team-coordinator" }, UI_ORIGIN));
    expect(again).toMatchObject({ runId: live.id, existing: true });
    expect(s.calls.length).toBe(calls);
  });
});

// R3 corrective (DeepSeek c0014): the run prompt tells the coordinator to hand the run id and run token
// to every dispatched worker (roadmap_task_progress and roadmap_run_ack need both); the handover prompt
// reuses it.
describe("R3 corrective: run prompt hands runId and runToken to dispatched workers (c0014)", () => {
  const X = { featureTitle: "Search", featureId: "f-1", runId: "run-77", runToken: "tok-77" };
  const workerSentence = (text: string) =>
    text.split(/(?<=[.!?])\s+/).filter((sentence) => /worker/i.test(sentence) && /run[ _]?id|runId/i.test(sentence) && /token/i.test(sentence));

  it("runPrompt has a sentence directing the coordinator to give dispatched workers the run id and token", async () => {
    const { runPrompt } = await import("./coordinator");
    const text = runPrompt(X);
    expect(workerSentence(text), text).toHaveLength(1);
    expect(workerSentence(text)[0]).toMatch(/dispatch/i);
    expect(text).toContain("run-77");
    expect(text).toContain("tok-77");
  });

  it("handoverPrompt carries the same instruction", async () => {
    const { handoverPrompt } = await import("./coordinator");
    const text = handoverPrompt({ ...X, previousAgentId: "agent-old" });
    expect(workerSentence(text), text).toHaveLength(1);
  });
});

// Stage R4.3 (task card §4): replacementPrompt asks the coordinator for a replacement plan draft and
// states that only the human approves; a staged start of a feature with a QUEUED replacement request
// turns it into `requested` (history note naming the start) and, after commit, sends exactly one
// replacement steer; an already requested feature gets none.
describe("R4.3 replacement prompt and queued → requested on staged start", () => {
  it("replacementPrompt names the feature and the cancelled cause, asks for a replacement draft and says only the human approves", async () => {
    const mod = await import("./coordinator");
    expect(typeof mod.replacementPrompt, "server/coordinator exports replacementPrompt").toBe("function");
    const text = mod.replacementPrompt({ featureTitle: "Search", featureId: "f-9", becauseOfTitle: "Indexer" });
    expect(text).toContain("Search");
    expect(text).toContain("f-9");
    expect(text).toContain("Indexer");
    expect(text).toMatch(/replacement/i);
    expect(text).toMatch(/draft/i);
    expect(text).toMatch(/only the (human|owner|person)[^.]*approv/i);
  });

  // R4 successor KensAI c0040/c0043 (accepted wording): the cause may be the root of a dependency chain,
  // so the prompt must not call it this feature's prerequisite; and a feature with a plan needs a new
  // revision of it, so the prompt names the lookup (roadmap_plan_status) and drafting with that planId.
  it("replacementPrompt describes a cancellation in the dependency chain and directs the plan lookup and a new revision with planId", async () => {
    const mod = await import("./coordinator");
    const text = mod.replacementPrompt({ featureTitle: "Search", featureId: "f-9", becauseOfTitle: "Indexer" });
    expect(text, "the cause is not presented as this feature's own prerequisite").not.toMatch(/The prerequisite "Indexer" of/);
    expect(text).toMatch(/dependency chain/i);
    expect(text).toContain("Indexer");
    expect(text).toContain("roadmap_plan_status");
    expect(text).toMatch(/planId/);
    expect(text).toMatch(/new revision/i);
    expect(text).toContain("roadmap_plan_draft");
  });

  // R4 final DeepSeek c0086: a dependent with no bound plan also gets the request, and a draft without
  // featureId creates an unbound plan that cannot execute this feature. The prompt names the binding
  // argument with this feature's actual id (wording only; no new parameter or lookup).
  it("replacementPrompt tells the coordinator to pass featureId with this feature's id to roadmap_plan_draft", async () => {
    const mod = await import("./coordinator");
    const text = mod.replacementPrompt({ featureTitle: "Search", featureId: "f-9", becauseOfTitle: "Indexer" });
    expect(text, "the draft binding argument is named with the actual feature id").toMatch(/featureId\W{0,4}f-9\b/);
    expect(text).toContain("roadmap_plan_draft");
  });

  async function queuedStart(state: "queued" | "requested") {
    const s = await setup();
    await (await s.open(s.P)).transact(await s.revision(), (draft) => {
      // MODELLED STATE (labelled): an unbound feature that a cancelled prerequisite left with a request.
      const feature = draft.features.find((f) => f.id === s.featureId);
      if (!feature) throw new Error("modelled feature missing");
      feature.replacementRequested = { at: "2026-10-29T10:00:00.000Z", becauseOf: "f-root", state };
    });
    return s;
  }

  it("a staged start turns a queued request into requested with a note naming the start, and sends one replacement steer after the run prompt commit", async () => {
    const s = await queuedStart("queued");
    ok(await s.start("team-coordinator"));
    const f = await s.feature();
    expect((f as Record<string, any>).replacementRequested).toMatchObject({ state: "requested", becauseOf: "f-root" });
    expect(f.events.some((e) => e.kind === "note" && /start/i.test(JSON.stringify(e)) && /replacement/i.test(JSON.stringify(e)))).toBe(true);
    const sends = s.calls.filter((c) => c.op === "send").map((c) => sendOf(c).prompt);
    expect(sends.filter((p) => /replacement/i.test(p)), "exactly one replacement steer").toHaveLength(1);
  });

  // R4 successor KensAI c0038 control: on the UI start path the delivery-failure note stays human.
  it("control: a failed replacement steer on a UI start records the 'not delivered' note as human", async () => {
    const s = await setup({ sendFails: () => true });
    await (await s.open(s.P)).transact(await s.revision(), (draft) => {
      // MODELLED STATE (labelled): an unbound feature that a cancelled prerequisite left with a request.
      const feature = draft.features.find((f) => f.id === s.featureId);
      if (!feature) throw new Error("modelled feature missing");
      feature.replacementRequested = { at: "2026-10-29T10:00:00.000Z", becauseOf: "f-root", state: "queued" };
    });
    ok(await s.start("team-coordinator"));
    const failed = (await s.feature()).events.filter((e) => e.kind === "note" && /replacement request not delivered/.test(String((e as { reason?: string }).reason)));
    expect(failed).toHaveLength(1);
    expect(failed[0].actor).toEqual({ kind: "human" });
  });

  it("an already requested feature gets no replacement steer on start", async () => {
    const s = await queuedStart("requested");
    ok(await s.start("team-coordinator"));
    const sends = s.calls.filter((c) => c.op === "send").map((c) => sendOf(c).prompt);
    expect(sends.filter((p) => /replacement plan/i.test(p))).toEqual([]);
  });
});
