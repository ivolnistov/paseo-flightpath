// Automatic grilling S1/G2 (task card §3.2, §3.4 S1–S17, TR6, TR7): the first roadmap_ask with a
// caller binds the planner; other callers, unbound grants and the UI never bind; ordinary writes
// leave the grilling fields untouched; the UI-only rebind bumps the epoch, keeps the history and
// supersedes a live continuation; the UI-only reopen; the service resolves the workspace from the
// host; and both RPCs are routed. Real temp stores, synthetic data, the real commands.
//
// Negative cases ("never binds") carry a positive anchor in the same case, so they are RED until
// binding exists and then prove the negative for the right reason.
import type { PaseoApi } from "@getpaseo/client";
import type { PluginRpcContract } from "@getpaseo/plugin";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalJson } from "../shared/canonical";
import type { Option, Ref, Session } from "../shared/model";
import { registerHandlers } from "./handlers";
import { buildTools } from "./mcp-tools";
import { createPaseoHolder } from "./paseo-holder";
import {
  createRoadmapCommands,
  createRoadmapService,
  UI_ORIGIN,
  type PlannerCaller,
  type RoadmapService,
  type StoreOpener,
  type WriteOrigin,
} from "./sessions";
import { openProjectStore } from "./store-root";
import { fixedClock, NOW, nextId, opt } from "./test-support/build";
import { fakeDirectory } from "./test-support/fake-dir";
import {
  binding,
  BLK_NEXT,
  BLK_OPEN,
  blocksFor,
  continuationIn,
  grillingFields,
  isPostAccept,
  LIVE_STATES,
  need,
  OP,
  OTHER_AGENT,
  PLANNER,
  seedGrilling,
  SHORT_AGENT,
  TERMINAL_STATES,
  UUID_AGENT,
  type Binding,
} from "./test-support/grilling";
import { err, makeProject, ok, type TestProject } from "./test-support/service";

const P = "prj_test";
const T1 = NOW.toISOString();
const T2 = "2026-10-20T11:00:00.000Z";
const ab: Option[] = [opt("a"), opt("b")];
const chat = (agentId?: string, quoted = "Use A"): WriteOrigin => ({
  source: "chat",
  actor: agentId !== undefined ? { kind: "agent", agentId } : { kind: "agent" },
  quoted,
});
const caller = (agentId = PLANNER, workspaceId: string | null = "ws-1"): PlannerCaller => ({ agentId, workspaceId });
const bq = (title: string, extra: Partial<{ allowFreeText: boolean; invalidatedBy: Array<{ upstream: Ref | { batchIndex: number } }> }> = {}) => ({
  title,
  context: "",
  options: ab,
  allowFreeText: extra.allowFreeText ?? false,
  activatedBy: [],
  invalidatedBy: extra.invalidatedBy ?? [],
});

let project: TestProject | undefined;
let clock = new Date(T1);
afterEach(async () => {
  await project?.cleanup();
  project = undefined;
});

async function setup() {
  clock = new Date(T1);
  project = await makeProject();
  const proj = project;
  const dir = fakeDirectory({ projects: [{ projectId: P, projectRootPath: proj.root, projectKind: "git" }] });
  const storeOptions = { now: fixedClock, newId: nextId, log: (m: string, e?: unknown) => void proj.logs.push([m, e]) };
  const deps = { directory: () => dir, now: () => clock, newId: nextId, storeOptions };
  const commands = createRoadmapCommands(deps);
  const open: StoreOpener = (projectId) => openProjectStore(dir, projectId, storeOptions);
  ok(await commands.init(open, { projectId: P }, UI_ORIGIN));

  const revision = async () => ok(await commands.version(open, { projectId: P }, UI_ORIGIN)).revision!;
  const data = async () => {
    const read = await (await open(P)).read();
    if (read.status !== "ok") throw new Error(`expected an ok store, got ${read.status}`);
    return read.data;
  };
  const sessionOf = async (sessionId: string): Promise<Session> => {
    const s = (await data()).sessions.find((x) => x.id === sessionId);
    if (s === undefined) throw new Error(`session ${sessionId} not found`);
    return s;
  };
  const newSession = async (title = "Grilling") =>
    ok(await commands.sessionCreate(open, { projectId: P, expectedRevision: await revision(), title }, UI_ORIGIN)).sessionId;
  const ask = async (
    sessionId: string,
    o: { caller?: PlannerCaller; origin?: WriteOrigin; blockId?: string; questions?: Array<ReturnType<typeof bq>> } = {},
  ) =>
    commands.questionCreateBatch(
      open,
      { projectId: P, expectedRevision: await revision(), sessionId, blockId: o.blockId ?? BLK_OPEN, questions: o.questions ?? [bq("Q")] },
      o.origin ?? chat(o.caller?.agentId),
      o.caller,
    );
  const plannerSet = async (sessionId: string, agentId: string, workspaceId: string | null, origin: WriteOrigin = UI_ORIGIN, expectedRevision?: number) => {
    need(commands.plannerSet, "createRoadmapCommands().plannerSet");
    return commands.plannerSet(open, { projectId: P, sessionId, expectedRevision: expectedRevision ?? (await revision()), agentId, workspaceId }, origin);
  };
  const reopen = async (sessionId: string, origin: WriteOrigin = UI_ORIGIN) => {
    need(commands.sessionReopen, "createRoadmapCommands().sessionReopen");
    return commands.sessionReopen(open, { projectId: P, sessionId, expectedRevision: await revision() }, origin);
  };
  /** A session with one question in `blk-open` (written without a caller), optionally seeded. */
  const seededSession = async (patch: Parameters<typeof seedGrilling>[3] = {}) => {
    const sessionId = await newSession();
    ok(await ask(sessionId, { origin: chat() }));
    if (Object.keys(patch).length > 0) await seedGrilling(open, P, sessionId, patch);
    return sessionId;
  };
  return { proj, dir, deps, storeOptions, commands, open, revision, data, sessionOf, newSession, ask, plannerSet, reopen, seededSession };
}

const expectBinding = (s: Session, expected: Binding) => {
  expect(s.planner, "stored planner binding").toEqual(expected);
};

describe("S1–S5 binding on roadmap_ask", () => {
  it("S1: the first ask with a caller into an empty session binds exactly that caller, boundBy ask, epoch 1, no history", async () => {
    const t = await setup();
    const sid = await t.newSession();
    ok(await t.ask(sid, { caller: caller() }));
    const s = await t.sessionOf(sid);
    expectBinding(s, { agentId: PLANNER, workspaceId: "ws-1", boundAt: T1, boundBy: "ask", epoch: 1 });
    expect("plannerHistory" in s).toBe(false);
    expect(s.blocks?.map((b) => b.id)).toEqual([BLK_OPEN]);
  });

  it("S2: a null workspaceId is stored as null; one-character and UUID-shaped agent ids bind as given (TR7)", async () => {
    const t = await setup();
    const s1 = await t.newSession("null workspace");
    ok(await t.ask(s1, { caller: caller(SHORT_AGENT, null) }));
    expectBinding(await t.sessionOf(s1), { agentId: SHORT_AGENT, workspaceId: null, boundAt: T1, boundBy: "ask", epoch: 1 });
    const s2 = await t.newSession("uuid agent");
    ok(await t.ask(s2, { caller: caller(UUID_AGENT, "ws-uuid") }));
    expectBinding(await t.sessionOf(s2), { agentId: UUID_AGENT, workspaceId: "ws-uuid", boundAt: T1, boundBy: "ask", epoch: 1 });
  });

  it("S3: a second caller's ask writes its questions and leaves the planner unchanged", async () => {
    const t = await setup();
    const sid = await t.newSession();
    ok(await t.ask(sid, { caller: caller() }));
    const before = await t.sessionOf(sid);
    expectBinding(before, binding());
    clock = new Date(T2);
    const out = ok(await t.ask(sid, { caller: caller(OTHER_AGENT, "ws-2"), questions: [bq("B1"), bq("B2")] }));
    expect(out.questionIds).toHaveLength(2);
    const after = await t.sessionOf(sid);
    expect(after.questions).toHaveLength(3);
    expect(canonicalJson(after.planner)).toBe(canonicalJson(before.planner));
    expect("plannerHistory" in after).toBe(false);
  });

  it("S4: an ask without a caller never binds (with or without an origin agent id); a later ask with a caller is the first binding", async () => {
    const t = await setup();
    const sid = await t.newSession();
    ok(await t.ask(sid, { origin: chat() }));
    expect("planner" in (await t.sessionOf(sid))).toBe(false);
    ok(await t.ask(sid, { origin: chat(OTHER_AGENT) }));
    expect("planner" in (await t.sessionOf(sid)), "the origin's agentId is not a binding input (TR6)").toBe(false);
    clock = new Date(T2);
    ok(await t.ask(sid, { caller: caller() }));
    expectBinding(await t.sessionOf(sid), { agentId: PLANNER, workspaceId: "ws-1", boundAt: T2, boundBy: "ask", epoch: 1 });
  });

  it("S5: the UI question.create never binds; a later ask with a caller is the first binding", async () => {
    const t = await setup();
    const sid = await t.newSession();
    ok(
      await t.commands.questionCreate(
        t.open,
        { projectId: P, expectedRevision: await t.revision(), sessionId: sid, blockId: BLK_OPEN, title: "UI", context: "", options: ab, allowFreeText: false, activatedBy: [], invalidatedBy: [] },
        UI_ORIGIN,
      ),
    );
    expect("planner" in (await t.sessionOf(sid))).toBe(false);
    ok(await t.ask(sid, { caller: caller(SHORT_AGENT) }));
    expectBinding(await t.sessionOf(sid), { agentId: SHORT_AGENT, workspaceId: "ws-1", boundAt: T1, boundBy: "ask", epoch: 1 });
  });
});

describe("S6 ordinary writes never touch the grilling fields", () => {
  it("answer, confirm, skip, discuss, update, relation add/remove, link create/delete, decision cancel and block accept keep planner, history, continuation and continuations canonical-equal", async () => {
    const t = await setup();
    const other = await t.newSession("Other");
    const sid = await t.newSession();
    ok(await t.ask(sid, { origin: chat(), questions: [bq("Frozen")] }));
    await seedGrilling(t.open, P, sid, { blocks: blocksFor(true) });
    const created = ok(
      await t.ask(sid, {
        origin: chat(),
        blockId: BLK_NEXT,
        questions: [bq("Q1"), bq("Q2", { invalidatedBy: [{ upstream: { batchIndex: 0 } }] }), bq("Q3", { allowFreeText: true })],
      }),
    );
    const [q1, q2, q3] = created.questionIds;
    // A live continuation of the planner; `resolving` is post-Accept, so its openBlockId is the
    // accepted blk-open and accepting blk-next later is "another block" in every stage.
    const planner = binding({ epoch: 2, boundBy: "ui", agentId: PLANNER });
    await seedGrilling(t.open, P, sid, {
      planner,
      plannerHistory: [binding({ agentId: "agent-old" })],
      continuation: continuationIn("resolving", { target: { agentId: PLANNER, epoch: 2 } }),
      continuations: [continuationIn("pause_lost", { operationId: "op-0", target: { agentId: "agent-old", epoch: 1 }, reason: "no_pause" })],
    });
    const seeded = grillingFields(await t.sessionOf(sid));
    expect(seeded).toContain("resolving");
    const ref = (questionId: string) => ({ sessionId: sid, questionId });
    const steps: Array<[string, () => Promise<{ ok: boolean }>]> = [
      ["answer (chat, quoted)", async () => t.commands.questionAnswer(t.open, { projectId: P, expectedRevision: await t.revision(), ...ref(q1), optionId: "a" }, chat(PLANNER, "A"))],
      ["answer (ui)", async () => t.commands.questionAnswer(t.open, { projectId: P, expectedRevision: await t.revision(), ...ref(q2), optionId: "a" }, UI_ORIGIN)],
      ["re-answer marks stale", async () => t.commands.questionAnswer(t.open, { projectId: P, expectedRevision: await t.revision(), ...ref(q1), optionId: "b" }, UI_ORIGIN)],
      ["confirm", async () => t.commands.questionConfirm(t.open, { projectId: P, expectedRevision: await t.revision(), ...ref(q2) }, chat(PLANNER, "Still A"))],
      ["discuss", async () => t.commands.questionDiscuss(t.open, { projectId: P, expectedRevision: await t.revision(), ...ref(q1), text: "note" }, chat(PLANNER))],
      ["update", async () => t.commands.questionUpdate(t.open, { projectId: P, expectedRevision: await t.revision(), ...ref(q1), patch: { title: "Q1 edited" } }, chat(PLANNER))],
      [
        "relation add",
        async () =>
          t.commands.relationAdd(t.open, { projectId: P, expectedRevision: await t.revision(), relation: { kind: "invalidation", target: ref(q3), invalidation: { upstream: ref(q1) } } }, UI_ORIGIN),
      ],
      [
        "relation remove",
        async () =>
          t.commands.relationRemove(t.open, { projectId: P, expectedRevision: await t.revision(), relation: { kind: "invalidation", target: ref(q3), invalidation: { upstream: ref(q1) } } }, UI_ORIGIN),
      ],
      ["skip", async () => t.commands.questionSkip(t.open, { projectId: P, expectedRevision: await t.revision(), ...ref(q3) }, UI_ORIGIN)],
      ["link create", async () => t.commands.linkCreate(t.open, { projectId: P, expectedRevision: await t.revision(), kind: "informs", from: { sessionId: sid }, to: { sessionId: other } }, chat(PLANNER))],
      [
        "link delete",
        async () => {
          const linkId = (await t.data()).meta.links[0].id;
          return t.commands.linkDelete(t.open, { projectId: P, expectedRevision: await t.revision(), linkId }, UI_ORIGIN);
        },
      ],
      ["decision cancel", async () => t.commands.decisionCancel(t.open, { projectId: P, expectedRevision: await t.revision(), ...ref(q3), reason: "not needed" }, UI_ORIGIN)],
      ["block accept (blk-next)", async () => t.commands.blockAccept(t.open, { projectId: P, expectedRevision: await t.revision(), sessionId: sid, blockId: BLK_NEXT }, UI_ORIGIN)],
    ];
    for (const [name, step] of steps) {
      const out = await step();
      expect(out.ok, `${name} succeeds`).toBe(true);
      expect(grillingFields(await t.sessionOf(sid)), `${name} leaves the grilling fields unchanged`).toBe(seeded);
    }
    expect((await t.sessionOf(sid)).blocks?.filter((b) => b.state === "accepted").map((b) => b.id)).toEqual([BLK_OPEN, BLK_NEXT]);
  });
});

describe("S7 the roadmap_ask MCP tool passes the grant's agent as caller", () => {
  const askTool = (t: Awaited<ReturnType<typeof setup>>) => {
    const tool = buildTools(t.commands).find((x) => x.name === "roadmap_ask");
    if (tool === undefined) throw new Error("roadmap_ask missing");
    return tool;
  };
  const args = async (t: Awaited<ReturnType<typeof setup>>, sessionId: string) => ({
    expectedRevision: await t.revision(),
    sessionId,
    blockId: BLK_OPEN,
    questions: [bq("Via MCP")],
  });

  it("ctx { agentId, workspaceId } binds that agent and workspace; an absent workspaceId binds null", async () => {
    const t = await setup();
    const tool = askTool(t);
    const s1 = await t.newSession("ws");
    ok(await tool.run(await args(t, s1), { open: t.open, projectId: P, origin: chat(PLANNER), agentId: PLANNER, workspaceId: "ws-7" }));
    expectBinding(await t.sessionOf(s1), { agentId: PLANNER, workspaceId: "ws-7", boundAt: T1, boundBy: "ask", epoch: 1 });
    const s2 = await t.newSession("no ws");
    ok(await tool.run(await args(t, s2), { open: t.open, projectId: P, origin: chat(UUID_AGENT), agentId: UUID_AGENT }));
    expectBinding(await t.sessionOf(s2), { agentId: UUID_AGENT, workspaceId: null, boundAt: T1, boundBy: "ask", epoch: 1 });
  });

  it("ctx without agentId (unbound grant) does not bind; the same tool with an agentId then binds", async () => {
    const t = await setup();
    const tool = askTool(t);
    const sid = await t.newSession();
    ok(await tool.run(await args(t, sid), { open: t.open, projectId: P, origin: chat(), workspaceId: "ws-1" }));
    expect("planner" in (await t.sessionOf(sid))).toBe(false);
    ok(await tool.run(await args(t, sid), { open: t.open, projectId: P, origin: chat(PLANNER), agentId: PLANNER, workspaceId: null }));
    expectBinding(await t.sessionOf(sid), { agentId: PLANNER, workspaceId: null, boundAt: T1, boundBy: "ask", epoch: 1 });
  });
});

describe("S8–S14 session.planner.set (UI-only rebind)", () => {
  it("S8: on an unbound session binds epoch 1 with boundBy ui and returns { revision, epoch: 1 }", async () => {
    const t = await setup();
    const sid = await t.seededSession();
    const before = await t.revision();
    const out = ok(await t.plannerSet(sid, SHORT_AGENT, "ws-1"));
    expect(out).toEqual({ revision: before + 1, epoch: 1 });
    expectBinding(await t.sessionOf(sid), { agentId: SHORT_AGENT, workspaceId: "ws-1", boundAt: T1, boundBy: "ui", epoch: 1 });
  });

  it("S9: a rebind bumps the epoch, appends the previous binding verbatim to plannerHistory and stamps boundAt now", async () => {
    const t = await setup();
    const sid = await t.newSession();
    ok(await t.ask(sid, { caller: caller() }));
    const first = (await t.sessionOf(sid)).planner;
    clock = new Date(T2);
    expect(ok(await t.plannerSet(sid, UUID_AGENT, null)).epoch).toBe(2);
    const s = await t.sessionOf(sid);
    expectBinding(s, { agentId: UUID_AGENT, workspaceId: null, boundAt: T2, boundBy: "ui", epoch: 2 });
    expect(s.plannerHistory).toEqual([first]);
    expect(first).toEqual({ agentId: PLANNER, workspaceId: "ws-1", boundAt: T1, boundBy: "ask", epoch: 1 });
    expect(ok(await t.plannerSet(sid, PLANNER, "ws-3")).epoch).toBe(3);
    const s3 = await t.sessionOf(sid);
    expect(s3.plannerHistory).toEqual([first, s.planner]);
    expect(s3.planner?.epoch).toBe(3);
  });

  it.each(LIVE_STATES)("S10: a rebind while %s supersedes the continuation in place (reason rebind, at now), changing nothing else", async (state) => {
    const t = await setup();
    const seeded = continuationIn(state);
    const sid = await t.seededSession({ planner: binding(), continuation: seeded, ...(isPostAccept(state) ? { blocks: blocksFor(true) } : {}) });
    clock = new Date(T2);
    expect(ok(await t.plannerSet(sid, OTHER_AGENT, "ws-2"))).toMatchObject({ epoch: 2 });
    const s = await t.sessionOf(sid);
    expect(s.continuation).toEqual({ ...seeded, state: "superseded", reason: "rebind", at: T2 });
    expect((s.continuations ?? []).some((c) => c.operationId === OP), "not moved to history").toBe(false);
    expectBinding(s, { agentId: OTHER_AGENT, workspaceId: "ws-2", boundAt: T2, boundBy: "ui", epoch: 2 });
    expect(s.plannerHistory).toEqual([binding()]);
  });

  it("S11: a rebind with a terminal continuation leaves it byte-unchanged", async () => {
    const t = await setup();
    for (const state of TERMINAL_STATES) {
      const sid = await t.seededSession({ planner: binding(), continuation: continuationIn(state, { reason: `was-${state}` }), ...(isPostAccept(state) ? { blocks: blocksFor(true) } : {}) });
      const before = canonicalJson((await t.sessionOf(sid)).continuation);
      ok(await t.plannerSet(sid, OTHER_AGENT, null));
      const s = await t.sessionOf(sid);
      expect(canonicalJson(s.continuation), state).toBe(before);
      expect(s.planner?.epoch, state).toBe(2);
    }
  });

  it("S12: a chat origin is invalid_input and writes nothing", async () => {
    const t = await setup();
    const sid = await t.seededSession({ planner: binding() });
    const before = await t.revision();
    const fields = grillingFields(await t.sessionOf(sid));
    expect(err(await t.plannerSet(sid, OTHER_AGENT, null, chat(PLANNER))).code).toBe("invalid_input");
    expect(err(await t.plannerSet(sid, PLANNER, null, chat())).code).toBe("invalid_input");
    expect(await t.revision()).toBe(before);
    expect(grillingFields(await t.sessionOf(sid))).toBe(fields);
  });

  it("S13: an unknown session is not_found; S14: a stale expectedRevision is revision_conflict; neither writes", async () => {
    const t = await setup();
    const sid = await t.seededSession();
    const before = await t.revision();
    expect(err(await t.plannerSet("no-such-session", PLANNER, null)).code).toBe("not_found");
    expect(err(await t.plannerSet(sid, PLANNER, null, UI_ORIGIN, before - 1)).code).toBe("revision_conflict");
    expect(await t.revision()).toBe(before);
    expect("planner" in (await t.sessionOf(sid))).toBe(false);
  });
});

describe("S15 the service resolves the planner's workspace from the host", () => {
  function fakeAgents(snapshot: (agentId: string) => unknown) {
    const calls: string[] = [];
    const paseo = {
      agents: {
        ref: (agentId: string) => ({
          id: agentId,
          refresh: async () => {
            calls.push(agentId);
            return snapshot(agentId);
          },
        }),
      },
    };
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- partial PaseoApi test stub: only agents.ref().refresh exists
    return { paseo: paseo as unknown as PaseoApi, calls };
  }

  it("calls refresh once; null is not_found and archived is invalid_input, both without a write; otherwise binds the snapshot's workspace (undefined → null)", async () => {
    const t = await setup();
    const service = createRoadmapService(t.deps);
    const plannerSet = need(service.plannerSet, "createRoadmapService().plannerSet");
    const sid = await t.seededSession();
    const input = async (agentId: string) => ({ projectId: P, expectedRevision: await t.revision(), sessionId: sid, agentId });

    const missing = fakeAgents(() => null);
    const r0 = await t.revision();
    expect(err(await plannerSet(missing.paseo, await input("agent-gone"))).code).toBe("not_found");
    expect(missing.calls).toEqual(["agent-gone"]);
    expect(await t.revision()).toBe(r0);

    const archived = fakeAgents((id) => ({ agent: { id, workspaceId: "ws-9", archivedAt: "2026-10-19T10:00:00.000Z" }, project: null }));
    expect(err(await plannerSet(archived.paseo, await input("agent-archived"))).code).toBe("invalid_input");
    expect(archived.calls).toEqual(["agent-archived"]);
    expect(await t.revision()).toBe(r0);
    expect("planner" in (await t.sessionOf(sid))).toBe(false);

    const live = fakeAgents((id) => ({ agent: { id, workspaceId: "ws-9", archivedAt: null }, project: null }));
    expect(ok(await plannerSet(live.paseo, await input(PLANNER)))).toEqual({ revision: r0 + 1, epoch: 1 });
    expect(live.calls).toEqual([PLANNER]);
    expectBinding(await t.sessionOf(sid), { agentId: PLANNER, workspaceId: "ws-9", boundAt: T1, boundBy: "ui", epoch: 1 });

    const noWorkspace = fakeAgents((id) => ({ agent: { id, archivedAt: null }, project: null }));
    expect(ok(await plannerSet(noWorkspace.paseo, await input(SHORT_AGENT))).epoch).toBe(2);
    expect(noWorkspace.calls).toEqual([SHORT_AGENT]);
    expectBinding(await t.sessionOf(sid), { agentId: SHORT_AGENT, workspaceId: null, boundAt: T1, boundBy: "ui", epoch: 2 });
  });

  // Result boundary (root, same pattern as R4 c0124): a failing host read resolves a sanitised
  // internal Result like every other service method; it never rejects or leaks the raw error.
  it("a rejecting host refresh resolves { ok: false, internal } without the raw error, and writes nothing", async () => {
    const t = await setup();
    const service = createRoadmapService(t.deps);
    const plannerSet = need(service.plannerSet, "createRoadmapService().plannerSet");
    const sid = await t.seededSession({ planner: binding() });
    const before = { revision: await t.revision(), fields: grillingFields(await t.sessionOf(sid)) };
    const PRIVATE = "/synthetic-private/owner-home/.paseo/agents/agent-store.json";
    const failing = fakeAgents(() => {
      throw new Error(`synthetic host failure reading ${PRIVATE}`);
    });
    const outcome = await plannerSet(failing.paseo, { projectId: P, expectedRevision: before.revision, sessionId: sid, agentId: OTHER_AGENT }).then(
      (resolved) => ({ resolved }),
      (e: unknown) => ({ rejected: e instanceof Error ? e.message : String(e) }),
    );
    expect(outcome).toEqual({ resolved: { ok: false, error: { code: "internal", message: "Unexpected error; see plugin logs." } } });
    expect(JSON.stringify(outcome)).not.toContain("synthetic-private");
    expect(failing.calls).toEqual([OTHER_AGENT]);
    expect(await t.revision()).toBe(before.revision);
    expect(grillingFields(await t.sessionOf(sid))).toBe(before.fields);
  });
});

describe("S16 session.reopen (UI-only)", () => {
  it("reopens a closed session (+1 revision) and leaves its continuation unchanged; an active session or a chat origin is invalid_input", async () => {
    const t = await setup();
    const sid = await t.seededSession({ status: "closed", planner: binding(), continuation: continuationIn("complete") });
    const fields = grillingFields(await t.sessionOf(sid));
    const before = await t.revision();
    expect(err(await t.reopen(sid, chat(PLANNER))).code).toBe("invalid_input");
    expect(await t.revision()).toBe(before);
    expect(ok(await t.reopen(sid))).toEqual({ revision: before + 1 });
    const s = await t.sessionOf(sid);
    expect(s.status).toBe("active");
    expect(grillingFields(s)).toBe(fields);
    expect(err(await t.reopen(sid)).code).toBe("invalid_input");
    expect(await t.revision()).toBe(before + 1);
  });

  // S1 KensAI c0001/c0002 (dispositioned to the S2 completion/reopen scope): the UI service path and an unknown session.
  it("the service reopens a closed session with the UI origin; an unknown session is not_found and writes nothing", async () => {
    const t = await setup();
    const service = createRoadmapService(t.deps);
    const sid = await t.seededSession({ status: "closed", planner: binding(), continuation: continuationIn("complete") });
    const fields = grillingFields(await t.sessionOf(sid));
    const before = await t.revision();
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- opaque PaseoApi identity token: the service only passes it to the directory
    const paseo = { synthetic: "reopen" } as unknown as PaseoApi;
    expect(err(await service.sessionReopen(paseo, { projectId: P, sessionId: "no-such-session", expectedRevision: before })).code).toBe("not_found");
    expect(await t.revision()).toBe(before);
    expect(ok(await service.sessionReopen(paseo, { projectId: P, sessionId: sid, expectedRevision: before }))).toEqual({ revision: before + 1 });
    const s = await t.sessionOf(sid);
    expect(s.status).toBe("active");
    expect(grillingFields(s)).toBe(fields);
    expect(err(await t.commands.sessionReopen(t.open, { projectId: P, sessionId: "no-such-session", expectedRevision: before + 1 }, UI_ORIGIN)).code).toBe("not_found");
    expect(await t.revision()).toBe(before + 1);
  });
});

describe("S17 handler routing", () => {
  it("routes session.planner.set to plannerSet and session.reopen to sessionReopen with context.paseo, and sets the holder", async () => {
    const names: string[] = [];
    const handlers = new Map<string, (input: unknown, context: { paseo: PaseoApi }) => unknown>();
    const server = {
      handle(contract: PluginRpcContract, handler: (input: unknown, context: { paseo: PaseoApi }) => unknown) {
        names.push(contract.name);
        handlers.set(contract.name, handler);
      },
    };
    const calls: Array<[string, unknown, unknown]> = [];
    const sentinel = { ok: true as const, value: { revision: 9, epoch: 2 } };
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- Proxy spy: every method is synthesised by the get trap
    const service = new Proxy({} as RoadmapService, {
      get: (_t, method: string) => async (paseo: unknown, input: unknown) => {
        calls.push([method, paseo, input]);
        return sentinel;
      },
    });
    const holder = createPaseoHolder();
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test recorder for the SDK's generic handle(): one handler map for all contracts
    registerHandlers(server as never, service, holder);
    expect(names).toContain("session.planner.set");
    expect(names).toContain("session.reopen");
    expect(new Set(names).size).toBe(names.length);

    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- opaque PaseoApi identity token: only passed through and compared, never called
    const paseo = { synthetic: "planner-set" } as unknown as PaseoApi;
    const setInput = { projectId: P, expectedRevision: 3, sessionId: "s1", agentId: PLANNER };
    expect(await handlers.get("session.planner.set")!(setInput, { paseo })).toBe(sentinel);
    expect(holder.get()).toBe(paseo);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- opaque PaseoApi identity token: only passed through and compared, never called
    const paseo2 = { synthetic: "reopen" } as unknown as PaseoApi;
    const reopenInput = { projectId: P, expectedRevision: 4, sessionId: "s1" };
    expect(await handlers.get("session.reopen")!(reopenInput, { paseo: paseo2 })).toBe(sentinel);
    expect(holder.get()).toBe(paseo2);
    expect(calls).toEqual([
      ["plannerSet", paseo, setInput],
      ["sessionReopen", paseo2, reopenInput],
    ]);
  });
});
