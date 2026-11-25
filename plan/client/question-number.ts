// Stable question labels and the links a question offers for copying: the question link and the
// current-answer link. The revision-pinned history form is never offered here.
import type { QuestionView } from "../shared/rpc";

export const qLabel = (n: number): string => `Q${n}`;

export const copyLinks = (qv: QuestionView): { question: string; answer: string } => ({ question: qv.links.question, answer: qv.links.answer });
