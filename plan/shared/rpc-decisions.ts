// Decision cancellation contract (Stage R1.3a; part of `STAGE_R1_CONTRACTS` in `./rpc`). UI only:
// the actor, id and time are set by the server, never taken from the input.
import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { Id } from "./model";
import { Mutation, result, Written } from "./rpc-base";

export const DecisionCancel = defineRpc({
  name: "decision.cancel",
  input: Mutation.extend({ sessionId: Id, questionId: Id, reason: z.string().min(1) }),
  output: result(Written.extend({ cancellationId: Id })),
});
