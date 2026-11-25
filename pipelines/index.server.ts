import type { PaseoApi } from "@getpaseo/client";
import type { PluginCleanup } from "@getpaseo/plugin";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { join } from "node:path";
import { pipelineSettings, type PipelineSettings } from "./shared/settings";
import { createPaseoAgentPort, LABELS, METADATA_KEY } from "./server/agent-port";
import { createNodeFs } from "./server/fs-port";
import { registerRunHandlers, registerWorkflowHandlers } from "./server/handlers";
import { registerInjection } from "./server/injection";
import { startMcpEndpoint, type McpEndpoint } from "./server/mcp-endpoint";
import { pipelineStateDir } from "./server/paths";
import { runChecks } from "./server/check-runner";
import { createProcessPort } from "./server/process-port";
import { createRunDriver, type RunDriver } from "./server/run-driver";
import { createRunService, type RunService } from "./server/run-service";
import { createRunStore } from "./server/run-store";
import { createScratchCopy, removeScratchCopy } from "./server/scratch-copy";
import type { HostCatalog } from "./server/settings-resolve";
import { createWorkflowStore } from "./server/workflow-store";
import { git, worktreeIdentity } from "./server/worktree-identity";

type Core = { service: RunService; driver: RunDriver; endpoint: McpEndpoint };

async function hostCatalog(paseo: PaseoApi): Promise<HostCatalog> {
  const [config, snapshot] = await Promise.all([paseo.config.get(), paseo.providers.snapshot()]);
  const entries = snapshot.entries.length > 0 ? snapshot.entries : (snapshot.compactSnapshot?.entries ?? []);
  return {
    profiles: (config.config.agentProfiles ?? []).map((profile) => ({
      id: profile.id,
      name: profile.name,
      provider: profile.provider,
      model: profile.model,
      modeId: profile.modeId,
      thinkingOptionId: profile.thinkingOptionId,
      featureValues: profile.featureValues,
      options: profile.options,
    })),
    // Provider snapshots carry no MCP capability, so `supportsMcp` stays unset here.
    providers: entries
      .filter((entry) => entry.enabled !== false)
      .map((entry) => ({
        id: entry.provider,
        models: entry.models ? entry.models.flatMap((model) => [model.id, ...(model.aliases ?? [])]) : null,
        defaultModel: entry.models?.find((model) => model.isDefault)?.id,
      })),
  };
}

export default function contribute(server: PluginServerContext): PluginCleanup {
  const log = (message: string): void => console.error(`[flightpath-pipeline] ${message}`);
  const settings = server.registerSettings(pipelineSettings);
  let current: PipelineSettings = pipelineSettings.schema.parse({});
  const apply = (state: Awaited<ReturnType<typeof settings.read>>): void => {
    if (state.status === "ready") current = state.values;
    else log("settings invalid; using defaults");
  };
  const ready = settings.read().then(apply, (error: unknown) => {
    log(`settings unavailable; using defaults (${error instanceof Error ? error.message : "unknown error"})`);
  });
  const unsubscribe = settings.subscribe(apply);

  const fs = createNodeFs();
  const processes = createProcessPort();
  // Workflows and runs share one data directory, fixed at its first use after settings load;
  // a later `dataDir` change takes effect on the next start.
  let stateDirFixed: string | null = null;
  const stateDirOf = (): string => (stateDirFixed ??= pipelineStateDir(current.dataDir));
  const workflows = createWorkflowStore({ stateDir: stateDirOf, fs, now: () => new Date(), log });
  registerWorkflowHandlers(server, workflows, { log, ready });

  let paseo: PaseoApi | null = null;
  const sdk = (): PaseoApi => {
    if (paseo === null) throw new Error("No host SDK context has been supplied yet.");
    return paseo;
  };
  const agents = createPaseoAgentPort(sdk);

  // One process owns the state directory.
  let core: Promise<Core> | null = null;
  let resolved: Core | null = null;
  const build = async (): Promise<Core> => {
    await ready;
    const stateDir = stateDirOf();
    const store = createRunStore({ stateDir, fs });
    const endpointRef: { value: McpEndpoint | null } = { value: null };
    const driver = createRunDriver({
      store,
      processes,
      identity: (dir) => worktreeIdentity(processes, dir),
      headCommit: async (dir) => (await git(processes, dir, ["rev-parse", "--verify", "HEAD"])).trim(),
      checks: (input) => runChecks(processes, input),
      copies: { create: (x) => createScratchCopy(processes, x), remove: removeScratchCopy, removeAll: removeScratchCopy },
      copiesDir: (projectId, runId) => join(stateDir, "runs", projectId, runId, "copies"),
      reservation: (subject) => {
        if (endpointRef.value === null) throw new Error("The MCP endpoint is not running.");
        return endpointRef.value.reservation(subject);
      },
      settings: () => ({ checkTimeoutMs: current.checkTimeoutMs, maxOutputBytes: current.maxOutputBytes, quiesceTimeoutMs: current.quiesceTimeoutMs }),
      now: () => new Date(),
      log,
    });
    endpointRef.value = await startMcpEndpoint({
      stateDir,
      fs,
      log,
      tools: {
        runs: {
          read: (runId) => driver.read(runId),
          act: (runId, action) => driver.act(runId, (state) => action(state)),
          bindFromGrant: (...args) => driver.bindFromGrant(...args),
          holdReview: (runId, submission) => driver.holdReview(runId, submission),
        },
        workflows: { get: (projectId) => workflows.get(projectId), addProposal: (projectId, input) => workflows.addProposal(projectId, input) },
      },
    });
    const endpoint = endpointRef.value;
    try {
      await driver.prepare();
    } catch (error) {
      await endpoint.close().catch(() => undefined);
      throw error;
    }
    const service = createRunService({
      workflows,
      store,
      driver,
      fs,
      git: processes,
      stateDir,
      catalog: () => hostCatalog(sdk()),
      agents: () => (paseo === null ? null : agents),
      reservation: (subject) => endpoint.reservation(subject),
      createChatAgent: async (x) => {
        const handle = await sdk()
          .workspaces.ref(x.workspaceId)
          .agents.create({ config: { provider: x.model }, title: x.title, labels: { [LABELS.run]: `workflow:${x.projectId}` }, metadata: { [METADATA_KEY]: x.reservation } });
        return { agentId: handle.id };
      },
      now: () => new Date(),
      log,
    });
    resolved = { service, driver, endpoint };
    return resolved;
  };
  // Callers share one startup; a failed one is retried by the next caller.
  const coreReady = (): Promise<Core> => {
    core ??= build().catch((error: unknown) => {
      core = null;
      throw error;
    });
    return core;
  };
  // Disk-only recovery starts at once; scheduling waits for the first SDK context.
  void coreReady().catch((error: unknown) => log(`startup failed: ${error instanceof Error ? error.message : "unknown error"}`));

  const onContext = async (api: PaseoApi): Promise<void> => {
    paseo = api;
    const { driver } = await coreReady();
    await driver.attach(agents);
  };

  registerRunHandlers(server, {
    log,
    ready: async () => (await coreReady()).service,
    onContext,
    subscribe: (runId, listener) => {
      let release: (() => void) | null = null;
      let released = false;
      void coreReady().then(({ driver }) => {
        if (!released) release = driver.subscribe(runId, listener);
      });
      return () => {
        released = true;
        release?.();
      };
    },
  });

  const removeHooks = [
    registerInjection(server, {
      endpoint: () => resolved?.endpoint ?? null,
      readRun: async (runId) => (await coreReady()).driver.read(runId).catch(() => null),
      isWorkflowChat: async (projectId, agentId, reason) => (await coreReady()).service.isWorkflowChat(projectId, agentId, reason),
      log,
      onContext: (context) => onContext(context.paseo),
    }),
    server.addHook("agent.turn.after", async (event, context) => {
      await onContext(context.paseo);
      await (await coreReady()).driver.onTurnEnded({ agent: { id: event.agent.id, metadata: event.agent.metadata }, turnId: event.turnId, outcome: event.outcome });
    }),
    server.addHook("agent.archive.after", async (event, context) => {
      await onContext(context.paseo);
      await (await coreReady()).driver.onAgentGone({ agent: { id: event.agent.id, metadata: event.agent.metadata } });
    }),
    server.addHook("agent.close.after", async (event, context) => {
      await onContext(context.paseo);
      await (await coreReady()).driver.onAgentGone({ agent: { id: event.agent.id, metadata: event.agent.metadata } });
    }),
  ];

  return async () => {
    for (const remove of removeHooks) remove();
    await unsubscribe();
    // A failed startup has already closed its endpoint.
    if (core) await core.then((started) => started.endpoint.close()).catch(() => undefined);
  };
}
