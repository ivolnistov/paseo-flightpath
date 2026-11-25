// Questions that depend on a decision: activation children and invalidation dependents,
// transitively and across sessions.
import { refKey, type Ref, type RefKey, type Session } from "./model";

/** Direct dependents of every question, in document order. */
export function childIndex(sessions: Session[]): Map<RefKey, Ref[]> {
  const children = new Map<RefKey, Ref[]>();
  for (const s of sessions) {
    for (const q of s.questions) {
      const ref = { sessionId: s.id, questionId: q.id };
      const parents = [...q.activatedBy.map((a) => a.parent), ...q.invalidatedBy.map((i) => i.upstream)];
      for (const key of new Set(parents.map(refKey))) children.set(key, [...(children.get(key) ?? []), ref]);
    }
  }
  return children;
}

/** Every question reachable from `start` through activation or invalidation edges, `start` excluded, in BFS order. */
export function dependentsOf(sessions: Session[], start: Ref, children: Map<RefKey, Ref[]> = childIndex(sessions)): Ref[] {
  const seen = new Set<RefKey>([refKey(start)]);
  const out: Ref[] = [];
  const queue: Ref[] = [start];
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    for (const child of children.get(refKey(next)) ?? []) {
      const key = refKey(child);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(child);
      queue.push(child);
    }
  }
  return out;
}
