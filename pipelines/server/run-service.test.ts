import { existsSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createNodeFs } from "./fs-port";
import { launchConfig } from "./agent-port";
import { createProcessPort } from "./process-port";
import { createRunDriver, type RunDriver } from "./run-driver";
import { creationKey, runStatus } from "./run-engine";
import { createRunService, RunServiceError, type RunService, type RunServiceDeps } from "./run-service";
import { createRunStore } from "./run-store";
import type { HostCatalog } from "./settings-resolve";
import { FakeChecks, FakeHost, FakeProcesses, fakeCopies } from "./test-support/fake-host";
import { createWorkflowStore, type WorkflowStore } from "./workflow-store";

const WORKFLOW = `name: Service
inputs: { goal: { type: string } }
jobs:
  build: { uses: agent, with: { prompt: "\${{ inputs.goal }}", agent: { model: alpha/a1 } } }
  approve: { needs: [build], uses: approval }
`;

let catalog: HostCatalog = { profiles: [], providers: [{ id: "alpha", models: ["a1"], supportsMcp: true }] };

let dir = "";
let host: FakeHost;
let workflows: WorkflowStore;
let snapshotsSeenAtCreate: string[][] = [];
let runCounter = 0;

function compose(extra: Partial<RunServiceDeps> = {}): { service: RunService; driver: RunDriver } {
  const fs = createNodeFs();
  const store = createRunStore({ stateDir: dir, fs });
  const driver = createRunDriver({
    store,
    processes: new FakeProcesses(),
    identity: host.identity,
    headCommit: host.headCommit,
    checks: new FakeChecks(host).start,
    copies: fakeCopies(),
    copiesDir: (projectId, runId) => join(dir, "runs", projectId, runId, "copies"),
    reservation: (key) => `rsv_${key}`,
    settings: () => ({ checkTimeoutMs: 1_000, maxOutputBytes: 4_096, quiesceTimeoutMs: 400 }),
    now: () => new Date("2026-11-21T00:00:00.000Z"),
    log: () => undefined,
    pollMs: 10,
  });
  const service = createRunService({
    workflows,
    store,
    driver,
    fs,
    git: createProcessPort(),
    stateDir: dir,
    catalog: () => Promise.resolve(catalog),
    agents: () => host,
    reservation: (subject) => `rsv_${subject}`,
    now: () => new Date("2026-11-21T00:00:00.000Z"),
    newRunId: () => `run${++runCounter}`,
    log: () => undefined,
    ...extra,
  });
  return { service, driver };
}

async function snapshotsOnDisk(): Promise<string[]> {
  const projectDir = join(dir, "runs", "proj");
  return existsSync(projectDir) ? (await readdir(projectDir)).filter((name) => existsSync(join(projectDir, name, "snapshot.json"))) : [];
}

async function saved(yaml: string): Promise<string> {
  const view = await workflows.get("proj");
  const drafted = await workflows.setDraftText("proj", { editableDigest: view.editableDigest, yaml });
  const after = await workflows.save("proj", { savedDigest: drafted.saved?.digest ?? "absent", draftDigest: drafted.draft?.digest ?? "absent" });
  return after.saved?.digest ?? "";
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "fp-service-"));
  host = new FakeHost();
  workflows = createWorkflowStore({ stateDir: () => dir, fs: createNodeFs(), now: () => new Date("2026-11-21T00:00:00Z") });
  snapshotsSeenAtCreate = [];
  catalog = { profiles: [], providers: [{ id: "alpha", models: ["a1"], supportsMcp: true }] };
  const create = host.createWorkspace.bind(host);
  host.createWorkspace = async (x) => {
    snapshotsSeenAtCreate.push(await snapshotsOnDisk());
    return create(x);
  };
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("run.preview", () => {
  it("reports the job count, resolved settings and blockers", async () => {
    const { service } = compose();
    expect((await service.preview("proj", {})).blockers).toEqual(["workflow_missing"]);
    const digest = await saved(WORKFLOW);
    const preview = await service.preview("proj", { goal: "x" });
    expect(preview).toMatchObject({ workflowDigest: digest, jobCount: 2, hasDraft: false, blockers: [] });
    expect(preview.settings.build?.worker?.primary).toEqual({ provider: "alpha", model: "a1" });
    expect(preview.graph?.jobs.length).toBe(2);
    const invalid = await service.preview("proj", {});
    expect(invalid.blockers).toEqual(["inputs_invalid"]);
    expect(invalid.graph).toBeNull();
    await saved(WORKFLOW.replace("alpha/a1", "alpha/zzz"));
    const unresolved = await service.preview("proj", { goal: "x" });
    expect(unresolved.blockers).toEqual(["settings_unresolved"]);
    expect(unresolved.graph?.jobs.length).toBe(2);
  });
});

describe("run.start", () => {
  it("writes the snapshot before any host call and refuses a changed saved workflow as preview_stale", async () => {
    const { service, driver } = compose();
    await driver.attach(host);
    const digest = await saved(WORKFLOW);
    const { runId } = await service.start("proj", { inputs: { goal: "x" }, workflowDigest: digest, startKey: "k1" });
    await driver.idle(runId);
    expect(snapshotsSeenAtCreate).toEqual([[runId]]);
    const kinds = (await createRunStore({ stateDir: dir, fs: createNodeFs() }).load(runId)).events.map((event) => event.kind);
    expect(kinds.slice(0, 2)).toEqual(["workspace.intent", "workspace.bound"]);

    await saved(WORKFLOW.replace("name: Service", "name: Changed"));
    const refused = await service.start("proj", { inputs: { goal: "x" }, workflowDigest: digest, startKey: "k2" }).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(RunServiceError);
    expect(refused instanceof RunServiceError ? refused.code : null).toBe("preview_stale");
    expect(await snapshotsOnDisk()).toEqual([runId]);
  });

  it("schedules a published run on a repeated key after its first registration failed", async () => {
    const { service, driver } = compose();
    await driver.attach(host);
    const digest = await saved(WORKFLOW);
    const request = { inputs: { goal: "x" }, workflowDigest: digest, startKey: "retry" };
    const register = driver.register;
    driver.register = () => Promise.reject(new Error("snapshot read failed"));
    await expect(service.start("proj", request)).rejects.toThrow("snapshot read failed");
    driver.register = register;
    const [runId] = await snapshotsOnDisk();
    expect((await service.start("proj", request)).runId).toBe(runId);
    await driver.idle(runId ?? "");
    expect(await snapshotsOnDisk()).toEqual([runId]);
    expect(host.calls.createWorkspace).toBe(1);
  });

  it("refuses a repeated key whose inputs or workflow digest differ from the run it started", async () => {
    const { service, driver } = compose();
    await driver.attach(host);
    const digest = await saved(WORKFLOW);
    const { runId } = await service.start("proj", { inputs: { goal: "x" }, workflowDigest: digest, startKey: "bound" });
    await driver.idle(runId);
    expect((await service.start("proj", { inputs: { goal: "x" }, workflowDigest: digest, startKey: "bound" })).runId).toBe(runId);
    await expect(service.start("proj", { inputs: { goal: "y" }, workflowDigest: digest, startKey: "bound" })).rejects.toMatchObject({ code: "start_key_conflict" });
    await expect(service.start("proj", { inputs: { goal: "x" }, workflowDigest: "0".repeat(64), startKey: "bound" })).rejects.toMatchObject({ code: "start_key_conflict" });
    expect(await snapshotsOnDisk()).toEqual([runId]);
  });

  it("returns the same run for a repeated key, for concurrent Starts and after a rebuild from disk", async () => {
    const first = compose();
    await first.driver.attach(host);
    const digest = await saved(WORKFLOW);
    const request = { inputs: { goal: "x" }, workflowDigest: digest, startKey: "same" };
    const [a, b] = await Promise.all([first.service.start("proj", request), first.service.start("proj", request)]);
    expect(a.runId).toBe(b.runId);
    expect((await first.service.start("proj", request)).runId).toBe(a.runId);
    await first.driver.idle(a.runId);
    expect(await snapshotsOnDisk()).toEqual([a.runId]);
    expect(host.calls.createWorkspace).toBe(1);

    const rebuilt = compose();
    await rebuilt.driver.attach(host);
    expect((await rebuilt.service.start("proj", request)).runId).toBe(a.runId);
    expect(await snapshotsOnDisk()).toEqual([a.runId]);
    expect(host.calls.createWorkspace).toBe(1);
  });

  it("two keys give two live runs on two branches whose identical jobs have distinct keys and agents", async () => {
    const { service, driver } = compose();
    await driver.attach(host);
    const digest = await saved(WORKFLOW);
    const one = await service.start("proj", { inputs: { goal: "x" }, workflowDigest: digest, startKey: "a" });
    const two = await service.start("proj", { inputs: { goal: "x" }, workflowDigest: digest, startKey: "b" });
    await driver.idle(one.runId);
    await driver.idle(two.runId);
    expect(one.runId).not.toBe(two.runId);
    expect(new Set(host.workspaces.map((workspace) => workspace.branchName))).toEqual(new Set([`flightpath/run-${one.runId}`, `flightpath/run-${two.runId}`]));
    const keyOne = creationKey(one.runId, "build#1", "worker");
    const keyTwo = creationKey(two.runId, "build#1", "worker");
    expect(keyOne).not.toBe(keyTwo);
    expect(host.agentFor(keyOne)?.id).toBeDefined();
    expect(host.agentFor(keyOne)?.id).not.toBe(host.agentFor(keyTwo)?.id);
    const runs = await service.list("proj");
    expect(runs.map((run) => [run.runId, run.status])).toEqual([
      [one.runId, "running"],
      [two.runId, "running"],
    ]);
  });
});

describe("profile launch bundle", () => {
  it("reaches the create options from the snapshot and stays the snapshot's after the host profile changes", async () => {
    const profile = { id: "tuned", name: "Tuned", provider: "alpha", model: "a1", modeId: "auto", thinkingOptionId: "max", featureValues: { fast_mode: true }, options: { service_tier: "priority" } };
    catalog = { profiles: [profile], providers: [{ id: "alpha", models: ["a1"], supportsMcp: true }] };
    const { service, driver } = compose();
    await driver.attach(host);
    const digest = await saved(WORKFLOW.replace("agent: { model: alpha/a1 }", "agent: { profile: tuned, retries: 1 }"));
    const { runId } = await service.start("proj", { inputs: { goal: "x" }, workflowDigest: digest, startKey: "p" });
    await driver.idle(runId);
    const expected = { provider: "alpha/a1", modeId: "auto", thinkingOptionId: "max", options: { fast_mode: true, service_tier: "priority" } };
    const first = host.agentFor(creationKey(runId, "build#1", "worker"));
    expect(first && launchConfig(first.input.agent)).toEqual(expected);
    const snapshot = await createRunStore({ stateDir: dir, fs: createNodeFs() }).load(runId);
    expect(snapshot.snapshot.settings.build?.worker?.primary).toEqual({ provider: "alpha", model: "a1", profile: "tuned", modeId: "auto", thinkingOptionId: "max", options: { fast_mode: true, service_tier: "priority" } });
    expect(JSON.stringify(snapshot.snapshot)).not.toContain("notes");

    catalog = { profiles: [{ ...profile, modeId: "plan", options: { service_tier: "flex" } }], providers: catalog.providers };
    if (first) await driver.onTurnEnded(host.turnEnded(first.id, { kind: "failed", error: { message: "TypeError" } }));
    await driver.idle(runId);
    const second = host.agentFor(creationKey(runId, "build#2", "worker"));
    expect(second && launchConfig(second.input.agent)).toEqual(expected);
  });
});

describe("run actions", () => {
  it("reads the identity inside the run's serialisation for Approve and refuses a drifted one", async () => {
    const { service, driver } = compose();
    await driver.attach(host);
    const digest = await saved(WORKFLOW);
    const { runId } = await service.start("proj", { inputs: { goal: "x" }, workflowDigest: digest, startKey: "k" });
    await driver.idle(runId);
    const agent = host.agentFor(creationKey(runId, "build#1", "worker"));
    if (!agent) throw new Error("no agent");
    await driver.act(runId, () => ({ ok: true, events: [{ kind: "attempt.outputs_accepted", attemptId: "build#1", role: "worker", agentId: agent.id, outputs: {}, summary: "s" }] }));
    await driver.onTurnEnded(host.turnEnded(agent.id));
    await driver.idle(runId);
    const detail = await service.get(runId);
    const approval = detail.view.jobs.find((job) => job.id === "approve");
    expect(approval?.status).toBe("awaiting_human");
    const cycleId = approval?.activeCycleId ?? "";
    host.write(`/fake/${runId}`);
    const stale = await service.approveJob(runId, "approve", cycleId).catch((error: unknown) => error);
    expect(stale instanceof RunServiceError ? stale.code : null).toBe("evidence_stale");
    await driver.idle(runId);
    const fresh = (await service.get(runId)).view.jobs.find((job) => job.id === "approve")?.activeCycleId ?? "";
    expect(fresh).not.toBe(cycleId);
    const approved = await service.approveJob(runId, "approve", fresh);
    await driver.idle(runId);
    expect(approved.view.jobs.find((job) => job.id === "approve")?.status).toBe("succeeded");
    expect(runStatus(await driver.read(runId))).toBe("finished");
  });
});

describe("workflow chat", () => {
  it("opens with the provider's default model when the default profile names none", async () => {
    catalog = { profiles: [{ id: "plain", name: "Plain", provider: "alpha" }], providers: [{ id: "alpha", models: ["a1"], defaultModel: "a1", supportsMcp: true }] };
    const models: string[] = [];
    const { service } = compose({
      createChatAgent: (x) => {
        models.push(x.model);
        return Promise.resolve({ agentId: "chat-1" });
      },
    });
    await saved("defaults: { agent: { profile: plain } }\njobs:\n  build: { uses: agent, with: { prompt: go } }\n");
    expect(await service.openChat("proj", "ws-1")).toEqual({ agentId: "chat-1" });
    expect(models).toEqual(["alpha/a1"]);
  });
});
