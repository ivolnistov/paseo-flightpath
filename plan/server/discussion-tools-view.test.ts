// The discussion header's ongoing tools state: the session view of a session whose planner is a
// discussion chat reports whether the chat has the roadmap tools, read from the plugin's grant state
// each time the view is read, not only once after creation: attached (a live grant bound to the
// planner), not attached (the planner holds no live grant and none could be its own: none was issued,
// or the one it had was made stale), or unknown (a live unbound grant in its workspace, which cannot
// be attributed by directory or time; the grant state cannot be read; or the workspace cannot be
// resolved, so absence cannot be claimed). Other planners carry no tools state. These planners are
// seeded without a feature's reservation, so marked grants count as well and pending (a grant marked
// with the chat's own reservation) does not arise here.
//
// Real temp store and real McpState over a temp directory; the host directory is a synthetic fake.
// The service receives the grant state as `state`, the dependency the plan names for the view.
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PaseoApi } from "@getpaseo/client";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createMcpState, envFingerprint } from "./mcp-state";
import { createRoadmapService, type StoreOpener } from "./sessions";
import { openProjectStore, type ProjectDirectory } from "./store-root";
import type { GrantReader } from "./tools-state";
import { fixedClock, NOW, nextId, opt } from "./test-support/build";
import { fakeDirectory } from "./test-support/fake-dir";
import { binding, BLK_OPEN, seedGrilling } from "./test-support/grilling";
import { makeProject, ok, type TestProject } from "./test-support/service";

const P = "prj_test";
const AGENT = "agent-discussion";
const WS_DIR = "/synthetic/wks1";

let project: TestProject | undefined;
const roots: string[] = [];
afterEach(async () => {
  await project?.cleanup();
  project = undefined;
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});

async function setup(planner: { boundBy: "discussion" | "ask"; workspaceId: string | null } | null = { boundBy: "discussion", workspaceId: "ws-1" }) {
  project = await makeProject();
  const stateParent = await realpath(await mkdtemp(join(tmpdir(), "dr-tools-view-")));
  roots.push(stateParent);
  const stateDir = join(stateParent, "state");
  const state = createMcpState({ stateDir, now: fixedClock, newId: nextId, log: () => undefined });
  const real = fakeDirectory({ projects: [{ projectId: P, projectRootPath: project.root, projectKind: "git" }], workspaces: [{ id: "ws-1", projectId: P, directory: WS_DIR }] });
  // Every grant-state and workspace lookup the view makes is counted.
  const calls: string[] = [];
  const dir: ProjectDirectory = { listProjects: real.listProjects, listWorkspaces: async () => (calls.push("listWorkspaces"), real.listWorkspaces()) };
  const reader: GrantReader = {
    grantForAgent: async (agentId) => (calls.push("grantForAgent"), state.grantForAgent(agentId)),
    grantsIssuedSince: async (at, cwd, scope) => (calls.push("grantsIssuedSince"), state.grantsIssuedSince(at, cwd, scope)),
  };
  const storeOptions = { now: fixedClock, newId: nextId, log: () => undefined };
  const deps = { directory: () => dir, now: fixedClock, newId: nextId, storeOptions, state: reader };
  const service = createRoadmapService(deps);
  const paseo: PaseoApi = project.paseo;
  ok(await service.init(paseo, { projectId: P }));
  const open: StoreOpener = (projectId) => openProjectStore(dir, projectId, storeOptions);
  const revision = async () => ok(await service.version(paseo, { projectId: P })).revision!;
  const sessionId = ok(await service.sessionCreate(paseo, { projectId: P, expectedRevision: await revision(), title: "[feature] Login" })).sessionId;
  ok(await service.questionCreate(paseo, { projectId: P, expectedRevision: await revision(), sessionId, title: "Q1", context: "", options: [opt("a")], allowFreeText: false, activatedBy: [], invalidatedBy: [], blockId: BLK_OPEN }));
  if (planner !== null) await seedGrilling(open, P, sessionId, { planner: { ...binding(), agentId: AGENT, workspaceId: planner.workspaceId, boundBy: planner.boundBy, boundAt: NOW.toISOString() } });
  const tools = async () => {
    calls.length = 0;
    const view = ok(await service.sessionGet(paseo, { projectId: P, sessionId }));
    return z.looseObject({ tools: z.string().optional() }).parse(view.grilling ?? {}).tools;
  };
  const issue = () => state.issueGrant({ projectId: P, storeRoot: project!.root, provider: "claude", cwd: WS_DIR, port: 1 });
  const bind = async () => {
    const grant = await issue();
    await state.bindByFingerprint(envFingerprint(grant.grantId), { agentId: AGENT, workspaceId: "ws-1", at: NOW.toISOString() });
  };
  return { state, stateDir, tools, issue, bind, calls };
}

describe("the discussion header's tools state", () => {
  it("not attached while no grant was issued for the chat", async () => {
    const t = await setup();
    expect(await t.tools()).toBe("not_attached");
  });

  it("unknown, never pending, once an unmarked grant is issued for the chat's workspace but not yet bound", async () => {
    const t = await setup();
    await t.issue();
    expect(await t.tools()).toBe("unknown");
  });

  it("attached once a grant is bound to the planner chat, read again on each view", async () => {
    const t = await setup();
    expect(await t.tools()).toBe("not_attached");
    const grant = await t.issue();
    await t.state.bindByFingerprint(envFingerprint(grant.grantId), { agentId: AGENT, workspaceId: "ws-1", at: NOW.toISOString() });
    expect(await t.tools()).toBe("attached");
  });

  it("unknown when the grant state cannot be read, never not attached", async () => {
    const t = await setup();
    await t.issue();
    await writeFile(join(t.stateDir, "grants.json"), "{ not json");
    expect(await t.tools()).toBe("unknown");
  });

  it("unknown when the chat's workspace cannot be resolved and no grant is bound, so absence is not claimed", async () => {
    const t = await setup({ boundBy: "discussion", workspaceId: null });
    expect(await t.tools()).toBe("unknown");
  });

  it("a planner that is not a discussion chat carries no tools state", async () => {
    const t = await setup({ boundBy: "ask", workspaceId: "ws-1" });
    expect(await t.tools()).toBeUndefined();
  });
});

// Review guards: the view only asks what it needs. A planner without a known workspace never lists
// workspaces nor counts the workspace's unbound grants, yet still reports a grant bound to it; a
// workspace the directory no longer has is unknown without counting; sessions whose planner is not a
// discussion chat (or that have no planner) read neither the grant state nor the workspaces.
describe("what the tools state reads", () => {
  it("a discussion planner without a workspace lists no workspaces and counts no unbound grants", async () => {
    const t = await setup({ boundBy: "discussion", workspaceId: null });
    await t.issue();
    expect(await t.tools()).toBe("unknown");
    expect(t.calls).not.toContain("listWorkspaces");
    expect(t.calls).not.toContain("grantsIssuedSince");
  });

  it("a discussion planner without a workspace is still attached once a grant is bound to it", async () => {
    const t = await setup({ boundBy: "discussion", workspaceId: null });
    await t.bind();
    expect(await t.tools()).toBe("attached");
    expect(t.calls).not.toContain("listWorkspaces");
  });

  it("a workspace the directory no longer has is unknown, without counting unbound grants", async () => {
    const t = await setup({ boundBy: "discussion", workspaceId: "ws-gone" });
    await t.issue();
    expect(await t.tools()).toBe("unknown");
    expect(t.calls).not.toContain("grantsIssuedSince");
  });

  it("an ask-bound planner reads neither the grant state nor the workspaces", async () => {
    const t = await setup({ boundBy: "ask", workspaceId: "ws-1" });
    await t.bind();
    expect(await t.tools()).toBeUndefined();
    expect(t.calls).toEqual([]);
  });

  it("a session without a planner reads neither the grant state nor the workspaces", async () => {
    const t = await setup(null);
    expect(await t.tools()).toBeUndefined();
    expect(t.calls).toEqual([]);
  });
});
