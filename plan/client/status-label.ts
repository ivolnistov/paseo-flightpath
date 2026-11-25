// Question status labels without UI dependencies, so plain text builders can use them.
import type { QuestionStatus } from "../shared/status";

export const STATUS_LABEL: Record<QuestionStatus, string> = {
  open: "Open",
  answered: "Answered",
  stale: "Stale",
  skipped: "Skipped",
  inactive: "Inactive",
  out_of_scope: "Out of scope",
};
