// Preapproved roadmap tools in the dedicated feature-discussion chat only (owner approval,
// 2026-11-08): the chat Discuss creates may use the roadmap's read tools and create questions
// without a per-call approval prompt. It is never preapproved to answer, confirm, accept, cancel,
// mark out of scope, finish, draft or approve plans, edit cards or run work, and no other agent's
// approvals change. No general approval policy, mode or setting is changed.
//
// Host semantics, read from the installed host 0.15.3 (read-only):
// - the agent config carries `toolPolicy.preapproved: { kind: "mcp", server, tool }[]`, exact tool
//   grants; the 0.12 client passes every config field through to the daemon, and splits
//   "provider/model";
// - the agent.create before-hook runs before the daemon applies the provider configuration;
// - the daemon then rejects the creation when a grant names an MCP server that is not in the same
//   request (`validateToolPolicyServers`), and when the provider cannot preapprove exact MCP tools
//   (only claude, codex and opencode can; copilot and others throw);
// - the hook sees the creation env, where Discuss passes the chat's reservation; it sees no agent id
//   or labels, so the reservation is what identifies the discussion chat's creation.
// - the provider then applies the grants (host 0.15.3 `applyToolPolicy`): Claude adds each grant to
//   `allowedTools` and OpenCode adds an allow rule, so the server keeps all its tools; Codex sets a
//   granted server's `enabled_tools` to exactly its granted tools, so every other tool of that
//   server disappears from the chat.
// `hostApply` below mirrors those two daemon checks, so a config the real daemon would refuse fails
// the creation here as well, and returns what each provider then shows and auto-approves, so a
// grant that hides a roadmap tool fails here too.
//
// Real temp store, real grant state and the REAL injection hook; the host is a synthetic fake.
// Whether the grants are added by Discuss or by the injection is left to the implementation: the
// assertions read the final config the daemon would apply.
import { mkdtemp, realpath, rm } from "node:fs/promises";
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
import { createMcpState, PLUGIN_ID, RESERVATION_ENV } from "./mcp-state";
import { TOOL_NAMES } from "./mcp-tools";
import { STAGE3_TOOL_NAMES } from "./plan-tools";
import { FEATURE_TOOL_NAMES } from "./feature-tools";
import { createPaseoHolder } from "./paseo-holder";
import { createRoadmapCommands, UI_ORIGIN, type StoreOpener } from "./sessions";
import { openStore } from "./store";
import { openProjectStore } from "./store-root";
import { fixedClock, nextId } from "./test-support/build";
import { fakeDirectory } from "./test-support/fake-dir";
import { fakeHookServer } from "./test-support/mcp";
import { makeProject, ok, type TestProject } from "./test-support/service";

const P = "prj_test";
const WS = "wks_1";
const OTHER_SERVER = "other-plugin";
const OTHER_GRANT = { kind: "mcp" as const, server: OTHER_SERVER, tool: "lookup" };

/** What the discussion chat must be able to do without a prompt: the reads its prompt names, and asking. */
const REQUIRED = ["roadmap_overview", "roadmap_get_session", "roadmap_feature_list", "roadmap_ask"];
/** The roadmap's read-only tools and its question creation; nothing outside this may be preapproved. */
const ALLOWED = new Set([
  ...REQUIRED,
  "roadmap_resolve_link",
  "roadmap_pause_instructions",
  "roadmap_plan_status",
  "roadmap_dod_template",
]);
/** Writes the owner excluded, named so a failure says which one leaked (ALLOWED already excludes them). */
const EXCLUDED = [
  "roadmap_answer", "roadmap_confirm", "roadmap_block_accept", "roadmap_cancel_question", "roadmap_out_of_scope",
  "roadmap_grill_propose_finish", "roadmap_grill_complete", "roadmap_plan_draft", "roadmap_task_update",
  "roadmap_update_question", "roadmap_discuss", "roadmap_link", "roadmap_relate", "roadmap_create_session",
  "roadmap_feature_create", "roadmap_feature_update", "roadmap_run_next", "roadmap_task_claim", "roadmap_start",
];
const EXACT_PREAPPROVAL = new Set(["claude", "codex", "opencode"]);

const PROFILES = [
  { id: "p-claude", name: "Claude", provider: "claude", model: "synthetic-claude" },
  { id: "p-codex", name: "Codex default", provider: "codex", model: "synthetic-codex", modeId: "default", featureValues: { plan_mode: false } },
  { id: "p-opencode", name: "OpenCode", provider: "opencode", model: "synthetic-opencode" },
  { id: "p-copilot", name: "Copilot", provider: "copilot", model: "synthetic-copilot" },
];

const Grant = z.object({ kind: z.literal("mcp"), server: z.string(), tool: z.string() }).strict();
const Config = z.looseObject({
  provider: z.string(),
  modeId: z.string().optional(),
  featureValues: z.record(z.string(), z.unknown()).optional(),
  mcpServers: z.record(z.string(), z.unknown()).optional(),
  toolPolicy: z.object({ preapproved: z.array(Grant) }).strict().optional(),
});
type Config = z.infer<typeof Config>;

/** Every tool the roadmap server offers to a chat. */
const ROADMAP_TOOLS = [...new Set<string>([...TOOL_NAMES, ...STAGE3_TOOL_NAMES, ...FEATURE_TOOL_NAMES, ...EXCLUDED])];

/** Per server: the tools the chat sees ("all": not restricted) and those it may call without a prompt. */
type Effective = { visible: Map<string, Set<string> | "all">; auto: Set<string> };

/** The daemon's checks after the before-hooks (host 0.15.3 agent-manager / provider-registry), then the provider's application. */
function hostApply(config: Config): Effective {
  const servers = Object.keys(config.mcpServers ?? {});
  const effective: Effective = { visible: new Map(servers.map((s) => [s, "all"])), auto: new Set() };
  if (config.toolPolicy === undefined) return effective;
  for (const g of config.toolPolicy.preapproved) {
    if (!servers.includes(g.server)) throw new Error(`toolPolicy preapproval '${g.server}.${g.tool}' requires MCP server '${g.server}' in the same agent request`);
  }
  if (!EXACT_PREAPPROVAL.has(config.provider)) throw new Error(`Provider '${config.provider}' cannot preapprove exact MCP tools for unattended execution`);
  for (const g of config.toolPolicy.preapproved) {
    effective.auto.add(`${g.server}/${g.tool}`);
    // codex/options.js applyCodexToolPolicy: `enabled_tools` is the granted list of that server.
    if (config.provider === "codex") {
      const seen = effective.visible.get(g.server);
      effective.visible.set(g.server, seen === "all" || seen === undefined ? new Set([g.tool]) : seen.add(g.tool));
    }
  }
  return effective;
}

/** The server entries that reach the roadmap endpoint with the chat's grant (the injected URL). */
const roadmapServers = (config: Config) => {
  const url = JSON.stringify(config.mcpServers?.[PLUGIN_ID]);
  return Object.entries(config.mcpServers ?? {}).flatMap(([name, entry]) => (url !== undefined && JSON.stringify(entry) === url ? [name] : []));
};

/** The roadmap tools preapproved on any server entry that reaches the roadmap endpoint. */
const ours = (config: Config) => {
  const servers = new Set(roadmapServers(config));
  return (config.toolPolicy?.preapproved ?? []).filter((g) => servers.has(g.server)).map((g) => g.tool);
};

let project: TestProject | undefined;
const roots: string[] = [];
afterEach(async () => {
  await project?.cleanup();
  project = undefined;
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});

async function setup(o: { endpointFails?: boolean } = {}) {
  project = await makeProject();
  const proj = project;
  const WS_DIR = proj.root;
  const stateParent = await realpath(await mkdtemp(join(tmpdir(), "dr-preapproval-")));
  roots.push(stateParent);
  const state = createMcpState({ stateDir: join(stateParent, "state"), now: fixedClock, newId: nextId, log: () => undefined });
  const dir = fakeDirectory({ projects: [{ projectId: P, projectRootPath: proj.root, projectKind: "git" }], workspaces: [{ id: WS, projectId: P, directory: WS_DIR }] });
  const storeOptions = { now: fixedClock, newId: nextId, log: () => undefined };
  const base = { directory: () => dir, now: fixedClock, newId: nextId, storeOptions };
  const commands = createRoadmapCommands(base);
  const features = createFeatureCommands(base);
  const open: StoreOpener = (projectId) => openProjectStore(dir, projectId, storeOptions);
  ok(await commands.init(open, { projectId: P }, UI_ORIGIN));
  const revision = async () => ok(await commands.version(open, { projectId: P }, UI_ORIGIN)).revision!;

  const hooks = fakeHookServer();
  const SECRET_URL = "http://127.0.0.1:1/mcp/synthetic-grant-path";
  const endpoint = o.endpointFails === true
    ? Promise.reject(new Error("synthetic endpoint failure"))
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- a synthetic endpoint: the injection reads only its port and URL builder
    : Promise.resolve({ port: 1, urlFor: () => SECRET_URL } as unknown as McpEndpoint);
  endpoint.catch(() => undefined);
  registerInjection(hooks.server, { endpoint, state, holder: createPaseoHolder(), directory: () => dir, openStore, log: () => undefined });

  const host = {
    finals: [] as Array<{ config: Config; env: Record<string, string>; effective: Effective }>,
    /** The prompts Discuss sent to the created chats. */
    prompts: [] as string[],
    /** Another plugin's before-hook that runs first and appends its own exact grant and server. */
    otherPluginFirst: false,
    next: 1,
  };
  let paseo: PaseoApi;
  /** The 0.12 client's translation, the before-hooks, then the daemon's checks. */
  const createAgent = async (options: { config: Record<string, unknown> & { provider: string }; title?: string; env?: Record<string, string> }) => {
    const { provider: providerModel, ...runtime } = options.config;
    const slash = providerModel.indexOf("/");
    let request: { config: Record<string, unknown>; env: Record<string, string> } = {
      config: { ...runtime, provider: providerModel.slice(0, slash), model: providerModel.slice(slash + 1), cwd: WS_DIR, title: options.title ?? null },
      env: options.env ?? {},
    };
    if (host.otherPluginFirst) {
      const prior = Config.parse(request.config);
      request = {
        ...request,
        config: {
          ...request.config,
          mcpServers: { ...prior.mcpServers, [OTHER_SERVER]: { type: "http", url: "http://127.0.0.1:2/other" } },
          toolPolicy: { preapproved: [...(prior.toolPolicy?.preapproved ?? []), OTHER_GRANT] },
        },
      };
    }
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- the synthetic request is built field by field like the client's; the hook reads it as the SDK request
    const out = await hooks.runBefore(request as unknown as Parameters<typeof hooks.runBefore>[0], paseo);
    const final = out ?? request;
    const config = Config.parse(final.config);
    const effective = hostApply(config);
    host.finals.push({ config, env: { ...(final.env ?? {}) }, effective });
    return { id: `agent-${host.next++}` };
  };
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- synthetic host: only the PaseoApi members these paths use exist
  paseo = {
    config: { get: async () => ({ revision: "r1", config: { agentProfiles: PROFILES } }) },
    workspaces: { ref: (id: string) => ({ id, agents: { create: createAgent } }) },
    agents: { list: async () => ({ requestId: "r", entries: [], pageInfo: {} }), ref: (agentId: string) => ({ id: agentId, send: async (text: string) => void host.prompts.push(text) }) },
  } as unknown as PaseoApi;

  const deps = (): DiscussionDeps => ({
    open, commands, settings: async () => roadmapSettings.schema.parse({}), directory: () => dir, state, now: fixedClock, newId: nextId, log: () => undefined,
  });
  const discuss = async (profileRef: string) => {
    const featureId = ok(await features.create(open, { projectId: P, expectedRevision: await revision(), title: `Feature ${host.next}`, description: "", kind: "feature" }, UI_ORIGIN)).featureId;
    return openDiscussion(deps(), paseo, { projectId: P, expectedRevision: await revision(), featureId, workspaceId: WS, profileRef });
  };
  return { host, discuss, createAgent, SECRET_URL };
}

describe("the discussion chat's preapproved roadmap tools", () => {
  for (const profile of PROFILES.filter((p) => EXACT_PREAPPROVAL.has(p.provider))) {
    it(`${profile.provider}: only read tools and question creation, all on the roadmap server, and the profile's mode untouched`, async () => {
      const t = await setup();
      expect((await t.discuss(profile.id)).ok).toBe(true);
      const [{ config, env, effective }] = t.host.finals;
      expect(config.mcpServers).toHaveProperty(PLUGIN_ID);
      const tools = ours(config);
      for (const required of REQUIRED) expect(tools, `preapproved ${required}`).toContain(required);
      for (const tool of tools) expect(ALLOWED.has(tool), `not preapprovable: ${tool}`).toBe(true);
      for (const excluded of EXCLUDED) expect(tools).not.toContain(excluded);
      expect(new Set(tools).size).toBe(tools.length);
      const servers = new Set(roadmapServers(config));
      expect((config.toolPolicy?.preapproved ?? []).every((g) => servers.has(g.server))).toBe(true);
      // The roadmap server itself stays complete: no roadmap tool is hidden from the chat by a grant.
      expect(effective.visible.get(PLUGIN_ID), "the roadmap server keeps every tool").toBe("all");
      for (const tool of ROADMAP_TOOLS) {
        const callable = [...servers].some((s) => {
          const v = effective.visible.get(s);
          return v === "all" || v?.has(tool) === true;
        });
        expect(callable, `${tool} still reachable`).toBe(true);
      }
      // Without a prompt: exactly the granted read and ask tools, on whichever roadmap entry carries them.
      const auto = [...effective.auto].filter((k) => servers.has(k.slice(0, k.lastIndexOf("/")))).map((k) => k.slice(k.lastIndexOf("/") + 1));
      for (const tool of auto) expect(ALLOWED.has(tool), `auto-approved: ${tool}`).toBe(true);
      expect(config.modeId).toBe(profile.modeId);
      expect(config.featureValues).toEqual(profile.featureValues);
      // No grant secret in what the agent config or env carry beyond the MCP server entry itself.
      expect(JSON.stringify(config.toolPolicy)).not.toContain(t.SECRET_URL);
      expect(JSON.stringify(env)).not.toContain(t.SECRET_URL);
    });
  }

  it("copilot cannot preapprove exact tools: no grant is added, so the host does not refuse the creation", async () => {
    const t = await setup();
    expect((await t.discuss("p-copilot")).ok).toBe(true);
    const [{ config }] = t.host.finals;
    expect(config.mcpServers).toHaveProperty(PLUGIN_ID);
    expect(config.toolPolicy?.preapproved ?? []).toEqual([]);
  });

  it("when the roadmap server is not injected, no grant names it, so the creation is not refused", async () => {
    const t = await setup({ endpointFails: true });
    expect((await t.discuss("p-claude")).ok).toBe(true);
    const [{ config }] = t.host.finals;
    expect(config.mcpServers ?? {}).not.toHaveProperty(PLUGIN_ID);
    expect(ours(config)).toEqual([]);
  });

  it("another plugin's earlier preapproval is kept beside the discussion chat's grants", async () => {
    const t = await setup();
    t.host.otherPluginFirst = true;
    expect((await t.discuss("p-claude")).ok).toBe(true);
    const [{ config }] = t.host.finals;
    expect(config.toolPolicy?.preapproved).toContainEqual(OTHER_GRANT);
    expect(config.mcpServers).toHaveProperty(OTHER_SERVER);
    expect(ours(config)).toEqual(expect.arrayContaining(REQUIRED));
  });
});

describe("agents other than the discussion chat are unchanged", () => {
  it("an agent created without the discussion reservation gets no roadmap preapproval and keeps its own exactly", async () => {
    const t = await setup();
    await t.createAgent({ config: { provider: "claude/synthetic-claude", mcpServers: { [OTHER_SERVER]: { type: "http", url: "http://127.0.0.1:2/other" } }, toolPolicy: { preapproved: [OTHER_GRANT] } } });
    await t.createAgent({ config: { provider: "codex/synthetic-codex", modeId: "default" } });
    const [withOwn, without] = t.host.finals;
    expect(withOwn.config.mcpServers).toHaveProperty(PLUGIN_ID);
    expect(withOwn.config.toolPolicy).toEqual({ preapproved: [OTHER_GRANT] });
    expect(Object.keys(withOwn.config.mcpServers ?? {}).sort()).toEqual([OTHER_SERVER, PLUGIN_ID].sort());
    expect(without.config.mcpServers).toHaveProperty(PLUGIN_ID);
    expect(Object.keys(without.config.mcpServers ?? {})).toEqual([PLUGIN_ID]);
    expect(without.config.toolPolicy).toBeUndefined();
    expect(without.config.modeId).toBe("default");
  });

  it("a malformed reservation, or one Discuss did not reserve, in the env is not taken for the discussion chat", async () => {
    const t = await setup();
    await t.createAgent({ config: { provider: "claude/synthetic-claude" }, env: { [RESERVATION_ENV]: "../not a reservation" } });
    await t.createAgent({ config: { provider: "codex/synthetic-codex" }, env: { [RESERVATION_ENV]: "res-not-reserved" } });
    for (const { config } of t.host.finals) {
      expect(ours(config)).toEqual([]);
      expect(Object.keys(config.mcpServers ?? {})).toEqual([PLUGIN_ID]);
    }
  });
});

// Integration gap: a Codex discussion chat sees two server entries offering the same read and ask
// tools, and only the second (its preapproval entry) runs them without a prompt. The discussion prompt
// therefore tells a Codex chat to prefer that entry for the preapproved read and ask tools when it is
// available, falling back to the roadmap server otherwise, and to use the roadmap server for the
// owner-controlled tools. Other providers have their grants on the roadmap server itself and are not
// told about a second entry. The prompt can only direct the chat; which tool the model calls is not
// something these cases, or the plugin, can guarantee.
describe("the discussion prompt and the Codex preapproval entry", () => {
  const ALIAS = `${PLUGIN_ID}-discuss`;
  const OWNER_CONTROLLED = ["roadmap_answer", "roadmap_out_of_scope", "roadmap_cancel_question", "roadmap_grill_propose_finish", "roadmap_block_accept"];

  it("codex: prefers the preapproval entry for read and ask tools, with a fallback, and the roadmap server for owner-controlled tools", async () => {
    const t = await setup();
    expect((await t.discuss("p-codex")).ok).toBe(true);
    expect(t.host.finals[0].config.mcpServers).toHaveProperty(ALIAS);
    expect(t.host.prompts).toHaveLength(1);
    const prompt = t.host.prompts[0];
    const aliasLines = prompt.split("\n").filter((l) => l.includes(ALIAS));
    expect(aliasLines.length, "the prompt names the preapproval entry").toBeGreaterThan(0);
    const aliasText = aliasLines.join("\n");
    expect(aliasText).toContain("roadmap_ask");
    expect(aliasText).toMatch(/roadmap_(overview|get_session|feature_list)/);
    // A fallback when the entry is not there.
    expect(aliasText).toMatch(/if (it is )?(not )?(available|present|listed|offered)|otherwise|fall ?back/i);
    // Owner-controlled tools are never directed to the preapproval entry.
    for (const tool of OWNER_CONTROLLED) expect(aliasText, tool).not.toContain(tool);
    // The roadmap server itself is named for the other tools.
    expect(prompt).toMatch(new RegExp(`${PLUGIN_ID}(?!-discuss)`));
  });

  for (const profile of ["p-claude", "p-opencode", "p-copilot"]) {
    it(`${profile}: the prompt does not mention a second entry`, async () => {
      const t = await setup();
      expect((await t.discuss(profile)).ok).toBe(true);
      expect(t.host.prompts).toHaveLength(1);
      expect(t.host.prompts[0]).not.toContain(ALIAS);
    });
  }
});
