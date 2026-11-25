// Decision timeline row: a reference to a stored question, never its text or answer. Pure.
import { z } from "zod";
import { Id } from "../shared/model";

export const ROW_KIND = "decision-question";
export const ROW_VERSION = 1;

export const RowData = z.object({ projectId: Id, sessionId: Id, questionId: Id }).strict();
export type RowData = z.output<typeof RowData>;

/** Run timeline row (Stage R3.5): a reference to a stored run, never its token, events or evidence. */
export const RUN_ROW_KIND = "decision-run";
export const RUN_ROW_VERSION = 1;

export const RunRowData = z.object({ projectId: Id, runId: Id }).strict();
export type RunRowData = z.output<typeof RunRowData>;

/**
 * Decision-references row: the roadmap links an agent's turn mentioned (assistant text and completed
 * tool results), at most 20, as references only; never message text, titles or answers.
 */
export const REF_ROW_KIND = "decision-references";
export const REF_ROW_VERSION = 1;
export const MAX_REFERENCES = 20;

export const RefRowData = z
  .object({
    projectId: Id,
    turnId: z.string().min(1),
    refs: z
      .array(z.object({ link: z.string().min(1), sessionId: Id, number: z.number().int().min(1), kind: z.enum(["question", "answer"]) }).strict())
      .max(MAX_REFERENCES),
  })
  .strict();
export type RefRowData = z.output<typeof RefRowData>;
