// Tracker preview, apply and reconcile (Stage 4 P4.3). Local project data stays canonical: intents
// and ticket mappings live in Plan.intents/Plan.tickets. Every remote call is preceded by a durable
// `pending` then `sent` intent; outcomes that cannot be confirmed are never retried automatically.
import type { PaseoApi } from "@getpaseo/client";
import type { PluginRpcContract, RpcInput } from "@getpaseo/plugin";
import { canonicalJson, isRecord } from "../../shared/canonical";
import { DomainError, isDomainError } from "../../shared/errors";
import type { ApprovalReceipt, Plan, PlanRevision, RoadmapData, TicketMapping, TrackerIntent } from "../../shared/model";
import type { Result, TrackerAction, TrackerApply, TrackerList, TrackerPreview, TrackerReconcile, TrackerResolve, ValueOf } from "../../shared/rpc";
import type { TrackerSettings } from "../../shared/settings";
import { sha256Hex } from "../hash";
import { ulid } from "../ids";
import { cancelledRefs } from "../plan-hash";
import { currency } from "../plan-rules";
import { verifiedReceiptFor, type PlanDeps } from "../plans";
import { UI_ORIGIN, type StoreOpener, type WriteOrigin } from "../sessions";
import type { Store } from "../store";
import { openProjectStore } from "../store-root";
import { adapterFor, TrackerError, type RemoteIssue, type TrackerAdapter, type WirePayload } from "./adapter";
import { ConnectionSnapshot, snapshotConnection, type ConnectionError, type ConnectionSource } from "./connection";
import type { AuditStore } from "./audit";
import { listTracker } from "./list";
import { resolveIntent } from "./resolve";
import { createPayload, idempotencyKey } from "./payload";
import { renderSnailOrbit, type TrackerSession } from "./snailorbit";
import { confirmToken, decodeActionId, encodeActionId, tokensEqual, type Binding, type createTrackerKeyStore } from "./token";

export interface TrackerDeps extends PlanDeps {
  settings: () => Promise<TrackerSettings>;
  keys: ReturnType<typeof createTrackerKeyStore>;
  live: { snailorbit?: TrackerAdapter };
  /** Local SnailOrbit connection source, read per use (never at module load). */
  connection: ConnectionSource;
  /** Durable resolution audit (O2); without it, resolutions report auditRecorded: false. */
  audit?: AuditStore;
  processStartedAt: Date;
  timeoutMs?: number;
}

export interface TrackerCommands {
  preview(open: StoreOpener, i: RpcInput<typeof TrackerPreview>, origin: WriteOrigin): Promise<Result<ValueOf<typeof TrackerPreview>>>;
  apply(open: StoreOpener, i: RpcInput<typeof TrackerApply>, origin: WriteOrigin): Promise<Result<ValueOf<typeof TrackerApply>>>;
  reconcile(open: StoreOpener, i: RpcInput<typeof TrackerReconcile>): Promise<Result<ValueOf<typeof TrackerReconcile>>>;
  resolve(open: StoreOpener, i: RpcInput<typeof TrackerResolve>, origin: WriteOrigin): Promise<Result<ValueOf<typeof TrackerResolve>>>;
}

type TrackerFn<C extends PluginRpcContract> = (paseo: PaseoApi, input: RpcInput<C>) => Promise<Result<ValueOf<C>>>;
export interface TrackerService {
  preview: TrackerFn<typeof TrackerPreview>;
  apply: TrackerFn<typeof TrackerApply>;
  reconcile: TrackerFn<typeof TrackerReconcile>;
  list: TrackerFn<typeof TrackerList>;
  resolve: TrackerFn<typeof TrackerResolve>;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const OUTCOME_ATTEMPTS = 3;
const OPEN_STATES = new Set<TrackerIntent["state"]>(["pending", "sent", "unknown"]);

type Destination = { provider: TrackerSettings["provider"]; projectKey: string | null };
type Actionable = {
  actionId: string;
  kind: "create" | "close";
  taskId: string;
  intentId: string;
  idempotencyKey: string;
  payload: WirePayload;
  /** Persisted intent destination: canonical { provider, projectKey, connectionFp }. */
  destination: string;
  /** Close only: the create idempotency key of the mapping being closed. */
  ticketKey?: string;
};
type ApplyResult = ValueOf<typeof TrackerApply>["results"][number];

const destinationOf = (s: TrackerSettings): Destination => ({ provider: s.provider, projectKey: s.projectKey ?? null });
const settingsDigest = (s: TrackerSettings) => sha256Hex(canonicalJson(s));
const fp = (intentId: string) => sha256Hex(intentId).slice(0, 8);

/**
 * Skip reasons and actionable actions for the latest revision, in task order. Every payload is the
 * exact SnailOrbit wire object (create or close), whatever the mode. A close always targets the
 * original destination recorded on the create intent, never the current settings.
 */
function planActions(
  projectId: string,
  plan: Plan,
  latest: PlanRevision,
  settings: TrackerSettings,
  adapter: TrackerAdapter | null,
  intentFor: (taskId: string, kind: "create" | "close") => string,
  processStartedAt: Date,
  connectionFp: string | null,
): { actions: TrackerAction[]; actionable: Actionable[] } {
  const actions: TrackerAction[] = [];
  const actionable: Actionable[] = [];
  const render = (kind: "create" | "close", neutral: unknown, projectKey: string, s: TrackerSettings): WirePayload =>
    adapter
      ? adapter.render({ kind, neutral, destination: { projectKey }, settings: s })
      : renderSnailOrbit(kind, neutral, { projectKey }, s.closeByProject?.[projectKey]);
  const skip = (taskId: string, reason: string) =>
    actions.push({ actionId: null, intentId: null, taskId, planRev: latest.rev, kind: "skip", payload: null, idempotencyKey: null, reason });
  const add = (a: Omit<Actionable, "actionId">) => {
    const actionId = encodeActionId({ intentId: a.intentId, taskId: a.taskId, kind: a.kind, planRev: latest.rev });
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- produced in this function only: canonicalJson of the settings-enum create destination, or of the earlier create intent's recorded destination for a close
    const target = JSON.parse(a.destination) as { provider: "none" | "snailorbit"; projectKey: string };
    actions.push({
      actionId,
      intentId: a.intentId,
      taskId: a.taskId,
      planRev: latest.rev,
      kind: a.kind,
      payload: a.payload,
      idempotencyKey: a.idempotencyKey,
      reason: null,
      destination: { provider: target.provider, projectKey: target.projectKey },
    });
    actionable.push({ actionId, ...a });
  };
  const openIntent = (taskId: string, kind: "create" | "close") =>
    plan.intents.find((x) => x.taskId === taskId && x.planRev === latest.rev && x.kind === kind && OPEN_STATES.has(x.state));
  const busy = (x: TrackerIntent) => (x.state === "unknown" || isInterrupted(x, processStartedAt) ? "needs reconcile" : "in progress");

  for (const task of latest.tasks) {
    if (settings.provider === "none") {
      skip(task.id, "provider none");
      continue;
    }
    const key = idempotencyKey(projectId, plan.id, latest.rev, task.id, "create");
    const mapping = plan.tickets.find((t) => t.idempotencyKey === key);
    if (mapping) {
      const state = plan.taskStates.find((s) => s.planRev === latest.rev && s.taskId === task.id)?.status;
      if (state !== "verified" || mapping.state !== "created") {
        skip(task.id, mapping.state === "closed" ? "already closed" : "already mapped");
        continue;
      }
      const openClose = openIntent(task.id, "close");
      if (openClose) {
        skip(task.id, busy(openClose));
        continue;
      }
      const original = originalDestination(plan.intents.find((x) => x.intentId === mapping.intentId));
      if (!original) {
        skip(task.id, "close blocked: original destination unknown");
        continue;
      }
      if (settings.mode === "live" && connectionFp !== null && connectionFp !== original.connectionFp) {
        skip(task.id, "close blocked: connection differs from where the ticket was created");
        continue;
      }
      const config = settings.closeByProject?.[original.projectKey];
      if (!config) {
        skip(task.id, `close not configured for ${original.projectKey}`);
        continue;
      }
      const closeKey = idempotencyKey(projectId, plan.id, latest.rev, task.id, "close");
      add({
        kind: "close",
        taskId: task.id,
        intentId: intentFor(task.id, "close"),
        idempotencyKey: closeKey,
        payload: render("close", { remoteKey: mapping.remoteKey }, original.projectKey, settings),
        destination: canonicalJson(original),
        ticketKey: key,
      });
      continue;
    }
    const open = openIntent(task.id, "create");
    if (open) {
      skip(task.id, busy(open));
      continue;
    }
    if (!settings.projectKey) {
      skip(task.id, "project key not configured");
      continue;
    }
    const intentId = intentFor(task.id, "create");
    add({
      kind: "create",
      taskId: task.id,
      intentId,
      idempotencyKey: key,
      payload: render("create", createPayload(task, intentId, key), settings.projectKey, settings),
      destination: canonicalJson({ provider: settings.provider, projectKey: settings.projectKey, connectionFp }),
    });
  }
  return { actions, actionable };
}

/** The destination a create intent was sent to; null when unknown or recorded without a connection. */
function originalDestination(intent: TrackerIntent | undefined): { provider: string; projectKey: string; connectionFp: string } | null {
  if (!intent || intent.kind !== "create") return null;
  try {
    const d: unknown = JSON.parse(intent.destination);
    if (!isRecord(d)) return null;
    if (typeof d.provider !== "string" || typeof d.projectKey !== "string" || typeof d.connectionFp !== "string" || d.connectionFp === "") return null;
    return { provider: d.provider, projectKey: d.projectKey, connectionFp: d.connectionFp };
  } catch {
    return null;
  }
}

export function isInterrupted(intent: TrackerIntent, processStartedAt: Date): boolean {
  if (intent.state === "pending") return Date.parse(intent.createdAt) < processStartedAt.getTime();
  if (intent.state === "sent") return Date.parse(intent.lastAttemptAt) < processStartedAt.getTime();
  return false;
}

function bindingOf(
  projectId: string,
  plan: Plan,
  latest: PlanRevision,
  receipt: ApprovalReceipt,
  settings: TrackerSettings,
  storeRevision: number,
  actionable: Actionable[],
  connectionFp: string | null,
): Binding {
  return {
    v: 1,
    projectId,
    planId: plan.id,
    planRev: latest.rev,
    contentHash: latest.contentHash,
    receiptId: receipt.receiptId,
    destination: destinationOf(settings),
    settingsDigest: settingsDigest(settings),
    mode: settings.mode,
    storeRevision,
    connectionFp,
    actions: actionable.map(({ actionId, kind, taskId, intentId, idempotencyKey: key, payload }) => ({
      actionId,
      kind,
      taskId,
      intentId,
      idempotencyKey: key,
      payload,
    })),
  };
}

export function createTrackerCommands(deps: TrackerDeps): TrackerCommands {
  const now = deps.now ?? (() => new Date());
  const newId = deps.newId ?? (() => ulid());
  const log = deps.storeOptions?.log ?? ((m: string) => console.error(m));
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  async function toResult<T>(body: () => Promise<T>): Promise<Result<T>> {
    try {
      return { ok: true, value: await body() };
    } catch (e) {
      if (isDomainError(e)) {
        return { ok: false, error: { code: e.code, message: e.message, ...(e.details !== undefined ? { details: e.details } : {}) } };
      }
      log(`decision-roadmap: unexpected tracker error: ${e instanceof Error ? e.name : "error"}`);
      return { ok: false, error: { code: "internal", message: "Unexpected error; see plugin logs." } };
    }
  }

  async function readOk(store: Store) {
    const read = await store.read();
    if (read.status === "missing") throw new DomainError("store_missing", "No decision roadmap in this project.");
    if (read.status === "invalid") throw new DomainError("store_invalid", read.error.message, read.error);
    return read;
  }

  /** The latest revision with its verified receipt, only while the approval is current. */
  async function currentApproval(projectId: string, data: RoadmapData, planId: string) {
    const plan = data.plans.find((p) => p.id === planId);
    if (!plan) throw new DomainError("not_found", `plan ${planId} not found`, { planId });
    const latest = plan.revisions.at(-1);
    if (!latest) throw new DomainError("tracker_not_current", "the plan has no revision");
    const receipt = await verifiedReceiptFor(deps.approvals, projectId, plan, latest);
    const copyOnly = !receipt && plan.approvals.some((c) => c.planRev === latest.rev);
    const c = currency(data.sessions, plan, receipt, copyOnly, cancelledRefs(data));
    if (c.status !== "current" || !receipt) {
      const reasons = c.reasons.length > 0 ? c.reasons : [`approval is ${c.status}`];
      throw new DomainError("tracker_not_current", `the latest revision is not currently approved: ${reasons.join("; ")}`, {
        status: c.status,
        reasons,
      });
    }
    return { plan, latest, receipt };
  }

  const requireUi = (origin: WriteOrigin) => {
    if (origin.source !== "ui") throw new DomainError("invalid_input", "tracker actions are confirmed only in the Paseo UI");
  };

  /** Sends with a timeout. Definitive refusals fail; everything else unconfirmed is unknown. */
  /**
   * Sends under an abort signal that fires at `timeoutMs`, plus a local deadline guard in case a
   * session ignores the abort. A timeout is unknown and is never retried.
   */
  async function send(session: TrackerSession, action: Actionable): Promise<{ state: "confirmed"; issue: RemoteIssue } | { state: "failed" | "unknown"; code: string }> {
    const ac = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => {
        ac.abort();
        resolve("timeout");
      }, timeoutMs);
    });
    try {
      const out = await Promise.race([session.send(action.kind, action.payload, ac.signal), timeout]);
      if (out === "timeout") return { state: "unknown", code: "timeout" };
      return { state: "confirmed", issue: out };
    } catch (e) {
      if (e instanceof TrackerError) return { state: e.kind === "definitive" ? "failed" : "unknown", code: e.code };
      return { state: "unknown", code: "unclassified" };
    } finally {
      clearTimeout(timer);
    }
  }

  /** A local snapshot of the live connection (no network); null outside live SnailOrbit mode. */
  async function liveSnapshot(settings: TrackerSettings): Promise<ConnectionSnapshot | { error: ConnectionError } | null> {
    if (settings.provider !== "snailorbit" || settings.mode !== "live") return null;
    return snapshotConnection(deps.connection, await deps.keys.key());
  }
  const fpOf = (snap: ConnectionSnapshot | { error: ConnectionError } | null) => (snap instanceof ConnectionSnapshot ? snap.fingerprint : null);

  return {
    preview: (open, i, origin) =>
      toResult(async () => {
        requireUi(origin);
        const read = await readOk(await open(i.projectId));
        const { plan, latest, receipt } = await currentApproval(i.projectId, read.data, i.planId);
        const settings = await deps.settings();
        const adapter = adapterFor(settings, deps.live);
        const snap = await liveSnapshot(settings);
        const connectionFp = fpOf(snap);
        const { actions, actionable } = planActions(i.projectId, plan, latest, settings, adapter, () => newId(), deps.processStartedAt, connectionFp);
        const key = await deps.keys.key();
        const token = confirmToken(key, bindingOf(i.projectId, plan, latest, receipt, settings, read.revision, actionable, connectionFp));
        const interrupted = plan.intents
          .filter((x) => isInterrupted(x, deps.processStartedAt))
          .map((x) => ({ intentId: x.intentId, taskId: x.taskId, kind: x.kind, state: x.state }));
        return {
          actions,
          destination: destinationOf(settings),
          mode: settings.mode,
          receiptId: receipt.receiptId,
          storeRevision: read.revision,
          confirmToken: token,
          interrupted,
          // Local config and adapter only: preview never connects, so this promises neither reachability nor auth.
          liveAvailable: settings.mode === "live" && adapter !== null && snap instanceof ConnectionSnapshot,
          unavailableReason: snap !== null && !(snap instanceof ConnectionSnapshot) ? snap.error : null,
        };
      }),

    apply: (open, i, origin) =>
      toResult(async () => {
        requireUi(origin);
        const mismatch = (why: string) => new DomainError("tracker_token_mismatch", `the confirmed batch no longer matches: ${why}`);
        const decoded = i.actionIds.map((id) => ({ id, ...decodeActionId(id) }));
        if (new Set(decoded.map((d) => d.id)).size !== decoded.length) throw mismatch("duplicate action");
        if (new Set(decoded.map((d) => d.intentId)).size !== decoded.length) throw mismatch("duplicate intent");
        if (new Set(decoded.map((d) => `${d.taskId}\n${d.kind}`)).size !== decoded.length) throw mismatch("duplicate task action");

        const store = await open(i.projectId);
        const read = await readOk(store);
        if (read.revision !== i.expectedRevision) {
          throw new DomainError("revision_conflict", "store revision changed", { expected: i.expectedRevision, actual: read.revision });
        }
        const { plan, latest, receipt } = await currentApproval(i.projectId, read.data, i.planId);
        if (decoded.some((d) => d.planRev !== latest.rev)) throw mismatch("plan revision");
        const settings = await deps.settings();
        const adapter = adapterFor(settings, deps.live);
        // One snapshot per batch; the same object is used for every render, sign and send.
        const snap = await liveSnapshot(settings);
        const connectionFp = fpOf(snap);
        const intents = new Map(decoded.map((d) => [`${d.taskId}\n${d.kind}`, d.intentId]));
        const { actionable } = planActions(
          i.projectId,
          plan,
          latest,
          settings,
          adapter,
          (taskId, kind) => intents.get(`${taskId}\n${kind}`) ?? "",
          deps.processStartedAt,
          connectionFp,
        );
        const rebuilt = new Set(actionable.map((a) => a.actionId));
        if (rebuilt.size !== decoded.length || decoded.some((d) => !rebuilt.has(d.id))) throw mismatch("actions");
        const binding = bindingOf(i.projectId, plan, latest, receipt, settings, i.expectedRevision, actionable, connectionFp);
        if (!tokensEqual(confirmToken(await deps.keys.key(), binding), i.confirmToken)) throw mismatch("token");

        if (settings.mode === "dry-run") {
          return {
            revision: read.revision,
            results: actionable.map((a): ApplyResult => ({ actionId: a.actionId, intentId: a.intentId, state: "dry_run" })),
          };
        }
        if (!adapter) throw new DomainError("tracker_unavailable", "no live tracker adapter is available");
        if (!(snap instanceof ConnectionSnapshot)) {
          throw new DomainError("tracker_unavailable", `the live connection is unavailable: ${snap?.error ?? "connection_missing"}`);
        }
        const batchSnapshot = snap;

        // Live: one session per batch, closed in finally. A failed connect writes nothing.
        let session: TrackerSession;
        try {
          session = await adapter.connect(batchSnapshot, new AbortController().signal);
        } catch (e) {
          const code = e instanceof TrackerError ? e.code : "connect_failed";
          log(`tracker connect failed: ${code}`);
          return {
            revision: read.revision,
            results: actionable.map((a): ApplyResult => ({ actionId: a.actionId, intentId: a.intentId, state: "not_attempted", error: code })),
          };
        }
        try {
        // Live: sequential, each action durably pending then sent before the remote call.
        const results: ApplyResult[] = [];
        let batchRevision = i.expectedRevision;
        let stopped = false;
        const settingsDestination = canonicalJson(binding.destination);
        const notAttempted = (a: Actionable): ApplyResult => ({ actionId: a.actionId, intentId: a.intentId, state: "not_attempted" });

        const recheck = (draft: RoadmapData, verified: ApprovalReceipt) => {
          const p = draft.plans.find((x) => x.id === plan.id);
          const l = p?.revisions.at(-1);
          if (!p || !l || l.rev !== latest.rev || l.contentHash !== latest.contentHash) throw mismatch("plan revision");
          if (currency(draft.sessions, p, verified, false, cancelledRefs(draft)).status !== "current") throw new DomainError("tracker_not_current", "approval no longer current");
          return p;
        };
        /** The authoritative plugin-data receipt, read fresh; it must be the one the batch was confirmed under. */
        const freshReceipt = async (): Promise<ApprovalReceipt> => {
          const r = await verifiedReceiptFor(deps.approvals, i.projectId, plan, latest);
          if (
            !r ||
            r.receiptId !== receipt.receiptId ||
            r.planRev !== receipt.planRev ||
            r.contentHash !== receipt.contentHash ||
            r.decisionSnapshotHash !== receipt.decisionSnapshotHash
          ) {
            throw new DomainError("tracker_not_current", "the approval receipt is missing or changed");
          }
          return r;
        };

        for (const action of actionable) {
          if (stopped) {
            results.push(notAttempted(action));
            continue;
          }
          const at = now().toISOString();
          let pendingRecorded = false;
          try {
            const fresh = await deps.settings();
            if (settingsDigest(fresh) !== binding.settingsDigest || canonicalJson(destinationOf(fresh)) !== settingsDestination) {
              throw mismatch("settings");
            }
            // Re-read the connection locally; a different source stops the batch.
            if (fpOf(await snapshotConnection(deps.connection, await deps.keys.key())) !== batchSnapshot.fingerprint) {
              throw mismatch("connection");
            }
            const verified = await freshReceipt();
            batchRevision = (
              await store.transact(batchRevision, (draft) => {
                const p = recheck(draft, verified);
                const sameKind = (x: TrackerIntent) =>
                  x.taskId === action.taskId && x.planRev === latest.rev && x.kind === action.kind && (OPEN_STATES.has(x.state) || x.state === "confirmed");
                const ticketBlocks =
                  action.kind === "create"
                    ? p.tickets.some((t) => t.idempotencyKey === action.idempotencyKey)
                    : !p.tickets.some((t) => t.idempotencyKey === action.ticketKey && t.state === "created");
                if (ticketBlocks || p.intents.some((x) => x.intentId === action.intentId || sameKind(x))) throw mismatch("conflicting intent");
                p.intents.push({
                  intentId: action.intentId,
                  planId: plan.id,
                  taskId: action.taskId,
                  planRev: latest.rev,
                  receiptId: receipt.receiptId,
                  kind: action.kind,
                  payload: action.payload,
                  destination: action.destination,
                  mode: settings.mode,
                  state: "pending",
                  createdAt: at,
                  lastAttemptAt: at,
                });
              })
            ).revision;
            pendingRecorded = true;
            batchRevision = (
              await store.transact(batchRevision, (draft) => {
                const intent = recheck(draft, verified).intents.find((x) => x.intentId === action.intentId);
                if (!intent || intent.state !== "pending") throw mismatch("intent state");
                intent.state = "sent";
                intent.lastAttemptAt = now().toISOString();
              })
            ).revision;
          } catch (e) {
            log(`tracker ${action.kind} not attempted fp=${fp(action.intentId)}: ${isDomainError(e) ? e.code : e instanceof Error ? e.name : "error"}`);
            stopped = true;
            // A durable pending intent that was never marked sent was never sent.
            results.push(pendingRecorded ? { ...notAttempted(action), error: "intent_not_sent" } : notAttempted(action));
            continue;
          }

          const outcome = await send(session, action);
          const record = (draft: RoadmapData) => {
            const p = draft.plans.find((x) => x.id === plan.id);
            const intent = p?.intents.find((x) => x.intentId === action.intentId);
            if (!p || !intent || intent.state !== "sent") throw new DomainError("tracker_intent_unresolved", "intent is no longer sent");
            intent.lastAttemptAt = now().toISOString();
            if (outcome.state === "confirmed" && action.kind === "close") {
              intent.state = "confirmed";
              delete intent.error;
              const mapping = p.tickets.find((t) => t.idempotencyKey === action.ticketKey);
              if (mapping) {
                mapping.state = "closed";
                mapping.lastSyncAt = intent.lastAttemptAt;
              }
            } else if (outcome.state === "confirmed") {
              intent.state = "confirmed";
              delete intent.error;
              const mapping: TicketMapping = {
                provider: "snailorbit",
                remoteId: outcome.issue.remoteId,
                remoteKey: outcome.issue.remoteKey,
                url: outcome.issue.url,
                idempotencyKey: action.idempotencyKey,
                intentId: action.intentId,
                state: "created",
                lastSyncAt: intent.lastAttemptAt,
              };
              p.tickets.push(mapping);
            } else {
              intent.state = outcome.state;
              intent.error = outcome.code;
            }
          };

          // Record at our own revision; on any failure retry at the latest revision, then stop the batch.
          let recorded = false;
          let rebased = false;
          for (let attempt = 0; attempt < OUTCOME_ATTEMPTS && !recorded; attempt++) {
            try {
              let target = batchRevision;
              if (attempt > 0) {
                const v = await store.version();
                if (v.status !== "ok" || v.revision === null) break;
                target = v.revision;
                rebased = rebased || target !== batchRevision;
              }
              batchRevision = (await store.transact(target, record)).revision;
              recorded = true;
            } catch (e) {
              if (isDomainError(e, "tracker_intent_unresolved")) break;
            }
          }
          const remoteKey = outcome.state === "confirmed" ? outcome.issue.remoteKey : undefined;
          if (!recorded) {
            log(`tracker ${action.kind} outcome not recorded fp=${fp(action.intentId)}`);
            results.push({ actionId: action.actionId, intentId: action.intentId, state: "unknown", error: "outcome not recorded", ...(remoteKey ? { remoteKey } : {}) });
            stopped = true;
            continue;
          }
          log(`tracker ${action.kind} ${outcome.state} fp=${fp(action.intentId)}`);
          results.push({
            actionId: action.actionId,
            intentId: action.intentId,
            state: outcome.state,
            ...(remoteKey ? { remoteKey } : {}),
            ...(outcome.state !== "confirmed" ? { error: outcome.code } : {}),
          });
          // A foreign write forced a rebase, or the outcome is not a confirmation: stop here.
          if (rebased || outcome.state !== "confirmed") stopped = true;
        }
        return { revision: batchRevision, results };
        } finally {
          await session.close().catch(() => undefined);
        }
      }),

    resolve: (open, i, origin) =>
      resolveIntent(open, i, origin, {
        live: deps.live,
        connection: deps.connection,
        keys: deps.keys,
        processStartedAt: deps.processStartedAt,
        ...(deps.audit ? { audit: deps.audit } : {}),
        now,
        log: (m) => log(m),
      }),

    reconcile: (open, i) =>
      toResult(async () => {
        const read = await readOk(await open(i.projectId));
        const plan = read.data.plans.find((p) => p.id === i.planId);
        if (!plan) throw new DomainError("not_found", `plan ${i.planId} not found`, { planId: i.planId });
        const intent = plan.intents.find((x) => x.intentId === i.intentId);
        if (!intent) throw new DomainError("not_found", "tracker intent not found");
        const mapping = plan.tickets.find((t) => t.intentId === intent.intentId);
        return {
          state: intent.state,
          ...(mapping ? { remoteKey: mapping.remoteKey } : {}),
          humanDecisionRequired: OPEN_STATES.has(intent.state),
        };
      }),
  };
}

/** UI wrapper: a live opener per call and the UI origin, as the Stage 1/3 services do. */
export function createTrackerService(deps: TrackerDeps): TrackerService {
  const commands = createTrackerCommands(deps);
  const opener =
    (paseo: PaseoApi): StoreOpener =>
    (projectId) =>
      openProjectStore(deps.directory(paseo), projectId, deps.storeOptions);
  return {
    preview: (paseo, i) => commands.preview(opener(paseo), i, UI_ORIGIN),
    apply: (paseo, i) => commands.apply(opener(paseo), i, UI_ORIGIN),
    reconcile: (paseo, i) => commands.reconcile(opener(paseo), i),
    list: (paseo, i) => listTracker(opener(paseo), i, { processStartedAt: deps.processStartedAt }),
    resolve: (paseo, i) => commands.resolve(opener(paseo), i, UI_ORIGIN),
  };
}
