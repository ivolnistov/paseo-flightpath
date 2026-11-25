// Per-tab state from the host, for keeping the open screen across a host remount (the host renders a
// compact and a wide layout through different trees, so a breakpoint change remounts the panel).
//
// Host-version-specific: the Paseo host observed at 0.15.3 passes workspace panels a `tab` prop
// `{ state, setState, setModified }` kept in its tab layout store. The plugin SDK this project pins
// (0.12) does not declare it, so it is read defensively and treated as optional: without it, or with a
// shape other than expected, nothing is restored or saved and the panel opens on its overview as
// before. Only this plugin's own key inside a record state is written; any other state is left alone.
const KEY = "decisionRoadmap";
const VERSION = 1;

export type HostTab = { read(): unknown; write(next: Record<string, unknown>): void };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The host's tab state for this panel, or null when the host passes none (or an unknown shape). */
export function hostTabOf(props: object): HostTab | null {
  const tab: unknown = Reflect.get(props, "tab");
  if (!isRecord(tab)) return null;
  const setState: unknown = tab.setState;
  if (typeof setState !== "function") return null;
  return {
    read: () => tab.state,
    write: (next) => void Reflect.apply(setState, tab, [next]),
  };
}

/** A screen as kept in the tab: its kind and ids only; one-shot link targets are not kept. */
export type StoredScreen = { kind: "overview" } | { kind: "roadmap" } | { kind: "feature"; featureId: string } | { kind: "plan"; planId: string } | { kind: "session"; sessionId: string };

function parseScreen(v: unknown): StoredScreen | null {
  if (!isRecord(v)) return null;
  const id = (k: string) => (typeof v[k] === "string" && v[k] !== "" ? v[k] : null);
  switch (v.kind) {
    case "overview":
      return { kind: "overview" };
    case "roadmap":
      return { kind: "roadmap" };
    case "feature": {
      const featureId = id("featureId");
      return featureId === null ? null : { kind: "feature", featureId };
    }
    case "plan": {
      const planId = id("planId");
      return planId === null ? null : { kind: "plan", planId };
    }
    case "session": {
      const sessionId = id("sessionId");
      return sessionId === null ? null : { kind: "session", sessionId };
    }
    default:
      return null;
  }
}

/** The kept screen stack for this host and project; null when there is none or it does not parse. */
export function restoreStack(tab: HostTab | null, hostId: string, projectId: string): StoredScreen[] | null {
  if (tab === null) return null;
  const state = tab.read();
  const kept = isRecord(state) ? state[KEY] : undefined;
  if (!isRecord(kept) || kept.v !== VERSION || kept.hostId !== hostId || kept.projectId !== projectId || !Array.isArray(kept.stack)) return null;
  const stack = kept.stack.map(parseScreen);
  if (stack.length === 0 || stack.some((s) => s === null) || stack[0]?.kind !== "overview") return null;
  return stack.filter((s): s is StoredScreen => s !== null);
}

/** Keeps the screen stack in the tab; a state that is not a record (someone else's) is left alone. */
export function saveStack(tab: HostTab | null, hostId: string, projectId: string, stack: StoredScreen[]): void {
  if (tab === null) return;
  const state = tab.read();
  if (state !== undefined && state !== null && !isRecord(state)) return;
  const base = isRecord(state) ? state : {};
  const kept = { v: VERSION, hostId, projectId, stack };
  if (JSON.stringify(base[KEY]) === JSON.stringify(kept)) return;
  tab.write({ ...base, [KEY]: kept });
}
