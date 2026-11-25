// Feature records (Stage R0.5, design §2/§3.1/§6): an ordered roadmap of feature cards with
// dependencies, manual status transitions, deletion only before the first start and append-only
// history. People and agents may create and edit cards; reorder, delete and status changes are UI
// only. Planned, executing and done are reached through plans and runs in later stages, never here.
import type { PaseoApi } from "@getpaseo/client";
import type { PluginRpcContract, RpcInput } from "@getpaseo/plugin";
import { DomainError, isDomainError } from "../shared/errors";
import type { Feature, FeatureCreator, FeatureEvent, FeatureStatus, RoadmapData } from "../shared/model";
import type { Result, ValueOf } from "../shared/rpc";
import type {
  FeatureCreate,
  FeatureDelete,
  FeatureDependenciesSet,
  FeatureList,
  FeaturePatch,
  FeatureReorder,
  FeatureStatusSet,
  FeatureUpdate,
} from "../shared/rpc-features";
import { ulid } from "./ids";
import type { ApprovalStore } from "./approvals";
import { readLatestReceipts, type ReceiptMap } from "./plans";
import { applyPrerequisiteCancelled, applyRunEffect, type DependencyEffect } from "./runs";
import { projectSection, projectSectionKey, type ProjectSection } from "./project-section";
import { UI_ORIGIN, type RoadmapServiceDeps, type StoreOpener, type WriteOrigin } from "./sessions";
import { openProjectStore } from "./store-root";

type Cmd<C extends PluginRpcContract> = (open: StoreOpener, input: RpcInput<C>, origin: WriteOrigin) => Promise<Result<ValueOf<C>>>;

/**
 * `feature.update` carries a card patch only. The MCP update tool may also set dependencies in the
 * same call; both apply in one transaction under one expectedRevision.
 */
export type FeatureUpdateInput = Omit<RpcInput<typeof FeatureUpdate>, "patch"> & { patch?: FeaturePatch; dependsOn?: string[] };

export interface FeatureCommands {
  list: Cmd<typeof FeatureList>;
  create: Cmd<typeof FeatureCreate>;
  update(open: StoreOpener, input: FeatureUpdateInput, origin: WriteOrigin): Promise<Result<ValueOf<typeof FeatureUpdate>>>;
  reorder: Cmd<typeof FeatureReorder>;
  dependenciesSet: Cmd<typeof FeatureDependenciesSet>;
  delete: Cmd<typeof FeatureDelete>;
  statusSet: Cmd<typeof FeatureStatusSet>;
}

type Fn<C extends PluginRpcContract> = (paseo: PaseoApi, input: RpcInput<C>) => Promise<Result<ValueOf<C>>>;
export interface FeatureService {
  list: Fn<typeof FeatureList>;
  create: Fn<typeof FeatureCreate>;
  update: Fn<typeof FeatureUpdate>;
  reorder: Fn<typeof FeatureReorder>;
  dependenciesSet: Fn<typeof FeatureDependenciesSet>;
  delete: Fn<typeof FeatureDelete>;
  statusSet: Fn<typeof FeatureStatusSet>;
}

/** Statuses a feature can be deferred from, and the only ones undefer returns to. */
const ACTIVE: ReadonlySet<FeatureStatus> = new Set<FeatureStatus>(["created", "planned", "executing"]);
const isActive = (status: FeatureStatus): status is "created" | "planned" | "executing" => ACTIVE.has(status);

/** Attribution of a write. An agent without a bound id is recorded as "unknown" until grants bind agents. */
function creatorOf(origin: WriteOrigin): FeatureCreator {
  if (origin.source === "ui") return { kind: "human" };
  return { kind: "agent", agentId: origin.actor.kind === "agent" && origin.actor.agentId !== undefined ? origin.actor.agentId : "unknown" };
}

function findFeature(data: RoadmapData, featureId: string): Feature {
  const feature = data.features.find((f) => f.id === featureId);
  if (!feature) throw new DomainError("not_found", `feature ${featureId} not found`, { featureId });
  return feature;
}

/**
 * Checks a new dependency list for `featureId` (absent for a feature being created): unique ids,
 * known features, and no path from any prerequisite back to the feature itself.
 */
function checkDependencies(data: RoadmapData, featureId: string | undefined, dependsOn: string[]): void {
  if (new Set(dependsOn).size !== dependsOn.length) throw new DomainError("invalid_input", "dependency ids must be unique", { dependsOn });
  const byId = new Map(data.features.map((f) => [f.id, f] as const));
  const unknown = dependsOn.filter((id) => !byId.has(id));
  if (unknown.length > 0) throw new DomainError("not_found", `unknown feature: ${unknown.join(", ")}`, { featureIds: unknown });
  if (featureId === undefined) return;
  if (dependsOn.includes(featureId)) throw new DomainError("relation_cycle", "a feature cannot depend on itself", { featureId });
  const seen = new Set<string>();
  const stack = [...dependsOn];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (id === featureId) throw new DomainError("relation_cycle", "the dependencies would form a cycle", { featureId, dependsOn });
    if (seen.has(id)) continue;
    seen.add(id);
    stack.push(...(byId.get(id)?.dependsOn ?? []));
  }
}

/** Whether a plan bound to the feature has its latest revision sent for rework. */
function inRework(data: RoadmapData, featureId: string): boolean {
  return data.plans.some((p) => {
    const latest = p.revisions.at(-1);
    return p.featureId === featureId && latest !== undefined && (p.reworks ?? []).some((r) => r.planRev === latest.rev);
  });
}

/** A descriptive relation set at creation: unique ids of existing features, no cycle rule. */
function checkRelated(data: RoadmapData, relatedTo: string[]): void {
  if (new Set(relatedTo).size !== relatedTo.length) throw new DomainError("invalid_input", "related feature ids must be unique", { relatedTo });
  const known = new Set(data.features.map((f) => f.id));
  const unknown = relatedTo.filter((id) => !known.has(id));
  if (unknown.length > 0) throw new DomainError("not_found", `unknown feature: ${unknown.join(", ")}`, { featureIds: unknown });
}

/** Stage R3.5: called after a status change committed an effect on the feature's live run. */
export type FeatureDeps = RoadmapServiceDeps & {
  afterRunEffect?: (x: { projectId: string; runId: string }) => void;
  /** Stage R4.3: the authoritative approval receipts (absent: no receipt, so dependents get a request only). */
  approvals?: ApprovalStore;
  /** Stage R4.3: after commit, one steer asking a bound coordinator for a replacement plan. */
  afterReplacementRequest?: (x: { projectId: string; featureId: string; agentId: string }) => void;
  /** The per-project critical section shared with plan approval (default: the process-wide one). */
  projectSection?: ProjectSection;
};

export function createFeatureCommands(deps: FeatureDeps): FeatureCommands {
  const now = deps.now ?? (() => new Date());
  const section = deps.projectSection ?? projectSection;
  const newId = deps.newId ?? (() => ulid());
  const log = deps.storeOptions?.log ?? ((m: string, e?: unknown) => console.error(m, e));

  async function toResult<T>(body: () => Promise<T>): Promise<Result<T>> {
    try {
      return { ok: true, value: await body() };
    } catch (e) {
      if (isDomainError(e)) {
        return { ok: false, error: { code: e.code, message: e.message, ...(e.details !== undefined ? { details: e.details } : {}) } };
      }
      log("decision-roadmap: unexpected feature error", e);
      return { ok: false, error: { code: "internal", message: "Unexpected error; see plugin logs." } };
    }
  }

  /** One transaction; `fn` edits the draft and returns the value fields besides `revision`. */
  function mutate<T extends object>(
    open: StoreOpener,
    input: { projectId: string; expectedRevision: number },
    fn: (draft: RoadmapData, at: string) => T,
  ): Promise<Result<T & { revision: number }>> {
    return toResult(async () => {
      const store = await open(input.projectId);
      const out = await store.transact(input.expectedRevision, (draft) => fn(draft, now().toISOString()));
      return { ...out.result, revision: out.revision };
    });
  }

  /** A UI-only write: the origin is refused before the store is touched, like plan approval. */
  function uiMutate<T extends object>(
    open: StoreOpener,
    input: { projectId: string; expectedRevision: number },
    origin: WriteOrigin,
    action: string,
    fn: (draft: RoadmapData, at: string) => T,
  ): Promise<Result<T & { revision: number }>> {
    if (origin.source !== "ui") {
      return toResult(async () => {
        throw new DomainError("invalid_input", `${action} happens only in the Paseo UI`);
      });
    }
    return mutate(open, input, fn);
  }

  const event = (at: string, origin: WriteOrigin, kind: FeatureEvent["kind"], extra: Pick<FeatureEvent, "from" | "to"> = {}): FeatureEvent => ({
    at,
    actor: creatorOf(origin),
    kind,
    ...extra,
  });

  return {
    list: (open, i) =>
      toResult(async () => {
        const read = await (await open(i.projectId)).read();
        if (read.status === "missing") throw new DomainError("store_missing", "No decision roadmap in this project.");
        if (read.status === "invalid") throw new DomainError("store_invalid", read.error.message, read.error);
        return { revision: read.revision, features: read.data.features, delegations: read.data.delegations };
      }),

    create: (open, i, origin) =>
      mutate(open, i, (draft, at) => {
        const dependsOn = i.dependsOn ?? [];
        checkDependencies(draft, undefined, dependsOn);
        const relatedTo = i.relatedTo ?? [];
        checkRelated(draft, relatedTo);
        const featureId = newId();
        draft.features.push({
          id: featureId,
          title: i.title,
          description: i.description,
          kind: i.kind,
          status: "created",
          dependsOn: [...dependsOn],
          relatedTo: [...relatedTo],
          everStarted: false,
          createdAt: at,
          createdBy: creatorOf(origin),
          coordinatorHistory: [],
          events: [event(at, origin, "created")],
        });
        return { featureId };
      }),

    update: (open, i, origin) =>
      mutate(open, i, (draft, at) => {
        if (i.patch === undefined && i.dependsOn === undefined) throw new DomainError("invalid_input", "nothing to update");
        const feature = findFeature(draft, i.featureId);
        if (i.dependsOn !== undefined) checkDependencies(draft, feature.id, i.dependsOn);
        if (i.patch !== undefined) {
          if (i.patch.title !== undefined) feature.title = i.patch.title;
          if (i.patch.description !== undefined) feature.description = i.patch.description;
          feature.events.push(event(at, origin, "updated"));
        }
        if (i.dependsOn !== undefined) {
          feature.dependsOn = [...i.dependsOn];
          feature.events.push(event(at, origin, "dependencies"));
        }
        return {};
      }),

    reorder: (open, i, origin) =>
      uiMutate(open, i, origin, "Reordering the roadmap", (draft, at) => {
        const current = draft.features.map((f) => f.id);
        const permutation =
          i.order.length === current.length && new Set(i.order).size === i.order.length && i.order.every((id) => current.includes(id));
        if (!permutation) throw new DomainError("invalid_input", "order must list every feature exactly once", { order: i.order });
        const byId = new Map(draft.features.map((f) => [f.id, f] as const));
        i.order.forEach((id, index) => {
          const from = current.indexOf(id);
          if (from !== index) byId.get(id)!.events.push(event(at, origin, "reordered", { from: String(from), to: String(index) }));
        });
        draft.features = i.order.map((id) => byId.get(id)!);
        return {};
      }),

    dependenciesSet: (open, i, origin) =>
      mutate(open, i, (draft, at) => {
        const feature = findFeature(draft, i.featureId);
        checkDependencies(draft, feature.id, i.dependsOn);
        feature.dependsOn = [...i.dependsOn];
        feature.events.push(event(at, origin, "dependencies"));
        return {};
      }),

    delete: (open, i, origin) =>
      uiMutate(open, i, origin, "Deleting a feature", (draft) => {
        const feature = findFeature(draft, i.featureId);
        if (feature.everStarted) {
          throw new DomainError("feature_transition", "a feature that has started is never deleted", { featureId: feature.id });
        }
        // The chat being created would be left without its feature and session.
        if (feature.discussion?.state === "creating") {
          throw new DomainError("feature_transition", "the feature's discussion chat is being created; delete it once that finishes", { featureId: feature.id });
        }
        const dependents = draft.features.filter((f) => f.dependsOn.includes(feature.id)).map((f) => f.id);
        if (dependents.length > 0) {
          throw new DomainError("feature_transition", "other features depend on this feature", { featureId: feature.id, dependents });
        }
        // A bound plan must repeat its featureId on every later draft, so its feature must stay.
        const planIds = draft.plans.filter((p) => p.featureId === feature.id).map((p) => p.id);
        if (planIds.length > 0) {
          throw new DomainError("feature_transition", "plans are bound to this feature", { featureId: feature.id, planIds });
        }
        draft.features = draft.features.filter((f) => f.id !== feature.id);
        return {};
      }),

    statusSet: async (open, i, origin) => {
      let effect: { runId: string } | undefined;
      let dependencyEffects: DependencyEffect[] = [];
      // Stage R4.3: the approval receipts are read from the ApprovalStore BEFORE the transaction (the
      // transaction at expectedRevision then guarantees the same data) and revalidated inside it.
      let receipts: ReceiptMap = new Map();
      const approvals = origin.source === "ui" && i.status === "cancelled" ? deps.approvals : undefined;
      const mutateStatus = () => uiMutate(open, i, origin, "Changing a feature status", (draft, at) => {
        const feature = findFeature(draft, i.featureId);
        const from = feature.status;
        const to = i.status;
        const refuse = () => {
          throw new DomainError("feature_transition", `a feature cannot move from ${from} to ${to} manually`, { from, to });
        };
        if (from === "deferred") {
          if (to !== "cancelled" && to !== feature.statusBeforeDefer) refuse();
          delete feature.statusBeforeDefer;
        } else if (to === "deferred") {
          feature.statusBeforeDefer = isActive(from) ? from : refuse();
        } else if (to !== "cancelled" || !ACTIVE.has(from)) {
          refuse();
        }
        feature.status = to;
        // The reason describes the current status only; history stays in the events and Plan.reworks.
        delete feature.statusReason;
        if (from === "deferred" && to === "created" && inRework(draft, feature.id)) feature.statusReason = "plan in rework";
        feature.events.push(event(at, origin, "status", { from, to }));
        // The live run follows in the same transaction (card §6.2a): defer pauses, cancel ends,
        // undefer keeps it paused for a human resume.
        effect = applyRunEffect(draft, feature.id, to === "deferred" ? "deferred" : to === "cancelled" ? "cancelled" : "undeferred", at);
        const actor = event(at, origin, "status", {}).actor;
        if (to === "cancelled") {
          // Stage R4.3: the dependents follow in this same human transaction.
          dependencyEffects = applyPrerequisiteCancelled(draft, { projectId: i.projectId, cancelledId: feature.id, at, actor, receipts });
        }
        return {};
      });
      let out: Awaited<ReturnType<typeof mutateStatus>>;
      if (approvals) {
        // R4 final review c0082: the receipt check and the transaction run in the project's critical
        // section, so a concurrent approval cannot publish a receipt between them. The after-commit
        // hooks below run after the section is released.
        // A failing open or receipt read returns its Result (nothing is committed) instead of rejecting.
        const guarded = await toResult(async () => {
          const store = await open(i.projectId);
          return section(projectSectionKey(store), async () => {
            const read = await store.read().catch(() => null);
            if (read?.status === "ok") {
              const ids = read.data.features.filter((f) => f.dependsOn.includes(i.featureId)).map((f) => f.id);
              if (ids.length > 0) receipts = await readLatestReceipts(approvals, i.projectId, read.data, ids);
            }
            return mutateStatus();
          });
        });
        out = guarded.ok ? guarded.value : guarded;
      } else {
        out = await mutateStatus();
      }
      if (out.ok) {
        if (effect) deps.afterRunEffect?.({ projectId: i.projectId, ...effect });
        for (const e of dependencyEffects) {
          if (e.kind === "run") deps.afterRunEffect?.({ projectId: i.projectId, runId: e.runId });
          else deps.afterReplacementRequest?.({ projectId: i.projectId, featureId: e.featureId, agentId: e.agentId });
        }
      }
      return out;
    },
  };
}

/** UI wrapper: a live opener per call and the UI origin, as createPlanService does. */
export function createFeatureService(deps: FeatureDeps): FeatureService {
  const commands = createFeatureCommands(deps);
  const opener =
    (paseo: PaseoApi): StoreOpener =>
    (projectId) =>
      openProjectStore(deps.directory(paseo), projectId, deps.storeOptions);
  return {
    list: (paseo, i) => commands.list(opener(paseo), i, UI_ORIGIN),
    create: (paseo, i) => commands.create(opener(paseo), i, UI_ORIGIN),
    update: (paseo, i) => commands.update(opener(paseo), i, UI_ORIGIN),
    reorder: (paseo, i) => commands.reorder(opener(paseo), i, UI_ORIGIN),
    dependenciesSet: (paseo, i) => commands.dependenciesSet(opener(paseo), i, UI_ORIGIN),
    delete: (paseo, i) => commands.delete(opener(paseo), i, UI_ORIGIN),
    statusSet: (paseo, i) => commands.statusSet(opener(paseo), i, UI_ORIGIN),
  };
}
