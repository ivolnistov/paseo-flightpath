// The plain-text summary of an accepted grilling block (PLAN §1 and §3.6, TR18). It answers the
// planner's pause card and is built from the store only; the chat is never parsed back.
import { DomainError } from "../shared/errors";
import { computeVisibility } from "../shared/graph";
import { childIndex, dependentsOf } from "../shared/dependents";
import { refKey, type Ref, type RoadmapData } from "../shared/model";
import { questionNumber } from "../shared/numbering";

export const SUMMARY_LEGEND =
  '(Q<n> = the question\'s stable number in this session; the value is the 1-based position of the chosen option in that question\'s option list, or the quoted option id when that option was removed; "text:" lines are the owner\'s free text verbatim, indented; (default) = the owner accepted the preselected recommended option; skipped = the owner deliberately left the question unanswered: do not insist, ask it again only when new information makes it necessary; out of scope = the owner excluded the question; unanswered = no answer was given; (stale) = the answer predates a change it depends on; (review) = the owner\'s skipped or out-of-scope outcome is kept, but a question it depends on changed since: ask the owner whether it still holds; (cancelled) = the decision was cancelled; a "Cancelled:" line names the decisions that depend on a cancelled one, which you should cancel or re-ask; hidden questions are omitted. Canonical answers, history and links stay in the roadmap store: read roadmap_get_session for details.)';

/**
 * Header, one entry per active question of the block in panel order (`order`, stable), each under
 * its session number `Q<n>`, then a `Cancelled:` line per cancelled decision of the session that
 * still has uncancelled dependents, then the legend. `skipped` and `out of scope` win over a
 * retained answer; an option answer is its 1-based position in the current option list; free text
 * follows `Q<n> text:` with each line indented by two spaces; `(default)`, `(stale)`, `(review)`
 * and `(cancelled)` mark the value.
 */
export function buildBlockSummary(data: RoadmapData, sessionId: string, blockId: string): string {
  const session = data.sessions.find((s) => s.id === sessionId);
  const block = session?.blocks?.find((b) => b.id === blockId);
  if (session === undefined || block === undefined) {
    throw new DomainError("not_found", `block ${blockId} of session ${sessionId} not found`, { sessionId, blockId });
  }
  const visibility = computeVisibility(data.sessions);
  const cancelled = new Set((data.meta.cancellations ?? []).map((c) => refKey(c.ref)));
  const lines = [`Decision Roadmap: block ${block.order + 1} accepted (session ${JSON.stringify(session.title)}, block ${JSON.stringify(blockId)})`];
  const questions = session.questions.filter((q) => q.blockId === blockId).sort((a, b) => a.order - b.order);
  for (const q of questions) {
    const n = questionNumber(q);
    const key = refKey({ sessionId, questionId: q.id });
    if (visibility.get(key) !== "active") continue;
    const answer = q.answer;
    const defaulted = answer?.defaulted === true && answer.optionId !== undefined && answer.optionId === q.recommendedOptionId;
    const marks = `${defaulted && q.validity === "valid" ? " (default)" : ""}${q.validity === "stale" ? " (stale)" : ""}${q.review !== undefined ? " (review)" : ""}${cancelled.has(key) ? " (cancelled)" : ""}`;
    if (q.validity === "skipped") {
      lines.push(`Q${n} skipped${marks}`);
    } else if (q.validity === "out_of_scope") {
      lines.push(`Q${n} out of scope${marks}`);
    } else if (answer === undefined) {
      lines.push(`Q${n} unanswered${marks}`);
    } else if (answer.text !== undefined) {
      lines.push(`Q${n} text${marks}:`, ...answer.text.split(/\r?\n/).map((line) => `  ${line}`));
    } else {
      const position = q.options.findIndex((o) => o.id === answer.optionId);
      lines.push(`Q${n} ${position >= 0 ? String(position + 1) : JSON.stringify(answer.optionId)}${marks}`);
    }
  }
  lines.push(...cancelledLines(data, sessionId, cancelled));
  lines.push(SUMMARY_LEGEND);
  return lines.join("\n");
}

/** `Cancelled: Q<k> (<reason>) -> dependents …: cancel or re-ask them` for the session's cancelled decisions. */
function cancelledLines(data: RoadmapData, sessionId: string, cancelled: ReadonlySet<string>): string[] {
  const out: string[] = [];
  let children: ReturnType<typeof childIndex> | undefined;
  const label = (ref: Ref): string => {
    const s = data.sessions.find((x) => x.id === ref.sessionId);
    const q = s?.questions.find((x) => x.id === ref.questionId);
    const n = q !== undefined ? `Q${questionNumber(q)}` : JSON.stringify(ref.questionId);
    return ref.sessionId === sessionId ? n : `${n} of session ${JSON.stringify(s?.title ?? ref.sessionId)}`;
  };
  for (const c of data.meta.cancellations ?? []) {
    if (c.ref.sessionId !== sessionId) continue;
    children ??= childIndex(data.sessions);
    const open = dependentsOf(data.sessions, c.ref, children).filter((d) => !cancelled.has(refKey(d)));
    if (open.length === 0) continue;
    out.push(`Cancelled: ${label(c.ref)} (${c.reason}) -> dependents ${open.map(label).join(", ")}: cancel or re-ask them`);
  }
  return out;
}
