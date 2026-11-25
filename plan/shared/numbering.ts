// Persistent question numbers: stored on new questions, derived as order + 1 for older ones until
// their session is next written, and never changed afterwards.
import { DomainError } from "./errors";
import type { RoadmapData, Session } from "./model";

type Numbered = { order: number; number?: number };

/** The effective number: the stored one, else order + 1. */
export const questionNumber = (q: Numbered): number => q.number ?? q.order + 1;

/** The number for a new question of `session`: past every effective number, gaps never reused. */
export function nextNumber(session: { questions: ReadonlyArray<Numbered> }): number {
  return session.questions.reduce((max, q) => Math.max(max, questionNumber(q)), 0) + 1;
}

/** Stores the derived number on every question that lacks one; returns whether anything changed. */
export function backfillNumbers(session: Session): boolean {
  let changed = false;
  for (const q of session.questions) {
    if (q.number === undefined) {
      q.number = q.order + 1;
      changed = true;
    }
  }
  return changed;
}

/**
 * Every session and question of the previous generation survives, every surviving question keeps
 * its effective number, and effective numbers are unique per session.
 */
export function assertNumbersStable(before: RoadmapData | null, after: RoadmapData): void {
  for (const s of after.sessions) {
    const seen = new Set<number>();
    for (const q of s.questions) {
      const n = questionNumber(q);
      if (seen.has(n)) throw new DomainError("internal", `duplicate question number ${n} in session ${s.id}`, { sessionId: s.id });
      seen.add(n);
    }
  }
  if (before === null) return;
  const sessions = new Map(after.sessions.map((s) => [s.id, s]));
  for (const s of before.sessions) {
    const next = sessions.get(s.id);
    if (next === undefined) throw new DomainError("internal", `session ${s.id} deleted`, { sessionId: s.id });
    const questions = new Map(next.questions.map((q) => [q.id, q]));
    for (const q of s.questions) {
      const candidate = questions.get(q.id);
      if (candidate === undefined) {
        throw new DomainError("internal", `question ${s.id}/${q.id} deleted`, { sessionId: s.id, questionId: q.id });
      }
      if (questionNumber(candidate) !== questionNumber(q)) {
        throw new DomainError("internal", `question number changed: ${s.id}/${q.id} ${questionNumber(q)} -> ${questionNumber(candidate)}`, {
          sessionId: s.id,
          questionId: q.id,
        });
      }
    }
  }
}
