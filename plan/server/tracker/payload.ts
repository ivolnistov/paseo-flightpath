// Provider-neutral tracker payloads. The body ends with a marker naming the intent and its
// idempotency key, so a ticket can be traced back to the durable intent that created it.
import { DomainError } from "../../shared/errors";
import type { TaskDefinition } from "../../shared/model";
import { CreatePayload } from "../../shared/rpc";

export const idempotencyKey = (projectId: string, planId: string, planRev: number, taskId: string, kind: "create" | "close") =>
  `dr:${projectId}:${planId}:${planRev}:${taskId}:${kind}`;

export const intentMarker = (intentId: string, key: string) => `decision-roadmap intent ${intentId} (${key})`;

/**
 * The issue for one task. A schema 2 task's non-blank Definition of done goes between the
 * description and the marker (Stage R4.5a); the marker stays last, since recovery parses it. An
 * over-length body is refused, never truncated.
 */
export function createPayload(task: TaskDefinition & { dod?: string }, intentId: string, key: string): CreatePayload {
  const dod = task.dod !== undefined && task.dod.trim() !== "" ? `\n\nDefinition of done:\n${task.dod}` : "";
  const parsed = CreatePayload.safeParse({ title: task.title, body: `${task.description}${dod}\n\n${intentMarker(intentId, key)}` });
  if (!parsed.success) throw new DomainError("invalid_input", "the task does not fit a tracker issue", { issues: parsed.error.issues });
  return parsed.data;
}
