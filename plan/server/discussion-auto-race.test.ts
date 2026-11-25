// The window between the automatic continuation's claim and its send. The host has no conditional
// send (every message interrupts a running turn and clears pending permissions and questions), so
// the engine reads the chat once more after the claim and sends only when that read shows it idle
// with nothing pending; otherwise the unsent claim is withdrawn and the continuation waits for the
// next turn end, permission resolution or reconcile. These cases change the chat at the first read
// taken while the claim is committed (`sending` in the store), so they exercise the post-claim read
// itself, whatever reads come before it. A change after that last read, before the send reaches the
// host, cannot be detected by any public host call; the owner accepted that window, and it is not
// covered here.
//
// Harness: real temp store and commands, the real pause engine, a scripted synthetic host whose
// refresh is observed per call. No model or live host is involved.
import type { PaseoApi } from "@getpaseo/client";
import type { PluginLifecycleEvents } from "@getpaseo/plugin/server";
import type { AgentPermissionRequest } from "@getpaseo/protocol/agent-types";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { resolveRetry } from "./discussion";
import { createPauseEngine } from "./pause";
import { createRoadmapCommands, UI_ORIGIN, type StoreOpener } from "./sessions";
import { openProjectStore } from "./store-root";
import { NOW, nextId, opt } from "./test-support/build";
import { fakeDirectory } from "./test-support/fake-dir";
import { manualFinish } from "./test-support/finish";
import { fakePaseoAgents, gate, hookAgent } from "./test-support/fake-paseo-agents";
import { binding, BLK_OPEN, continuationIn, PLANNER, seedGrilling } from "./test-support/grilling";
import type { Session } from "../shared/model";
import { makeProject, ok, type TestProject } from "./test-support/service";

const P = "prj_test";
const CODEX_DEFAULT = [{ type: "toggle" as const, id: "plan_mode", label: "Plan", value: false }];
const APPROVAL: AgentPermissionRequest = { id: "perm-approval-1", provider: "codex", name: "exec_command", kind: "tool", title: "Run a command" };
const RetryRecord = z.looseObject({ id: z.string(), state: z.string(), resolvedBy: z.string().optional() });

let project: TestProject | undefined;
afterEach(async () => {
  await project?.cleanup();
  project = undefined;
});

async function setup() {
  project = await makeProject();
  const root = project.root;
  const now = () => new Date(NOW);
  const dir = fakeDirectory({ projects: [{ projectId: P, projectRootPath: root, projectKind: "git" }] });
  const storeOptions = { now, newId: nextId, log: () => undefined };
  const fake = fakePaseoAgents([{ id: PLANNER, provider: "codex", cwd: root, status: "idle", features: CODEX_DEFAULT, pending: [] }]);
  /** Awaited before the host answers each refresh of the planner. */
  let onRefresh: () => Promise<void> | void = () => undefined;
  /** Awaited after the host answered a refresh, before the engine sees the answer. */
  let afterRefresh: () => Promise<void> | void = () => undefined;
  const paseo: PaseoApi = {
    ...fake.paseo,
    agents: {
      ...fake.paseo.agents,
      ref: (agent: Parameters<PaseoApi["agents"]["ref"]>[0]) =>
        new Proxy(fake.paseo.agents.ref(agent), {
          get: (target, key, receiver) => {
            const value: unknown = Reflect.get(target, key, receiver);
            if (key !== "refresh") return value;
            return async () => {
              await onRefresh();
              const answer = await target.refresh();
              await afterRefresh();
              return answer;
            };
          },
        }),
    },
  };
  const open: StoreOpener = (projectId) => openProjectStore(dir, projectId, storeOptions);
  // The plugin cleanup aborts the engine; a restart is a new engine with a fresh signal.
  let controller = new AbortController();
  const make = () => createPauseEngine({ open, paseo: () => paseo, directory: () => dir, log: () => undefined, now, newId: nextId, retryDelaysMs: [0, 0], signal: controller.signal });
  let engine = make();
  const restart = () => {
    controller = new AbortController();
    engine = make();
    engine.remember(PLANNER, P);
    onRefresh = () => undefined;
    afterRefresh = () => undefined;
  };
  const commands = createRoadmapCommands({ directory: () => dir, now, newId: nextId, storeOptions, afterAccept: (x) => void engine.afterAccept(x) });
  ok(await commands.init(open, { projectId: P }, UI_ORIGIN));
  const revision = async () => ok(await commands.version(open, { projectId: P }, UI_ORIGIN)).revision!;
  const sessionId = ok(await commands.sessionCreate(open, { projectId: P, expectedRevision: await revision(), title: "[feature] Login" }, UI_ORIGIN)).sessionId;
  const [q1] = ok(
    await commands.questionCreateBatch(
      open,
      { projectId: P, expectedRevision: await revision(), sessionId, blockId: BLK_OPEN, questions: [{ title: "Q1", context: "", options: [opt("a"), opt("b")], allowFreeText: false, activatedBy: [], invalidatedBy: [] }] },
      { source: "chat", actor: { kind: "agent" } },
    ),
  ).questionIds;
  ok(await commands.questionAnswer(open, { projectId: P, expectedRevision: await revision(), sessionId, questionId: q1, optionId: "a" }, UI_ORIGIN));
  await seedGrilling(open, P, sessionId, { planner: binding({ boundBy: "discussion" }), continuation: continuationIn("unsupported", { reason: "codex default mode" }) });
  engine.remember(PLANNER, P);

  const session = async (): Promise<Session> => {
    const read = await (await open(P)).read();
    if (read.status !== "ok") throw new Error(`expected an ok store, got ${read.status}`);
    return read.data.sessions.find((s) => s.id === sessionId)!;
  };
  const records = async () => z.array(RetryRecord).parse((await session()).retries ?? []);
  const accept = async () => {
    ok(await commands.blockAccept(open, { projectId: P, sessionId, blockId: BLK_OPEN, expectedRevision: await revision() }, UI_ORIGIN));
    await engine.idle();
  };
  const agent = () => hookAgent(PLANNER, root, "codex");
  const turnEnded = async () => {
    const event: PluginLifecycleEvents["agent.turn_ended"] = { agent: agent(), turnId: "turn-1", outcome: { kind: "completed" }, timeline: [] };
    await engine.turnEnded(event, paseo);
    await engine.idle();
  };
  const permissionResolved = async (requestId: string) => {
    const event: PluginLifecycleEvents["agent.permission_resolved"] = { agent: agent(), requestId, resolution: { behavior: "allow" } };
    await engine.permissionResolved(event, paseo);
    await engine.idle();
  };
  const reconcile = async () => {
    await engine.reconcileAll(paseo);
    await engine.idle();
  };
  const planner = () => fake.agents.get(PLANNER)!;
  /**
   * Applies `change` at the first read taken while a claim is committed (`sending`), and `after` at
   * every read after it. Returns whether that post-claim read happened.
   */
  const atClaimedRead = (change: () => unknown, after: () => unknown = () => undefined) => {
    let done = false;
    onRefresh = async () => {
      if (done) {
        after();
        return;
      }
      if ((await records()).some((r) => r.state === "sending")) {
        done = true;
        await Promise.resolve(change());
      }
    };
    return () => done;
  };
  /** Fires a turn end without waiting for the engine to settle (a hook arriving during a decision). */
  const turnEndedNow = () => engine.turnEnded({ agent: agent(), turnId: "turn-x", outcome: { kind: "completed" }, timeline: [] }, paseo);
  return {
    fake, open, commands, revision, sessionId, session, records, accept, turnEnded, turnEndedNow, permissionResolved, reconcile, planner, atClaimedRead, restart,
    /** Accept without waiting for the engine; `idle` waits for it. */
    acceptOnly: async () => ok(await commands.blockAccept(open, { projectId: P, sessionId, blockId: BLK_OPEN, expectedRevision: await revision() }, UI_ORIGIN)),
    idle: () => engine.idle(),
    /** Awaited before the host answers each refresh of the planner (replaces any earlier hook). */
    beforeRead: (fn: () => Promise<void> | void) => (onRefresh = fn),
    abort: () => controller.abort(),
    afterRefresh: (fn: () => Promise<void> | void) => (afterRefresh = fn),
  };
}

describe("the chat changes between the automatic continuation's claim and its send", () => {
  it("a turn starts: nothing is sent, the unsent claim is withdrawn, and the next idle turn end sends once", async () => {
    const t = await setup();
    const claimedRead = t.atClaimedRead(() => (t.planner().status = "running"));
    await t.accept();
    expect(claimedRead()).toBe(true);
    expect(t.fake.calls.send).toEqual([]);
    expect(await t.records()).toEqual([]);
    t.planner().status = "idle";
    await t.turnEnded();
    expect(t.fake.calls.send).toHaveLength(1);
    expect(t.fake.calls.send[0]).toMatchObject({ statusAtSend: "idle", pendingAtSend: 0 });
    expect((await t.records()).map((r) => r.state)).toEqual(["sent"]);
  });

  it("a permission request appears: nothing is sent or answered and the prompt stays; once resolved, one send", async () => {
    const t = await setup();
    const claimedRead = t.atClaimedRead(() => t.planner().pending.push(structuredClone(APPROVAL)));
    await t.accept();
    expect(claimedRead()).toBe(true);
    expect(t.fake.calls.send).toEqual([]);
    expect(t.fake.calls.respond).toEqual([]);
    expect(t.planner().pending.map((r) => r.id)).toEqual([APPROVAL.id]);
    expect(await t.records()).toEqual([]);
    t.fake.drop(PLANNER, APPROVAL.id);
    await t.permissionResolved(APPROVAL.id);
    expect(t.fake.calls.send).toHaveLength(1);
    expect(t.fake.calls.send[0]).toMatchObject({ statusAtSend: "idle", pendingAtSend: 0 });
  });

  it("the last read fails: nothing is sent (fail closed); a later reconcile sends once", async () => {
    const t = await setup();
    const claimedRead = t.atClaimedRead(
      () => t.fake.script.refreshRejects.set(PLANNER, new Error("synthetic refresh failure")),
      () => t.fake.script.refreshRejects.delete(PLANNER),
    );
    await t.accept();
    expect(claimedRead()).toBe(true);
    expect(t.fake.calls.send).toEqual([]);
    expect(await t.records()).toEqual([]);
    await t.reconcile();
    expect(t.fake.calls.send).toHaveLength(1);
    expect((await t.records()).map((r) => r.state)).toEqual(["sent"]);
  });

  it("the last read does not answer within its short bound: nothing is sent", async () => {
    const t = await setup();
    const hold = gate();
    const claimedRead = t.atClaimedRead(
      () => t.fake.script.refreshGate.set(PLANNER, hold.promise),
      () => t.fake.script.refreshGate.delete(PLANNER),
    );
    await t.accept();
    expect(claimedRead()).toBe(true);
    expect(t.fake.calls.send).toEqual([]);
    expect(await t.records()).toEqual([]);
    hold.release();
  }, 10_000);
});

// Review regressions: the plugin's own store changes while the post-claim read is in flight. The read
// shows the chat idle, but the claim no longer matches the session: the owner finished the session,
// rebound the planner, a new operation started on the next block, or the owner settled the record.
// The claimed text is then stale: it is never sent, and the store keeps exactly what those changes
// wrote. Every change is a real store transaction through the commands.
describe("the session changes in the store while the post-claim read is in flight", () => {
  it("the owner finishes the session: nothing is sent, the unsent claim is withdrawn, the session stays closed", async () => {
    const t = await setup();
    const claimedRead = t.atClaimedRead(async () =>
      ok(await t.commands.sessionFinish(t.open, manualFinish(P, await t.revision(), t.sessionId), UI_ORIGIN)),
    );
    await t.accept();
    expect(claimedRead()).toBe(true);
    expect(t.fake.calls.send).toEqual([]);
    expect(await t.records()).toEqual([]);
    expect((await t.session()).status).toBe("closed");
  });

  it("the owner rebinds the planner: nothing is sent to either chat, the unsent claim is withdrawn, the new binding stays", async () => {
    const t = await setup();
    const claimedRead = t.atClaimedRead(async () =>
      ok(await t.commands.plannerSet(t.open, { projectId: P, expectedRevision: await t.revision(), sessionId: t.sessionId, agentId: "agent-new", workspaceId: "ws-1" }, UI_ORIGIN)),
    );
    await t.accept();
    expect(claimedRead()).toBe(true);
    expect(t.fake.calls.send).toEqual([]);
    expect(await t.records()).toEqual([]);
    expect((await t.session()).planner).toMatchObject({ agentId: "agent-new", epoch: 2 });
  });

  it("a new operation starts on the next block: nothing is sent, the unsent claim is withdrawn, the new operation is untouched", async () => {
    const t = await setup();
    let next: Session["continuation"];
    const claimedRead = t.atClaimedRead(async () => {
      const open = (await t.session()).blocks!.find((b) => b.state === "open")!.id;
      next = continuationIn("awaiting_pause", { operationId: "op-2", openBlockId: open });
      await seedGrilling(t.open, P, t.sessionId, { continuation: next });
    });
    await t.accept();
    expect(claimedRead()).toBe(true);
    expect(t.fake.calls.send).toEqual([]);
    expect(await t.records()).toEqual([]);
    expect((await t.session()).continuation).toEqual(next);
  });

  for (const [outcome, state] of [["delivered", "sent"], ["not_delivered", "failed"]] as const) {
    it(`the owner marks the claimed record ${outcome}: nothing is sent and the owner's mark stays exactly`, async () => {
      const t = await setup();
      const claimedRead = t.atClaimedRead(async () => {
        const [record] = await t.records();
        const deps = { open: t.open, now: () => new Date(NOW), newId: nextId, log: () => undefined };
        expect((await resolveRetry(deps, { projectId: P, expectedRevision: await t.revision(), sessionId: t.sessionId, retryId: record.id, outcome })).ok).toBe(true);
      });
      await t.accept();
      expect(claimedRead()).toBe(true);
      expect(t.fake.calls.send).toEqual([]);
      expect(await t.records()).toEqual([expect.objectContaining({ state, resolvedBy: "user" })]);
    });
  }
});

// Review regression (KensAI c0003): the plugin is stopped (cleanup abort) after the claim committed
// and before anything was sent. The claim is then unambiguously unsent, so it must not strand the
// accepted block: after a restart the block is continued, once. (A claim whose send may have started
// is never resent; discussion-auto.test.ts covers that.)
describe("a stop between the claim and the send", () => {
  it("leaves no stranded claim: after a restart the accepted block is sent once", async () => {
    const t = await setup();
    const claimedRead = t.atClaimedRead(() => t.abort());
    await t.accept();
    expect(claimedRead()).toBe(true);
    expect(t.fake.calls.send).toEqual([]);
    t.restart();
    await t.reconcile();
    expect(t.fake.calls.send).toHaveLength(1);
    expect((await t.records()).map((r) => r.state)).toEqual(["sent"]);
  });
});

// Review regression (KensAI c0006): triggers that arrive while a decision is running ask for one more
// pass. Here a turn end arrives during each of three consecutive decisions that find the chat
// running; the last one comes when the chat has become idle. That trigger must still be served.
describe("triggers arriving during consecutive decisions", () => {
  it("the trigger that arrives during the last decision is not lost", async () => {
    const t = await setup();
    t.planner().status = "running";
    let reads = 0;
    t.afterRefresh(async () => {
      reads += 1;
      if (reads > 3) return;
      if (reads === 3) t.planner().status = "idle";
      await t.turnEndedNow();
    });
    await t.accept();
    for (let i = 0; i < 50 && t.fake.calls.send.length === 0; i++) await new Promise((r) => setTimeout(r, 5));
    expect(reads).toBeGreaterThanOrEqual(3);
    expect(t.fake.calls.send).toHaveLength(1);
    expect(t.fake.calls.send[0]).toMatchObject({ statusAtSend: "idle", pendingAtSend: 0 });
  });
});

// Review regressions (KensAI c0066, c0067, c0074) for loading a chat the host closed. The engine
// reads the chat, finds it closed (not archived), loads it with a timeline read, and reads it again.
// These cases change things while that first read is in flight, or hold the load open. What can be
// pinned is the plugin's own order: a stop or a store change that lands before the read returns is
// seen before the load is issued. A change after the load was issued cannot be withdrawn: the host
// loads the chat from its stored session.
describe("loading a closed chat", () => {
  /** Host calls recorded so far: refreshes, loads, sends and permission answers. */
  const hostCalls = (t: Awaited<ReturnType<typeof setup>>) => ({
    refresh: t.fake.calls.refresh.length,
    load: t.fake.calls.load.length,
    send: t.fake.calls.send.length,
    respond: t.fake.calls.respond.length,
  });

  it("c0066: the plugin stops while the first read is in flight: no load and no other host call after the stop", async () => {
    const t = await setup();
    t.planner().status = "closed";
    let atStop: ReturnType<typeof hostCalls> | undefined;
    t.beforeRead(() => {
      if (atStop !== undefined) return;
      t.abort();
      atStop = hostCalls(t);
      // The refresh being answered was already issued before the stop.
      atStop.refresh += 1;
    });
    await t.accept();
    expect(atStop).toBeDefined();
    expect(t.fake.calls.load).toEqual([]);
    expect(hostCalls(t)).toEqual(atStop);
    expect(await t.records()).toEqual([]);
  });

  for (const [what, change] of [
    ["the owner finishes the session", async (t: Awaited<ReturnType<typeof setup>>) => ok(await t.commands.sessionFinish(t.open, manualFinish(P, await t.revision(), t.sessionId), UI_ORIGIN))],
    ["the owner rebinds the planner", async (t: Awaited<ReturnType<typeof setup>>) => ok(await t.commands.plannerSet(t.open, { projectId: P, expectedRevision: await t.revision(), sessionId: t.sessionId, agentId: "agent-new", workspaceId: "ws-1" }, UI_ORIGIN))],
    ["a new operation supersedes the accepted one", async (t: Awaited<ReturnType<typeof setup>>) => {
      const open = (await t.session()).blocks!.find((b) => b.state === "open")!.id;
      await seedGrilling(t.open, P, t.sessionId, { continuation: continuationIn("awaiting_pause", { operationId: "op-2", openBlockId: open }) });
    }],
  ] as const) {
    it(`c0067: ${what} while the first read is in flight: the closed chat is not loaded and nothing is sent`, async () => {
      const t = await setup();
      t.planner().status = "closed";
      let changed = false;
      t.beforeRead(async () => {
        if (changed) return;
        changed = true;
        await change(t);
      });
      await t.accept();
      expect(changed).toBe(true);
      expect(t.fake.calls.load).toEqual([]);
      expect(t.fake.calls.send).toEqual([]);
      expect(await t.records()).toEqual([]);
    });
  }

  it("c0074: a load the host never answers reaches its bound: nothing is claimed or sent, and the engine settles", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const t = await setup();
      t.planner().status = "closed";
      const hold = gate();
      t.fake.script.loadGate.set(PLANNER, hold.promise);
      await t.acceptOnly();
      for (let i = 0; i < 500 && t.fake.calls.load.length === 0; i++) await new Promise((r) => setImmediate(r));
      expect(t.fake.calls.load).toEqual([PLANNER]);
      let settled = false;
      const idle = t.idle().then(() => (settled = true));
      await vi.advanceTimersByTimeAsync(29_000);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1_000);
      for (let i = 0; i < 500 && !settled; i++) await new Promise((r) => setImmediate(r));
      expect(settled).toBe(true);
      await idle;
      expect(t.fake.calls.send).toEqual([]);
      expect(await t.records()).toEqual([]);
      hold.release();
    } finally {
      vi.useRealTimers();
    }
  });
});
