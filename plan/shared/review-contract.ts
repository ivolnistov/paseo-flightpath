// The review command contract (Stage R3.3): the plugin writes a ReviewRequest to the configured
// review command's stdin and parses a ReviewVerdict from its stdout.
import { z } from "zod";
import { ResultBinding } from "./model";

const DodItemShape = z
  .object({ index: z.number().int().min(0), kind: z.enum(["check", "criterion"]), text: z.string(), command: z.string().optional() })
  .strict();

export const ReviewRequest = z
  .object({ binding: ResultBinding, dod: z.object({ items: z.array(DodItemShape) }).strict(), taskTitle: z.string(), taskDescription: z.string() })
  .strict();
export type ReviewRequest = z.infer<typeof ReviewRequest>;

export const ReviewVerdict = z
  .object({
    binding: ResultBinding,
    verdict: z.enum(["pass", "fail"]),
    items: z.array(z.object({ index: z.number().int().min(0), verdict: z.enum(["pass", "fail"]), note: z.string() }).strict()),
    summary: z.string(),
  })
  .strict();
export type ReviewVerdict = z.infer<typeof ReviewVerdict>;
