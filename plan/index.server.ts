import type { PluginServerContext } from "@getpaseo/plugin/server";
import * as pluginSdk from "@getpaseo/plugin";
import { roadmapSettings, trackerSettings, type RoadmapSettings, type TrackerSettings } from "./shared/settings";
import { createApprovalStore } from "./server/approvals";
import type { Result } from "./shared/rpc";
import type { DodTemplateValue } from "./shared/rpc-dod";
import { createDodTemplateService, registerDodHandlers } from "./server/dod-handlers";
import { registerDiscussionHandlers, sweepAllProjects } from "./server/discussion-handlers";
import type { DiscussionDeps } from "./server/discussion";
import { registerFeatureHandlers } from "./server/feature-handlers";
import { buildFeatureTools } from "./server/feature-tools";
import { createFeatureCommands, createFeatureService } from "./server/features";
import { registerHandlers } from "./server/handlers";
import { registerInjection } from "./server/injection";
import { createGrantResolver } from "./server/mcp-grants";
import { startMcpEndpoint } from "./server/mcp-endpoint";
import { createMcpState } from "./server/mcp-state";
import { buildTools } from "./server/mcp-tools";
import { createPaseoHolder } from "./server/paseo-holder";
import { createPauseEngine, registerPauseEngine, type PauseEngine } from "./server/pause";
import { readPauseSupport } from "./server/pause-support";
import { registerPlanHandlers } from "./server/plan-handlers";
import { hostSupportsSubscriptions, registerRevisionWatch } from "./server/revision-handlers";
import { coordinatorWorktree } from "./server/coordinator";
import { worktreeIdentity } from "./server/evidence";
import { nodeProcessPort } from "./server/process-port";
import { registerRunHandlers } from "./server/run-handlers";
import { buildRunTools } from "./server/run-tools";
import { afterReplacementRequest, afterRunEffect, createRunCommands, createRunners, createRunService, EXCLUDED, type IdentityReader, type RunDeps, type Runners } from "./server/runs";
import { buildPlanTools } from "./server/plan-tools";
import { createPlanCommands, createPlanService } from "./server/plans";
import { createRoadmapCommands, createRoadmapService } from "./server/sessions";
import { openStore } from "./server/store";
import { openProjectStore, projectDirectoryFromPaseo } from "./server/store-root";
import { ulid } from "./server/ids";
import type { StoreOpener } from "./server/sessions";
import { registerTrackerHandlers } from "./server/tracker/handlers";
import { createTrackerService } from "./server/tracker/sync";
import { codexConnectionSource } from "./server/tracker/connection";
import { createAuditStore } from "./server/tracker/audit";
import { createSnailOrbitAdapter } from "./server/tracker/snailorbit";
import { createTrackerKeyStore } from "./server/tracker/token";
import { registerTimelineObserver } from "./server/timeline-rows";

export default function contribute(server: PluginServerContext) {
  const log = (m: string, e?: unknown) => console.error(`[decision-roadmap] ${m}`, e ?? "");
  const storeOptions = { log };
  // Automatic grilling: an Accept that leaves an operation waiting on the planner's pause card hands
  // it to the pause engine (created below, once the host-context opener exists).
  let pause: PauseEngine | undefined;
  const deps = {
    directory: projectDirectoryFromPaseo,
    storeOptions,
    afterAccept: (x: { projectId: string; sessionId: string; operationId: string }) => void pause?.afterAccept(x),
  };
  const holder = createPaseoHolder((m) => log(m));
  const state = createMcpState({ log: (m) => log(m) });
  const commands = createRoadmapCommands(deps);
  // Stage R3.5 run composition. The opener resolves the project through the captured host context.
  const serverOpen: StoreOpener = async (projectId) => {
    const paseo = holder.get();
    if (paseo === null) throw new Error("The Paseo host context is not available yet");
    return openProjectStore(projectDirectoryFromPaseo(paseo), projectId, storeOptions);
  };
  const paseoNow = () => holder.get();
  const pauseAbort = new AbortController();
  pause = createPauseEngine({ open: serverOpen, paseo: paseoNow, directory: projectDirectoryFromPaseo, log: (m) => log(m), signal: pauseAbort.signal, newId: () => ulid() });
  const pauseEngine = pause;
  let runners: Runners | undefined;
  const runnersHook: Pick<Runners, "start" | "cancel"> = { start: (x) => runners?.start(x), cancel: (runId) => runners?.cancel(runId) };
  const effect = (x: { projectId: string; runId: string }) =>
    void afterRunEffect({ paseo: paseoNow, open: serverOpen, runners: runnersHook, log: (m) => log(m) }, x);
  // Stage R4.3: one shared after-commit hook for replacement requests (feature cancel and plan approval).
  // Both callers are UI-only human actions (a status change and an approval), so a delivery-failure
  // note is attributed to the human.
  const replacement = (x: { projectId: string; featureId: string; agentId: string }) =>
    void afterReplacementRequest({ paseo: paseoNow, open: serverOpen, log: (m) => log(m) }, { ...x, actor: { kind: "human" } });
  let sweep: (projectId: string) => void = () => undefined;
  const planDeps = {
    ...deps,
    approvals: createApprovalStore({ log: (m) => log(m) }),
    afterRunEffect: effect,
    afterReplacementRequest: replacement,
    afterApprove: (projectId: string) => sweep(projectId),
  };
  const planCommands = createPlanCommands(planDeps);
  const processStartedAt = new Date();
  const settings = server.registerSettings(trackerSettings);
  const defaults: TrackerSettings = trackerSettings.schema.parse({});
  const readSettings = async (): Promise<TrackerSettings> => {
    const state = await settings.read();
    if (state.status === "ready") return state.values;
    log("tracker settings invalid; using defaults (provider none, dry-run)");
    return defaults;
  };
  const roadmap = server.registerSettings(roadmapSettings);
  const roadmapDefaults: RoadmapSettings = roadmapSettings.schema.parse({});
  const readRoadmapSettings = async (): Promise<RoadmapSettings> => {
    const state = await roadmap.read();
    if (state.status === "ready") return state.values;
    log("roadmap settings invalid; using defaults (no global DoD template)");
    return roadmapDefaults;
  };

  const port = nodeProcessPort();
  const identity: IdentityReader = async ({ feature }) => {
    const paseo = holder.get();
    const dir = paseo ? await coordinatorWorktree(paseo, feature) : null;
    return dir === null ? null : worktreeIdentity(port, dir, EXCLUDED).catch(() => null);
  };
  const runDeps: RunDeps = { ...planDeps, settings: readRoadmapSettings, identity, paseo: paseoNow, runners: runnersHook };
  const runCommands = createRunCommands(runDeps);
  runners = createRunners({ port, paseo: paseoNow, settings: readRoadmapSettings, open: serverOpen, record: runCommands.recordVerification, log });
  sweep = (projectId) => void runCommands.sweep(serverOpen, { projectId }).catch(() => undefined);
  const featureDeps = { ...deps, afterRunEffect: effect, approvals: planDeps.approvals, afterReplacementRequest: replacement };

  registerHandlers(server, createRoadmapService({ ...deps, state }), holder);
  // Live revision notifications where the daemon supports subscriptions; the panel's version poll
  // stays the fallback everywhere.
  const stopRevisionWatches = registerRevisionWatch(
    server,
    { directory: projectDirectoryFromPaseo, storeOptions, holder },
    hostSupportsSubscriptions(pluginSdk),
  );
  registerPlanHandlers(server, createPlanService(planDeps), holder);
  registerFeatureHandlers(server, createFeatureService(featureDeps), holder);
  registerRunHandlers(server, createRunService(runDeps), holder);
  const discussionDeps = (paseo: Parameters<typeof projectDirectoryFromPaseo>[0]): DiscussionDeps => ({
    open: (projectId) => openProjectStore(projectDirectoryFromPaseo(paseo), projectId, storeOptions),
    commands,
    settings: readRoadmapSettings,
    directory: projectDirectoryFromPaseo,
    state,
    now: () => new Date(),
    newId: () => ulid(),
    log: (m) => log(m),
  });
  registerDiscussionHandlers(server, discussionDeps, holder);
  const dodTemplates = createDodTemplateService({ ...deps, settings: readRoadmapSettings, log: (m) => log(m) });
  registerDodHandlers(server, dodTemplates, holder);
  // roadmap_dod_template resolves exactly as dod.template.get, with the PaseoApi captured from RPC contexts.
  const dodTemplate = async (projectId: string): Promise<Result<DodTemplateValue>> => {
    const paseo = holder.get();
    // Unreachable in practice: the MCP grant resolver needs the same holder before any tool runs.
    if (paseo === null) return { ok: false, error: { code: "internal", message: "The Paseo host context is not available yet; retry shortly." } };
    return dodTemplates.get(paseo, { projectId });
  };
  registerTrackerHandlers(
    server,
    createTrackerService({
      ...planDeps,
      settings: readSettings,
      keys: createTrackerKeyStore({}),
      // Plugin-owned SnailOrbit client (O1); the connection is read locally per use, never here.
      live: { snailorbit: createSnailOrbitAdapter({}) },
      connection: codexConnectionSource({}),
      audit: createAuditStore({ log: (m) => log(m) }),
      processStartedAt,
    }),
    holder,
  );

  const endpoint = startMcpEndpoint({
    state,
    tools: buildTools(commands, [
      ...buildPlanTools(planCommands, dodTemplate),
      ...buildFeatureTools(createFeatureCommands(featureDeps)),
      ...buildRunTools(runCommands, { paseo: paseoNow }),
    ], {
      support: (agentId) => readPauseSupport(holder.get(), agentId),
      remember: (agentId, projectId) => pauseEngine.remember(agentId, projectId),
    }),
    resolveGrant: createGrantResolver({ holder, directory: projectDirectoryFromPaseo, log: (m) => log(m), storeOptions }),
    log: (m) => log(m),
  });
  endpoint.catch((e) => log(`MCP endpoint failed to start: ${e instanceof Error ? e.name : "error"}`));

  const unregisterInjection = registerInjection(server, {
    endpoint,
    state,
    holder,
    directory: projectDirectoryFromPaseo,
    openStore,
    log: (m) => log(m),
  });

  // Automatic grilling: the pause engine observes the bound planners' question cards; the first host
  // context of this process (and any replacement) reconciles operations left by a reload or restart.
  const unregisterPause = registerPauseEngine(server, pauseEngine, holder);
  const unsubscribeReconcile = holder.subscribe((paseo) => void pauseEngine.reconcileAll(paseo));
  const early = holder.get();
  if (early !== null) void pauseEngine.reconcileAll(early);
  // Manual continuation retries left `sending` by a previous process become `unknown`, once.
  let swept = false;
  const sweepRetries = (paseo: Parameters<typeof projectDirectoryFromPaseo>[0]) => {
    if (swept) return;
    swept = true;
    void endpoint.then(
      () => sweepAllProjects(discussionDeps(paseo), paseo),
      () => sweepAllProjects(discussionDeps(paseo), paseo),
    );
  };
  const unsubscribeSweep = holder.subscribe(sweepRetries);
  if (early !== null) sweepRetries(early);

  // Decision rows in Claude/Codex agent timelines, for host-delivered agents of opted-in projects only.
  const stopTimelineObserver = registerTimelineObserver(server, { directory: projectDirectoryFromPaseo, openStore, holder, log: (m) => log(m) });

  return async () => {
    // No new hook or subscriber call, no new claim or host call; then wait for what already started.
    unsubscribeReconcile();
    unsubscribeSweep();
    stopRevisionWatches();
    unregisterPause();
    pauseAbort.abort();
    await pauseEngine.idle();
    unregisterInjection();
    await stopTimelineObserver();
    await endpoint.then((e) => e.close()).catch(() => undefined);
    await runners?.dispose();
  };
}
