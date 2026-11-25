// The relation links of one question card: stored activation and invalidation relations and the
// session links that touch the question, each with its kind, direction and target identity. Pure.
import type { Ref } from "../shared/model";
import type { SessionView } from "../shared/rpc";
import { qLabel } from "./question-number";

/** Where a link leads: a question of this session, a question of another session, a session, or nowhere. */
export type RelationTarget =
  | { kind: "question"; questionId: string }
  | { kind: "ref"; ref: Ref }
  | { kind: "session"; sessionId: string }
  | { kind: "missing" };

export type RelationLink = { key: string; text: string; label: string; target: RelationTarget };

type End = { sessionId: string; questionId?: string };

function describe(view: SessionView, end: End): { short: string; full: string; target: RelationTarget; key: string } {
  const sid = view.session.id;
  if (end.questionId === undefined) {
    const title = end.sessionId === sid ? view.session.title : (view.catalog.find((c) => c.ref.sessionId === end.sessionId)?.sessionTitle ?? end.sessionId);
    const text = `session ${title}`;
    return { short: text, full: text, target: end.sessionId === sid ? { kind: "missing" } : { kind: "session", sessionId: end.sessionId }, key: `s:${end.sessionId}` };
  }
  const key = `q:${end.sessionId}/${end.questionId}`;
  if (end.sessionId === sid) {
    const qv = view.questions.find((x) => x.question.id === end.questionId);
    if (qv !== undefined) return { short: qLabel(qv.number), full: `${qLabel(qv.number)} ${qv.question.title}`, target: { kind: "question", questionId: qv.question.id }, key };
  } else {
    const entry = view.catalog.find((c) => c.ref.sessionId === end.sessionId && c.ref.questionId === end.questionId);
    if (entry !== undefined) {
      const text = `${entry.sessionTitle} / ${entry.questionTitle}`;
      return { short: text, full: text, target: { kind: "ref", ref: { sessionId: end.sessionId, questionId: end.questionId } }, key };
    }
  }
  const missing = "a question that no longer exists";
  return { short: missing, full: missing, target: { kind: "missing" }, key };
}

/**
 * Depends on (activation and invalidation parents), Needed by (dependents within this session only;
 * cross-session dependents are not claimed), Informs / Informed by and Supersedes / Superseded by
 * (stored links touching this question). One entry per kind, direction and target: a parent that both
 * activates and invalidates the question gives two entries marked "(activation)" and "(invalidation)",
 * on either side, and a link from the question to itself is one "Informs" / "Supersedes" entry marked
 * "(itself)".
 */
export function relationLinks(view: SessionView, questionId: string): RelationLink[] {
  const qv = view.questions.find((x) => x.question.id === questionId);
  if (qv === undefined) return [];
  const sid = view.session.id;
  const out: RelationLink[] = [];
  const seen = new Set<string>();
  const add = (verb: string, end: End, note = "") => {
    const d = describe(view, end);
    const key = `${verb}${note}|${d.key}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ key, text: `${verb} ${d.short}${note}`, label: `${verb} ${d.full}${note}`, target: d.target });
  };
  // Activation and invalidation parents share "Depends on" (and their children "Needed by"). One parent
  // may hold both kinds over one question; then each is its own entry, marked with its kind.
  const endKey = (end: End) => `${end.sessionId}/${end.questionId ?? ""}`;
  type Parent = { end: End; kind: "activation" | "invalidation" };
  const parentsOf = (x: (typeof view.questions)[number]): Parent[] => [
    ...x.question.activatedBy.map((a): Parent => ({ end: a.parent, kind: "activation" })),
    ...x.question.invalidatedBy.map((i): Parent => ({ end: i.upstream, kind: "invalidation" })),
  ];
  const kindNote = (all: Parent[], p: Parent) => (all.some((o) => endKey(o.end) === endKey(p.end) && o.kind !== p.kind) ? ` (${p.kind})` : "");
  const own = parentsOf(qv);
  for (const p of own) add("Depends on", p.end, kindNote(own, p));
  for (const x of view.questions) {
    const mine = parentsOf(x).filter((p) => p.end.sessionId === sid && p.end.questionId === questionId);
    for (const p of mine) add("Needed by", { sessionId: sid, questionId: x.question.id }, kindNote(mine, p));
  }
  const isSelf = (end: End) => end.sessionId === sid && end.questionId === questionId;
  for (const l of view.links) {
    const from: End = l.from;
    const to: End = l.to;
    // A stored link from the question to itself (the store accepts one) is one entry, in its own
    // direction, naming the question itself.
    if (isSelf(from) && isSelf(to)) add(l.kind === "informs" ? "Informs" : "Supersedes", to, " (itself)");
    else if (isSelf(from)) add(l.kind === "informs" ? "Informs" : "Supersedes", to);
    else if (isSelf(to)) add(l.kind === "informs" ? "Informed by" : "Superseded by", from);
  }
  return out;
}
