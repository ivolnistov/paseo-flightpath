// The text "Discuss in chat" places in the planner chat's draft: one delimited block naming the
// question, its current answer (or that it has none) and its canonical link. History revisions are
// never presented as the current answer.
import type { Answer, Question } from "../shared/model";
import type { QuestionView } from "../shared/rpc";
import { currentAnswer } from "../shared/status";
import { qLabel } from "./question-number";
import { STATUS_LABEL } from "./status-label";

function answerValue(q: Question, a: Answer): string {
  if (a.text !== undefined) return JSON.stringify(a.text);
  const option = q.options.find((o) => o.id === a.optionId);
  return JSON.stringify(option?.label ?? a.optionId ?? "");
}

export function discussContext(qv: QuestionView): string {
  const q = qv.question;
  const label = qLabel(qv.number);
  const current = currentAnswer(q);
  const answer =
    current !== undefined
      ? `Current answer (rev ${current.rev}): ${answerValue(q, current)}`
      : `Current answer: none (status: ${STATUS_LABEL[qv.status]})`;
  return [
    `--- Roadmap question ${label} ---`,
    `Question: ${label} ${JSON.stringify(q.title)}`,
    answer,
    `Link: ${qv.links.question}`,
    `--- End of roadmap question ${label} ---`,
  ].join("\n");
}
