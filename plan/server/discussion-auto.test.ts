// Automatic continuation of an accepted block in a feature-discussion chat whose planner cannot
// block on a native question (Codex in default mode), so the owner no longer presses Retry. Owner
// choices (2026-11-08) these cases pin:
// - only chats bound by Discuss (`boundBy: "discussion"`); other planners keep the manual Retry;
// - the shipped durable retry record is reused: at most one send per accepted block, the record
//   committed before the send, the record id as message id and the [DR-RETRY-<id>] token with the
//   block's summary in the text;
// - a pending permission or question is never answered, and the plugin sends only when its last read
//   before the send shows the chat idle with nothing pending, and waits otherwise. The host has no
//   conditional send, so a turn or prompt started after that read cannot be excluded (a window the
//   owner accepted; server/discussion-auto-race.test.ts covers changes up to the last read);
// - manual and automatic sends cannot duplicate each other, across concurrent presses and restarts;
// - an unknown outcome is never resent automatically, and the owner's marks stay as the owner set
//   them.
// Cases where the chat moved on (the owner answered the pause card in the chat) are not continued.
//
// Harness: real temp store and commands, the REAL pause engine (the plugin's only automatic actor:
// Accept's afterAccept callback, the lifecycle hooks and the start-up reconcile), and a scripted
// synthetic host. Which hook carries the send, and any new record fields, are left to the
// implementation; the engine is given `newId` in addition to its current deps in case records need
// ids. Sends are observed on the host, records in the store. No model or live host is involved.
import type { PluginLifecycleEvents } from "@getpaseo/plugin/server";
import type { AgentPermissionRequest } from "@getpaseo/protocol/agent-types";
import { DaemonConnectionError } from "@getpaseo/client/internal/daemon-client";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type { Continuation, RoadmapData, Session } from "../shared/model";
import { createPauseEngine } from "./pause";
import { createRoadmapCommands, UI_ORIGIN, type StoreOpener } from "./sessions";
import { openProjectStore } from "./store-root";
import { NOW, nextId, opt } from "./test-support/build";
import { fakeDirectory } from "./test-support/fake-dir";
import { fakePaseoAgents, gate, hookAgent } from "./test-support/fake-paseo-agents";
import { binding, BLK_OPEN, continuationIn, PLANNER, seedGrilling } from "./test-support/grilling";
import { makeProject, ok, type TestProject } from "./test-support/service";

const P = "prj_test";
const CODEX_DEFAULT = [{ type: "toggle" as const, id: "plan_mode", label: "Plan", value: false }];
/** A permission the chat asks the owner for, unrelated to the plugin (a tool approval). */
const APPROVAL: AgentPermissionRequest = { id: "perm-approval-1", provider: "codex", name: "exec_command", kind: "tool", title: "Run a command" };

const RetryRecord = z.looseObject({ id: z.string(), blockId: z.string(), agentId: z.string(), state: z.string(), resolvedBy: z.string().optional() });
const recordsOf = (session: unknown) => z.looseObject({ retries: z.array(RetryRecord).optional() }).parse(session).retries ?? [];

let project: TestProject | undefined;
afterEach(async () => {
  await project?.cleanup();
  project = undefined;
});

type Seed = { boundBy?: "discussion" | "ask"; continuation?: Continuation; status?: "idle" | "running" | "closed"; pending?: AgentPermissionRequest[]; archivedAt?: string };

async function setup(seed: Seed = {}) {
  project = await makeProject();
  const proj = project;
  const root = proj.root;
  let clock = new Date(NOW);
  const now = () => clock;
  const dir = fakeDirectory({ projects: [{ projectId: P, projectRootPath: root, projectKind: "git" }] });
  const storeOptions = { now, newId: nextId, log: () => undefined };
  const fake = fakePaseoAgents([{ id: PLANNER, provider: "codex", cwd: root, status: seed.status ?? "idle", features: CODEX_DEFAULT, pending: [...(seed.pending ?? [])], archivedAt: seed.archivedAt ?? null }]);
  const logs: string[] = [];
  const open: StoreOpener = (projectId) => openProjectStore(dir, projectId, storeOptions);
  const engineDeps = { open, paseo: () => fake.paseo, directory: () => dir, log: (m: string) => void logs.push(m), now, newId: nextId, retryDelaysMs: [0, 0] };
  let engine: ReturnType<typeof createPauseEngine> | undefined;
  const commands = createRoadmapCommands({ directory: () => dir, now, newId: nextId, storeOptions, afterAccept: (x) => void engine?.afterAccept(x) });
  /** A new engine, as after a plugin or daemon restart; the previous one is no longer used. */
  const restart = () => (engine = createPauseEngine(engineDeps));
  restart();
  ok(await commands.init(open, { projectId: P }, UI_ORIGIN));
  const revision = async () => ok(await commands.version(open, { projectId: P }, UI_ORIGIN)).revision!;
  const data = async (): Promise<RoadmapData> => {
    const read = await (await open(P)).read();
    if (read.status !== "ok") throw new Error(`expected an ok store, got ${read.status}`);
    return read.data;
  };
  const sessionId = ok(await commands.sessionCreate(open, { projectId: P, expectedRevision: await revision(), title: "[feature] Login" }, UI_ORIGIN)).sessionId;
  const [q1] = ok(
    await commands.questionCreateBatch(
      open,
      { projectId: P, expectedRevision: await revision(), sessionId, blockId: BLK_OPEN, questions: [{ title: "Q1", context: "", options: [opt("a"), opt("b")], allowFreeText: false, activatedBy: [], invalidatedBy: [] }] },
      { source: "chat", actor: { kind: "agent" } },
    ),
  ).questionIds;
  ok(await commands.questionAnswer(open, { projectId: P, expectedRevision: await revision(), sessionId, questionId: q1, optionId: "a" }, UI_ORIGIN));
  await seedGrilling(open, P, sessionId, {
    planner: binding({ boundBy: seed.boundBy ?? "discussion" }),
    continuation: seed.continuation ?? continuationIn("unsupported", { reason: "codex default mode" }),
  });
  engine!.remember(PLANNER, P);

  const session = async (): Promise<Session> => (await data()).sessions.find((s) => s.id === sessionId)!;
  const records = async () => recordsOf(await session());
  const summary = async () => {
    const block = (await session()).blocks?.find((b) => b.id === BLK_OPEN);
    return block?.state === "accepted" ? block.summary : undefined;
  };
  const idle = () => engine!.idle();
  const accept = async () => {
    ok(await commands.blockAccept(open, { projectId: P, sessionId, blockId: BLK_OPEN, expectedRevision: await revision() }, UI_ORIGIN));
    await idle();
  };
  const agent = () => hookAgent(PLANNER, root, "codex");
  const turnEnded = async () => {
    const event: PluginLifecycleEvents["agent.turn_ended"] = { agent: agent(), turnId: "turn-1", outcome: { kind: "completed" }, timeline: [] };
    await engine!.turnEnded(event, fake.paseo);
    await idle();
  };
  const permissionResolved = async (requestId: string) => {
    const event: PluginLifecycleEvents["agent.permission_resolved"] = { agent: agent(), requestId, resolution: { behavior: "allow" } };
    await engine!.permissionResolved(event, fake.paseo);
    await idle();
  };
  const reconcile = async () => {
    await engine!.reconcileAll(fake.paseo);
    await idle();
  };
  const setStatus = (status: "idle" | "running") => (fake.agents.get(PLANNER)!.status = status);
  const later = (ms: number) => (clock = new Date(NOW.getTime() + ms));

  // The shipped manual Retry, resolve and sweep (server/discussion.ts), over the same store and host.
  const retryDeps = () => ({ open, now, newId: nextId, log: () => undefined });
  const discussion = await import("./discussion");
  const manualRetry = async () => discussion.retryContinuation(retryDeps(), fake.paseo, { projectId: P, expectedRevision: await revision(), sessionId });
  const resolve = async (retryId: string, outcome: "delivered" | "not_delivered") =>
    discussion.resolveRetry(retryDeps(), { projectId: P, expectedRevision: await revision(), sessionId, retryId, outcome });
  const sweep = async (olderThanMs = 60_000) => discussion.sweepStaleRetries(retryDeps(), P, olderThanMs);

  /** The bound planner proposes finishing (roadmap_grill_propose_finish), through the real command. */
  const proposeFinish = async () =>
    ok(await commands.grillProposeFinish(open, { projectId: P, expectedRevision: await revision(), sessionId, summary: "Nothing left to ask." }, { source: "chat", actor: { kind: "agent" } }, { agentId: PLANNER, workspaceId: "ws-1" }));
  /** The session view the panel reads, and the header the client derives from it. */
  const header = async () => {
    const view = ok(await commands.sessionGet(open, { projectId: P, sessionId }, UI_ORIGIN));
    const headerPath = "../client/grilling-header";
    const mod: unknown = await import(/* @vite-ignore */ headerPath);
    const pick = (name: string): unknown => (typeof mod === "object" && mod !== null ? Object.entries(mod).find(([k]) => k === name)?.[1] : undefined);
    const fn = pick("grillingHeader");
    if (typeof fn !== "function") throw new Error("missing export: grilling-header.grillingHeader");
    const out: unknown = Reflect.apply(fn, undefined, [view, null]);
    return { header: z.object({ text: z.string(), recovery: z.string().nullable() }).parse(out), manualRecoveryText: String(pick("MANUAL_RECOVERY_TEXT")), grilling: view.grilling };
  };
  /** What the bound planner chat is told about pausing (roadmap_pause_instructions). */
  const instructions = async () =>
    z.object({ instructions: z.string() }).loose().parse(ok(await commands.pauseInstructions(open, { projectId: P, sessionId }, { agentId: PLANNER, workspaceId: "ws-1" }))).instructions;
  return { fake, logs, session, records, summary, accept, proposeFinish, header, instructions, turnEnded, permissionResolved, reconcile, restart, setStatus, later, manualRetry, resolve, sweep, idle };
}

/** The single send the plugin made and the record it belongs to. */
async function oneSend(t: Awaited<ReturnType<typeof setup>>) {
  expect(t.fake.calls.send).toHaveLength(1);
  const [sent] = t.fake.calls.send;
  const records = await t.records();
  expect(records).toHaveLength(1);
  return { sent, record: records[0] };
}

describe("a Codex default-mode discussion chat is continued after Accept without Retry", () => {
  it("one send to the idle chat: the record id as message id and token, the block's summary, no turn mode", async () => {
    const t = await setup();
    await t.accept();
    const { sent, record } = await oneSend(t);
    expect(sent.agentId).toBe(PLANNER);
    expect(sent.statusAtSend).toBe("idle");
    expect(sent.pendingAtSend).toBe(0);
    expect(sent.options).toMatchObject({ messageId: record.id });
    expect(sent.options ?? {}).not.toHaveProperty("activeTurnBehavior");
    expect(sent.text).toContain(`[DR-RETRY-${record.id}]`);
    expect(sent.text).toContain((await t.summary())!);
    expect(record).toMatchObject({ blockId: BLK_OPEN, agentId: PLANNER, state: "sent" });
    expect(t.fake.calls.respond).toEqual([]);
  });

  it("a card that never came before Accept (pause lost, no pause) is continued the same way", async () => {
    const t = await setup({ continuation: continuationIn("pause_lost", { reason: "no_pause" }) });
    await t.accept();
    expect((await oneSend(t)).record.state).toBe("sent");
  });

  it("an accepted block whose turn then ends without a card is continued once at that turn end", async () => {
    const t = await setup({ continuation: continuationIn("awaiting_pause"), status: "running" });
    await t.accept();
    expect(t.fake.calls.send).toEqual([]);
    t.setStatus("idle");
    await t.turnEnded();
    expect((await oneSend(t)).record.state).toBe("sent");
    await t.turnEnded();
    expect(t.fake.calls.send).toHaveLength(1);
  });

  it("later Accept-side events, turn ends and reconciles never send it again", async () => {
    const t = await setup();
    await t.accept();
    t.setStatus("idle");
    await t.turnEnded();
    await t.reconcile();
    t.restart();
    await t.reconcile();
    expect(t.fake.calls.send).toHaveLength(1);
    expect(await t.records()).toHaveLength(1);
  });
});

describe("scope: only chats bound by Discuss, and only when the chat did not move on", () => {
  it("a planner bound by ask keeps the manual Retry: nothing is sent automatically", async () => {
    const t = await setup({ boundBy: "ask" });
    await t.accept();
    await t.turnEnded();
    await t.reconcile();
    expect(t.fake.calls.send).toEqual([]);
    expect(await t.records()).toEqual([]);
  });

  it("a pause card the owner answered in the chat is not continued by the plugin", async () => {
    const t = await setup({ continuation: continuationIn("pause_answered_externally", { resolution: { behavior: "allow", at: NOW.toISOString(), source: "external" } }) });
    await t.accept();
    await t.turnEnded();
    expect(t.fake.calls.send).toEqual([]);
  });
});

describe("never interrupt a running chat, never dismiss a pending prompt", () => {
  it("while the chat is running nothing is sent; once its turn ends idle, one send", async () => {
    const t = await setup({ status: "running" });
    await t.accept();
    expect(t.fake.calls.send).toEqual([]);
    await t.turnEnded();
    expect(t.fake.calls.send).toEqual([]);
    t.setStatus("idle");
    await t.turnEnded();
    const { sent } = await oneSend(t);
    expect(sent.statusAtSend).toBe("idle");
  });

  it("while a permission is pending nothing is sent and the prompt is never answered; after it is resolved, one send", async () => {
    const t = await setup({ pending: [APPROVAL] });
    await t.accept();
    await t.turnEnded();
    await t.reconcile();
    expect(t.fake.calls.send).toEqual([]);
    expect(t.fake.calls.respond).toEqual([]);
    expect(t.fake.agents.get(PLANNER)!.pending.map((r) => r.id)).toEqual([APPROVAL.id]);
    // The owner answers the approval in the chat.
    t.fake.drop(PLANNER, APPROVAL.id);
    await t.permissionResolved(APPROVAL.id);
    if (t.fake.calls.send.length === 0) await t.turnEnded();
    const { sent } = await oneSend(t);
    expect(sent.pendingAtSend).toBe(0);
    expect(sent.statusAtSend).toBe("idle");
  });

  it("an unreadable chat state sends nothing", async () => {
    const t = await setup();
    t.fake.script.refreshRejects.set(PLANNER, new Error("synthetic refresh failure"));
    await t.accept();
    await t.turnEnded();
    expect(t.fake.calls.send).toEqual([]);
  });
});

describe("manual and automatic sends never duplicate", () => {
  it("after the automatic send, the manual Retry is refused and sends nothing", async () => {
    const t = await setup();
    await t.accept();
    expect(t.fake.calls.send).toHaveLength(1);
    expect((await t.manualRetry()).ok).toBe(false);
    expect(t.fake.calls.send).toHaveLength(1);
  });

  it("a manual Retry while the automatic send is in flight sends nothing", async () => {
    const t = await setup();
    const hold = gate();
    t.fake.script.sendGate.set(PLANNER, hold.promise);
    const accepted = t.accept();
    for (let i = 0; i < 200 && t.fake.calls.send.length === 0; i++) await new Promise((r) => setTimeout(r, 5));
    expect(t.fake.calls.send).toHaveLength(1);
    expect((await t.manualRetry()).ok).toBe(false);
    hold.release();
    await accepted;
    expect(t.fake.calls.send).toHaveLength(1);
    expect(await t.records()).toHaveLength(1);
  });

  it("a manual Retry while the automatic continuation waits for the chat leaves one send in total", async () => {
    const t = await setup({ status: "running" });
    await t.accept();
    t.setStatus("idle");
    expect((await t.manualRetry()).ok).toBe(true);
    await t.turnEnded();
    await t.reconcile();
    expect(t.fake.calls.send).toHaveLength(1);
    const ids = new Set(t.fake.calls.send.map((s) => s.options?.messageId));
    expect(ids.size).toBe(1);
  });
});

describe("restarts and uncertain outcomes", () => {
  it("a continuation still waiting for the chat at a restart is sent once after it, by the reconcile", async () => {
    const t = await setup({ status: "running" });
    await t.accept();
    expect(t.fake.calls.send).toEqual([]);
    t.restart();
    t.setStatus("idle");
    await t.reconcile();
    expect(t.fake.calls.send).toHaveLength(1);
    await t.reconcile();
    expect(t.fake.calls.send).toHaveLength(1);
  });

  it("a send in flight at a restart is never sent again; the sweep makes it unknown", async () => {
    const t = await setup();
    const hold = gate();
    t.fake.script.sendGate.set(PLANNER, hold.promise);
    void t.accept();
    for (let i = 0; i < 200 && t.fake.calls.send.length === 0; i++) await new Promise((r) => setTimeout(r, 5));
    expect(t.fake.calls.send).toHaveLength(1);
    t.restart();
    t.setStatus("idle");
    await t.reconcile();
    await t.turnEnded();
    t.later(120_000);
    await t.sweep();
    expect((await t.records()).map((r) => r.state)).toEqual(["unknown"]);
    expect(t.fake.calls.send).toHaveLength(1);
    hold.release();
  });

  it("an unknown outcome is never resent automatically", async () => {
    const t = await setup();
    t.fake.script.sendRejects.set(PLANNER, new DaemonConnectionError("timeout", "DAEMON_REQUEST_TIMEOUT"));
    await t.accept();
    expect((await oneSend(t)).record.state).toBe("unknown");
    t.fake.script.sendRejects.delete(PLANNER);
    t.setStatus("idle");
    await t.turnEnded();
    await t.reconcile();
    t.restart();
    await t.reconcile();
    expect(t.fake.calls.send).toHaveLength(1);
  });

  it("the owner's delivered mark stays: later events change nothing and send nothing", async () => {
    const t = await setup();
    t.fake.script.sendRejects.set(PLANNER, new DaemonConnectionError("timeout", "DAEMON_REQUEST_TIMEOUT"));
    await t.accept();
    t.fake.script.sendRejects.delete(PLANNER);
    const { record } = await oneSend(t);
    expect((await t.resolve(record.id, "delivered")).ok).toBe(true);
    t.setStatus("idle");
    await t.turnEnded();
    await t.reconcile();
    expect(await t.records()).toEqual([expect.objectContaining({ id: record.id, state: "sent", resolvedBy: "user" })]);
    expect(t.fake.calls.send).toHaveLength(1);
  });

  it("the owner's not-delivered mark stays: nothing is resent automatically, the owner's Retry sends once", async () => {
    const t = await setup();
    t.fake.script.sendRejects.set(PLANNER, new DaemonConnectionError("timeout", "DAEMON_REQUEST_TIMEOUT"));
    await t.accept();
    t.fake.script.sendRejects.delete(PLANNER);
    const { record } = await oneSend(t);
    expect((await t.resolve(record.id, "not_delivered")).ok).toBe(true);
    t.setStatus("idle");
    await t.turnEnded();
    await t.reconcile();
    expect(t.fake.calls.send).toHaveLength(1);
    expect((await t.records()).find((r) => r.id === record.id)).toMatchObject({ state: "failed", resolvedBy: "user" });
    expect((await t.manualRetry()).ok).toBe(true);
    expect(t.fake.calls.send).toHaveLength(2);
  });
});

// Review regression: a continuation that waits for a running chat is stale once the planner itself
// proposed finishing before its turn ended; continuing would ask it for another batch.
describe("a waiting continuation after the planner proposes finishing", () => {
  it("is not sent at the turn end, and no record is written", async () => {
    const t = await setup({ status: "running" });
    await t.accept();
    expect(t.fake.calls.send).toEqual([]);
    await t.proposeFinish();
    t.setStatus("idle");
    await t.turnEnded();
    await t.reconcile();
    expect(t.fake.calls.send).toEqual([]);
    expect(await t.records()).toEqual([]);
    expect((await t.session()).finishProposal).toMatchObject({ agentId: PLANNER });
  });
});

// Review regression (KensAI c0016): while the automatic continuation waits for the chat, the header
// does not also tell the owner to continue in the chat by hand; a planner bound by ask still does.
describe("the header while the automatic continuation waits", () => {
  it("shows the waiting continuation without the manual recovery instruction", async () => {
    const t = await setup({ status: "running" });
    await t.accept();
    const { header, manualRecoveryText } = await t.header();
    expect(header.text).not.toMatch(/needs manual recovery/i);
    expect(header.recovery).not.toBe(manualRecoveryText);
  });

  it("control: a planner bound by ask keeps the manual recovery instruction", async () => {
    const t = await setup({ boundBy: "ask" });
    await t.accept();
    const { header, manualRecoveryText } = await t.header();
    expect(header.recovery).toBe(manualRecoveryText);
  });
});

// Review regression (KensAI c0020): a discussion chat the plugin continues is not told that the owner
// continues it manually, before Accept (it cannot pause) or after (no resumable pause). A planner bound
// by ask still is.
describe("what a discussion chat that cannot pause is told", () => {
  const MANUAL_ONLY = /owner continues manually|Continue only as the owner tells you/i;

  it("before Accept and while the continuation waits, it is not told the owner continues manually", async () => {
    const t = await setup({ status: "running" });
    expect(await t.instructions()).not.toMatch(MANUAL_ONLY);
    await t.accept();
    expect(await t.instructions()).not.toMatch(MANUAL_ONLY);
  });

  it("control: a planner bound by ask is still told the owner continues manually", async () => {
    const t = await setup({ boundBy: "ask" });
    expect(await t.instructions()).toMatch(MANUAL_ONLY);
  });
});

// Review regression (KensAI c0026): the session view reports the automatic continuation, waiting and
// then sent with its automatic origin, and the header names it; the view fields are what the panel reads.
describe("the automatic continuation in the session view", () => {
  it("waiting while the chat runs, then sent with the automatic origin", async () => {
    const t = await setup({ status: "running" });
    await t.accept();
    const waiting = await t.header();
    expect(waiting.grilling).toMatchObject({ automatic: "waiting" });
    expect(waiting.header.text).not.toMatch(/sent/i);
    t.setStatus("idle");
    await t.turnEnded();
    const sent = await t.header();
    expect(sent.grilling?.lastRetry).toMatchObject({ origin: "automatic", state: "sent" });
    expect(sent.grilling).not.toMatchObject({ automatic: "waiting" });
    expect(sent.header.text).toMatch(/sent/i);
  });
});

// E2E regression (2026-11-08, sandbox): a discussion chat the host had closed after idling (status
// "closed", not archived) was never continued: the engine waited on "chat closed" until something
// else loaded the chat. Host 0.15.3 semantics, read from the installed packages: `ref.refresh()` is a
// read-only fetch that does not load a closed agent; `ref.timeline.refetch()` loads it from
// persistence (`ensureAgentLoaded`) without interrupting anything, and is a no-op for a loaded one;
// `ref.reload()` (`refresh_agent_request`) interrupts a loaded running agent, so it is never the way
// to load one. A closed chat is not taken for idle: after loading, the chat's own state decides, with
// the same rules as for any chat (idle, nothing pending, nothing answered, never resent).
describe("a discussion chat the host closed after idling", () => {
  it("is loaded without reload, then continued once when it loads idle with nothing pending", async () => {
    const t = await setup({ status: "closed" });
    await t.accept();
    expect(t.fake.calls.load).toContain(PLANNER);
    expect(t.fake.calls.reload).toEqual([]);
    const { sent, record } = await oneSend(t);
    expect(sent.statusAtSend).toBe("idle");
    expect(sent.pendingAtSend).toBe(0);
    expect(record.state).toBe("sent");
    expect(t.fake.calls.respond).toEqual([]);
  });

  it("loading surfaces a pending permission: nothing is sent or answered until it is resolved, then once", async () => {
    const t = await setup({ status: "closed" });
    t.fake.script.onLoad.set(PLANNER, (a) => {
      a.status = "idle";
      a.pending.push(structuredClone(APPROVAL));
    });
    await t.accept();
    expect(t.fake.calls.send).toEqual([]);
    expect(t.fake.calls.respond).toEqual([]);
    expect(t.fake.agents.get(PLANNER)!.pending.map((r) => r.id)).toEqual([APPROVAL.id]);
    t.fake.drop(PLANNER, APPROVAL.id);
    await t.permissionResolved(APPROVAL.id);
    if (t.fake.calls.send.length === 0) await t.turnEnded();
    expect((await oneSend(t)).sent.pendingAtSend).toBe(0);
  });

  it("loading finds it running: nothing is sent until an idle turn end, then once", async () => {
    const t = await setup({ status: "closed" });
    t.fake.script.onLoad.set(PLANNER, (a) => (a.status = "running"));
    await t.accept();
    expect(t.fake.calls.send).toEqual([]);
    t.setStatus("idle");
    await t.turnEnded();
    expect((await oneSend(t)).sent.statusAtSend).toBe("idle");
    expect(t.fake.calls.reload).toEqual([]);
  });

  it("the load fails: nothing is sent and nothing is reloaded", async () => {
    const t = await setup({ status: "closed" });
    t.fake.script.loadRejects.set(PLANNER, new Error("synthetic load failure"));
    await t.accept();
    await t.reconcile();
    expect(t.fake.calls.send).toEqual([]);
    expect(t.fake.calls.reload).toEqual([]);
    expect(t.fake.agents.get(PLANNER)!.status).toBe("closed");
  });

  it("an archived chat is neither loaded nor continued", async () => {
    const t = await setup({ status: "closed", archivedAt: NOW.toISOString() });
    await t.accept();
    await t.reconcile();
    expect(t.fake.calls.load).toEqual([]);
    expect(t.fake.calls.reload).toEqual([]);
    expect(t.fake.calls.send).toEqual([]);
  });
});
