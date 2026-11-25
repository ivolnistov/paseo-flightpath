// Stage R4.2 (task card 2026-10-29 R4 §3): `profileOptions(config)` (id + name only, never a model
// string) and `StartDialog({ hostId, projectId, feature, theme, compact, mode, onClose })`.
// Start: without a binding the profile picker is required (`run.start { featureId, profileRef }`);
// with a binding there is no profile (`run.start { featureId }`). Replace: `coordinator.replace
// { featureId, profileRef }` (feature-scoped, no run token). A refusal is shown and nothing retries.
// Node harness in the existing client pattern: slot state, inert markers, the dialog's own function
// components expanded; `useProfiles` and `useRoadmapMutation` are mocked at the `./hooks` boundary.
import { beforeEach, describe, expect, it, vi } from "vitest";

type El = { type: unknown; props: Record<string, any> };
const h = vi.hoisted(() => {
  const state = {
    slots: [] as unknown[],
    index: 0,
    dirty: false,
    calls: [] as Array<{ contract: string; input: Record<string, unknown> }>,
    answer: (_c: string): unknown => ({ revision: 8 }),
    profiles: [] as Array<{ id: string; label: string }>,
    // R4 successor KensAI c0037: an explicit profiles query state (e.g. a failed host config read).
    profilesQuery: null as null | { data: unknown; isPending: boolean; isError: boolean; error?: unknown },
  };
  const marker = (name: string) => Object.assign(() => null, { displayName: name });
  const useState = (init: unknown) => {
    const i = state.index++;
    if (!(i in state.slots)) state.slots[i] = typeof init === "function" ? (init as () => unknown)() : init;
    const set = (v: unknown) => {
      const next = typeof v === "function" ? (v as (p: unknown) => unknown)(state.slots[i]) : v;
      if (!Object.is(next, state.slots[i])) {
        state.slots[i] = next;
        state.dirty = true;
      }
    };
    return [state.slots[i], set];
  };
  return { state, marker, useState };
});
vi.mock("react", async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  const hooks = { useState: h.useState, useEffect: () => undefined, useCallback: (fn: unknown) => fn, useMemo: (fn: () => unknown) => fn(), useRef: (v: unknown) => ({ current: v }) };
  return { ...real, ...hooks, default: { ...(real.default as object), ...hooks } };
});
vi.mock("react-native", () => ({
  Text: h.marker("Text"), View: h.marker("View"), Pressable: h.marker("Pressable"), ScrollView: h.marker("ScrollView"), TextInput: h.marker("RNTextInput"),
  Platform: { OS: "ios", select: (o: Record<string, unknown>) => o.ios ?? o.default }, StyleSheet: { create: (x: unknown) => x, flatten: (x: unknown) => x },
}));
vi.mock("@getpaseo/plugin/client/react-native", () => ({
  TextInput: h.marker("TextInput"), ScrollView: h.marker("PScrollView"),
  Modal: Object.assign(h.marker("Modal"), { Content: h.marker("ModalContent") }),
  useToast: () => ({ show: () => undefined, error: () => undefined }),
}));
vi.mock("./ui", () => ({ Button: h.marker("Button"), Heading: h.marker("Heading"), Muted: h.marker("Muted") }));
vi.mock("@getpaseo/plugin/client", () => ({
  useRpc: (contract: { name: string }) => async (input: Record<string, unknown>) => {
    h.state.calls.push({ contract: contract.name, input });
    return { ok: true, value: h.state.answer(contract.name) };
  },
  usePaseo: () => ({ config: { get: async () => ({ revision: "r1", config: { agentProfiles: [] } }) } }),
  useWorkspace: () => null,
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: undefined, isPending: false, isError: false }),
  useQueryClient: () => ({ invalidateQueries: async () => undefined, getQueryData: () => ({ revision: 7 }), getQueriesData: () => [] }),
}));
vi.mock("./hooks", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useProfiles: () => h.state.profilesQuery ?? { data: h.state.profiles, isPending: false, isError: false },
  useRoadmapVersion: () => ({ data: { revision: 7 }, isPending: false, isError: false }),
  useRoadmapMutation: (_host: string, projectId: string, contract: { name: string }) => ({
    pending: false,
    run: async (input: Record<string, unknown>) => {
      h.state.calls.push({ contract: contract.name, input: { ...input, projectId, expectedRevision: 7 } });
      return h.state.answer(contract.name);
    },
  }),
}));

const modulePath = "./start-dialog";
const load = async () => {
  const mod = (await import(/* @vite-ignore */ modulePath)) as Record<string, unknown>;
  for (const n of ["profileOptions", "StartDialog"]) expect(typeof mod[n], `client/start-dialog exports ${n}`).toBe("function");
  return mod as unknown as { profileOptions: (c: unknown) => Array<{ id: string; label: string }>; StartDialog: (p: unknown) => unknown };
};
const AT = "2026-10-29T10:00:00.000Z";
const theme = { colors: new Proxy({}, { get: () => "#000" }) };
const feature = (bound: boolean) => ({
  id: "f-1", title: "Search", description: "", kind: "feature", status: "planned", dependsOn: [], relatedTo: [], everStarted: false,
  createdAt: AT, createdBy: { kind: "human" }, coordinatorHistory: [], events: [],
  ...(bound ? { coordinator: { agentId: "agent-c", workspaceId: "ws-1", boundAt: AT, profileRef: "team-coordinator" } } : {}),
});
const PROFILES = [{ id: "team-coordinator", label: "Coordinator" }, { id: "plain", label: "Plain helper" }];

function mount(Dialog: (p: unknown) => unknown, props: Record<string, unknown>) {
  const render = () => {
    let tree: unknown;
    for (let pass = 0; pass < 20; pass++) {
      h.state.index = 0;
      h.state.dirty = false;
      tree = Dialog(props);
      if (!h.state.dirty) break;
    }
    const els: El[] = [];
    const walk = (n: unknown, d = 0): void => {
      if (d > 60 || n === null || n === undefined || typeof n !== "object") return;
      if (Array.isArray(n)) return n.forEach((x) => walk(x, d + 1));
      const el = n as El;
      if (typeof el.type === "function" && !(el.type as { displayName?: string }).displayName) return walk((el.type as (p: unknown) => unknown)(el.props ?? {}), d + 1);
      els.push(el);
      for (const [k, v] of Object.entries(el.props ?? {})) if (k === "children" || k === "footer" || k === "header") walk(v, d + 1);
    };
    walk(tree);
    const textOf = (n: unknown): string => {
      if (typeof n === "string" || typeof n === "number") return String(n);
      if (Array.isArray(n)) return n.map(textOf).join(" ");
      if (n && typeof n === "object") {
        const x = n as El;
        if (typeof x.type === "function" && !(x.type as { displayName?: string }).displayName) return textOf((x.type as (p: unknown) => unknown)(x.props ?? {}));
        return [x.props?.label, x.props?.accessibilityLabel, x.props?.title, textOf(x.props?.children)].filter((s) => typeof s === "string" && s !== "").join(" ");
      }
      return "";
    };
    const pressables = els.filter((e) => typeof e.props?.onPress === "function" || typeof e.props?.onValueChange === "function" || typeof e.props?.onSelect === "function");
    const find = (re: RegExp) => pressables.filter((e) => re.test(textOf(e)));
    const text = els.map((e) => (typeof e.props?.children === "string" ? e.props.children : "")).join(" ") + " " + textOf(tree);
    return { els, pressables, find, text };
  };
  return { render };
}
const tap = async (el: El | undefined) => {
  expect(el, "a matching control").toBeDefined();
  if (el!.props.disabled) return;
  (el!.props.onPress ?? el!.props.onValueChange ?? el!.props.onSelect)(true);
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

beforeEach(() => {
  h.state.slots = [];
  h.state.calls = [];
  h.state.answer = () => ({ revision: 8 });
  h.state.profiles = PROFILES;
  h.state.profilesQuery = null;
});

describe("R4.2 profileOptions", () => {
  it("maps config.agentProfiles to { id, label: name } only, never a model or provider string", async () => {
    const { profileOptions } = await load();
    const out = profileOptions({ agentProfiles: [{ id: "team-coordinator", name: "Coordinator", provider: "claude", model: "claude-opus-5-5", mode: "plan" }, { id: "plain", name: "Plain helper", provider: "codex", model: "gpt-x" }] });
    expect(out).toEqual([{ id: "team-coordinator", label: "Coordinator" }, { id: "plain", label: "Plain helper" }]);
    for (const o of out) expect(Object.keys(o).sort()).toEqual(["id", "label"]);
    expect(JSON.stringify(out)).not.toMatch(/opus|gpt-x|claude|codex/);
  });

  it("malformed configs and entries give no options rather than guesses", async () => {
    const { profileOptions } = await load();
    for (const bad of [null, undefined, 7, "x", {}, { agentProfiles: "no" }]) expect(profileOptions(bad), JSON.stringify(bad)).toEqual([]);
    expect(profileOptions({ agentProfiles: [{ id: "ok", name: "Ok" }, { id: 5, name: "bad id" }, { name: "no id" }, { id: "no-name" }] }).map((o) => o.id)).toEqual(["ok"]);
  });
});

describe("R4.2 StartDialog", () => {
  const props = (mode: "start" | "replace", bound: boolean, closed: string[]) => ({
    hostId: "host-1", projectId: "prj_test", feature: feature(bound), theme, compact: true, mode, onClose: () => void closed.push("closed"),
  });

  it("unbound start requires a profile: Start sends run.start { featureId, profileRef } exactly once after a choice", async () => {
    const { StartDialog } = await load();
    const closed: string[] = [];
    const d = mount(StartDialog, props("start", false, closed));
    let r = d.render();
    expect(r.text).toContain("Coordinator");
    expect(r.text).toContain("Plain helper");
    await tap(r.find(/^\s*start\b/i).at(-1));
    expect(h.state.calls, "no start without a profile").toEqual([]);
    r = d.render();
    await tap(r.find(/Coordinator/)[0]);
    r = d.render();
    await tap(r.find(/^\s*start\b/i).at(-1));
    expect(h.state.calls).toHaveLength(1);
    expect(h.state.calls[0].contract).toBe("run.start");
    expect(h.state.calls[0].input).toMatchObject({ featureId: "f-1", profileRef: "team-coordinator" });
    expect(closed).toEqual(["closed"]);
  });

  it("bound start has no profile picker and sends run.start { featureId } without profileRef", async () => {
    const { StartDialog } = await load();
    const closed: string[] = [];
    const d = mount(StartDialog, props("start", true, closed));
    const r = d.render();
    expect(r.find(/Plain helper/), "no profile choice for a bound feature").toEqual([]);
    await tap(r.find(/^\s*start\b/i).at(-1));
    expect(h.state.calls.map((c) => c.contract)).toEqual(["run.start"]);
    expect(h.state.calls[0].input).toMatchObject({ featureId: "f-1" });
    expect("profileRef" in h.state.calls[0].input).toBe(false);
  });

  it("replace sends coordinator.replace { featureId, profileRef } with no run token", async () => {
    const { StartDialog } = await load();
    const closed: string[] = [];
    const d = mount(StartDialog, props("replace", true, closed));
    let r = d.render();
    await tap(r.find(/Plain helper/)[0]);
    r = d.render();
    await tap(r.find(/replace/i).at(-1));
    expect(h.state.calls.map((c) => c.contract)).toEqual(["coordinator.replace"]);
    expect(h.state.calls[0].input).toMatchObject({ featureId: "f-1", profileRef: "plain" });
    expect("runToken" in h.state.calls[0].input).toBe(false);
  });

  it("a refused start is not retried and the dialog stays open", async () => {
    const { StartDialog } = await load();
    h.state.answer = () => null; // useRoadmapMutation returns null on a refusal (toast shown by the hook)
    const closed: string[] = [];
    const d = mount(StartDialog, props("start", true, closed));
    const r = d.render();
    await tap(r.find(/^\s*start\b/i).at(-1));
    expect(h.state.calls).toHaveLength(1);
    expect(closed).toEqual([]);
  });
});

// R4 successor KensAI c0037: a failed host profile read is not "no profiles configured".
describe("R4 successor c0037: StartDialog separates a failed profile read from an empty one", () => {
  const props = (closed: string[]) => ({ hostId: "host-1", projectId: "prj_test", feature: feature(false), theme, compact: true, mode: "start" as const, onClose: () => void closed.push("closed") });
  it("a failed profile read names the failure, never 'No agent profiles are configured', and Start sends nothing", async () => {
    const { StartDialog } = await load();
    h.state.profilesQuery = { data: undefined, isPending: false, isError: true, error: new Error("host config unreadable") };
    const closed: string[] = [];
    const d = mount(StartDialog, props(closed));
    const r = d.render();
    expect(r.text).not.toContain("No agent profiles are configured");
    expect(r.text, "the read failure is visible").toMatch(/host config unreadable|could not|failed|unavailable/i);
    await tap(r.find(/^\s*start\b/i).at(-1));
    expect(h.state.calls).toEqual([]);
    h.state.profilesQuery = null;
  });

  it("control: a successful empty read keeps 'No agent profiles are configured on this host.'", async () => {
    const { StartDialog } = await load();
    h.state.profilesQuery = { data: [], isPending: false, isError: false };
    const r = mount(StartDialog, props([])).render();
    expect(r.text).toContain("No agent profiles are configured on this host.");
    h.state.profilesQuery = null;
  });
});
