// Unknown-intent resolution (O2). A human links a ticket they found, or confirms that nothing was
// created (or that a close was not applied). Never searches, sends or retries; a fresh preview is
// the only way to a new action. UI channel only; the server cannot prove which human pressed it.
import type { RpcInput } from "@getpaseo/plugin";
import { DomainError, isDomainError } from "../../shared/errors";
import type { Result, TrackerResolve, ValueOf } from "../../shared/rpc";
import type { StoreOpener, WriteOrigin } from "../sessions";
import type { TrackerAdapter } from "./adapter";
import type { AuditStore } from "./audit";
import { ConnectionSnapshot, snapshotConnection, type ConnectionSource } from "./connection";
import { idempotencyKey } from "./payload";
import type { FetchedIssue } from "./snailorbit";
import { isInterrupted } from "./sync";
import type { createTrackerKeyStore } from "./token";
import { isRecord } from "../../shared/canonical";

export { createAuditStore, type AuditEntry, type AuditStore } from "./audit";

export interface ResolveDeps {
  live: { snailorbit?: TrackerAdapter };
  connection: ConnectionSource;
  keys: ReturnType<typeof createTrackerKeyStore>;
  processStartedAt: Date;
  audit?: AuditStore;
  now: () => Date;
  log: (m: string) => void;
}

type ResolveValue = ValueOf<typeof TrackerResolve>;

function originalDestination(destination: string): { provider: string; projectKey: string; connectionFp: string } | null {
  try {
    const d: unknown = JSON.parse(destination);
    if (!isRecord(d)) return null;
    if (typeof d.provider !== "string" || typeof d.projectKey !== "string" || typeof d.connectionFp !== "string" || d.connectionFp === "") return null;
    return { provider: d.provider, projectKey: d.projectKey, connectionFp: d.connectionFp };
  } catch {
    return null;
  }
}

export async function resolveIntent(
  open: StoreOpener,
  i: RpcInput<typeof TrackerResolve>,
  origin: WriteOrigin,
  deps: ResolveDeps,
): Promise<Result<ResolveValue>> {
  try {
    if (origin.source !== "ui") throw new DomainError("invalid_input", "tracker intents are resolved only in the Paseo UI");
    const store = await open(i.projectId);
    const read = await store.read();
    if (read.status === "missing") throw new DomainError("store_missing", "No decision roadmap in this project.");
    if (read.status === "invalid") throw new DomainError("store_invalid", read.error.message, read.error);
    if (read.revision !== i.expectedRevision) {
      throw new DomainError("revision_conflict", "store revision changed", { expected: i.expectedRevision, actual: read.revision });
    }
    const plan = read.data.plans.find((p) => p.id === i.planId);
    const intent = plan?.intents.find((x) => x.intentId === i.intentId);
    if (!plan || !intent) throw new DomainError("not_found", "tracker intent not found");
    if (intent.planRev !== i.planRev) throw new DomainError("plan_revision_mismatch", "the intent belongs to another plan revision", { latestRev: intent.planRev });
    const resolvable = intent.state === "unknown" || ((intent.state === "pending" || intent.state === "sent") && isInterrupted(intent, deps.processStartedAt));
    if (!resolvable || (intent.kind !== "create" && intent.kind !== "close")) {
      throw new DomainError("tracker_intent_unresolved", "this tracker intent is not resolvable");
    }
    const createKey = idempotencyKey(i.projectId, plan.id, intent.planRev, intent.taskId, "create");
    const at = deps.now().toISOString();
    const unchanged = (d: typeof read.data) => {
      const p = d.plans.find((x) => x.id === plan.id);
      const x = p?.intents.find((y) => y.intentId === intent.intentId);
      if (!p || !x || x.state !== intent.state || x.lastAttemptAt !== intent.lastAttemptAt) {
        throw new DomainError("tracker_intent_unresolved", "the intent changed; reload and try again");
      }
      return { p, x };
    };

    let remoteKey: string | undefined;
    let resolution: "link" | "not_created" | "close_not_applied";
    let committed: number;

    if (i.resolution.kind === "link") {
      resolution = "link";
      const requested = i.resolution.remoteKey;
      const original = originalDestination(intent.destination);
      if (!original) throw new DomainError("tracker_unavailable", "the original destination of this intent is unknown");
      const mapping = plan.tickets.find((t) => t.idempotencyKey === createKey);
      if (intent.kind === "close") {
        // A close can only be confirmed for the ticket it was meant to close.
        if (!mapping) throw new DomainError("tracker_intent_unresolved", "the ticket this close was for is not mapped");
        if (requested !== mapping.remoteKey) throw new DomainError("invalid_input", "a close can only be confirmed for its original ticket");
      } else if (mapping) {
        throw new DomainError("tracker_intent_unresolved", "this task already has a mapped ticket");
      }
      const adapter = deps.live.snailorbit;
      if (!adapter) throw new DomainError("tracker_unavailable", "no live tracker adapter is available");
      const snap = await snapshotConnection(deps.connection, await deps.keys.key());
      if (!(snap instanceof ConnectionSnapshot) || snap.fingerprint !== original.connectionFp) {
        throw new DomainError("tracker_unavailable", "connection changed since this intent");
      }
      let issue: FetchedIssue | null = null;
      const ac = new AbortController();
      try {
        const session = await adapter.connect(snap, ac.signal);
        try {
          issue = await session.get(requested, ac.signal);
        } finally {
          await session.close().catch(() => undefined);
        }
      } catch (e) {
        deps.log(`tracker resolve could not verify: ${e instanceof Error ? e.name : "error"}`);
        issue = null;
      }
      if (!issue) throw new DomainError("not_found", "could not verify the ticket");
      if (issue.project.slug !== original.projectKey && issue.project.id !== original.projectKey) {
        throw new DomainError("invalid_input", "issue belongs to another project");
      }
      if (issue.remoteKey !== requested && issue.remoteId !== requested) throw new DomainError("invalid_input", "the returned issue is not the requested one");
      if (intent.kind === "close" && !issue.closed) throw new DomainError("invalid_input", "the ticket is not closed");
      const found = issue;
      remoteKey = found.remoteKey;
      committed = (
        await store.transact(i.expectedRevision, (d) => {
          const { p, x } = unchanged(d);
          if (intent.kind === "create") {
            if (p.tickets.some((t) => t.idempotencyKey === createKey)) throw new DomainError("tracker_intent_unresolved", "this task already has a mapped ticket");
            p.tickets.push({
              provider: "snailorbit",
              remoteId: found.remoteId,
              remoteKey: found.remoteKey,
              url: "",
              idempotencyKey: createKey,
              intentId: x.intentId,
              state: found.closed ? "closed" : "created",
              lastSyncAt: at,
            });
          } else {
            const m = p.tickets.find((t) => t.idempotencyKey === createKey);
            if (!m || m.remoteKey !== requested) throw new DomainError("tracker_intent_unresolved", "the mapped ticket changed");
            m.state = "closed";
            m.lastSyncAt = at;
          }
          x.state = "confirmed";
          delete x.error;
        })
      ).revision;
    } else {
      resolution = intent.kind === "close" ? "close_not_applied" : "not_created";
      committed = (
        await store.transact(i.expectedRevision, (d) => {
          const { x } = unchanged(d);
          x.state = "failed";
          x.error = intent.kind === "close" ? "human_close_not_applied" : "human_not_created";
        })
      ).revision;
    }

    const auditRecorded = deps.audit
      ? await deps.audit.record({ projectId: i.projectId, planId: plan.id, intentId: intent.intentId, planRev: intent.planRev, resolution, ...(remoteKey ? { remoteKey } : {}), at })
      : false;
    return {
      ok: true,
      value: { revision: committed, state: resolution === "link" ? "confirmed" : "failed", ...(remoteKey ? { remoteKey } : {}), auditRecorded },
    };
  } catch (e) {
    if (isDomainError(e)) {
      return { ok: false, error: { code: e.code, message: e.message, ...(e.details !== undefined ? { details: e.details } : {}) } };
    }
    deps.log(`tracker resolve failed: ${e instanceof Error ? e.name : "error"}`);
    return { ok: false, error: { code: "internal", message: "Unexpected error resolving the tracker intent." } };
  }
}
