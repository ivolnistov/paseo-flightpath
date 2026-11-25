#!/usr/bin/env node
import { spawn } from "node:child_process";
import { lstat, mkdir, open, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createPaseoApi } from "@getpaseo/client";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";

const PLUGIN_ID = "flightpath-pipeline";
const PROVIDER_ID = "pipeline-scripted";
const HOST_VERSION = "0.17.0-beta.1";
const USAGE = "node pipelines/e2e/journey.mjs --sandbox <owned bootstrap dir> --authorize <target nonce>";
const CAPABILITY_LOCAL = "Covered by the in-process or real-child local suite; no separate live claim.";

export function authorizationMatches(expected, supplied) {
  return typeof expected === "string" && /^[a-f0-9]{64}$/.test(expected) && expected === supplied;
}

export function assertSandboxRoot(root) {
  if (typeof root !== "string" || !path.isAbsolute(root)) throw new Error("The sandbox must be an absolute path.");
  const resolved = path.resolve(root);
  const temporary = path.resolve(tmpdir());
  const relative = path.relative(temporary, resolved);
  if (resolved === temporary || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`The sandbox must be inside ${temporary}.`);
  if (!path.basename(resolved).startsWith("flightpath-pipeline-e2e-")) throw new Error("The sandbox directory must have the flightpath-pipeline-e2e- prefix.");
  return resolved;
}

function parseArgs(argv) {
  const out = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key?.startsWith("--")) throw new Error(`Unexpected argument ${key}.`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${key} needs a value.`);
    if (out[key] !== undefined) throw new Error(`${key} was supplied twice.`);
    out[key] = value;
    index += 1;
  }
  if (Object.keys(out).sort().join(" ") !== "--authorize --sandbox") throw new Error(USAGE);
  return out;
}

async function ownedDirectory(directory, label) {
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`${label} must be a real directory.`);
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) throw new Error(`${label} is not owned by the invoking user.`);
  if ((info.mode & 0o777) !== 0o700) throw new Error(`${label} must have mode 0700.`);
}

async function bounded(promise, ms, label) {
  let timer;
  const limit = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms.`)), ms);
    timer.unref?.();
  });
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
}

export const SANDBOX_CLAIM = "harness-claim.json";

/**
 * Marks a sandbox as used before the harness changes anything in it. A sandbox that holds a claim
 * or any output of an earlier run is refused; nothing in it is removed, so earlier evidence stays.
 * The claim is created exclusively, so two concurrent invocations cannot both pass.
 */
export async function claimSandbox(sandbox, priorOutputs) {
  for (const candidate of priorOutputs) {
    // lstat inspects the entry itself, so a link whose target is missing still counts as present.
    const present = await lstat(candidate).then(
      () => true,
      (error) => {
        if (error?.code === "ENOENT") return false;
        throw error;
      },
    );
    if (present) throw new Error(`The sandbox is not fresh: ${path.relative(sandbox, candidate)} is left from an earlier run.`);
  }
  let handle;
  try {
    handle = await open(path.join(sandbox, SANDBOX_CLAIM), "wx", 0o600);
  } catch (error) {
    if (error?.code === "EEXIST") throw new Error("The sandbox was already used by an earlier harness run; provision a fresh one.");
    throw error;
  }
  try {
    await handle.writeFile(`${JSON.stringify({ claimedAt: new Date().toISOString(), pid: process.pid })}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * Stops a child with SIGTERM, then SIGKILL, each followed by a bounded wait for its exit.
 * Returns whether the exit was observed; a process still running afterwards is reported, not assumed gone.
 */
export async function stopChild(child, graceMs = 5_000) {
  const done = () => child.exitCode !== null || child.signalCode !== null;
  if (done()) return true;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  for (const signal of ["SIGTERM", "SIGKILL"]) {
    if (done()) return true;
    child.kill(signal);
    try {
      await bounded(exited, graceMs, `child ${child.pid} ${signal}`);
      return true;
    } catch {
      // Try the next signal, or report the survivor.
    }
  }
  return done();
}

async function waitFor(read, label, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() >= deadline) throw new Error(`${label} did not become true within ${timeoutMs} ms.`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function errorText(error) {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function resultValue(result) {
  if (!result || typeof result !== "object" || result.ok !== true || !("value" in result)) throw new Error(`RPC failed: ${JSON.stringify(result)}`);
  return result.value;
}

function resultError(result, code) {
  if (!result || typeof result !== "object" || result.ok !== false || result.error?.code !== code) throw new Error(`Expected ${code}, received ${JSON.stringify(result)}`);
  return result.error;
}

function jobOf(run, jobId) {
  const job = run.view.jobs.find((candidate) => candidate.id === jobId);
  if (!job) throw new Error(`Run ${run.view.runId} has no job ${jobId}.`);
  return job;
}

function runJob(run, jobId) {
  return run.graph.jobs.find((job) => job.id === jobId);
}

async function readJsonLines(file) {
  const text = await readFile(file, "utf8").catch((error) => {
    if (error?.code === "ENOENT") return "";
    throw error;
  });
  return text.split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function workflowText({ proposed, fixtureCheck, canonicalDir }) {
  const executable = JSON.stringify(process.execPath);
  const check = JSON.stringify(fixtureCheck);
  const lint = proposed ? `  lint: { needs: [implement], uses: checks, with: { run: [[${executable}, ${check}, lint, ${JSON.stringify(canonicalDir)}]] } }\n` : "";
  const reviewNeeds = proposed ? "[lint, module-tests]" : "[module-tests]";
  return `name: Feature delivery
inputs: { goal: { type: string }, tasks: { type: tasks, required: false } }
defaults:
  max-parallel: 3
  agent: { model: ${PROVIDER_ID}/primary, fallback: { model: ${PROVIDER_ID}/fallback, reasoning: medium }, retries: 2 }
jobs:
  discover:
    uses: agent
    acceptance: human
    with: { prompt: "List the modules affected by: \${{ inputs.goal }}" }
    outputs: { modules: { type: list, items: string } }
    done: [{ criterion: Every affected module is listed. }]
  implement:
    needs: [discover]
    uses: run-tasks
    with: { prompt: "\${{ inputs.goal }}", tasks: "\${{ inputs.tasks }}", context: "\${{ needs.discover.outputs.modules }}", reviewer: { model: ${PROVIDER_ID}/reviewer, fallback: { model: ${PROVIDER_ID}/fallback } } }
${lint}  module-tests:
    needs: [discover, implement]
    uses: checks
    strategy: { matrix: { module: "\${{ needs.discover.outputs.modules }}" }, max-parallel: 2 }
    with: { isolated: true, run: [[${executable}, ${check}, matrix, "\${{ matrix.module }}", ${JSON.stringify(canonicalDir)}]] }
  review: { needs: ${reviewNeeds}, uses: review, with: { agent: { model: ${PROVIDER_ID}/reviewer, fallback: { model: ${PROVIDER_ID}/fallback }, retries: 1 } }, rework: { to: implement, max: 2 } }
  accept: { needs: [review], uses: approval }
`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const sandbox = assertSandboxRoot(args.sandbox);
  await ownedDirectory(sandbox, "The sandbox");
  const markerFile = path.join(sandbox, "ownership.json");
  const marker = JSON.parse(await readFile(markerFile, "utf8"));
  const home = await realpath(path.join(sandbox, "home"));
  const projectDir = await realpath(path.join(sandbox, "project"));
  const controlFile = await realpath(path.join(sandbox, "fixture", "control.json"));
  const fixtureCheck = await realpath(path.join(sandbox, "fixture", "check.mjs"));
  const cli = await realpath(path.join(sandbox, "cli.mjs"));
  for (const [label, candidate] of [["home", home], ["project", projectDir], ["fixture control", controlFile], ["fixture check", fixtureCheck]]) {
    const relative = path.relative(sandbox, candidate);
    if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`The ${label} resolves outside the sandbox.`);
  }
  await ownedDirectory(home, "The sandbox PASEO_HOME");
  await ownedDirectory(projectDir, "The synthetic project");
  if (marker.kind !== "flightpath-pipeline-e2e" || marker.home !== home || marker.project !== projectDir || marker.control !== controlFile) throw new Error("The ownership marker does not match the resolved target.");
  if (!authorizationMatches(marker.nonce, args.authorize)) throw new Error("Owner authorization does not match this sandbox's target nonce.");
  const eventsFile = path.join(path.dirname(controlFile), "events.jsonl");
  const releaseDir = path.join(path.dirname(controlFile), "release");
  await claimSandbox(sandbox, [path.join(sandbox, "acceptance-results.json"), eventsFile, releaseDir, path.join(sandbox, "tmp")]);
  await mkdir(releaseDir, { recursive: true, mode: 0o700 });
  const pipelineDir = await realpath(fileURLToPath(new URL("..", import.meta.url)));
  const manifest = JSON.parse(await readFile(path.join(pipelineDir, "paseo-plugin.json"), "utf8"));
  if (manifest.id !== PLUGIN_ID) throw new Error("The working-tree plugin manifest has the wrong id.");
  const head = await readFile(path.join(projectDir, ".git", "HEAD"), "utf8").catch(() => "");
  if (!head) throw new Error("The synthetic project is not a Git repository.");

  const env = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: home,
    PASEO_HOME: home,
    TMPDIR: path.join(sandbox, "tmp"),
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_AUTHOR_NAME: "Pipeline sandbox",
    GIT_AUTHOR_EMAIL: "pipeline@example.invalid",
    GIT_COMMITTER_NAME: "Pipeline sandbox",
    GIT_COMMITTER_EMAIL: "pipeline@example.invalid",
    NODE_ENV: "test",
  };
  await mkdir(env.TMPDIR, { recursive: true, mode: 0o700 });
  const report = {
    ok: false,
    hostVersion: HOST_VERSION,
    sandbox,
    home,
    projectDir,
    pluginId: PLUGIN_ID,
    providerId: PROVIDER_ID,
    journey: [],
    capabilities: [],
    ui: { verified: false, reason: "This harness has no browser or native UI driver." },
  };
  const save = async () => writeFile(path.join(sandbox, "acceptance-results.json"), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  const record = async (step, proof) => {
    report.journey.push({ step, proof });
    await save();
  };
  const capability = async (row, status, proof, fallback = null) => {
    report.capabilities.push({ row, status, proof, fallback });
    await save();
  };
  let client = null;
  let api = null;
  let daemonStarted = false;
  const runCli = async (args, timeoutMs = 60_000) => {
    const child = spawn(process.execPath, [cli, ...args, "--home", home], { env, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { output = `${output}${chunk}`.slice(-1_000_000); });
    child.stderr.on("data", (chunk) => { output = `${output}${chunk}`.slice(-1_000_000); });
    const done = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => code === 0 ? resolve(output) : reject(new Error(`Sandbox CLI ${args.join(" ")} exited ${code ?? signal}: ${output}`)));
    });
    try {
      return await bounded(done, timeoutMs, `Sandbox CLI ${args.join(" ")}`);
    } catch (error) {
      if (!(await stopChild(child))) throw new Error(`Sandbox CLI ${args.join(" ")} failed and its process ${child.pid} did not exit after SIGKILL.`, { cause: error });
      throw error;
    }
  };
  const connect = async () => {
    if (client) await client.close().catch(() => undefined);
    client = new DaemonClient({ url: "ws://127.0.0.1:6797/ws", clientId: "flightpath-pipeline-acceptance", reconnect: { enabled: false }, runtimeMetricsIntervalMs: 0 });
    await bounded(client.connect(), 20_000, "Sandbox daemon connection");
    api = createPaseoApi(client);
  };
  const rpc = async (method, input) => bounded(client.invokePluginRpc(PLUGIN_ID, method, input), 30_000, method);
  const getRun = async (runId) => resultValue(await rpc("run.get", { runId }));
  const waitRun = (runId, predicate, label) => waitFor(async () => {
    const run = await getRun(runId);
    return predicate(run) ? run : null;
  }, label ?? `run ${runId}`);
  const waitJob = (runId, jobId, status) => waitRun(runId, (run) => jobOf(run, jobId).status === status, `${jobId} ${status}`);
  const accept = async (runId, jobId, criteria = []) => {
    const run = await waitJob(runId, jobId, "awaiting_human");
    const cycleId = jobOf(run, jobId).activeCycleId;
    if (!cycleId) throw new Error(`${jobId} has no active cycle.`);
    return resultValue(await rpc("job.accept", { runId, jobId, cycleId, criteria }));
  };
  const approve = async (runId, cycleId = null) => {
    const run = await waitJob(runId, "accept", "awaiting_human");
    const selected = cycleId ?? jobOf(run, "accept").activeCycleId;
    if (!selected) throw new Error("The approval has no active cycle.");
    return resultValue(await rpc("job.approve", { runId, jobId: "accept", cycleId: selected }));
  };
  const writeControl = async (scenario) => {
    const temporary = `${controlFile}.pipeline.tmp`;
    await writeFile(temporary, `${JSON.stringify(scenario, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, controlFile);
  };
  const release = async (name) => writeFile(path.join(releaseDir, name), "release\n", { mode: 0o600 });
  const events = () => readJsonLines(eventsFile);
  const restart = async () => {
    if (client) await client.close().catch(() => undefined);
    client = null;
    await runCli(["daemon", "restart"], 90_000);
    await connect();
  };

  try {
    const version = (await runCli(["--version"])).trim();
    if (version !== HOST_VERSION) throw new Error(`The sandbox CLI must be ${HOST_VERSION}, not ${version}.`);
    await runCli(["daemon", "config", "set", "daemon.listen", "127.0.0.1:6797"]);
    await runCli(["daemon", "config", "set", "daemon.relay.enabled", "false"]);
    await runCli(["daemon", "config", "set", "pluginsEnabled", "true"]);
    // An attempted start may still bring the daemon up, so cleanup stops it either way.
    daemonStarted = true;
    await runCli(["daemon", "start"], 90_000);
    await connect();
    const rosterBefore = await client.listPlugins();
    const beforeIds = (rosterBefore.plugins ?? rosterBefore).map((plugin) => plugin.id);
    if (beforeIds.includes(PLUGIN_ID) || beforeIds.some((id) => id === "plan" || id === "roadmap")) throw new Error(`Unexpected preinstalled plugins: ${beforeIds.join(", ")}`);
    await runCli(["plugin", "install", pipelineDir], 120_000);
    const rosterAfter = await client.listPlugins();
    const afterIds = (rosterAfter.plugins ?? rosterAfter).map((plugin) => plugin.id);
    if (!afterIds.includes(PLUGIN_ID) || afterIds.some((id) => id === "plan" || id === "roadmap")) throw new Error(`Pipeline is not the sole Flightpath plugin: ${afterIds.join(", ")}`);
    report.pluginRoster = afterIds;
    await capability("Plugin data directory convention", "pending", "Waiting for the first workflow write.");

    const planning = await api.workspaces.create({ source: { kind: "directory", path: projectDir }, title: "Pipeline acceptance planning" });
    const projectId = planning.projectId;
    if (!projectId) throw new Error("The synthetic workspace has no project id.");
    const probe = async (row, fallback, work) => {
      try {
        const proof = await work();
        await capability(row, "passed", proof, fallback);
      } catch (error) {
        await capability(row, "fallback", `Probe failed or was unreachable: ${errorText(error)}`, fallback);
      }
    };
    let probeAgentId = null;
    await probe("agents.create repeated idempotencyKey and labels", "Creation is never repeated; lookup by labels only. This safe default stays enabled.", async () => {
      const options = {
        config: { provider: `${PROVIDER_ID}/primary` },
        title: "Pipeline sandbox host probe",
        idempotencyKey: "pipeline-e2e-host-probe",
        labels: { "pipeline-e2e.probe": "host" },
        metadata: { "pipeline-e2e": "host-probe" },
        env: { PIPELINE_E2E_MARKER: "synthetic-env-marker" },
      };
      const first = await api.workspaces.ref(planning.id).agents.create(options);
      probeAgentId = first.id;
      const second = await api.workspaces.ref(planning.id).agents.create(options);
      if (first.id !== second.id) throw new Error(`Repeated key returned ${first.id} then ${second.id}.`);
      const found = await api.agents.list({ filter: { labels: { "pipeline-e2e.probe": "host" }, includeArchived: true, includeBackground: true }, includeBackground: true });
      if (!found.entries.some((entry) => entry.agent.id === first.id)) throw new Error("The created agent was not found by its label.");
      return `Both creates returned ${first.id}; the label lookup found the same agent.`;
    });
    await probe("agents.create synthetic env delivery", "Do not use env-dependent launch configuration; Pipeline's current launch path does not set env. No production flag changes.", async () => {
      if (!probeAgentId) throw new Error("No probe agent was created.");
      const opened = await waitFor(async () => (await events()).find((event) => event.type === "session.open" && event.agentId === probeAgentId && event.creationKey === "pipeline-e2e-host-probe") || null, "synthetic env probe event");
      if (opened.env?.PIPELINE_E2E_MARKER !== "synthetic-env-marker") throw new Error("The provider did not receive the synthetic env marker.");
      return `Provider session for ${probeAgentId} received the exact synthetic env marker.`;
    });
    const start = async (inputs, startKey) => {
      const preview = resultValue(await rpc("run.preview", { projectId, inputs }));
      if (preview.blockers.length > 0 || !preview.workflowDigest) throw new Error(`Start is blocked: ${JSON.stringify(preview)}`);
      return resultValue(await rpc("run.start", { projectId, inputs, workflowDigest: preview.workflowDigest, startKey })).runId;
    };

    const base = workflowText({ proposed: false, fixtureCheck, canonicalDir: projectDir });
    const proposed = workflowText({ proposed: true, fixtureCheck, canonicalDir: projectDir });
    let view = resultValue(await rpc("workflow.draft.set-text", { projectId, editableDigest: "absent", yaml: base }));
    if (view.diagnostics.length > 0 || !view.graph || !view.model) throw new Error("The base Planning workflow is invalid.");
    const chat = resultValue(await rpc("workflow.chat.open", { projectId, workspaceId: planning.id }));
    await api.agents.ref(chat.agentId).send("Propose adding lint and widening review.needs to include it.");
    view = await waitFor(async () => {
      const current = resultValue(await rpc("workflow.get", { projectId }));
      return current.proposals.some((proposal) => proposal.status === "pending") ? current : null;
    }, "workflow proposal");
    const proposal = view.proposals.find((candidate) => candidate.status === "pending");
    if (!proposal || proposal.diagnostics.length > 0) throw new Error("The scripted proposal is invalid.");
    const workflowBeforeIds = new Set(view.model.jobs.map((job) => job.id));
    const workflowAfterIds = new Set(proposal.model?.jobs.map((job) => job.id));
    if (!workflowAfterIds.has("lint") || workflowBeforeIds.has("lint") || proposal.yaml !== proposed) throw new Error("The proposal does not add exactly the expected lint content.");
    view = resultValue(await rpc("workflow.proposal.apply", { projectId, proposalId: proposal.id, editableDigest: view.editableDigest }));
    view = resultValue(await rpc("workflow.save", { projectId, savedDigest: view.saved?.digest ?? "absent", draftDigest: view.draft?.digest ?? "absent" }));
    const workflowFile = path.join(home, "plugin-data", PLUGIN_ID, "projects", projectId, "workflow.yaml");
    const saved = await readFile(workflowFile, "utf8");
    view = resultValue(await rpc("workflow.draft.set-text", { projectId, editableDigest: view.editableDigest, yaml: proposed.replace("Feature delivery", "Conflicting delivery") }));
    resultError(await rpc("workflow.save", { projectId, savedDigest: "0".repeat(64), draftDigest: view.draft?.digest ?? "absent" }), "workflow_conflict");
    if (await readFile(workflowFile, "utf8") !== saved) throw new Error("A conflicting save changed workflow.yaml.");
    view = resultValue(await rpc("workflow.draft.set-text", { projectId, editableDigest: view.editableDigest, yaml: proposed.replace("uses: agent", "uses: unknown") }));
    resultError(await rpc("workflow.save", { projectId, savedDigest: view.saved?.digest ?? "absent", draftDigest: view.draft?.digest ?? "absent" }), "workflow_invalid");
    if (await readFile(workflowFile, "utf8") !== saved) throw new Error("An invalid save changed workflow.yaml.");
    view = resultValue(await rpc("workflow.draft.discard", { projectId, editableDigest: view.editableDigest }));
    const dataInfo = await stat(path.join(home, "plugin-data", PLUGIN_ID));
    if ((dataInfo.mode & 0o777) !== 0o700) throw new Error("The plugin data directory is not owner-only.");
    await capability("Plugin data directory convention", "passed", "The workflow write succeeded and plugin-data/flightpath-pipeline is mode 0700.", "Host setting dataDir remains available.");
    await record(1, "Draft, proposal preview/apply, save conflict, invalid-save atomicity, and one saved workflow file.");

    const scenario = {
      version: 1,
      runIds: {},
      modules: ["core", "quoted \" module", "escape"],
      invalidFirstDiscover: true,
      crashAttempt: "implement.t1#1",
      providerFailures: ["implement.t2#1", "review#1", "review#2"],
      failedCheckAttempt: "implement.t2#2",
      changesRequestedAttempt: "review#3",
      holdMatrixAttempts: ["module-tests[0]#1", "module-tests[1]#1", "module-tests[2]#1"],
      holdReworkAttempt: "review#3",
    };
    await writeControl(scenario);

    const runA = await start({ goal: "Run A" }, "run-a");
    scenario.runIds.A = runA;
    await writeControl(scenario);
    const waitingA = await waitJob(runA, "discover", "awaiting_human");
    if (jobOf(waitingA, "implement.main").attempts.length !== 0) throw new Error("Run A started implement.main before discover was accepted.");
    await accept(runA, "discover", [0]);
    await approve(runA);
    const finishedA = await waitRun(runA, (run) => run.view.status === "finished", "Run A finished");
    if (!runJob(finishedA, "implement.main") || runJob(finishedA, "implement.t1")) throw new Error("Run A did not expand the no-task form correctly.");
    await record(2, "Run A used goal only, accepted discover before implement.main, and finished.");

    const tasks = [
      { id: "t1", title: "Task one", needs: [], done: [], acceptance: "auto" },
      { id: "t2", title: "Task two", description: "Second task text", needs: ["t1"], done: [{ run: [process.execPath, fixtureCheck, "task", projectDir] }, { criterion: "Task two is correct." }], acceptance: "auto" },
      { id: "t3", title: "Task three", needs: ["t1"], done: [], acceptance: "human" },
    ];
    const inputsB = { goal: "Run B", tasks: JSON.stringify(tasks) };
    const runB = await start(inputsB, "run-b");
    scenario.runIds.B = runB;
    await writeControl(scenario);
    await waitJob(runB, "discover", "awaiting_human");
    const toolEvents = await events();
    if (!toolEvents.some((event) => event.type === "tool.error" && event.code === "outputs_invalid" && event.runId === runB)) throw new Error("The fixture did not prove the rejected typed output.");
    await accept(runB, "discover", [0]);
    await waitFor(async () => (await events()).some((event) => event.type === "crash.ready" && event.runId === runB && event.attemptId === "implement.t1#1") || null, "agent-creation crash marker");
    const crashEvent = (await events()).find((event) => event.type === "crash.ready" && event.runId === runB && event.attemptId === "implement.t1#1");
    await restart();
    const recovered = await waitRun(runB, (run) => run.view.pauseReason === "recovery" && jobOf(run, "implement.t1").attempts[0]?.outcome === "lost", "lost recovered attempt");
    if (jobOf(recovered, "implement.t1").attempts[0]?.agents[0]?.agentId !== crashEvent.agentId) throw new Error("Recovery did not bind the same agent.");
    const agentsWithCrashKey = await api.agents.list({ filter: { labels: { "flightpath-pipeline.key": crashEvent.creationKey }, includeArchived: true, includeBackground: true }, includeBackground: true });
    if (agentsWithCrashKey.entries.length !== 1) throw new Error("Recovery created a duplicate agent.");
    resultValue(await rpc("run.resume", { runId: runB }));
    await waitJob(runB, "implement.t3", "awaiting_human");
    let current = await getRun(runB);
    if (jobOf(current, "implement.t2").status !== "succeeded" || jobOf(current, "implement.t1").status !== "succeeded") throw new Error("Task dependencies did not settle in order.");
    const t2Attempts = jobOf(current, "implement.t2").attempts;
    if (t2Attempts[1]?.cause !== "failover" || t2Attempts[2]?.cause !== "retry" || t2Attempts[2]?.target !== "fallback") throw new Error("Task two did not preserve failover and failed-check retry targets.");
    if (!current.view.evidence.some((item) => item.attemptId === "implement.t2#3" && item.kind === "criterion" && item.result === "pass")) throw new Error("Task two has no reviewer criterion evidence.");
    await accept(runB, "implement.t3");
    current = await getRun(runB);
    if (jobOf(current, "accept").attempts.length > 0) throw new Error("Task Accept approved the workflow.");
    await record(3, "Run B rejected then accepted typed outputs, accepted discover, recovered one lost agent without duplication, and preserved task/provider ordering.");
    await record(4, "t2 and t3 followed t1; t2 has check and reviewer evidence; human t3 Accept is separate from Approve.");
    await record(5, "The restart between creation and binding paused for recovery, rebound the same idle agent as lost, and Resume retried it.");
    await record(6, "t2 failed over once; its failed check stayed on fallback without consuming a provider switch.");

    await waitFor(async () => {
      const starts = (await events()).filter((event) => event.type === "check.start" && event.runId === runB && event.attemptId?.startsWith("module-tests"));
      return starts.some((event) => event.module === "core") && starts.some((event) => event.module === "quoted \" module") ? starts : null;
    }, "first isolated matrix pair");
    let checkEvents = (await events()).filter((event) => event.type?.startsWith("check.") && event.runId === runB);
    if (checkEvents.some((event) => event.type === "check.start" && event.module === "escape")) throw new Error("The third matrix instance exceeded max-parallel 2.");
    await release("core");
    await release("quoted-module");
    await waitJob(runB, "review", "needs_human");
    current = await getRun(runB);
    if (jobOf(current, "review").providerFailures.map((failure) => failure.target).join(",") !== "primary,fallback") throw new Error("Both review provider failures are not shown.");
    if (jobOf(current, "review").attempts.some((attempt) => attempt.attemptId === "review#3")) throw new Error("Review started before the user's provider choice.");
    checkEvents = (await events()).filter((event) => event.type?.startsWith("check.") && event.runId === runB);
    const quotedStarts = checkEvents.filter((event) => event.type === "check.start" && event.module === "quoted \" module");
    if (quotedStarts.length === 0 || quotedStarts.some((event) => event.hasGit || event.cwd === projectDir)) throw new Error("The quoted matrix value did not run as one argument in a plain scratch copy.");
    if (!current.view.evidence.some((item) => item.attemptId === "module-tests[2]#1" && item.result === "late") || !current.view.evidence.some((item) => item.attemptId === "module-tests[2]#1" && item.result === "pass" && item.mode === "exclusive")) throw new Error("The canonical escape did not invalidate and rerun exclusively.");
    if (!current.view.evidence.some((item) => item.attemptId === "lint#1" && item.mode === "exclusive" && item.result === "pass")) throw new Error("Lint did not run exclusively.");
    resultValue(await rpc("job.retry", { runId: runB, jobId: "review", target: "primary" }));
    const reworkBarrier = await waitRun(runB, (run) => run.view.barrier?.cause === "rework", "rework quiescence barrier");
    if (jobOf(reworkBarrier, "implement.t2").attempts.some((attempt) => attempt.attemptId === "implement.t2#4")) throw new Error("Rework started t2 before the old turn ended.");
    await release("rework");
    current = await waitJob(runB, "accept", "awaiting_human");
    if (jobOf(current, "implement.t1").attempts.length !== 2 || jobOf(current, "implement.t3").attempts.length !== 1) throw new Error("Rework relaunched t1 or t3.");
    if (!jobOf(current, "implement.t2").attempts.some((attempt) => attempt.cause === "rework") || !jobOf(current, "review").attempts.some((attempt) => attempt.cause === "rework")) throw new Error("Rework attempts are missing.");
    const reworkMatrixIds = current.graph.jobs.filter((job) => job.sourceJobId === "module-tests").map((job) => job.id);
    if (reworkMatrixIds.join(",") !== "module-tests[0],module-tests[1],module-tests[2]") throw new Error("The rework matrix instances are missing.");
    if (!jobOf(current, "lint").attempts.some((attempt) => attempt.cause === "rework")) throw new Error("Lint did not rerun for rework.");
    for (const matrixId of reworkMatrixIds) {
      if (!jobOf(current, matrixId).attempts.some((attempt) => attempt.cause === "rework")) throw new Error(`${matrixId} did not rerun for rework.`);
    }
    await record(7, "Lint was exclusive; three dynamic matrix instances respected cap two, preserved the quoted argument, and reran the escaping instance exclusively.");
    await record(8, "Review returned t2; the replacement waited for confirmed termination; dependents reran and t1/t3 kept their results.");

    const workspace = await api.workspaces.ref(current.view.workspace.workspaceId).refresh();
    const canonicalDir = workspace?.workspaceDirectory;
    if (!canonicalDir) throw new Error("The run workspace has no directory.");
    const staleCycle = jobOf(current, "accept").activeCycleId;
    await writeFile(path.join(canonicalDir, "stale-before-approve.txt"), "stale\n");
    resultError(await rpc("job.approve", { runId: runB, jobId: "accept", cycleId: staleCycle }), "evidence_stale");
    const beforeStaleTasks = ["implement.t1", "implement.t2", "implement.t3"].map((id) => jobOf(current, id).attempts.map((attempt) => attempt.attemptId));
    current = await waitJob(runB, "accept", "awaiting_human");
    const freshCycle = jobOf(current, "accept").activeCycleId;
    if (freshCycle === staleCycle) throw new Error("Approve did not open a fresh evidence cycle.");
    const afterStaleTasks = ["implement.t1", "implement.t2", "implement.t3"].map((id) => jobOf(current, id).attempts.map((attempt) => attempt.attemptId));
    if (JSON.stringify(beforeStaleTasks) !== JSON.stringify(afterStaleTasks)) throw new Error("Stale approval relaunched a task.");
    await approve(runB, freshCycle);
    const finishedB = await waitRun(runB, (run) => run.view.status === "finished", "Run B finished");
    const matrixIds = finishedB.graph.jobs.filter((job) => job.sourceJobId === "module-tests").map((job) => job.id);
    if (matrixIds.join(",") !== "module-tests[0],module-tests[1],module-tests[2]") throw new Error("The final matrix graph is incomplete.");
    if (!jobOf(finishedB, "lint").attempts.some((attempt) => attempt.cause === "stale")) throw new Error("Lint did not rerun during stale approval recovery.");
    for (const matrixId of matrixIds) {
      if (!jobOf(finishedB, matrixId).attempts.some((attempt) => attempt.cause === "stale")) throw new Error(`${matrixId} did not rerun during stale approval recovery.`);
    }
    const graphIds = finishedB.graph.jobs.map((job) => job.id);
    for (const required of ["discover", "implement.t1", "implement.t2", "implement.t3", "lint", ...matrixIds, "review", "accept"]) {
      if (!graphIds.includes(required)) throw new Error(`Execution graph is missing ${required}.`);
    }
    if (graphIds.includes("implement.main")) throw new Error("Run B unexpectedly contains implement.main.");
    const reviewAttemptIds = jobOf(finishedB, "review").attempts.map((attempt) => attempt.attemptId);
    if (reviewAttemptIds.join(",") !== "review#1,review#2,review#3,review#4,review#5") throw new Error(`Unexpected review attempt history: ${reviewAttemptIds.join(",")}`);
    if (!jobOf(finishedB, "review").attempts.some((attempt) => attempt.cause === "rework") || !jobOf(finishedB, "review").attempts.some((attempt) => attempt.cause === "stale")) throw new Error("Review rework/stale attempts are missing.");
    const discoverOutputs = jobOf(finishedB, "discover").attempts[0]?.outputs;
    if (JSON.stringify(discoverOutputs?.modules) !== JSON.stringify(["core", "quoted \" module", "escape"])) throw new Error("The accepted discovery outputs are missing or incorrect.");
    if (!finishedB.view.evidence.some((item) => item.attemptId === "implement.t2#4" && item.kind === "criterion" && item.item === 1 && item.result === "pass")) throw new Error("The reworked task's criterion evidence is missing.");
    const textJob = runJob(finishedB, "implement.t2");
    if (textJob?.with.title !== "Task two" || textJob.with.description !== "Second task text" || textJob.with.prompt !== "${{ inputs.goal }}") throw new Error("Execution task text does not match the snapshot.");
    await restart();
    const rebuilt = await getRun(runB);
    if (JSON.stringify(rebuilt.graph.jobs.filter((job) => job.sourceJobId === "module-tests").map((job) => job.id)) !== JSON.stringify(matrixIds)) throw new Error("Matrix instance ids changed after restart.");
    if (await start(inputsB, "run-b") !== runB) throw new Error("Repeated startKey returned another run.");
    const racing = await Promise.all([start(inputsB, "run-b"), start(inputsB, "run-b")]);
    if (racing[0] !== runB || racing[1] !== runB) throw new Error("Racing startKey calls returned another run.");
    if (await start(inputsB, "run-b") !== runB) throw new Error("startKey did not survive restart.");
    const changes = resultValue(await rpc("job.changes", { runId: runB, jobId: "implement.t2" }));
    if (!changes.diff.includes("implement.t2#4")) throw new Error("Execution changes omit the reworked task write.");
    const chats = jobOf(finishedB, "implement.t2").attempts.at(-1)?.agents.map((agent) => agent.role);
    if (chats?.join(",") !== "worker,reviewer") throw new Error("Worker and reviewer do not have separate Open chat bindings.");
    await record(9, "Stale Approve was refused, checks/review reran without relaunching tasks, and fresh Approve finished the run.");
    await record(10, "Execution exposed the graph, review attempts, evidence, task text, changes, and separate chat bindings; repeated/racing/restarted startKey returned Run B.");

    await capability("Workspace and agent lookup after a crash", "passed", "Run B rebound its workspace and the single labelled agent after daemon restart.", "binding_unknown with cancel only.");
    await capability("Process-group termination and exit", "local", CAPABILITY_LOCAL, "quiesce_unconfirmed.");
    await capability("Gated process launch", "local", CAPABILITY_LOCAL, "None; an unproven check is not started.");
    await capability("Plain Git-tree scratch copies", "passed", "Matrix events proved no .git and a non-canonical cwd; the escape invalidated evidence and reran exclusively.", "Exclusive mode.");
    await capability("Open/turn hooks and provider delivery", "passed", "The scripted fixture opened sessions, received scoped MCP, submitted tools, and delivered outcomes across restart.", "Reconcile by refresh where hooks are unavailable; MCP role context remains scoped.");
    await capability("Classified provider unavailability", "passed", "t2 and review primary/fallback failures produced the expected failover and human choice.", "Manual Retry on fallback remains available.");
    await capability("Turn interruption and observed end", "passed", "The rework barrier held t2 until the old reviewer turn was confirmed ended.", "quiesce_unconfirmed.");
    await capability("navigation.openAgent and subscriptions", "local", "Client paths are locally tested; no real UI or subscription claim is made by this run.", "Open chat hidden; run.get polling.");
    report.ok = true;
    await save();
  } catch (error) {
    report.error = errorText(error);
    await save();
    throw error;
  } finally {
    if (client) await client.close().catch(() => undefined);
    if (daemonStarted) await runCli(["daemon", "stop"], 30_000).catch(() => undefined);
  }
}

const invoked = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invoked) await main();
