// Read-only tracker list (Stage 4 P4.8): mapped tickets and intents that need attention. One store
// read; no currency, settings, adapter, transaction, export or tracker key. Payloads, destinations,
// idempotency keys, tokens, settings and receipts are never returned.
import type { RpcInput } from "@getpaseo/plugin";
import { DomainError, isDomainError } from "../../shared/errors";
import type { TrackerIntent } from "../../shared/model";
import type { Result, TrackerList, ValueOf } from "../../shared/rpc";
import type { StoreOpener } from "../sessions";

type ListValue = ValueOf<typeof TrackerList>;

/** Same rule as preview: pending before start (by creation), sent before start (by last attempt). */
function interruptedAt(intent: TrackerIntent, processStartedAt: Date): boolean {
  if (intent.state === "pending") return Date.parse(intent.createdAt) < processStartedAt.getTime();
  if (intent.state === "sent") return Date.parse(intent.lastAttemptAt) < processStartedAt.getTime();
  return false;
}

export async function listTracker(
  open: StoreOpener,
  i: RpcInput<typeof TrackerList>,
  deps: { processStartedAt: Date },
): Promise<Result<ListValue>> {
  try {
    const read = await (await open(i.projectId)).read();
    if (read.status === "missing") throw new DomainError("store_missing", "No decision roadmap in this project.");
    if (read.status === "invalid") throw new DomainError("store_invalid", read.error.message, read.error);
    const plan = read.data.plans.find((p) => p.id === i.planId);
    if (!plan) throw new DomainError("not_found", `plan ${i.planId} not found`, { planId: i.planId });

    const byIntent = new Map(plan.intents.map((x) => [x.intentId, x] as const));
    const tickets: ListValue["tickets"] = plan.tickets.map((t) => {
      const intent = byIntent.get(t.intentId);
      return {
        intentId: t.intentId,
        taskId: intent?.taskId ?? null,
        planRev: intent?.planRev ?? null,
        provider: t.provider,
        remoteKey: t.remoteKey,
        url: t.url,
        state: t.state,
        lastSyncAt: t.lastSyncAt,
      };
    });
    const intents: ListValue["intents"] = [];
    for (const x of plan.intents) {
      if (x.state === "confirmed") continue; // represented by its ticket
      intents.push({
        intentId: x.intentId,
        taskId: x.taskId,
        planRev: x.planRev,
        kind: x.kind,
        state: x.state,
        interrupted: interruptedAt(x, deps.processStartedAt),
        errorClass: x.error ?? null,
        createdAt: x.createdAt,
        lastAttemptAt: x.lastAttemptAt,
      });
    }
    return { ok: true, value: { revision: read.revision, latestRev: plan.revisions.at(-1)?.rev ?? null, tickets, intents } };
  } catch (e) {
    if (isDomainError(e)) {
      return { ok: false, error: { code: e.code, message: e.message, ...(e.details !== undefined ? { details: e.details } : {}) } };
    }
    return { ok: false, error: { code: "internal", message: "Unexpected error reading the tracker list." } };
  }
}
