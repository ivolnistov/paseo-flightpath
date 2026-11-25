// Pure plan rules (Stage 3 P3.2, owner rulings R1/R2): draft eligibility, basis currency,
// approval currency and task transitions. Visibility is always computed over the full graph.
import { DomainError } from "../shared/errors";
import { isV2Revision, refKey, type ApprovalReceipt, type Feature, type Plan, type PlanRevision, type Ref, type RefKey, type Session, type TaskState } from "../shared/model";
import type { ApprovalBlocker, ApprovalStatus } from "../shared/rpc";
import { activeBasis, basedOnSnapshot, contentHashFor, decisionSnapshotHash } from "./plan-hash";
import type { WriteOrigin } from "./sessions";

export type Currency = { status: ApprovalStatus; reasons: string[] };
type TaskStatus = TaskState["status"];

const skippedReason = (key: string) => `${key} is skipped; answer it and draft a new revision`;

/** `cancelled` (owner Q33=1): cancelled decisions are excluded from a new basis; the rules are unchanged. */
export function eligibility(sessions: Session[], sessionIds: string[], cancelled: ReadonlySet<RefKey> = new Set()): { basis: Ref[] } | { error: DomainError } {
  const known = new Set(sessions.map((s) => s.id));
  const unknown = sessionIds.filter((id) => !known.has(id));
  if (unknown.length > 0) return { error: new DomainError("not_found", `unknown session: ${unknown.join(", ")}`, { sessionIds: unknown }) };
  const basis = activeBasis(sessions, sessionIds, cancelled);
  if (basis.length === 0) {
    return { error: new DomainError("plan_ineligible", "no active questions", { refs: [], reasons: ["no active questions"] }) };
  }
  const snapshot = basedOnSnapshot(sessions, sessionIds, cancelled);
  const refs: Ref[] = [];
  const reasons: string[] = [];
  for (const entry of snapshot) {
    if (entry.validity === "valid" || entry.validity === "skipped") continue;
    const ref = { sessionId: entry.sessionId, questionId: entry.questionId };
    refs.push(ref);
    reasons.push(`${refKey(ref)} is ${entry.validity === "unanswered" ? "unanswered" : entry.validity}`);
  }
  if (refs.length > 0) {
    return { error: new DomainError("plan_ineligible", `the plan basis is not decided: ${reasons.join("; ")}`, { refs, reasons }) };
  }
  return { basis };
}

/**
 * Whether a revision's basis still matches the store; independent of any receipt (ruling 6). A
 * cancelled `basedOn` decision (owner Q33=1) is reported as cancelled, not as no longer active.
 */
export function basisCurrent(
  sessions: Session[],
  sessionIds: string[],
  revision: PlanRevision,
  cancelled: ReadonlySet<RefKey> = new Set(),
): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (contentHashFor(revision) !== revision.contentHash) reasons.push("content hash does not match the revision");

  const now = new Map(basedOnSnapshot(sessions, sessionIds, cancelled).map((e) => [refKey(e), e] as const));
  const recorded = new Map(revision.basedOn.map((e) => [refKey(e), e] as const));
  for (const key of now.keys()) if (!recorded.has(key)) reasons.push(`${key} became active`);
  for (const [key, entry] of recorded) {
    if (cancelled.has(key)) {
      reasons.push(`${key} was cancelled`);
      continue;
    }
    const current = now.get(key);
    if (!current) {
      reasons.push(`${key} is no longer active`);
      continue;
    }
    if (current.answerRev !== entry.answerRev) reasons.push(`${key} answer rev ${entry.answerRev} → ${current.answerRev}`);
    if (current.definitionRev !== entry.definitionRev) reasons.push(`${key} definition rev ${entry.definitionRev} → ${current.definitionRev}`);
    if (current.validity !== entry.validity && current.validity !== "skipped" && entry.validity !== "skipped") {
      reasons.push(`${key} is ${current.validity}`);
    }
    if (entry.validity === "skipped" || current.validity === "skipped") reasons.push(skippedReason(key));
  }
  if (decisionSnapshotHash(sessions, sessionIds, cancelled) !== revision.decisionSnapshotHash && reasons.length === 0) {
    reasons.push("decision snapshot changed");
  }
  return { ok: reasons.length === 0, reasons };
}

/** Whether a revision of the plan was sent for rework (it is then superseded). */
export const isReworked = (plan: Plan, rev: number): boolean => (plan.reworks ?? []).some((r) => r.planRev === rev);
export const reworkReason = (rev: number) => `revision ${rev} was sent for rework`;

/**
 * Approval state of the plan's latest revision. `receipt` is the verified plugin-data receipt for
 * that revision, if any; `copyOnly` means the project JSON holds a copy without one.
 */
export function currency(
  sessions: Session[],
  plan: Plan,
  receipt: ApprovalReceipt | null,
  copyOnly: boolean,
  cancelled: ReadonlySet<RefKey> = new Set(),
): Currency {
  const latest = plan.revisions.at(-1);
  if (!latest) return { status: "unapproved", reasons: [] };
  // A revision sent for rework is superseded, whatever its receipt says (Stage R2.3).
  if (isReworked(plan, latest.rev)) return { status: "not_current", reasons: [reworkReason(latest.rev)] };
  if (!receipt) return { status: copyOnly ? "unverified" : "unapproved", reasons: [] };
  if (
    receipt.planId !== plan.id ||
    receipt.planRev !== latest.rev ||
    receipt.contentHash !== latest.contentHash ||
    receipt.decisionSnapshotHash !== latest.decisionSnapshotHash
  ) {
    return { status: "not_current", reasons: ["the approval was given for different plan content"] };
  }
  const basis = basisCurrent(sessions, plan.sessionIds, latest, cancelled);
  return basis.ok ? { status: "current", reasons: [] } : { status: "not_current", reasons: basis.reasons };
}

/**
 * Whether a grilling session is complete (Stage R2 card §1.2): it has at least one active question
 * that is not cancelled, and every such question is answered and not stale. Visibility is computed
 * over all sessions, since another session may activate a question here. Skipped, unanswered and
 * stale questions keep it incomplete; block acceptance is not required, as one block is always open.
 */
export function grillingComplete(sessions: Session[], sessionId: string | undefined, cancelled: ReadonlySet<RefKey> = new Set()): boolean {
  if (sessionId === undefined || !sessions.some((s) => s.id === sessionId)) return false;
  const entries = basedOnSnapshot(sessions, [sessionId], cancelled);
  return entries.length > 0 && entries.every((e) => e.validity === "valid");
}

export type BlockerContext = { features: Feature[]; sessions: Session[]; cancelled: ReadonlySet<RefKey> };

/**
 * Why the latest revision cannot be approved. A legacy revision keeps the shipped rules (none),
 * except in a bound plan. A schema 2 revision needs a DoD on every task and complete grilling of
 * the feature (bound, not a bug), the plan and every task with `grill`. plan.get and plan.approve
 * both use this, so the UI disable and the server rejection cannot diverge.
 */
export function approvalBlockers(plan: Plan, ctx: BlockerContext): ApprovalBlocker[] {
  const latest = plan.revisions.at(-1);
  if (latest === undefined) return [];
  if (!isV2Revision(latest)) return plan.featureId === undefined ? [] : [{ code: "legacy_revision" }];
  let feature: Feature | undefined;
  if (plan.featureId !== undefined) {
    feature = ctx.features.find((f) => f.id === plan.featureId);
    if (!feature) throw new DomainError("not_found", `feature ${plan.featureId} not found`, { featureId: plan.featureId });
  }
  const done = (sessionId: string | undefined) => grillingComplete(ctx.sessions, sessionId, ctx.cancelled);
  const linked = (sessionId: string | undefined) => (sessionId !== undefined ? { sessionId } : {});
  const out: ApprovalBlocker[] = [];
  for (const t of latest.tasks) if (t.dod.trim() === "") out.push({ code: "dod_missing", taskId: t.id });
  if (feature !== undefined && feature.kind !== "bug" && !done(feature.grillSessionId)) {
    out.push({ code: "grilling_required", ...linked(feature.grillSessionId) });
  }
  if (!done(plan.grillSessionId)) out.push({ code: "grilling_required", ...linked(plan.grillSessionId) });
  for (const t of latest.tasks) {
    if (t.grill && !done(t.grillSessionId)) out.push({ code: "grilling_required", taskId: t.id, ...linked(t.grillSessionId) });
  }
  return out;
}

const EDGES = new Set(["todo>in_progress", "in_progress>done", "in_progress>todo", "done>verified", "done>in_progress"]);

export function taskTransition(
  from: TaskStatus,
  to: TaskStatus,
  ctx: { origin: WriteOrigin; note?: string; current: boolean },
): DomainError | null {
  if (!EDGES.has(`${from}>${to}`)) return new DomainError("task_transition", `a task cannot move from ${from} to ${to}`, { from, to });
  if (ctx.origin.source !== "ui" && to !== "in_progress" && to !== "done") {
    return new DomainError("task_transition", "agents may only move tasks to in_progress or done", { from, to });
  }
  if (to === "in_progress" && !ctx.current) {
    return new DomainError("plan_not_current", "starting work needs a current approval of the latest revision");
  }
  if (to === "verified" && (ctx.origin.source !== "ui" || !ctx.note?.trim())) {
    return new DomainError("invalid_input", "verification happens in the Paseo UI and needs a note");
  }
  return null;
}
