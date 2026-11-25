// Where a roadmap link lands in a session view. A question link selects the question; a current-answer
// link also focuses its current answer; a pinned link focuses that history revision; a hidden question
// is flagged so the hidden list opens; another session is reported with the whole link; an unknown
// number is reported as missing. Nothing in the link is dropped. Pure.
import type { ParsedLink } from "../shared/links";
import type { SessionView } from "../shared/rpc";

export type Focus = "answer" | { rev: number };
export type Target = { questionId: string; nonce: number; focus?: Focus };
export type Resolved =
  | { kind: "target"; target: Target }
  | { kind: "hidden"; target: Target }
  | { kind: "other-session"; sessionId: string; link: ParsedLink }
  | { kind: "missing"; number: number };

export function resolveTarget(view: SessionView, link: ParsedLink | number, nonce = 0): Resolved {
  if (typeof link !== "number" && link.sessionId !== view.session.id) return { kind: "other-session", sessionId: link.sessionId, link };
  const number = typeof link === "number" ? link : link.number;
  const qv = view.questions.find((q) => q.number === number);
  if (qv === undefined) return { kind: "missing", number };
  const focus: Focus | undefined = typeof link === "number" || link.kind === "question" ? undefined : link.rev !== undefined ? { rev: link.rev } : "answer";
  const target: Target = { questionId: qv.question.id, nonce, ...(focus !== undefined ? { focus } : {}) };
  return qv.visibility === "inactive" ? { kind: "hidden", target } : { kind: "target", target };
}
