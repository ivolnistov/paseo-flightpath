import type { Answer, Validity, Visibility } from "./model";

export type QuestionStatus = "open" | "answered" | "stale" | "skipped" | "inactive" | "out_of_scope";

/** Inactive wins; otherwise the stored validity maps to a status. */
export function questionStatus(visibility: Visibility, validity: Validity): QuestionStatus {
  if (visibility === "inactive") return "inactive";
  switch (validity) {
    case "unanswered":
      return "open";
    case "valid":
      return "answered";
    case "stale":
      return "stale";
    case "skipped":
      return "skipped";
    case "out_of_scope":
      return "out_of_scope";
  }
}

/** The answer that is the question's current outcome: only an answered or stale question has one. */
export function currentAnswer(q: { answer?: Answer; validity: Validity }): Answer | undefined {
  return q.validity === "valid" || q.validity === "stale" ? q.answer : undefined;
}

/**
 * The answer a skipped or out-of-scope question kept from before: history, never its current
 * outcome. The stored `answer` stays the latest revision for existing readers.
 */
export function priorAnswer(q: { answer?: Answer; validity: Validity }): Answer | undefined {
  return q.validity === "skipped" || q.validity === "out_of_scope" ? q.answer : undefined;
}
