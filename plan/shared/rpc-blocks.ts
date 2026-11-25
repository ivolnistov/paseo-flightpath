// Grilling block contracts (part of `STAGE_R0_CONTRACTS` in `./rpc`).
import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { Activation, Id, Invalidation } from "./model";
import { DefinitionFields, Mutation, result } from "./rpc-base";

export const BlockAccept = defineRpc({
  name: "block.accept",
  input: z.object({ projectId: Id, sessionId: Id, blockId: Id, expectedRevision: z.number().int().min(1) }),
  output: result(z.object({ revision: z.number().int().min(1), blockId: Id, nextBlockId: Id })),
});

/**
 * The `question.create` input: the shipped fields, the block the question joins and, from the UI
 * only, an optional first free-text answer written with the question.
 */
export const QuestionCreateV2Input = Mutation.extend({
  sessionId: Id,
  ...DefinitionFields,
  activatedBy: z.array(Activation),
  invalidatedBy: z.array(Invalidation),
  blockId: Id.optional(),
  /**
   * The owner's first free-text answer, written as revision 1 with the question in one transaction
   * through the ordinary answer rules: refused with nothing written when the question does not allow
   * free text or is created inactive, and refused for any origin but the UI.
   */
  answerText: z.string().min(1).optional(),
});
export type QuestionCreateV2Input = z.output<typeof QuestionCreateV2Input>;
