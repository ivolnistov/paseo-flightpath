import { computeVisibility, layoutDepth } from "../shared/graph";
import { refKey, type ContinuationState, type Link, type OutOfScopeMark, type Question, type Ref, type RefKey, type RoadmapData, type Session } from "../shared/model";
import { DomainError } from "../shared/errors";
import type {
  BlockSummaryView,
  CatalogEntry,
  Counts,
  DependentView,
  GrillingStatus,
  GrillingView,
  OutOfScopeEntry,
  Overview,
  QuestionView,
  SessionView,
} from "../shared/rpc";
import { automaticContinuation } from "./continuation-retry";
import { buildBlockSummary } from "./summary";
import { linksOf } from "../shared/links";
import { questionNumber } from "../shared/numbering";
import { childIndex, dependentsOf } from "../shared/dependents";
import { currentAnswer, priorAnswer, questionStatus } from "../shared/status";

const touches = (link: Link, sessionId: string) => link.from.sessionId === sessionId || link.to.sessionId === sessionId;

export function buildOverview(data: RoadmapData, revision: number, disabled: boolean): Overview {
  const visibility = computeVisibility(data.sessions);
  return {
    revision,
    disabled,
    sessions: data.sessions.map((s) => {
      const counts: Counts = { open: 0, answered: 0, stale: 0, skipped: 0, inactive: 0, out_of_scope: 0 };
      for (const q of s.questions) {
        counts[questionStatus(visibility.get(refKey({ sessionId: s.id, questionId: q.id })) ?? "inactive", q.validity)] += 1;
      }
      return { id: s.id, title: s.title, status: s.status, counts };
    }),
    links: data.meta.links,
  };
}

/**
 * The open finish proposal, the session's retry count (omitted when zero) and the last retry of the
 * current operation and planner binding, for the grilling view.
 */
function discussionFields(session: Session): Pick<GrillingView, "finishProposal" | "retryCount" | "lastRetry" | "automatic"> {
  const p = session.finishProposal;
  const retries = session.retries ?? [];
  // The last retry of the current operation and planner binding: a rebind or a new operation starts afresh.
  const c = session.continuation;
  const planner = session.planner;
  const last = retries.filter((r) => r.operationId === c?.operationId && r.agentId === planner?.agentId && r.epoch === planner?.epoch).at(-1);
  return {
    ...(p !== undefined && p.finishedAt === undefined ? { finishProposal: { at: p.at, summary: p.summary, skipped: p.skipped, outOfScope: p.outOfScope } } : {}),
    ...(retries.length > 0 ? { retryCount: retries.length } : {}),
    ...(last !== undefined ? { lastRetry: { id: last.id, at: last.at, state: last.state, ...(last.origin !== undefined ? { origin: last.origin } : {}) } } : {}),
    ...(automaticContinuation(session) !== null ? { automatic: "waiting" as const } : {}),
  };
}

/** Stored continuation state → header status and whether the owner must recover manually. */
const GRILLING_BY_STATE: Record<ContinuationState, [GrillingStatus, boolean]> = {
  awaiting_pause: ["waiting_for_answers", false],
  paused: ["waiting_for_accept", false],
  accepted_awaiting_pause: ["accepted_waiting_for_pause", false],
  resolving: ["answering", false],
  resumed: ["continued", false],
  unknown: ["outcome_unknown", true],
  pause_answered_externally: ["chat_moved_on", true],
  pause_lost: ["pause_lost", true],
  pause_mismatch: ["card_mismatch", true],
  unsupported: ["unsupported", true],
  superseded: ["planner_changed", true],
  needs_manual: ["needs_manual", true],
  complete: ["complete", false],
};

/**
 * The automatic-grilling status of a session that uses blocks (undefined for a legacy session).
 * `epoch` and `plannerAgentId` are the current planner's, even for a continuation of an older epoch.
 */
export function grillingView(session: Session): GrillingView | undefined {
  if (session.blocks === undefined) return undefined;
  const planner = session.planner;
  if (planner === undefined) return { status: "no_planner", manualRecovery: true };
  const plannerFields = { plannerAgentId: planner.agentId, epoch: planner.epoch, ...discussionFields(session) };
  const c = session.continuation;
  if (c === undefined) return { status: "idle", manualRecovery: false, ...plannerFields };
  const [status, manualRecovery] = GRILLING_BY_STATE[c.state];
  return {
    status,
    manualRecovery,
    ...(c.reason !== undefined ? { reason: c.reason } : {}),
    operationId: c.operationId,
    ...plannerFields,
  };
}

export function buildSessionView(data: RoadmapData, revision: number, sessionId: string): SessionView {
  const projectId = data.meta.projectId;
  const session = data.sessions.find((s) => s.id === sessionId);
  if (!session) throw new DomainError("not_found", `session ${sessionId} not found`, { sessionId });
  const visibility = computeVisibility(data.sessions);
  const review = outOfScopeReview(data, visibility);
  const marks = new Map<RefKey, OutOfScopeMark[]>();
  for (const m of data.meta.outOfScopeMarks ?? []) marks.set(refKey(m.ref), [...(marks.get(refKey(m.ref)) ?? []), m]);
  const depth = layoutDepth(data.sessions, sessionId);
  const questions: QuestionView[] = [...session.questions]
    .sort((a, b) => a.order - b.order)
    .map((question) => {
      const key = refKey({ sessionId, questionId: question.id });
      const v = visibility.get(key) ?? "inactive";
      const number = questionNumber(question);
      const current = currentAnswer(question);
      const prior = priorAnswer(question);
      const events = marks.get(key);
      const upstream = review.upstream.get(key);
      return {
        question,
        visibility: v,
        status: questionStatus(v, question.validity),
        depth: depth.get(question.id) ?? 0,
        number,
        links: linksOf({ projectId, sessionId, number }),
        ...(current !== undefined ? { currentAnswer: current } : {}),
        ...(prior !== undefined ? { priorAnswer: prior } : {}),
        ...(events !== undefined ? { outOfScopeEvents: events } : {}),
        ...(question.review !== undefined ? { review: question.review } : {}),
        ...(upstream !== undefined ? { outOfScopeUpstream: upstream } : {}),
      };
    });
  const catalog: CatalogEntry[] = data.sessions.flatMap((s) =>
    s.questions.map((q) => {
      const ref = { sessionId: s.id, questionId: q.id };
      return {
        ref,
        sessionTitle: s.title,
        questionTitle: q.title,
        options: q.options,
        status: questionStatus(visibility.get(refKey(ref)) ?? "inactive", q.validity),
      };
    }),
  );
  const { questions: _omit, ...meta } = session;
  void _omit;
  const children = childIndex(data.sessions);
  const cancellations = (data.meta.cancellations ?? [])
    .filter((c) => c.ref.sessionId === sessionId)
    .map((c) => ({ ...c, dependents: dependentsOf(data.sessions, c.ref, children).map((d) => dependentView(data, visibility, d)) }));
  const grilling = grillingView(session);
  const blocks = blockSummaries(data, session);
  return {
    revision,
    session: meta,
    cancellations,
    questions,
    links: data.meta.links.filter((l) => touches(l, sessionId)),
    catalog,
    ...(grilling !== undefined ? { grilling } : {}),
    outOfScope: review.entries.filter((e) => e.ref.sessionId === sessionId),
    ...blocks,
  };
}

function dependentView(data: RoadmapData, visibility: Map<RefKey, "active" | "inactive">, ref: Ref): DependentView {
  const q = data.sessions.find((s) => s.id === ref.sessionId)!.questions.find((x) => x.id === ref.questionId)!;
  return { ref, number: questionNumber(q), status: questionStatus(visibility.get(refKey(ref)) ?? "inactive", q.validity) };
}

/**
 * For a session with blocks: every accepted block's summary at acceptance beside the current one,
 * and a preview of the open block. The snapshot is the one stored on the block, else the summary its
 * grilling operation carried; without either nothing is reported as changed.
 */
function blockSummaries(data: RoadmapData, session: Session): Pick<SessionView, "summaries" | "openBlockPreview"> {
  if (session.blocks === undefined) return {};
  const carried = new Map<string, string>();
  for (const c of [...(session.continuations ?? []), ...(session.continuation !== undefined ? [session.continuation] : [])]) {
    if (c.acceptedBlockId !== undefined && c.summary !== undefined) carried.set(c.acceptedBlockId, c.summary);
  }
  const summaries: BlockSummaryView[] = [];
  let openBlockPreview: string | undefined;
  for (const b of [...session.blocks].sort((x, y) => x.order - y.order)) {
    const current = buildBlockSummary(data, session.id, b.id);
    if (b.state === "open") {
      openBlockPreview = current;
      continue;
    }
    const accepted = b.summary ?? carried.get(b.id);
    if (accepted === undefined) {
      summaries.push({ blockId: b.id, acceptedSummary: "", currentSummary: current, changedSinceAcceptance: false, changed: [], noSnapshot: true });
      continue;
    }
    const numbers = session.questions.filter((q) => q.blockId === b.id).sort((x, y) => x.order - y.order).map(questionNumber);
    const before = summaryEntries(accepted, numbers);
    const now = summaryEntries(current, numbers);
    const changed = [...new Set([...before.keys(), ...now.keys()])].filter((n) => before.get(n) !== now.get(n)).sort((x, y) => x - y);
    summaries.push({ blockId: b.id, acceptedSummary: accepted, currentSummary: current, changedSinceAcceptance: changed.length > 0, changed });
  }
  return { summaries, ...(openBlockPreview !== undefined ? { openBlockPreview } : {}) };
}

/**
 * The per-question entries of a block summary keyed by session number, with indented free-text lines
 * included. Summaries written before session numbering use `q<i>` for the i-th question of the block,
 * which `blockNumbers` maps to session numbers.
 */
function summaryEntries(text: string, blockNumbers: number[]): Map<number, string> {
  const entries = new Map<number, string>();
  let current: number | undefined;
  for (const line of text.split("\n")) {
    const m = /^([Qq])(\d+)(?=[ :])(.*)$/.exec(line);
    if (m !== null) {
      const n = m[1] === "Q" ? Number(m[2]) : blockNumbers[Number(m[2]) - 1];
      current = n;
      if (n !== undefined) entries.set(n, m[3]);
      continue;
    }
    if (current !== undefined && line.startsWith("  ")) entries.set(current, `${entries.get(current)}\n${line}`);
    else current = undefined;
  }
  return entries;
}

/**
 * Every out-of-scope question with its dependents (activation children and invalidation downstream,
 * transitively, across sessions), and for each dependent the out-of-scope questions it depends on.
 * The listing is derived on read and cancels nothing; the staleness and review markers it reflects
 * were written when the question went out of scope.
 */
function outOfScopeReview(
  data: RoadmapData,
  visibility: Map<RefKey, "active" | "inactive">,
): { entries: OutOfScopeEntry[]; upstream: Map<RefKey, Array<{ ref: Ref; number: number }>> } {
  const questions = new Map<RefKey, Question>();
  for (const s of data.sessions) for (const q of s.questions) questions.set(refKey({ sessionId: s.id, questionId: q.id }), q);
  const entries: OutOfScopeEntry[] = [];
  const upstream = new Map<RefKey, Array<{ ref: Ref; number: number }>>();
  let children: ReturnType<typeof childIndex> | undefined;
  for (const s of data.sessions) {
    for (const q of [...s.questions].sort((a, b) => questionNumber(a) - questionNumber(b))) {
      if (q.validity !== "out_of_scope") continue;
      children ??= childIndex(data.sessions);
      const ref = { sessionId: s.id, questionId: q.id };
      const number = questionNumber(q);
      const dependents = dependentsOf(data.sessions, ref, children).map((d) => {
        const key = refKey(d);
        const dq = questions.get(key)!;
        upstream.set(key, [...(upstream.get(key) ?? []), { ref, number }]);
        return { ref: d, number: questionNumber(dq), status: questionStatus(visibility.get(key) ?? "inactive", dq.validity) };
      });
      entries.push({ ref, number, dependents });
    }
  }
  return { entries, upstream };
}
