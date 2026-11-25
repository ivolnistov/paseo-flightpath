// Plan hashes (Stage 3 ruling 2). The basis is the active branch of the plan's sessions (R2):
// every currently active question, sorted by ref, visibility computed over the complete graph.
import { canonicalJson } from "../shared/canonical";
import { computeVisibility } from "../shared/graph";
import { isV2Revision, refKey, type Cancellation, type PlanRevision, type PlanRevisionV2, type Ref, type RefKey, type Session } from "../shared/model";
import { sha256Hex } from "./hash";

export type BasisEntry = PlanRevision["basedOn"][number];
export type SnapshotEntry = BasisEntry & { value: { optionId?: string; text?: string } };

const byRef = (a: Ref, b: Ref) => {
  const x = refKey(a);
  const y = refKey(b);
  return x < y ? -1 : x > y ? 1 : 0;
};

/** Refs of explicitly cancelled decisions (owner Q33=1). Empty for a v1 meta, which has no `cancellations`. */
export function cancelledRefs(data: { meta: { cancellations?: readonly Cancellation[] } }): ReadonlySet<RefKey> {
  return new Set((data.meta.cancellations ?? []).map((c) => refKey(c.ref)));
}

/**
 * Active questions of `sessionIds`, sorted by refKey, without cancelled decisions. Unknown session
 * ids contribute nothing. Visibility stays computed over the full graph: a cancelled question keeps
 * its visibility and its effect on children; it only leaves the basis.
 */
export function activeBasis(sessions: Session[], sessionIds: string[], cancelled: ReadonlySet<RefKey> = new Set()): Ref[] {
  const visibility = computeVisibility(sessions);
  const wanted = new Set(sessionIds);
  const out: Ref[] = [];
  for (const s of sessions) {
    if (!wanted.has(s.id)) continue;
    for (const q of s.questions) {
      const ref = { sessionId: s.id, questionId: q.id };
      if (visibility.get(refKey(ref)) === "active" && !cancelled.has(refKey(ref))) out.push(ref);
    }
  }
  return out.sort(byRef);
}

/**
 * One entry per active basis question. An active question without an answer is represented as
 * `answerRev: 0` and `value: {}`. That is not an answer revision; it only lets currency notice a
 * newly active unanswered question. Eligibility refuses to draft while such a question exists.
 */
export function basedOnSnapshot(sessions: Session[], sessionIds: string[], cancelled: ReadonlySet<RefKey> = new Set()): SnapshotEntry[] {
  const questions = new Map(sessions.flatMap((s) => s.questions.map((q) => [refKey({ sessionId: s.id, questionId: q.id }), q] as const)));
  return activeBasis(sessions, sessionIds, cancelled).map((ref) => {
    const q = questions.get(refKey(ref))!;
    const answer = q.answer;
    return {
      sessionId: ref.sessionId,
      questionId: ref.questionId,
      answerRev: answer?.rev ?? 0,
      definitionRev: q.definitionRev,
      validity: q.validity,
      value: answer
        ? {
            ...(answer.optionId !== undefined ? { optionId: answer.optionId } : {}),
            ...(answer.text !== undefined ? { text: answer.text } : {}),
          }
        : {},
    };
  });
}

export function decisionSnapshotHash(sessions: Session[], sessionIds: string[], cancelled: ReadonlySet<RefKey> = new Set()): string {
  return sha256Hex(canonicalJson(basedOnSnapshot(sessions, sessionIds, cancelled)));
}

/** sha256 of exactly `{ markdown, tasks, basedOn, decisionSnapshotHash }`; other fields are ignored. */
export function contentHash(rev: Pick<PlanRevision, "markdown" | "tasks" | "basedOn" | "decisionSnapshotHash">): string {
  return sha256Hex(
    canonicalJson({
      markdown: rev.markdown,
      tasks: rev.tasks,
      basedOn: rev.basedOn,
      decisionSnapshotHash: rev.decisionSnapshotHash,
    }),
  );
}

/**
 * Schema 2 revision hash: sha256 of exactly `{ schema: 2, markdown, tasks, basedOn,
 * decisionSnapshotHash }`. The `schema` member separates it from the v1 hash domain.
 */
export function contentHashV2(rev: Pick<PlanRevisionV2, "markdown" | "tasks" | "basedOn" | "decisionSnapshotHash">): string {
  return sha256Hex(
    canonicalJson({
      schema: 2,
      markdown: rev.markdown,
      tasks: rev.tasks,
      basedOn: rev.basedOn,
      decisionSnapshotHash: rev.decisionSnapshotHash,
    }),
  );
}

/** The hash matching the revision's schema: v1 when `schema` is absent, v2 when it is 2. */
export function contentHashFor(rev: PlanRevision): string {
  return isV2Revision(rev) ? contentHashV2(rev) : contentHash(rev);
}
