// Pure: the question.update patch for an edit draft, diffed against the question as it was when the
// editor opened (not the live, possibly refreshed question), so untouched fields are never sent.
import { canonicalJson } from "../shared/canonical";
import type { Option, Question } from "../shared/model";

export type DefinitionDraft = {
  title: string;
  context: string;
  options: Option[];
  recommendedOptionId?: string;
  allowFreeText: boolean;
};

export type DefinitionPatch = Partial<Omit<DefinitionDraft, "recommendedOptionId">> & { recommendedOptionId?: string | null };

export function definitionPatch(base: Question, draft: DefinitionDraft): DefinitionPatch {
  const patch: DefinitionPatch = {};
  if (draft.title !== base.title) patch.title = draft.title;
  if (draft.context !== base.context) patch.context = draft.context;
  if (canonicalJson(draft.options) !== canonicalJson(base.options)) patch.options = draft.options;
  if (draft.recommendedOptionId !== base.recommendedOptionId) patch.recommendedOptionId = draft.recommendedOptionId ?? null;
  if (draft.allowFreeText !== base.allowFreeText) patch.allowFreeText = draft.allowFreeText;
  return patch;
}
