// Panel integration (redesign Stage R1.4, task card §5.2, §5.3), in node: the REAL RoadmapPanel and
// the panel's own internal components (ProjectRoadmap, its screens) run, with the REAL hooks from
// client/hooks.ts over a `useQuery` mock that answers per key and a recording `useRpc`. The panel's
// internal function components are expanded in place, each with its own hook slots (by tree path);
// the exported screens of other modules (RoadmapScreen, FeatureScreen, GrillingBlocks, PlanView,
// MapView, …) stay elements, so their props are read and their handlers invoked.
// Limitations: no reconciler, layout, host or native behaviour; the height checks read style props
// along the element tree and do not prove on-device persistence.
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type El = { type: unknown; props: Record<string, any> };
type Call = { name: string; input: Record<string, any> };

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
    queries: [] as any[],
    query: (_key: unknown[]): any => ({}),
    // Each distinct enabled query key runs its real queryFn exactly once (no retry, no refetch);
    // the promises are drained before each test ends.
    ran: new Set<string>(),
    pending: [] as Array<Promise<unknown>>,
    invalidations: [] as unknown[],
    // R4 final KensAI c0014: listeners the panel registers through ./slash subscribePendingRoute.
    subscriptions: [] as Array<() => void>,
    // R4 final DeepSeek c0083: opt-in dependency-aware effects (per component slot, deps compared with
    // Object.is, the previous cleanup run before a re-run). Off by default: every other test keeps the
    // rerun-every-pass behaviour. No unmount cleanup is modelled.
    depsAware: false,
  };
  const useState = (init: unknown) => {
    // The slot array of the component rendering now: a setter called later (from a handler, after
    // another component rendered) must read and write this component's own slots.
    const slots = state.slots;
    const i = state.index++;
    if (!(i in slots)) slots[i] = typeof init === "function" ? (init as () => unknown)() : init;
    const set = (v: unknown) => {
      const next = typeof v === "function" ? (v as (p: unknown) => unknown)(slots[i]) : v;
      if (next !== slots[i]) {
        slots[i] = next;
        state.dirty = true;
      }
    };
    return [slots[i], set];
  };
  // Effects run after each render pass (every pass; the components guard their own effects).
  const useEffect = (fn: () => unknown, deps?: unknown[]) => {
    if (!state.depsAware) return void state.effects.push(fn);
    const slots = state.slots;
    const i = state.index++;
    const prev = slots[i] as { deps?: unknown[]; cleanup?: unknown } | undefined;
    const same = prev !== undefined && deps !== undefined && prev.deps !== undefined && deps.length === prev.deps.length && deps.every((d, k) => Object.is(d, prev.deps![k]));
    if (same) return;
    const record: { deps?: unknown[]; cleanup?: unknown } = { deps, cleanup: prev?.cleanup };
    slots[i] = record;
    state.effects.push(() => {
      if (typeof record.cleanup === "function") (record.cleanup as () => void)();
      record.cleanup = fn();
    });
  };
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
// R4 final KensAI c0014: the real ./slash module, with subscribePendingRoute recorded (it still registers
// the listener with the real store, so setPendingRoute notifies it exactly as in production).
vi.mock("./slash", async (importOriginal) => {
  const real = await importOriginal<typeof import("./slash")>();
  return {
    ...real,
    subscribePendingRoute: (listener: () => void) => {
      h.state.subscriptions.push(listener);
      return real.subscribePendingRoute(listener);
    },
  };
});
vi.mock("react-native", () => ({
  Text: h.marker("Text"),
  View: h.marker("View"),
  Pressable: h.marker("Pressable"),
  ScrollView: h.marker("RNScrollView"),
  // R4.2 harness completeness (root-authorised): FeatureScreen now imports FeatureChat, which reads
  // React Native's Platform and uses FlatList/TextInput at module level.
  FlatList: h.marker("RNFlatList"),
  TextInput: h.marker("RNTextInput"),
  KeyboardAvoidingView: h.marker("KeyboardAvoidingView"),
  Platform: { OS: "ios", select: (o: Record<string, unknown>) => o.ios ?? o.default },
}));
vi.mock("@getpaseo/plugin/client/react-native", () => ({
  TextInput: h.marker("TextInput"),
  ScrollView: h.marker("ScrollView"),
  Modal: Object.assign(h.marker("Modal"), { Content: h.marker("ModalContent") }),
  FlatList: h.marker("FlatList"),
  useToast: () => ({ show: (m: string) => void h.state.toasts.push(m), error: (m: string) => void h.state.toasts.push(m) }),
}));
vi.mock("@getpaseo/plugin/client", () => ({
  useRpc: h.useRpc,
  useWorkspace: (_id: string, select?: (w: { projectId: string }) => unknown) => (select ? select({ projectId: "prj_test" }) : { projectId: "prj_test" }),
  useSettings: () => ({ status: "loading" }),
  usePaseo: () => null,
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: (opts: any) => {
    h.state.queries.push(opts);
    const id = JSON.stringify(opts.queryKey);
    if (opts.enabled !== false && typeof opts.queryFn === "function" && !h.state.ran.has(id)) {
      h.state.ran.add(id);
      h.state.pending.push(Promise.resolve().then(() => opts.queryFn()).then(() => undefined, () => undefined));
    }
    return h.state.query(opts.queryKey as unknown[]);
  },
  useQueryClient: () => ({
    getQueryData: (key: unknown[]) => (key.at(-1) === "version" && h.state.cacheRevision !== null ? { status: "ok", revision: h.state.cacheRevision } : undefined),
    getQueriesData: () => [],
    invalidateQueries: async (filters: unknown) => {
      h.state.invalidations.push(filters);
    },
  }),
}));

const COLORS = new Proxy({} as Record<string, string>, { get: (_t, k) => `#${String(k)}` });
const theme = { colors: COLORS } as never;
const HOST = "h1";
const P = "prj_test";
const AT = "2026-10-20T10:00:00.000Z";

beforeEach(() => {
  h.state.calls = [];
  h.state.toasts = [];
  h.state.cacheRevision = null;
  h.state.view = undefined;
  h.state.answers = {};
  h.state.depsAware = false;
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
const labelOf = (el: El): string => String(el.props.label ?? el.props.accessibilityLabel ?? textOf(el.props.children) ?? "");
const handlerOf = (el: El) => el.props.onPress ?? el.props.onChange ?? el.props.onValueChange;
const pressables = (tree: unknown, label: RegExp) => all(tree, (el) => typeof handlerOf(el) === "function" && label.test(labelOf(el)));
/** Every visible string: element labels and the text of Text-like leaves (children joined). */
const allText = (tree: unknown) =>
  all(tree, () => true)
    .map((el) => [typeof el.props.label === "string" ? el.props.label : "", ["Text", "Muted", "Heading"].includes(nameOf(el)) ? textOf(el.props.children) : ""].join(" "))
    .join("\n");
const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};
const press = async (el: El, value: unknown = true) => {
  if (el.props.onPress) el.props.onPress();
  else handlerOf(el)(value);
  await flush();
};
const calls = (name: string): Call[] => h.state.calls.filter((c) => c.name === name);

// ---- Synthetic session views (hand-built SessionView values) ----
const ab = [{ id: "a", label: "Option A", description: "Because A" }, { id: "b", label: "Option B" }];
const answerOf = (optionId: string, note?: string) => ({ rev: 1, optionId, source: "ui", actor: { kind: "human" }, at: AT, ...(note ? { note } : {}) });
function q(id: string, title: string, extra: Record<string, unknown> = {}): any {
  return {
    id, order: 0, title, context: "", options: ab, allowFreeText: false, definitionRev: 1, activatedBy: [], invalidatedBy: [],
    revisions: [], discussion: [{ id: "n1", at: AT, actor: { kind: "agent", agentId: "ag" }, text: "Stored discussion" }], validity: "valid", ...extra,
  };
}
const qv = (question: any, status = question.answer ? "answered" : "open") => ({ question, visibility: "active", status, depth: 0 });
const cancel = (sessionId: string, questionId: string, reason: string) => ({ id: `c-${questionId}`, ref: { sessionId, questionId }, reason, at: AT, actor: { kind: "human" } });
/**
 * Blocked session S: accepted b1 (q1 answered a with a note; q2 unanswered and cancelled), open b2
 * (q3 answered and replaced by q4 and cancelled; q4 open; q5 cancelled; q6 stale, not cancelled).
 * q1 is replaced cross-session by T/t1.
 */
function blockedView(over: Record<string, unknown> = {}): any {
  const questions = [
    q("q1", "Q1 frozen", { blockId: "b1", answer: answerOf("a", "because") }),
    q("q2", "Q2 frozen cancelled", { blockId: "b1" }),
    q("q3", "Q3 replaced", { blockId: "b2", answer: answerOf("b") }),
    q("q4", "Q4 open", { blockId: "b2", recommendedOptionId: "b" }),
    q("q5", "Q5 cancelled", { blockId: "b2" }),
    q("q6", "Q6 stale", { blockId: "b2", answer: answerOf("a"), validity: "stale" }),
  ];
  return {
    revision: 7,
    session: {
      id: "S", title: "Session S", createdAt: AT, status: "active",
      blocks: [
        { id: "b1", order: 0, state: "accepted", openedAt: AT, acceptedAt: AT, acceptedBy: { kind: "human" } },
        { id: "b2", order: 1, state: "open", openedAt: AT },
      ],
    },
    cancellations: [cancel("S", "q2", "Out of scope"), cancel("S", "q5", "Dropped"), cancel("S", "q3", "Superseded")],
    questions: questions.map((x) => qv(x, x.validity === "stale" ? "stale" : x.answer ? "answered" : "open")),
    links: [
      { id: "l1", kind: "supersedes", from: { sessionId: "S", questionId: "q4" }, to: { sessionId: "S", questionId: "q3" } },
      { id: "l2", kind: "supersedes", from: { sessionId: "T", questionId: "t1" }, to: { sessionId: "S", questionId: "q1" } },
    ],
    catalog: [
      ...questions.map((x) => ({ ref: { sessionId: "S", questionId: x.id }, sessionTitle: "Session S", questionTitle: x.title, options: ab, status: "open" })),
      { ref: { sessionId: "T", questionId: "t1" }, sessionTitle: "Session T", questionTitle: "T1 replacement", options: ab, status: "answered" },
    ],
    ...over,
  };
}
/** Legacy session L (no blocks): l1 answered, l2 open, l3 cancelled. */
function legacyView(status: "active" | "closed" = "active"): any {
  const questions = [q("l1", "L1", { answer: answerOf("a") }), q("l2", "L2"), q("l3", "L3")];
  return {
    revision: 4,
    session: { id: "L", title: "Legacy", createdAt: AT, status },
    cancellations: [cancel("L", "l3", "Not needed")],
    questions: questions.map((x) => qv(x)),
    links: [],
    catalog: questions.map((x) => ({ ref: { sessionId: "L", questionId: x.id }, sessionTitle: "Legacy", questionTitle: x.title, options: ab, status: "open" })),
  };
}
const flat = (style: unknown) => Object.assign({}, ...[style].flat(Infinity).filter(Boolean).map((s: any) => (typeof s === "function" ? s({ pressed: false }) : s)));
const keyOf = (el: El) => (el as unknown as { key: string | null }).key;

const panelPath = "./panel";
const OTHER_MODULES = ["./ui", "./roadmap-screen", "./feature-screen", "./grilling-blocks", "./map-view", "./plan-view", "./question-card", "./question-editor", "./plans-list", "./question-answer-panel", "./relations-editor", "./dod-editor", "./task-spec-row", "./tracker-list", "./tracker-preview"];
async function external(): Promise<Set<unknown>> {
  const out = new Set<unknown>();
  for (const p of OTHER_MODULES) {
    const mod = (await import(/* @vite-ignore */ String(p))) as Record<string, unknown>;
    for (const v of Object.values(mod)) if (typeof v === "function") out.add(v);
  }
  return out;
}
const mods = async () => ({
  panel: (await import(/* @vite-ignore */ panelPath)),
  rs: (await import(/* @vite-ignore */ String("./roadmap-screen"))),
  fs: (await import(/* @vite-ignore */ String("./feature-screen"))),
  gb: (await import(/* @vite-ignore */ String("./grilling-blocks"))),
  pv: (await import(/* @vite-ignore */ String("./plan-view"))),
  mv: (await import(/* @vite-ignore */ String("./map-view"))),
  qc: (await import(/* @vite-ignore */ String("./question-card"))),
});

// ---- Data per query key ----
const features = [
  { id: "f1", title: "Feature one", description: "", kind: "feature", status: "created", dependsOn: [], relatedTo: [], everStarted: false, createdAt: AT, createdBy: { kind: "human" }, coordinatorHistory: [], events: [] },
  { id: "f2", title: "Feature two", description: "", kind: "bug", status: "done", dependsOn: [], relatedTo: [], everStarted: true, createdAt: AT, createdBy: { kind: "human" }, coordinatorHistory: [], events: [] },
];
const plans = [{ id: "p1", title: "Plan one", latestRev: 1, approval: "unapproved", featureId: "f1" }, { id: "p2", title: "Plan two", latestRev: 1, approval: "unapproved" }];
const overview = { revision: 5, disabled: false, sessions: [{ id: "S", title: "Session S", status: "active", counts: { open: 1, answered: 1, stale: 0, skipped: 0, inactive: 0 } }], links: [] };
const tView = () => ({ ...legacyView(), session: { id: "T", title: "Session T", createdAt: AT, status: "active" }, questions: [qv(q("t1", "T1 replacement"))], cancellations: [] });
let featureState: any;
let planState: any;
afterEach(async () => {
  await Promise.allSettled(h.state.pending);
});
beforeEach(() => {
  h.state.ran = new Set();
  h.state.pending = [];
  h.state.invalidations = [];
  featureState = { data: { revision: 5, features }, isPending: false, isError: false };
  planState = { data: { revision: 5, plans }, isError: false, isPending: false };
  h.state.query = (key: unknown[]) => {
    switch (key[3]) {
      case "version":
        return { data: { status: "ok", revision: 5 }, isError: false, isPending: false };
      case "overview":
        return { data: overview, isError: false, isPending: false };
      case "session":
        return { data: key[4] === "T" ? tView() : blockedView(), isError: false, isPending: false };
      case "features":
        return featureState;
      case "plans":
        return planState;
      default:
        return { data: undefined, isError: false, isPending: true };
    }
  };
});

// ---- Deep render: expand the panel's own components, each with slots keyed by tree path ----
type Node = El & { from?: string };
function deepMount(root: (p: any) => unknown, props: Record<string, unknown>, ext: Set<unknown>) {
  const store = new Map<string, unknown[]>();
  const expand = (node: unknown, path: string, counts: Map<string, number>): unknown => {
    if (node === null || typeof node !== "object") return node;
    if (Array.isArray(node)) return node.map((n) => expand(n, path, counts));
    const el = node as El;
    if (typeof el.type === "function" && !(el.type as { displayName?: string }).displayName && !ext.has(el.type)) {
      const name = (el.type as { name?: string }).name || "anon";
      const n = counts.get(name) ?? 0;
      counts.set(name, n + 1);
      const k = `${path}/${name}#${keyOf(el) ?? n}`;
      if (!store.has(k)) store.set(k, []);
      const saved = { slots: h.state.slots, index: h.state.index };
      h.state.slots = store.get(k)!;
      h.state.index = 0;
      const out = (el.type as (p: unknown) => unknown)(el.props);
      h.state.slots = saved.slots;
      h.state.index = saved.index;
      const expanded = expand(out, k, new Map()) as Node;
      if (expanded && typeof expanded === "object" && !Array.isArray(expanded)) return { ...expanded, from: name };
      return expanded;
    }
    if (!el.props) return el;
    return { ...el, props: { ...el.props, children: expand(el.props.children, path, counts) } };
  };
  const render = (): Node => {
    for (let pass = 0; pass < 40; pass++) {
      h.state.dirty = false;
      h.state.effects = [];
      const tree = expand({ type: root, props, key: null } as unknown as El, "", new Map()) as Node;
      for (const fn of h.state.effects) fn();
      if (!h.state.dirty) return tree;
    }
    throw new Error("panel did not settle");
  };
  return { render };
}
/** Ancestors of the first element matching `pred`, root first. */
function ancestorsOf(tree: unknown, pred: (el: El) => boolean): Node[] | null {
  const walk = (n: unknown, chain: Node[]): Node[] | null => {
    if (Array.isArray(n)) {
      for (const x of n) {
        const r = walk(x, chain);
        if (r) return r;
      }
      return null;
    }
    if (!n || typeof n !== "object") return null;
    const el = n as Node;
    if (!el.props) return null;
    if (pred(el)) return chain;
    return walk(el.props.children, [...chain, el]);
  };
  return walk(tree, []);
}
const isScroll = (el: El) => ["ScrollView", "RNScrollView", "FlatList"].includes(nameOf(el));

async function panelOf(compactFlag = false) {
  const m = await mods();
  const ext = await external();
  const p = deepMount(m.panel.RoadmapPanel, { theme, layout: { compact: compactFlag }, host: { id: HOST }, workspaceId: "w1" }, ext);
  return { m, p };
}
const only = (tree: unknown, type: unknown, what: string) => {
  const found = all(tree, (el) => el.type === type);
  expect(found.length, what).toBe(1);
  return found[0];
};
async function openSession(p: { render(): Node }) {
  const list = all(p.render(), (el) => nameOf(el) === "FlatList");
  expect(list.length).toBe(1);
  const item = list[0].props.renderItem({ item: overview.sessions[0], index: 0 });
  await press(pressables(item, /Session S/)[0]);
}
async function openRoadmap(p: { render(): Node }) {
  const button = pressables(p.render(), /^Roadmap$/);
  expect(button.length, "one Roadmap button on the overview").toBe(1);
  await press(button[0]);
}

describe("panel routes and back stack (§5.2)", () => {
  it("the overview has one Roadmap button that opens RoadmapScreen with the list's features and revision", async () => {
    const { m, p } = await panelOf();
    expect(all(p.render(), (el) => el.type === m.rs.RoadmapScreen)).toEqual([]);
    await openRoadmap(p);
    const screen = only(p.render(), m.rs.RoadmapScreen, "RoadmapScreen");
    expect(screen.props).toMatchObject({ hostId: HOST, projectId: P, features, revision: 5 });
    expect(h.state.queries.some((q: any) => q.queryKey?.at(-1) === "features" && q.enabled === true)).toBe(true);
  });

  it("the roadmap shows Loading… while the list loads and the error text on failure (control: data renders the screen)", async () => {
    const { m, p } = await panelOf();
    await openRoadmap(p);
    featureState = { data: undefined, isPending: true, isError: false };
    let tree = p.render();
    expect(all(tree, (el) => el.type === m.rs.RoadmapScreen)).toEqual([]);
    expect(allText(tree)).toContain("Loading…");
    featureState = { data: undefined, isPending: false, isError: true, error: new Error("list failed") };
    tree = p.render();
    expect(all(tree, (el) => el.type === m.rs.RoadmapScreen)).toEqual([]);
    expect(allText(tree)).toContain("list failed");
  });

  it("roadmap → feature → plan, then back to feature, roadmap and overview", async () => {
    const { m, p } = await panelOf();
    await openRoadmap(p);
    only(p.render(), m.rs.RoadmapScreen, "roadmap").props.onOpenFeature("f1");
    let feature = only(p.render(), m.fs.FeatureScreen, "feature");
    expect(feature.props.feature).toEqual(features[0]);
    expect(feature.props.features).toEqual(features);
    expect(feature.props.plans).toEqual(plans);
    feature.props.onOpenPlan("p1");
    const plan = only(p.render(), m.pv.PlanView, "plan");
    expect(plan.props.planId).toBe("p1");
    plan.props.onBack();
    feature = only(p.render(), m.fs.FeatureScreen, "feature again");
    expect(feature.props.feature.id).toBe("f1");
    feature.props.onBack();
    only(p.render(), m.rs.RoadmapScreen, "roadmap again").props.onBack();
    const tree = p.render();
    expect(pressables(tree, /^Roadmap$/).length).toBe(1);
    expect(all(tree, (el) => el.type === m.rs.RoadmapScreen || el.type === m.fs.FeatureScreen || el.type === m.pv.PlanView)).toEqual([]);
  });

  it("a feature no longer in the list shows the missing text and a Back control (no dead placeholder)", async () => {
    const { m, p } = await panelOf();
    await openRoadmap(p);
    only(p.render(), m.rs.RoadmapScreen, "roadmap").props.onOpenFeature("ghost");
    const tree = p.render();
    expect(all(tree, (el) => el.type === m.fs.FeatureScreen)).toEqual([]);
    expect(allText(tree)).toContain("This feature no longer exists");
    const back = pressables(tree, /Back/);
    expect(back.length).toBeGreaterThan(0);
    await press(back[0]);
    only(p.render(), m.rs.RoadmapScreen, "back to roadmap");
  });
});

describe("session screen (§5.2)", () => {
  it("renders GrillingBlocks (default) under a bounded chain with no ScrollView ancestor; the header is outside the body", async () => {
    const { m, p } = await panelOf();
    await openSession(p);
    const tree = p.render();
    expect(flat(tree.props.style).flex).toBe(1);
    const grilling = only(tree, m.gb.GrillingBlocks, "GrillingBlocks");
    expect(grilling.props.view.session.id).toBe("S");
    expect(all(tree, (el) => el.type === m.qc.QuestionCard)).toEqual([]);
    const chain = ancestorsOf(tree, (el) => el.type === m.gb.GrillingBlocks)!;
    expect(chain.filter(isScroll), "no ScrollView ancestor").toEqual([]);
    const sessionRoot = chain.find((el) => el.from === "SessionScreen");
    expect(sessionRoot, "SessionScreen root in the chain").toBeDefined();
    expect(flat(sessionRoot!.props.style)).toMatchObject({ flex: 1, minHeight: 0, minWidth: 0 });
    const below = chain.slice(chain.indexOf(sessionRoot!) + 1);
    expect(below.length, "a body View between the session root and GrillingBlocks").toBeGreaterThan(0);
    for (const el of below) expect(flat(el.props.style), nameOf(el)).toMatchObject({ flex: 1, minHeight: 0 });
    const above = chain.slice(0, chain.indexOf(sessionRoot!));
    for (const el of above) expect(flat(el.props.style).flex, `ancestor ${nameOf(el)}`).toBe(1);
    const body = below[0];
    expect(all(body, (el) => el.type === m.gb.ChatMenu), "the Chat menu is in the header, not the body").toEqual([]);
    expect(all(sessionRoot!, (el) => el.type === m.gb.ChatMenu).length).toBe(1);
  });

  it.each([true, false])("R1 §10: the header is a non-shrinking column; Back, the title and the Chat menu share one nonwrapping title row (compact %s)", async (compactFlag) => {
    const { m, p } = await panelOf(compactFlag);
    await openSession(p);
    const tree = p.render();
    const sessionRoot = ancestorsOf(tree, (el) => el.type === m.gb.GrillingBlocks)!.find((el) => el.from === "SessionScreen")!;
    expect(sessionRoot, "SessionScreen root").toBeDefined();
    const isView = (el: El) => nameOf(el) === "View";
    const header = [sessionRoot.props.children].flat(Infinity).find((c: any) => c?.props && isView(c) && pressables(c, /‹ Back/).length > 0) as El | undefined;
    expect(header, "a session root child View holding Back").toBeDefined();
    expect(flat(header!.props.style).flexShrink, "header flexShrink").toBe(0);
    expect(flat(header!.props.style).flexDirection ?? "column", "header is a column").toBe("column");
    const back = pressables(header!, /‹ Back/);
    expect(back.length, "one Back").toBe(1);
    const heading = all(header!, (el) => nameOf(el) === "Heading");
    expect(heading.length, "one title Heading").toBe(1);
    expect(textOf(heading[0].props.children)).toBe("Session S");
    const menu = all(header!, (el) => el.type === m.gb.ChatMenu);
    expect(menu.length, "one Chat menu").toBe(1);
    /** The innermost header container (a View or a scroll view) whose subtree holds every given element. */
    const innermost = (items: El[]) => {
      const holds = all(header!, (el) => ["View", "ScrollView", "RNScrollView"].includes(nameOf(el)) && items.every((x) => all(el, (y) => y === x).length > 0));
      const inner = holds.filter((c) => all(c, (x) => x !== c && holds.includes(x)).length === 0);
      expect(inner.length, "one innermost container").toBe(1);
      return inner[0];
    };
    // DeepSeek Flash review 01a1c6c1 c0111: the title row is the one that holds Back and the title
    // (in compact the Chat menu is on the next row, so the container of all three is the header column).
    const titleRow = innermost([back[0], heading[0]]);
    expect(nameOf(titleRow), "the title row is a View, not a horizontal scroll view").toBe("View");
    expect(flat(titleRow.props.style).flexDirection, "Back and the title share one row").toBe("row");
    expect(flat(titleRow.props.style).flexWrap, "title row does not wrap").not.toBe("wrap");
    const menuRow = innermost([back[0], heading[0], menu[0]]);
    if (compactFlag) {
      expect(all(titleRow, (x) => x === menu[0]), "compact: the Chat menu is not on the title row").toEqual([]);
      expect(flat(menuRow.props.style).flexDirection ?? "column", "compact: the rows stack").toBe("column");
    } else {
      expect(menuRow, "wide: Back, the title and the Chat menu share the title row").toBe(titleRow);
    }
    const titleParent = ancestorsOf(header!, (el) => el === heading[0])!.at(-1)!;
    expect(isView(titleParent), "title wrapped in a View").toBe(true);
    expect(flat(titleParent.props.style)).toMatchObject({ flex: 1, minWidth: 0 });
    for (const re of [/^Grilling$/, /^Map$/, /^Add question$/]) expect(pressables(header!, re), `${re} is not a header button`).toEqual([]);
  });

  it("Grilling/Map switch from the Chat menu: Map shows the MapView in a bounded region; opening a question from the map switches back to Grilling with a new target", async () => {
    const { m, p } = await panelOf();
    await openSession(p);
    expect(pressables(p.render(), /^Map$/), "Map is in the Chat menu").toEqual([]);
    const menu = only(p.render(), m.gb.ChatMenu, "the Chat menu");
    expect(menu.props.mode).toBe("grilling");
    menu.props.onMode("map");
    await flush();
    expect(only(p.render(), m.gb.ChatMenu, "the Chat menu").props.mode).toBe("map");
    let tree = p.render();
    const map = only(tree, m.mv.MapView, "MapView in Map mode");
    expect(all(tree, (el) => el.type === m.gb.GrillingBlocks)).toEqual([]);
    expect(map.props.view.session.id).toBe("S");
    // The map scrolls inside its own bounded region; the panel gives it a flex 1 / minHeight 0 parent.
    const chain = ancestorsOf(tree, (el) => el.type === m.mv.MapView)!;
    expect(chain.some(isScroll), "no ScrollView around the map").toBe(false);
    expect(flat(chain.at(-1)!.props.style)).toMatchObject({ flex: 1, minHeight: 0 });
    expect(typeof map.props.onOpenRef).toBe("function");
    map.props.onOpenQuestion("q6");
    tree = p.render();
    const grilling = only(tree, m.gb.GrillingBlocks, "back to Grilling");
    expect(grilling.props.target).toMatchObject({ questionId: "q6" });
    expect(typeof grilling.props.target.nonce).toBe("number");
    expect(all(tree, (el) => el.type === m.qc.QuestionCard)).toEqual([]);
  });

  it("a same-session onOpenRef sets a new target on the same screen", async () => {
    const { m, p } = await panelOf();
    await openSession(p);
    let g = only(p.render(), m.gb.GrillingBlocks, "grilling");
    expect(typeof g.props.onOpenRef).toBe("function");
    g.props.onOpenRef({ sessionId: "S", questionId: "q2" });
    g = only(p.render(), m.gb.GrillingBlocks, "grilling");
    expect(g.props.view.session.id).toBe("S");
    expect(g.props.target).toMatchObject({ questionId: "q2" });
    const first = g.props.target.nonce;
    g.props.onOpenRef({ sessionId: "S", questionId: "q2" });
    expect(only(p.render(), m.gb.GrillingBlocks, "grilling").props.target.nonce).not.toBe(first);
  });

  it("a cross-session onOpenRef opens the other session with the linked question; Back returns to the previous session", async () => {
    const { m, p } = await panelOf();
    await openSession(p);
    only(p.render(), m.gb.GrillingBlocks, "grilling S").props.onOpenRef({ sessionId: "T", questionId: "t1" });
    let tree = p.render();
    const other = only(tree, m.gb.GrillingBlocks, "grilling T");
    expect(other.props.view.session.id).toBe("T");
    expect(other.props.target).toMatchObject({ questionId: "t1" });
    expect(h.state.queries.some((q: any) => q.queryKey?.[3] === "session" && q.queryKey?.[4] === "T")).toBe(true);
    const back = pressables(tree, /Back|Sessions|‹/);
    expect(back.length).toBeGreaterThan(0);
    await press(back[0]);
    tree = p.render();
    expect(only(tree, m.gb.GrillingBlocks, "grilling S again").props.view.session.id).toBe("S");
  });
});

describe("registration unchanged (§5.1)", () => {
  // R4.5a (root-authorised replacement of the R1.3b byte pin; slash.ts now carries the scoped pending
  // route): the R1 slash invariants kept as behaviour. Exactly one /roadmap workspace command with a
  // description; with no args it opens this panel once and makes no RPC or other host call.
  it("client/slash.ts keeps the R1 /roadmap contribution: one workspace command that opens the panel once and calls nothing else", async () => {
    const { roadmapSlashCommands } = await import("./slash");
    const cmds = roadmapSlashCommands("roadmap");
    expect(cmds.map((c) => [c.name, c.context])).toEqual([["roadmap", "workspace"]]);
    expect(cmds[0].description.trim().length).toBeGreaterThan(0);
    const openPanel = vi.fn();
    const forbidden = vi.fn(() => {
      throw new Error("must not be called");
    });
    await cmds[0].onSubmit({ context: "workspace", workspace: { id: "w-slash", projectId: "prj_slash" }, openPanel, rpc: forbidden, openScreen: forbidden, openSurface: forbidden, openSettings: forbidden, args: "" } as never);
    expect(openPanel).toHaveBeenCalledTimes(1);
    expect(openPanel.mock.calls[0][0]).toBe("roadmap");
    expect(forbidden).not.toHaveBeenCalled();
    const routes = (await import("./slash")) as unknown as { takePendingRoute: (s: unknown) => unknown };
    routes.takePendingRoute({ workspaceId: "w-slash", projectId: "prj_slash" }); // leave no route behind
  });

  // R3.5 (root-authorised adaptation): index.client.tsx gains the run timeline renderer, so its R1.3b
  // byte pin is replaced by the registrations it must keep; the new run renderer is covered by
  // client/run-timeline-card.test.ts.
  it("index.client.tsx keeps the R1.3b panel, command, settings, slash and question-row registrations", () => {
    const src = readFileSync(new URL("../index.client.tsx", import.meta.url), "utf8");
    expect(src).toMatch(/const PANEL_ID = "roadmap";/);
    expect(src.match(/client\.addWorkspacePanel\(/g) ?? []).toHaveLength(1);
    expect(src).toMatch(/addWorkspacePanel\(\{\s*id: PANEL_ID,\s*title: "Decision roadmap",\s*icon: "PanelsTopLeft",\s*context: "workspace",\s*locations: \["workspace", "explorer"\],\s*Component: RoadmapPanel,\s*\}\)/);
    expect(src).toMatch(/addCommandCenterItem\(\{\s*id: "open-roadmap",[\s\S]*?onSelect: \(ctx\) => ctx\.openPanel\(PANEL_ID\),\s*\}\)/);
    expect(src).toMatch(/addSettingsScreen\(\{ id: "tracker", title: "Decision roadmap tracker", icon: "PanelsTopLeft", Component: TrackerSettingsScreen \}\)/);
    expect(src).toMatch(/\.\.\.roadmapSlashCommands\(PANEL_ID\)\.map\(\(command\) => client\.addSlashCommand\(command\)\)/);
    expect((src.match(/addTimelineRenderer\(\{ kind: ROW_KIND, version: ROW_VERSION, schema: RowData, Component: DecisionTimelineCard \}\)/g) ?? [])).toHaveLength(1);
    expect(src).toMatch(/return \(\) => cleanups\.forEach\(\(c\) => void c\(\)\);/);
  });
});

// R1.4 navigation regression (root-identified): a route whose list is loading or failed still offers a
// working Back, so no route is a dead end. The request is not retried and nothing is invalidated here.
describe("R1.4 Back while a route's data is loading or failed", () => {
  const LOADING = { data: undefined, isPending: true, isError: false };
  const FAILED = { data: undefined, isPending: false, isError: true, error: new Error("load failed") };
  const backOf = (tree: unknown) => {
    const b = pressables(tree, /Back|‹/);
    expect(b.length, "a Back control").toBeGreaterThan(0);
    return b[0];
  };

  for (const [label, state] of [["loading", LOADING], ["failed", FAILED]] as const) {
    it(`roadmap with the feature list ${label}: Back returns to the overview`, async () => {
      const { m, p } = await panelOf();
      await openRoadmap(p);
      only(p.render(), m.rs.RoadmapScreen, "roadmap (control)");
      featureState = state;
      const tree = p.render();
      expect(all(tree, (el) => el.type === m.rs.RoadmapScreen)).toEqual([]);
      await press(backOf(tree));
      expect(pressables(p.render(), /^Roadmap$/).length).toBe(1);
      await flush();
      // The list was requested once when the route opened; Back neither retries nor invalidates.
      expect(calls("feature.list").map((c) => c.input)).toEqual([{ projectId: P }]);
      expect(h.state.invalidations).toEqual([]);
    });

    it(`feature with the feature list ${label}: Back returns to the roadmap`, async () => {
      const { m, p } = await panelOf();
      await openRoadmap(p);
      only(p.render(), m.rs.RoadmapScreen, "roadmap").props.onOpenFeature("f1");
      only(p.render(), m.fs.FeatureScreen, "feature (control)");
      featureState = state;
      await press(backOf(p.render()));
      featureState = { data: { revision: 5, features }, isPending: false, isError: false };
      only(p.render(), m.rs.RoadmapScreen, "back to roadmap");
    });

    it(`feature with the plan list ${label}: Back returns to the roadmap`, async () => {
      const { m, p } = await panelOf();
      await openRoadmap(p);
      only(p.render(), m.rs.RoadmapScreen, "roadmap").props.onOpenFeature("f1");
      only(p.render(), m.fs.FeatureScreen, "feature (control)");
      planState = state;
      const tree = p.render();
      await press(backOf(tree));
      only(p.render(), m.rs.RoadmapScreen, "back to roadmap");
      await flush();
      expect(calls("plan.list").map((c) => c.input)).toEqual([{ projectId: P }]);
      expect(calls("feature.list").length).toBe(1);
      expect(h.state.invalidations).toEqual([]);
    });
  }
});

// R1 review c0003 (harness control): the query mock runs each distinct enabled key's real queryFn
// exactly once, so list requests are observable; disabled keys never run.
describe("R1 review c0003/c0052: ProjectRoadmap's own list queries per route", () => {
  // The overview footer's PlansList also uses the plans key (enabled by default); the harness does not
  // expand FlatList's ListFooterComponent, so this control asserts only ProjectRoadmap's own queries.
  const flags = () => {
    const last = (kind: string) => [...h.state.queries].reverse().find((q: any) => q.queryKey?.[3] === kind);
    return { features: last("features")?.enabled, plans: last("plans")?.enabled };
  };
  it("enabled flags: overview both false; roadmap features true; feature both true; each enabled list is requested once", async () => {
    const { m, p } = await panelOf();
    h.state.queries = [];
    p.render();
    await flush();
    expect(flags()).toEqual({ features: false, plans: false });
    expect(calls("feature.list")).toEqual([]);
    await openRoadmap(p);
    h.state.queries = [];
    p.render();
    await flush();
    expect(flags()).toEqual({ features: true, plans: false });
    expect(calls("feature.list").map((c) => c.input)).toEqual([{ projectId: P }]);
    only(p.render(), m.rs.RoadmapScreen, "roadmap").props.onOpenFeature("f1");
    h.state.queries = [];
    p.render();
    await flush();
    expect(flags()).toEqual({ features: true, plans: true });
    expect(calls("plan.list").map((c) => c.input)).toEqual([{ projectId: P }]);
    expect(calls("feature.list").length).toBe(1);
    p.render();
    p.render();
    await flush();
    expect(calls("feature.list").length).toBe(1);
    expect(calls("plan.list").length).toBe(1);
    expect(h.state.invalidations).toEqual([]);
  });
});

// R1 final review c0095: a feature detail link opens another feature (feature → feature), and Back
// returns to the first feature.
describe("R1 final review c0095: feature → feature", () => {
  it("onOpenFeature from the feature screen shows the second feature; Back returns to the first", async () => {
    const { m, p } = await panelOf();
    await openRoadmap(p);
    only(p.render(), m.rs.RoadmapScreen, "roadmap").props.onOpenFeature("f1");
    const first = only(p.render(), m.fs.FeatureScreen, "feature f1");
    expect(first.props.feature.id).toBe("f1");
    first.props.onOpenFeature("f2");
    const second = only(p.render(), m.fs.FeatureScreen, "feature f2");
    expect(second.props.feature).toEqual(features[1]);
    second.props.onBack();
    expect(only(p.render(), m.fs.FeatureScreen, "back to f1").props.feature.id).toBe("f1");
  });
});

// R4.2 verification (T; root technical ruling on the approved layout): the feature route gives
// FeatureScreen a bounded viewport instead of wrapping it in the page's outer ScrollView, so the
// screen can own its content scroll and keep the compact action bar and the chat composer outside
// it. Node structural evidence only; this does not prove sticky behaviour or the absence of overflow.
describe("R4.2 verification: the feature route is not trapped in an outer scrolling page", () => {
  it("FeatureScreen has no ScrollView ancestor in the panel route (Back and the route itself unchanged)", async () => {
    const { m, p } = await panelOf();
    await openRoadmap(p);
    only(p.render(), m.rs.RoadmapScreen, "roadmap").props.onOpenFeature("f1");
    const tree = p.render();
    const SCROLLS = new Set(["ScrollView", "RNScrollView", "RNFlatList", "FlatList"]);
    const ancestry: string[][] = [];
    const walk = (n: unknown, chain: string[]): void => {
      if (Array.isArray(n)) return n.forEach((x) => walk(x, chain));
      if (!n || typeof n !== "object") return;
      const el = n as El;
      if (!el.props) return;
      const name = (el.type as { displayName?: string })?.displayName ?? "";
      if (el.type === m.fs.FeatureScreen) ancestry.push(chain);
      walk(el.props.children, name ? [...chain, name] : chain);
    };
    walk(tree, []);
    expect(ancestry, "FeatureScreen is rendered once").toHaveLength(1);
    expect(ancestry[0].filter((n) => SCROLLS.has(n)), "no scrolling ancestor around the feature screen").toEqual([]);
    expect(only(tree, m.fs.FeatureScreen, "feature").props.feature.id).toBe("f1");
  });
});

// R4.4 verification (T): the panel's roadmap route passes feature.list's `delegations` to
// RoadmapScreen (producer → consumer composition for the delegations strip).
describe("R4.4 verification: the roadmap route passes feature.list delegations", () => {
  it("RoadmapScreen receives exactly feature.list.delegations (revoked included; the strip filters)", async () => {
    const { m, p } = await panelOf();
    const delegations = [
      { id: "d1", scope: "feature", featureId: "f1", grantedAt: "2026-10-29T10:00:00.000Z", provenance: { agentId: "a", seqStart: 1, timestamp: "2026-10-29T10:00:00.000Z", quoted: "start f1" } },
      { id: "d2", scope: "roadmap", grantedAt: "2026-10-29T11:00:00.000Z", revokedAt: "2026-10-29T12:00:00.000Z", provenance: { agentId: "a", seqStart: 2, timestamp: "2026-10-29T11:00:00.000Z", quoted: "start all" } },
    ];
    featureState = { data: { ...featureState.data, delegations }, isPending: false, isError: false };
    await openRoadmap(p);
    const screen = only(p.render(), m.rs.RoadmapScreen, "RoadmapScreen");
    expect(screen.props.delegations).toEqual(delegations);
  });
});

// ======================= Stage R4.5a (task card §6.2 G5, §6.3) =======================
// The panel consumes the scoped, one-shot pending route left by /roadmap: on mount and, for an
// already open panel, through subscribePendingRoute. Scope = { workspaceId: the panel's, projectId:
// useProjectId(workspaceId) } (here w1 / prj_test). A feature query resolves against feature.list by
// exact id, else a unique case-insensitive title; a miss or an ambiguity gives the roadmap screen
// plus "No single feature matches '<query>'". Nothing is written. Loaded from the real ./slash module.
describe("R4.5a panel consumes the pending /roadmap route", () => {
  const SCOPE = { workspaceId: "w1", projectId: "prj_test" };
  const routes = async () => {
    const mod: Record<string, unknown> = await import("./slash");
    for (const n of ["setPendingRoute", "takePendingRoute"]) expect(typeof mod[n], `client/slash exports ${n}`).toBe("function");
    return mod as unknown as { setPendingRoute: (s: typeof SCOPE, r: unknown) => void; takePendingRoute: (s: typeof SCOPE) => unknown };
  };
  const textAll = (tree: unknown) => allText(tree);

  it("a pending feature route is taken on mount (by id) and a remount does not re-navigate", async () => {
    const r = await routes();
    r.setPendingRoute(SCOPE, { kind: "feature", query: "f1" });
    const { m, p } = await panelOf();
    const screen = only(p.render(), m.fs.FeatureScreen, "FeatureScreen for f1");
    expect(screen.props.feature.id).toBe("f1");
    const again = await panelOf();
    expect(all(again.p.render(), (el) => el.type === again.m.fs.FeatureScreen), "one-shot: a remount stays on the overview").toEqual([]);
  });

  it("a route set while the panel is already open is consumed through the subscription (roadmap route → roadmap screen)", async () => {
    const r = await routes();
    h.state.subscriptions = [];
    const { m, p } = await panelOf();
    expect(all(p.render(), (el) => el.type === m.rs.RoadmapScreen)).toEqual([]);
    // R4 final KensAI c0014: the open panel registered a listener, and setting a route notifies it, which
    // marks the panel for a re-render before any render pass (the harness re-runs mount effects on every
    // pass, so the screen change alone cannot show that the subscription exists).
    expect(h.state.subscriptions.length, "the open panel subscribed to pending routes").toBeGreaterThanOrEqual(1);
    h.state.dirty = false;
    r.setPendingRoute(SCOPE, { kind: "roadmap" });
    expect(h.state.dirty, "the recorded listener re-renders the panel when a route is set").toBe(true);
    only(p.render(), m.rs.RoadmapScreen, "RoadmapScreen after the subscription");
  });

  // R4 final DeepSeek c0083: with dependency-aware effects the take-route effect re-runs only when one of
  // its deps changes, so a route set while the panel is open reaches the screen only through the
  // routeTick dependency the subscription bumps (removing routeTick from the deps fails this case).
  it("dependency-aware effects: one subscription, and a route set while open is taken because routeTick changes", async () => {
    const r = await routes();
    h.state.subscriptions = [];
    h.state.depsAware = true;
    const { m, p } = await panelOf();
    expect(all(p.render(), (el) => el.type === m.rs.RoadmapScreen)).toEqual([]);
    expect(all(p.render(), (el) => el.type === m.rs.RoadmapScreen), "settled renders do not navigate").toEqual([]);
    expect(h.state.subscriptions.length, "the mount-only subscription effect ran once").toBe(1);
    h.state.dirty = false;
    r.setPendingRoute(SCOPE, { kind: "roadmap" });
    expect(h.state.dirty, "the listener marks the panel for a re-render").toBe(true);
    only(p.render(), m.rs.RoadmapScreen, "RoadmapScreen after the routeTick change");
    expect(r.takePendingRoute(SCOPE), "the route was consumed").toBeNull();
    expect(h.state.subscriptions.length, "no re-subscription on re-render").toBe(1);
  });

  // R4 successor KensAI c0041: a pending feature route whose feature-list read fails must not stall silently
  // on the overview; it lands on the roadmap route, whose existing error branch shows the failed read.
  it("a pending feature route with a failed feature.list read shows the read error on the roadmap route, not a silent overview", async () => {
    const r = await routes();
    featureState = { data: undefined, isPending: false, isError: true, error: new Error("feature list unreadable") };
    r.setPendingRoute(SCOPE, { kind: "feature", query: "f1" });
    const { m, p } = await panelOf();
    const tree = p.render();
    expect(textAll(tree), "the failed read is visible").toContain("feature list unreadable");
    expect(all(tree, (el) => el.type === m.fs.FeatureScreen)).toEqual([]);
    expect(r.takePendingRoute(SCOPE), "the route was consumed").toBeNull();
  });

  it("a unique case-insensitive title resolves; an ambiguous or missing one gives the roadmap screen plus a notice", async () => {
    const r = await routes();
    r.setPendingRoute(SCOPE, { kind: "feature", query: "FEATURE TWO" });
    let w = await panelOf();
    expect(only(w.p.render(), w.m.fs.FeatureScreen, "by title").props.feature.id).toBe("f2");
    featureState = { data: { revision: 5, features: [...features, { ...features[0], id: "f3", title: "feature ONE" }] }, isPending: false, isError: false };
    r.setPendingRoute(SCOPE, { kind: "feature", query: "Feature one" });
    w = await panelOf();
    let tree = w.p.render();
    only(tree, w.m.rs.RoadmapScreen, "ambiguous → roadmap");
    expect(textAll(tree)).toContain("No single feature matches 'Feature one'");
    r.setPendingRoute(SCOPE, { kind: "feature", query: "zzz" });
    w = await panelOf();
    tree = w.p.render();
    only(tree, w.m.rs.RoadmapScreen, "missing → roadmap");
    expect(textAll(tree)).toContain("No single feature matches 'zzz'");
  });

  it("a route for another workspace or project is not consumed and does not navigate; no mutation", async () => {
    const r = await routes();
    r.setPendingRoute({ workspaceId: "w2", projectId: "prj_test" }, { kind: "roadmap" });
    r.setPendingRoute({ workspaceId: "w1", projectId: "prj_other" } as typeof SCOPE, { kind: "roadmap" });
    const { m, p } = await panelOf();
    expect(all(p.render(), (el) => el.type === m.rs.RoadmapScreen), "no navigation").toEqual([]);
    expect(r.takePendingRoute({ workspaceId: "w2", projectId: "prj_test" }), "the foreign route stays for its own scope").toEqual({ kind: "roadmap" });
    expect(h.state.invalidations).toEqual([]);
    expect(h.state.calls.filter((c) => !/\.(get|list|version|overview)$/.test(c.name)), "no RPC write").toEqual([]);
  });
});

describe("R4.5a index.client.tsx registration (client structural)", () => {
  it("registers the roadmap settings screen exactly once next to the unchanged tracker screen; slash commands come from roadmapSlashCommands(PANEL_ID)", () => {
    const src = readFileSync(new URL("../index.client.tsx", import.meta.url), "utf8");
    const screens = src.match(/addSettingsScreen\(\{[^}]*\}\)/g) ?? [];
    const roadmap = screens.filter((x) => /id:\s*"roadmap"/.test(x));
    expect(roadmap, "one roadmap settings screen").toHaveLength(1);
    expect(roadmap[0]).toMatch(/title:\s*"Decision roadmap"/);
    expect(roadmap[0]).toMatch(/Component:\s*RoadmapSettingsScreen/);
    expect(screens.filter((x) => /id:\s*"tracker"/.test(x) && /Component:\s*TrackerSettingsScreen/.test(x)), "the tracker screen unchanged").toHaveLength(1);
    expect(src).toMatch(/import \{ RoadmapSettingsScreen \} from "\.\/client\/roadmap-settings"/);
    expect(src.match(/roadmapSlashCommands\(PANEL_ID\)/g) ?? []).toHaveLength(1);
  });
});

// Review regression: a link of another project is refused even when its session id matches the
// session on screen, and the refusal is visible on whatever screen the panel shows, with no
// navigation. A short Q<n> outside a session is refused the same visible way.
describe("refused links are visible on every screen", () => {
  const SCOPE = { workspaceId: "w1", projectId: "prj_test" };
  const routes = async () => {
    const mod: Record<string, unknown> = await import("./slash");
    return mod as unknown as { setPendingRoute: (s: typeof SCOPE, r: unknown) => void };
  };
  const foreign = (sessionId: string) => ({ projectId: "prj_other", sessionId, number: 1, kind: "question" });
  const ANOTHER_PROJECT = /another project/i;

  it("from the overview: a link of another project shows the warning and does not navigate", async () => {
    const r = await routes();
    r.setPendingRoute(SCOPE, { kind: "question", link: foreign("S") });
    const { m, p } = await panelOf();
    const tree = p.render();
    expect(allText(tree)).toMatch(ANOTHER_PROJECT);
    expect(all(tree, (el) => el.type === m.gb.GrillingBlocks)).toEqual([]);
  });

  it("from an open session: a link of another project with the same session id shows the warning and keeps the session as it was", async () => {
    const r = await routes();
    const { m, p } = await panelOf();
    await openSession(p);
    const before = only(p.render(), m.gb.GrillingBlocks, "GrillingBlocks").props.target;
    r.setPendingRoute(SCOPE, { kind: "question", link: foreign("S") });
    const tree = p.render();
    expect(allText(tree)).toMatch(ANOTHER_PROJECT);
    const after = only(tree, m.gb.GrillingBlocks, "still the same session");
    expect(after.props.view.session.id).toBe("S");
    expect(after.props.target).toEqual(before);
  });

  it("inside a session: a pressed link of another project with the same session id is refused visibly, not resolved here", async () => {
    const { m, p } = await panelOf();
    await openSession(p);
    const grilling = only(p.render(), m.gb.GrillingBlocks, "GrillingBlocks");
    const before = grilling.props.target;
    grilling.props.onOpenLink(foreign("S"));
    const tree = p.render();
    expect(allText(tree)).toMatch(ANOTHER_PROJECT);
    expect(only(tree, m.gb.GrillingBlocks, "same session").props.target).toEqual(before);
  });

  it("inside a session: a pressed link of another project's other session is refused visibly", async () => {
    const { m, p } = await panelOf();
    await openSession(p);
    only(p.render(), m.gb.GrillingBlocks, "GrillingBlocks").props.onOpenLink(foreign("S-elsewhere"));
    const tree = p.render();
    expect(allText(tree)).toMatch(ANOTHER_PROJECT);
    expect(only(tree, m.gb.GrillingBlocks, "no navigation").props.view.session.id).toBe("S");
  });

  it("outside a session: /roadmap question Q<n> shows the warning on the overview", async () => {
    const r = await routes();
    r.setPendingRoute(SCOPE, { kind: "question-number", number: 3 });
    const { p } = await panelOf();
    expect(allText(p.render())).toMatch(/Open a session first.*Q3/);
  });
});

// UI feedback plan (2026-11-09) U1: the session header uses the one 44 px ActionButton for Back and
// Add question (no smaller Button remains on the screen). U3: a session that belongs to a feature
// (the feature whose grillSessionId is the session) shows the stage strip; a standalone or legacy
// session shows none.
describe("UI feedback: session header controls and stage strip", () => {
  const strips = (tree: unknown) => all(tree, (el) => (el as Node).from === "StageStrip" || nameOf(el) === "StageStrip");

  it("Back is an ActionButton, the header has no Add question, and no ui Button is on the session screen", async () => {
    const { m, p } = await panelOf();
    await openSession(p);
    const tree = p.render();
    const sessionRoot = ancestorsOf(tree, (el) => el.type === m.gb.GrillingBlocks)!.find((el) => el.from === "SessionScreen")!;
    expect(pressables(sessionRoot, /^Add question$/), "questions are added under the open block, not from the header").toEqual([]);
    for (const label of [/Back/]) {
      const found = pressables(sessionRoot, label);
      expect(found.length, String(label)).toBeGreaterThan(0);
      for (const b of found) expect(b.type, String(label)).toBe(m.rs.ActionButton);
    }
    const ui = (await import(/* @vite-ignore */ String("./ui"))) as Record<string, unknown>;
    if (typeof ui.Button === "function") expect(all(tree, (el) => el.type === ui.Button)).toEqual([]);
  });

  it("a session of a feature shows the stage strip; a standalone session shows none", async () => {
    const standalone = await panelOf();
    await openSession(standalone.p);
    expect(strips(standalone.p.render())).toEqual([]);

    featureState = { data: { revision: 5, features: features.map((f) => (f.id === "f1" ? { ...f, grillSessionId: "S" } : f)) }, isPending: false, isError: false };
    const owned = await panelOf();
    await openSession(owned.p);
    expect(strips(owned.p.render()).length).toBe(1);
  });
});

// Compact session screen (66bebf3, 6ac2fac): the session header above GrillingBlocks stays short; its
// stage strip is one horizontal row of the four cells, never a wrapping block of pills. Structure
// only; the harness has no layout to measure the header's height.
describe("compact session header stage strip", () => {
  it("is one horizontal row holding the four stage cells", async () => {
    featureState = { data: { revision: 5, features: features.map((f) => (f.id === "f1" ? { ...f, grillSessionId: "S" } : f)) }, isPending: false, isError: false };
    const { m, p } = await panelOf(true);
    await openSession(p);
    const tree = p.render();
    const stage = /^(Questions|Plan|Tasks|Execution|Done): /;
    const cells = (n: unknown) => all(n, (el) => typeof el.props.accessibilityLabel === "string" && stage.test(el.props.accessibilityLabel));
    const rows = all(tree, (el) => isScroll(el) && el.props.horizontal === true && cells(el).length === 4);
    expect(rows.length).toBe(1);
    const sessionRoot = ancestorsOf(tree, (el) => el.type === m.gb.GrillingBlocks)!.find((el) => el.from === "SessionScreen")!;
    expect(cells(sessionRoot).length, "the strip is in the session screen").toBe(4);
    expect(all(tree, (el) => el.type === m.gb.GrillingBlocks).flatMap((g) => cells(g)), "not inside GrillingBlocks").toEqual([]);
  });
});


// The session route reads the feature list (to find the feature that owns the session
// and show its stage strip), so the features query is enabled there.
describe("session route feature list", () => {
  it("the features query is enabled on the session route", async () => {
    const { p } = await panelOf();
    await openSession(p);
    h.state.queries = [];
    p.render();
    await flush();
    const last = [...h.state.queries].reverse().find((q: any) => q.queryKey?.[3] === "features");
    expect(last?.enabled).toBe(true);
  });
});
