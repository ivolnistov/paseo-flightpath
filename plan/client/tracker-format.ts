// Pure tracker display helpers. No React Native import; tested in the node environment.
import { canonicalJson } from "../shared/canonical";

type ActionKind = "create" | "close" | "skip";
type DisplayState = "dry_run" | "confirmed" | "unknown" | "failed" | "not_attempted" | "pending" | "sent" | "interrupted";

const ACTION_LABELS: Record<ActionKind, string> = { create: "Create issue", close: "Close issue", skip: "Skip" };
const STATE_LABELS: Record<DisplayState, string> = {
  dry_run: "Dry run (nothing sent)",
  confirmed: "Created",
  unknown: "Outcome unknown",
  failed: "Failed",
  not_attempted: "Not attempted",
  pending: "Pending",
  sent: "Sent, awaiting result",
  interrupted: "Interrupted",
};

const INTENT_ROW_LABELS = {
  pending: "Pending",
  sent: "Sent, awaiting result",
  unknown: "Outcome unknown",
  failed: "Failed",
} as const;

/** Row label for an intent that needs attention; interrupted pending/sent rows read differently. */
export function intentRowLabel(state: "pending" | "sent" | "unknown" | "failed", interrupted: boolean): string {
  if (interrupted && state === "pending") return "Interrupted before sending";
  if (interrupted && state === "sent") return "Interrupted after sending";
  return INTENT_ROW_LABELS[state];
}

export const actionLabel = (kind: ActionKind): string => ACTION_LABELS[kind];
/** A confirmed close reads "Closed"; a confirmed create (or unknown kind) reads "Created". */
export const stateLabel = (state: DisplayState, kind?: "create" | "close"): string =>
  state === "confirmed" && kind === "close" ? "Closed" : STATE_LABELS[state];

/** Stable pretty JSON: canonical (sorted keys) with a 2-space indent. */
export function payloadText(payload: unknown): string {
  return JSON.stringify(JSON.parse(canonicalJson(payload)), null, 2);
}
