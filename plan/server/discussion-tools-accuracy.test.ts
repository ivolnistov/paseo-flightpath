// How honest the discussion chat's tools state is when grants cannot be told apart by time and
// directory alone. "pending" must mean a grant that belongs to this discussion's creation; an unbound
// grant of an unrelated agent in the same directory never makes it pending, two grants that cannot
// be told apart are not attributed to the discussion, and the discussion's own grant issued long
// before a delayed binding never turns into "not attached". "attached" needs a grant bound to that
// exact agent; anything the plugin cannot establish is "unknown".
//
// Host capability, verified in the installed SDK: the agent.create before-hook receives only the
// session config (provider, cwd, title, ...) and env, with no agent id and no labels; agents.create
// accepts env, which the hook sees; agent.session_open later carries the agent id and env. A
// creation can therefore be correlated with its grant only through what the plugin itself puts in
// the creation (for example env); without such a correlation the honest answer is "unknown".
//
// Real temp store, real grant state and the REAL injection and session_open hooks; the host is a
// synthetic fake that runs those hooks the way the daemon does around agents.create. The workspace
// directory is the temp project root, since the injection resolves the creation's cwd on disk.
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PaseoApi } from "@getpaseo/client";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { roadmapSettings } from "../shared/settings";
import { openDiscussion, type DiscussionDeps } from "./discussion";
import { createFeatureCommands } from "./features";
import { registerInjection } from "./injection";
import type { McpEndpoint } from "./mcp-endpoint";
import { createMcpState } from "./mcp-state";
import { createPaseoHolder } from "./paseo-holder";
import { createRoadmapCommands, createRoadmapService, UI_ORIGIN, type StoreOpener } from "./sessions";
import { openStore } from "./store";
import { openProjectStore } from "./store-root";
import { NOW, nextId, opt } from "./test-support/build";
import { fakeDirectory } from "./test-support/fake-dir";
import { BLK_OPEN } from "./test-support/grilling";
import { fakeHookServer } from "./test-support/mcp";
import { makeProject, ok, type TestProject } from "./test-support/service";

const P = "prj_test";
const WS = "wks_1";
const LABEL = "decision-roadmap.reservation";
/** "alt" runs on an MCP-capable provider; "no-mcp" on one the injection skips. */
const PROFILES = [
  { id: "alt", name: "Alternative", provider: "claude" },
  { id: "no-mcp", name: "No MCP", provider: "antigravity", model: "gemini-3.8-flash-medium" },
];
const later = (ms: number) => new Date(NOW.getTime() + ms);
const UNSURE = ["unknown"];

let project: TestProject | undefined;
const roots: string[] = [];
afterEach(async () => {
  await project?.cleanup();
  project = undefined;
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});

const OpenOk = z.object({ ok: z.literal(true), value: z.looseObject({ sessionId: z.string(), agentId: z.string(), tools: z.string() }) });

async function setup() {
  project = await makeProject();
  const proj = project;
  // The workspace directory must exist: the injection resolves the creation's cwd through realpath.
  const WS_DIR = proj.root;
  const stateParent = await realpath(await mkdtemp(join(tmpdir(), "dr-tools-acc-")));
  roots.push(stateParent);
  const stateDir = join(stateParent, "state");
  // One clock for the store, the grant state and the discussion, so a delay is a real gap everywhere.
  const clock = { at: NOW };
  const fixedClock = () => clock.at;
  const state = createMcpState({ stateDir, now: fixedClock, newId: nextId, log: () => undefined });
  const dir = fakeDirectory({ projects: [{ projectId: P, projectRootPath: proj.root, projectKind: "git" }], workspaces: [{ id: WS, projectId: P, directory: WS_DIR }] });
  const storeOptions = { now: fixedClock, newId: nextId, log: () => undefined };
  const base = { directory: () => dir, now: fixedClock, newId: nextId, storeOptions };
  const commands = createRoadmapCommands(base);
  const features = createFeatureCommands(base);
  const service = createRoadmapService({ ...base, state });
  const open: StoreOpener = (projectId) => openProjectStore(dir, projectId, storeOptions);
  ok(await commands.init(open, { projectId: P }, UI_ORIGIN));
  const revision = async () => ok(await commands.version(open, { projectId: P }, UI_ORIGIN)).revision!;

  // The real injection and session_open hooks, as the daemon runs them.
  const hooks = fakeHookServer();
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- a synthetic endpoint: the injection reads only its port and URL builder
  const endpoint = Promise.resolve({ port: 1, urlFor: () => "http://127.0.0.1:1/mcp/synthetic" } as unknown as McpEndpoint);
  registerInjection(hooks.server, { endpoint, state, holder: createPaseoHolder(), directory: () => dir, openStore, log: () => undefined });

  const host = {
    envOf: new Map<string, Record<string, string>>(),
    listed: [] as Array<{ id: string; labels?: Record<string, string>; archivedAt: string | null }>,
    failAfterInjection: undefined as Error | undefined,
    /**
     * How the injection runs for a creation: "run" as the daemon does; "skip" when it issued no grant
     * for this attempt (it fails open); "dropEnv" when the hook did not receive the creation env (an
     * older host or plugin), so the grant it issues carries no reservation mark.
     */
    injection: "run" as "run" | "skip" | "dropEnv",
    next: 1,
  };
  let paseo: PaseoApi;
  /** The daemon's agents.create: the before-hook runs (it may issue a grant), then the agent exists. */
  const createAgent = async (options: { config?: { provider?: string }; title?: string; env?: Record<string, string> }) => {
    const request = { config: { provider: options.config?.provider ?? "claude", cwd: WS_DIR, title: options.title ?? null }, env: options.env ?? {} };
    const hookRequest = host.injection === "dropEnv" ? { ...request, env: {} } : request;
    const out = host.injection === "skip" ? undefined : await hooks.runBefore(hookRequest as Parameters<typeof hooks.runBefore>[0], paseo);
    const id = `agent-${host.next++}`;
    host.envOf.set(id, out?.env ?? request.env);
    if (host.failAfterInjection) throw host.failAfterInjection;
    return { id };
  };
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- synthetic host: only the PaseoApi members these paths use exist
  paseo = {
    config: { get: async () => ({ revision: "r1", config: { agentProfiles: PROFILES } }) },
    workspaces: { ref: (id: string) => ({ id, agents: { create: createAgent } }) },
    agents: {
      list: async () => ({ requestId: "r", entries: host.listed.map((agent) => ({ agent, project: null })), pageInfo: {} }),
      ref: (agentId: string) => ({ id: agentId, send: async () => undefined }),
    },
  } as unknown as PaseoApi;
  /** The daemon opens the agent's interactive session; the real hook binds its grant by env. */
  const sessionOpen = (agentId: string) =>
    hooks.runSessionOpen({ agentId, workspaceId: WS, provider: "claude", cwd: WS_DIR, reason: "create", purpose: "interactive", env: host.envOf.get(agentId) ?? {} }, paseo);
  /** Another chat created in the same workspace by someone else: its grant is unrelated to the discussion. */
  const unrelatedAgent = async () => (await createAgent({ config: { provider: "claude" }, title: "Someone else's chat" })).id;

  const deps = (): DiscussionDeps => ({
    open, commands, settings: async () => roadmapSettings.schema.parse({}), directory: () => dir, state, now: fixedClock, newId: nextId, log: () => undefined,
  });
  const featureId = ok(await features.create(open, { projectId: P, expectedRevision: await revision(), title: "Login", description: "", kind: "feature" }, UI_ORIGIN)).featureId;
  const discuss = async (profileRef: string, extra: { retryUnresolved?: true; confirmedNoChat?: true; featureId?: string } = {}) =>
    openDiscussion(deps(), paseo, { projectId: P, expectedRevision: await revision(), featureId, workspaceId: WS, profileRef, ...extra });
  const createFeature = async (title: string) => ok(await features.create(open, { projectId: P, expectedRevision: await revision(), title, description: "", kind: "feature" }, UI_ORIGIN)).featureId;
  const deleteFeature = async (id: string) => ok(await features.delete(open, { projectId: P, expectedRevision: await revision(), featureId: id }, UI_ORIGIN));
  const sessionView = async (sessionId: string) => ok(await service.sessionGet(paseo, { projectId: P, sessionId }));
  const reservation = async () => {
    const read = await (await open(P)).read();
    if (read.status !== "ok") throw new Error("store not ok");
    return z.looseObject({ discussion: z.looseObject({ reservationId: z.string(), state: z.string() }) }).parse(read.data.features.find((f) => f.id === featureId)).discussion;
  };
  /** The header read: the session view of the discussion, once its first block exists. */
  const headerTools = async (sessionId: string) => {
    const session = (await (await open(P)).read());
    if (session.status !== "ok") throw new Error("store not ok");
    const s = session.data.sessions.find((x) => x.id === sessionId)!;
    if (s.blocks === undefined) {
      ok(await commands.questionCreateBatch(open, { projectId: P, expectedRevision: await revision(), sessionId, blockId: BLK_OPEN, questions: [{ title: "Language", context: "", options: [opt("en")], allowFreeText: true, activatedBy: [], invalidatedBy: [] }] }, { source: "chat", actor: { kind: "agent" } }));
    }
    const view = ok(await service.sessionGet(paseo, { projectId: P, sessionId }));
    return z.looseObject({ tools: z.string().optional() }).parse(view.grilling ?? {}).tools;
  };
  return { clock, state, stateDir, reservation, createFeature, deleteFeature, sessionView, host, paseo, discuss, headerTools, sessionOpen, unrelatedAgent, featureId, open };
}

describe("an unrelated agent's grant in the same workspace", () => {
  it("never makes a discussion without its own grant pending, in the Discuss response or in the header", async () => {
    const t = await setup();
    await t.unrelatedAgent();
    const opened = OpenOk.parse(await t.discuss("no-mcp"));
    expect(opened.value.tools).not.toBe("pending");
    await t.unrelatedAgent();
    expect(await t.headerTools(opened.value.sessionId)).not.toBe("pending");
  });

  it("bound to the unrelated agent, it never makes the discussion attached", async () => {
    const t = await setup();
    const opened = OpenOk.parse(await t.discuss("no-mcp"));
    const other = await t.unrelatedAgent();
    await t.sessionOpen(other);
    expect(await t.headerTools(opened.value.sessionId)).not.toBe("attached");
  });
});

describe("grants that cannot be told apart", () => {
  it("the discussion's own unbound grant beside an unrelated one is either attributed exactly (pending) or reported unknown", async () => {
    const t = await setup();
    await t.unrelatedAgent();
    const opened = OpenOk.parse(await t.discuss("alt"));
    expect(["pending", ...UNSURE]).toContain(opened.value.tools);
    await t.unrelatedAgent();
    expect(["pending", ...UNSURE]).toContain(await t.headerTools(opened.value.sessionId));
  });

  it("attached only once the discussion chat's own grant is bound to it", async () => {
    const t = await setup();
    const opened = OpenOk.parse(await t.discuss("alt"));
    const other = await t.unrelatedAgent();
    await t.sessionOpen(other);
    expect(await t.headerTools(opened.value.sessionId)).not.toBe("attached");
    await t.sessionOpen(opened.value.agentId);
    expect(await t.headerTools(opened.value.sessionId)).toBe("attached");
  });
});

describe("a delayed reconciliation", () => {
  it("the discussion's own grant, issued more than a minute before the agent is found and bound, is not reported as not attached", async () => {
    const t = await setup();
    t.host.failAfterInjection = new Error("connection dropped after the agent was created");
    expect((await t.discuss("alt")).ok).toBe(false);
    t.host.failAfterInjection = undefined;
    // The host did create the agent: it carries the reservation label and its unbound grant exists.
    const read = await (await t.open(P)).read();
    if (read.status !== "ok") throw new Error("store not ok");
    const discussion = z.looseObject({ discussion: z.looseObject({ reservationId: z.string() }) }).parse(read.data.features.find((f) => f.id === t.featureId)).discussion;
    t.host.listed = [{ id: "agent-1", labels: { [LABEL]: discussion.reservationId }, archivedAt: null }];
    t.clock.at = later(180_000);
    const reconciled = OpenOk.parse(await t.discuss("alt"));
    expect(reconciled.value.agentId).toBe("agent-1");
    expect(reconciled.value.tools).not.toBe("not_attached");
    expect(await t.headerTools(reconciled.value.sessionId)).not.toBe("not_attached");
  });
});

describe("unknown when the state cannot be read", () => {
  it("an unreadable grants file is unknown in the Discuss response and in the header", async () => {
    const t = await setup();
    const opened = OpenOk.parse(await t.discuss("alt"));
    await writeFile(join(t.stateDir, "grants.json"), "{ not json");
    expect(await t.headerTools(opened.value.sessionId)).toBe("unknown");
    const again = OpenOk.parse(await t.discuss("alt"));
    expect(again.value.tools).toBe("unknown");
  });
});

// Review regressions for a creation retried under the same reservation. The first attempt's outcome
// was uncertain: the injection issued a grant marked with the reservation, but the host created no
// chat. The owner checked and confirmed that no chat was created, and Discuss created it again under
// the same reservation. The earlier grant can never become the new chat's (its fingerprint is in the
// env of a creation that produced no agent), so it never makes the new chat pending. Unknown is
// always acceptable; not attached only where the retry provably issued nothing; attached only for a
// grant bound to the new chat itself.
describe("a creation retried under the same reservation", () => {
  const UNCERTAIN = new Error("connection dropped; the host created no chat");
  /** The uncertain first attempt, its unresolved lookup, and the confirmed retry's creation settings. */
  async function unresolved(t: Awaited<ReturnType<typeof setup>>) {
    t.host.failAfterInjection = UNCERTAIN;
    expect((await t.discuss("alt")).ok).toBe(false);
    expect(await t.state.grantsForReservation((await t.reservation()).reservationId)).toHaveLength(1);
    t.host.failAfterInjection = undefined;
    t.clock.at = later(120_000);
    expect((await t.discuss("alt")).ok).toBe(false);
    expect((await t.reservation()).state).toBe("unresolved");
  }
  const retry = (t: Awaited<ReturnType<typeof setup>>) => t.discuss("alt", { retryUnresolved: true, confirmedNoChat: true });

  it("only the earlier attempt's grant exists: the new chat is never pending, in the Discuss response or in the header", async () => {
    const t = await setup();
    await unresolved(t);
    t.host.injection = "skip";
    const opened = OpenOk.parse(await retry(t));
    expect(opened.value.agentId).toBe("agent-2");
    expect(["unknown", "not_attached"]).toContain(opened.value.tools);
    expect(["unknown", "not_attached"]).toContain(await t.headerTools(opened.value.sessionId));
  });

  it("only the earlier attempt's grant exists and the retry is reconciled minutes later: never pending", async () => {
    const t = await setup();
    await unresolved(t);
    t.host.injection = "skip";
    t.host.failAfterInjection = UNCERTAIN;
    expect((await retry(t)).ok).toBe(false);
    t.host.failAfterInjection = undefined;
    const { reservationId } = await t.reservation();
    t.host.listed = [{ id: "agent-2", labels: { [LABEL]: reservationId }, archivedAt: null }];
    t.clock.at = later(300_000);
    const reconciled = OpenOk.parse(await t.discuss("alt"));
    expect(reconciled.value.agentId).toBe("agent-2");
    expect(["unknown", "not_attached"]).toContain(reconciled.value.tools);
    expect(["unknown", "not_attached"]).toContain(await t.headerTools(reconciled.value.sessionId));
  });

  it("the retry's own grant lost its mark: unknown, neither pending from the earlier grant nor not attached", async () => {
    const t = await setup();
    await unresolved(t);
    t.host.injection = "dropEnv";
    const opened = OpenOk.parse(await retry(t));
    expect(opened.value.tools).toBe("unknown");
    expect(await t.headerTools(opened.value.sessionId)).toBe("unknown");
  });

  it("both attempts issued a marked grant: unknown until the new chat's own grant is bound to it", async () => {
    const t = await setup();
    await unresolved(t);
    const opened = OpenOk.parse(await retry(t));
    expect(await t.state.grantsForReservation((await t.reservation()).reservationId)).toHaveLength(2);
    expect(opened.value.tools).toBe("unknown");
    expect(await t.headerTools(opened.value.sessionId)).toBe("unknown");
    await t.sessionOpen(opened.value.agentId);
    expect(await t.headerTools(opened.value.sessionId)).toBe("attached");
  });

  it("the earlier attempt's agentless grant is never bound to the new chat by its session", async () => {
    const t = await setup();
    await unresolved(t);
    t.host.injection = "skip";
    const opened = OpenOk.parse(await retry(t));
    await t.sessionOpen(opened.value.agentId);
    expect(await t.state.grantForAgent(opened.value.agentId)).toBeNull();
    expect(await t.headerTools(opened.value.sessionId)).not.toBe("attached");
    expect(await t.headerTools(opened.value.sessionId)).not.toBe("pending");
  });
});

// Review regressions for the reservation marks file beside grants.json. When it cannot be read or
// parsed, every tools state that needs it is unknown, and issuing a grant leaves it byte for byte as
// it was (replacing it would drop the earlier marks) and keeps every grant already recorded.
describe("an unreadable reservation marks file", () => {
  for (const [name, bytes] of [
    ["corrupt JSON", "{ not json"],
    ["an unknown version", JSON.stringify({ version: 2, marks: [{ grantId: "g-earlier", reservationId: "r-earlier" }] })],
  ] as const) {
    it(`${name}: unknown in the Discuss response and the header, existing marks and grants preserved`, async () => {
      const t = await setup();
      const earlier = await t.unrelatedAgent();
      const marksPath = join(t.stateDir, "reservations.json");
      await writeFile(marksPath, bytes);
      const grantsBefore = z.looseObject({ grants: z.array(z.looseObject({ grantId: z.string() })) }).parse(JSON.parse(await readFile(join(t.stateDir, "grants.json"), "utf8"))).grants;
      expect(grantsBefore).toHaveLength(1);
      const opened = OpenOk.parse(await t.discuss("alt"));
      expect(opened.value.tools).toBe("unknown");
      expect(await t.headerTools(opened.value.sessionId)).toBe("unknown");
      expect(await readFile(marksPath, "utf8")).toBe(bytes);
      const grantsAfter = z.looseObject({ grants: z.array(z.looseObject({ grantId: z.string() })) }).parse(JSON.parse(await readFile(join(t.stateDir, "grants.json"), "utf8"))).grants;
      expect(grantsAfter.map((g) => g.grantId)).toEqual(expect.arrayContaining(grantsBefore.map((g) => g.grantId)));
      expect(grantsAfter).toHaveLength(2);
      expect(earlier).toBe("agent-1");
    });
  }

  it("a marks path that cannot be read as a file: unknown, and the path is left as it is", async () => {
    const t = await setup();
    const marksPath = join(t.stateDir, "reservations.json");
    await mkdir(marksPath, { recursive: true });
    await writeFile(join(marksPath, "keep.txt"), "someone else's data");
    const opened = OpenOk.parse(await t.discuss("alt"));
    expect(opened.value.tools).toBe("unknown");
    expect(await t.headerTools(opened.value.sessionId)).toBe("unknown");
    expect(await readFile(join(marksPath, "keep.txt"), "utf8")).toBe("someone else's data");
  });
});

// Review regressions for unmarked grants: a grant issued without the creation's reservation (an older
// plugin or a host that did not pass the env) cannot be attributed by directory or time. When the
// creation's own grant may be such a grant, issued at the creation but bound more than a minute
// later, absence cannot be proved: the state is unknown, never not attached nor pending.
describe("an unmarked grant from the creation, older than a minute at the binding", () => {
  it("is unknown in the reconciled Discuss response and in the header", async () => {
    const t = await setup();
    t.host.injection = "dropEnv";
    t.host.failAfterInjection = new Error("connection dropped after the agent was created");
    expect((await t.discuss("alt")).ok).toBe(false);
    t.host.failAfterInjection = undefined;
    const { reservationId } = await t.reservation();
    expect(await t.state.grantsForReservation(reservationId)).toEqual([]);
    t.host.listed = [{ id: "agent-1", labels: { [LABEL]: reservationId }, archivedAt: null }];
    t.clock.at = later(180_000);
    const reconciled = OpenOk.parse(await t.discuss("alt"));
    expect(reconciled.value.tools).toBe("unknown");
    expect(await t.headerTools(reconciled.value.sessionId)).toBe("unknown");
  });

  it("read again an hour later in the header, it is still unknown", async () => {
    const t = await setup();
    t.host.injection = "dropEnv";
    const opened = OpenOk.parse(await t.discuss("alt"));
    expect(opened.value.tools).toBe("unknown");
    t.clock.at = later(3_600_000);
    expect(await t.headerTools(opened.value.sessionId)).toBe("unknown");
  });
});

// Review regressions at 2a614e0. A grant the discussion chat really was issued, later invalidated by
// the MCP endpoint's port rotation (the endpoint calls McpState.markStale with the old port when it
// cannot listen there again; here the real markStale is called directly), gives the chat no tools:
// the state is not attached or unknown, never pending or attached. The client copy for "not
// attached" must then not claim that none was ever issued (client/discussion-controls.test.ts and
// client/grilling-blocks.test.ts).
describe("a discussion grant invalidated by port rotation", () => {
  it("an unbound grant made stale is neither pending nor attached, in the Discuss response or the header", async () => {
    const t = await setup();
    const opened = OpenOk.parse(await t.discuss("alt"));
    expect(opened.value.tools).toBe("pending");
    expect(await t.state.markStale(1)).toHaveLength(1);
    const again = OpenOk.parse(await t.discuss("alt"));
    expect(again.value.agentId).toBe(opened.value.agentId);
    expect(["not_attached", "unknown"]).toContain(again.value.tools);
    expect(["not_attached", "unknown"]).toContain(await t.headerTools(opened.value.sessionId));
  });

  it("a bound grant made stale is no longer attached, in the Discuss response or the header", async () => {
    const t = await setup();
    const opened = OpenOk.parse(await t.discuss("alt"));
    await t.sessionOpen(opened.value.agentId);
    expect(await t.headerTools(opened.value.sessionId)).toBe("attached");
    expect(await t.state.markStale(1)).toHaveLength(1);
    expect(["not_attached", "unknown"]).toContain(OpenOk.parse(await t.discuss("alt")).value.tools);
    expect(["not_attached", "unknown"]).toContain(await t.headerTools(opened.value.sessionId));
  });
});

// Review regressions at 2a614e0 and 0c97a6b. Deleting a feature whose discussion chat is bound
// leaves the discussion session (its history stays readable) but drops the feature's reservation,
// the only link from the chat to its marked grant. Without it the grant cannot be attributed, so
// every live unbound grant in the chat's workspace since its session's creation, marked or not, makes
// the orphaned session unknown, never not attached nor pending. The reservation marks are not needed
// for that count, so an unreadable marks file neither hides such a grant nor stops an orphan without
// one from reading not attached. A grant bound to the chat's own agent still reads attached. No policy
// for deleting a bound feature is assumed beyond what the delete command does today.
describe("a deleted feature's orphaned discussion session", () => {
  it("is unknown while its marked grant exists unbound, and its history stays readable", async () => {
    const t = await setup();
    const opened = OpenOk.parse(await t.discuss("alt"));
    expect(await t.headerTools(opened.value.sessionId)).toBe("pending");
    const { reservationId } = await t.reservation();
    await t.deleteFeature(t.featureId);
    // The chat's marked grant is still there, unbound; only the feature's record of it is gone.
    expect((await t.state.grantsForReservation(reservationId)).map((g) => g.agentId)).toEqual([undefined]);
    expect(await t.headerTools(opened.value.sessionId)).toBe("unknown");
    const view = await t.sessionView(opened.value.sessionId);
    expect(view.questions.map((q) => q.question.title)).toEqual(["Language"]);
    expect(view.session.planner).toMatchObject({ agentId: opened.value.agentId, boundBy: "discussion" });
  });

  it("still reads attached once the grant is bound to the chat's own agent", async () => {
    const t = await setup();
    const opened = OpenOk.parse(await t.discuss("alt"));
    await t.headerTools(opened.value.sessionId);
    await t.deleteFeature(t.featureId);
    await t.sessionOpen(opened.value.agentId);
    expect(await t.headerTools(opened.value.sessionId)).toBe("attached");
  });

  it("with an unreadable marks file: unknown while its own unbound grant exists, the file left as it was", async () => {
    const t = await setup();
    const opened = OpenOk.parse(await t.discuss("alt"));
    await t.headerTools(opened.value.sessionId);
    await t.deleteFeature(t.featureId);
    const marksPath = join(t.stateDir, "reservations.json");
    await writeFile(marksPath, "{ not json");
    expect(await t.headerTools(opened.value.sessionId)).toBe("unknown");
    expect(await readFile(marksPath, "utf8")).toBe("{ not json");
  });

  it("with an unreadable marks file and no grant that could be its own: not attached", async () => {
    const t = await setup();
    const opened = OpenOk.parse(await t.discuss("no-mcp"));
    await t.headerTools(opened.value.sessionId);
    await t.deleteFeature(t.featureId);
    // No grant was issued, so the state directory does not exist yet.
    await mkdir(t.stateDir, { recursive: true });
    await writeFile(join(t.stateDir, "reservations.json"), "{ not json");
    expect(await t.headerTools(opened.value.sessionId)).toBe("not_attached");
  });

  it("another feature's unbound marked grant never makes it pending", async () => {
    const t = await setup();
    const opened = OpenOk.parse(await t.discuss("no-mcp"));
    await t.headerTools(opened.value.sessionId);
    await t.deleteFeature(t.featureId);
    const other = await t.createFeature("Search");
    const otherOpened = OpenOk.parse(await t.discuss("alt", { featureId: other }));
    expect(otherOpened.value.tools).toBe("pending");
    expect(await t.headerTools(opened.value.sessionId)).not.toBe("pending");
  });
});
