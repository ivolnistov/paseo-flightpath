// Stable question and answer links. An answer link resolves to the current answer; the
// revision-pinned form is a history reference, never the default.
const SEGMENT = "[A-Za-z0-9_-]+";
const POSITIVE = "[1-9]\\d*";
// Groups: 1 project, 2 session, 3 number, 4 the answer suffix, 5 the pinned revision. The kind comes
// from group 4, never from the ids, which may contain "answer". Numbered groups keep the pattern
// portable to the native client's regex engine.
const LINK_RE = new RegExp(`^roadmap://(${SEGMENT})/s/(${SEGMENT})/q/(${POSITIVE})(/answer(?:/r(${POSITIVE}))?)?$`);
const SHORT_RE = new RegExp(`^[Qq](${POSITIVE})$`);

export type LinkTarget = { projectId: string; sessionId: string; number: number };
export type ParsedLink = LinkTarget & { kind: "question" | "answer"; rev?: number };

export const questionLink = (x: LinkTarget): string => `roadmap://${x.projectId}/s/${x.sessionId}/q/${x.number}`;

export const answerLink = (x: LinkTarget, rev?: number): string => `${questionLink(x)}/answer${rev !== undefined ? `/r${rev}` : ""}`;

/** Both links of a question. */
export const linksOf = (x: LinkTarget): { question: string; answer: string } => ({ question: questionLink(x), answer: answerLink(x) });

/** A canonical roadmap link, or null for anything else. */
export function parseLink(text: string): ParsedLink | null {
  const m = LINK_RE.exec(text.trim());
  if (m === null) return null;
  const [, projectId, sessionId, number, answer, rev] = m;
  return {
    projectId,
    sessionId,
    number: Number(number),
    kind: answer !== undefined ? "answer" : "question",
    ...(rev !== undefined ? { rev: Number(rev) } : {}),
  };
}

/** `Q<n>` (either case) → n, or null. */
export function parseShortRef(text: string): number | null {
  const m = SHORT_RE.exec(text.trim());
  return m === null ? null : Number(m[1]);
}
