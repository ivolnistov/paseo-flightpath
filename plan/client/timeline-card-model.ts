// Pure state of a decision timeline card, derived from the current session view. No React Native.
import type { QuestionView, SessionView } from "../shared/rpc";
import { relationLines, staleCauseText, type RelationLine } from "./layout";

export type CardModel =
  | { kind: "missing" }
  | { kind: "question"; question: QuestionView; relationLines: RelationLine[]; staleText: string | null; canAnswer: boolean };

export function cardModel(view: SessionView | null, questionId: string): CardModel {
  const qv = view?.questions.find((x) => x.question.id === questionId);
  if (!view || !qv) return { kind: "missing" };
  return {
    kind: "question",
    question: qv,
    relationLines: relationLines(qv, view),
    staleText: staleCauseText(qv, view),
    canAnswer: qv.visibility !== "inactive",
  };
}
