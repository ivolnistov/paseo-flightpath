// Plan commands (Stage 3 P3.4): drafts, exact-revision approval backed by plugin-data receipts,
// task state per (planRev, taskId), and the derived Markdown export.
import type { PaseoApi } from "@getpaseo/client";
import type { PluginRpcContract, RpcInput } from "@getpaseo/plugin";
import { canonicalJson } from "../shared/canonical";
import { DomainError, isDomainError } from "../shared/errors";
import {
  isV2Revision,
  taskGraphIssues,
  type ApprovalReceipt,
  type Feature,
  type FeatureCreator,
  type Plan,
  type PlanRevision,
  type RoadmapData,
  type TaskDefinition,
  type TaskDefinitionV2,
} from "../shared/model";
import type { PlanApprove, PlanDraft, PlanGet, PlanList, PlanView, Result, TaskUpdate, ValueOf } from "../shared/rpc";
import type { PlanRework } from "../shared/rpc-features";
import type { ApprovalStore } from "./approvals";
import { ulid } from "./ids";
import { applyRunEffect } from "./runs";
import { syncExport } from "./plan-export";
import { basedOnSnapshot, cancelledRefs, contentHash, contentHashFor, contentHashV2, decisionSnapshotHash } from "./plan-hash";
import { approvalBlockers, basisCurrent, currency, eligibility, isReworked, reworkReason, taskTransition } from "./plan-rules";
import { projectSection, projectSectionKey, type ProjectSection } from "./project-section";
import { UI_ORIGIN, type PlannerCaller, type RoadmapServiceDeps, type StoreOpener, type WriteOrigin } from "./sessions";
import type { Store } from "./store";
import { openProjectStore } from "./store-root";

type Cmd<C extends PluginRpcContract> = (open: StoreOpener, input: RpcInput<C>, origin: WriteOrigin) => Promise<Result<ValueOf<C>>>;

export interface PlanCommands {
  list(open: StoreOpener, i: RpcInput<typeof PlanList>): Promise<Result<ValueOf<typeof PlanList>>>;
  get(open: StoreOpener, i: RpcInput<typeof PlanGet>): Promise<Result<ValueOf<typeof PlanGet>>>;
  /** A bound grant's `caller` becomes the planner of every grilling session this draft creates. */
  draft(open: StoreOpener, input: RpcInput<typeof PlanDraft>, origin: WriteOrigin, caller?: PlannerCaller): Promise<Result<ValueOf<typeof PlanDraft>>>;
  approve: Cmd<typeof PlanApprove>;
  taskUpdate: Cmd<typeof TaskUpdate>;
  rework: Cmd<typeof PlanRework>;
}

type PlanFn<C extends PluginRpcContract> = (paseo: PaseoApi, input: RpcInput<C>) => Promise<Result<ValueOf<C>>>;
export interface PlanService {
  list: PlanFn<typeof PlanList>;
  get: PlanFn<typeof PlanGet>;
  draft: PlanFn<typeof PlanDraft>;
  approve: PlanFn<typeof PlanApprove>;
  taskUpdate: PlanFn<typeof TaskUpdate>;
  rework: PlanFn<typeof PlanRework>;
}

// ---- Stage R4.3: the authoritative receipt pre-read and the shared R2 rework helper ----

/** Receipts read from the ApprovalStore before a transaction, keyed `${planId}#${rev}` (never plan.approvals). */
export type ReceiptMap = ReadonlyMap<string, ApprovalReceipt>;
export const receiptKey = (planId: string, rev: number) => `${planId}#${rev}`;

/** The single bound plan of a feature and its latest revision, or nothing. */
function boundLatest(data: RoadmapData, featureId: string): { plan: Plan; latest: PlanRevision } | undefined {
  const bound = data.plans.filter((p) => p.featureId === featureId);
  const latest = bound.length === 1 ? bound[0].revisions.at(-1) : undefined;
  return latest ? { plan: bound[0], latest } : undefined;
}

/** For each feature's single bound plan: the ApprovalStore receipt of its latest revision; misses are absent. */
export async function readLatestReceipts(approvals: ApprovalStore, projectId: string, data: RoadmapData, featureIds: string[]): Promise<ReceiptMap> {
  const out = new Map<string, ApprovalReceipt>();
  for (const featureId of featureIds) {
    const b = boundLatest(data, featureId);
    if (!b) continue;
    const receipt = await approvals.read(projectId, b.plan.id, b.latest.rev);
    if (receipt) out.set(receiptKey(b.plan.id, b.latest.rev), receipt);
  }
  return out;
}

/** The rework record (shared by plan.rework and reworkInDraft): reworks, cancelled tasks, feature created. */
type HumanActor = Extract<FeatureCreator, { kind: "human" }>;
function applyRework(plan: Plan, latest: PlanRevision & { tasks: TaskDefinition[] | TaskDefinitionV2[] }, feature: Feature, x: { at: string; reason: string; actor: HumanActor }): void {
  plan.reworks = [...(plan.reworks ?? []), { planRev: latest.rev, at: x.at, reason: x.reason, actor: x.actor }];
  // The task set is cancelled; verified states stay as the record of completed work.
  for (const task of latest.tasks) {
    const index = plan.taskStates.findIndex((s) => s.planRev === latest.rev && s.taskId === task.id);
    if (index >= 0 && plan.taskStates[index].status === "verified") continue;
    const cancelled = { taskId: task.id, planRev: latest.rev, status: "cancelled" as const };
    if (index >= 0) plan.taskStates[index] = cancelled;
    else plan.taskStates.push(cancelled);
  }
  if (feature.status === "deferred") {
    // An automatic rework of a deferred feature (Stage R4.3): it stays deferred and returns to
    // created, in rework, when undeferred.
    feature.statusBeforeDefer = "created";
    feature.events.push({ at: x.at, actor: x.actor, kind: "note", reason: "plan in rework while deferred" });
    return;
  }
  const from = feature.status;
  feature.status = "created";
  feature.statusReason = "plan in rework";
  feature.events.push({ at: x.at, actor: x.actor, kind: "status", from, to: "created", reason: "plan in rework" });
}

const receiptMatches = (receipt: ApprovalReceipt | null, projectId: string, plan: Plan, latest: PlanRevision) =>
  receipt !== null &&
  receipt.projectId === projectId &&
  receipt.planId === plan.id &&
  receipt.planRev === latest.rev &&
  receipt.contentHash === latest.contentHash &&
  receipt.decisionSnapshotHash === latest.decisionSnapshotHash;

/**
 * The R2 rework inside a caller's transaction, with the R2 preconditions revalidated against the
 * draft: a single bound plan, the latest revision, not reworked, a receipt matching projectId,
 * planId, rev, contentHash and decisionSnapshotHash, and a planned or executing feature. Never
 * writes a receipt and never touches runs (the caller owns those).
 */
export function reworkInDraft(
  draft: RoadmapData,
  x: {
    projectId: string;
    planId: string;
    planRev: number;
    receipt: ApprovalReceipt | null;
    reason: string;
    at: string;
    actor: FeatureCreator;
    /** Automatic rework only (a cancelled prerequisite): a feature deferred from planned or executing is reworked too. */
    allowDeferred?: boolean;
  },
): { reworked: true } | { reworked: false; why: string } {
  const plan = draft.plans.find((p) => p.id === x.planId);
  // A rework is a human decision (R2); an automatic one is carried by the causing human action.
  if (x.actor.kind !== "human") return { reworked: false, why: "a rework needs a human actor" };
  const actor = x.actor;
  if (!plan || plan.featureId === undefined) return { reworked: false, why: "the plan is not bound to a feature" };
  if (draft.plans.filter((p) => p.featureId === plan.featureId).length !== 1) return { reworked: false, why: "the feature has more than one plan" };
  const latest = plan.revisions.at(-1);
  if (!latest || latest.rev !== x.planRev) return { reworked: false, why: "not the latest revision" };
  if (isReworked(plan, latest.rev)) return { reworked: false, why: "already sent for rework" };
  if (!receiptMatches(x.receipt, x.projectId, plan, latest)) return { reworked: false, why: "no matching approval receipt" };
  const feature = draft.features.find((f) => f.id === plan.featureId);
  const active = (status: string | undefined) => status === "planned" || status === "executing";
  const reworkable = feature !== undefined && (active(feature.status) || (x.allowDeferred === true && feature.status === "deferred" && active(feature.statusBeforeDefer)));
  if (!feature || !reworkable) return { reworked: false, why: "the feature is not planned or executing" };
  applyRework(plan, latest, feature, { at: x.at, reason: x.reason, actor });
  return { reworked: true };
}

/**
 * Whether an approval clears a replacement request (card §4): with `reworkedRev` only a greater
 * approved revision; without it only a receipt strictly later than the request, so an
 * approval-effects retry of an older receipt never clears it.
 */
export function replacementCleared(req: NonNullable<Feature["replacementRequested"]>, approved: ApprovalReceipt): boolean {
  return req.reworkedRev !== undefined ? approved.planRev > req.reworkedRev : approved.at > req.at;
}

export type PlanDeps = RoadmapServiceDeps & {
  approvals: ApprovalStore;
  /** Stage R3.5: after a rework ended the feature's live run (cancel its runners, steer). */
  afterRunEffect?: (x: { projectId: string; runId: string }) => void;
  /** Stage R4.3: after commit, one steer asking a bound coordinator for a replacement plan. */
  afterReplacementRequest?: (x: { projectId: string; featureId: string; agentId: string }) => void;
  /** Stage R3.5: after an approval committed (delegated and dependent sweep). */
  afterApprove?: (projectId: string) => void;
  /** The per-project critical section shared with a feature cancel (default: the process-wide one). */
  projectSection?: ProjectSection;
};

const COPY_RETRIES = 3;
const sameReceipt = (a: ApprovalReceipt, b: ApprovalReceipt) => canonicalJson(a) === canonicalJson(b);

/** The plugin-data receipt for a revision, only when it matches that revision exactly. */
export async function verifiedReceiptFor(
  approvals: ApprovalStore,
  projectId: string,
  plan: Plan,
  revision: PlanRevision,
): Promise<ApprovalReceipt | null> {
  const r = await approvals.read(projectId, plan.id, revision.rev);
  if (!r) return null;
  const matches =
    r.projectId === projectId &&
    r.planId === plan.id &&
    r.planRev === revision.rev &&
    r.contentHash === revision.contentHash &&
    r.decisionSnapshotHash === revision.decisionSnapshotHash;
  return matches ? r : null;
}

/**
 * Server-owned grilling sessions of a bound draft (Stage R2.2): the feature (unless a bug) and the
 * plan get one ordinary empty session each, at most once; an existing link, even to a missing
 * session, is kept. A `grill` task carries the link of the latest revision's task with the same id,
 * or gets a new session; a task without `grill` has no link (its old session stays in the store).
 * This helper never adds grilling sessions to the plan's sessionIds or basedOn; a caller may still
 * select one explicitly as an ordinary basis session. With `caller` (a bound MCP grant) each session
 * created here gets that chat as its planner (`boundBy: "draft"`, epoch 1).
 */
function linkGrillingSessions(
  draft: RoadmapData,
  plan: Plan,
  x: { featureId: string; planTitle: string; tasks: TaskDefinitionV2[]; at: string; newId: () => string; caller?: PlannerCaller },
): void {
  const { featureId, planTitle, tasks, at, newId, caller } = x;
  // Only sessions created here are bound to the drafting chat; carried and existing ones never change.
  const planner = caller !== undefined ? { agentId: caller.agentId, workspaceId: caller.workspaceId, boundAt: at, boundBy: "draft" as const, epoch: 1 } : undefined;
  const open = (title: string) => {
    const id = newId();
    draft.sessions.push({ id, title, createdAt: at, status: "active", questions: [], ...(planner !== undefined ? { planner: { ...planner } } : {}) });
    return id;
  };
  const feature = draft.features.find((f) => f.id === featureId)!;
  if (feature.kind === "feature" && feature.grillSessionId === undefined) feature.grillSessionId = open(`[feature] ${feature.title}`);
  if (plan.grillSessionId === undefined) plan.grillSessionId = open(`[plan] ${planTitle}`);
  const previous = plan.revisions.at(-1);
  const carried = new Map<string, string>();
  if (previous !== undefined && isV2Revision(previous)) {
    for (const t of previous.tasks) if (t.grill && t.grillSessionId !== undefined) carried.set(t.id, t.grillSessionId);
  }
  for (const t of tasks) {
    if (!t.grill) continue;
    t.grillSessionId = carried.get(t.id) ?? open(`[task:${t.id}] ${t.title}`);
  }
}

const blockerContext = (data: RoadmapData) => ({ features: data.features, sessions: data.sessions, cancelled: cancelledRefs(data) });

const V2_TASK_FIELDS = ["dependsOn", "parallel", "completion", "grill", "dod"] as const;

/**
 * The feature a draft binds to, or undefined for a legacy draft. A bound plan must repeat its
 * featureId (no downgrade to a legacy revision, no rebinding); task fields beyond title and
 * description require a featureId; a featureId must name an existing feature.
 */
function draftBinding(
  data: RoadmapData,
  plan: Plan | undefined,
  i: { featureId?: string; tasks: ReadonlyArray<Partial<Record<(typeof V2_TASK_FIELDS)[number], unknown>>> },
): string | undefined {
  if (plan?.featureId !== undefined && i.featureId !== plan.featureId) {
    throw new DomainError("invalid_input", `plan ${plan.id} is bound to feature ${plan.featureId}; pass that featureId`, {
      featureId: plan.featureId,
    });
  }
  if (i.featureId === undefined) {
    if (i.tasks.some((t) => V2_TASK_FIELDS.some((k) => t[k] !== undefined))) {
      throw new DomainError("invalid_input", "task fields beyond title and description need a featureId");
    }
    return undefined;
  }
  if (!data.features.some((f) => f.id === i.featureId)) {
    throw new DomainError("not_found", `feature ${i.featureId} not found`, { featureId: i.featureId });
  }
  // One plan per feature (owner Q1): binding a second plan is refused; old duplicate data fails closed.
  const others = boundPlans(data, i.featureId).filter((p) => p.id !== plan?.id);
  if (others.length > 0) {
    if (plan?.featureId === undefined) {
      throw new DomainError("invalid_input", "the feature already has a plan; draft a new revision of it", {
        reason: "feature_has_plan",
        featureId: i.featureId,
        planId: others[0].id,
      });
    }
    throw multiplePlans(data, i.featureId);
  }
  return i.featureId;
}

/** Plans bound to a feature. More than one exists only in old data written before the R2 guard. */
const boundPlans = (data: RoadmapData, featureId: string): Plan[] => data.plans.filter((p) => p.featureId === featureId);

const multiplePlans = (data: RoadmapData, featureId: string) =>
  new DomainError("invalid_input", "the feature has more than one plan", {
    reason: "feature_has_multiple_plans",
    featureId,
    planIds: boundPlans(data, featureId).map((p) => p.id).sort(),
  });

/** Refuses a write to a plan whose feature binds more than one plan. */
function assertSinglePlan(data: RoadmapData, plan: Plan): void {
  if (plan.featureId !== undefined && boundPlans(data, plan.featureId).length > 1) throw multiplePlans(data, plan.featureId);
}

export function createPlanCommands(deps: PlanDeps): PlanCommands {
  const now = deps.now ?? (() => new Date());
  const newId = deps.newId ?? (() => ulid());
  const log = deps.storeOptions?.log ?? ((m: string, e?: unknown) => console.error(m, e));
  const exportLog = (m: string) => log(m);
  const { approvals } = deps;
  const section = deps.projectSection ?? projectSection;

  async function toResult<T>(body: () => Promise<T>): Promise<Result<T>> {
    try {
      return { ok: true, value: await body() };
    } catch (e) {
      if (isDomainError(e)) {
        return { ok: false, error: { code: e.code, message: e.message, ...(e.details !== undefined ? { details: e.details } : {}) } };
      }
      log("decision-roadmap: unexpected plan error", e);
      return { ok: false, error: { code: "internal", message: "Unexpected error; see plugin logs." } };
    }
  }

  async function readOk(store: Store) {
    const read = await store.read();
    if (read.status === "missing") throw new DomainError("store_missing", "No decision roadmap in this project.");
    if (read.status === "invalid") throw new DomainError("store_invalid", read.error.message, read.error);
    return read;
  }

  const findPlan = (data: RoadmapData, planId: string): Plan => {
    const plan = data.plans.find((p) => p.id === planId);
    if (!plan) throw new DomainError("not_found", `plan ${planId} not found`, { planId });
    return plan;
  };

  const latestOf = (plan: Plan): PlanRevision => {
    const latest = plan.revisions.at(-1);
    if (!latest) throw new DomainError("not_found", `plan ${plan.id} has no revision`, { planId: plan.id });
    return latest;
  };

  const verifiedReceipt = (projectId: string, plan: Plan, revision: PlanRevision) => verifiedReceiptFor(approvals, projectId, plan, revision);

  async function approvalOf(projectId: string, data: RoadmapData, plan: Plan) {
    const latest = plan.revisions.at(-1);
    if (!latest) return { status: "unapproved" as const, reasons: [] as string[] };
    const receipt = await verifiedReceipt(projectId, plan, latest);
    const copyOnly = !receipt && plan.approvals.some((c) => c.planRev === latest.rev);
    return currency(data.sessions, plan, receipt, copyOnly, cancelledRefs(data));
  }

  /**
   * Effects of the latest revision's durable approval that the copy transaction has not recorded
   * (derived, never stored): the project copy, and planning a created feature under the same
   * conditions the copy uses. With duplicate bound plans `plan.approve` refuses, so every entry is
   * marked `retryBlocked` and no feature transition is reported.
   */
  async function approvalEffectsPending(projectId: string, data: RoadmapData, plan: Plan): Promise<Pick<PlanView, "approvalEffectsPending">> {
    const latest = plan.revisions.at(-1);
    if (!latest) return {};
    const receipt = await verifiedReceipt(projectId, plan, latest);
    if (!receipt) return {};
    const duplicate = plan.featureId !== undefined && boundPlans(data, plan.featureId).length > 1;
    const pending: NonNullable<PlanView["approvalEffectsPending"]> = [];
    if (!plan.approvals.some((c) => c.receiptId === receipt.receiptId)) {
      pending.push(
        duplicate
          ? { effect: "project_copy", reason: "approval effects cannot be retried while the feature has more than one plan", retryBlocked: "feature_has_multiple_plans" }
          : { effect: "project_copy", reason: `the project copy of approval ${receipt.receiptId} is not recorded` },
      );
    }
    const feature = plan.featureId !== undefined ? data.features.find((f) => f.id === plan.featureId) : undefined;
    if (!duplicate && feature?.status === "created" && isV2Revision(latest) && !isReworked(plan, latest.rev)) {
      pending.push({ effect: "feature_planned", reason: "the feature is still created" });
    }
    return pending.length > 0 ? { approvalEffectsPending: pending } : {};
  }

  const exportFor = (store: Store, planId: string) => syncExport(store, planId, { ...(deps.storeOptions?.fs ? { fs: deps.storeOptions.fs } : {}), log: exportLog });

  return {
    list: (open, i) =>
      toResult(async () => {
        const read = await readOk(await open(i.projectId));
        const plans = [];
        for (const plan of read.data.plans) {
          const approval = await approvalOf(i.projectId, read.data, plan);
          plans.push({
            id: plan.id,
            title: plan.title,
            latestRev: plan.revisions.at(-1)?.rev ?? null,
            approval: approval.status,
            ...(plan.featureId !== undefined ? { featureId: plan.featureId } : {}),
          });
        }
        return { revision: read.revision, plans };
      }),

    get: (open, i) =>
      toResult(async () => {
        const store = await open(i.projectId);
        const read = await readOk(store);
        const plan = findPlan(read.data, i.planId);
        // History: per revision, the authoritative plugin-data receipt (if any) first, then project
        // copies that do not equal it. A copy never replaces or hides a receipt, and get never writes.
        const copies: PlanView["approvals"] = [];
        const listed = new Set<ApprovalReceipt>();
        for (const revision of plan.revisions) {
          const stored = await verifiedReceipt(i.projectId, plan, revision);
          if (stored) copies.push({ receipt: stored, verified: true });
          for (const copy of plan.approvals) {
            if (copy.planRev !== revision.rev) continue;
            listed.add(copy);
            if (stored && sameReceipt(stored, copy)) continue;
            copies.push({ receipt: copy, verified: false });
          }
        }
        for (const copy of plan.approvals) if (!listed.has(copy)) copies.push({ receipt: copy, verified: false });
        const approval = await approvalOf(i.projectId, read.data, plan);
        const { approvals: _a, intents: _i, tickets: _t, ...rest } = plan;
        const exportWritten = await exportFor(store, plan.id);
        return {
          revision: read.revision,
          plan: rest,
          approvals: copies,
          approval: approval.status,
          notCurrentReasons: approval.status === "not_current" ? approval.reasons : [],
          exportWritten,
          blockers: approvalBlockers(plan, blockerContext(read.data)),
          ...reuseCandidates(plan),
          ...(await approvalEffectsPending(i.projectId, read.data, plan)),
        };
      }),

    draft: (open, i, _origin, caller) =>
      toResult(async () => {
        const store = await open(i.projectId);
        const at = now().toISOString();
        const out = await store.transact(i.expectedRevision, (draft) => {
          const cancelled = cancelledRefs(draft);
          const ok = eligibility(draft.sessions, i.sessionIds, cancelled);
          if ("error" in ok) throw ok.error;
          const existing = i.planId !== undefined ? findPlan(draft, i.planId) : undefined;
          const featureId = draftBinding(draft, existing, i);
          // No mid-run edits (design §3.2): a live run freezes the feature's plan until stop-and-rework.
          if (featureId !== undefined && draft.runs.some((r) => r.featureId === featureId && (r.state === "running" || r.state === "paused"))) {
            throw new DomainError("plan_not_current", "revision is executing; stop and send for rework", { featureId });
          }
          const basedOn = basedOnSnapshot(draft.sessions, i.sessionIds, cancelled).map(({ value: _v, ...entry }) => entry);
          const snapshot = decisionSnapshotHash(draft.sessions, i.sessionIds, cancelled);
          // Legacy draft: task ids are allocated before a new plan id, exactly as shipped.
          let legacyTasks: TaskDefinition[] | undefined;
          if (featureId === undefined) {
            legacyTasks = i.tasks.map((t) => ({ id: t.id ?? newId(), title: t.title, description: t.description }));
            if (new Set(legacyTasks.map((t) => t.id)).size !== legacyTasks.length) throw new DomainError("invalid_input", "task ids must be unique");
          }
          let plan: Plan;
          if (existing !== undefined) {
            plan = existing;
          } else {
            plan = { id: newId(), title: i.title, sessionIds: [], revisions: [], approvals: [], taskStates: [], intents: [], tickets: [] };
            draft.plans.push(plan);
          }
          const rev = (plan.revisions.at(-1)?.rev ?? 0) + 1;
          let revision: PlanRevision;
          if (legacyTasks !== undefined) {
            // Legacy draft: exactly the shipped body and hash.
            const body = { markdown: i.markdown, tasks: legacyTasks, basedOn, decisionSnapshotHash: snapshot };
            revision = { rev, createdAt: at, contentHash: contentHash(body), ...body };
          } else {
            // Schema 2 draft: omitted task fields get explicit defaults; the graph is checked before writing.
            const tasks: TaskDefinitionV2[] = i.tasks.map((t) => ({
              id: t.id ?? newId(),
              title: t.title,
              description: t.description,
              dependsOn: t.dependsOn ?? [],
              parallel: t.parallel ?? false,
              completion: t.completion ?? "auto",
              grill: t.grill ?? false,
              dod: t.dod ?? "",
            }));
            const issues = taskGraphIssues(tasks);
            if (issues.length > 0) throw new DomainError("invalid_input", "the task list is not a valid dependency graph", { issues });
            linkGrillingSessions(draft, plan, { featureId: featureId!, planTitle: i.title, tasks, at, newId, ...(caller !== undefined ? { caller } : {}) });
            const body = { markdown: i.markdown, tasks, basedOn, decisionSnapshotHash: snapshot };
            revision = { rev, createdAt: at, schema: 2, contentHash: contentHashV2(body), ...body };
            plan.featureId = featureId;
          }
          plan.revisions.push(revision);
          plan.title = i.title;
          plan.sessionIds = [...i.sessionIds];
          return { planId: plan.id, rev, contentHash: revision.contentHash };
        });
        const exportWritten = await exportFor(store, out.result.planId);
        return { revision: out.revision, ...out.result, exportWritten };
      }),

    approve: (open, i, origin) =>
      toResult(async () => {
        if (origin.source !== "ui") throw new DomainError("invalid_input", "approval only in the Paseo UI");
        const store = await open(i.projectId);
        // R4 final review c0082: the checks, the receipt publication and the copy run in the project's
        // critical section, shared with a cancel's receipt check and transaction. The export and the
        // after-commit hooks run after the section is released.
        const approved = await section(projectSectionKey(store), async () => {
          const read = await readOk(store);
          const plan = findPlan(read.data, i.planId);
          const latest = latestOf(plan);
          if (i.rev !== latest.rev) {
            throw new DomainError("plan_revision_mismatch", `revision ${i.rev} is not the latest (${latest.rev})`, { latestRev: latest.rev });
          }
          assertSinglePlan(read.data, plan);
          if (isReworked(plan, latest.rev)) throw new DomainError("plan_not_current", reworkReason(latest.rev), { reasons: [reworkReason(latest.rev)] });
          // The same DoD and grilling gates plan.get reports.
          const blockers = approvalBlockers(plan, blockerContext(read.data));
          if (blockers.length > 0) throw new DomainError("plan_ineligible", "the revision cannot be approved yet", { blockers });
          if (i.contentHash !== latest.contentHash || contentHashFor(latest) !== latest.contentHash) {
            throw new DomainError("plan_revision_mismatch", "content hash does not match the latest revision", { latestRev: latest.rev });
          }
          const basis = basisCurrent(read.data.sessions, plan.sessionIds, latest, cancelledRefs(read.data));
          if (!basis.ok) {
            throw new DomainError("plan_not_current", `the plan basis changed: ${basis.reasons.join("; ")}`, { reasons: basis.reasons });
          }
          const { created, receipt } = await approvals.write({
            receiptId: newId(),
            projectId: i.projectId,
            planId: plan.id,
            planRev: latest.rev,
            contentHash: latest.contentHash,
            decisionSnapshotHash: latest.decisionSnapshotHash,
            at: now().toISOString(),
            actor: { kind: "human" },
            ...(i.note !== undefined && i.note !== "" ? { note: i.note } : {}),
          });

          // The copy in the project JSON is cosmetic; the plugin-data receipt is the authority.
          let copyRecorded = false;
          let revision: number | null = null;
          let requested: Array<{ featureId: string; agentId: string }> = [];
          for (let attempt = 0; attempt < COPY_RETRIES && !copyRecorded; attempt++) {
            const version = await store.version();
            if (version.status !== "ok" || version.revision === null) break;
            try {
              const committed = await store.transact(version.revision, (draft) => {
                const p = draft.plans.find((x) => x.id === plan.id);
                if (!p) return [];
                if (!p.approvals.some((c) => c.receiptId === receipt.receiptId)) p.approvals.push(receipt);
                // Approving a bound schema 2 revision plans a created feature (design §3.1), but only while
                // the approved revision is still the latest: a draft committed between the receipt and this
                // copy leaves the feature as it is. A retry of the same revision finds it planned already
                // and adds nothing; other statuses keep theirs.
                const latestNow = p.revisions.at(-1);
                const approvedIsLatest =
                  latestNow !== undefined &&
                  isV2Revision(latestNow) &&
                  latestNow.rev === receipt.planRev &&
                  latestNow.contentHash === receipt.contentHash &&
                  latestNow.decisionSnapshotHash === receipt.decisionSnapshotHash &&
                  // A rework committed after the approval's checks supersedes the revision; keep the copy only.
                  !isReworked(p, latestNow.rev);
                const feature = p.featureId !== undefined ? draft.features.find((f) => f.id === p.featureId) : undefined;
                if (feature?.status === "created" && approvedIsLatest) {
                  feature.status = "planned";
                  delete feature.statusReason;
                  feature.events.push({ at: receipt.at, actor: { kind: "human" }, kind: "status", from: "created", to: "planned", reason: "plan approved" });
                }
                // Stage R4.3: the matching replacement approval clears the feature's request and asks every
                // unfinished direct dependent for its own replacement (drafting never clears).
                const out: Array<{ featureId: string; agentId: string }> = [];
                const req = feature?.replacementRequested;
                if (feature && req && approvedIsLatest && replacementCleared(req, receipt)) {
                  delete feature.replacementRequested;
                  for (const c of draft.features) {
                    if (!c.dependsOn.includes(feature.id) || c.status === "done" || c.status === "cancelled" || c.replacementRequested) continue;
                    c.replacementRequested = { at: receipt.at, becauseOf: req.becauseOf, state: c.coordinator ? "requested" : "queued" };
                    c.events.push({ at: receipt.at, actor: { kind: "human" }, kind: "note", reason: `replacement requested after ${feature.title} was approved` });
                    if (c.coordinator) out.push({ featureId: c.id, agentId: c.coordinator.agentId });
                  }
                }
                return out;
              });
              copyRecorded = true;
              revision = committed.revision;
              requested = committed.result ?? [];
            } catch (e) {
              if (!isDomainError(e, "revision_conflict")) {
                log(`plan approval copy not recorded: ${isDomainError(e) ? e.code : e instanceof Error ? e.name : "error"}`);
                break;
              }
            }
          }
          return { planId: plan.id, created, receipt, copyRecorded, revision, requested };
        });
        const { created, receipt, copyRecorded, revision, requested } = approved;
        const exportWritten = await exportFor(store, approved.planId);
        for (const r of requested) deps.afterReplacementRequest?.({ projectId: i.projectId, ...r });
        deps.afterApprove?.(i.projectId);
        return { receiptId: receipt.receiptId, approvedAt: receipt.at, alreadyApproved: !created, copyRecorded, exportWritten, revision };
      }),

    taskUpdate: (open, i, origin) =>
      toResult(async () => {
        const store = await open(i.projectId);
        // Receipts live outside the store; read the one for the addressed revision first.
        const receipt = await approvals.read(i.projectId, i.planId, i.planRev);
        const at = now().toISOString();
        const out = await store.transact(i.expectedRevision, (draft) => {
          const plan = findPlan(draft, i.planId);
          const latest = latestOf(plan);
          if (i.planRev !== latest.rev || i.contentHash !== latest.contentHash) {
            throw new DomainError("plan_revision_mismatch", "the task belongs to another plan revision", { latestRev: latest.rev });
          }
          if (!latest.tasks.some((t) => t.id === i.taskId)) throw new DomainError("not_found", `task ${i.taskId} not found`, { taskId: i.taskId });
          // A run-managed revision is verified only by the completion predicate (and task.accept), never here.
          if (i.status === "verified" && draft.runs.some((r) => r.planId === i.planId && r.planRev === i.planRev)) {
            throw new DomainError("task_transition", "this revision is executed by a run; tasks are verified by its checks and review", {
              planId: i.planId,
              planRev: i.planRev,
            });
          }
          const matching =
            receipt &&
            receipt.planRev === latest.rev &&
            receipt.contentHash === latest.contentHash &&
            receipt.decisionSnapshotHash === latest.decisionSnapshotHash
              ? receipt
              : null;
          const copyOnly = !matching && plan.approvals.some((c) => c.planRev === latest.rev);
          const current = currency(draft.sessions, plan, matching, copyOnly, cancelledRefs(draft)).status === "current";
          const index = plan.taskStates.findIndex((s) => s.planRev === latest.rev && s.taskId === i.taskId);
          const from = index >= 0 ? plan.taskStates[index].status : "todo";
          // Starting work on a revision sent for rework is refused as not current, even for its cancelled tasks.
          if (i.status === "in_progress" && isReworked(plan, latest.rev)) {
            throw new DomainError("plan_not_current", "starting work needs a current approval of the latest revision", { reasons: [reworkReason(latest.rev)] });
          }
          const error = taskTransition(from, i.status, { origin, ...(i.note !== undefined ? { note: i.note } : {}), current });
          if (error) throw error;
          const state = {
            taskId: i.taskId,
            planRev: latest.rev,
            status: i.status,
            ...(i.status === "verified" ? { verification: { at, note: i.note!.trim() } } : {}),
          };
          if (index >= 0) plan.taskStates[index] = state;
          else plan.taskStates.push(state);
        });
        return { revision: out.revision };
      }),

    // Stage R2.3: send the approved latest revision of a bound plan back for rework. The approval
    // must exist (a matching receipt), but it need not be current: a cancelled basis decision is
    // exactly a reason to rework (owner Q33=1).
    rework: (open, i, origin) =>
      toResult(async () => {
        if (origin.source !== "ui") throw new DomainError("invalid_input", "rework only in the Paseo UI");
        const store = await open(i.projectId);
        const receipt = await approvals.read(i.projectId, i.planId, i.planRev);
        const at = now().toISOString();
        const out = await store.transact(i.expectedRevision, (draft) => {
          const plan = findPlan(draft, i.planId);
          if (plan.featureId === undefined) throw new DomainError("invalid_input", "only a plan bound to a feature can be sent for rework");
          assertSinglePlan(draft, plan);
          const latest = latestOf(plan);
          if (i.planRev !== latest.rev) {
            throw new DomainError("plan_revision_mismatch", `revision ${i.planRev} is not the latest (${latest.rev})`, { latestRev: latest.rev });
          }
          if (isReworked(plan, latest.rev)) throw new DomainError("invalid_input", `revision ${latest.rev} was already sent for rework`);
          if (!receiptMatches(receipt, i.projectId, plan, latest)) throw new DomainError("invalid_input", `revision ${latest.rev} is not approved`);
          const feature = draft.features.find((f) => f.id === plan.featureId);
          if (!feature) throw new DomainError("not_found", `feature ${plan.featureId} not found`, { featureId: plan.featureId });
          if (feature.status !== "planned" && feature.status !== "executing") {
            throw new DomainError("invalid_input", `a ${feature.status} feature has no plan to send for rework`, { status: feature.status });
          }
          applyRework(plan, latest, feature, { at, reason: i.reason, actor: { kind: "human" } });
          // A live run on the reworked revision ends in this transaction (card §6.2a).
          return applyRunEffect(draft, feature.id, "rework", at);
        });
        if (out.result) deps.afterRunEffect?.({ projectId: i.projectId, ...out.result });
        return { revision: out.revision };
      }),
  };
}

/**
 * Verified tasks of the plan's reworked revisions, newest revision first, with the title they had
 * in that revision. `verifiedAt` is copied only from a recorded verification. Never applied.
 */
function reuseCandidates(plan: Plan): { reuseCandidates?: NonNullable<PlanView["reuseCandidates"]> } {
  const out: NonNullable<PlanView["reuseCandidates"]> = [];
  const revs = [...new Set((plan.reworks ?? []).map((r) => r.planRev))].sort((a, b) => b - a);
  for (const rev of revs) {
    const revision = plan.revisions.find((r) => r.rev === rev);
    if (!revision) continue;
    for (const task of revision.tasks) {
      const state = plan.taskStates.find((s) => s.planRev === rev && s.taskId === task.id);
      if (state?.status !== "verified") continue;
      out.push({ planRev: rev, taskId: task.id, title: task.title, ...(state.verification ? { verifiedAt: state.verification.at } : {}) });
    }
  }
  return out.length > 0 ? { reuseCandidates: out } : {};
}

/** UI wrapper: a live opener per call and the UI origin, as createRoadmapService does. */
export function createPlanService(deps: PlanDeps): PlanService {
  const commands = createPlanCommands(deps);
  const opener =
    (paseo: PaseoApi): StoreOpener =>
    (projectId) =>
      openProjectStore(deps.directory(paseo), projectId, deps.storeOptions);
  return {
    list: (paseo, i) => commands.list(opener(paseo), i),
    get: (paseo, i) => commands.get(opener(paseo), i),
    draft: (paseo, i) => commands.draft(opener(paseo), i, UI_ORIGIN),
    approve: (paseo, i) => commands.approve(opener(paseo), i, UI_ORIGIN),
    taskUpdate: (paseo, i) => commands.taskUpdate(opener(paseo), i, UI_ORIGIN),
    rework: (paseo, i) => commands.rework(opener(paseo), i, UI_ORIGIN),
  };
}
