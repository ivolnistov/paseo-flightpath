// Pure layout helpers for the roadmap view. Imports only shared modules (no React Native).
import { refKey, type Ref } from "../shared/model";
import type { QuestionView, RpcError, SessionView } from "../shared/rpc";

const MAX_INDENT = 4;

export function columnsByDepth(qs: QuestionView[]): QuestionView[][] {
  const columns: QuestionView[][] = [];
  for (const qv of qs) (columns[qv.depth] ??= []).push(qv);
  return Array.from(columns, (c) => (c ?? []).sort((a, b) => a.question.order - b.question.order));
}

export type CompactRow = { question: QuestionView; indent: number };

/**
 * DFS from roots by order; each question appears once, after its deepest in-session parent.
 * Pass `sessionId` so a parent in another session with a colliding question id is not mistaken
 * for a local one; without it, any parent whose id is in `qs` counts as local.
 */
export function compactRows(qs: QuestionView[], sessionId?: string): CompactRow[] {
  const byId = new Map(qs.map((qv) => [qv.question.id, qv]));
  const local = (parent: Ref) => (sessionId === undefined || parent.sessionId === sessionId) && byId.has(parent.questionId);
  const parentsIn = (qv: QuestionView): QuestionView[] =>
    [...qv.question.activatedBy.map((a) => a.parent), ...qv.question.invalidatedBy.map((i) => i.upstream)]
      .filter(local)
      .map((p) => byId.get(p.questionId))
      .filter((p): p is QuestionView => p !== undefined);
  // The "home" parent is the deepest in-session parent; the question is listed under it.
  const children = new Map<string, QuestionView[]>();
  const roots: QuestionView[] = [];
  for (const qv of qs) {
    const parents = parentsIn(qv);
    if (parents.length === 0) {
      roots.push(qv);
      continue;
    }
    const home = parents.reduce((a, b) => (b.depth > a.depth || (b.depth === a.depth && b.question.order > a.question.order) ? b : a));
    children.set(home.question.id, [...(children.get(home.question.id) ?? []), qv]);
  }
  const byOrder = (a: QuestionView, b: QuestionView) => a.question.order - b.question.order;
  const out: CompactRow[] = [];
  const seen = new Set<string>();
  const visit = (qv: QuestionView) => {
    if (seen.has(qv.question.id)) return;
    seen.add(qv.question.id);
    out.push({ question: qv, indent: Math.min(qv.depth, MAX_INDENT) });
    for (const child of [...(children.get(qv.question.id) ?? [])].sort(byOrder)) visit(child);
  };
  for (const root of [...roots].sort(byOrder)) visit(root);
  // Questions whose parents live only in other sessions but are not roots here are still listed.
  for (const qv of [...qs].sort(byOrder)) visit(qv);
  return out;
}

export type RelationLine = { kind: "activation" | "invalidation" | "link"; text: string; external: boolean };

const MISSING = "<missing question>";

function titleOf(view: SessionView, ref: Ref): { text: string; external: boolean; options: Map<string, string> } {
  const entry = view.catalog.find((c) => c.ref.sessionId === ref.sessionId && c.ref.questionId === ref.questionId);
  if (!entry) return { text: MISSING, external: ref.sessionId !== view.session.id, options: new Map() };
  const external = ref.sessionId !== view.session.id;
  return {
    text: external ? `${entry.sessionTitle} / ${entry.questionTitle}` : entry.questionTitle,
    external,
    options: new Map(entry.options.map((o) => [o.id, o.label])),
  };
}

function linkEndTitle(view: SessionView, end: { sessionId: string; questionId?: string }): string {
  if (end.questionId !== undefined) return titleOf(view, { sessionId: end.sessionId, questionId: end.questionId }).text;
  return view.catalog.find((c) => c.ref.sessionId === end.sessionId)?.sessionTitle ?? (end.sessionId === view.session.id ? view.session.title : "<missing session>");
}

export function relationLines(q: QuestionView, view: SessionView): RelationLine[] {
  const lines: RelationLine[] = [];
  for (const a of q.question.activatedBy) {
    const parent = titleOf(view, a.parent);
    const labels = a.optionIds.map((id) => parent.options.get(id) ?? id).join(" or ");
    lines.push({ kind: "activation", text: `Active when ${parent.text} = ${labels}`, external: parent.external });
  }
  for (const i of q.question.invalidatedBy) {
    const parent = titleOf(view, i.upstream);
    lines.push({ kind: "invalidation", text: `Invalidated by ${parent.text}`, external: parent.external });
  }
  const self = { sessionId: view.session.id, questionId: q.question.id };
  for (const link of view.links) {
    const fromSelf = "questionId" in link.from && refKey(link.from) === refKey(self);
    const toSelf = "questionId" in link.to && refKey(link.to) === refKey(self);
    if (!fromSelf && !toSelf) continue;
    const other = fromSelf ? link.to : link.from;
    lines.push({
      kind: "link",
      text: `Linked: ${link.kind} ${linkEndTitle(view, other)}`,
      external: other.sessionId !== view.session.id,
    });
  }
  return lines;
}

export type ColumnEdge = { from: Ref; to: Ref; kind: "activation" | "invalidation"; label: string };

/** Edges whose child is at depth+1 and parent at depth, within this session. */
export function edgesBetween(view: SessionView, depth: number): ColumnEdge[] {
  const sid = view.session.id;
  const atDepth = new Map(view.questions.map((qv) => [qv.question.id, qv]));
  const edges: ColumnEdge[] = [];
  for (const child of view.questions) {
    if (child.depth !== depth + 1) continue;
    const to = { sessionId: sid, questionId: child.question.id };
    for (const a of child.question.activatedBy) {
      const parent = a.parent.sessionId === sid ? atDepth.get(a.parent.questionId) : undefined;
      if (!parent || parent.depth !== depth) continue;
      const labels = new Map(parent.question.options.map((o) => [o.id, o.label]));
      edges.push({ from: a.parent, to, kind: "activation", label: a.optionIds.map((id) => labels.get(id) ?? id).join(" or ") });
    }
    for (const i of child.question.invalidatedBy) {
      const parent = i.upstream.sessionId === sid ? atDepth.get(i.upstream.questionId) : undefined;
      if (!parent || parent.depth !== depth) continue;
      edges.push({ from: i.upstream, to, kind: "invalidation", label: "invalidates" });
    }
  }
  return edges;
}

/**
 * Why the question must be reviewed: its staleness cause, or for a skipped or out-of-scope question
 * that kept its outcome, the change behind its review marker.
 */
export function staleCauseText(q: QuestionView, view: SessionView): string | null {
  const stale = q.question.validity === "stale" ? q.question.stale : undefined;
  const review = q.question.validity === "skipped" || q.question.validity === "out_of_scope" ? q.question.review : undefined;
  const marker = stale ?? review;
  if (marker === undefined) return null;
  const cause = view.catalog.find((c) => c.ref.sessionId === marker.causeSessionId && c.ref.questionId === marker.causeQuestionId);
  const title = cause?.questionTitle ?? MISSING;
  const prefix = stale !== undefined ? "Stale" : "Needs review";
  if (marker.causeKind === "out_of_scope") return `${prefix}: ${title} went out of scope`;
  return `${prefix}: ${title} changed (rev ${marker.causeRev})`;
}

export function conflictMessage(e: RpcError): string {
  switch (e.code) {
    case "revision_conflict":
      return "Changed elsewhere; reloaded. Review and retry.";
    case "relation_cycle":
      return "That relation would create a cycle.";
    case "unresolved_ref":
      return "Referenced question no longer exists.";
    case "question_inactive":
      return "Question is inactive.";
    default:
      return e.message;
  }
}
