// Host-event-scoped timeline observer (Stage 5 T5.5). Fake lifecycle `on` server and a fake PaseoApi
// whose `agents.ref(id).timeline` records subscribe/append/refetch, over a REAL temp store. Event and
// item shapes follow the installed 0.12.0 declarations (plugin server lifecycle, client
// PaseoAgentTimelineEvent / agent_stream payload, protocol ToolCallTimelineItem).
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PaseoApi } from "@getpaseo/client";
import { AgentStreamMessageSchema } from "@getpaseo/protocol/messages";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPaseoHolder } from "./paseo-holder";
import { openStore } from "./store";
import { fixedClock, NOW_ISO, nextId, q, session } from "./test-support/build";
import { fakeDirectory } from "./test-support/fake-dir";
import { makeProject, type TestProject } from "./test-support/service";
import { registerTimelineObserver } from "./timeline-rows";

const SECRET_TITLE = "Secret question title QT-7731";
const OUTPUT_MARKER = "TOOL-OUTPUT-MARKER-5512";
const ID_MARKER = "full-identity-marker";
const agentId = (n: number | string) => `agent-${n}-${ID_MARKER}-0123456789abcdef`;
const ASK = "mcp__decision-roadmap__roadmap_ask";

type Handler = (event: unknown, ctx: { paseo: PaseoApi; signal: AbortSignal }) => unknown;
type Sub = { agentId: string; handler: (e: unknown) => void; active: boolean };

function fakeServer(paseo: PaseoApi) {
  const handlers = new Map<string, Handler[]>();
  return {
    on(name: string, handler: Handler) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
      return () => handlers.set(name, (handlers.get(name) ?? []).filter((h) => h !== handler));
    },
    async emit(name: string, event: unknown) {
      for (const h of handlers.get(name) ?? []) await h(event, { paseo, signal: new AbortController().signal });
    },
  };
}

function fakePaseo() {
  const subs: Sub[] = [];
  const refs: string[] = [];
  const appends: Array<{ agentId: string; item: Record<string, unknown> }> = [];
  const refetches: string[] = [];
  const appendAttempts: string[] = [];
  /** Opt-in fault knobs (defaults keep the ordinary behaviour): agents whose `ready` rejects, appends to fail. */
  const faults = { rejectReady: new Set<string>(), failAppends: 0 };
  let entries: (agentId: string) => unknown[] = () => [];
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- partial PaseoApi test stub: only the members this test exercises exist
  const paseo = {
    agents: {
      ref(id: string) {
        refs.push(id);
        return {
          id,
          timeline: {
            subscribe(handler: (e: unknown) => void) {
              const sub: Sub = { agentId: id, handler, active: true };
              subs.push(sub);
              const stop = () => void (sub.active = false);
              let ready: Promise<void> = Promise.resolve();
              if (faults.rejectReady.has(id)) {
                ready = Promise.reject(new Error("synthetic establish failure"));
                ready.catch(() => undefined); // observed only by the code under test
              }
              return Object.assign(stop, { ready, subscriptionId: `sub-${subs.length}`, release: async () => stop() });
            },
            async append(item: Record<string, unknown>) {
              appendAttempts.push(id);
              if (faults.failAppends > 0) {
                faults.failAppends -= 1;
                throw new Error("synthetic append failure");
              }
              appends.push({ agentId: id, item });
              return { seq: appends.length, epoch: "epoch-1" };
            },
            async refetch() {
              refetches.push(id);
              return {
                requestId: "req-1",
                agentId: id,
                agent: null,
                direction: "tail",
                projection: "projected",
                epoch: "epoch-1",
                reset: false,
                staleCursor: false,
                gap: false,
                window: { minSeq: 0, maxSeq: 1, nextSeq: 2 },
                startCursor: null,
                endCursor: null,
                hasOlder: false,
                hasNewer: false,
                entries: entries(id).map((item, i) => ({
                  provider: "claude",
                  item,
                  timestamp: NOW_ISO,
                  seqStart: i,
                  seqEnd: i,
                  sourceSeqRanges: [],
                  collapsed: [],
                })),
                error: null,
              };
            },
          },
        };
      },
    },
  } as unknown as PaseoApi;
  return {
    paseo,
    subs,
    refs,
    appends,
    refetches,
    appendAttempts,
    faults,
    setRefetchEntries: (f: (agentId: string) => unknown[]) => void (entries = f),
    active: (id: string) => subs.filter((s) => s.agentId === id && s.active).length,
    subscribed: (id: string) => subs.filter((s) => s.agentId === id).length,
    deliver: (id: string, event: unknown) => subs.filter((s) => s.agentId === id && s.active).forEach((s) => s.handler(event)),
  };
}

const askCall = (questionIds: string[], status: "running" | "completed" | "failed" = "completed", extra: Record<string, unknown> = {}) => ({
  type: "tool_call",
  callId: `call-${questionIds.join("-")}`,
  name: ASK,
  detail: {
    type: "unknown",
    input: { expectedRevision: 1, sessionId: "s1", questions: [{ title: SECRET_TITLE, options: [] }] },
    output: JSON.stringify({ revision: 2, questionIds, visibilityChanged: [], note: OUTPUT_MARKER, ...extra }),
  },
  status,
  error: status === "failed" ? { message: "boom" } : null,
});
const streamEvent = (id: string, item: unknown) => ({
  subscriptionId: "sub-x",
  agentId: id,
  event: { type: "timeline", provider: "claude", item, turnId: "turn-1" },
  timestamp: NOW_ISO,
  seq: 7,
  epoch: "epoch-1",
});
const hookAgent = (id: string, cwd: string, provider = "claude") => ({ id, workspaceId: "ws-1", parentAgentId: null, provider, cwd, title: null });
const rowFor = (questionId: string) => ({
  type: "plugin",
  id: `q.s1.${questionId}`,
  kind: "decision-question",
  version: 1,
  data: { projectId: "prj_test", sessionId: "s1", questionId },
});
/** Lets fire-and-forget scans finish before asserting that something did NOT happen. */
const settle = () => new Promise((r) => setTimeout(r, 150));

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((c) => c()));
});

/** Opted-in synthetic project: registered, initialised, with s1/{q1 (secret title), q2}. */
async function optedIn(): Promise<TestProject> {
  const project = await makeProject();
  cleanups.push(project.cleanup);
  const store = openStore({ storeRoot: project.root, projectId: "prj_test", now: fixedClock, newId: nextId, log: () => undefined });
  await store.init();
  await store.transact(1, (d) => {
    d.sessions.push(session("s1", [q("q1", { title: SECRET_TITLE }), q("q2")]));
  });
  return project;
}

function observe(project: { root: string }, opts: { maxSubscriptions?: number; fake?: ReturnType<typeof fakePaseo> } = {}) {
  const fake = opts.fake ?? fakePaseo();
  const server = fakeServer(fake.paseo);
  const logs: string[] = [];
  const holder = createPaseoHolder();
  const dir = fakeDirectory({ projects: [{ projectId: "prj_test", projectRootPath: project.root, projectKind: "git" }] });
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test recorder for the SDK's generic handle(): one handler map for all contracts
  const stop = registerTimelineObserver(server as never, {
    directory: (p) => {
      if (p !== fake.paseo) throw new Error("observer did not use the hook context's paseo");
      return dir;
    },
    openStore,
    holder,
    log: (m: string) => void logs.push(m),
    ...(opts.maxSubscriptions !== undefined ? { maxSubscriptions: opts.maxSubscriptions } : {}),
  });
  // A second stop in afterEach must not mask the test result.
  cleanups.push(async () => void (await Promise.resolve().then(stop).catch(() => undefined)));
  return { fake, server, logs, holder, stop };
}

describe("observer scope (T5.5)", () => {
  it("subscribes once per opted-in Claude agent delivered by turn_started, and hydrates the holder", async () => {
    const project = await optedIn();
    const { fake, server, holder } = observe(project);
    const id = agentId(1);
    await server.emit("agent.turn_started", { agent: hookAgent(id, project.root), turnId: "turn-1" });
    await server.emit("agent.turn_started", { agent: hookAgent(id, project.root), turnId: "turn-2" });
    await vi.waitFor(() => expect(fake.active(id)).toBe(1));
    await settle();
    expect(fake.subscribed(id)).toBe(1);
    expect(holder.get()).toBe(fake.paseo);
  });

  it("does not subscribe outside an opted-in project, for a disabled store, or for OpenCode/Pi", async () => {
    const project = await optedIn();
    const outside = await realpath(await mkdtemp(join(tmpdir(), "dr-rows-outside-")));
    cleanups.push(() => rm(outside, { recursive: true, force: true }));
    const uninitialised = await makeProject();
    cleanups.push(uninitialised.cleanup);

    const a = observe(project);
    await a.server.emit("agent.turn_started", { agent: hookAgent(agentId("outside"), outside), turnId: null });
    await a.server.emit("agent.turn_started", { agent: hookAgent(agentId("opencode"), project.root, "opencode"), turnId: null });
    await a.server.emit("agent.turn_started", { agent: hookAgent(agentId("pi"), project.root, "pi"), turnId: null });
    const b = observe(uninitialised);
    await b.server.emit("agent.turn_started", { agent: hookAgent(agentId("uninit"), uninitialised.root), turnId: null });

    const manifest = join(project.root, ".decisions", "manifest.json");
    await writeFile(manifest, JSON.stringify({ ...JSON.parse(await readFile(manifest, "utf8")), disabled: true }));
    await a.server.emit("agent.turn_started", { agent: hookAgent(agentId("disabled"), project.root), turnId: null });
    await settle();
    expect(a.fake.subs).toHaveLength(0);
    expect(b.fake.subs).toHaveLength(0);
    expect(a.fake.appends).toHaveLength(0);
  });
});

describe("live rows (T5.5)", () => {
  it("a completed ask for a stored question appends exactly one ref-only row to the host agent", async () => {
    const project = await optedIn();
    const { fake, server } = observe(project);
    const id = agentId(2);
    await server.emit("agent.turn_started", { agent: hookAgent(id, project.root), turnId: "turn-1" });
    await vi.waitFor(() => expect(fake.active(id)).toBe(1));

    fake.deliver(id, streamEvent(id, askCall(["q99"]))); // absent from the store
    fake.deliver(id, streamEvent(id, askCall(["q1"], "running")));
    fake.deliver(id, streamEvent(id, askCall(["q1"], "completed", { agentId: agentId("foreign") })));
    await vi.waitFor(() => expect(fake.appends.length).toBeGreaterThan(0));
    await settle();
    expect(fake.appends).toEqual([{ agentId: id, item: rowFor("q1") }]);
    expect(new Set(fake.refs)).toEqual(new Set([id]));
  });
});

describe("live rows from the installed 0.12.0 provider envelopes (T5.5)", () => {
  // Stage 5 card "Installed 0.12.0 output clarification": Claude detail.output = { output: payload },
  // Codex detail.output = { content: [{ type: "text", text: JSON payload }] }.
  const payload = (questionIds: string[]) => ({ revision: 2, questionIds, visibilityChanged: [], note: OUTPUT_MARKER });
  const cases = [
    {
      provider: "claude",
      name: ASK,
      output: (ids: string[]) => ({ output: payload(ids) }),
      malformed: { output: `Tool failed: ${OUTPUT_MARKER}` },
    },
    {
      provider: "codex",
      name: "decision-roadmap.roadmap_ask",
      output: (ids: string[]) => ({ content: [{ type: "text", text: JSON.stringify(payload(ids)) }] }),
      malformed: { isError: true, content: [{ type: "text", text: JSON.stringify(payload(["q2"])) }] },
    },
    // Review regression (KensAI c0057): the Codex discussion chat's preapproval entry gives the same row.
    {
      provider: "codex",
      name: "decision-roadmap-discuss.roadmap_ask",
      output: (ids: string[]) => ({ content: [{ type: "text", text: JSON.stringify(payload(ids)) }] }),
      malformed: { isError: true, content: [{ type: "text", text: JSON.stringify(payload(["q2"])) }] },
    },
  ] as const;

  for (const c of cases) {
    it(`${c.provider} (${c.name}): a completed ask in the actual envelope appends the canonical row to the host agent only`, async () => {
      const project = await optedIn();
      const { fake, server } = observe(project);
      const id = agentId(`${c.provider}-envelope`);
      await server.emit("agent.turn_started", { agent: hookAgent(id, project.root, c.provider), turnId: "turn-1" });
      await vi.waitFor(() => expect(fake.active(id)).toBe(1));
      const item = (output: unknown, questionIds = ["q1"]) => ({
        ...askCall(questionIds),
        name: c.name,
        detail: { type: "unknown", input: { expectedRevision: 1, sessionId: "s1", questions: [{ title: SECRET_TITLE, options: [] }] }, output },
      });
      const deliver = (toolCall: unknown) =>
        fake.deliver(id, { ...streamEvent(id, toolCall), event: { type: "timeline", provider: c.provider, item: toolCall, turnId: "turn-1" } });

      deliver(item(c.malformed)); // malformed or error envelope: skipped
      deliver(item(c.output(["q99"]), ["q99"])); // absent from the store: skipped
      deliver(item(c.output(["q1"])));
      await vi.waitFor(() => expect(fake.appends.length).toBeGreaterThan(0));
      await settle();
      expect(fake.appends).toEqual([{ agentId: id, item: rowFor("q1") }]);
      expect(new Set(fake.refs)).toEqual(new Set([id]));
    });
  }
});

describe("protocol-invalid live payloads (T5.5, installed AgentStreamMessageSchema)", () => {
  it("payloads the installed agent_stream schema rejects append nothing; a valid one in the same stream does", async () => {
    const project = await optedIn();
    const { fake, server } = observe(project);
    const id = agentId("schema");
    await server.emit("agent.turn_started", { agent: hookAgent(id, project.root), turnId: "turn-1" });
    await vi.waitFor(() => expect(fake.active(id)).toBe(1));

    const payloadSchema = AgentStreamMessageSchema.shape.payload;
    const valid = streamEvent(id, askCall(["q1"]));
    expect(payloadSchema.safeParse(valid).success).toBe(true);
    const { timestamp: _timestamp, ...missingTimestamp } = streamEvent(id, askCall(["q2"]));
    const { callId: _callId, ...itemWithoutCallId } = askCall(["q2"]);
    const invalid: Record<string, unknown> = {
      "missing timestamp": missingTimestamp,
      "numeric timestamp": { ...streamEvent(id, askCall(["q2"])), timestamp: 1_700_000_000 },
      "numeric provider": { ...streamEvent(id, askCall(["q2"])), event: { type: "timeline", provider: 7, item: askCall(["q2"]), turnId: "turn-1" } },
      "item missing callId": streamEvent(id, itemWithoutCallId),
    };
    for (const [label, payload] of Object.entries(invalid)) {
      expect(payloadSchema.safeParse(payload).success, `${label} must be schema-invalid`).toBe(false);
      fake.deliver(id, payload);
    }
    fake.deliver(id, valid);
    await vi.waitFor(() => expect(fake.appends.length).toBeGreaterThan(0));
    await settle();
    expect(fake.appends).toEqual([{ agentId: id, item: rowFor("q1") }]);
  });
});

describe("replay (T5.5)", () => {
  it("turn_ended folded history and a fresh observer only re-append the same id with identical data", async () => {
    const project = await optedIn();
    const fake = fakePaseo();
    const first = observe(project, { fake });
    const id = agentId(3);
    await first.server.emit("agent.turn_started", { agent: hookAgent(id, project.root), turnId: "turn-1" });
    await vi.waitFor(() => expect(fake.active(id)).toBe(1));
    fake.deliver(id, streamEvent(id, askCall(["q1"])));
    await vi.waitFor(() => expect(fake.appends).toHaveLength(1));

    const ended = { agent: hookAgent(id, project.root), turnId: "turn-1", outcome: { kind: "completed" }, timeline: [askCall(["q1"])] };
    await first.server.emit("agent.turn_ended", ended);
    const second = observe(project, { fake }); // a new process lifetime over the same host
    await second.server.emit("agent.turn_ended", ended);
    await vi.waitFor(() => expect(fake.appends.length).toBeGreaterThanOrEqual(2));
    await settle();
    for (const a of fake.appends) expect(a).toEqual({ agentId: id, item: rowFor("q1") });
  });
});

describe("reconnect (T5.5)", () => {
  it("subscription_restored and replacement each trigger one refetch scan through the same validation", async () => {
    const project = await optedIn();
    const { fake, server } = observe(project);
    const id = agentId(4);
    fake.setRefetchEntries(() => [askCall(["q2"]), askCall(["q99"]), askCall(["q1"], "failed")]);
    await server.emit("agent.turn_started", { agent: hookAgent(id, project.root), turnId: "turn-1" });
    await vi.waitFor(() => expect(fake.active(id)).toBe(1));

    fake.deliver(id, { agentId: id, subscriptionId: "sub-1", event: { type: "subscription_restored" } });
    await vi.waitFor(() => expect(fake.refetches).toHaveLength(1));
    await vi.waitFor(() => expect(fake.appends.length).toBeGreaterThan(0));
    fake.deliver(id, { agentId: id, event: { type: "replacement", epoch: "epoch-2" } });
    await vi.waitFor(() => expect(fake.refetches).toHaveLength(2));
    await settle();
    expect(fake.refetches).toEqual([id, id]);
    for (const a of fake.appends) expect(a).toEqual({ agentId: id, item: rowFor("q2") });
  });
});

describe("cleanup and cap (T5.5)", () => {
  it("removes subscriptions on turn_ended, archived, closed, subscription error and plugin cleanup", async () => {
    const project = await optedIn();
    const { fake, server, stop } = observe(project);
    const ids = ["ended", "archived", "closed", "error", "plugin"].map(agentId);
    for (const id of ids) await server.emit("agent.turn_started", { agent: hookAgent(id, project.root), turnId: "turn-1" });
    await vi.waitFor(() => ids.forEach((id) => expect(fake.active(id)).toBe(1)));

    await server.emit("agent.turn_ended", { agent: hookAgent(ids[0], project.root), turnId: "turn-1", outcome: { kind: "completed" }, timeline: [] });
    await server.emit("agent.archived", { agent: hookAgent(ids[1], project.root), archivedAt: NOW_ISO });
    await server.emit("agent.closed", { agent: hookAgent(ids[2], project.root) });
    await vi.waitFor(() => [ids[0], ids[1], ids[2]].forEach((id) => expect(fake.active(id), id).toBe(0)));

    // The host releases an errored observation; the plugin must forget it so the next turn re-subscribes.
    fake.deliver(ids[3], { agentId: ids[3], event: { type: "error", error: "synthetic failure" } });
    await settle();
    await server.emit("agent.turn_started", { agent: hookAgent(ids[3], project.root), turnId: "turn-2" });
    await vi.waitFor(() => expect(fake.subscribed(ids[3])).toBe(2));

    await stop();
    for (const id of ids) expect(fake.active(id), id).toBe(0);
  });

  it("caps live subscriptions at 32; the 33rd agent is still covered by its turn_ended scan", async () => {
    const project = await optedIn();
    const { fake, server, logs } = observe(project);
    const ids = Array.from({ length: 33 }, (_, i) => agentId(`cap${i}`));
    for (const id of ids) await server.emit("agent.turn_started", { agent: hookAgent(id, project.root), turnId: "turn-1" });
    await settle();
    expect(fake.subs.filter((s) => s.active)).toHaveLength(32);
    const uncovered = ids.filter((id) => fake.subscribed(id) === 0);
    expect(uncovered).toHaveLength(1);

    await server.emit("agent.turn_ended", {
      agent: hookAgent(uncovered[0], project.root),
      turnId: "turn-1",
      outcome: { kind: "completed" },
      timeline: [askCall(["q1"])],
    });
    await vi.waitFor(() => expect(fake.appends.filter((a) => a.agentId === uncovered[0])).toHaveLength(1));
    expect(fake.appends.find((a) => a.agentId === uncovered[0])?.item).toEqual(rowFor("q1"));
    expect(logs.length).toBeGreaterThan(0); // the cap is logged
  });
});

describe("establishment failure, opt-in recheck and append failure (KensAI c0090, c0088, c0092)", () => {
  it("releases an assigned handle whose ready rejects, and cleanup leaves none active (c0090)", async () => {
    const project = await optedIn();
    const { fake, server, stop } = observe(project);
    const failing = agentId("ready-reject");
    const ordinary = agentId("ready-ok");
    fake.faults.rejectReady.add(failing);
    await server.emit("agent.turn_started", { agent: hookAgent(failing, project.root), turnId: "turn-1" });
    await server.emit("agent.turn_started", { agent: hookAgent(ordinary, project.root), turnId: "turn-1" });
    await vi.waitFor(() => expect(fake.active(ordinary)).toBe(1));
    await settle();
    expect(fake.subscribed(failing), "the handle was assigned before ready rejected").toBe(1);
    expect(fake.active(failing), "a handle whose establishment failed must be released").toBe(0);
    await stop();
    expect(fake.active(failing)).toBe(0);
    expect(fake.active(ordinary)).toBe(0);
  });

  it("re-checks opt-in on every scan: disabling the store after subscribing stops new rows (c0088)", async () => {
    const project = await optedIn();
    const { fake, server } = observe(project);
    const id = agentId("disable-later");
    await server.emit("agent.turn_started", { agent: hookAgent(id, project.root), turnId: "turn-1" });
    await vi.waitFor(() => expect(fake.active(id)).toBe(1));
    fake.deliver(id, streamEvent(id, askCall(["q1"])));
    await vi.waitFor(() => expect(fake.appends).toHaveLength(1));

    const manifest = join(project.root, ".decisions", "manifest.json");
    await writeFile(manifest, JSON.stringify({ ...JSON.parse(await readFile(manifest, "utf8")), disabled: true }));
    fake.deliver(id, streamEvent(id, askCall(["q2"]))); // q2 exists in the store
    await settle();
    expect(fake.appends).toEqual([{ agentId: id, item: rowFor("q1") }]);
  });

  it("a failed append is logged once and not retried; a later delivery appends the same row (c0092)", async () => {
    const project = await optedIn();
    const { fake, server, logs } = observe(project);
    const id = agentId("append-fails");
    await server.emit("agent.turn_started", { agent: hookAgent(id, project.root), turnId: "turn-1" });
    await vi.waitFor(() => expect(fake.active(id)).toBe(1));

    fake.faults.failAppends = 1;
    fake.deliver(id, streamEvent(id, askCall(["q1"])));
    await vi.waitFor(() => expect(fake.appendAttempts).toHaveLength(1));
    await settle();
    expect(fake.appends).toHaveLength(0);
    expect(fake.appendAttempts, "no automatic retry").toEqual([id]);

    fake.deliver(id, streamEvent(id, askCall(["q1"])));
    await vi.waitFor(() => expect(fake.appends).toHaveLength(1));
    await settle();
    expect(fake.appends).toEqual([{ agentId: id, item: rowFor("q1") }]);
    expect(fake.appendAttempts).toEqual([id, id]);
    expect(logs.filter((line) => /append/i.test(line) && /fail/i.test(line))).toHaveLength(1);
  });
});

describe("redaction (T5.5)", () => {
  it("logs carry no question text, tool output or full agent ids", async () => {
    const project = await optedIn();
    const { fake, server, logs } = observe(project, { maxSubscriptions: 1 });
    const [a, b] = [agentId("redact-a"), agentId("redact-b")];
    await server.emit("agent.turn_started", { agent: hookAgent(a, project.root), turnId: "turn-1" });
    await server.emit("agent.turn_started", { agent: hookAgent(b, project.root), turnId: "turn-1" }); // over the cap
    await vi.waitFor(() => expect(fake.active(a)).toBe(1));
    fake.deliver(a, streamEvent(a, askCall(["q1"])));
    fake.deliver(a, streamEvent(a, { ...askCall(["q1"]), detail: { type: "unknown", input: { sessionId: "s1" }, output: `{ ${OUTPUT_MARKER}` } }));
    fake.deliver(a, { agentId: a, event: { type: "error", error: "synthetic failure" } });
    await settle();
    expect(logs.length).toBeGreaterThan(0);
    for (const line of logs) {
      expect(line).not.toContain(SECRET_TITLE);
      expect(line).not.toContain(OUTPUT_MARKER);
      expect(line).not.toContain(ID_MARKER);
    }
  });
});

// Stage R3.5 (card §6.2a "Timeline run rows"): the same observer appends a reference-only run row
// for a completed run-scoped tool call whose runId is a canonical `data.runs` record; once per agent
// and run; a failed append is logged and retried by a later scan. Question-row controls above stay.
const RUN_TOKEN_MARKER = "RUN-TOKEN-MARKER-8821";
const runCall = (tool: string, runId: string, status: "running" | "completed" | "failed" = "completed") => ({
  type: "tool_call",
  callId: `call-${tool}-${runId}`,
  name: `mcp__decision-roadmap__${tool}`,
  detail: {
    type: "unknown",
    input: { runId, runToken: RUN_TOKEN_MARKER, taskId: "t1" },
    output: JSON.stringify({ revision: 3, ready: ["t1"], note: OUTPUT_MARKER }),
  },
  status,
  error: status === "failed" ? { message: "boom" } : null,
});
const runRow = (runId: string) => ({ type: "plugin", id: `run.${runId}`, kind: "decision-run", version: 1, data: { projectId: "prj_test", runId } });

/** Opted-in project with a canonical run `run-1` (prompt-like event detail included, never copied). */
async function withRun(): Promise<TestProject> {
  const project = await optedIn();
  const store = openStore({ storeRoot: project.root, projectId: "prj_test", now: fixedClock, newId: nextId, log: () => undefined });
  const read = await store.read();
  if (read.status !== "ok") throw new Error("store not ok");
  await store.transact(read.revision, (d) => {
    d.runs.push({
      id: "run-1", featureId: "f-1", planId: "plan-1", planRev: 1, runToken: RUN_TOKEN_MARKER, state: "running", startAuth: { kind: "ui", at: NOW_ISO },
      tasks: [{ taskId: "t1", state: "in_progress", agentId: "agent-w", failedCycles: 0, extraBudget: 0, unresolved: [] }],
      acks: [], events: [{ at: NOW_ISO, kind: "started", detail: OUTPUT_MARKER }], lateEvidence: [],
    });
  });
  return project;
}

describe("R3.5 run rows", () => {
  it("a completed run-scoped call for a canonical run appends one ref-only row; unknown runs, running calls and roadmap_start append nothing; repeats fold", async () => {
    const project = await withRun();
    const { fake, server } = observe(project);
    const id = agentId("run-live");
    await server.emit("agent.turn_started", { agent: hookAgent(id, project.root), turnId: "turn-1" });
    await vi.waitFor(() => expect(fake.active(id)).toBe(1));
    fake.deliver(id, streamEvent(id, runCall("roadmap_run_next", "run-404")));
    fake.deliver(id, streamEvent(id, runCall("roadmap_task_claim", "run-1", "running")));
    fake.deliver(id, streamEvent(id, runCall("roadmap_start", "run-1")));
    fake.deliver(id, streamEvent(id, runCall("roadmap_run_next", "run-1")));
    await vi.waitFor(() => expect(fake.appends.length).toBeGreaterThan(0));
    fake.deliver(id, streamEvent(id, runCall("roadmap_task_progress", "run-1")));
    fake.deliver(id, streamEvent(id, runCall("roadmap_run_ack", "run-1")));
    await settle();
    expect(fake.appends, "once per agent and run").toEqual([{ agentId: id, item: runRow("run-1") }]);
    const text = JSON.stringify(fake.appends);
    for (const secret of [RUN_TOKEN_MARKER, OUTPUT_MARKER, "t1", "agent-w"]) expect(text, secret).not.toContain(secret);
  });

  it("subscription_restored refetch appends the canonical run row once; question rows still append alongside", async () => {
    const project = await withRun();
    const { fake, server } = observe(project);
    const id = agentId("run-refetch");
    fake.setRefetchEntries(() => [runCall("roadmap_task_claim", "run-1"), runCall("roadmap_task_claim", "run-1"), runCall("roadmap_run_next", "run-404"), askCall(["q2"])]);
    await server.emit("agent.turn_started", { agent: hookAgent(id, project.root), turnId: "turn-1" });
    await vi.waitFor(() => expect(fake.active(id)).toBe(1));
    fake.deliver(id, { agentId: id, subscriptionId: "sub-1", event: { type: "subscription_restored" } });
    await vi.waitFor(() => expect(fake.appends.length).toBeGreaterThanOrEqual(2));
    await settle();
    expect(fake.appends.filter((a) => a.item.kind === "decision-run")).toEqual([{ agentId: id, item: runRow("run-1") }]);
    expect(fake.appends.filter((a) => a.item.kind === "decision-question")).toEqual([{ agentId: id, item: rowFor("q2") }]);
  });

  it("a failed run-row append is logged, never thrown, and a later scan appends it", async () => {
    const project = await withRun();
    const { fake, server, logs } = observe(project);
    const id = agentId("run-append-fails");
    await server.emit("agent.turn_started", { agent: hookAgent(id, project.root), turnId: "turn-1" });
    await vi.waitFor(() => expect(fake.active(id)).toBe(1));
    fake.faults.failAppends = 1;
    fake.deliver(id, streamEvent(id, runCall("roadmap_run_next", "run-1")));
    await vi.waitFor(() => expect(fake.appendAttempts).toHaveLength(1));
    await settle();
    expect(fake.appends).toHaveLength(0);
    expect(logs.filter((line) => /append/i.test(line) && /fail/i.test(line))).toHaveLength(1);
    fake.deliver(id, streamEvent(id, runCall("roadmap_run_next", "run-1")));
    await vi.waitFor(() => expect(fake.appends).toHaveLength(1));
    expect(fake.appends).toEqual([{ agentId: id, item: runRow("run-1") }]);
  });

  it("a run call outside an opted-in project appends nothing (opt-in precedes run lookup)", async () => {
    const project = await withRun();
    const { fake, server } = observe(project);
    const manifest = join(project.root, ".decisions", "manifest.json");
    await writeFile(manifest, JSON.stringify({ ...JSON.parse(await readFile(manifest, "utf8")), disabled: true }));
    await server.emit("agent.turn_started", { agent: hookAgent(agentId("run-disabled"), project.root), turnId: null });
    await settle();
    expect(fake.subs).toHaveLength(0);
    expect(fake.appends).toHaveLength(0);
  });
});
