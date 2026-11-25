// Stage 4 test support. Staged: Stage 4 modules are referenced by type only or loaded lazily, so
// the payload/token tests do not depend on the sync commands module (T4 commit 2).
import type { RemoteIssue, TrackerAdapter } from "../tracker/adapter";
import type { TrackerSession } from "../tracker/snailorbit";
import { fixedClock, nextId } from "./build";
import { makePlanProject } from "./plans";

export type AdapterStep = "ok" | "definitive" | "ambiguous" | "hang";

type RenderFn = TrackerAdapter["render"];
let renderImpl: RenderFn = () => {
  throw new Error("fake adapter render not configured: call setFakeRender() with the production renderSnailOrbit delegate");
};
/** Tests set the real pure wire renderer (P4.6 renderSnailOrbit) so fake and production render identically. */
export const setFakeRender = (fn: RenderFn) => void (renderImpl = fn);

/**
 * Scripted adapter (P4.6 interface: render + connect → session). Records every render, connect,
 * send, get and close; `send` steps follow the script across sessions.
 */
export function fakeAdapter(script: AdapterStep[]): TrackerAdapter & { calls: Array<{ op: string; payload: unknown }>; sessions: { opened: number; closed: number } } {
  const calls: Array<{ op: string; payload: unknown }> = [];
  const sessions = { opened: 0, closed: 0 };
  let n = 0;
  return {
    provider: "snailorbit",
    calls,
    sessions,
    render(action) {
      calls.push({ op: "render", payload: action });
      return renderImpl(action);
    },
    async connect(snapshot) {
      calls.push({ op: "connect", payload: (snapshot as { fingerprint?: string }).fingerprint });
      sessions.opened++;
      let closed = false;
      const session: TrackerSession = {
        async send(kind, wire) {
          calls.push({ op: `send:${kind}`, payload: wire });
          const step = script[n++] ?? "definitive";
          if (step === "hang") return new Promise<RemoteIssue>(() => undefined);
          if (step === "ok") return { remoteId: `remote-${n}`, remoteKey: `SYN-${n}`, url: "", closed: kind === "close" };
          const { TrackerError } = await import("../tracker/adapter");
          throw new TrackerError(step, step === "definitive" ? "rejected" : "timeout");
        },
        async get(remoteKey) {
          calls.push({ op: "get", payload: remoteKey });
          return null;
        },
        async close() {
          if (!closed) sessions.closed++;
          closed = true;
        },
      };
      return session;
    },
  };
}

/** A temp project with an approved, current plan (Stage 3 draft + UI approve) and tracker commands. */
export async function approvedPlan(opts: { tasks?: number } = {}) {
  const { createTrackerCommands } = await import("../tracker/sync");
  const { createTrackerKeyStore } = await import("../tracker/token");
  const { UI_ORIGIN } = await import("../sessions");
  const t = await makePlanProject();
  const seed = await t.seedAnswered();
  const tasks = Array.from({ length: opts.tasks ?? 2 }, (_, i) => ({ id: `t${i + 1}`, title: `Task ${i + 1}`, description: `Synthetic task ${i + 1}` }));
  const drafted = await t.plans.draft(
    t.open,
    { projectId: t.P, expectedRevision: await t.revision(), title: "Tracker plan", sessionIds: [seed.sessionId], markdown: "# Tracker plan", tasks },
    UI_ORIGIN,
  );
  if (!drafted.ok) throw new Error(`draft failed: ${drafted.error.code}`);
  const approved = await t.plans.approve(t.open, { projectId: t.P, planId: drafted.value.planId, rev: drafted.value.rev, contentHash: drafted.value.contentHash }, UI_ORIGIN);
  if (!approved.ok) throw new Error(`approve failed: ${approved.error.code}`);
  type Deps = Parameters<typeof createTrackerCommands>[0];
  /** Current synthetic SnailOrbit connection URL seen by the fake ConnectionSource (switchable). */
  const connectionUrl = { current: new URL("http://127.0.0.1:9/mcp/synthetic-conn-A") };
  return {
    ...t,
    seed,
    planId: drafted.value.planId,
    rev: drafted.value.rev,
    contentHash: drafted.value.contentHash,
    connectionUrl,
    receiptId: approved.value.receiptId,
    /** Tracker commands over the same project and plugin-data stateDir; defaults: provider none, dry-run, no live adapter. */
    tracker: (deps: Partial<Deps> = {}) =>
      createTrackerCommands({
        directory: () => {
          throw new Error("tracker commands must use the call's opener");
        },
        now: fixedClock,
        newId: nextId,
        storeOptions: { now: fixedClock, newId: nextId, log: t.env.log },
        approvals: t.approvals,
        settings: async () => ({ provider: "none", mode: "dry-run", closeByProject: {} }),
        keys: createTrackerKeyStore({ stateDir: t.stateDir }),
        live: {},
        connection: { read: async () => ({ url: connectionUrl.current }) },
        processStartedAt: fixedClock(),
        ...deps,
      } as Deps),
  };
}
