// Start delegations (Stage R3.1): a scoped, revocable human delegation recorded from chat (R3.4)
// lets ready features start without a click. Revocation stops new starts only.
import type { DelegationProvenance, RoadmapData, StartDelegation } from "../shared/model";
import { isV2Revision } from "../shared/model";
import { cancelledRefs } from "./plan-hash";
import { basisCurrent, isReworked } from "./plan-rules";

/** The latest unrevoked delegation covering the feature (its own feature scope, or the roadmap). */
export function coveringDelegation(data: RoadmapData, featureId: string): StartDelegation | undefined {
  for (let i = data.delegations.length - 1; i >= 0; i--) {
    const d = data.delegations[i];
    if (d.revokedAt === undefined && (d.scope === "roadmap" || d.featureId === featureId)) return d;
  }
  return undefined;
}

/** Appends a delegation inside the caller's store transaction and returns it. */
export function recordDelegation(
  draft: RoadmapData,
  x: { id: string; scope: "feature" | "roadmap"; featureId?: string; provenance: DelegationProvenance; at: string },
): StartDelegation {
  const delegation: StartDelegation = {
    id: x.id,
    scope: x.scope,
    ...(x.scope === "feature" && x.featureId !== undefined ? { featureId: x.featureId } : {}),
    provenance: x.provenance,
    grantedAt: x.at,
  };
  draft.delegations.push(delegation);
  return delegation;
}

/**
 * Candidate features for a delegated start: planned, with a project approval copy matching the
 * latest revision of their single bound plan, a current basis, a covering delegation and no live
 * run. This is a prefilter on stored data only: the copy is not the authority, so every start
 * still verifies the durable approval receipt and currency (`run.start`).
 */
export function delegatedStarts(data: RoadmapData): string[] {
  const cancelled = cancelledRefs(data);
  const out: string[] = [];
  for (const feature of data.features) {
    if (feature.status !== "planned") continue;
    if (data.runs.some((r) => r.featureId === feature.id && r.state !== "ended")) continue;
    if (!coveringDelegation(data, feature.id)) continue;
    const plans = data.plans.filter((p) => p.featureId === feature.id);
    if (plans.length !== 1) continue;
    const plan = plans[0];
    const latest = plan.revisions.at(-1);
    if (!latest || !isV2Revision(latest) || isReworked(plan, latest.rev)) continue;
    const copied = plan.approvals.some(
      (c) => c.planRev === latest.rev && c.contentHash === latest.contentHash && c.decisionSnapshotHash === latest.decisionSnapshotHash,
    );
    if (!copied || !basisCurrent(data.sessions, plan.sessionIds, latest, cancelled).ok) continue;
    out.push(feature.id);
  }
  return out;
}
