// Task spec row (redesign Stage R1.2, task card §3.3, §3.4), in node: a read-only row rendered by
// calling the REAL TaskSpecRow; React Native and host UI are inert markers, child components are not
// rendered (their text props and children are read). The module is loaded per test, so every case is
// collected while it is missing.
// Limitations: no reconciler, layout, host or native behaviour; this does not prove the live UI.
import { beforeEach, describe, expect, it, vi } from "vitest";

type El = { type: unknown; props: Record<string, any> };

const h = vi.hoisted(() => {
  const state = {
    slots: [] as unknown[],
    index: 0,
    dirty: false,
    effects: [] as Array<() => unknown>,
    calls: [] as Array<{ name: string; input: Record<string, any> }>,
    toasts: [] as string[],
    cacheRevision: null as number | null,
    view: undefined as unknown,
    answers: {} as Record<string, (input: Record<string, any>) => unknown>,
  };
  const useState = (init: unknown) => {
    const i = state.index++;
    if (!(i in state.slots)) state.slots[i] = typeof init === "function" ? (init as () => unknown)() : init;
    const set = (v: unknown) => {
      const next = typeof v === "function" ? (v as (p: unknown) => unknown)(state.slots[i]) : v;
      if (next !== state.slots[i]) {
        state.slots[i] = next;
        state.dirty = true;
      }
    };
    return [state.slots[i], set];
  };
  // Effects run after each render pass (every pass; the components guard their own effects).
  const useEffect = (fn: () => unknown) => void state.effects.push(fn);
  const marker = (name: string) => Object.assign(() => null, { displayName: name });
  const useRpc = (contract: { name: string }) => (input: Record<string, any>) => {
    state.calls.push({ name: contract.name, input });
    const answer = state.answers[contract.name];
    return Promise.resolve(answer ? answer(input) : { ok: true, value: { revision: (input.expectedRevision ?? 0) + 1 } });
  };
  return { state, useState, useEffect, marker, useRpc };
});

vi.mock("react", async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  const passthrough = { useState: h.useState, useEffect: h.useEffect, useCallback: (fn: unknown) => fn, useMemo: (fn: () => unknown) => fn(), useRef: (v: unknown) => ({ current: v }) };
  return { ...real, ...passthrough, default: { ...(real.default as object), ...passthrough } };
});
vi.mock("react-native", () => ({ Text: h.marker("Text"), View: h.marker("View"), Pressable: h.marker("Pressable"), ScrollView: h.marker("RNScrollView") }));
vi.mock("@getpaseo/plugin/client/react-native", () => ({
  TextInput: h.marker("TextInput"),
  ScrollView: h.marker("ScrollView"),
  Modal: Object.assign(h.marker("Modal"), { Content: h.marker("ModalContent") }),
  useToast: () => ({ show: (m: string) => void h.state.toasts.push(m), error: (m: string) => void h.state.toasts.push(m) }),
}));
vi.mock("@getpaseo/plugin/client", () => ({ useRpc: h.useRpc, useWorkspace: () => ({}), useSettings: () => ({ status: "loading" }) }));
vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: h.state.view, isError: false }),
  useQueryClient: () => ({
    getQueryData: (key: unknown[]) => (key.at(-1) === "version" && h.state.cacheRevision !== null ? { status: "ok", revision: h.state.cacheRevision } : undefined),
    getQueriesData: () => [],
    invalidateQueries: async () => undefined,
  }),
}));

const COLORS = new Proxy({} as Record<string, string>, { get: (_t, k) => `#${String(k)}` });
const theme = { colors: COLORS } as never;

beforeEach(() => {
  h.state.calls = [];
  h.state.toasts = [];
  h.state.cacheRevision = null;
  h.state.view = undefined;
  h.state.answers = {};
});


function all(tree: unknown, pred: (el: El) => boolean): El[] {
  const out: El[] = [];
  const walk = (n: unknown) => {
    if (Array.isArray(n)) return n.forEach(walk);
    if (!n || typeof n !== "object") return;
    const el = n as El;
    if (el.props && pred(el)) out.push(el);
    walk(el.props?.children);
  };
  walk(tree);
  return out;
}
const textOf = (n: unknown): string => {
  if (n === null || n === undefined || typeof n === "boolean") return "";
  if (typeof n === "string" || typeof n === "number") return String(n);
  if (Array.isArray(n)) return n.map(textOf).join("");
  const el = n as El;
  return el.props ? textOf(el.props.children) : "";
};
const nameOf = (el: El) => (el.type as { displayName?: string; name?: string })?.displayName ?? (el.type as { name?: string })?.name ?? "";
/** Every visible string: element labels and the text of Text-like leaves (children joined). */
const allText = (tree: unknown) =>
  all(tree, () => true)
    .map((el) => [typeof el.props.label === "string" ? el.props.label : "", ["Text", "Muted", "Heading"].includes(nameOf(el)) ? textOf(el.props.children) : ""].join(" "))
    .join("\n");
const v2Task = (id: string, over: Record<string, unknown> = {}) => ({
  id, title: `Task ${id}`, description: `About ${id}`, dependsOn: [] as string[], parallel: false, completion: "auto", grill: false, dod: "", ...over,
});

const rowPath = "./task-spec-row";
const formatPath = "./plan-format";
const load = async () => (await import(/* @vite-ignore */ rowPath));
const loadFormat = async () => (await import(/* @vite-ignore */ formatPath));
const row = async (task: unknown, titles: Record<string, string> = {}) => {
  const m = await load();
  const f = await loadFormat();
  return allText(m.TaskSpecRow({ spec: f.taskSpec(task), titles, theme, compact: false }));
};

describe("TaskSpecRow (§3.3)", () => {
  it("a legacy task shows its title and description and no v2 line", async () => {
    const text = await row({ id: "t1", title: "Build the parser", description: "Use the grammar" });
    expect(text).toContain("Build the parser");
    expect(text).toContain("Use the grammar");
    expect(text).not.toMatch(/Completion:|Grill:|No DoD yet|Parallel|Check:/);
  });

  it("a v2 task shows dependencies by title, Parallel, completion, grill and DoD items", async () => {
    const text = await row(v2Task("t2", { title: "Ship", dependsOn: ["t1"], parallel: true, completion: "human", grill: true, dod: "- [check] npm test\nDocs updated" }), { t1: "Build the parser" });
    expect(text).toContain("Ship");
    expect(text).toContain("Build the parser");
    expect(text).toContain("Parallel");
    expect(text).toContain("Completion: needs human acceptance");
    expect(text).toContain("Grill: yes");
    expect(text).toContain("Check: npm test");
    expect(text).toContain("Docs updated");
    expect(text).not.toContain("No DoD yet");
  });

  it("automatic completion, Grill: no, no Parallel when not granted, and No DoD yet when empty", async () => {
    const text = await row(v2Task("t3", { dod: "" }));
    expect(text).toContain("Completion: automatic after checks and review");
    expect(text).toContain("Grill: no");
    expect(text).toContain("No DoD yet");
    expect(text).not.toContain("Parallel");
  });

  it("is read-only: no element with a press or change handler", async () => {
    const m = await load();
    const f = await loadFormat();
    const tree = m.TaskSpecRow({ spec: f.taskSpec(v2Task("t4", { dod: "x" })), titles: {}, theme, compact: true });
    expect(all(tree, (el) => typeof (el.props.onPress ?? el.props.onChange ?? el.props.onChangeText ?? el.props.onValueChange) === "function")).toEqual([]);
  });
});
