// Automatic grilling S3/G5 (S3-TASKS §3.4, §4 P1–P2): the planner picker. P1 is the pure candidate
// list; P2 calls the REAL PlannerPicker with the REAL usePlannerAgents and useRoadmapMutation over
// mocked React, React Native, react-query (a cache keyed by queryKey, as the real one) and the plugin
// client (a recording usePaseo fake and useRpc). Child components are not rendered.
// Limitations: no reconciler, layout, host or native behaviour, no live agent list; this does not
// prove the live UI (G7).
import type { PluginTheme } from "@getpaseo/plugin";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { isRecord } from "../shared/canonical";

const h = vi.hoisted(() => {
  const state = {
    slots: [] as unknown[],
    index: 0,
    dirty: false,
    effects: [] as Array<() => unknown>,
    calls: [] as Array<{ name: string; input: unknown }>,
    answers: new Map<string, () => Promise<unknown>>(),
    toasts: [] as string[],
    listCalls: [] as unknown[],
    forbidden: [] as string[],
    listResult: (): Promise<unknown> => Promise.resolve({ entries: [], pageInfo: { nextCursor: null, prevCursor: null, hasMore: false } }),
    cache: new Map<string, { status: "pending" | "ok" | "error"; data?: unknown }>(),
  };
  const useState = (init: unknown) => {
    const i = state.index++;
    if (!(i in state.slots)) {
      const first: unknown = typeof init === "function" ? Reflect.apply(init, undefined, []) : init;
      state.slots[i] = first;
    }
    const set = (v: unknown) => {
      const next: unknown = typeof v === "function" ? Reflect.apply(v, undefined, [state.slots[i]]) : v;
      if (next !== state.slots[i]) {
        state.slots[i] = next;
        state.dirty = true;
      }
    };
    return [state.slots[i], set];
  };
  const useEffect = (fn: () => unknown) => void state.effects.push(fn);
  const marker = (name: string) => Object.assign(() => null, { displayName: name });
  const record = (what: string) => () => {
    state.forbidden.push(what);
    return Promise.resolve(undefined);
  };
  const paseo = {
    agents: {
      list: (options: unknown) => {
        state.listCalls.push(options);
        return state.listResult();
      },
      ref: (id: unknown) => {
        state.forbidden.push(`agents.ref(${String(id)})`);
        return { send: record("send"), run: record("run"), respondToPermission: record("respondToPermission"), refresh: record("refresh") };
      },
      create: record("agents.create"),
    },
  };
  return { state, useState, useEffect, marker, paseo };
});

vi.mock("react", async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  const passthrough = { useState: h.useState, useEffect: h.useEffect, useCallback: (fn: unknown) => fn, useMemo: (fn: () => unknown) => fn(), useRef: (v: unknown) => ({ current: v }) };
  const realDefault: unknown = real.default;
  return { ...real, ...passthrough, default: { ...(typeof realDefault === "object" && realDefault !== null ? realDefault : {}), ...passthrough } };
});
vi.mock("react-native", () => ({ Text: h.marker("Text"), View: h.marker("View"), Pressable: h.marker("Pressable"), ScrollView: h.marker("RNScrollView") }));
vi.mock("@getpaseo/plugin/client/react-native", () => ({
  TextInput: h.marker("TextInput"),
  ScrollView: h.marker("ScrollView"),
  Modal: Object.assign(h.marker("Modal"), { Content: h.marker("ModalContent") }),
  useToast: () => ({ show: (m: string) => void h.state.toasts.push(m), error: (m: string) => void h.state.toasts.push(m) }),
}));
vi.mock("@getpaseo/plugin/client", () => ({
  useRpc: (contract: { name: string }) => (input: unknown) => {
    h.state.calls.push({ name: contract.name, input });
    const answer = h.state.answers.get(contract.name);
    return answer ? answer() : Promise.resolve({ ok: true, value: { revision: 8, epoch: 2 } });
  },
  usePaseo: () => h.paseo,
  useAgent: () => null,
  useWorkspace: () => ({}),
  useSettings: () => ({ status: "loading" }),
}));
vi.mock("@tanstack/react-query", () => ({
  // A cache keyed by queryKey, like react-query: a key's queryFn runs once; the same key returns the cached result.
  useQuery: (opts: { queryKey: unknown[]; queryFn?: () => Promise<unknown>; enabled?: boolean }) => {
    const key = JSON.stringify(opts.queryKey);
    if (opts.enabled !== false && typeof opts.queryFn === "function" && !h.state.cache.has(key)) {
      h.state.cache.set(key, { status: "pending" });
      opts.queryFn().then(
        (data) => void h.state.cache.set(key, { status: "ok", data }),
        () => void h.state.cache.set(key, { status: "error" }),
      );
    }
    const entry = opts.enabled === false ? undefined : h.state.cache.get(key);
    const status = entry?.status ?? "pending";
    return {
      data: entry?.data,
      status: status === "ok" ? "success" : status,
      isLoading: status === "pending",
      isPending: status === "pending",
      isError: status === "error",
      isSuccess: status === "ok",
      error: status === "error" ? new Error("list failed") : null,
    };
  },
  useQueryClient: () => ({ getQueryData: () => undefined, getQueriesData: () => [], invalidateQueries: async () => undefined }),
}));

// A variable path (as the sibling component tests use): a literal import would pull the RN component
// and React Native's global types into the node TypeScript program. The module is read as `unknown`
// and each export is checked at runtime, so a missing module or export fails the case by name.
const pickerPath = "./planner-picker";
async function load() {
  const mod: unknown = await import(/* @vite-ignore */ pickerPath).catch((e: unknown) => {
    throw new Error(`missing module client/planner-picker.tsx: ${String(e)}`);
  });
  const pick = (name: string) => {
    const fn: unknown = isRecord(mod) ? mod[name] : undefined;
    if (typeof fn !== "function") throw new Error(`missing export client/planner-picker.${name}`);
    return (...args: unknown[]): unknown => {
      const out: unknown = Reflect.apply(fn, undefined, args);
      return out;
    };
  };
  return { plannerCandidates: pick("plannerCandidates"), PlannerPicker: pick("PlannerPicker") };
}

const colorBase: Record<string, string> = {};
const COLORS = new Proxy(colorBase, { get: (_t, k) => `#${String(k)}` });
// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test theme: every colour token resolves to a placeholder string
const theme = { colors: COLORS } as unknown as PluginTheme;
const HOST = "h1";
const P = "prj_test";

beforeEach(() => {
  h.state.calls = [];
  h.state.answers = new Map();
  h.state.toasts = [];
  h.state.listCalls = [];
  h.state.forbidden = [];
  h.state.cache = new Map();
  h.state.listResult = () => Promise.resolve({ entries: [], pageInfo: { nextCursor: null, prevCursor: null, hasMore: false } });
});

// ---- Tree helpers (typed: unknown + guards) ----
type El = { type: unknown; props: Record<string, unknown> };
const asEl = (n: unknown): El | undefined => (isRecord(n) && isRecord(n.props) ? { type: n.type, props: n.props } : undefined);
function all(tree: unknown, pred: (el: El) => boolean): El[] {
  const out: El[] = [];
  const walk = (n: unknown): void => {
    if (Array.isArray(n)) {
      for (const c of n) walk(c);
      return;
    }
    const el = asEl(n);
    if (el === undefined) return;
    if (pred(el)) out.push(el);
    walk(el.props.children);
  };
  walk(tree);
  return out;
}
const textOf = (n: unknown): string => {
  if (typeof n === "string" || typeof n === "number") return String(n);
  if (Array.isArray(n)) return n.map(textOf).join("");
  const el = asEl(n);
  return el ? textOf(el.props.children) : "";
};
const labelOf = (el: El): string =>
  typeof el.props.label === "string" ? el.props.label : typeof el.props.accessibilityLabel === "string" ? el.props.accessibilityLabel : textOf(el.props.children);
const onPressOf = (el: El): (() => void) | undefined => {
  const handler = el.props.onPress;
  return typeof handler === "function" ? () => void Reflect.apply(handler, undefined, []) : undefined;
};
const pressables = (tree: unknown, label: RegExp) => all(tree, (el) => onPressOf(el) !== undefined && label.test(labelOf(el)));
const allText = (tree: unknown) => all(tree, () => true).map((el) => `${typeof el.props.label === "string" ? el.props.label : ""} ${textOf(el.props.children)}`).join("\n");
const flat = (style: unknown): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  const parts: unknown[] = [style].flat(Infinity);
  for (const part of parts) {
    const value: unknown = typeof part === "function" ? Reflect.apply(part, undefined, [{ pressed: false }]) : part;
    if (isRecord(value)) Object.assign(out, value);
  }
  return out;
};
const flush = async () => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
};

type Props = { hostId: string; projectId: string; sessionId: string; revision: number; currentAgentId: string | null; theme: PluginTheme; onDone(): void };
async function picker(over: Partial<Props> = {}) {
  const m = await load();
  const done: number[] = [];
  let props: Props = { hostId: HOST, projectId: P, sessionId: "S", revision: 7, currentAgentId: null, theme, onDone: () => void done.push(1), ...over };
  const slots: unknown[] = [];
  const render = (next?: Partial<Props>): unknown => {
    if (next) props = { ...props, ...next };
    h.state.slots = slots;
    for (let pass = 0; pass < 30; pass++) {
      h.state.index = 0;
      h.state.dirty = false;
      h.state.effects = [];
      const tree: unknown = m.PlannerPicker(props);
      for (const fn of h.state.effects) fn();
      if (!h.state.dirty) return tree;
    }
    throw new Error("component did not settle");
  };
  return { render, done };
}

// ---- Synthetic agent list entries (FetchAgentsEntry shape, only the read fields) ----
const entry = (id: string, title: string | null, extra: { projectKey?: string; archivedAt?: string | null; internal?: boolean; provider?: string } = {}) => ({
  agent: {
    id,
    provider: extra.provider ?? "claude",
    title,
    status: "idle",
    ...("archivedAt" in extra ? { archivedAt: extra.archivedAt } : {}),
    ...(extra.internal !== undefined ? { internal: extra.internal } : {}),
  },
  project: { projectKey: extra.projectKey ?? P },
});
const page = (entries: unknown[]) => () => Promise.resolve({ entries, pageInfo: { nextCursor: null, prevCursor: null, hasMore: false } });

describe("P1 plannerCandidates", () => {
  it("keeps only this project's live, non-internal agents; labels by title or id; marks current; sorts by label then id; does not mutate", async () => {
    const { plannerCandidates } = await load();
    const entries = [
      entry("agent-z", "Zeta chat"),
      entry("agent-b", null, { provider: "codex" }),
      entry("agent-a2", "Alpha chat"),
      entry("agent-a1", "Alpha chat", { archivedAt: null }),
      entry("agent-other", "Other project", { projectKey: "prj_other" }),
      entry("agent-gone", "Archived", { archivedAt: "2026-10-19T10:00:00.000Z" }),
      entry("agent-int", "Internal", { internal: true }),
      entry("agent-empty", ""),
    ];
    const before = JSON.stringify(entries);
    // Deterministic case-sensitive code-point label order ("A" < "Z" < "a"), then agentId for equal labels.
    expect(plannerCandidates(entries, P, "agent-b")).toEqual([
      { agentId: "agent-a1", label: "Alpha chat", provider: "claude", current: false },
      { agentId: "agent-a2", label: "Alpha chat", provider: "claude", current: false },
      { agentId: "agent-z", label: "Zeta chat", provider: "claude", current: false },
      { agentId: "agent-b", label: "agent-b", provider: "codex", current: true },
      { agentId: "agent-empty", label: "agent-empty", provider: "claude", current: false },
    ]);
    expect(JSON.stringify(entries)).toBe(before);
    const none: unknown = plannerCandidates(entries, P, null);
    expect(Array.isArray(none) && none.some((c: unknown) => isRecord(c) && c.current === true)).toBe(false);
  });
});

describe("P2 PlannerPicker", () => {
  it("lists this project's agents on the panel host (one page of 200, no subscription) and never calls ref/send/run/respond/create", async () => {
    h.state.listResult = page([entry("agent-a", "Alpha chat"), entry("agent-b", "Beta chat")]);
    const p = await picker();
    expect(allText(p.render())).toContain("Loading chats…");
    await flush();
    const tree = p.render();
    expect(h.state.listCalls).toEqual([{ filter: { projectKeys: [P], includeArchived: false }, page: { limit: 200 } }]);
    expect(pressables(tree, /Alpha chat/).length).toBe(1);
    expect(pressables(tree, /Beta chat/).length).toBe(1);
    expect(h.state.forbidden).toEqual([]);
  });

  it("rows are at least 44 px high", async () => {
    h.state.listResult = page([entry("agent-a", "Alpha chat"), entry("agent-b", "Beta chat")]);
    const p = await picker();
    p.render();
    await flush();
    const rows = pressables(p.render(), /Alpha chat|Beta chat/);
    expect(rows.length).toBe(2);
    for (const r of rows) expect(Number(flat(r.props.style).minHeight ?? 0), labelOf(r)).toBeGreaterThanOrEqual(44);
  });

  it("pressing a row rebinds through session.planner.set at the given revision; rows and Cancel are disabled while pending; success calls onDone once", async () => {
    h.state.listResult = page([entry("agent-a", "Alpha chat"), entry("agent-b", "Beta chat")]);
    let release: (v: unknown) => void = () => undefined;
    h.state.answers.set("session.planner.set", () => new Promise((r) => (release = r)));
    const p = await picker({ currentAgentId: "agent-a" });
    p.render();
    await flush();
    const row = pressables(p.render(), /Beta chat/)[0];
    onPressOf(row)?.();
    const during = p.render();
    expect(h.state.calls).toEqual([{ name: "session.planner.set", input: { sessionId: "S", agentId: "agent-b", projectId: P, expectedRevision: 7 } }]);
    const disabledOf = (el: El) => el.props.disabled === true;
    const controls = pressables(during, /Alpha chat|Beta chat|^Cancel$/);
    expect(controls.length).toBe(3);
    for (const c of controls) expect(disabledOf(c), labelOf(c)).toBe(true);
    release({ ok: true, value: { revision: 8, epoch: 2 } });
    await flush();
    p.render();
    expect(p.done).toEqual([1]);
    expect(h.state.forbidden).toEqual([]);
  });

  it("a failed rebind (revision_conflict) keeps the picker open: no onDone, the rows stay", async () => {
    h.state.listResult = page([entry("agent-a", "Alpha chat")]);
    h.state.answers.set("session.planner.set", () => Promise.resolve({ ok: false, error: { code: "revision_conflict", message: "stale" } }));
    const p = await picker();
    p.render();
    await flush();
    onPressOf(pressables(p.render(), /Alpha chat/)[0])?.();
    await flush();
    const tree = p.render();
    expect(p.done).toEqual([]);
    expect(pressables(tree, /Alpha chat/).length).toBe(1);
    expect(h.state.calls.length).toBe(1);
  });

  it("Cancel closes without any RPC", async () => {
    h.state.listResult = page([entry("agent-a", "Alpha chat")]);
    const p = await picker();
    p.render();
    await flush();
    onPressOf(pressables(p.render(), /^Cancel$/)[0])?.();
    await flush();
    expect(p.done).toEqual([1]);
    expect(h.state.calls).toEqual([]);
  });

  it("the current marker follows a rebind (currentAgentId changes with the same host and project)", async () => {
    h.state.listResult = page([entry("agent-a", "Alpha chat"), entry("agent-b", "Beta chat")]);
    const p = await picker({ currentAgentId: "agent-a" });
    p.render();
    await flush();
    const rowText = (tree: unknown, label: RegExp) => pressables(tree, label).map((el) => textOf(el.props.children) + " " + labelOf(el)).join(" ");
    let tree = p.render();
    expect(rowText(tree, /Alpha chat/)).toMatch(/current/i);
    expect(rowText(tree, /Beta chat/)).not.toMatch(/current/i);
    p.render({ currentAgentId: "agent-b" });
    await flush();
    tree = p.render();
    expect(rowText(tree, /Beta chat/), "the new planner is marked current").toMatch(/current/i);
    expect(rowText(tree, /Alpha chat/), "the previous planner is no longer marked").not.toMatch(/current/i);
  });

  // KensAI c33; S3-TASKS §3.4 "Selecting the current planner is allowed … a legitimate rebind (S2); it is not hidden."
  it("the current planner's row is enabled; pressing it rebinds the same agent at the rendered revision", async () => {
    h.state.listResult = page([entry("agent-a", "Alpha chat"), entry("agent-b", "Beta chat")]);
    h.state.answers.set("session.planner.set", () => Promise.resolve({ ok: true, value: { revision: 8, epoch: 2 } }));
    const p = await picker({ currentAgentId: "agent-a" });
    p.render();
    await flush();
    const current = pressables(p.render(), /Alpha chat/);
    expect(current.length).toBe(1);
    expect(current[0].props.disabled === true, "the current row is not disabled").toBe(false);
    onPressOf(current[0])?.();
    await flush();
    p.render();
    expect(h.state.calls).toEqual([{ name: "session.planner.set", input: { sessionId: "S", agentId: "agent-a", projectId: P, expectedRevision: 7 } }]);
    expect(p.done).toEqual([1]);
    expect(h.state.forbidden).toEqual([]);
  });

  it("truthful states: an error text when the list fails, and an empty text when no candidate remains", async () => {
    h.state.listResult = () => Promise.reject(new Error("host unavailable"));
    const failing = await picker();
    failing.render();
    await flush();
    expect(allText(failing.render())).toContain("Chats could not be loaded.");
    h.state.cache = new Map();
    // KensAI c10: the internal entry goes through the real usePlannerAgents mapping, so dropping its `internal` field fails here.
    h.state.listResult = page([
      entry("agent-other", "Other", { projectKey: "prj_other" }),
      entry("agent-gone", "Gone", { archivedAt: "2026-10-19T10:00:00.000Z" }),
      entry("agent-int", "Internal", { internal: true }),
    ]);
    const empty = await picker();
    empty.render();
    await flush();
    expect(allText(empty.render())).toContain("No other chats in this project.");
    expect(h.state.forbidden).toEqual([]);
  });
});
