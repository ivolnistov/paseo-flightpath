import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginBeforeRequests, PluginSessionOpenRequest } from "@getpaseo/plugin/server";
import { afterEach, describe, expect, it } from "vitest";
import { registerInjection } from "./injection";
import type { McpEndpoint } from "./mcp-endpoint";
import { openStore } from "./store";
import { jsonString, readJsonObject } from "./test-support/build";
import { fakeHookServer, startTestEndpoint, type TestEndpoint } from "./test-support/mcp";

type CreateRequest = PluginBeforeRequests["agent.create"];
/** R3.2: the grant fingerprint in the agent env, sha256Hex(grantId).slice(0, 32). Not a credential. */
const fp32 = (grantId: string) => createHash("sha256").update(grantId, "utf8").digest("hex").slice(0, 32);
const URL_RE = /^http:\/\/127\.0\.0\.1:\d+\/mcp\/[A-Za-z0-9_-]{1,64}\.[A-Za-z0-9_-]{43}$/;

let t: TestEndpoint | undefined;
const temps: string[] = [];
afterEach(async () => {
  await t?.stop();
  t = undefined;
  await Promise.all(temps.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function temp(prefix: string) {
  const d = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  temps.push(d);
  return d;
}

/** Opted-in project prj_test with a separate registered worktree directory, plus injection hooks. */
async function setup(opts: { endpoint?: Promise<McpEndpoint> } = {}) {
  t = await startTestEndpoint();
  const worktree = await temp("dr-wt-");
  t.dir.registry.workspaces.push({ id: "ws-main", projectId: "prj_test", directory: t.project.root }, { id: "ws-wt", projectId: "prj_test", directory: worktree });
  const hooks = fakeHookServer();
  const unregister = registerInjection(hooks.server, {
    endpoint: opts.endpoint ?? Promise.resolve(t.endpoint),
    state: t.state,
    holder: t.holder,
    directory: () => t!.dir.directory,
    openStore,
    log: (m: string) => void t!.logs.push(m),
  });
  const grantsFile = join(t.stateDir, "grants.json");
  const grants = async () => readFile(grantsFile, "utf8").catch(() => null);
  return { t, hooks, worktree, unregister, grants };
}

const request = (cwd: string, extra: Partial<CreateRequest["config"]> = {}): CreateRequest =>
  ({
    config: { provider: "claude", cwd, title: "synthetic agent", mcpServers: { other: { type: "stdio", command: "other-mcp", args: [] } }, ...extra },
    env: { SYNTHETIC: "1" },
  });

/** The hook's rewrite; a skipped (void) result fails here, as the old `.config` read on it did. */
const rewritten = async (p: Promise<CreateRequest | void>): Promise<CreateRequest> => {
  const out = await p;
  if (!out) throw new Error("the hook returned no rewritten request");
  return out;
};
/** The injected decision-roadmap server's URL: only http/sse servers carry one (stdio has none). */
const roadmapUrl = (out: CreateRequest): string | undefined => {
  const server = out.config.mcpServers?.["decision-roadmap"];
  return server && "url" in server ? server.url : undefined;
};
describe("agent.create injection", () => {
  it("injects a project-scoped HTTP MCP server for a new agent in a registered worktree, preserving everything else", async () => {
    const s = await setup();
    const req = request(s.worktree);
    const before = structuredClone(req);
    const out = await rewritten(s.hooks.runBefore(req, s.t.paseo));
    expect(req).toEqual(before); // input not mutated
    const servers = out.config.mcpServers;
    expect(servers?.["decision-roadmap"]?.type).toBe("http");
    expect(roadmapUrl(out)).toMatch(URL_RE);
    expect(servers?.other).toEqual(before.config.mcpServers!.other);
    const { mcpServers: _a, ...restOut } = out.config;
    const { mcpServers: _b, ...restIn } = before.config;
    expect(restOut).toEqual(restIn);
    const grantId = new URL(roadmapUrl(out) ?? "").pathname.slice("/mcp/".length).split(".")[0];
    // R3.2 (card §3.2): the env gains only the 32-hex grant fingerprint; every other variable is kept.
    expect(out.env).toEqual({ ...before.env, PASEO_ROADMAP_GRANT_FP: fp32(grantId) });
    expect(await s.t.state.getGrant(grantId)).toMatchObject({ projectId: "prj_test", storeRoot: s.t.project.root, provider: "claude", cwd: s.worktree, stale: false });
    expect(s.t.holder.get()).toBe(s.t.paseo);
    const line = s.t.logs.find((l) => l.startsWith("injected"))!;
    expect(line).toMatch(/fp=[0-9a-f]{8}/);
    expect(line).toContain("project=prj_test");
    expect(line).toContain("provider=claude");
    expect(s.t.logs.join("\n")).not.toContain("/mcp/");
  });

  it.each(["codex", "opencode", "copilot"])("injects for allow-listed provider %s", async (provider) => {
    const s = await setup();
    const out = await rewritten(s.hooks.runBefore(request(s.worktree, { provider }), s.t.paseo));
    expect(roadmapUrl(out)).toMatch(URL_RE);
  });

  const skipCases: Array<[string, (s: Awaited<ReturnType<typeof setup>>) => Promise<CreateRequest>]> = [
    ["a provider outside the allowlist", async (s) => request(s.worktree, { provider: "gemini" })],
    ["an existing decision-roadmap server", async (s) => request(s.worktree, { mcpServers: { "decision-roadmap": { type: "http", url: "http://127.0.0.1:1/x" } } })],
    ["an unregistered cwd", async () => request(await temp("dr-unreg-"))],
    [
      "a project whose store was never initialised",
      async (s) => {
        const root = await temp("dr-noinit-");
        s.t.dir.registry.projects.push({ projectId: "prj_new", projectRootPath: root, projectKind: "git" });
        return request(root);
      },
    ],
    [
      "an invalid store",
      async (s) => {
        const dec = join(s.t.project.root, ".decisions");
        const manifest = readJsonObject(await readFile(join(dec, "manifest.json"), "utf8"));
        await writeFile(join(dec, "generations", jsonString(manifest, "generation"), "roadmap.json"), "{ truncated");
        return request(s.worktree);
      },
    ],
    [
      "a disabled store",
      async (s) => {
        const path = join(s.t.project.root, ".decisions", "manifest.json");
        await writeFile(path, JSON.stringify({ ...JSON.parse(await readFile(path, "utf8")), disabled: true }));
        return request(s.worktree);
      },
    ],
    [
      "an unsafe root (.decisions is a symlink)",
      async (s) => {
        const moved = await temp("dr-moved-");
        await rename(join(s.t.project.root, ".decisions"), join(moved, ".decisions"));
        await symlink(join(moved, ".decisions"), join(s.t.project.root, ".decisions"));
        return request(s.worktree);
      },
    ],
  ];
  it.each(skipCases)("does not inject for %s, issues no grant and logs no URL", async (_name, prepare) => {
    const s = await setup();
    const req = await prepare(s);
    const grantsBefore = await s.grants();
    expect(await s.hooks.runBefore(req, s.t.paseo)).toBeUndefined();
    expect(await s.grants()).toBe(grantsBefore);
    expect(s.t.logs.join("\n")).not.toContain("/mcp/");
  });

  it("does not inject when the endpoint failed to start", async () => {
    const failed = Promise.reject(new Error("listen failed"));
    failed.catch(() => undefined);
    const s = await setup({ endpoint: failed });
    const grantsBefore = await s.grants();
    expect(await s.hooks.runBefore(request(s.worktree), s.t.paseo)).toBeUndefined();
    expect(await s.grants()).toBe(grantsBefore);
  });

  it("fails open when the directory throws", async () => {
    const s = await setup();
    s.t.dir.directory.listWorkspaces = async () => {
      throw new Error("daemon unavailable");
    };
    await expect(s.hooks.runBefore(request(s.worktree), s.t.paseo)).resolves.toBeUndefined();
    expect(s.t.logs.some((l) => l.startsWith("injection skipped"))).toBe(true);
  });
});

describe("registrations and hydration hooks", () => {
  it("registers exactly agent.create, agent.session_open and agent.turn_started", async () => {
    const s = await setup();
    expect(s.hooks.registrations()).toEqual([
      { kind: "before", name: "agent.create" },
      { kind: "before", name: "agent.session_open" },
      { kind: "on", name: "agent.turn_started" },
    ]);
  });

  it.each(["resume", "refresh", "import"] as const)("session_open (%s) of an existing agent attaches nothing and only hydrates", async (reason) => {
    const s = await setup();
    await mkdir(s.worktree, { recursive: true });
    const grantsBefore = await s.grants();
    const req: PluginSessionOpenRequest = { agentId: "agent-old", workspaceId: "ws-wt", provider: "claude", cwd: s.worktree, reason, purpose: "interactive", env: { KEEP: "1" } };
    expect(s.t.holder.get()).toBeNull();
    expect(await s.hooks.runSessionOpen(req, s.t.paseo)).toBeUndefined();
    expect(await s.grants()).toBe(grantsBefore);
    expect(s.t.holder.get()).toBe(s.t.paseo);
  });

  it("turn_started hydrates without touching the store or grants", async () => {
    const s = await setup();
    await s.hooks.runBefore(request(s.worktree), s.t.paseo); // one grant exists
    const store = openStore({ storeRoot: s.t.project.root, projectId: "prj_test" });
    const revision = (await store.version()).revision;
    const manifest = await readFile(join(s.t.project.root, ".decisions", "manifest.json"), "utf8");
    const grantsBefore = await s.grants();
    await s.hooks.emit(
      "agent.turn_started",
      { agent: { id: "agent-old", workspaceId: "ws-wt", parentAgentId: null, provider: "claude", cwd: s.worktree, title: null }, turnId: "turn-1" },
      s.t.paseo,
    );
    expect((await store.version()).revision).toBe(revision);
    expect(await readFile(join(s.t.project.root, ".decisions", "manifest.json"), "utf8")).toBe(manifest);
    expect(await s.grants()).toBe(grantsBefore);
    expect(s.t.holder.get()).toBe(s.t.paseo);
  });
});

// Stage R3.2 (task card 2026-10-29 R3 §3.2, §3.3): the created agent's env carries the grant
// fingerprint next to the injected MCP server, only for MCP providers; an interactive session_open
// with that env value binds the grant to the agent once. The holder is set on every hook.
describe("R3.2 grant fingerprint and binding", () => {
  const grantOf = (out: CreateRequest) => {
    return new URL(roadmapUrl(out) ?? "").pathname.slice("/mcp/".length).split(".")[0];
  };
  const open = (s: Awaited<ReturnType<typeof setup>>, x: { agentId: string; env: Record<string, string>; purpose?: "interactive" | "history" }): PluginSessionOpenRequest => ({
    agentId: x.agentId, workspaceId: "ws-wt", provider: "claude", cwd: s.worktree, reason: "create", purpose: x.purpose ?? "interactive", env: x.env,
  });

  it("create injects MCP and the fingerprint together; a non-MCP provider gets neither; no log carries the grant id", async () => {
    const s = await setup();
    const out = await rewritten(s.hooks.runBefore(request(s.worktree), s.t.paseo));
    const grantId = grantOf(out);
    expect(out.env?.PASEO_ROADMAP_GRANT_FP).toBe(fp32(grantId));
    expect(out.env?.PASEO_ROADMAP_GRANT_FP).toMatch(/^[0-9a-f]{32}$/);
    for (const l of s.t.logs) {
      expect(l).not.toContain(grantId);
      expect(l).not.toContain(fp32(grantId));
    }
    const other = await s.hooks.runBefore(request(s.worktree, { provider: "gemini" }), s.t.paseo);
    expect(other, "a non-MCP provider is left untouched").toBeUndefined();
  });

  it("an interactive session_open with the fingerprint binds the grant once; the same agent is idempotent; a different agent is refused and logged", async () => {
    const s = await setup();
    const grantId = grantOf(await rewritten(s.hooks.runBefore(request(s.worktree), s.t.paseo)));
    expect(await s.hooks.runSessionOpen(open(s, { agentId: "agent-1", env: { PASEO_ROADMAP_GRANT_FP: fp32(grantId) } }), s.t.paseo)).toBeUndefined();
    const bound = await s.t.state.getGrant(grantId);
    expect(bound).toMatchObject({ agentId: "agent-1", workspaceId: "ws-wt" });
    expect(typeof bound?.boundAt).toBe("string");
    await s.hooks.runSessionOpen(open(s, { agentId: "agent-1", env: { PASEO_ROADMAP_GRANT_FP: fp32(grantId) } }), s.t.paseo);
    expect(await s.t.state.getGrant(grantId)).toEqual(bound);
    const logsBefore = s.t.logs.length;
    expect(await s.hooks.runSessionOpen(open(s, { agentId: "agent-2", env: { PASEO_ROADMAP_GRANT_FP: fp32(grantId) } }), s.t.paseo)).toBeUndefined();
    expect(await s.t.state.getGrant(grantId), "the first binding stands").toEqual(bound);
    expect(s.t.logs.length, "the refusal is logged").toBeGreaterThan(logsBefore);
    for (const l of s.t.logs) expect(l).not.toContain(grantId);
    expect(s.t.holder.get()).toBe(s.t.paseo);
  });

  it("history purpose, a missing fingerprint or a stale grant do not bind; the holder is still set", async () => {
    const s = await setup();
    const grantId = grantOf(await rewritten(s.hooks.runBefore(request(s.worktree), s.t.paseo)));
    await s.hooks.runSessionOpen(open(s, { agentId: "agent-1", env: { PASEO_ROADMAP_GRANT_FP: fp32(grantId) }, purpose: "history" }), s.t.paseo);
    await s.hooks.runSessionOpen(open(s, { agentId: "agent-1", env: { OTHER: "1" } }), s.t.paseo);
    const g = await s.t.state.getGrant(grantId);
    expect(g).not.toBeNull();
    expect(g!.agentId).toBeUndefined();
    await s.t.state.markStale(g!.port);
    await s.hooks.runSessionOpen(open(s, { agentId: "agent-1", env: { PASEO_ROADMAP_GRANT_FP: fp32(grantId) } }), s.t.paseo);
    const stale = await s.t.state.getGrant(grantId);
    expect(stale?.stale).toBe(true);
    expect(stale?.agentId).toBeUndefined();
    expect(s.t.holder.get()).toBe(s.t.paseo);
  });
});
