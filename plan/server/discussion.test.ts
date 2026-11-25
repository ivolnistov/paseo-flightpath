// feature.discussion.open: one click creates a feature's discussion chat as reservation, creation,
// binding, prompt. The reservation is written first; the agent is created in the panel's workspace
// from the chosen saved profile WITHOUT a prompt and labelled with the reservation; the session
// planner is set through the existing rebind path; the prompt is sent only after the binding has
// committed. A second press while creating is refused, two presses never create two agents, and the
// creation is keyed by the reservation id. An uncertain creation is reconciled by the reservation
// label: a live agent is bound, an archived one proves the creation happened, and no agent at all
// leaves the creation explicitly unresolved, with nothing created automatically. Only an
// authentication refusal records a failure. The tools state is read honestly from the real grant
// state.
//
// The host is a deterministic synthetic fake that records every call and the store state seen at
// that moment; the grant state is the real McpState over a temp directory. No model is invoked.
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PaseoApi } from "@getpaseo/client";
import { DaemonAuthenticationError, DaemonConnectionError } from "@getpaseo/client/internal/daemon-client";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { canonicalJson } from "../shared/canonical";
import type { RoadmapData, Session } from "../shared/model";
import { roadmapSettings } from "../shared/settings";
import { createFeatureCommands } from "./features";
import { createMcpState, envFingerprint, type McpState } from "./mcp-state";
import { createRoadmapCommands, UI_ORIGIN, type StoreOpener } from "./sessions";
import { openProjectStore } from "./store-root";
import { fixedClock, NOW, nextId } from "./test-support/build";
import { fakeDirectory } from "./test-support/fake-dir";
import { binding, BLK_OPEN, continuationIn, OTHER_AGENT } from "./test-support/grilling";
import { makeProject, ok as okCommand, type TestProject } from "./test-support/service";

const P = "prj_test";
const WS = "wks_1";
const WS_DIR = "/synthetic/wks1";
const LABEL = "decision-roadmap.reservation";
const PROFILES = [
  { id: "team-research", name: "Research", provider: "antigravity", model: "gemini-3.8-flash-medium" },
  { id: "alt", name: "Alternative", provider: "claude" },
];
const later = (ms: number) => () => new Date(NOW.getTime() + ms);

type OpenInput = { projectId: string; expectedRevision: number; featureId: string; workspaceId: string; profileRef?: string; [key: string]: unknown };
const OpenValue = z.looseObject({
  revision: z.number().int(),
  sessionId: z.string(),
  agentId: z.string(),
  workspaceId: z.string(),
  created: z.boolean(),
  tools: z.enum(["attached", "pending", "not_attached", "unknown"]),
});
const OpenResult = z.union([
  z.object({ ok: z.literal(true), value: OpenValue }),
  z.object({ ok: z.literal(false), error: z.looseObject({ code: z.string(), message: z.string() }) }),
]);
type OpenResult = z.infer<typeof OpenResult>;
const ok = (r: OpenResult) => {
  if (!r.ok) throw new Error(`expected ok, got ${r.error.code}: ${r.error.message}`);
  return r.value;
};
const err = (r: OpenResult) => {
  if (r.ok) throw new Error(`expected an error, got ok: ${JSON.stringify(r.value)}`);
  return r.error;
};
/** The feature's discussion binding as stored (creating, failed or bound). */
const Discussion = z.looseObject({
  state: z.enum(["creating", "unresolved", "failed", "bound"]),
  reservationId: z.string(),
  profileRef: z.string().optional(),
  workspaceId: z.string().optional(),
  agentId: z.string().optional(),
  error: z.string().optional(),
});
type Discussion = z.infer<typeof Discussion>;
const discussionOf = (feature: unknown): Discussion | undefined => z.looseObject({ discussion: Discussion.optional() }).parse(feature).discussion;

const modulePath = "./discussion";
/** server/discussion.ts openDiscussion(deps, paseo, input), loaded without a static import so each case fails on its own. */
const loadDiscussion = async (): Promise<(deps: Record<string, unknown>, paseo: PaseoApi, input: OpenInput) => Promise<OpenResult>> => {
  const mod: unknown = await import(/* @vite-ignore */ modulePath).catch((e: unknown) => {
    throw new Error(`missing module server/discussion.ts: ${String(e)}`);
  });
  const fn: unknown = typeof mod === "object" && mod !== null && "openDiscussion" in mod ? mod.openDiscussion : undefined;
  if (typeof fn !== "function") throw new Error("missing export: discussion.openDiscussion");
  return async (deps, paseo, input) => OpenResult.parse(await Reflect.apply(fn, undefined, [deps, paseo, input]));
};

let project: TestProject | undefined;
const roots: string[] = [];
afterEach(async () => {
  await project?.cleanup();
  project = undefined;
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});

/** A promise released by hand, to hold a host call in flight. */
function gate() {
  let release: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => (release = resolve));
  return { promise, release };
}

type Snapshot = { discussion: Discussion | undefined; planner: Session["planner"] | undefined; revision: number };

async function setup(opts: { discussionProfile?: string } = { discussionProfile: "team-research" }) {
  project = await makeProject();
  const proj = project;
  const stateParent = await realpath(await mkdtemp(join(tmpdir(), "dr-discussion-state-")));
  roots.push(stateParent);
  const stateDir = join(stateParent, "state");
  const dir = fakeDirectory({
    projects: [{ projectId: P, projectRootPath: proj.root, projectKind: "git" }],
    workspaces: [
      { id: WS, projectId: P, directory: WS_DIR },
      { id: "wks_2", projectId: P, directory: "/synthetic/wks2" },
      { id: "wks_other", projectId: "prj_other", directory: "/synthetic/other" },
    ],
  });
  const storeOptions = { now: fixedClock, newId: nextId, log: () => undefined };
  const base = { directory: () => dir, now: fixedClock, newId: nextId, storeOptions };
  const commands = createRoadmapCommands(base);
  const features = createFeatureCommands(base);
  const open: StoreOpener = (projectId) => openProjectStore(dir, projectId, storeOptions);
  okCommand(await commands.init(open, { projectId: P }, UI_ORIGIN));
  const revision = async () => okCommand(await commands.version(open, { projectId: P }, UI_ORIGIN)).revision!;
  const data = async (): Promise<RoadmapData> => {
    const read = await (await open(P)).read();
    if (read.status !== "ok") throw new Error(`expected ok store, got ${read.status}`);
    return read.data;
  };
  const feature = async (id: string) => (await data()).features.find((f) => f.id === id)!;
  const sessionOf = async (id: string) => (await data()).sessions.find((s) => s.id === id)!;
  const createFeature = async (title = "Login", kind: "feature" | "bug" = "feature") =>
    okCommand(await features.create(open, { projectId: P, expectedRevision: await revision(), title, description: "Sign in with SSO", kind }, UI_ORIGIN)).featureId;
  const state: McpState = createMcpState({ stateDir, now: fixedClock, newId: nextId, log: () => undefined });

  // Synthetic host. Every call is recorded with the feature's discussion and the session planner
  // as the store holds them at that moment.
  let watchedFeature = "";
  const observe = async (): Promise<Snapshot> => {
    const d = await data();
    const f = d.features.find((x) => x.id === watchedFeature);
    const s = f?.grillSessionId !== undefined ? d.sessions.find((x) => x.id === f.grillSessionId) : undefined;
    const read = await (await open(P)).read();
    return { discussion: f !== undefined ? discussionOf(f) : undefined, planner: s?.planner, revision: read.status === "ok" ? read.revision : -1 };
  };
  const host = {
    calls: [] as string[],
    created: [] as Array<{ workspaceId: string; options: { config?: Record<string, unknown>; title?: string; labels?: Record<string, string>; prompt?: string; idempotencyKey?: string }; seen: Snapshot }>,
    sent: [] as Array<{ agentId: string; text: string; seen: Snapshot }>,
    listed: [] as Array<{ id: string; labels?: Record<string, string>; archivedAt: string | null }>,
    failCreate: undefined as Error | undefined,
    failSend: undefined as Error | undefined,
    createGate: undefined as ReturnType<typeof gate> | undefined,
    createIssued: gate(),
    /** What the injection does when the agent is created: nothing, issue a grant, or issue and bind it. */
    inject: "none" as "none" | "issued" | "bound",
    nextAgent: 1,
  };
  const paseo = {
    config: { get: async () => (host.calls.push("config.get"), { revision: "r1", config: { agentProfiles: PROFILES } }) },
    workspaces: {
      ref: (workspaceId: string) => ({
        id: workspaceId,
        agents: {
          create: async (options: (typeof host.created)[number]["options"]) => {
            host.calls.push("agents.create");
            host.created.push({ workspaceId, options, seen: await observe() });
            host.createIssued.release();
            if (host.createGate) await host.createGate.promise;
            if (host.failCreate) throw host.failCreate;
            const id = `agent-${host.nextAgent++}`;
            if (host.inject !== "none") {
              const grant = await state.issueGrant({ projectId: P, storeRoot: proj.root, provider: "antigravity", cwd: WS_DIR, port: 1 });
              if (host.inject === "bound") await state.bindByFingerprint(envFingerprint(grant.grantId), { agentId: id, workspaceId, at: NOW.toISOString() });
            }
            return { id };
          },
        },
      }),
    },
    agents: {
      list: async () => (host.calls.push("agents.list"), { requestId: "r", entries: host.listed.map((agent) => ({ agent, project: null })), pageInfo: {} }),
      ref: (agentId: string) => ({
        id: agentId,
        send: async (text: string) => {
          host.calls.push("agents.send");
          host.sent.push({ agentId, text, seen: await observe() });
          if (host.failSend) throw host.failSend;
        },
      }),
    },
  };
  const settings = async () => roadmapSettings.schema.parse(opts.discussionProfile !== undefined ? { discussionProfile: opts.discussionProfile } : {});
  const deps = (over: Record<string, unknown> = {}) => ({
    open,
    commands,
    settings,
    directory: () => dir,
    state,
    now: fixedClock,
    newId: nextId,
    log: () => undefined,
    ...over,
  });
  const openDiscussion = await loadDiscussion();
  const press = async (featureId: string, extra: { expectedRevision?: number; workspaceId?: string; profileRef?: string; deps?: Record<string, unknown>; extra?: Record<string, unknown> } = {}) => {
    watchedFeature = featureId;
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- synthetic host: only the PaseoApi members the command uses exist
    return openDiscussion(extra.deps ?? deps(), paseo as unknown as PaseoApi, {
      projectId: P,
      expectedRevision: extra.expectedRevision ?? (await revision()),
      featureId,
      workspaceId: extra.workspaceId ?? WS,
      ...(extra.profileRef !== undefined ? { profileRef: extra.profileRef } : {}),
      ...(extra.extra ?? {}),
    });
  };
  const snapshot = async () => ({ revision: await revision(), text: canonicalJson(await data()) });
  return { commands, features, open, revision, data, feature, sessionOf, createFeature, state, stateDir, host, deps, press, snapshot, observe };
}

describe("one click: reservation, creation without a prompt, binding, then the prompt", () => {
  it("creates one agent from the default profile in the panel's workspace, labelled with the reservation, and binds it before prompting", async () => {
    const t = await setup();
    const featureId = await t.createFeature("Login");
    const out = ok(await t.press(featureId));
    expect(out).toMatchObject({ workspaceId: WS, created: true });

    expect(t.host.created).toHaveLength(1);
    const created = t.host.created[0];
    expect(created.workspaceId).toBe(WS);
    expect(created.options.title).toBe("Discussion: Login");
    expect(created.options.config).toMatchObject({ provider: "antigravity/gemini-3.8-flash-medium" });
    expect(created.options.prompt).toBeUndefined();
    expect(created.options.labels).toMatchObject({ "decision-roadmap.feature": featureId, "decision-roadmap.role": "discussion" });
    // The reservation was committed before the creation, and the creation carries its id.
    expect(created.seen.discussion).toMatchObject({ state: "creating", profileRef: "team-research", workspaceId: WS });
    const reservationId = created.seen.discussion?.reservationId;
    expect(created.options.labels?.[LABEL]).toBe(reservationId);
    // The reservation id is also the creation's idempotency key.
    expect(created.options.idempotencyKey).toBe(reservationId);
    expect(created.seen.planner).toBeUndefined();

    const f = await t.feature(featureId);
    expect(discussionOf(f)).toEqual({ state: "bound", reservationId, agentId: out.agentId, workspaceId: WS, boundAt: NOW.toISOString(), profileRef: "team-research" });
    expect(f.grillSessionId).toBe(out.sessionId);
    const session = await t.sessionOf(out.sessionId);
    expect(session.title).toBe("[feature] Login");
    expect(session.planner).toMatchObject({ agentId: out.agentId, workspaceId: WS, boundBy: "discussion", epoch: 1 });

    // The prompt went out once, only after the binding had committed.
    expect(t.host.sent).toHaveLength(1);
    expect(t.host.sent[0].agentId).toBe(out.agentId);
    expect(t.host.sent[0].seen.discussion).toMatchObject({ state: "bound", agentId: out.agentId });
    expect(t.host.sent[0].seen.planner).toMatchObject({ agentId: out.agentId, boundBy: "discussion" });
    expect(t.host.sent[0].text).toContain(out.sessionId);
    expect(t.host.calls.indexOf("agents.create")).toBeLessThan(t.host.calls.indexOf("agents.send"));
    expect(out.revision).toBe(await t.revision());
  });

  it("an explicit profile overrides the default and is recorded on the binding", async () => {
    const t = await setup();
    const featureId = await t.createFeature();
    ok(await t.press(featureId, { profileRef: "alt" }));
    expect(t.host.created[0].options.config).toMatchObject({ provider: "claude" });
    expect(discussionOf(await t.feature(featureId))).toMatchObject({ state: "bound", profileRef: "alt" });
  });

  it("a second press on a bound feature opens the same chat: nothing is created or sent again", async () => {
    const t = await setup();
    const featureId = await t.createFeature();
    const first = ok(await t.press(featureId));
    const second = ok(await t.press(featureId));
    expect(second).toMatchObject({ sessionId: first.sessionId, agentId: first.agentId, workspaceId: WS, created: false });
    expect(t.host.created).toHaveLength(1);
    expect(t.host.sent).toHaveLength(1);
  });

  it("an existing planner is replaced through the rebind path: epoch increments, history kept, a live continuation superseded", async () => {
    const t = await setup();
    const featureId = await t.createFeature();
    const sessionId = okCommand(await t.commands.sessionCreate(t.open, { projectId: P, expectedRevision: await t.revision(), title: "[feature] Login" }, UI_ORIGIN)).sessionId;
    okCommand(
      await t.commands.questionCreateBatch(
        t.open,
        { projectId: P, expectedRevision: await t.revision(), sessionId, blockId: BLK_OPEN, questions: [{ title: "Q", context: "", options: [{ id: "a", label: "A" }], allowFreeText: false, activatedBy: [], invalidatedBy: [] }] },
        { source: "chat", actor: { kind: "agent" } },
      ),
    );
    await (await t.open(P)).transact(await t.revision(), (d) => {
      d.features.find((f) => f.id === featureId)!.grillSessionId = sessionId;
      const s = d.sessions.find((x) => x.id === sessionId)!;
      s.planner = { ...binding(), agentId: OTHER_AGENT };
      s.continuation = continuationIn("awaiting_pause", { target: { agentId: OTHER_AGENT, epoch: 1 } });
    });
    const out = ok(await t.press(featureId));
    expect(out.sessionId).toBe(sessionId);
    const s = await t.sessionOf(sessionId);
    expect(s.planner).toMatchObject({ agentId: out.agentId, boundBy: "discussion", epoch: 2 });
    expect(s.plannerHistory?.map((p) => p.agentId)).toEqual([OTHER_AGENT]);
    expect(s.continuation).toMatchObject({ state: "superseded", reason: "rebind" });
  });
});

describe("refusals before anything is created", () => {
  it("no default and no explicit profile, or an unknown profile: invalid_input, nothing created or written", async () => {
    const t = await setup({});
    const featureId = await t.createFeature();
    const before = await t.snapshot();
    const none = err(await t.press(featureId));
    expect(none.code).toBe("invalid_input");
    expect(none.message).toMatch(/no discussion profile configured/);
    expect(err(await t.press(featureId, { profileRef: "no-such-profile" })).code).toBe("invalid_input");
    expect(t.host.created).toEqual([]);
    expect(await t.snapshot()).toEqual(before);
  });

  it("a workspace of another project or an unknown workspace: invalid_input, nothing created or written", async () => {
    const t = await setup();
    const featureId = await t.createFeature();
    const before = await t.snapshot();
    expect(err(await t.press(featureId, { workspaceId: "wks_other" })).code).toBe("invalid_input");
    expect(err(await t.press(featureId, { workspaceId: "wks_missing" })).code).toBe("invalid_input");
    expect(t.host.created).toEqual([]);
    expect(await t.snapshot()).toEqual(before);
  });

  it("a bug card has no discussion: invalid_input", async () => {
    const t = await setup();
    const bugId = await t.createFeature("Crash", "bug");
    expect(err(await t.press(bugId)).code).toBe("invalid_input");
    expect(t.host.created).toEqual([]);
  });

  it("a stale revision is revision_conflict, nothing created or written", async () => {
    const t = await setup();
    const featureId = await t.createFeature();
    const before = await t.snapshot();
    expect(err(await t.press(featureId, { expectedRevision: before.revision - 1 })).code).toBe("revision_conflict");
    expect(t.host.created).toEqual([]);
    expect(await t.snapshot()).toEqual(before);
  });
});

describe("two presses never create two agents", () => {
  it("a press while the reservation is creating is refused as being created", async () => {
    const t = await setup();
    const featureId = await t.createFeature();
    t.host.createGate = gate();
    const first = t.press(featureId);
    await t.host.createIssued.promise;
    const second = err(await t.press(featureId));
    expect(second.code).toBe("invalid_input");
    expect(second.message).toMatch(/being created/);
    t.host.createGate.release();
    ok(await first);
    expect(t.host.created).toHaveLength(1);
    expect(t.host.sent).toHaveLength(1);
  });

  it("two simultaneous presses with the same revision create exactly one agent", async () => {
    const t = await setup();
    const featureId = await t.createFeature();
    const rev = await t.revision();
    const results = await Promise.all([t.press(featureId, { expectedRevision: rev }), t.press(featureId, { expectedRevision: rev })]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    const refused = results.find((r) => !r.ok);
    expect(refused && !refused.ok ? refused.error.code : undefined).toMatch(/revision_conflict|invalid_input/);
    expect(t.host.created).toHaveLength(1);
  });
});

describe("an uncertain creation is reconciled by the reservation label", () => {
  it("a rejection other than authentication keeps the reservation creating; within the timeout a press is refused", async () => {
    const t = await setup();
    const featureId = await t.createFeature();
    t.host.failCreate = new DaemonConnectionError("connection lost", "DAEMON_CONNECTION_LOST");
    expect((await t.press(featureId)).ok).toBe(false);
    expect(discussionOf(await t.feature(featureId))).toMatchObject({ state: "creating" });
    const session = await t.sessionOf((await t.feature(featureId)).grillSessionId!);
    expect(session.planner).toBeUndefined();
    t.host.failCreate = undefined;
    expect(err(await t.press(featureId, { deps: t.deps({ now: later(10_000) }) })).message).toMatch(/being created/);
    expect(t.host.created).toHaveLength(1);
    expect(t.host.sent).toEqual([]);
  });

  it("after the timeout, an agent found by the reservation label is bound and prompted; nothing new is created", async () => {
    const t = await setup();
    const featureId = await t.createFeature();
    t.host.failCreate = new Error("boom");
    expect((await t.press(featureId)).ok).toBe(false);
    const reservationId = discussionOf(await t.feature(featureId))?.reservationId;
    expect(reservationId).toBeDefined();
    t.host.failCreate = undefined;
    t.host.listed = [
      { id: "agent-other", labels: { [LABEL]: "another-reservation" }, archivedAt: null },
      { id: "agent-archived", labels: { [LABEL]: reservationId! }, archivedAt: NOW.toISOString() },
      { id: "agent-found", labels: { [LABEL]: reservationId! }, archivedAt: null },
    ];
    const out = ok(await t.press(featureId, { deps: t.deps({ now: later(120_000) }) }));
    expect(out).toMatchObject({ agentId: "agent-found", created: false });
    expect(t.host.created).toHaveLength(1);
    expect(discussionOf(await t.feature(featureId))).toMatchObject({ state: "bound", agentId: "agent-found", reservationId });
    expect(t.host.sent.map((s) => s.agentId)).toEqual(["agent-found"]);
  });

  it("after the timeout, an archived agent carrying the label proves the creation happened, so a new agent is created once", async () => {
    const t = await setup();
    const featureId = await t.createFeature();
    t.host.failCreate = new Error("boom");
    expect((await t.press(featureId)).ok).toBe(false);
    const old = discussionOf(await t.feature(featureId))?.reservationId;
    t.host.failCreate = undefined;
    t.host.listed = [{ id: "agent-archived", labels: { [LABEL]: old! }, archivedAt: NOW.toISOString() }];
    const out = ok(await t.press(featureId, { deps: t.deps({ now: later(120_000) }) }));
    expect(out.created).toBe(true);
    expect(t.host.created).toHaveLength(2);
    const bound = discussionOf(await t.feature(featureId));
    expect(bound).toMatchObject({ state: "bound", agentId: out.agentId });
    expect(t.host.created[1].options.labels?.[LABEL]).toBe(bound?.reservationId);
  });

  it("after the timeout, no agent at all carrying the label leaves the creation unresolved: refused, recorded, nothing created", async () => {
    const t = await setup();
    const featureId = await t.createFeature();
    t.host.failCreate = new Error("boom");
    expect((await t.press(featureId)).ok).toBe(false);
    const reservationId = discussionOf(await t.feature(featureId))?.reservationId;
    t.host.failCreate = undefined;
    t.host.listed = [{ id: "agent-other", labels: { [LABEL]: "another-reservation" }, archivedAt: null }];
    const before = t.host.created.length;

    const refused = err(await t.press(featureId, { deps: t.deps({ now: later(120_000) }) }));
    expect(refused.code).toBe("invalid_input");
    expect(refused.message).toMatch(/unresolved/);
    expect(discussionOf(await t.feature(featureId))).toMatchObject({ state: "unresolved", reservationId });
    // A later ordinary press does not create either.
    expect(err(await t.press(featureId, { deps: t.deps({ now: later(600_000) }) })).message).toMatch(/unresolved/);
    expect(t.host.created).toHaveLength(before);
    expect(t.host.sent).toEqual([]);
    expect((await t.sessionOf((await t.feature(featureId)).grillSessionId!)).planner).toBeUndefined();
  });

  it("an unresolved creation is bound when the agent later appears under its reservation label", async () => {
    const t = await setup();
    const featureId = await t.createFeature();
    t.host.failCreate = new Error("boom");
    expect((await t.press(featureId)).ok).toBe(false);
    const reservationId = discussionOf(await t.feature(featureId))?.reservationId;
    t.host.failCreate = undefined;
    expect((await t.press(featureId, { deps: t.deps({ now: later(120_000) }) })).ok).toBe(false);
    expect(discussionOf(await t.feature(featureId))).toMatchObject({ state: "unresolved" });

    t.host.listed = [{ id: "agent-late", labels: { [LABEL]: reservationId! }, archivedAt: null }];
    const out = ok(await t.press(featureId, { deps: t.deps({ now: later(180_000) }) }));
    expect(out).toMatchObject({ agentId: "agent-late", created: false });
    expect(t.host.created).toHaveLength(1);
    expect(discussionOf(await t.feature(featureId))).toMatchObject({ state: "bound", agentId: "agent-late", reservationId });
    expect(t.host.sent.map((s) => s.agentId)).toEqual(["agent-late"]);
  });

  // Owner decision: after an ambiguous creation the chat is created again only when the owner has
  // explicitly confirmed that no chat was created; an empty listing or a plain retry never decides it.
  describe("an unresolved creation is retried only with the owner's confirmation that no chat exists", () => {
    async function unresolved(t: Awaited<ReturnType<typeof setup>>) {
      const featureId = await t.createFeature();
      t.host.failCreate = new Error("boom");
      expect((await t.press(featureId)).ok).toBe(false);
      t.host.failCreate = undefined;
      t.host.listed = [];
      expect((await t.press(featureId, { deps: t.deps({ now: later(120_000) }) })).ok).toBe(false);
      const reservationId = discussionOf(await t.feature(featureId))?.reservationId;
      expect(discussionOf(await t.feature(featureId))).toMatchObject({ state: "unresolved" });
      return { featureId, reservationId };
    }
    const confirmed = { retryUnresolved: true, confirmedNoChat: true };

    it("a plain retry without the confirmation is refused and creates nothing", async () => {
      const t = await setup();
      const { featureId } = await unresolved(t);
      const before = await t.snapshot();
      const refused = err(await t.press(featureId, { deps: t.deps({ now: later(180_000) }), extra: { retryUnresolved: true } }));
      expect(refused.code).toBe("invalid_input");
      expect(t.host.created).toHaveLength(1);
      expect(await t.snapshot()).toEqual(before);
    });

    it("with the confirmation, one agent is created under the same reservation id and idempotency key", async () => {
      const t = await setup();
      const { featureId, reservationId } = await unresolved(t);
      const out = ok(await t.press(featureId, { deps: t.deps({ now: later(180_000) }), extra: confirmed }));
      expect(out.created).toBe(true);
      expect(t.host.created).toHaveLength(2);
      expect(t.host.created[1].options.labels?.[LABEL]).toBe(reservationId);
      expect(t.host.created[1].options.idempotencyKey).toBe(reservationId);
      expect(discussionOf(await t.feature(featureId))).toMatchObject({ state: "bound", agentId: out.agentId, reservationId });
    });

    it("the confirmation does not override a creation in progress or a bound chat", async () => {
      const t = await setup();
      const featureId = await t.createFeature();
      t.host.failCreate = new Error("boom");
      expect((await t.press(featureId)).ok).toBe(false);
      t.host.failCreate = undefined;
      expect(err(await t.press(featureId, { deps: t.deps({ now: later(10_000) }), extra: confirmed })).message).toMatch(/being created/);
      expect(t.host.created).toHaveLength(1);

      const u = await setup();
      const boundId = await u.createFeature();
      const first = ok(await u.press(boundId));
      const again = ok(await u.press(boundId, { extra: confirmed }));
      expect(again).toMatchObject({ agentId: first.agentId, created: false });
      expect(u.host.created).toHaveLength(1);
    });

    it("a confirmed retry is revision-checked, and two at one revision create one agent", async () => {
      const t = await setup();
      const { featureId } = await unresolved(t);
      const rev = await t.revision();
      expect(err(await t.press(featureId, { expectedRevision: rev - 1, deps: t.deps({ now: later(180_000) }), extra: confirmed })).code).toBe("revision_conflict");
      expect(t.host.created).toHaveLength(1);
      const results = await Promise.all([
        t.press(featureId, { expectedRevision: rev, deps: t.deps({ now: later(180_000) }), extra: confirmed }),
        t.press(featureId, { expectedRevision: rev, deps: t.deps({ now: later(180_000) }), extra: confirmed }),
      ]);
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      expect(t.host.created).toHaveLength(2);
    });
  });

  it("only an authentication refusal records failed with its reason; the session stays unbound and a later press may create", async () => {
    const t = await setup();
    const featureId = await t.createFeature();
    const refusal = new DaemonAuthenticationError("password_required");
    t.host.failCreate = refusal;
    expect((await t.press(featureId)).ok).toBe(false);
    const f = await t.feature(featureId);
    expect(discussionOf(f)).toMatchObject({ state: "failed", error: refusal.message, profileRef: "team-research", workspaceId: WS });
    expect((await t.sessionOf(f.grillSessionId!)).planner).toBeUndefined();
    expect(t.host.sent).toEqual([]);
    t.host.failCreate = undefined;
    expect(ok(await t.press(featureId)).created).toBe(true);
  });

  it("an undelivered prompt leaves the binding in place", async () => {
    const t = await setup();
    const featureId = await t.createFeature();
    t.host.failSend = new Error("agent offline");
    await t.press(featureId);
    const f = await t.feature(featureId);
    expect(discussionOf(f)).toMatchObject({ state: "bound" });
    expect((await t.sessionOf(f.grillSessionId!)).planner).toMatchObject({ boundBy: "discussion" });
  });
});

describe("the tools state is reported honestly from the grant state", () => {
  it("not_attached when no grant was issued for the creation", async () => {
    const t = await setup();
    const featureId = await t.createFeature();
    expect(ok(await t.press(featureId)).tools).toBe("not_attached");
  });

  // An unmarked grant (issued without the creation's reservation) cannot be attributed to the chat by
  // its directory or time, so it reads unknown, never pending.
  it("unknown when an unmarked grant was issued for this workspace at creation but no agent bound it yet", async () => {
    const t = await setup();
    const featureId = await t.createFeature();
    t.host.inject = "issued";
    expect(ok(await t.press(featureId)).tools).toBe("unknown");
  });

  it("attached when a grant is bound to the created agent", async () => {
    const t = await setup();
    const featureId = await t.createFeature();
    t.host.inject = "bound";
    expect(ok(await t.press(featureId)).tools).toBe("attached");
  });

  it("an older grant or one for another directory does not make it pending", async () => {
    const t = await setup();
    const featureId = await t.createFeature();
    const earlier = createMcpState({ stateDir: t.stateDir, now: () => new Date(NOW.getTime() - 3_600_000), newId: nextId, log: () => undefined });
    await earlier.issueGrant({ projectId: P, storeRoot: "/synthetic/root", provider: "claude", cwd: WS_DIR, port: 1 });
    await t.state.issueGrant({ projectId: P, storeRoot: "/synthetic/root", provider: "claude", cwd: "/synthetic/elsewhere", port: 1 });
    expect(ok(await t.press(featureId)).tools).toBe("not_attached");
  });

  it("unknown when the grant file cannot be read, rather than claiming not_attached", async () => {
    const t = await setup();
    const featureId = await t.createFeature();
    await t.state.issueGrant({ projectId: P, storeRoot: "/synthetic/root", provider: "claude", cwd: "/synthetic/elsewhere", port: 1 });
    await writeFile(join(t.stateDir, "grants.json"), "{ not json");
    expect(ok(await t.press(featureId)).tools).toBe("unknown");
  });
});

// Review regressions for recovering an unresolved creation and for deleting a feature mid-creation.
describe("recovery and deletion around a creation", () => {
  async function unresolvedIn(t: Awaited<ReturnType<typeof setup>>, profileRef?: string) {
    const featureId = await t.createFeature();
    t.host.failCreate = new Error("boom");
    expect((await t.press(featureId, profileRef !== undefined ? { profileRef } : {})).ok).toBe(false);
    t.host.failCreate = undefined;
    t.host.listed = [];
    expect((await t.press(featureId, { deps: t.deps({ now: later(120_000) }) })).ok).toBe(false);
    expect(discussionOf(await t.feature(featureId))).toMatchObject({ state: "unresolved" });
    return featureId;
  }
  const confirmed = { retryUnresolved: true, confirmedNoChat: true };

  it("a creation started with an explicitly chosen profile and no default is recovered after the owner's confirmation, with that profile", async () => {
    const t = await setup({});
    const featureId = await unresolvedIn(t, "alt");
    const out = ok(await t.press(featureId, { deps: t.deps({ now: later(180_000) }), extra: confirmed }));
    expect(out.created).toBe(true);
    expect(t.host.created[1].options.config).toMatchObject({ provider: "claude" });
    expect(discussionOf(await t.feature(featureId))).toMatchObject({ state: "bound", profileRef: "alt" });
  });

  it("a confirmed retry from another workspace of the project creates in the reserved workspace", async () => {
    const t = await setup();
    const featureId = await unresolvedIn(t);
    const out = ok(await t.press(featureId, { workspaceId: "wks_2", deps: t.deps({ now: later(180_000) }), extra: confirmed }));
    expect(t.host.created[1].workspaceId).toBe(WS);
    expect(out.workspaceId).toBe(WS);
    expect(discussionOf(await t.feature(featureId))).toMatchObject({ state: "bound", workspaceId: WS });
  });

  it("an agent found by its label from another workspace is bound with the reserved workspace", async () => {
    const t = await setup();
    const featureId = await t.createFeature();
    t.host.failCreate = new Error("boom");
    expect((await t.press(featureId)).ok).toBe(false);
    t.host.failCreate = undefined;
    const reservationId = discussionOf(await t.feature(featureId))?.reservationId;
    t.host.listed = [{ id: "agent-found", labels: { [LABEL]: reservationId! }, archivedAt: null }];
    const out = ok(await t.press(featureId, { workspaceId: "wks_2", deps: t.deps({ now: later(120_000) }) }));
    expect(out).toMatchObject({ agentId: "agent-found", workspaceId: WS });
    expect(discussionOf(await t.feature(featureId))).toMatchObject({ state: "bound", workspaceId: WS });
  });
  it("a feature whose discussion chat is being created cannot be deleted; the creation then binds normally", async () => {
    const t = await setup();
    const featureId = await t.createFeature();
    t.host.createGate = gate();
    const pressing = t.press(featureId);
    await Promise.race([t.host.createIssued.promise, pressing.then(() => undefined, () => undefined)]);
    expect(t.host.created).toHaveLength(1);
    const deleted = await t.features.delete(t.open, { projectId: P, expectedRevision: await t.revision(), featureId }, UI_ORIGIN);
    expect(deleted.ok).toBe(false);
    expect((await t.data()).features.map((f) => f.id)).toContain(featureId);
    t.host.createGate.release();
    ok(await pressing);
    expect(discussionOf(await t.feature(featureId))).toMatchObject({ state: "bound" });
  });
});
