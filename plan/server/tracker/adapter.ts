// Tracker adapter boundary (server-only): a provider renders the exact wire payload and opens a
// session on a connection snapshot; the SnailOrbit implementation lives in snailorbit.ts.
import type { TrackerSettings } from "../../shared/settings";
import type { ConnectionSnapshot } from "./connection";
import type { TrackerSession } from "./snailorbit";

export interface RemoteIssue {
  remoteId: string;
  remoteKey: string;
  url: string;
  closed: boolean;
}

/** `definitive`: the provider refused, nothing was created. `ambiguous`: the outcome is unknown. */
export class TrackerError extends Error {
  constructor(
    readonly kind: "definitive" | "ambiguous",
    readonly code: string,
  ) {
    super(code);
    this.name = "TrackerError";
  }
}

/** Provider request arguments, JSON-safe. */
export type WirePayload = Record<string, unknown>;

export interface TrackerAdapter {
  readonly provider: "snailorbit";
  /** Pure and deterministic: the exact wire object that is displayed, signed and sent. */
  render(action: { kind: "create" | "close"; neutral: unknown; destination: { projectKey: string }; settings: TrackerSettings }): WirePayload;
  /** Opens a session on the snapshot's connection and checks the tool contract; no write happens here. */
  connect(snapshot: ConnectionSnapshot, signal: AbortSignal): Promise<TrackerSession>;
  // No search by idempotency key: there is no verified idempotency guarantee, and reconcile never searches.
}

/** Live mode with the snailorbit provider uses the supplied live adapter; everything else has none. */
export function adapterFor(settings: TrackerSettings, live: { snailorbit?: TrackerAdapter }): TrackerAdapter | null {
  if (settings.mode === "live" && settings.provider === "snailorbit") return live.snailorbit ?? null;
  return null;
}
