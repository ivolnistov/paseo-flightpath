// Automatic grilling S2/G4 (task card §4.3 engine table, §4.4; PLAN §3.4–§3.5; TR4, TR9, TR10,
// TR15, TR16): the pause engine over a real temp store and a scripted fake host. Every transition
// is a fenced store write; the claim (state resolving, attempts n) is committed before the one
// respondToPermission call for attempt n; late acknowledgements and events cannot overwrite a moved
// operation. Accept before the card is answered once; reloads retry a pending request up to 3 calls
// in total and leave an unconfirmed outcome visible; a rebind's old card is never answered. The
// engine never sends, runs or denies anything. Races use gates and Promise.all, timers are faked.
import type { PaseoApi } from "@getpaseo/client";
import type { PluginLifecycleEvents } from "@getpaseo/plugin/server";
import type { AgentPermissionRequest, AgentPermissionResponse } from "@getpaseo/protocol/agent-types";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Option, Session } from "../shared/model";
import { createPaseoHolder } from "./paseo-holder";
import { pauseContractText } from "./pause-contract";
import { createRoadmapCommands, UI_ORIGIN, type StoreOpener } from "./sessions";
import { openProjectStore } from "./store-root";
import { fixedClock, NOW, nextId, opt } from "./test-support/build";
import { fakeDirectory } from "./test-support/fake-dir";
import { cardText, claudeCard, codexCard, fakePaseoAgents, gate, hookAgent, type FakePaseoAgents } from "./test-support/fake-paseo-agents";
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
  PAUSE_TEXT,
  pauseSnapshot,
  PLANNER,
  seedGrilling,
  SUMMARY,
  type Cont,
} from "./test-support/grilling";
import { makeProject, ok, type TestProject } from "./test-support/service";

const load = () =>
  import("./pause").catch((e: unknown) => {
    throw new Error(`missing module server/pause.ts: ${String(e)}`);
  });

const P = "prj_test";
const T1 = NOW.toISOString();
const T2 = "2026-10-20T11:00:00.000Z";
const REQ = "permission-req-1";
const ab: Option[] = [opt("a"), opt("b")];
const OUR_ANSWER: AgentPermissionResponse = { behavior: "allow", updatedInput: { answers: { [PAUSE_TEXT]: SUMMARY, Roadmap: SUMMARY } } };

let project: TestProject | undefined;
let clock = new Date(T1);
afterEach(async () => {
  vi.useRealTimers();
  await project?.cleanup();
  project = undefined;
});

async function setup(o: { defaultDelays?: boolean; plannerStatus?: "idle" | "running"; signal?: AbortSignal } = {}) {
  const { createPauseEngine } = await load();
  clock = new Date(T1);
  project = await makeProject();
  const proj = project;
  const root = proj.root;
  const dir = fakeDirectory({ projects: [{ projectId: P, projectRootPath: root, projectKind: "git" }] });
  const storeOptions = { now: fixedClock, newId: nextId, log: (m: string, e?: unknown) => void proj.logs.push([m, e]) };
  const commands = createRoadmapCommands({ directory: () => dir, now: () => clock, newId: nextId, storeOptions });
  const open: StoreOpener = (projectId) => openProjectStore(dir, projectId, storeOptions);
  ok(await commands.init(open, { projectId: P }, UI_ORIGIN));
  const fake = fakePaseoAgents([
    { id: PLANNER, provider: "claude", cwd: root, status: o.plannerStatus ?? "running" },
    { id: OTHER_AGENT, provider: "claude", cwd: root, status: "running" },
  ]);
  const logs: string[] = [];
  const makeEngine = () =>
    need(createPauseEngine, "pause.createPauseEngine")({
      open,
      paseo: () => fake.paseo,
      directory: () => dir,
      log: (m: string) => void logs.push(m),
      now: () => clock,
      ...(o.defaultDelays === true ? {} : { retryDelaysMs: [0, 0] }),
      ...(o.signal !== undefined ? { signal: o.signal } : {}),
    });
  const engine = makeEngine();
  const revision = async () => ok(await commands.version(open, { projectId: P }, UI_ORIGIN)).revision!;
  const sessionOf = async (sessionId: string): Promise<Session> => {
    const read = await (await open(P)).read();
    if (read.status !== "ok") throw new Error(`expected an ok store, got ${read.status}`);
    const s = read.data.sessions.find((x) => x.id === sessionId);
    if (s === undefined) throw new Error(`session ${sessionId} not found`);
    return s;
  };
  /** A session with one question in blk-open and the given planner/continuation (post-Accept blocks when needed). */
  const seeded = async (c: Cont | undefined, extra: Parameters<typeof seedGrilling>[3] = {}) => {
    const sessionId = ok(await commands.sessionCreate(open, { projectId: P, expectedRevision: await revision(), title: "Grilling" }, UI_ORIGIN)).sessionId;
    ok(
      await commands.questionCreateBatch(
        open,
        { projectId: P, expectedRevision: await revision(), sessionId, blockId: BLK_OPEN, questions: [{ title: "Q", context: "", options: ab, allowFreeText: false, activatedBy: [], invalidatedBy: [] }] },
        { source: "chat", actor: { kind: "agent" } },
      ),
    );
    await seedGrilling(open, P, sessionId, {
      planner: binding(),
      ...(c !== undefined ? { continuation: c } : {}),
      ...(c !== undefined && isPostAccept(c.state) ? { blocks: blocksFor(true) } : {}),
      ...extra,
    });
    engine.remember(PLANNER, P);
    return sessionId;
  };
  const agent = (id = PLANNER) => hookAgent(id, root);
  const requested = (e: ReturnType<typeof makeEngine>, request: AgentPermissionRequest, id = PLANNER): Promise<void> => {
    const event: PluginLifecycleEvents["agent.permission_requested"] = { agent: agent(id), request };
    return e.permissionRequested(event, fake.paseo);
  };
  const resolved = (e: ReturnType<typeof makeEngine>, requestId: string, resolution: AgentPermissionResponse, id = PLANNER): Promise<void> => {
    const event: PluginLifecycleEvents["agent.permission_resolved"] = { agent: agent(id), requestId, resolution };
    return e.permissionResolved(event, fake.paseo);
  };
  const turnEnded = (e: ReturnType<typeof makeEngine>, outcome: PluginLifecycleEvents["agent.turn_ended"]["outcome"], id = PLANNER): Promise<void> => {
    const event: PluginLifecycleEvents["agent.turn_ended"] = { agent: agent(id), turnId: "turn-1", outcome, timeline: [] };
    return e.turnEnded(event, fake.paseo);
  };
  const accept = async (sessionId: string) =>
    ok(await commands.blockAccept(open, { projectId: P, sessionId, blockId: BLK_OPEN, expectedRevision: await revision() }, UI_ORIGIN));
  return { commands, open, fake, logs, engine, makeEngine, revision, sessionOf, seeded, agent, requested, resolved, turnEnded, accept, root };
}

/**
 * Waits until `cond` holds, letting real I/O (fsync'd store commits) progress between checks. Only
 * `setTimeout` is ever faked in this file, so `setImmediate` turns and the wall clock are real. The
 * deadline is a safety bound on a condition the test observes, not a timing window it relies on.
 */
async function until(cond: () => boolean | Promise<boolean>, what: string, boundMs = 10_000): Promise<void> {
  const deadline = Date.now() + boundMs;
  while (!(await cond())) {
    if (Date.now() > deadline) throw new Error(`gave up waiting for ${what}`);
    await new Promise<void>((r) => setImmediate(r));
  }
}

/** The engine never sends, runs, denies or answers anything but the exact pause request. */
function expectNoForbiddenCalls(fake: FakePaseoAgents) {
  expect(fake.calls.send, "no send").toEqual([]);
  expect(fake.calls.run, "no run").toEqual([]);
  expect(fake.calls.respond.filter((c) => c.response.behavior === "deny"), "no deny").toEqual([]);
  for (const c of fake.calls.respond) expect(c.requestId, "only the pause request is answered").toBe(REQ);
}

const ourCall = { agentId: PLANNER, requestId: REQ, response: OUR_ANSWER };

describe("a matching card before Accept", () => {
  it.each([
    ["claude", claudeCard(OP), "AskUserQuestion"],
    ["codex", codexCard(OP), "request_user_input"],
  ] as const)("%s card while awaiting_pause → paused with the request snapshot; nothing is answered", async (provider, card, name) => {
    const t = await setup();
    const sid = await t.seeded(continuationIn("awaiting_pause"));
    t.fake.show(PLANNER, card);
    clock = new Date(T2);
    await t.requested(t.engine, card);
    await t.engine.idle();
    expect((await t.sessionOf(sid)).continuation).toEqual({
      ...continuationIn("awaiting_pause"),
      state: "paused",
      pause: { requestId: REQ, provider, name, seenAt: T2, questionText: cardText(OP), header: "Roadmap", optionLabels: ["Continue", "Stop"] },
      at: T2,
    });
    expect(t.fake.calls.respond).toEqual([]);
    expectNoForbiddenCalls(t.fake);
  });

  it("a deviating card with the current token: awaiting_pause → pause_mismatch, accepted_awaiting_pause → needs_manual (pause_mismatch…); nothing answered", async () => {
    const t = await setup();
    const bundled = claudeCard(OP, { questions: [{ question: cardText(OP), header: "Roadmap", options: [{ label: "Continue" }, { label: "Stop" }] }, { question: "Extra?", header: "X", options: [{ label: "Y" }] }] });
    const a = await t.seeded(continuationIn("awaiting_pause"));
    t.fake.show(PLANNER, bundled);
    await t.requested(t.engine, bundled);
    await t.engine.idle();
    const ca = (await t.sessionOf(a)).continuation;
    expect(ca?.state).toBe("pause_mismatch");
    expect(ca?.reason?.length ?? 0).toBeGreaterThan(0);
    t.fake.drop(PLANNER, REQ);
    const b = await t.seeded(continuationIn("accepted_awaiting_pause"));
    t.fake.show(PLANNER, bundled);
    await t.requested(t.engine, bundled);
    await t.engine.idle();
    const cb = (await t.sessionOf(b)).continuation;
    expect(cb?.state).toBe("needs_manual");
    expect(cb?.reason).toMatch(/^pause_mismatch/);
    expect(t.fake.calls.respond).toEqual([]);
    expectNoForbiddenCalls(t.fake);
  });
});

describe("requests that are never ours: no write, no answer", () => {
  it("a previous operation's card is ignored and logged as stale_operation", async () => {
    const t = await setup();
    const sid = await t.seeded(continuationIn("accepted_awaiting_pause"));
    const old = claudeCard("op-old");
    t.fake.show(PLANNER, old);
    const before = { rev: await t.revision(), fields: grillingFields(await t.sessionOf(sid)) };
    await t.requested(t.engine, old);
    await t.engine.idle();
    expect(await t.revision()).toBe(before.rev);
    expect(grillingFields(await t.sessionOf(sid))).toBe(before.fields);
    expect(t.logs.join("\n")).toContain("stale_operation");
    expect(t.fake.calls.respond).toEqual([]);
  });

  it("tool/plan/mode/other kinds, another agent's exact card, the async Codex card and another plugin's question are ignored", async () => {
    const t = await setup();
    const sid = await t.seeded(continuationIn("accepted_awaiting_pause"));
    const before = { rev: await t.revision(), fields: grillingFields(await t.sessionOf(sid)) };
    const bash: AgentPermissionRequest = { id: "perm-bash", provider: "claude", name: "Bash", kind: "tool", input: { command: "ls" } };
    const otherPlugin = claudeCard(OP, { requestId: "perm-other", questions: [{ question: "Pick a colour", header: "Colour", options: [{ label: "Red" }, { label: "Blue" }] }] });
    for (const kind of ["tool", "plan", "mode", "other"] as const) await t.requested(t.engine, { ...claudeCard(OP), kind });
    await t.requested(t.engine, bash);
    await t.requested(t.engine, otherPlugin);
    await t.requested(t.engine, codexCard(OP, { name: "request_user_input_async" }));
    await t.requested(t.engine, claudeCard(OP), OTHER_AGENT);
    await t.engine.idle();
    expect(await t.revision()).toBe(before.rev);
    expect(grillingFields(await t.sessionOf(sid))).toBe(before.fields);
    expect(t.fake.calls.respond).toEqual([]);
    expectNoForbiddenCalls(t.fake);
  });
});

describe("the answer after Accept", () => {
  it("Accept while paused, then afterAccept: one answer with the summary keyed by the snapshot, claimed before the call, then resumed (plugin)", async () => {
    const t = await setup();
    const sid = await t.seeded(continuationIn("paused"));
    t.fake.show(PLANNER, claudeCard(OP));
    await t.accept(sid);
    const summary = (await t.sessionOf(sid)).continuation?.summary ?? "";
    expect((await t.sessionOf(sid)).continuation).toMatchObject({ state: "resolving", attempts: 1 });
    const atCall: Array<Cont | undefined> = [];
    t.fake.script.beforeRespond = async () => void atCall.push((await t.sessionOf(sid)).continuation);
    clock = new Date(T2);
    await t.engine.afterAccept({ projectId: P, sessionId: sid, operationId: OP });
    await t.engine.idle();
    expect(t.fake.calls.respond).toEqual([{ agentId: PLANNER, requestId: REQ, response: { behavior: "allow", updatedInput: { answers: { [PAUSE_TEXT]: summary, Roadmap: summary } } } }]);
    expect(atCall.map((c) => [c?.state, c?.attempts])).toEqual([["resolving", 1]]);
    const c = (await t.sessionOf(sid)).continuation;
    expect(c).toMatchObject({ state: "resumed", attempts: 1, resolution: { behavior: "allow", source: "plugin" } });
    expectNoForbiddenCalls(t.fake);
  });

  it("Accept before the card (accepted_awaiting_pause): the matching card is claimed (attempt 1) and answered once, then resumed", async () => {
    const t = await setup();
    const sid = await t.seeded(continuationIn("accepted_awaiting_pause"));
    t.fake.show(PLANNER, claudeCard(OP));
    const atCall: Array<Cont | undefined> = [];
    t.fake.script.beforeRespond = async () => void atCall.push((await t.sessionOf(sid)).continuation);
    await t.requested(t.engine, claudeCard(OP));
    await t.engine.idle();
    expect(t.fake.calls.respond).toEqual([ourCall]);
    expect(atCall.map((c) => [c?.state, c?.attempts, c?.pause?.requestId])).toEqual([["resolving", 1, REQ]]);
    expect((await t.sessionOf(sid)).continuation).toMatchObject({ state: "resumed", attempts: 1, resolution: { behavior: "allow", source: "plugin" } });
    await t.engine.reconcileAll(t.fake.paseo);
    await t.engine.idle();
    expect(t.fake.calls.respond).toHaveLength(1);
    expectNoForbiddenCalls(t.fake);
  });

  it("a Codex card is answered with the Codex snapshot's exact question text and header (TR2)", async () => {
    const t = await setup();
    const sid = await t.seeded(continuationIn("accepted_awaiting_pause"));
    t.fake.show(PLANNER, codexCard(OP));
    await t.requested(t.engine, codexCard(OP));
    await t.engine.idle();
    expect(t.fake.calls.respond).toEqual([ourCall]);
    expect((await t.sessionOf(sid)).continuation?.state).toBe("resumed");
  });

  it("the full flow: card seen while awaiting, Accept, afterAccept → one answer → resumed; a later reconcile answers nothing", async () => {
    const t = await setup();
    const sid = await t.seeded(continuationIn("awaiting_pause"));
    t.fake.show(PLANNER, claudeCard(OP));
    await t.requested(t.engine, claudeCard(OP));
    await t.engine.idle();
    expect((await t.sessionOf(sid)).continuation?.state).toBe("paused");
    await t.accept(sid);
    await t.engine.afterAccept({ projectId: P, sessionId: sid, operationId: OP });
    await t.engine.idle();
    await t.engine.reconcileAll(t.fake.paseo);
    await t.engine.idle();
    expect(t.fake.calls.respond).toHaveLength(1);
    expect((await t.sessionOf(sid)).continuation?.state).toBe("resumed");
    expectNoForbiddenCalls(t.fake);
  });
});

describe("a failing answer call (TR10)", () => {
  it("the request stays pending: three calls in total, each claimed first, then needs_manual (answer_failed)", async () => {
    const t = await setup();
    const sid = await t.seeded(continuationIn("accepted_awaiting_pause"));
    t.fake.show(PLANNER, claudeCard(OP));
    t.fake.script.respondFailures.set(PLANNER, 10);
    const attemptsAtCall: number[] = [];
    t.fake.script.beforeRespond = async () => void attemptsAtCall.push((await t.sessionOf(sid)).continuation?.attempts ?? -1);
    await t.requested(t.engine, claudeCard(OP));
    await t.engine.idle();
    expect(t.fake.calls.respond).toHaveLength(3);
    expect(attemptsAtCall).toEqual([1, 2, 3]);
    expect((await t.sessionOf(sid)).continuation).toMatchObject({ state: "needs_manual", reason: "answer_failed", attempts: 3 });
    expectNoForbiddenCalls(t.fake);
  });

  it("one transport failure, then success: two calls, resumed with attempts 2", async () => {
    const t = await setup();
    const sid = await t.seeded(continuationIn("accepted_awaiting_pause"));
    t.fake.show(PLANNER, claudeCard(OP));
    t.fake.script.respondFailures.set(PLANNER, 1);
    await t.requested(t.engine, claudeCard(OP));
    await t.engine.idle();
    expect(t.fake.calls.respond).toHaveLength(2);
    expect((await t.sessionOf(sid)).continuation).toMatchObject({ state: "resumed", attempts: 2, resolution: { source: "plugin" } });
  });

  it("the retries wait 1 s and then 3 s by default (fake timers, no real waits)", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const stop = new AbortController();
    const t = await setup({ defaultDelays: true, signal: stop.signal });
    try {
      const sid = await t.seeded(continuationIn("accepted_awaiting_pause"));
      t.fake.show(PLANNER, claudeCard(OP));
      t.fake.script.respondFailures.set(PLANNER, 10);
      // Observed, not timed: call n reached the host, the decision read after it is done, and the
      // only pending timer is the retry wait (each bounded host call clears its own timer).
      const retryScheduled = (n: number) =>
        until(() => t.fake.calls.respond.length === n && t.fake.calls.refresh.length >= n && vi.getTimerCount() === 1, `retry timer after call ${n}`);
      void t.requested(t.engine, claudeCard(OP));
      await retryScheduled(1);
      await vi.advanceTimersByTimeAsync(999);
      expect(t.fake.calls.respond).toHaveLength(1);
      expect(vi.getTimerCount(), "the 1 s wait has not fired at 999 ms").toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      await until(() => t.fake.calls.respond.length === 2, "call 2 after 1000 ms");
      await retryScheduled(2);
      await vi.advanceTimersByTimeAsync(2999);
      expect(t.fake.calls.respond).toHaveLength(2);
      expect(vi.getTimerCount(), "the 3 s wait has not fired at 2999 ms").toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      await until(() => t.fake.calls.respond.length === 3, "call 3 after 3000 ms");
      await until(async () => (await t.sessionOf(sid)).continuation?.state === "needs_manual", "needs_manual after the third failure");
      await vi.advanceTimersByTimeAsync(10_000);
      expect(t.fake.calls.respond).toHaveLength(3);
      expect(vi.getTimerCount(), "no retry is scheduled after the cap").toBe(0);
      expect((await t.sessionOf(sid)).continuation).toMatchObject({ state: "needs_manual", reason: "answer_failed", attempts: 3 });
    } finally {
      stop.abort();
      vi.useRealTimers();
      await t.engine.idle();
    }
  });

  it("the request is gone and no resolution was recorded: unknown, with no further call", async () => {
    const t = await setup();
    const sid = await t.seeded(continuationIn("paused"));
    await t.accept(sid);
    // The host no longer has the request (never shown here): the answer is rejected as not pending.
    await t.engine.afterAccept({ projectId: P, sessionId: sid, operationId: OP });
    await t.engine.idle();
    expect(t.fake.calls.respond).toHaveLength(1);
    expect((await t.sessionOf(sid)).continuation?.state).toBe("unknown");
  });

  it("a late acknowledgement is fenced: the plugin's own resolution arrives first (resumed), then the call fails; no rewrite, no retry", async () => {
    const t = await setup();
    const sid = await t.seeded(continuationIn("accepted_awaiting_pause"));
    t.fake.show(PLANNER, claudeCard(OP));
    let hook: Promise<void> | undefined;
    t.fake.script.afterRespond = (call) => {
      hook = t.resolved(t.engine, call.requestId, call.response);
      throw new Error("synthetic transport failure after the host applied the answer");
    };
    await t.requested(t.engine, claudeCard(OP));
    await t.engine.idle();
    await hook;
    await t.engine.idle();
    expect(t.fake.calls.respond).toHaveLength(1);
    expect((await t.sessionOf(sid)).continuation).toMatchObject({ state: "resumed", attempts: 1, resolution: { behavior: "allow", source: "plugin" } });
  });
});

describe("resolution events (TR4)", () => {
  it.each([
    ["a host deny (the owner typed)", { behavior: "deny", message: "answered with a message instead" } as AgentPermissionResponse, "deny"],
    ["someone else's allow", { behavior: "allow", updatedInput: { answers: { [PAUSE_TEXT]: "Continue" } } } as AgentPermissionResponse, "allow"],
  ] as const)("%s for the paused request → pause_answered_externally (external)", async (_name, resolution, behavior) => {
    const t = await setup();
    const sid = await t.seeded(continuationIn("paused"));
    clock = new Date(T2);
    await t.resolved(t.engine, REQ, resolution);
    await t.engine.idle();
    expect((await t.sessionOf(sid)).continuation).toMatchObject({ state: "pause_answered_externally", resolution: { behavior, at: T2, source: "external" } });
    expect(t.fake.calls.respond).toEqual([]);
  });

  it("a resolution of another request id changes nothing", async () => {
    const t = await setup();
    const sid = await t.seeded(continuationIn("paused"));
    const before = grillingFields(await t.sessionOf(sid));
    await t.resolved(t.engine, "perm-other", { behavior: "deny" });
    await t.engine.idle();
    expect(grillingFields(await t.sessionOf(sid))).toBe(before);
  });

  it("while resolving: our summary → resumed (plugin); another allow → pause_answered_externally (external); a deny → pause_answered_externally", async () => {
    const t = await setup();
    const a = await t.seeded(continuationIn("resolving"));
    await t.resolved(t.engine, REQ, OUR_ANSWER);
    await t.engine.idle();
    expect((await t.sessionOf(a)).continuation).toMatchObject({ state: "resumed", resolution: { behavior: "allow", source: "plugin" } });
    const b = await t.seeded(continuationIn("resolving"));
    await t.resolved(t.engine, REQ, { behavior: "allow", updatedInput: { answers: { Roadmap: "Stop" } } });
    await t.engine.idle();
    expect((await t.sessionOf(b)).continuation).toMatchObject({ state: "pause_answered_externally", resolution: { behavior: "allow", source: "external" } });
    const c = await t.seeded(continuationIn("resolving"));
    await t.resolved(t.engine, REQ, { behavior: "deny" });
    await t.engine.idle();
    expect((await t.sessionOf(c)).continuation).toMatchObject({ state: "pause_answered_externally", resolution: { behavior: "deny" } });
    expect(t.fake.calls.respond).toEqual([]);
  });

  it("while resolving: an allow without readable answers is recorded as the host's and the state stays resolving", async () => {
    const t = await setup();
    const sid = await t.seeded(continuationIn("resolving"));
    clock = new Date(T2);
    await t.resolved(t.engine, REQ, { behavior: "allow" });
    await t.engine.idle();
    expect((await t.sessionOf(sid)).continuation).toMatchObject({ state: "resolving", resolution: { behavior: "allow", at: T2, source: "host" } });
  });
});

describe("turn end, archive and close", () => {
  it("turn_ended: awaiting_pause → pause_lost (no_pause); accepted_awaiting_pause → needs_manual (no_pause); another agent's turn changes nothing", async () => {
    const t = await setup();
    const a = await t.seeded(continuationIn("awaiting_pause"));
    const before = grillingFields(await t.sessionOf(a));
    await t.turnEnded(t.engine, { kind: "completed" }, OTHER_AGENT);
    await t.engine.idle();
    expect(grillingFields(await t.sessionOf(a))).toBe(before);
    await t.turnEnded(t.engine, { kind: "completed" });
    await t.engine.idle();
    expect((await t.sessionOf(a)).continuation).toMatchObject({ state: "pause_lost", reason: "no_pause" });
    const b = await t.seeded(continuationIn("accepted_awaiting_pause"));
    await t.turnEnded(t.engine, { kind: "completed" });
    await t.engine.idle();
    expect((await t.sessionOf(b)).continuation).toMatchObject({ state: "needs_manual", reason: "no_pause" });
    expect(t.fake.calls.respond).toEqual([]);
  });

  it("turn_ended while paused: a still-pending request keeps paused; a vanished one is pause_lost with a turn_ended reason", async () => {
    const t = await setup();
    const kept = await t.seeded(continuationIn("paused"));
    t.fake.show(PLANNER, claudeCard(OP));
    const before = grillingFields(await t.sessionOf(kept));
    await t.turnEnded(t.engine, { kind: "completed" });
    await t.engine.idle();
    expect(grillingFields(await t.sessionOf(kept))).toBe(before);
    t.fake.drop(PLANNER, REQ);
    await t.turnEnded(t.engine, { kind: "canceled", reason: "host restart" });
    await t.engine.idle();
    const c = (await t.sessionOf(kept)).continuation;
    expect(c?.state).toBe("pause_lost");
    expect(c?.reason).toMatch(/turn_ended/);
    expect(t.fake.calls.respond).toEqual([]);
  });

  it.each([
    ["archived", "archived"],
    ["closed", "closed"],
  ] as const)("%s planner: every live operation becomes pause_lost (%s); a terminal one is untouched", async (why, reason) => {
    const t = await setup();
    const live: Array<[string, string]> = [];
    for (const state of ["awaiting_pause", "paused", "accepted_awaiting_pause", "resolving"] as const) live.push([state, await t.seeded(continuationIn(state))]);
    const done = await t.seeded(continuationIn("resumed"));
    const doneBefore = grillingFields(await t.sessionOf(done));
    await t.engine.agentGone({ agent: t.agent() }, why, t.fake.paseo);
    await t.engine.idle();
    for (const [state, sid] of live) expect((await t.sessionOf(sid)).continuation, state).toMatchObject({ state: "pause_lost", reason });
    expect(grillingFields(await t.sessionOf(done))).toBe(doneBefore);
    expect(t.fake.calls.respond).toEqual([]);
  });
});

describe("afterAccept and reconciliation (reload, restart)", () => {
  it("afterAccept with Accept before the card: a pending card is claimed and answered; an idle planner without a card → needs_manual (no_pause); a running one waits", async () => {
    const t = await setup();
    const withCard = await t.seeded(continuationIn("accepted_awaiting_pause"));
    t.fake.show(PLANNER, claudeCard(OP));
    await t.engine.afterAccept({ projectId: P, sessionId: withCard, operationId: OP });
    await t.engine.idle();
    expect(t.fake.calls.respond).toEqual([ourCall]);
    expect((await t.sessionOf(withCard)).continuation?.state).toBe("resumed");

    const running = await t.seeded(continuationIn("accepted_awaiting_pause"));
    const before = grillingFields(await t.sessionOf(running));
    await t.engine.afterAccept({ projectId: P, sessionId: running, operationId: OP });
    await t.engine.idle();
    expect(grillingFields(await t.sessionOf(running))).toBe(before);

    const planner = t.fake.agents.get(PLANNER);
    if (planner) planner.status = "idle";
    const idle = await t.seeded(continuationIn("accepted_awaiting_pause"));
    await t.engine.afterAccept({ projectId: P, sessionId: idle, operationId: OP });
    await t.engine.idle();
    expect((await t.sessionOf(idle)).continuation).toMatchObject({ state: "needs_manual", reason: "no_pause" });
    expect(t.fake.calls.respond).toHaveLength(1);
  });

  it("a fresh engine's reconcileAll: awaiting with the card pending → paused; paused still pending → kept; paused gone → pause_lost (restart)", async () => {
    const t = await setup();
    const awaiting = await t.seeded(continuationIn("awaiting_pause"));
    t.fake.show(PLANNER, claudeCard(OP));
    const engine = t.makeEngine();
    await engine.reconcileAll(t.fake.paseo);
    await engine.idle();
    expect((await t.sessionOf(awaiting)).continuation).toMatchObject({ state: "paused", pause: { requestId: REQ, questionText: PAUSE_TEXT } });

    const kept = await t.seeded(continuationIn("paused"));
    const keptBefore = grillingFields(await t.sessionOf(kept));
    const second = t.makeEngine();
    await second.reconcileAll(t.fake.paseo);
    await second.idle();
    expect(grillingFields(await t.sessionOf(kept))).toBe(keptBefore);

    t.fake.drop(PLANNER, REQ);
    const fresh = t.makeEngine();
    await fresh.reconcileAll(t.fake.paseo);
    await fresh.idle();
    expect((await t.sessionOf(kept)).continuation).toMatchObject({ state: "pause_lost", reason: "restart" });
    expect(t.fake.calls.respond).toEqual([]);
  });

  it("crash after the claim: resolving with the request still pending → exactly one more call (attempt 2) → resumed", async () => {
    const t = await setup();
    const sid = await t.seeded(continuationIn("resolving"));
    t.fake.show(PLANNER, claudeCard(OP));
    const engine = t.makeEngine();
    await engine.reconcileAll(t.fake.paseo);
    await engine.idle();
    expect(t.fake.calls.respond).toEqual([ourCall]);
    expect((await t.sessionOf(sid)).continuation).toMatchObject({ state: "resumed", attempts: 2 });
  });

  it("reconcile caps the calls: resolving at attempts 3 with the request pending → needs_manual (answer_failed), no call", async () => {
    const t = await setup();
    const sid = await t.seeded(continuationIn("resolving", { attempts: 3 }));
    t.fake.show(PLANNER, claudeCard(OP));
    const engine = t.makeEngine();
    await engine.reconcileAll(t.fake.paseo);
    await engine.idle();
    expect(t.fake.calls.respond).toEqual([]);
    expect((await t.sessionOf(sid)).continuation).toMatchObject({ state: "needs_manual", reason: "answer_failed", attempts: 3 });
  });

  it("resolving with the request gone: a recorded plugin resolution → resumed; none → unknown (the outcome stays visible)", async () => {
    const t = await setup();
    const confirmed = await t.seeded(continuationIn("resolving", { resolution: { behavior: "allow", at: T1, source: "plugin" } }));
    const unconfirmed = await t.seeded(continuationIn("resolving"));
    const engine = t.makeEngine();
    await engine.reconcileAll(t.fake.paseo);
    await engine.idle();
    expect((await t.sessionOf(confirmed)).continuation?.state).toBe("resumed");
    expect((await t.sessionOf(unconfirmed)).continuation?.state).toBe("unknown");
    expect(t.fake.calls.respond).toEqual([]);
  });
});

describe("races and fencing (TR16)", () => {
  it("the hook and a reconcile racing on the same pending card answer it once", async () => {
    const t = await setup();
    const sid = await t.seeded(continuationIn("accepted_awaiting_pause"));
    t.fake.show(PLANNER, claudeCard(OP));
    await Promise.all([t.requested(t.engine, claudeCard(OP)), t.engine.reconcileAll(t.fake.paseo)]);
    await t.engine.idle();
    expect(t.fake.calls.respond).toEqual([ourCall]);
    expect((await t.sessionOf(sid)).continuation).toMatchObject({ state: "resumed", attempts: 1 });
  });

  it("two engines (two processes after a reload) reconciling the same pending claim make exactly one more call", async () => {
    const t = await setup();
    const sid = await t.seeded(continuationIn("resolving"));
    t.fake.show(PLANNER, claudeCard(OP));
    const e1 = t.makeEngine();
    const e2 = t.makeEngine();
    await Promise.all([e1.reconcileAll(t.fake.paseo), e2.reconcileAll(t.fake.paseo)]);
    await Promise.all([e1.idle(), e2.idle()]);
    expect(t.fake.calls.respond).toEqual([ourCall]);
    expect((await t.sessionOf(sid)).continuation).toMatchObject({ state: "resumed", attempts: 2 });
  });

  it("a rebind supersedes the operation: the old planner's card is never answered by the hook or a reconcile", async () => {
    const t = await setup();
    const sid = await t.seeded(continuationIn("accepted_awaiting_pause"));
    need(t.commands.plannerSet, "plannerSet");
    ok(await t.commands.plannerSet(t.open, { projectId: P, sessionId: sid, expectedRevision: await t.revision(), agentId: OTHER_AGENT, workspaceId: null }, UI_ORIGIN));
    const after = grillingFields(await t.sessionOf(sid));
    expect(after).toContain("superseded");
    t.fake.show(PLANNER, claudeCard(OP));
    await t.requested(t.engine, claudeCard(OP));
    await t.engine.reconcileAll(t.fake.paseo);
    await t.engine.idle();
    expect(t.fake.calls.respond).toEqual([]);
    expect(grillingFields(await t.sessionOf(sid))).toBe(after);
  });

  it("an ordinary answer after the card was seen wakes nothing: no call, the operation stays paused", async () => {
    const t = await setup();
    const sid = await t.seeded(continuationIn("paused"));
    t.fake.show(PLANNER, claudeCard(OP));
    const qid = (await t.sessionOf(sid)).questions[0].id;
    ok(await t.commands.questionAnswer(t.open, { projectId: P, expectedRevision: await t.revision(), sessionId: sid, questionId: qid, optionId: "a" }, UI_ORIGIN));
    await t.engine.reconcileAll(t.fake.paseo);
    await t.engine.idle();
    expect(t.fake.calls.respond).toEqual([]);
    expect((await t.sessionOf(sid)).continuation?.state).toBe("paused");
  });
});

// Root review of the S2 engine (2026-11-01, concerns A–C): retry only on an observed pending card,
// fence every new call after a wait, and give the planner's next batch an operation for its new block.
describe("race contract (root concerns A–C)", () => {
  it("A: after a failed answer, a failed host read never claims or calls again; the outcome stays visible and is never resumed", async () => {
    const t = await setup();
    const sid = await t.seeded(continuationIn("accepted_awaiting_pause"));
    t.fake.show(PLANNER, claudeCard(OP));
    t.fake.script.respondFailures.set(PLANNER, 10);
    // From the first call on, the host cannot be read (a throw; a timeout is the same failed read).
    t.fake.script.beforeRespond = () => void t.fake.script.refreshRejects.set(PLANNER, new Error("synthetic host read failure"));
    await t.requested(t.engine, claudeCard(OP));
    await t.engine.idle();
    expect(t.fake.calls.respond, "no call without an observed pending card").toHaveLength(1);
    const c = (await t.sessionOf(sid)).continuation;
    expect(c?.attempts, "no new claim").toBe(1);
    expect(["unknown", "needs_manual"]).toContain(c?.state);
    expectNoForbiddenCalls(t.fake);
  });

  it("B: a rebind while the retry wait is pending prevents any new call to the old card; superseded and the new binding stay", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const stop = new AbortController();
    const t = await setup({ defaultDelays: true, signal: stop.signal });
    try {
      const sid = await t.seeded(continuationIn("accepted_awaiting_pause"));
      t.fake.show(PLANNER, claudeCard(OP));
      t.fake.script.respondFailures.set(PLANNER, 1);
      void t.requested(t.engine, claudeCard(OP));
      // The window under test: call 1 failed, the claim of attempt 2 is committed, the 1 s retry wait is pending.
      await until(
        async () => t.fake.calls.respond.length === 1 && vi.getTimerCount() === 1 && (await t.sessionOf(sid)).continuation?.attempts === 2,
        "the committed claim of attempt 2 with its retry wait pending",
      );
      need(t.commands.plannerSet, "plannerSet");
      ok(await t.commands.plannerSet(t.open, { projectId: P, sessionId: sid, expectedRevision: await t.revision(), agentId: OTHER_AGENT, workspaceId: "ws-2" }, UI_ORIGIN));
      const after = await t.sessionOf(sid);
      expect(after.continuation?.state).toBe("superseded");
      await vi.advanceTimersByTimeAsync(1000);
      stop.abort();
      vi.useRealTimers();
      await t.engine.idle();
      expect(t.fake.calls.respond, "no new call to the old card after the rebind").toHaveLength(1);
      expect(t.fake.agents.get(PLANNER)?.pending.map((r) => r.id), "the old card is left to the owner").toEqual([REQ]);
      const s = await t.sessionOf(sid);
      expect(grillingFields(s)).toBe(grillingFields(after));
      expect(s.planner).toMatchObject({ agentId: OTHER_AGENT, workspaceId: "ws-2", boundBy: "ui", epoch: 2 });
    } finally {
      stop.abort();
      vi.useRealTimers();
      await t.engine.idle();
    }
  });

  it("C: the planner's next batch after its card was delivered but before the plugin saw the acknowledgement gets an operation for the new open block", async () => {
    const t = await setup();
    const sid = await t.seeded(continuationIn("paused"));
    t.fake.show(PLANNER, claudeCard(OP));
    const accepted = await t.accept(sid);
    expect((await t.sessionOf(sid)).continuation).toMatchObject({ state: "resolving", openBlockId: BLK_OPEN });
    // The host applied the answer and the planner resumed: its next batch reaches the plugin while the
    // answer call's acknowledgement is still held (the plugin has not recorded the outcome yet).
    let batch: Awaited<ReturnType<typeof t.commands.questionCreateBatch>> | undefined;
    t.fake.script.afterRespond = async () => {
      batch = await t.commands.questionCreateBatch(
        t.open,
        {
          projectId: P,
          expectedRevision: await t.revision(),
          sessionId: sid,
          blockId: accepted.nextBlockId,
          questions: [{ title: "Next", context: "", options: ab, allowFreeText: false, activatedBy: [], invalidatedBy: [] }],
        },
        { source: "chat", actor: { kind: "agent", agentId: PLANNER } },
        { agentId: PLANNER, workspaceId: "ws-1" },
      );
    };
    await t.engine.afterAccept({ projectId: P, sessionId: sid, operationId: OP });
    await t.engine.idle();
    expect(t.fake.calls.respond.map((c) => c.requestId), "the card was answered once").toEqual([REQ]);
    const value = batch !== undefined && batch.ok ? batch.value : undefined;
    expect(value, "the planner's batch was written").toBeDefined();
    const g = value?.grilling;
    expect(g?.operationId, "a new operation, not the one being answered").not.toBe(OP);
    expect(g?.instructions).toBe(pauseContractText({ openBlockId: accepted.nextBlockId, operationId: g?.operationId ?? "" }));
    const s = await t.sessionOf(sid);
    expect(s.continuation).toMatchObject({ operationId: g?.operationId, openBlockId: accepted.nextBlockId, state: "awaiting_pause", target: { agentId: PLANNER, epoch: 1 }, attempts: 0 });
    expect(s.continuations?.map((c) => c.operationId), "the answered operation is kept in the history").toContain(OP);
    expectNoForbiddenCalls(t.fake);
  });
});

// S2 KensAI review (session 01a198b2): c8 shutdown drain and c22 the canonical event settling `unknown`.
describe("S2 KensAI c8 and c22", () => {
  it("c8: after abort, idle() also covers a reconcile started directly (as the host-context subscriber does); once idle resolves no new host call or store write follows", async () => {
    const stop = new AbortController();
    const t = await setup({ signal: stop.signal });
    await t.seeded(continuationIn("accepted_awaiting_pause"));
    t.fake.show(PLANNER, claudeCard(OP));
    const held = gate();
    t.fake.script.refreshGate.set(PLANNER, held.promise);
    // Started without awaiting, like `holder.subscribe((p) => void engine.reconcileAll(p))` in the index.
    const reconcile = t.engine.reconcileAll(t.fake.paseo);
    await until(() => t.fake.calls.refresh.length === 1, "the reconcile's host read in flight");
    stop.abort();
    const cleanup = t.engine.idle();
    held.release();
    await cleanup;
    const atCleanup = { respond: t.fake.calls.respond.length, revision: await t.revision() };
    await reconcile;
    await t.engine.idle();
    expect(t.fake.calls.respond.length, "no new host call after cleanup resolved").toBe(atCleanup.respond);
    expect(await t.revision(), "no store write after cleanup resolved").toBe(atCleanup.revision);
    expectNoForbiddenCalls(t.fake);
  });

  it("c22: the canonical resolution of the operation's own card settles unknown: our summary → resumed (plugin); a deny → pause_answered_externally", async () => {
    const t = await setup();
    const ours = await t.seeded(continuationIn("unknown"));
    await t.resolved(t.engine, REQ, OUR_ANSWER);
    await t.engine.idle();
    expect((await t.sessionOf(ours)).continuation).toMatchObject({ state: "resumed", resolution: { behavior: "allow", source: "plugin" } });
    const denied = await t.seeded(continuationIn("unknown"));
    await t.resolved(t.engine, REQ, { behavior: "deny" });
    await t.engine.idle();
    expect((await t.sessionOf(denied)).continuation).toMatchObject({ state: "pause_answered_externally", resolution: { behavior: "deny" } });
    expect(t.fake.calls.respond).toEqual([]);
  });
});

// S2 successor KensAI review (session 01a198e0): c50, c55, c59 and c60.
describe("S2 successor KensAI c50, c55, c59, c60", () => {
  it("c50: a reconcile already running when the engine is aborted opens no further project store (each open reaches the host's project list)", async () => {
    const { createPauseEngine } = await load();
    const stop = new AbortController();
    const t = await setup();
    await t.seeded(continuationIn("accepted_awaiting_pause"));
    t.fake.show(PLANNER, claudeCard(OP));
    // A second registered project after the one holding the live operation.
    const { mkdtemp, realpath } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const root2 = await realpath(await mkdtemp(join(tmpdir(), "dr-pause-two-")));
    const dir = fakeDirectory({
      projects: [
        { projectId: P, projectRootPath: t.root, projectKind: "git" },
        { projectId: "prj_two", projectRootPath: root2, projectKind: "git" },
      ],
    });
    await (await openProjectStore(dir, "prj_two")).init();
    const opened: Array<{ projectId: string; afterAbort: boolean }> = [];
    const engine = createPauseEngine({
      open: (projectId) => (opened.push({ projectId, afterAbort: stop.signal.aborted }), openProjectStore(dir, projectId)),
      paseo: () => t.fake.paseo,
      directory: () => dir,
      log: () => undefined,
      retryDelaysMs: [0, 0],
      signal: stop.signal,
    });
    const held = gate();
    t.fake.script.refreshGate.set(PLANNER, held.promise);
    const reconcile = engine.reconcileAll(t.fake.paseo);
    await until(() => t.fake.calls.refresh.length === 1, "the reconcile blocked in the first project's agent read");
    stop.abort();
    held.release();
    await reconcile;
    await engine.idle();
    const { rm } = await import("node:fs/promises");
    await rm(root2, { recursive: true, force: true });
    expect(opened.filter((o) => o.afterAbort), "no project store opened after the abort").toEqual([]);
    expect(t.fake.calls.respond).toEqual([]);
  });

  it("c55: an abort while a retry wait is pending ends the chain at once: idle() resolves without the timer firing and no further call follows", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const stop = new AbortController();
    const t = await setup({ defaultDelays: true, signal: stop.signal });
    try {
      await t.seeded(continuationIn("accepted_awaiting_pause"));
      t.fake.show(PLANNER, claudeCard(OP));
      t.fake.script.respondFailures.set(PLANNER, 10);
      void t.requested(t.engine, claudeCard(OP));
      await until(() => t.fake.calls.respond.length === 1 && t.fake.calls.refresh.length >= 1 && vi.getTimerCount() === 1, "the 1 s retry wait after call 1");
      stop.abort();
      let idle = false;
      void t.engine.idle().then(() => {
        idle = true;
      });
      await until(() => idle, "idle() after the abort, without advancing the fake clock", 2000);
      expect(t.fake.calls.respond).toHaveLength(1);
      expect(vi.getTimerCount(), "the retry timer was cleared").toBe(0);
    } finally {
      stop.abort();
      vi.useRealTimers();
      await t.engine.idle();
    }
  });

  it.each([
    ["awaiting_pause", "pause_mismatch", /./],
    ["accepted_awaiting_pause", "needs_manual", /^pause_mismatch/],
  ] as const)("c59: a reconcile that finds this operation's own-token card deviating records %s → %s (as the hook path does)", async (state, expected, reason) => {
    const t = await setup();
    const sid = await t.seeded(continuationIn(state));
    const bundled = claudeCard(OP, {
      questions: [
        { question: cardText(OP), header: "Roadmap", options: [{ label: "Continue" }, { label: "Stop" }] },
        { question: "Extra?", header: "X", options: [{ label: "Y" }] },
      ],
    });
    t.fake.show(PLANNER, bundled);
    const engine = t.makeEngine();
    await engine.reconcileAll(t.fake.paseo);
    await engine.idle();
    const c = (await t.sessionOf(sid)).continuation;
    expect(c?.state).toBe(expected);
    expect(c?.reason ?? "").toMatch(reason);
    expect(t.fake.calls.respond).toEqual([]);
  });

  it("c60: after the abort, idle() still waits for an answer call already in flight; once it settles nothing is written (no outcome, no retry)", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const stop = new AbortController();
    const t = await setup({ signal: stop.signal });
    const held = gate();
    try {
      const sid = await t.seeded(continuationIn("accepted_awaiting_pause"));
      t.fake.show(PLANNER, claudeCard(OP));
      t.fake.script.beforeRespond = () => held.promise;
      void t.requested(t.engine, claudeCard(OP));
      await until(() => t.fake.calls.respond.length === 1, "the answer call in flight");
      const atAbort = await t.revision();
      stop.abort();
      let idle = false;
      void t.engine.idle().then(() => {
        idle = true;
      });
      // The current escape is pure microtasks; these real turns are ample for it to show.
      for (let i = 0; i < 50; i++) await new Promise<void>((r) => setImmediate(r));
      expect(idle, "idle() waits for the call that was already issued").toBe(false);
      held.release();
      await until(() => idle, "idle() once the in-flight call settled");
      expect(t.fake.calls.respond).toHaveLength(1);
      expect(await t.revision(), "no store write after the abort").toBe(atAbort);
      expect((await t.sessionOf(sid)).continuation).toMatchObject({ state: "resolving", attempts: 1 });
    } finally {
      held.release();
      stop.abort();
      vi.useRealTimers();
      await t.engine.idle();
    }
  });

  it("c60: an in-flight answer call that never settles still holds idle() only up to the 30 s host-call bound, which the abort does not cancel", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const stop = new AbortController();
    const t = await setup({ signal: stop.signal });
    const never = gate();
    try {
      const sid = await t.seeded(continuationIn("accepted_awaiting_pause"));
      t.fake.show(PLANNER, claudeCard(OP));
      t.fake.script.beforeRespond = () => never.promise;
      void t.requested(t.engine, claudeCard(OP));
      await until(() => t.fake.calls.respond.length === 1, "the answer call in flight");
      const atAbort = await t.revision();
      stop.abort();
      let idle = false;
      void t.engine.idle().then(() => {
        idle = true;
      });
      await vi.advanceTimersByTimeAsync(29_999);
      for (let i = 0; i < 50; i++) await new Promise<void>((r) => setImmediate(r));
      expect(idle, "still bounded by the host-call timeout at 29 999 ms").toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await until(() => idle, "idle() at the 30 s bound");
      expect(t.fake.calls.respond).toHaveLength(1);
      expect(await t.revision(), "no store write after the abort").toBe(atAbort);
      expect((await t.sessionOf(sid)).continuation).toMatchObject({ state: "resolving", attempts: 1 });
    } finally {
      never.release();
      stop.abort();
      vi.useRealTimers();
      await t.engine.idle();
    }
  });
});

// S2 corrected KensAI review (session 01a19904): c79 and c81.
describe("S2 corrected KensAI c79 and c81", () => {
  it("c79: a UI rebind that commits while the answer chain's fence read is in flight is seen: the old planner's card is not answered after the rebind committed", async () => {
    const { createPauseEngine } = await load();
    const { nodeStoreFs } = await import("./fs-port");
    const t = await setup();
    const sid = await t.seeded(continuationIn("paused"));
    t.fake.show(PLANNER, claudeCard(OP));
    await t.accept(sid);
    expect((await t.sessionOf(sid)).continuation).toMatchObject({ state: "resolving", attempts: 1 });
    // Narrow test-owned StoreFs wrapper: the engine's 2nd manifest read (with the current engine,
    // afterAccept's read is the 1st and the answer chain's fence read the 2nd; that fence is now admit) returns
    // the manifest it read, but only after the test releases it.
    const fenceRead = gate();
    let manifestReads = 0;
    let fencePending = false;
    const fs = {
      ...nodeStoreFs,
      readFile: async (path: string) => {
        const text = await nodeStoreFs.readFile(path);
        if (path.endsWith("/manifest.json") && ++manifestReads === 2) {
          fencePending = true;
          await fenceRead.promise;
        }
        return text;
      },
    };
    const dir = fakeDirectory({ projects: [{ projectId: P, projectRootPath: t.root, projectKind: "git" }] });
    const engine = createPauseEngine({
      open: (projectId) => openProjectStore(dir, projectId, { fs }),
      paseo: () => t.fake.paseo,
      directory: () => dir,
      log: () => undefined,
      retryDelaysMs: [0, 0],
    });
    const order: string[] = [];
    t.fake.script.beforeRespond = () => void order.push("answer");
    void engine.afterAccept({ projectId: P, sessionId: sid, operationId: OP });
    await until(() => fencePending, "the fence read holding the manifest it read");
    need(t.commands.plannerSet, "plannerSet");
    let rebound = false;
    const rebind = (async () => {
      const out = await t.commands.plannerSet(t.open, { projectId: P, sessionId: sid, expectedRevision: await t.revision(), agentId: OTHER_AGENT, workspaceId: "ws-2" }, UI_ORIGIN);
      order.push("rebind committed");
      rebound = true;
      return out;
    })();
    // The current engine reads without the store lock, so the rebind commits now. An engine that
    // validates and admits the call under the lock the rebind needs will hold the rebind here: release then.
    await until(() => rebound, "the rebind commit (or a lock that holds it)", 2000).catch(() => undefined);
    fenceRead.release();
    expect((await rebind).ok).toBe(true);
    await engine.idle();
    const answerIndex = order.indexOf("answer");
    const rebindIndex = order.indexOf("rebind committed");
    expect(answerIndex === -1 || answerIndex < rebindIndex, `no answer to the old card after the rebind committed (order: ${order.join(" → ")})`).toBe(true);
    expect((await t.sessionOf(sid)).continuation?.state).toBe("superseded");
  });

  it("c81 (guard): a fresh engine with no remembered project finds the operation through the hook agent's cwd and records paused", async () => {
    const t = await setup();
    const sid = await t.seeded(continuationIn("awaiting_pause"));
    t.fake.show(PLANNER, claudeCard(OP));
    const fresh = t.makeEngine();
    await t.requested(fresh, claudeCard(OP));
    await fresh.idle();
    expect((await t.sessionOf(sid)).continuation).toMatchObject({ state: "paused", pause: { requestId: REQ } });
  });
});

// S2 summary KensAI review (session 01a19945): c121 late canonical resolution after a reconcile.
describe("S2 KensAI c121", () => {
  it("c121: when a resolution event is the first host context, its reconcile may commit pause_lost first; the exact request's resolution still records pause_answered_externally", async () => {
    const { createPauseEngine, registerPauseEngine } = await load();
    const t = await setup();
    const sid = await t.seeded(continuationIn("paused"));
    // The owner answered the card in the chat: the host shows nothing pending any more.
    const lookupHeld = gate();
    let lookupReached = false;
    const base = fakeDirectory({ projects: [{ projectId: P, projectRootPath: t.root, projectKind: "git" }] });
    const dir = {
      listProjects: () => base.listProjects(),
      // Only the hook's cwd lookup (projectForCwd) lists workspaces; holding it lets the reconcile commit first.
      listWorkspaces: async () => {
        lookupReached = true;
        await lookupHeld.promise;
        return base.listWorkspaces();
      },
    };
    const holder = createPaseoHolder();
    const engine = createPauseEngine({ open: t.open, paseo: () => holder.get(), directory: () => dir, log: () => undefined, retryDelaysMs: [0, 0] });
    // Wired as index.server.ts wires it: the first host context starts a reconcile, then the hook body runs.
    holder.subscribe((p) => void engine.reconcileAll(p));
    const handlers = new Map<string, (event: unknown, ctx: { paseo: PaseoApi; signal: AbortSignal }) => unknown>();
    const server = {
      on(name: string, handler: (event: unknown, ctx: { paseo: PaseoApi; signal: AbortSignal }) => unknown) {
        handlers.set(name, handler);
        return () => undefined;
      },
    };
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test recorder for the SDK's generic on(): one handler map for all hooks
    registerPauseEngine(server as never, engine, holder);
    const dispatched = handlers.get("agent.permission_resolved")!(
      { agent: t.agent(), requestId: REQ, resolution: { behavior: "deny", message: "answered with a message instead" } },
      { paseo: t.fake.paseo, signal: new AbortController().signal },
    );
    await until(async () => lookupReached && (await t.sessionOf(sid)).continuation?.state === "pause_lost", "the reconcile committed pause_lost while the hook's lookup is pending");
    lookupHeld.release();
    await dispatched;
    await engine.idle();
    expect((await t.sessionOf(sid)).continuation).toMatchObject({
      operationId: OP,
      state: "pause_answered_externally",
      resolution: { behavior: "deny", source: "external" },
      pause: { requestId: REQ },
    });
    expect(t.fake.calls.respond).toEqual([]);
  });

  // Controls for the narrow acceptance (they hold today and must keep holding): only a pre-Accept
  // pause_lost for the exact request may be settled by a late canonical resolution.
  it("c121 control: a late resolution of another request id leaves a pre-Accept pause_lost unchanged", async () => {
    const t = await setup();
    const sid = await t.seeded(continuationIn("pause_lost", { pause: pauseSnapshot(), reason: "restart" }));
    const before = grillingFields(await t.sessionOf(sid));
    await t.resolved(t.engine, "perm-other", { behavior: "deny" });
    await t.engine.idle();
    expect(grillingFields(await t.sessionOf(sid))).toBe(before);
  });

  it.each([
    ["post-Accept pause_lost", "pause_lost"],
    ["post-Accept needs_manual", "needs_manual"],
  ] as const)("c121 control: %s with the exact request is not settled by a late resolution", async (_name, state) => {
    const t = await setup();
    const sid = await t.seeded(
      continuationIn(state, { pause: pauseSnapshot(), acceptedBlockId: BLK_OPEN, nextBlockId: BLK_NEXT, summary: SUMMARY, reason: "answer_failed" }),
      { blocks: blocksFor(true) },
    );
    const before = grillingFields(await t.sessionOf(sid));
    await t.resolved(t.engine, REQ, { behavior: "deny" });
    await t.engine.idle();
    expect(grillingFields(await t.sessionOf(sid))).toBe(before);
  });
});

describe("registerPauseEngine and the holder", () => {
  type Engine = Awaited<ReturnType<typeof setup>>["engine"];
  function stubEngine(throwing = false) {
    const calls: Array<[string, unknown]> = [];
    const fail = async () => {
      if (throwing) throw new Error("synthetic engine failure");
    };
    const engine: Engine = {
      permissionRequested: async (e: unknown) => (calls.push(["permissionRequested", e]), fail()),
      permissionResolved: async (e: unknown) => (calls.push(["permissionResolved", e]), fail()),
      turnEnded: async (e: unknown) => (calls.push(["turnEnded", e]), fail()),
      agentGone: async (e: unknown, why: string) => (calls.push([`agentGone:${why}`, e]), fail()),
      afterAccept: async (x: unknown) => (calls.push(["afterAccept", x]), fail()),
      reconcileAll: async () => (calls.push(["reconcileAll", null]), fail()),
      remember: () => undefined,
      idle: async () => undefined,
    };
    return { engine, calls };
  }
  function recordingServer() {
    const handlers = new Map<string, (event: unknown, ctx: { paseo: PaseoApi; signal: AbortSignal }) => unknown>();
    const unsubscribed: string[] = [];
    const server = {
      on(name: string, handler: (event: unknown, ctx: { paseo: PaseoApi; signal: AbortSignal }) => unknown) {
        handlers.set(name, handler);
        return () => void unsubscribed.push(name);
      },
    };
    return { server, handlers, unsubscribed };
  }
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- opaque PaseoApi identity token: only passed through and compared, never called
  const paseo = { synthetic: "hook-context" } as unknown as PaseoApi;
  const HOOKS = ["agent.permission_requested", "agent.permission_resolved", "agent.turn_ended", "agent.archived", "agent.closed"];

  it("registers the five 0.12 hooks; each sets the holder and forwards to the engine; dispose unregisters all", async () => {
    const { registerPauseEngine } = await load();
    const rec = recordingServer();
    const stub = stubEngine();
    const holder = createPaseoHolder();
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test recorder for the SDK's generic on(): one handler map for all hooks
    const dispose = need(registerPauseEngine, "pause.registerPauseEngine")(rec.server as never, stub.engine, holder);
    expect([...rec.handlers.keys()].sort()).toEqual([...HOOKS].sort());
    const ctx = { paseo, signal: new AbortController().signal };
    const agent = hookAgent(PLANNER, "/synthetic/project");
    await rec.handlers.get("agent.permission_requested")!({ agent, request: claudeCard(OP) }, ctx);
    expect(holder.get()).toBe(paseo);
    await rec.handlers.get("agent.permission_resolved")!({ agent, requestId: REQ, resolution: { behavior: "deny" } }, ctx);
    await rec.handlers.get("agent.turn_ended")!({ agent, turnId: null, outcome: { kind: "completed" }, timeline: [] }, ctx);
    await rec.handlers.get("agent.archived")!({ agent, archivedAt: T1 }, ctx);
    await rec.handlers.get("agent.closed")!({ agent }, ctx);
    expect(stub.calls.map(([name]) => name)).toEqual(["permissionRequested", "permissionResolved", "turnEnded", "agentGone:archived", "agentGone:closed"]);
    dispose();
    expect([...rec.unsubscribed].sort()).toEqual([...HOOKS].sort());
  });

  it("a failing engine never makes a hook handler throw or reject", async () => {
    const { registerPauseEngine } = await load();
    const rec = recordingServer();
    const stub = stubEngine(true);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test recorder for the SDK's generic on(): one handler map for all hooks
    need(registerPauseEngine, "pause.registerPauseEngine")(rec.server as never, stub.engine, createPaseoHolder());
    const ctx = { paseo, signal: new AbortController().signal };
    const agent = hookAgent(PLANNER, "/synthetic/project");
    const events: Record<string, unknown> = {
      "agent.permission_requested": { agent, request: claudeCard(OP) },
      "agent.permission_resolved": { agent, requestId: REQ, resolution: { behavior: "deny" } },
      "agent.turn_ended": { agent, turnId: null, outcome: { kind: "completed" }, timeline: [] },
      "agent.archived": { agent, archivedAt: T1 },
      "agent.closed": { agent },
    };
    for (const name of HOOKS) {
      const outcome = await Promise.resolve()
        .then(() => rec.handlers.get(name)!(events[name], ctx))
        .then(
          () => "resolved",
          () => "rejected",
        );
      expect(outcome, name).toBe("resolved");
    }
  });

  it("holder.subscribe is called on the first PaseoApi and on a replacement, never twice for the same object", async () => {
    const holder = createPaseoHolder();
    const seen: PaseoApi[] = [];
    const unsubscribe = need(holder.subscribe, "paseo-holder.subscribe")((p: PaseoApi) => void seen.push(p));
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- opaque PaseoApi identity token: only passed through and compared, never called
    const other = { synthetic: "replacement" } as unknown as PaseoApi;
    holder.set(paseo);
    holder.set(paseo);
    holder.set(other);
    holder.set(other);
    expect(seen).toEqual([paseo, other]);
    unsubscribe();
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- opaque PaseoApi identity token: only passed through and compared, never called
    holder.set({ synthetic: "third" } as unknown as PaseoApi);
    expect(seen).toHaveLength(2);
  });
});
