import type { PluginRpcContract, RpcInput } from "@getpaseo/plugin";
import { usePaseo, useRpc, useWorkspace } from "@getpaseo/plugin/client";
import * as clientSdk from "@getpaseo/plugin/client";
import { useToast } from "@getpaseo/plugin/client/react-native";
import { useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  PlanGet,
  PlanList,
  RoadmapOverview,
  RoadmapVersion,
  SessionGet,
  type Overview,
  type PlanView,
  type Result,
  type RpcError,
  type SessionView,
  type ValueOf,
  type VersionValue,
} from "../shared/rpc";
import type { SessionFinish } from "../shared/rpc-discussion";
import { FeatureList } from "../shared/rpc-features";
import { RUN_CONTRACTS, RUN_EVIDENCE_CONTRACTS, RunGet, RunList } from "../shared/rpc-runs";
import { isRecord } from "../shared/canonical";
import { optionalExport } from "../shared/host-features";
import { RoadmapRevisionWatch, type RevisionEvent } from "../shared/rpc-live";
import { conflictMessage } from "./layout";
import type { PlannerAgentEntry } from "./planner-picker";

/**
 * Thrown by query functions so the error UI can read the RPC error. A constructor function rather
 * than a class, because the native (Hermes) client bundle cannot parse class syntax; instances are
 * real Errors with this prototype, so `instanceof RpcFailure` and `instanceof Error` hold.
 */
export interface RpcFailure extends Error {
  readonly rpcError: RpcError;
}
interface RpcFailureConstructor {
  new (rpcError: RpcError): RpcFailure;
  prototype: RpcFailure;
}

// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- Hermes-safe ES5 Error subclass (Reflect.construct); no class extends Error by design
export const RpcFailure = function RpcFailure(rpcError: RpcError) {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- Hermes-safe ES5 Error subclass (Reflect.construct); no class extends Error by design
  const error = Reflect.construct(Error, [rpcError.message], RpcFailure) as { -readonly [K in keyof RpcFailure]: RpcFailure[K] };
  error.name = "RpcFailure";
  error.rpcError = rpcError;
  return error;
} as unknown as RpcFailureConstructor;
Object.setPrototypeOf(RpcFailure, Error);
// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Hermes-safe ES5 Error subclass (Reflect.construct); no class extends Error by design
RpcFailure.prototype = Object.create(Error.prototype, {
  constructor: { value: RpcFailure, writable: true, configurable: true },
  name: { value: "RpcFailure", writable: true, configurable: true },
});

const unwrap = <T>(r: Result<T>): T => {
  if (!r.ok) throw new RpcFailure(r.error);
  return r.value;
};

export function useProjectId(workspaceId: string): string | null {
  return useWorkspace(workspaceId, (w) => w.projectId);
}

export const roadmapKey = (hostId: string, projectId: string) => ["decision-roadmap", hostId, projectId] as const;

export function useRoadmapVersion(hostId: string, projectId: string): UseQueryResult<VersionValue> {
  const call = useRpc(RoadmapVersion);
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: [...roadmapKey(hostId, projectId), "version"],
    queryFn: async () => unwrap((await call({ projectId })) as Result<VersionValue>),
    refetchInterval: 3000,
  });
  const previous = useRef<number | null>(null);
  const revision = query.data?.revision ?? null;
  useEffect(() => {
    if (previous.current !== null && revision !== previous.current) {
      void queryClient.invalidateQueries({
        queryKey: roadmapKey(hostId, projectId),
        predicate: (q) => q.queryKey[3] !== "version",
      });
    }
    previous.current = revision;
  }, [revision, hostId, projectId, queryClient]);
  return query;
}

/** The live-update states: no host support, subscribing, delivering events, or waiting to retry. */
export type LiveRevisionStatus = "unsupported" | "connecting" | "live" | "retrying";

type SubscriptionState = { status: "connecting" | "live" | "closed" | "error" };
type UseSubscription = (contract: typeof RoadmapRevisionWatch, input: { projectId: string }, onEvent: (event: RevisionEvent) => void) => SubscriptionState;

function subscriptionHook(): UseSubscription | null {
  const candidate = optionalExport(clientSdk, "useSubscription");
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- runtime-detected host hook; older SDK types do not declare it
  return typeof candidate === "function" ? (candidate as UseSubscription) : null;
}

/** Retry delays after a failed or closed subscription: 1 s doubling to at most 30 s. */
export const liveRetryDelay = (failures: number): number => Math.min(30_000, 1000 * 2 ** Math.min(failures, 5));

/**
 * Live revision notifications for one host and project, where the host supports subscriptions.
 * An event or a (re)established subscription refreshes the `roadmapKey(hostId, projectId)` version
 * query, whose revision comparison in `useRoadmapVersion` then re-reads the roadmap. Events are not
 * replayed, so establishment always re-reads. A failed or closed subscription is retried with a
 * growing delay; the version poll runs throughout, so live updates only make changes appear sooner.
 */
export function useLiveRevision(hostId: string, projectId: string): LiveRevisionStatus {
  // Detection is fixed for the loaded host, so the hook order is stable across renders.
  const useSubscription = subscriptionHook();
  const queryClient = useQueryClient();
  const [attempt, setAttempt] = useState(0);
  const failures = useRef(0);
  // A new contract object per attempt makes the host's hook subscribe again; the wire contract is the same.
  const contract = useMemo(() => ({ ...RoadmapRevisionWatch }), [attempt, hostId, projectId]);
  const reread = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: [...roadmapKey(hostId, projectId), "version"], exact: true }).catch(() => undefined);
  }, [queryClient, hostId, projectId]);
  const onEvent = useCallback(
    (event: RevisionEvent) => {
      // The subscription's host is this surface's host; an event of another project is ignored.
      if (event.projectId !== projectId) return;
      const cached = queryClient.getQueryData<VersionValue>([...roadmapKey(hostId, projectId), "version"]);
      if (cached !== undefined && cached.status === event.status && cached.revision === event.revision) return;
      reread();
    },
    [queryClient, hostId, projectId, reread],
  );
  let state: SubscriptionState | null = null;
  if (useSubscription !== null) {
    try {
      state = useSubscription(contract, { projectId }, onEvent);
    } catch {
      // A surface without the host's RPC context: the same on every render of this mount.
      state = null;
    }
  }
  const status = state?.status ?? null;
  // Keyed on the host hook's state object: each failure or closure is a new state, and a retry
  // passes through "connecting", so every outcome is handled exactly once.
  useEffect(() => {
    const current = state?.status;
    if (current === "live") {
      failures.current = 0;
      reread();
      return;
    }
    if (current !== "error" && current !== "closed") return;
    const timer = setTimeout(() => setAttempt((a) => a + 1), liveRetryDelay(failures.current));
    failures.current += 1;
    return () => clearTimeout(timer);
  }, [state, reread]);
  if (status === null) return "unsupported";
  return status === "error" || status === "closed" ? "retrying" : status;
}

export function useOverview(hostId: string, projectId: string, enabled: boolean): UseQueryResult<Overview> {
  const call = useRpc(RoadmapOverview);
  return useQuery({
    queryKey: [...roadmapKey(hostId, projectId), "overview"],
    queryFn: async () => unwrap((await call({ projectId })) as Result<Overview>),
    enabled,
  });
}

export function useSessionView(hostId: string, projectId: string, sessionId: string | null): UseQueryResult<SessionView> {
  const call = useRpc(SessionGet);
  return useQuery({
    queryKey: [...roadmapKey(hostId, projectId), "session", sessionId],
    queryFn: async () => unwrap((await call({ projectId, sessionId: sessionId! })) as Result<SessionView>),
    enabled: sessionId !== null,
  });
}

export type FeatureListValue = ValueOf<typeof FeatureList>;

/** The roadmap's features in order with the store revision; refreshed by the version invalidation, no polling. */
export function useFeatureList(hostId: string, projectId: string, enabled: boolean): UseQueryResult<FeatureListValue> {
  const call = useRpc(FeatureList);
  return useQuery({
    queryKey: [...roadmapKey(hostId, projectId), "features"],
    queryFn: async () => unwrap((await call({ projectId })) as Result<FeatureListValue>),
    enabled,
  });
}

export type PlanListValue = ValueOf<typeof PlanList>;

export function usePlanList(hostId: string, projectId: string, enabled = true): UseQueryResult<PlanListValue> {
  const call = useRpc(PlanList);
  return useQuery({
    queryKey: [...roadmapKey(hostId, projectId), "plans"],
    queryFn: async () => unwrap((await call({ projectId })) as Result<PlanListValue>),
    enabled,
  });
}

export function usePlan(hostId: string, projectId: string, planId: string | null): UseQueryResult<PlanView> {
  const call = useRpc(PlanGet);
  return useQuery({
    queryKey: [...roadmapKey(hostId, projectId), "plan", planId],
    queryFn: async () => unwrap((await call({ projectId, planId: planId! })) as Result<PlanView>),
    enabled: planId !== null,
  });
}

/** Latest known store revision from any cached roadmap query of this host and project. */
function cachedRevision(queryClient: ReturnType<typeof useQueryClient>, hostId: string, projectId: string): number | null {
  // The newest revision known from any cached roadmap query of this host and project (the version
  // poll can lag behind a fresher run.get); an explicit draft revision is applied by the caller.
  const version = queryClient.getQueryData<VersionValue>([...roadmapKey(hostId, projectId), "version"]);
  let best: number | null = version?.revision ?? null;
  for (const [, data] of queryClient.getQueriesData<{ revision?: number }>({ queryKey: roadmapKey(hostId, projectId) })) {
    if (typeof data?.revision === "number") best = Math.max(best ?? 0, data.revision);
  }
  return best;
}

export type MutationOptions = {
  /** Revision the caller's draft was based on; overrides the latest cached revision. */
  expectedRevision?: number;
  onError?(error: RpcError): void;
  /** The RPC call itself failed (the response was lost): whether anything was written is unknown. Never for a failed re-read after an answer. */
  onCallError?(error: unknown): void;
};

/** A mutation's input without the fields the hook fills in; distributes over a union input. */
type MutationInput<C extends PluginRpcContract> = RpcInput<C> extends infer I ? (I extends unknown ? Omit<I, "projectId" | "expectedRevision"> : never) : never;

export function useRoadmapMutation<C extends PluginRpcContract>(
  hostId: string,
  projectId: string,
  contract: C,
): {
  run(input: MutationInput<C>, opts?: MutationOptions): Promise<ValueOf<C> | null>;
  pending: boolean;
} {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- heterogeneous SDK contract dispatch; the generic handler cannot type each method
  const call = useRpc(contract) as (input: unknown) => Promise<Result<ValueOf<C>>>;
  const queryClient = useQueryClient();
  const toast = useToast();
  const [pending, setPending] = useState(false);
  const run = useCallback(
    async (input: MutationInput<C>, opts: MutationOptions = {}): Promise<ValueOf<C> | null> => {
      // An explicit revision (a draft's observed base) is never replaced by the latest cached one.
      const expectedRevision = opts.expectedRevision ?? cachedRevision(queryClient, hostId, projectId);
      if (expectedRevision === null) {
        toast.error("Roadmap is still loading. Try again.");
        return null;
      }
      setPending(true);
      try {
        let out: Result<ValueOf<C>>;
        try {
          out = await call({ ...input, projectId, expectedRevision });
        } catch (e) {
          toast.show(e instanceof Error ? e.message : "Request failed", { variant: "error" });
          opts.onCallError?.(e);
          return null;
        }
        // The call has answered: a failed re-read after it is not a lost response, and the outcome
        // stands. The version poll re-reads the roadmap anyway.
        const reread = () => queryClient.invalidateQueries({ queryKey: roadmapKey(hostId, projectId) }).catch(() => undefined);
        if (out.ok) {
          await reread();
          const stale = isRecord(out.value) ? out.value.staleMarked : undefined;
          if (Array.isArray(stale) && stale.length > 0) {
            toast.show(`${stale.length} ${stale.length === 1 ? "question" : "questions"} marked stale`, { variant: "warning" });
          }
          return out.value;
        }
        toast.show(conflictMessage(out.error), { variant: "error" });
        opts.onError?.(out.error);
        if (refetchOn(contract.name, out.error.code)) await reread();
        return null;
      } finally {
        setPending(false);
      }
    },
    [call, queryClient, hostId, projectId, toast, contract.name],
  );
  return { run, pending };
}

/** The session.finish mutation as a screen shares it between its Finish entries. */
export type FinishMutation = ReturnType<typeof useRoadmapMutation<typeof SessionFinish>>;

// ---- Stage R4.2: run queries, profiles and the mutation refetch rule ----

const RUN_CONTRACT_NAMES: ReadonlySet<string> = new Set([...RUN_CONTRACTS, ...RUN_EVIDENCE_CONTRACTS].map((c) => c.name));

/**
 * Which refusals a mutation returns make the screen re-read the roadmap (its queries are invalidated;
 * the mutation itself is never sent again): a revision conflict, a stale run token or a run that is
 * not ready; for the run contracts also `invalid_input`, a state refusal such as "the run is not
 * paused" after a concurrent resume won (c0095); and every refusal of Discuss
 * (`feature.discussion.open`) and Retry (`discussion.retry`). A thrown error (the host call itself
 * failed) re-reads nothing.
 */
function refetchOn(contractName: string, code: RpcError["code"]): boolean {
  if (code === "revision_conflict" || code === "run_stale" || code === "run_not_ready") return true;
  // Some Discuss and Retry refusals come after the store changed: Discuss records a failed or an
  // unresolved creation, and Retry settles its record as failed or unknown, before refusing. A
  // refusal does not say whether it wrote, so every refusal of either re-reads.
  if (contractName === "feature.discussion.open" || contractName === "discussion.retry") return true;
  return code === "invalid_input" && RUN_CONTRACT_NAMES.has(contractName);
}

export type RunListValue = ValueOf<typeof RunList>;
export type RunGetValue = ValueOf<typeof RunGet>;

/** The feature's runs; the key is shared with FeatureChat and refreshed by the version invalidation. */
export function useRunList(hostId: string, projectId: string, featureId: string | null): UseQueryResult<RunListValue> {
  const call = useRpc(RunList);
  return useQuery({
    queryKey: [...roadmapKey(hostId, projectId), "runs", featureId],
    queryFn: async () => unwrap((await call({ projectId, featureId: featureId! })) as Result<RunListValue>),
    enabled: featureId !== null,
  });
}

/** Every run of the project for the roadmap progress line (Stage R4.4); read-only, own key. */
export function useProjectRuns(hostId: string, projectId: string, enabled: boolean): UseQueryResult<RunListValue> {
  const call = useRpc(RunList);
  return useQuery({
    queryKey: [...roadmapKey(hostId, projectId), "project-runs"],
    queryFn: async () => unwrap((await call({ projectId })) as Result<RunListValue>),
    enabled,
  });
}

/** One run as run.get returns it: the current token, readiness, blockers and unresolved lines. */
export function useRun(hostId: string, projectId: string, runId: string | null): UseQueryResult<RunGetValue> {
  const call = useRpc(RunGet);
  return useQuery({
    queryKey: [...roadmapKey(hostId, projectId), "run", runId],
    queryFn: async () => unwrap((await call({ projectId, runId: runId! })) as Result<RunGetValue>),
    enabled: runId !== null,
  });
}

/** The host's agent profiles as `{ id, label }` choices (id and name only, never a model string). */
export function profileOptions(config: unknown): Array<{ id: string; label: string }> {
  if (typeof config !== "object" || config === null) return [];
  const profiles = (config as { agentProfiles?: unknown }).agentProfiles;
  if (!Array.isArray(profiles)) return [];
  return profiles.flatMap((p) => {
    if (!isRecord(p)) return [];
    const { id, name } = p;
    return typeof id === "string" && id !== "" && typeof name === "string" && name !== "" ? [{ id, label: name }] : [];
  });
}

/** The coordinator profiles from the host config (`usePaseo().config.get()`); no plugin RPC. */
export function useProfiles(hostId: string): UseQueryResult<Array<{ id: string; label: string }>> {
  const paseo = usePaseo() as ReturnType<typeof usePaseo> | null;
  return useQuery({
    queryKey: ["decision-roadmap", hostId, "profiles"],
    queryFn: async () => {
      if (!paseo) return [];
      const out = await paseo.config.get();
      return profileOptions(out.config);
    },
  });
}

// ---- Automatic grilling S3: planner picker agent list ----

/**
 * The chats of this project on the panel's host (`usePaseo()`), for the planner picker: one page of
 * up to 200 agents of `projectKeys: [projectId]` without archived ones, no subscription. Only the fields
 * the picker reads are kept; the current-planner marker is derived outside the cache. Never refs, sends,
 * runs, answers or creates anything.
 */
export function usePlannerAgents(hostId: string, projectId: string, enabled: boolean): UseQueryResult<PlannerAgentEntry[]> {
  const paseo = usePaseo() as ReturnType<typeof usePaseo> | null;
  return useQuery({
    queryKey: ["decision-roadmap", hostId, projectId, "planner-agents"],
    enabled,
    queryFn: async (): Promise<PlannerAgentEntry[]> => {
      if (!paseo) return [];
      const out = await paseo.agents.list({ filter: { projectKeys: [projectId], includeArchived: false }, page: { limit: 200 } });
      return out.entries.map((e) => ({
        agent: {
          id: e.agent.id,
          provider: e.agent.provider,
          title: e.agent.title,
          status: e.agent.status,
          ...(e.agent.archivedAt !== undefined ? { archivedAt: e.agent.archivedAt } : {}),
          ...(e.agent.internal !== undefined ? { internal: e.agent.internal } : {}),
        },
        project: { projectKey: e.project.projectKey },
      }));
    },
  });
}
