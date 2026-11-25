// The discussion screen per the round 7 template, in node: the REAL RoadmapPanel opens a session and
// every function component below it is expanded in place, each with its own hook slots keyed by tree
// path, so the cases read what the owner sees (labels, text, enabled state) and the RPCs a press
// sends, whatever component owns a control. Closed host Modals are left out of the visible tree.
// Limitations: no reconciler, layout, focus, keyboard or native behaviour; nothing here proves the
// live UI, touch targets or styling.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildSessionView } from "../server/views";
import { largeMapRoadmap, MAP_SESSION, mapRoadmap } from "../server/test-support/map-fixture";
import { answered as storedAnswered, NOW_ISO, q as storedQuestion } from "../server/test-support/build";
import { roadmapData } from "../server/test-support/grilling";

type El = { type: unknown; props: Record<string, any>; key?: string | null };
type Node = El & { from?: string; ownProps?: Record<string, any> };
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
    answers: {} as Record<string, (input: Record<string, any>) => unknown>,
    query: (_key: unknown[]): any => ({}),
    ran: new Set<string>(),
    pending: [] as Array<Promise<unknown>>,
    invalidations: [] as unknown[],
    agentStatuses: {} as Record<string, string>,
    agentTitles: {} as Record<string, string | null>,
    copied: [] as string[],
    /** Calls of relationLinks, the per-question relation derivation. */
    relationCalls: 0,
    /** KensAI 9126580 c0007: a re-read (invalidateQueries) that rejects; null = it resolves. */
    invalidateError: null as Error | null,
    /** The options every useQuery call was made with, latest last. */
    queryOptions: [] as any[],
    /**
     * React's dependency semantics for useEffect, useLayoutEffect, useMemo and useCallback (an effect
     * runs after a render only when its deps changed, its previous cleanup first; a memo keeps its
     * value while its deps are equal). Off by default: the other cases rely on every effect running
     * after every render. Set before the screen is mounted.
     */
    reactDeps: false,
    /** The window Dimensions.get reports; null: it throws (a platform that reports none). */
    window: { width: 1220, height: 847 } as { width: number; height: number } | null,
    /**
     * React's unmount: after each render pass, a component that is no longer in the tree loses its
     * hook state and refs (its effect cleanups run under reactDeps), so mounting it again starts
     * afresh. Before review 01a1c737 c0052 the harness kept every component's state for good, which
     * hid state lost to an unmount. On for every case (reset in beforeEach).
     */
    unmount: true,
    /**
     * The host's `useComposers` (0.16). By default it throws as outside a composer source, which is
     * what the cases written before it saw (the action reports itself unsupported).
     */
    composers: ((_selector: unknown): unknown[] => {
      throw new Error("useComposers must run inside a plugin component");
    }) as (selector: unknown) => unknown[],
  };
  const useState = (init: unknown) => {
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
  const sameDeps = (a: unknown[] | undefined, b: unknown[] | undefined) => a !== undefined && b !== undefined && a.length === b.length && a.every((x, k) => Object.is(x, b[k]));
  const useEffect = (fn: () => unknown, deps?: unknown[]) => {
    if (!state.reactDeps) return void state.effects.push(fn);
    const slots = state.slots;
    const i = state.index++;
    const prev = slots[i] as { deps?: unknown[]; cleanup?: unknown } | undefined;
    if (prev !== undefined && sameDeps(prev.deps, deps)) return;
    const record: { deps?: unknown[]; cleanup?: unknown } = { deps, cleanup: undefined };
    slots[i] = record;
    state.effects.push(() => {
      if (typeof prev?.cleanup === "function") (prev.cleanup as () => void)();
      record.cleanup = fn();
    });
  };
  const useMemo = (fn: () => unknown, deps?: unknown[]) => {
    if (!state.reactDeps) return fn();
    const slots = state.slots;
    const i = state.index++;
    const prev = slots[i] as { deps?: unknown[]; value: unknown } | undefined;
    if (prev !== undefined && sameDeps(prev.deps, deps)) return prev.value;
    const value = fn();
    slots[i] = { deps, value };
    return value;
  };
  const marker = (name: string) => Object.assign(() => null, { displayName: name });
  const useRpc = (contract: { name: string }) => (input: Record<string, any>) => {
    state.calls.push({ name: contract.name, input });
    const answer = state.answers[contract.name];
    return Promise.resolve(answer ? answer(input) : { ok: true, value: { revision: (input.expectedRevision ?? 0) + 1 } });
  };
  return { state, useState, useEffect, useMemo, marker, useRpc };
});

vi.mock("react", async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  const useRef = (v: unknown) => {
    const slots = h.state.slots;
    const i = h.state.index++;
    if (!(i in slots)) slots[i] = { current: v };
    return slots[i];
  };
  const passthrough = { useState: h.useState, useEffect: h.useEffect, useLayoutEffect: h.useEffect, useCallback: (fn: unknown, deps?: unknown[]) => h.useMemo(() => fn, deps), useMemo: h.useMemo, useRef };
  return { ...real, ...passthrough, default: { ...(real.default as object), ...passthrough } };
});
vi.mock("react-native", () => ({
  Text: h.marker("Text"),
  View: h.marker("View"),
  Pressable: h.marker("Pressable"),
  ScrollView: h.marker("RNScrollView"),
  FlatList: h.marker("RNFlatList"),
  TextInput: h.marker("RNTextInput"),
  KeyboardAvoidingView: h.marker("KeyboardAvoidingView"),
  Platform: { OS: "web", select: (o: Record<string, unknown>) => o.web ?? o.default },
  Dimensions: {
    get: () => {
      if (h.state.window === null) throw new Error("no window reported");
      return { ...h.state.window };
    },
  },
  useWindowDimensions: () => ({ width: 1220, height: 847 }),
}));
vi.mock("@getpaseo/plugin/client/react-native", () => ({
  TextInput: h.marker("TextInput"),
  ScrollView: h.marker("ScrollView"),
  Modal: Object.assign(h.marker("Modal"), { Content: h.marker("ModalContent") }),
  FlatList: h.marker("FlatList"),
  Icon: h.marker("Icon"),
  useToast: () => ({ show: (m: string) => void h.state.toasts.push(m), error: (m: string) => void h.state.toasts.push(m) }),
  copyText: async (text: string) => void h.state.copied.push(text),
}));
vi.mock("@getpaseo/plugin/client", () => ({
  useRpc: h.useRpc,
  useWorkspace: (_id: string, select?: (w: { projectId: string }) => unknown) => (select ? select({ projectId: "prj_test" }) : { projectId: "prj_test" }),
  useSettings: () => ({ status: "loading" }),
  usePaseo: () => null,
  useComposers: (selector: unknown) => h.state.composers(selector),
  useAgent: (id: string, select?: (a: { title: string | null; status?: string }) => unknown) => {
    if (!(id in h.state.agentTitles) && !(id in h.state.agentStatuses)) return null;
    const agent = { title: h.state.agentTitles[id] ?? null, ...(id in h.state.agentStatuses ? { status: h.state.agentStatuses[id] } : {}) };
    return select ? select(agent) : agent;
  },
}));
vi.mock("./relation-links", async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  const relationLinks = real.relationLinks as (...args: unknown[]) => unknown;
  return {
    ...real,
    relationLinks: (...args: unknown[]) => {
      h.state.relationCalls++;
      return relationLinks(...args);
    },
  };
});
vi.mock("@tanstack/react-query", () => ({
  useQuery: (opts: any) => {
    h.state.queryOptions.push(opts);
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
      if (h.state.invalidateError !== null) throw h.state.invalidateError;
    },
  }),
}));

const COLORS = new Proxy({} as Record<string, string>, { get: (_t, k) => `#${String(k)}` });
const theme = { colors: COLORS } as never;
const HOST = "h1";
const P = "prj_test";
const AT = "2026-11-09T09:00:00.000Z";
const PROPOSED_AT = "2026-11-09T10:00:00.000Z";
const CLOSED_AT = "2026-11-09T11:00:00.000Z";
const REOPENED_AT = "2026-11-09T12:00:00.000Z";
const PLANNER = "agent-planner-1";

// ---- Tree helpers ----
const nameOf = (el: El) => (el.type as { displayName?: string; name?: string })?.displayName ?? (el.type as { name?: string })?.name ?? "";
const isClosedModal = (el: El) => nameOf(el) === "Modal" && (el.props.open === false || el.props.visible === false);
/** Every element in document order, skipping the content of closed host Modals. */
function all(tree: unknown, pred: (el: Node) => boolean = () => true): Node[] {
  const out: Node[] = [];
  const walk = (n: unknown) => {
    if (Array.isArray(n)) return n.forEach(walk);
    if (!n || typeof n !== "object") return;
    const el = n as Node;
    if (!el.props) return;
    if (isClosedModal(el)) return;
    if (pred(el)) out.push(el);
    walk(el.props.children);
  };
  walk(tree);
  return out;
}
/**
 * The Map graph's own vertical scroll view: the innermost vertical ScrollView with onLayout and a ref
 * that holds the horizontal world scroller. (An outer scroll region around the compact Map, as in
 * c3bc2ae, may carry onLayout and a ref too; it is not the graph's.)
 */
const isGraphScroll = (el: El): boolean => {
  const candidate = (x: El) => ["ScrollView", "RNScrollView"].includes(nameOf(x)) && x.props.horizontal !== true && typeof x.props.onLayout === "function" && x.props.ref != null;
  if (!candidate(el)) return false;
  if (all(el, (x) => nameOf(x) === "RNScrollView" && x.props.horizontal === true).length === 0) return false;
  return !all(el, (x) => x !== el && candidate(x) && all(x, (y) => nameOf(y) === "RNScrollView" && y.props.horizontal === true).length > 0).length;
};
const textOf = (n: unknown): string => {
  if (n === null || n === undefined || typeof n === "boolean") return "";
  if (typeof n === "string" || typeof n === "number") return String(n);
  if (Array.isArray(n)) return n.map(textOf).join("");
  const el = n as El;
  if (!el.props || isClosedModal(el)) return "";
  return textOf(el.props.children);
};
const labelOf = (el: El): string => String(el.props.accessibilityLabel ?? el.props.label ?? textOf(el.props.children) ?? "");
const handlerOf = (el: El) => el.props.onPress ?? el.props.onChange ?? el.props.onValueChange;
const isDisabled = (el: El) => el.props.disabled === true || el.props.accessibilityState?.disabled === true;
/** Pressable controls whose accessibility label, label or text matches. */
const controls = (tree: unknown, re: RegExp) => all(tree, (el) => typeof handlerOf(el) === "function" && (re.test(labelOf(el)) || re.test(textOf(el.props.children))));
const enabledControls = (tree: unknown, re: RegExp) => controls(tree, re).filter((el) => !isDisabled(el));
/** Every visible string: Text-like leaves and string labels, one per line. */
const visibleText = (tree: unknown) =>
  all(tree)
    .flatMap((el) => [
      typeof el.props.label === "string" ? el.props.label : "",
      typeof el.props.accessibilityLabel === "string" ? el.props.accessibilityLabel : "",
      typeof el.props.children === "string" || typeof el.props.children === "number" ? String(el.props.children) : "",
      Array.isArray(el.props.children) && el.props.children.every((c: unknown) => typeof c === "string" || typeof c === "number") ? el.props.children.join("") : "",
    ])
    .filter((s) => s !== "")
    .join("\n");
const inputs = (tree: unknown, re: RegExp) =>
  all(tree, (el) => typeof el.props.onChangeText === "function" && re.test(String(el.props.accessibilityLabel ?? el.props.label ?? el.props.placeholder ?? "")));
const flush = async () => {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
};
async function press(el: El, value: unknown = true) {
  if (el.props.onPress) el.props.onPress({ nativeEvent: {}, preventDefault: () => undefined, stopPropagation: () => undefined });
  else handlerOf(el)(value);
  await flush();
}
const calls = (name: string): Call[] => h.state.calls.filter((c) => c.name === name);
const one = <T>(list: T[], what: string): T => {
  expect(list.length, what).toBe(1);
  return list[0];
};

const squash = (x: string) => x.replace(/\s+/g, "");
/**
 * One question card, whichever component renders it: the smallest subtree with exactly one More
 * control that holds an element starting with the card's title row (`Q<n> <title>`, number and
 * title in one text or adjacent ones). A link that names the question elsewhere does not start so.
 */
function cardOf(tree: unknown, title: string): Node {
  const head = squash(title);
  const startsWithTitle = (el: Node) => all(el, (x) => squash(textOf(x)).startsWith(head)).length > 0;
  const candidates = all(tree, (el) => controls(el, /^More\b/).length === 1 && startsWithTitle(el));
  if (candidates.length === 0) throw new Error(`no card for ${title}`);
  return candidates.reduce((a, b) => (all(b).length < all(a).length ? b : a));
}
/** RPCs other than the panel's own reads. */
const READS = /^(roadmap\.(version|overview)|session\.get|feature\.list|plan\.(list|get)|run\.(list|get)|.*\.list|.*\.get)$/;
const writes = () => h.state.calls.filter((c) => !READS.test(c.name));

// ---- Synthetic session views ----
const opt = (id: string, label: string, description?: string) => ({ id, label, ...(description !== undefined ? { description } : {}) });
const answerOf = (a: { optionId?: string; text?: string }) => ({ rev: 1, ...a, source: "ui", actor: { kind: "human" }, at: AT });
function q(id: string, title: string, extra: Record<string, unknown> = {}): any {
  return {
    id, order: Number(id.replace(/\D/g, "")), number: Number(id.replace(/\D/g, "")), title, context: "", options: [], allowFreeText: false, definitionRev: 1,
    activatedBy: [], invalidatedBy: [], revisions: [], discussion: [], validity: "unanswered", ...extra,
  };
}
const answered = (question: any, a: { optionId?: string; text?: string }) => ({ ...question, answer: answerOf(a), revisions: [answerOf(a)], validity: "valid" });
const qv = (question: any, over: Record<string, unknown> = {}) => ({
  question, visibility: "active", status: question.answer ? "answered" : "open", depth: 0, number: question.number,
  links: { question: `roadmap://${P}/s/S/q/${question.number}`, answer: `roadmap://${P}/s/S/q/${question.number}/answer` }, ...over,
});
const ref = (questionId: string, sessionId = "S") => ({ sessionId, questionId });

const Q1 = "Which sign-in methods are supported?";
const Q2 = "Which identifier is used to sign in?";
const Q3 = "How long should a session last?";
const Q4 = "Lock the account after failed attempts?";
const CONTEXT_Q1 = "Pick the methods for the first version.";
const WHY_Q1 = "No external provider is needed for the first version.";

/**
 * Session S with a bound planner: Block 1 accepted (Q1 option answer, recommended with a reason and a
 * description; Q2 free-text answer, depends on Q1 by invalidation), Block 2 open (Q3 unanswered,
 * activated by Q1, recommends an option without a reason; Q4 option answer). Links: Q2 informs Q4;
 * T1 of Session T supersedes Q4; Q3 informs Session U; Q4 supersedes a question that no longer
 * exists; an unrelated T1 → U1 link touches no question of S.
 */
function sessionView(over: { session?: Record<string, unknown>; grilling?: Record<string, unknown> | null; questions?: any[]; links?: any[] } = {}): any {
  const questions = over.questions ?? [
    qv(answered(q("q1", Q1, { blockId: "b1", context: CONTEXT_Q1, options: [opt("m1", "Email and password", WHY_Q1), opt("m2", "Passkeys")], recommendedOptionId: "m1" }), { optionId: "m1" })),
    qv(answered(q("q2", Q2, { blockId: "b1", allowFreeText: true, invalidatedBy: [{ upstream: ref("q1") }] }), { text: "Email address" })),
    qv(q("q3", Q3, { blockId: "b2", options: [opt("s1", "Long-lived session"), opt("s2", "Until the browser closes")], recommendedOptionId: "s2", activatedBy: [{ parent: ref("q1"), optionIds: ["m1"] }] })),
    qv(answered(q("q4", Q4, { blockId: "b2", options: [opt("yes", "Yes"), opt("no", "No")] }), { optionId: "no" })),
  ];
  return {
    revision: 7,
    session: {
      id: "S", title: "Session S", createdAt: AT, status: "active",
      blocks: [
        { id: "b1", order: 0, state: "accepted", openedAt: AT, acceptedAt: AT, acceptedBy: { kind: "human" } },
        { id: "b2", order: 1, state: "open", openedAt: AT },
      ],
      planner: { agentId: PLANNER, workspaceId: "w1", boundAt: AT, boundBy: "discussion", epoch: 1 },
      ...over.session,
    },
    cancellations: [],
    questions,
    links: over.links ?? [
      { id: "l1", kind: "informs", from: ref("q2"), to: ref("q4") },
      { id: "l2", kind: "supersedes", from: ref("t1", "T"), to: ref("q4") },
      { id: "l3", kind: "informs", from: ref("q3"), to: { sessionId: "U" } },
      { id: "l4", kind: "supersedes", from: ref("q4"), to: ref("gone") },
      { id: "l5", kind: "informs", from: ref("t1", "T"), to: ref("u1", "U") },
    ],
    catalog: [
      ...questions.map((x: any) => ({ ref: ref(x.question.id), sessionTitle: "Session S", questionTitle: x.question.title, options: x.question.options, status: x.status })),
      { ref: ref("t1", "T"), sessionTitle: "Session T", questionTitle: "T1 replacement", options: [], status: "open" },
      { ref: ref("u1", "U"), sessionTitle: "Session U", questionTitle: "U1 question", options: [], status: "open" },
    ],
    ...(over.grilling === null ? {} : { grilling: { status: "waiting_for_answers", manualRecovery: false, plannerAgentId: PLANNER, epoch: 1, retryCount: 0, tools: "attached", ...over.grilling } }),
  };
}
/** Legacy session (no blocks). */
function legacyView(): any {
  const questions = [qv(answered(q("l1", "Legacy first", { options: [opt("a", "A")] }), { optionId: "a" })), qv(q("l2", "Legacy second", { options: [opt("a", "A")] }))];
  return { revision: 4, session: { id: "S", title: "Session S", createdAt: AT, status: "active" }, cancellations: [], questions, links: [], catalog: [] };
}
const tView = () => ({ revision: 7, session: { id: "T", title: "Session T", createdAt: AT, status: "active" }, cancellations: [], questions: [qv(q("t1", "T1 replacement"))], links: [], catalog: [] });

// ---- Panel data per query key ----
const overview = { revision: 7, disabled: false, sessions: [{ id: "S", title: "Session S", status: "active", counts: { open: 1, answered: 3, stale: 0, skipped: 0, inactive: 0 } }], links: [] };
let current: { view: any } = { view: sessionView() };
afterEach(async () => {
  await Promise.allSettled(h.state.pending);
});
beforeEach(() => {
  h.state.calls = [];
  h.state.toasts = [];
  h.state.cacheRevision = 7;
  h.state.answers = {};
  h.state.ran = new Set();
  h.state.pending = [];
  h.state.invalidations = [];
  h.state.agentStatuses = {};
  h.state.agentTitles = { [PLANNER]: "Login discussion" };
  h.state.copied = [];
  h.state.invalidateError = null;
  h.state.queryOptions = [];
  h.state.unmount = true;
  h.state.window = { width: 1220, height: 847 };
  h.state.composers = () => {
    throw new Error("useComposers must run inside a plugin component");
  };
  current = { view: sessionView() };
  h.state.query = (key: unknown[]) => {
    switch (key[3]) {
      case "version":
        return { data: { status: "ok", revision: current.view.revision }, isError: false, isPending: false };
      case "overview":
        return { data: overview, isError: false, isPending: false };
      case "session":
        return { data: key[4] === "T" ? tView() : current.view, isError: false, isPending: false };
      case "features":
        return { data: { revision: 7, features: [] }, isError: false, isPending: false };
      case "plans":
        return { data: { revision: 7, plans: [] }, isError: false, isPending: false };
      default:
        return { data: undefined, isError: false, isPending: true };
    }
  };
});

// ---- Deep render ----
function deepMount(root: (p: any) => unknown, props: Record<string, unknown>) {
  const store = new Map<string, unknown[]>();
  const seen = new Set<string>();
  const expand = (node: unknown, path: string, counts: Map<string, number>): unknown => {
    if (node === null || typeof node !== "object") return node;
    if (Array.isArray(node)) return node.map((n) => expand(n, path, counts));
    const el = node as El;
    if (typeof el.type === "function" && !(el.type as { displayName?: string }).displayName) {
      const name = (el.type as { name?: string }).name || "anon";
      const n = counts.get(name) ?? 0;
      counts.set(name, n + 1);
      const k = `${path}/${name}#${el.key ?? n}`;
      seen.add(k);
      if (!store.has(k)) store.set(k, []);
      const saved = { slots: h.state.slots, index: h.state.index };
      h.state.slots = store.get(k)!;
      h.state.index = 0;
      const out = (el.type as (p: unknown) => unknown)(el.props);
      h.state.slots = saved.slots;
      h.state.index = saved.index;
      const expanded = expand(out, k, new Map()) as Node;
      if (expanded && typeof expanded === "object" && !Array.isArray(expanded)) return { ...expanded, from: name, ownProps: el.props };
      return expanded;
    }
    if (typeof el.type === "object" && el.type !== null && "type" in el.type) {
      return expand({ ...el, type: (el.type as { type: unknown }).type }, path, counts);
    }
    if (!el.props) return el;
    return { ...el, props: { ...el.props, children: expand(el.props.children, path, counts) } };
  };
  const render = (): Node => {
    for (let pass = 0; pass < 40; pass++) {
      h.state.dirty = false;
      h.state.effects = [];
      seen.clear();
      const tree = expand({ type: root, props, key: null } as unknown as El, "", new Map()) as Node;
      for (const fn of h.state.effects) fn();
      if (h.state.unmount) {
        for (const [k, slots] of store) {
          if (seen.has(k)) continue;
          store.delete(k);
          for (const slot of slots) {
            const cleanup = (slot as { cleanup?: unknown } | null)?.cleanup;
            if (typeof cleanup === "function") (cleanup as () => void)();
          }
        }
      }
      if (!h.state.dirty) return tree;
    }
    throw new Error("panel did not settle");
  };
  return { render };
}

type Screen = { render(): Node; opened: string[] };
async function openScreen(opts: { navigation?: boolean; compact?: boolean } = {}): Promise<Screen> {
  const panel = (await import(/* @vite-ignore */ String("./panel"))) as { RoadmapPanel: (p: any) => unknown };
  const opened: string[] = [];
  const props = {
    theme,
    layout: { compact: opts.compact ?? false, platform: "web" },
    host: { id: HOST },
    workspaceId: "w1",
    ...(opts.navigation !== false ? { navigation: { openAgent: ({ agentId }: { agentId: string }) => void opened.push(agentId) } } : {}),
  };
  const p = deepMount(panel.RoadmapPanel, props);
  const list = one(all(p.render(), (el) => nameOf(el) === "FlatList"), "the overview list");
  const item = list.props.renderItem({ item: overview.sessions[0], index: 0 });
  await press(one(controls(item, /Session S/), "the session row"));
  return { render: () => p.render(), opened };
}
/** The Chat menu trigger. */
const trigger = (tree: unknown) => one(controls(tree, /^Chat\b/), "one Chat menu trigger");
async function openMenu(s: Screen): Promise<Node> {
  await press(trigger(s.render()));
  return s.render();
}
/** The navigator item of a block (or the proposal), by its first line. */
const navItem = (tree: unknown, re: RegExp) => one(controls(tree, re).filter((el) => !/^(Add question|Accept)/.test(labelOf(el))), `navigator item ${re}`);
async function selectBlock(s: Screen, n: number) {
  await press(navItem(s.render(), new RegExp(`^Block ${n}\\b`)));
  return s.render();
}

/** Each Text element's full text (nested Text included): one line as the owner reads it. */
const textLines = (tree: unknown) => all(tree, (el) => nameOf(el) === "Text").map((el) => textOf(el));
const selected = (el: El) => el.props.accessibilityState?.selected === true || el.props.selected === true;
/** The form's question and answer fields. */
const QUESTION_FIELD = /^(Question|What should be decided\?)$/;
const ANSWER_FIELD = /^(Answer \(optional, free text\)|Leave empty to add the question unanswered)$/;
const SUBMIT = /^Add( to Block \d+)?$/;
async function type(s: Screen, field: RegExp, text: string) {
  one(inputs(s.render(), field), `field ${field}`).props.onChangeText(text);
  await flush();
}
async function openAddForm(s: Screen) {
  await press(one(controls(s.render(), /^Add question to Block 2$/), "the add row of Block 2"));
  return s.render();
}

describe("harness", () => {
  it("opens session S on the panel", async () => {
    const s = await openScreen();
    expect(visibleText(s.render())).toContain("Session S");
  });
});

// ---- W3: header, Chat menu, Open chat and the notices kept outside the menu ----
describe("session header and Chat menu", () => {
  it("the title row holds Back, the title, the Chat menu trigger and Open chat; there is no Add question or Grilling/Map button outside the menu", async () => {
    const s = await openScreen();
    const t = s.render();
    expect(controls(t, /Back/).length).toBeGreaterThan(0);
    expect(visibleText(t)).toContain("Session S");
    trigger(t);
    one(controls(t, /^Open chat$/), "one Open chat control while no menu or composer is open");
    expect(controls(t, /^Add question$/)).toEqual([]);
    expect(controls(t, /^(✓ )?(Grilling|Map)$/), "the view mode lives in the menu").toEqual([]);
  });

  it("Open chat sits above the canvas and opens the planner chat; it is absent without host navigation or without a planner", async () => {
    let s = await openScreen();
    let t = s.render();
    const order = all(t);
    const open = order.indexOf(one(controls(t, /^Open chat$/), "Open chat"));
    const firstCard = order.findIndex((el) => textOf(el).startsWith(`Q3 ${Q3}`));
    expect(firstCard).toBeGreaterThan(-1);
    expect(open, "Open chat comes before the first question card").toBeLessThan(firstCard);
    await press(controls(t, /^Open chat$/)[0]);
    expect(s.opened).toEqual([PLANNER]);
    expect(writes()).toEqual([]);

    s = await openScreen({ navigation: false });
    expect(controls(s.render(), /^Open chat$/)).toEqual([]);
    current = { view: sessionView({ session: { planner: undefined }, grilling: { status: "no_planner", plannerAgentId: undefined, epoch: undefined } }) };
    s = await openScreen();
    t = s.render();
    expect(controls(t, /^Open chat$/)).toEqual([]);
  });

  it("the trigger names the mode and opens a menu with Grilling and Map radios, Finish discussion…, Change chat…, Retry and the tools info", async () => {
    const s = await openScreen();
    expect(labelOf(trigger(s.render())) + textOf(trigger(s.render()).props.children)).toMatch(/Grilling/);
    const t = await openMenu(s);
    const grilling = one(controls(t, /^(✓ )?Grilling$/), "Grilling item");
    const map = one(controls(t, /^(✓ )?Map$/), "Map item");
    expect(grilling.props.accessibilityRole).toBe("menuitemradio");
    expect(map.props.accessibilityRole).toBe("menuitemradio");
    expect(grilling.props.accessibilityState?.checked).toBe(true);
    expect(map.props.accessibilityState?.checked).not.toBe(true);
    one(controls(t, /^Finish discussion…$/), "Finish discussion…");
    one(controls(t, /^Change chat…$/), "Change chat…");
    one(controls(t, /^Retry\b/), "Retry");
    expect(visibleText(t)).toMatch(/Roadmap tools: attached/);
    expect(controls(t, /^Reopen$/), "Reopen only for a closed session").toEqual([]);
    expect(writes()).toEqual([]);
  });

  it("choosing Map switches the body and the trigger, with no RPC; Grilling switches back", async () => {
    const s = await openScreen();
    let t = await openMenu(s);
    await press(one(controls(t, /^(✓ )?Map$/), "Map item"));
    t = s.render();
    expect(labelOf(trigger(t)) + textOf(trigger(t).props.children)).toMatch(/Map/);
    expect(controls(t, /^Accept block and continue$/)).toEqual([]);
    t = await openMenu(s);
    await press(one(controls(t, /^(✓ )?Grilling$/), "Grilling item"));
    expect(controls(s.render(), /^Accept block and continue$/).length).toBe(1);
    expect(writes()).toEqual([]);
  });

  it("Change chat… opens the planner picker; without a planner the item reads Bind chat…", async () => {
    let s = await openScreen();
    await press(one(controls(await openMenu(s), /^Change chat…$/), "Change chat…"));
    expect(all(s.render(), (el) => el.from === "PlannerPicker").length).toBe(1);
    expect(writes()).toEqual([]);

    current = { view: sessionView({ session: { planner: undefined }, grilling: { status: "no_planner", plannerAgentId: undefined, epoch: undefined } }) };
    s = await openScreen();
    const t = await openMenu(s);
    one(controls(t, /^Bind chat…$/), "Bind chat…");
    expect(controls(t, /^Change chat…$/)).toEqual([]);
  });

  it("a closed session's menu offers Reopen, which sends one session.reopen, and no Finish discussion…", async () => {
    current = { view: sessionView({ session: { status: "closed" } }) };
    const s = await openScreen();
    const t = await openMenu(s);
    expect(controls(t, /^Finish discussion…$/)).toEqual([]);
    await press(one(enabledControls(t, /^Reopen$/), "Reopen"));
    expect(calls("session.reopen").map((c) => c.input)).toEqual([{ sessionId: "S", projectId: P, expectedRevision: 7 }]);
  });
});

describe("the Retry item per state", () => {
  const manual = (lastRetry?: Record<string, unknown>) =>
    sessionView({ grilling: { status: "needs_manual", manualRecovery: true, retryCount: lastRetry ? 1 : 0, ...(lastRetry ? { lastRetry } : {}) } });
  const retryItem = (t: unknown) => one(controls(t, /^Retry\b/), "Retry item");
  const hintOf = (el: El) => `${labelOf(el)} ${String(el.props.accessibilityHint ?? "")} ${textOf(el.props.children)}`;

  it("without anything to retry it is disabled with Nothing to retry", async () => {
    const s = await openScreen();
    const item = retryItem(await openMenu(s));
    expect(isDisabled(item)).toBe(true);
    expect(hintOf(item)).toMatch(/Nothing to retry/);
  });

  it("a sent retry disables it with Sent at; a sending or unknown one with Delivery unknown since", async () => {
    current = { view: manual({ id: "r1", at: PROPOSED_AT, state: "sent" }) };
    let item = retryItem(await openMenu(await openScreen()));
    expect(isDisabled(item)).toBe(true);
    expect(hintOf(item)).toMatch(/Sent at/);
    for (const state of ["sending", "unknown"]) {
      current = { view: manual({ id: "r1", at: PROPOSED_AT, state }) };
      item = retryItem(await openMenu(await openScreen()));
      expect(isDisabled(item), state).toBe(true);
      expect(hintOf(item), state).toMatch(/Delivery unknown since/);
      expect(hintOf(item), state).not.toMatch(/\bSent at/);
    }
  });

  it("after a failed retry with an idle chat it is enabled and one press sends one discussion.retry", async () => {
    current = { view: manual({ id: "r1", at: PROPOSED_AT, state: "failed" }) };
    h.state.agentStatuses = { [PLANNER]: "idle" };
    const s = await openScreen();
    const item = retryItem(await openMenu(s));
    expect(isDisabled(item)).toBe(false);
    expect(hintOf(item)).toMatch(/Resends the accepted summary/);
    expect(calls("discussion.retry"), "nothing is sent on render or on opening the menu").toEqual([]);
    expect(visibleText(s.render()), "an idle chat has no interruption warning").not.toMatch(/interrupt/i);
    await press(item);
    expect(calls("discussion.retry").map((c) => c.input.sessionId)).toEqual(["S"]);
  });

  it("with a running chat it is enabled with the interruption warning, which also stays visible outside the menu", async () => {
    current = { view: manual() };
    h.state.agentStatuses = { [PLANNER]: "running" };
    const s = await openScreen();
    expect(visibleText(s.render()), "the warning is visible with the menu closed").toContain("The chat is responding: Retry interrupts its current answer.");
    const item = retryItem(await openMenu(s));
    expect(isDisabled(item)).toBe(false);
    expect(hintOf(item)).toMatch(/interrupts its current answer/);
  });
});

describe("notices stay visible outside the menu", () => {
  it("the planner status line and the tools state are shown with the menu closed; the tools explanation is in the menu", async () => {
    current = { view: sessionView({ grilling: { tools: "not_attached" } }) };
    const s = await openScreen();
    let t = s.render();
    const text = visibleText(t);
    expect(text).toContain("Login discussion");
    expect(text).toMatch(/Roadmap tools: not attached/);
    expect(text, "the explanation is not in the notice row").not.toContain("holds no current grant");
    expect(labelOf(trigger(t)), "the trigger names a tools state that is not attached").toMatch(/not attached/i);
    t = await openMenu(s);
    expect(visibleText(t)).toContain("holds no current grant");
  });

  it("with attached tools the trigger names no tools warning", async () => {
    const s = await openScreen();
    expect(labelOf(trigger(s.render()))).not.toMatch(/not attached|unknown|pending/i);
  });

  it("an unknown retry keeps Check chat, Mark as delivered and Mark as not delivered outside the menu", async () => {
    current = { view: sessionView({ grilling: { status: "needs_manual", manualRecovery: true, retryCount: 1, lastRetry: { id: "r1", at: PROPOSED_AT, state: "unknown" } } }) };
    const t = (await openScreen()).render();
    for (const label of [/^Check chat$/, /^Mark as delivered$/, /^Mark as not delivered$/]) expect(controls(t, label).length, String(label)).toBe(1);
  });
});

// DeepSeek Flash review 01a1c822 c0118, assessed against the approved plan r4: §2.1 "Warnings stay
// visible outside the menu, for sighted users too. Under the stage strip a notice row keeps: the
// planner status line …; the manual-recovery hint; the retry line …; the delivery-unknown warning with
// Check chat, Mark as delivered, Mark as not delivered; the interruption warning whenever Retry is
// enabled with one; and the tools line", and §12.1 "the state line under the strip stays visible".
// The stage strip is shown in both views; the notice row is drawn inside the Grilling body only
// (client/grilling-blocks.tsx), so choosing Map hides it. The plan does not name the Map here; it
// places the row under the strip, which the Map keeps. No case presses Retry (a model effect).
describe("the notice row stays visible under the stage strip on the Map", () => {
  const manual = (lastRetry?: Record<string, unknown>, grilling: Record<string, unknown> = {}) =>
    sessionView({ grilling: { status: "needs_manual", manualRecovery: true, retryCount: lastRetry ? 1 : 0, ...(lastRetry ? { lastRetry } : {}), ...grilling } });
  async function toMap(s: Screen, compact: boolean) {
    if (compact) {
      await press(trigger(s.render()));
      const sheet = one(all(s.render(), (el) => nameOf(el) === "Modal" && el.props.open !== false && controls(el, /^(✓ )?Map$/).length > 0), "the Chat sheet");
      await press(one(controls(sheet, /^(✓ )?Map$/), "Map"));
    } else {
      await press(one(controls(await openMenu(s), /^(✓ )?Map$/), "Map"));
    }
    const t = s.render();
    expect(controls(t, /^(✓ )?Fit$/).length, "the Map is shown").toBe(1);
    expect(controls(t, /^(✓ )?(Grilling|Map)$/), "the menu is closed").toEqual([]);
    return t;
  }

  for (const compact of [false, true]) {
    const where = compact ? "compact" : "wide";
    it(`${where}: the planner status line and the tools state stay visible on the Map`, async () => {
      current = { view: sessionView({ grilling: { tools: "not_attached" } }) };
      const s = await openScreen({ compact });
      const g = s.render();
      expect(visibleText(g), "Grilling shows the tools line (control)").toMatch(/Roadmap tools: not attached/);
      const statusLine = textLines(g).find((l) => l.includes("Login discussion"));
      expect(statusLine, "the planner status line in Grilling (control)").toBeDefined();
      const t = await toMap(s, compact);
      expect(visibleText(t), "the tools line on the Map").toMatch(/Roadmap tools: not attached/);
      expect(textLines(t), "the planner status line on the Map").toContain(statusLine);
    });
  }

  it("wide: the retry line stays visible on the Map", async () => {
    current = { view: manual({ id: "r1", at: PROPOSED_AT, state: "sent" }) };
    const s = await openScreen();
    const line = textLines(s.render()).find((l) => /^Retry sent at /.test(l));
    expect(line, "Grilling shows the retry line (control)").toBeDefined();
    expect(textLines(await toMap(s, false))).toContain(line);
  });

  it("wide: an unknown delivery keeps its warning and Check chat / Mark as delivered / Mark as not delivered on the Map, and they act there", async () => {
    current = { view: manual({ id: "r1", at: PROPOSED_AT, state: "unknown" }) };
    const s = await openScreen();
    const t = await toMap(s, false);
    expect(visibleText(t)).toMatch(/Delivery outcome unknown since .*: check the chat/);
    for (const label of [/^Check chat$/, /^Mark as delivered$/, /^Mark as not delivered$/]) expect(controls(t, label).length, String(label)).toBe(1);
    await press(one(controls(t, /^Check chat$/), "Check chat"));
    expect(calls("discussion.retry.check").map((c) => c.input), "one check of that retry").toEqual([expect.objectContaining({ sessionId: "S", retryId: "r1" })]);
    await press(one(controls(s.render(), /^Mark as not delivered$/), "Mark as not delivered"));
    expect(calls("discussion.retry.resolve").map((c) => c.input), "one resolve at the shown revision").toEqual([expect.objectContaining({ sessionId: "S", retryId: "r1", outcome: "not_delivered", expectedRevision: 7 })]);
    expect(calls("discussion.retry"), "nothing is resent to the chat").toEqual([]);
  });

  it("wide: the interruption warning stays visible on the Map while Retry is enabled with one", async () => {
    current = { view: manual() };
    h.state.agentStatuses = { [PLANNER]: "running" };
    const s = await openScreen();
    expect(visibleText(s.render()), "Grilling (control)").toContain("The chat is responding: Retry interrupts its current answer.");
    expect(visibleText(await toMap(s, false))).toContain("The chat is responding: Retry interrupts its current answer.");
    expect(calls("discussion.retry")).toEqual([]);
  });

  it("wide: the closure line stays visible on the Map", async () => {
    current = { view: sessionView({ session: { status: "closed", closures: [{ at: CLOSED_AT, basis: "manual", source: "ui", actor: { kind: "human" } }] } }) };
    const s = await openScreen();
    const line = textLines(s.render()).find((l) => /^Closed\b/.test(l));
    expect(line, "Grilling shows the closure line (control)").toBeDefined();
    expect(textLines(await toMap(s, false))).toContain(line);
  });

  // Audit of 2d9dd61 (SessionNotices above the Map, the same row inline in Grilling).
  it("one copy of the row in either view: one tools line and one set of recovery controls", async () => {
    current = { view: manual({ id: "r1", at: PROPOSED_AT, state: "unknown" }, { tools: "not_attached" }) };
    const s = await openScreen();
    const count = (t: unknown) => ({
      tools: textLines(t).filter((l) => /^Roadmap tools: /.test(l)).length,
      check: controls(t, /^Check chat$/).length,
      delivered: controls(t, /^Mark as delivered$/).length,
      notDelivered: controls(t, /^Mark as not delivered$/).length,
    });
    expect(count(s.render()), "Grilling").toEqual({ tools: 1, check: 1, delivered: 1, notDelivered: 1 });
    expect(count(await toMap(s, false)), "Map").toEqual({ tools: 1, check: 1, delivered: 1, notDelivered: 1 });
    await press(one(controls(await openMenu(s), /^(✓ )?Grilling$/), "Grilling"));
    expect(count(s.render()), "Grilling again").toEqual({ tools: 1, check: 1, delivered: 1, notDelivered: 1 });
  });

  it("a mark pending across a switch to the Map and back sends nothing more on its own, and its late reply triggers no other call", async () => {
    current = { view: manual({ id: "r1", at: PROPOSED_AT, state: "unknown" }) };
    let settle: (v: unknown) => void = () => undefined;
    h.state.answers["discussion.retry.resolve"] = () => new Promise((res) => (settle = res));
    const s = await openScreen();
    one(controls(s.render(), /^Mark as delivered$/), "Mark as delivered").props.onPress();
    await flush();
    await toMap(s, false);
    await press(one(controls(await openMenu(s), /^(✓ )?Grilling$/), "Grilling"));
    await toMap(s, false);
    settle({ ok: true, value: { revision: 8 } });
    await flush();
    s.render();
    const sent = writes().map((c) => c.name);
    expect(sent, "only the one mark the owner pressed").toEqual(["discussion.retry.resolve"]);
    expect(calls("discussion.retry"), "never a retry").toEqual([]);
    expect(calls("discussion.retry.check"), "no check on its own").toEqual([]);
  });

  it("on the Map the marks act at the revision now shown (after a refresh), on this session's retry", async () => {
    current = { view: manual({ id: "r1", at: PROPOSED_AT, state: "unknown" }) };
    const s = await openScreen();
    await toMap(s, false);
    const newer = manual({ id: "r1", at: PROPOSED_AT, state: "unknown" });
    newer.revision = 9;
    current = { view: newer };
    h.state.cacheRevision = 9;
    await press(one(controls(s.render(), /^Mark as delivered$/), "Mark as delivered"));
    expect(calls("discussion.retry.resolve").map((c) => c.input)).toEqual([expect.objectContaining({ sessionId: "S", retryId: "r1", outcome: "delivered", expectedRevision: 9 })]);
  });

  // Compact Map reachability (host check of 2d9dd61, docs/reviews/2026-11-11-r7-2d9dd61-notices-host.md):
  // plan r4 §2.9 keeps the compact layout bounded ("one vertical scroll region (the canvas with its
  // notices) … nothing else scrolls"), and W8 asks of the compact Map "toolbar of 44 px controls …,
  // List is reachable"; §2.1 keeps the notice row visible. On the host the compact panel does not
  // scroll (a swipe left the Map's viewport where it was). Structure only, no pixel geometry: a control
  // is reachable whatever the notices hold when it lies in a vertical scroll region, or when the
  // state-dependent notice row that precedes it in the same non-scrolling column declares a bounded
  // height (height / maxHeight); the graph's own scroll view is also reachable when it declares a
  // minimum height. In compact Grilling the notices are inside the canvas's scroll region (the control).
  const vScroll = (el: El) => ["ScrollView", "RNScrollView"].includes(nameOf(el)) && el.props.horizontal !== true;
  function pathTo(root: unknown, target: unknown): Node[] | null {
    const walk = (n: unknown, up: Node[]): Node[] | null => {
      if (n === null || typeof n !== "object") return null;
      if (Array.isArray(n)) {
        for (const c of n) {
          const r = walk(c, up);
          if (r) return r;
        }
        return null;
      }
      const el = n as Node;
      if (!el.props) return null;
      const here = [...up, el];
      if (el === target) return here;
      return walk(el.props.children, here);
    };
    return walk(root, []);
  }
  const flatStyle = (el: El): Record<string, unknown> => Object.assign({}, ...[el.props.style].flat(Infinity).filter(Boolean));
  const bounded = (el: El) => ["height", "maxHeight"].some((k) => typeof flatStyle(el)[k] === "number");
  /** Why `target` may be pushed out of reach by the notice row, or null when it cannot be. */
  function unreachable(root: unknown, target: El, opts: { graph?: boolean } = {}): string | null {
    const path = pathTo(root, target);
    if (path === null) return "not in the tree";
    if (path.slice(0, -1).some(vScroll)) return null;
    if (opts.graph === true && Number(flatStyle(target).minHeight ?? 0) > 0) return null;
    const order = all(root);
    const row = all(root, (el) => el.from === "SessionNotices" || (all(el, (x) => /^Delivery outcome unknown/.test(textOf(x))).length > 0 && controls(el, /^Check chat$/).length > 0 && controls(el, /^List$/).length === 0)).pop();
    if (row === undefined) return null;
    if (order.indexOf(row) > order.indexOf(target)) return null;
    // A bounded notice row keeps the toolbar's controls in reach, but not the graph: on the host
    // (ec71b5b, docs/reviews/2026-11-11-r7-ec71b5b-notice-bound-host.md) a row at its 200 px bound left
    // the graph 0 px tall at 320 × 640 and 390 × 640, with Fit, Find question and List still reachable. The
    // graph's viewport is what is left of the column, so only an outer scroll region or a declared minimum
    // height of its own keeps it in reach.
    if (opts.graph === true) return "the graph's viewport is what the bounded column leaves: no outer scroll region and no minimum height";
    const rowPath = pathTo(root, row) ?? [];
    if (rowPath.some((el) => bounded(el) || vScroll(el))) return null;
    return "no vertical scroll region holds it, and the notice row before it in the same column has no bounded height";
  }

  it("compact Map with the full notice row: Fit, Find question, List and the graph stay reachable by scrolling or a bounded notice row", async () => {
    current = { view: manual({ id: "r1", at: PROPOSED_AT, state: "unknown" }, { tools: "not_attached" }) };
    h.state.agentStatuses = { [PLANNER]: "running" };
    const s = await openScreen({ compact: true });
    const t = await toMap(s, true);
    // The situation: the whole notice row is drawn, its controls 44 px.
    expect(visibleText(t)).toMatch(/Roadmap tools: not attached/);
    expect(visibleText(t)).toMatch(/Delivery outcome unknown since/);
    for (const label of [/^Check chat$/, /^Mark as delivered$/, /^Mark as not delivered$/]) {
      const b = one(controls(t, label), String(label));
      expect(Number(flatStyle(b).minHeight), `${String(label)}: 44 px`).toBeGreaterThanOrEqual(44);
      // A notice row bounded without scrolling would clip its own controls: bounded means scrolled.
      const p = pathTo(t, b) ?? [];
      const clippedBy = p.slice(0, -1).find((el) => bounded(el) && !p.slice(p.indexOf(el)).some(vScroll));
      expect(clippedBy === undefined, `${String(label)} is not clipped by a bounded, non-scrolling notice row`).toBe(true);
    }
    const world = all(t, isGraphScroll);
    expect(world.length, "the graph's scroll view").toBe(1);
    const problems = [
      ...[/^(✓ )?Fit$/, /^(✓ )?Find question$/, /^(✓ )?List$/].map((re) => [String(re), unreachable(t, one(controls(t, re), String(re)))] as const),
      ["the graph", unreachable(t, world[0], { graph: true })] as const,
    ].filter(([, why]) => why !== null);
    expect(problems, "pushed out of reach by the notice row on a bounded compact panel").toEqual([]);
    expect(calls("discussion.retry"), "nothing is sent").toEqual([]);
  });

  // Audit of ec71b5b: on the compact Map the notice row scrolls in its own region ("Session notices"),
  // at most a third of the window's height and never more than 200 px; wide and Grilling unchanged.
  const noticeRegion = (t: unknown) => all(t, (el) => vScroll(el) && el.props.accessibilityLabel === "Session notices");
  async function withWindow<T>(size: { width: number; height: number } | "throws", run: () => Promise<T>): Promise<T> {
    h.state.window = size === "throws" ? null : size;
    try {
      return await run();
    } finally {
      h.state.window = { width: 1220, height: 847 };
    }
  }
  for (const [label, view] of [
    ["the short row (no planner)", () => sessionView({ session: { planner: undefined }, grilling: { plannerAgentId: undefined } })],
    ["the long row (unknown delivery, tools, interruption)", () => manual({ id: "r1", at: PROPOSED_AT, state: "unknown" }, { tools: "not_attached" })],
  ] as const) {
    it(`compact Map, ${label}: one bounded notice region holds the whole row; the toolbar and the graph are outside it`, async () => {
      current = { view: view() };
      h.state.agentStatuses = { [PLANNER]: "running" };
      await withWindow({ width: 320, height: 640 }, async () => {
        const s = await openScreen({ compact: true });
        const t = await toMap(s, true);
        const region = one(noticeRegion(t), "the notice region");
        const max = Number(flatStyle(region).maxHeight);
        expect(max, "a third of 640, at most 200").toBe(Math.min(200, Math.round(640 / 3)));
        expect(max, "room for at least one 44 px row").toBeGreaterThanOrEqual(44);
        for (const re of [/^Check chat$/, /^Mark as delivered$/, /^Mark as not delivered$/]) for (const el of controls(t, re)) expect(pathTo(t, el)?.includes(region), `${String(re)} in the region`).toBe(true);
        for (const re of [/^(✓ )?Fit$/, /^(✓ )?Find question$/, /^(✓ )?List$/]) expect(pathTo(t, one(controls(t, re), String(re)))?.includes(region), `${String(re)} outside the region`).toBe(false);
        expect(textLines(t).filter((l) => /^Roadmap tools: |^No planner bound$/.test(l)).length, "one copy of the row").toBeLessThanOrEqual(1);
      });
    });
  }

  for (const [label, size, expected] of [
    ["a 390 × 844 window", { width: 390, height: 844 }, 200],
    ["a landscape 640 × 320 window", { width: 640, height: 320 }, 107],
    ["no reported window", "throws", 200],
  ] as const) {
    it(`compact Map, ${label}: the notice region's bound is ${expected} px`, async () => {
      current = { view: manual({ id: "r1", at: PROPOSED_AT, state: "unknown" }) };
      await withWindow(size, async () => {
        const s = await openScreen({ compact: true });
        const t = await toMap(s, true);
        expect(Number(flatStyle(one(noticeRegion(t), "the notice region")).maxHeight)).toBe(expected);
      });
    });
  }

  it("compact Map: Check chat and a mark in the notice region act once on this session's retry, nothing else is sent", async () => {
    current = { view: manual({ id: "r1", at: PROPOSED_AT, state: "unknown" }) };
    const s = await openScreen({ compact: true });
    await toMap(s, true);
    await press(one(controls(s.render(), /^Check chat$/), "Check chat"));
    await press(one(controls(s.render(), /^Mark as delivered$/), "Mark as delivered"));
    expect(writes().map((c) => [c.name, c.input.sessionId, c.input.retryId])).toEqual([
      ["discussion.retry.check", "S", "r1"],
      ["discussion.retry.resolve", "S", "r1"],
    ]);
    expect(calls("discussion.retry")).toEqual([]);
  });

  // Audit of c3bc2ae: on the compact Map the notices and the Map now share one outer vertical scroll
  // region, so the toolbar (Zoom out, Zoom in) scrolls inside it. A tooltip shown on a toolbar control
  // is drawn in the panel's layer, which neither moves nor clips with the region; the rule of 16f6d01
  // hides it once its control has left the clipping region it was in, but only for a registered
  // region (the Grilling canvas is one). Model, as for the Summary case: measureInWindow answers from
  // fixed rectangles (the panel layer 0,0 320×640; the Map's scroll region 12,184 296×444, where its
  // element can be measured; Zoom in 120,392 44×44, then 120,100 after the scroll, above the region and
  // under the header), and the document is a fake that records the captured scroll listener.
  it("compact Map: a keyboard-shown Zoom in tooltip whose control scrolls up out of the Map's region is not drawn over the header", async () => {
    const listeners: Record<string, Array<() => void>> = {};
    vi.stubGlobal("document", {
      addEventListener: (type: string, fn: () => void) => void (listeners[type] ??= []).push(fn),
      removeEventListener: (type: string, fn: () => void) => void (listeners[type] = (listeners[type] ?? []).filter((f) => f !== fn)),
    });
    try {
      h.state.window = { width: 320, height: 640 };
      const s = await openScreen({ compact: true });
      await toMap(s, true);
      const box = (r: { x: number; y: number; w: number; h: number }) => ({ measureInWindow: (cb: (x: number, y: number, w: number, h: number) => void) => cb(r.x, r.y, r.w, r.h) });
      const LAYER = { x: 0, y: 0, w: 320, h: 640 };
      const REGION = { x: 12, y: 184, w: 296, h: 444 };
      const control = { x: 120, y: 392, w: 44, h: 44 };
      const HINT = "Zoom in one step (50, 75, 100, 125 %)";
      const isLayer = (el: El) => el.props.pointerEvents === "box-none" && flatStyle(el).position === "absolute" && el.props.ref && typeof el.props.ref === "object";
      const fit = () => {
        const t = s.render();
        for (const l of all(t, isLayer)) l.props.ref.current = box(LAYER);
        // The Map's outer region, wherever it carries a ref: the vertical scroll view that holds the notices and the toolbar.
        for (const r of all(t, (el) => vScroll(el) && el.props.ref && typeof el.props.ref === "object" && noticeRegion(el).length > 0 && controls(el, /^Zoom in$/).length > 0)) r.props.ref.current = box(REGION);
        const n = { ...box(control), matches: (sel: string) => sel === ":focus-visible", focus: () => undefined, blur: () => undefined };
        const zi = one(controls(t, /^Zoom in$/), "Zoom in");
        const ref = zi.props.ref;
        if (typeof ref === "function") ref(n);
        else if (ref && typeof ref === "object") ref.current = n;
        return n;
      };
      const n = fit();
      one(controls(s.render(), /^Zoom in$/), "Zoom in").props.onFocus?.({ nativeEvent: { type: "focus", target: n }, target: n });
      await flush();
      fit();
      const tops = () =>
        all(s.render(), isLayer).flatMap((l) => all(l, (el) => el !== l && flatStyle(el).position === "absolute" && all(el, (x) => nameOf(x) === "Text" && textOf(x) === HINT).length > 0)).map((el) => Number(flatStyle(el).top ?? NaN));
      expect(tops(), "before the scroll: below Zoom in (392 + 44 + 4)").toEqual([440]);
      control.y = 100;
      fit();
      for (const fn of listeners.scroll ?? []) fn();
      await new Promise((r) => setTimeout(r, 40));
      await flush();
      expect(listeners.scroll?.length ?? 0, "a scroll listener was registered").toBeGreaterThan(0);
      const outside = tops().filter((top) => top < REGION.y - LAYER.y);
      expect(outside, "bubble tops above the Map's region (over the header)").toEqual([]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  // Host check of 0bec24e (docs/reviews/2026-11-11-r7-0bec24e-compact-map-host.md, 320 × 640 and
  // 390 × 640 with a 230 px DOM proxy in the notice row): the notice region at its 200 px bound, the
  // Map's measured 320 px under it, the outer region 444 px high; its content is 200 + 8 + 320 = 528,
  // and the graph (the Map's last part) lay 84 px below the region's end until the owner scrolled it.
  // With the region scrolled part-way (34 px), Go to open Block 6 left Q126 only partly in view: Go to
  // scrolls the graph's own scroll views, not the region around it. OVERVIEW: Go to "brings that
  // block's first question into view". Since the graph ends the region's content, bringing it fully
  // into view means the region scrolled to its end; the case accepts scrollToEnd or a scrollTo at (or
  // past) that offset. The region and notice heights are delivered as React Native reports them
  // (onLayout); the long row's real height was not measured on the host (a proxy was used).
  it("compact Map with a long notice row: Go to open Block n also brings the graph into view in the outer region", async () => {
    current = { view: manual({ id: "r1", at: PROPOSED_AT, state: "unknown" }, { tools: "not_attached" }) };
    h.state.window = { width: 320, height: 640 };
    const s = await openScreen({ compact: true });
    await toMap(s, true);
    const outerOf = (t: unknown) => one(all(t, (el) => vScroll(el) && noticeRegion(el).length > 0 && controls(el, /^Zoom in$/).length > 0), "the Map's outer region");
    const asked: Array<{ y?: number } | "end"> = [];
    let outer = outerOf(s.render());
    const fake = { scrollTo: (o: { y?: number }) => void asked.push(o), scrollToEnd: () => void asked.push("end"), measureInWindow: (cb: (x: number, y: number, w: number, h: number) => void) => cb(12, 184, 296, 444) };
    const attachOuter = () => {
      outer = outerOf(s.render());
      const ref = outer.props.ref;
      if (typeof ref === "function") ref(fake);
      else if (ref && typeof ref === "object") ref.current = fake;
    };
    attachOuter();
    outer.props.onLayout?.({ nativeEvent: { layout: { x: 0, y: 0, width: 296, height: 444 } } });
    await flush();
    const region = one(noticeRegion(s.render()), "the notice region");
    region.props.onLayout?.({ nativeEvent: { layout: { x: 0, y: 0, width: 296, height: 200 } } });
    await flush();
    attachOuter();
    const mapBox = all(outerOf(s.render()), (el) => typeof flatStyle(el).height === "number" && controls(el, /^(✓ )?Fit$/).length > 0)[0];
    const mapH = Number(flatStyle(mapBox).height);
    const end = 200 + 8 + mapH - 444;
    expect(end, "the region has more content than room (the situation)").toBeGreaterThan(0);
    asked.length = 0;
    await press(one(controls(s.render(), /^Go to open Block \d+$/), "Go to open Block n"));
    await flush();
    attachOuter();
    const reached = asked.some((a) => a === "end" || (typeof a.y === "number" && a.y >= end));
    expect({ asked, end }, "the outer region is scrolled to show the graph").toEqual({ asked: expect.arrayContaining([expect.anything()]), end });
    expect(reached, `scrolled to the region's end (${end}) or further`).toBe(true);
    expect(writes(), "nothing is written").toEqual([]);
  });

  // Audit of a597cff: MapView calls onReveal on the owner's actions that bring a place into view, and the
  // compact screen scrolls its region to the end; layouts, zoom steps, lane toggles and the List/Graph
  // switch call nothing. Same model as the Go to case: the region and notice heights as onLayout.
  async function compactRevealSetup() {
    current = { view: manual({ id: "r1", at: PROPOSED_AT, state: "unknown" }, { tools: "not_attached" }) };
    h.state.window = { width: 320, height: 640 };
    const s = await openScreen({ compact: true });
    await toMap(s, true);
    const outerOf = (t: unknown) => one(all(t, (el) => vScroll(el) && noticeRegion(el).length > 0 && controls(el, /^(✓ )?(Graph|List)$/).length > 0), "the Map's outer region");
    const asked: Array<{ y?: number } | "end"> = [];
    const fake = { scrollTo: (o: { y?: number }) => void asked.push(o), scrollToEnd: () => void asked.push("end"), measureInWindow: (cb: (x: number, y: number, w: number, h: number) => void) => cb(12, 184, 296, 444) };
    const attachOuter = () => {
      const ref = outerOf(s.render()).props.ref;
      if (typeof ref === "function") ref(fake);
      else if (ref && typeof ref === "object") ref.current = fake;
    };
    attachOuter();
    outerOf(s.render()).props.onLayout?.({ nativeEvent: { layout: { x: 0, y: 0, width: 296, height: 444 } } });
    await flush();
    one(noticeRegion(s.render()), "the notice region").props.onLayout?.({ nativeEvent: { layout: { x: 0, y: 0, width: 296, height: 200 } } });
    await flush();
    attachOuter();
    asked.length = 0;
    const act = async (fn: () => Promise<void> | void) => {
      asked.length = 0;
      await fn();
      await flush();
      attachOuter();
      return asked.slice();
    };
    return { s, act };
  }

  it("compact Map: Fit, a Find question pick, a List row pick and a node press each scroll the region to its end", async () => {
    const { s, act } = await compactRevealSetup();
    expect(await act(() => press(one(controls(s.render(), /^(✓ )?Fit$/), "Fit"))), "Fit").toContain("end");
    expect(await act(async () => {
      await press(one(controls(s.render(), /^(✓ )?Find question$/), "Find question"));
      await press(controls(s.render(), /^Find Q\d+ /)[0]);
    }), "a Find question pick").toContain("end");
    await act(() => press(one(controls(s.render(), /^(✓ )?List$/), "List")));
    expect(await act(() => press(controls(s.render(), /^Show Q\d+ .* on the map$/)[0])), "a List row pick").toContain("end");
    for (const m of all(s.render(), (el) => nameOf(el) === "Modal" && el.props.open !== false && typeof el.props.onOpenChange === "function")) m.props.onOpenChange(false);
    await flush();
    const graphButton = controls(s.render(), /^(✓ )?Graph$/);
    if (graphButton.length > 0) await act(() => press(graphButton[0]));
    for (let i = 0; i < 4 && !/\b(75|100|125)\s?%/.test(visibleText(s.render())); i++) await press(one(controls(s.render(), /^Zoom in$/), "Zoom in"));
    const nodeQ1 = controls(s.render(), /^Q1 .*, Block \d+, \d+ incoming, \d+ outgoing$/);
    expect(nodeQ1.length, "Q1 is drawn as a node at 75 % or more").toBe(1);
    expect(await act(() => press(nodeQ1[0])), "a node press").toContain("end");
    expect(writes(), "nothing is written").toEqual([]);
  });

  it("compact Map: a zoom step, Show inactive and the List / Graph switch do not scroll the region; nor does a render", async () => {
    const { s, act } = await compactRevealSetup();
    expect(await act(() => press(one(controls(s.render(), /^Zoom in$/), "Zoom in"))), "a zoom step").toEqual([]);
    expect(await act(() => press(one(controls(s.render(), /^(✓ )?Show inactive$/), "Show inactive"))), "Show inactive").toEqual([]);
    expect(await act(() => press(one(controls(s.render(), /^(✓ )?List$/), "List"))), "List").toEqual([]);
    expect(await act(() => press(one(controls(s.render(), /^(✓ )?Graph$/), "Graph"))), "Graph").toEqual([]);
    expect(await act(() => { s.render(); }), "a render or layout alone").toEqual([]);
  });

  it("control: the wide Map has no region to reveal; Go to still works there", async () => {
    current = { view: manual({ id: "r1", at: PROPOSED_AT, state: "unknown" }) };
    const s = await openScreen();
    const t = await toMap(s, false);
    expect(all(t, (el) => vScroll(el) && noticeRegion(el).length > 0), "no outer region").toEqual([]);
    await press(one(controls(t, /^Go to open Block \d+$/), "Go to"));
    expect(writes()).toEqual([]);
  });

  it("control: the wide Map and compact Grilling have no separate notice region", async () => {
    current = { view: manual({ id: "r1", at: PROPOSED_AT, state: "unknown" }) };
    const wide = await openScreen();
    expect(noticeRegion(await toMap(wide, false)), "wide Map").toEqual([]);
    const compactGrilling = await openScreen({ compact: true });
    expect(noticeRegion(compactGrilling.render()), "compact Grilling").toEqual([]);
  });

  it("control: in compact Grilling the notice controls lie in the canvas's vertical scroll region", async () => {
    current = { view: manual({ id: "r1", at: PROPOSED_AT, state: "unknown" }, { tools: "not_attached" }) };
    const s = await openScreen({ compact: true });
    const t = s.render();
    for (const label of [/^Check chat$/, /^Mark as delivered$/, /^Mark as not delivered$/]) {
      const path = pathTo(t, one(controls(t, label), String(label))) ?? [];
      expect(path.slice(0, -1).some(vScroll), `${String(label)} scrolls with the canvas`).toBe(true);
    }
  });

  it("control: the check itself: a bounded notice row or an outer scroll region passes, the current structure does not", () => {
    const V = h.marker("View");
    const T = h.marker("Text");
    const P = h.marker("Pressable");
    const S = h.marker("ScrollView");
    const mk = (type: unknown, props: Record<string, unknown>) => ({ type, props }) as Node;
    const build = (rowStyle: Record<string, unknown>, outer: boolean) => {
      const list = mk(P, { accessibilityLabel: "List", onPress: () => undefined });
      const row = Object.assign(mk(V, { style: rowStyle, children: [mk(T, { children: "Delivery outcome unknown since 10:00" }), mk(P, { accessibilityLabel: "Check chat", onPress: () => undefined })] }), { from: "SessionNotices" });
      const column = mk(V, { style: { flex: 1, minHeight: 0 }, children: [row, mk(V, { style: { flex: 1, minHeight: 0 }, children: [list] })] });
      return { root: outer ? mk(S, { children: column }) : mk(V, { style: { flex: 1 }, children: column }), list };
    };
    const a = build({ flexShrink: 0 }, false);
    expect(unreachable(a.root, a.list), "the current shape").not.toBeNull();
    const b = build({ flexShrink: 0, maxHeight: 160 }, false);
    expect(unreachable(b.root, b.list), "a bounded notice row keeps a toolbar control in reach").toBeNull();
    expect(unreachable(b.root, b.list, { graph: true }), "but not the graph's viewport").not.toBeNull();
    const c = build({ flexShrink: 0 }, true);
    expect(unreachable(c.root, c.list), "an outer vertical scroll region").toBeNull();
  });

  // Controls (pass at 6f7a034): back on Grilling the row is there again; it belongs to its session.
  it("control: back on Grilling the unknown-delivery controls are there again, nothing was sent", async () => {
    current = { view: manual({ id: "r1", at: PROPOSED_AT, state: "unknown" }) };
    const s = await openScreen();
    await toMap(s, false);
    await press(one(controls(await openMenu(s), /^(✓ )?Grilling$/), "Grilling"));
    const t = s.render();
    for (const label of [/^Check chat$/, /^Mark as delivered$/, /^Mark as not delivered$/]) expect(controls(t, label).length, String(label)).toBe(1);
    expect(writes()).toEqual([]);
  });

  it("control: Session T (no planner, no retry) shows none of Session S's notices", async () => {
    current = { view: manual({ id: "r1", at: PROPOSED_AT, state: "unknown" }, { tools: "not_attached" }) };
    const s = await openScreen();
    await press(one(controls(cardOf(s.render(), `Q4 ${Q4}`), /^Superseded by\b/), "Superseded by"));
    const t = s.render();
    expect(all(t, (el) => /^Q\d+ T1 replacement$/.test(textOf(el))).length, "Session T is shown").toBeGreaterThan(0);
    expect(visibleText(t)).not.toMatch(/Roadmap tools: not attached|Delivery outcome unknown/);
    expect(controls(t, /^(Check chat|Mark as delivered|Mark as not delivered)$/)).toEqual([]);
  });
});

// ---- W4: blocks-only navigator and the block canvas ----
describe("blocks navigator", () => {
  it("one item per block with its state and question range; the open block is selected by default; no question rows", async () => {
    const t = (await openScreen()).render();
    const b1 = navItem(t, /^Block 1\b/);
    const b2 = navItem(t, /^Block 2\b/);
    expect(`${labelOf(b1)} ${textOf(b1.props.children)}`).toMatch(/accepted/);
    expect(`${labelOf(b1)} ${textOf(b1.props.children)}`).toMatch(/2 questions · Q1–Q2/);
    expect(`${labelOf(b2)} ${textOf(b2.props.children)}`).toMatch(/open/);
    expect(`${labelOf(b2)} ${textOf(b2.props.children)}`).toMatch(/2 questions · Q3–Q4/);
    expect(selected(b2)).toBe(true);
    expect(selected(b1)).toBe(false);
    expect(controls(t, /^Q\d+ /), "no question navigation rows").toEqual([]);
  });

  it("an empty block reads No questions yet; non-contiguous numbers are listed", async () => {
    current = {
      view: sessionView({
        session: { blocks: [{ id: "b1", order: 0, state: "accepted", openedAt: AT, acceptedAt: AT, acceptedBy: { kind: "human" } }, { id: "b2", order: 1, state: "open", openedAt: AT }] },
        questions: [qv(q("q1", Q1, { blockId: "b1", options: [opt("a", "A")] })), qv(q("q3", Q3, { blockId: "b1", options: [opt("a", "A")] }))],
        links: [],
      }),
    };
    const t = (await openScreen()).render();
    expect(textOf(navItem(t, /^Block 1\b/))).toMatch(/2 questions · Q1, Q3/);
    expect(textOf(navItem(t, /^Block 2\b/))).toMatch(/No questions yet/);
  });

  it("the proposal item appears only with an open proposal; a legacy session shows one All questions item and no proposal item", async () => {
    let t = (await openScreen()).render();
    expect(controls(t, /^Finish proposal/)).toEqual([]);
    current = { view: sessionView({ grilling: { finishProposal: { at: PROPOSED_AT, summary: "All decided.", skipped: [], outOfScope: [] } } }) };
    t = (await openScreen()).render();
    expect(textOf(navItem(t, /^Finish proposal/))).toMatch(/Not accepted yet/);

    current = { view: legacyView() };
    t = (await openScreen()).render();
    navItem(t, /^All questions/);
    expect(controls(t, /^Block \d/)).toEqual([]);
    expect(controls(t, /^Finish proposal/)).toEqual([]);
  });

  // DeepSeek Flash review 01a1c6ee c0002: a reopened, active session keeps its finished proposal in
  // `session.finishProposal` (finishedAt set) while the grilling view omits it. The screen reads the
  // grilling view: no proposal item and no Accept finish proposal for that stored, finished proposal.
  it("a reopened session whose stored proposal was finished shows no proposal item and no Accept", async () => {
    current = {
      view: sessionView({
        session: { status: "active", finishProposal: { at: PROPOSED_AT, agentId: PLANNER, summary: "All decided.", skipped: [], outOfScope: [], finishedAt: PROPOSED_AT, finishedBy: "manual" } },
      }),
    };
    expect(current.view.grilling?.finishProposal, "the grilling view has no open proposal").toBeUndefined();
    const t = (await openScreen()).render();
    expect(controls(t, /^Finish proposal/)).toEqual([]);
    expect(controls(t, /^Accept finish proposal/)).toEqual([]);
    expect(visibleText(t)).not.toMatch(/proposes to finish/i);
  });

  it("selecting a block shows that block's cards only", async () => {
    const s = await openScreen();
    let t = s.render();
    cardOf(t, `Q3 ${Q3}`);
    cardOf(t, `Q4 ${Q4}`);
    expect(() => cardOf(t, `Q1 ${Q1}`)).toThrow();
    t = await selectBlock(s, 1);
    expect(selected(navItem(t, /^Block 1\b/))).toBe(true);
    cardOf(t, `Q1 ${Q1}`);
    cardOf(t, `Q2 ${Q2}`);
    expect(() => cardOf(t, `Q3 ${Q3}`)).toThrow();
    expect(writes()).toEqual([]);
  });
});

describe("question cards: recorded answer, Edit, Description and Why recommended", () => {
  it("a card shows only the recorded answer: the chosen option with its tags, a free-text answer with its tag, or No answer yet", async () => {
    const s = await openScreen();
    let t = s.render();
    const q3 = textOf(cardOf(t, `Q3 ${Q3}`));
    expect(q3).toContain("No answer yet.");
    expect(q3).not.toContain("Long-lived session");
    const q4 = textOf(cardOf(t, `Q4 ${Q4}`));
    expect(q4).toMatch(/Chosen/);
    expect(q4).not.toMatch(/\bYes\b/);
    t = await selectBlock(s, 1);
    const q1 = textOf(cardOf(t, `Q1 ${Q1}`));
    expect(q1).toContain("Email and password");
    expect(q1).toMatch(/Chosen/);
    expect(q1).toMatch(/Recommended/);
    expect(q1).not.toContain("Passkeys");
    const q2 = textOf(cardOf(t, `Q2 ${Q2}`));
    expect(q2).toContain("Email address");
    expect(q2).toMatch(/free text/i);
  });

  it("Edit shows every option of the answer panel and Cancel hides it without any RPC", async () => {
    const s = await openScreen();
    await press(one(controls(cardOf(s.render(), `Q3 ${Q3}`), /^Edit$/), "Edit"));
    let card = cardOf(s.render(), `Q3 ${Q3}`);
    expect(textOf(card)).toContain("Long-lived session");
    expect(textOf(card)).toContain("Until the browser closes");
    const cancel = controls(card, /^Cancel$/);
    expect(cancel.length, "a Cancel control closes the panel").toBeGreaterThan(0);
    await press(cancel[0]);
    card = cardOf(s.render(), `Q3 ${Q3}`);
    expect(textOf(card)).not.toContain("Long-lived session");
    expect(writes()).toEqual([]);
  });

  it("choosing an option and Answer sends one question.answer for that question", async () => {
    const s = await openScreen();
    await press(one(controls(cardOf(s.render(), `Q3 ${Q3}`), /^Edit$/), "Edit"));
    await press(controls(cardOf(s.render(), `Q3 ${Q3}`), /Long-lived session/).filter((el) => typeof el.props.onPress === "function")[0]);
    expect(writes(), "choosing alone sends nothing").toEqual([]);
    await press(one(enabledControls(cardOf(s.render(), `Q3 ${Q3}`), /^Answer$/), "Answer"));
    expect(calls("question.answer").map((c) => c.input)).toEqual([expect.objectContaining({ sessionId: "S", questionId: "q3", optionId: "s1", expectedRevision: 7 })]);
  });

  it("on an accepted block Edit still offers the answer panel", async () => {
    const s = await openScreen();
    await selectBlock(s, 1);
    await press(one(controls(cardOf(s.render(), `Q1 ${Q1}`), /^Edit$/), "Edit"));
    expect(textOf(cardOf(s.render(), `Q1 ${Q1}`))).toContain("Passkeys");
  });

  it("Description shows the context and is absent when empty; Why recommended shows the recommended option's reason and is absent without one", async () => {
    const s = await openScreen();
    const q3 = cardOf(s.render(), `Q3 ${Q3}`);
    expect(controls(q3, /^Description$/)).toEqual([]);
    expect(controls(q3, /^Why recommended$/)).toEqual([]);
    await selectBlock(s, 1);
    let q1 = cardOf(s.render(), `Q1 ${Q1}`);
    expect(textOf(q1)).not.toContain(CONTEXT_Q1);
    expect(textOf(q1)).not.toContain(WHY_Q1);
    await press(one(controls(q1, /^Description$/), "Description"));
    q1 = cardOf(s.render(), `Q1 ${Q1}`);
    expect(textOf(q1)).toContain(CONTEXT_Q1);
    await press(one(controls(q1, /^Why recommended$/), "Why recommended"));
    expect(textOf(cardOf(s.render(), `Q1 ${Q1}`))).toContain(WHY_Q1);
    expect(writes()).toEqual([]);
  });

  it("hidden questions keep their section at the end of the canvas", async () => {
    const view = sessionView();
    view.questions.push(qv(q("q5", "Hidden follow-up", { blockId: "b2", options: [opt("a", "A")], activatedBy: [{ parent: ref("q4"), optionIds: ["yes"] }] }), { visibility: "inactive", status: "inactive" }));
    current = { view };
    const t = (await openScreen()).render();
    expect(controls(t, /Show hidden questions \(1\)/).length).toBe(1);
  });

  it("an empty open block says so and promises nothing", async () => {
    current = { view: sessionView({ questions: sessionView().questions.filter((x: any) => x.question.blockId === "b1") }) };
    const text = visibleText((await openScreen()).render());
    expect(text).toContain("No questions in this block yet.");
    expect(text).not.toMatch(/more questions|will ask|next questions are coming/i);
  });
});

// DeepSeek Flash review 01a1c7df-fec1 c0091: the canvas card (QuestionCanvasCard) shows the session's
// language as a chip on the first card of the shown block, and for a non-English language an "About
// the language" control that opens a modal with the note; the existing chip cases cover the old
// QuestionBody only.
describe("the language chip on the canvas card", () => {
  const isOpenModal = (el: El) => nameOf(el) === "Modal" && el.props.open !== false && el.props.visible !== false;
  const chips = (t: unknown) => all(t, (el) => nameOf(el) === "Text" && /^Language: /.test(textOf(el))).map((el) => textOf(el));
  it("English: the first card of the shown block carries \"Language: English\", no other card does, and there is no About the language", async () => {
    const s = await openScreen();
    const t = s.render();
    expect(chips(t), "one chip").toEqual(["Language: English"]);
    expect(chips(cardOf(t, `Q3 ${Q3}`)), "on the block's first card (Q3)").toEqual(["Language: English"]);
    expect(chips(cardOf(t, `Q4 ${Q4}`)), "not on the second card").toEqual([]);
    expect(controls(t, /^About the language$/)).toEqual([]);
    const b1 = await selectBlock(s, 1);
    expect(chips(cardOf(b1, `Q1 ${Q1}`)), "Block 1's first card").toEqual(["Language: English"]);
  });

  it("a non-English language: the chip names it, and About the language opens a modal with the note, which closes", async () => {
    current = { view: sessionView({ session: { language: "Русский", languageNoticeAck: { language: "Русский", at: AT } } }) };
    const s = await openScreen();
    let t = s.render();
    expect(chips(t)).toEqual(["Language: Русский"]);
    const about = one(controls(cardOf(t, `Q3 ${Q3}`), /^About the language$/), "About the language on the first card");
    expect(all(t, (el) => isOpenModal(el) && el.props.title === "About the language"), "no modal yet").toEqual([]);
    await press(about);
    t = s.render();
    const modal = one(all(t, (el) => isOpenModal(el) && el.props.title === "About the language"), "the About the language modal");
    expect(textOf(modal), "the note").toMatch(/no translation is performed/i);
    modal.props.onOpenChange(false);
    await flush();
    expect(all(s.render(), (el) => isOpenModal(el) && el.props.title === "About the language"), "closed").toEqual([]);
    expect(writes(), "reading the note writes nothing").toEqual([]);
  });
});

describe("relation links keep kind, direction and target", () => {
  it("each card lists its own stored relations and links with their kind and direction; no generic Related label", async () => {
    const s = await openScreen();
    let t = s.render();
    const q3 = cardOf(t, `Q3 ${Q3}`);
    expect(controls(q3, /^Depends on Q1\b/).length).toBe(1);
    expect(textOf(q3)).toMatch(/Informs session Session U/);
    const q4 = cardOf(t, `Q4 ${Q4}`);
    expect(controls(q4, /^Informed by Q2\b/).length).toBe(1);
    expect(controls(q4, /^Superseded by\b.*Session T/).length).toBe(1);
    expect(textOf(q4)).toMatch(/Supersedes a question that no longer exists/);
    expect(controls(q4, /no longer exists/), "a missing target is plain text").toEqual([]);
    expect(visibleText(t)).not.toMatch(/Related:/);
    expect(visibleText(t), "a link touching no question of this session is not shown").not.toContain("U1 question");
    t = await selectBlock(s, 1);
    const q1 = cardOf(t, `Q1 ${Q1}`);
    expect(controls(q1, /^Needed by Q2\b/).length).toBe(1);
    expect(controls(q1, /^Needed by Q3\b/).length).toBe(1);
    const q2 = cardOf(t, `Q2 ${Q2}`);
    expect(controls(q2, /^Depends on Q1\b/).length).toBe(1);
    expect(controls(q2, /^Informs Q4\b/).length).toBe(1);
  });

  it("a link to a question of another block selects that block; a link to another session opens it", async () => {
    const s = await openScreen();
    await press(one(controls(cardOf(s.render(), `Q4 ${Q4}`), /^Informed by Q2\b/), "Informed by Q2"));
    let t = s.render();
    expect(selected(navItem(t, /^Block 1\b/))).toBe(true);
    cardOf(t, `Q2 ${Q2}`);
    await selectBlock(s, 2);
    const asked = () => h.state.queryOptions.filter((o) => Array.isArray(o.queryKey) && o.queryKey[4] === "T").length;
    const before = asked();
    await press(one(controls(cardOf(s.render(), `Q4 ${Q4}`), /^Superseded by\b/), "Superseded by"));
    t = s.render();
    // DeepSeek Flash review 01a1c67a c0025: "Session T" and "T1 replacement" are already written on
    // Q4's card, so the press must lead to Session T's own screen: its view is read, its question has
    // a card, and Session S's Q4 card is gone.
    expect(asked(), "Session T's view is read").toBeGreaterThan(before);
    expect(all(t, (el) => /^Q\d+ T1 replacement$/.test(textOf(el))).length, "Session T's question has a card").toBeGreaterThan(0);
    expect(() => cardOf(t, `Q4 ${Q4}`), "Session S's Q4 card is gone").toThrow();
    expect(writes()).toEqual([]);
  });

  // DeepSeek Flash review 01a1c7df-fec1 c0093: a link to a whole session (no question), here Q3
  // "Informs session Session U", and the Map detail's "Open its session" for that end open the session's
  // own screen (onOpenSession); before, only the text was read.
  const uView = () => ({ revision: 7, session: { id: "U", title: "Session U", createdAt: AT, status: "active" }, cancellations: [], questions: [qv(q("u1", "U1 question"))], links: [], catalog: [] });
  const withU = () => {
    const base = h.state.query;
    h.state.query = (key: unknown[]) => (key[3] === "session" && key[4] === "U" ? { data: uView(), isError: false, isPending: false } : base(key));
  };
  const askedU = () => h.state.queryOptions.filter((o) => Array.isArray(o.queryKey) && o.queryKey[3] === "session" && o.queryKey[4] === "U").length;
  it("a link to a whole session (Informs session Session U) opens that session's screen", async () => {
    withU();
    const s = await openScreen();
    const before = askedU();
    await press(one(controls(cardOf(s.render(), `Q3 ${Q3}`), /^Informs session\b.*Session U/), "Informs session Session U"));
    const t = s.render();
    expect(askedU(), "Session U's view is read").toBeGreaterThan(before);
    expect(all(t, (el) => /^Q\d+ U1 question$/.test(textOf(el))).length, "Session U's question has a card").toBeGreaterThan(0);
    expect(() => cardOf(t, `Q3 ${Q3}`), "Session S's card is gone").toThrow();
    expect(writes()).toEqual([]);
  });

  it("the Map detail of that end offers Open its session, which opens Session U's screen", async () => {
    withU();
    const s = await openScreen();
    await press(one(controls(await openMenu(s), /^(✓ )?Map$/), "Map item"));
    const stub = controls(s.render(), /Session U/).filter((el) => !/^Q\d+ /.test(labelOf(el)));
    expect(stub.length, "the Session U end is drawn as a pressable stub").toBeGreaterThan(0);
    await press(stub[0]);
    const before = askedU();
    await press(one(enabledControls(s.render(), /^Open its session$/), "Open its session"));
    const t = s.render();
    expect(askedU(), "Session U's view is read").toBeGreaterThan(before);
    expect(all(t, (el) => /^Q\d+ U1 question$/.test(textOf(el))).length, "Session U's question has a card").toBeGreaterThan(0);
    expect(writes()).toEqual([]);
  });

  it("duplicate stored links collapse into one link", async () => {
    const base = sessionView();
    current = { view: { ...base, links: [...base.links, { id: "l1-copy", kind: "informs", from: ref("q2"), to: ref("q4") }] } };
    const t = (await openScreen()).render();
    expect(controls(cardOf(t, `Q4 ${Q4}`), /^Informed by Q2\b/).length).toBe(1);
  });
});

// DeepSeek Flash review 01a1c8ba-d7c3 c0129: a stored answer link pinned to a revision
// (roadmap://<project>/s/<session>/q/<n>/answer/r<rev>, shared/links.ts) opens that question's card
// with its History, the pinned revision marked; a revision the question does not have says so; an
// unpinned answer link focuses the current answer and opens no History. Here the links are in Q4's
// answer note (drawn with LinkText), and pressing one goes the panel's way: resolveTarget, a target
// with focus { rev }, the block selected, the canvas card's History modal.
describe("a pinned answer link opens the canvas card's History", () => {
  const rev = (n: number, optionId: string) => ({ rev: n, optionId, source: "ui", actor: { kind: "human" }, at: AT });
  const link = (tail: string, project = P) => `roadmap://${project}/s/S/q/1/answer${tail}`;
  function withLinks() {
    const base = sessionView();
    const questions = base.questions.map((x: any) => {
      if (x.question.id === "q1") return { ...x, question: { ...x.question, answer: rev(2, "m1"), revisions: [rev(1, "m2"), rev(2, "m1")] } };
      if (x.question.id === "q4")
        return { ...x, question: { ...x.question, answer: { ...x.question.answer, note: `See ${link("/r1")} and ${link("/r9")}, or ${link("")}; elsewhere ${link("/r1", "prj_other")}.` } } };
      return x;
    });
    return { ...base, questions };
  }
  const history = (t: unknown) => all(t, (el) => nameOf(el) === "Modal" && el.props.open !== false && el.props.title === "Q1 history");
  const linkControl = (t: unknown, raw: string) => one(controls(t, new RegExp(`^Open ${raw.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}$`)), `the link ${raw}`);

  it("a link pinned to an earlier revision selects Q1's block and opens its History with that revision marked not current", async () => {
    current = { view: withLinks() };
    const s = await openScreen();
    expect(history(s.render()), "no History before").toEqual([]);
    await press(linkControl(s.render(), link("/r1")));
    const t = s.render();
    expect(selected(navItem(t, /^Block 1\b/)), "Q1's block is selected").toBe(true);
    const modal = one(history(t), "Q1 history");
    const lines = textLines(modal);
    expect(lines, "the pinned revision, not current").toContain("Rev 1: Passkeys (not current; current is rev 2)");
    expect(lines, "the current revision").toContain("Rev 2: Email and password (current)");
    expect(textOf(modal)).not.toMatch(/does not exist/);
    expect(writes(), "nothing is written").toEqual([]);
  });

  it("a link pinned to a revision the question does not have opens its History and says so, marking no revision", async () => {
    current = { view: withLinks() };
    const s = await openScreen();
    await press(linkControl(s.render(), link("/r9")));
    const modal = one(history(s.render()), "Q1 history");
    expect(textOf(modal)).toContain("Revision 9 does not exist for this question.");
    expect(textOf(modal), "no revision is marked as pinned").not.toMatch(/not current/);
    expect(textLines(modal)).toContain("Rev 2: Email and password (current)");
  });

  it("after Close, the same pinned link opens the History again; an unpinned answer link opens none", async () => {
    current = { view: withLinks() };
    const s = await openScreen();
    await press(linkControl(s.render(), link("/r1")));
    one(history(s.render()), "Q1 history").props.onOpenChange(false);
    await flush();
    expect(history(s.render()), "closed").toEqual([]);
    await selectBlock(s, 2);
    await press(linkControl(s.render(), link("/r1")));
    expect(history(s.render()).length, "opened again by the same link").toBe(1);
    one(history(s.render()), "Q1 history").props.onOpenChange(false);
    await flush();
    await selectBlock(s, 2);
    await press(linkControl(s.render(), link("")));
    const t = s.render();
    expect(selected(navItem(t, /^Block 1\b/)), "the unpinned answer link selects Q1's block").toBe(true);
    expect(history(t), "and opens no History").toEqual([]);
  });

  // DeepSeek Flash review 01a1c8d3 c0156: the link opens History once. Closing it and choosing another
  // block and then Q1's block again remounts Q1's card; that is not a new link, so History stays shut.
  it("after Close, leaving the block and coming back does not open the History again", async () => {
    current = { view: withLinks() };
    const s = await openScreen();
    await press(linkControl(s.render(), link("/r1")));
    one(history(s.render()), "Q1 history").props.onOpenChange(false);
    await flush();
    expect(history(s.render()), "closed").toEqual([]);
    await selectBlock(s, 2);
    const t = await selectBlock(s, 1);
    expect(selected(navItem(t, /^Block 1\b/)), "back on Q1's block").toBe(true);
    expect(history(t), "no History without a new link").toEqual([]);
    expect(writes()).toEqual([]);
  });

  // Audit of 44a22d1 (c0156): the pin ends when the owner chooses another block in the navigator. A
  // relation link also moves to another block (Q2 "Informs Q4" to Block 2) and back (Q4 "Informed by
  // Q2" to Block 1); coming back that way also remounts Q1's card, and that is not a new pinned link.
  it("after Close, leaving the block by a relation link and coming back by another does not open the History again", async () => {
    current = { view: withLinks() };
    const s = await openScreen();
    await press(linkControl(s.render(), link("/r1")));
    one(history(s.render()), "Q1 history").props.onOpenChange(false);
    await flush();
    expect(history(s.render()), "closed").toEqual([]);
    await press(one(controls(cardOf(s.render(), `Q2 ${Q2}`), /^Informs Q4\b/), "Informs Q4"));
    expect(selected(navItem(s.render(), /^Block 2\b/)), "on Block 2").toBe(true);
    await press(one(controls(cardOf(s.render(), `Q4 ${Q4}`), /^Informed by Q2\b/), "Informed by Q2"));
    const t = s.render();
    expect(selected(navItem(t, /^Block 1\b/)), "back on Q1's block").toBe(true);
    expect(history(t), "no History without a new pinned link").toEqual([]);
  });

  it("after Close, Map and back to Grilling does not open the History again", async () => {
    current = { view: withLinks() };
    const s = await openScreen();
    await press(linkControl(s.render(), link("/r1")));
    one(history(s.render()), "Q1 history").props.onOpenChange(false);
    await flush();
    await press(one(controls(await openMenu(s), /^(✓ )?Map$/), "Map"));
    await press(one(controls(await openMenu(s), /^(✓ )?Grilling$/), "Grilling"));
    const t = s.render();
    expect(selected(navItem(t, /^Block 1\b/)), "Q1's block is still selected").toBe(true);
    expect(history(t), "no History without a new pinned link").toEqual([]);
  });

  it("control: a pinned link of another project opens nothing and says so", async () => {
    current = { view: withLinks() };
    const s = await openScreen();
    await press(linkControl(s.render(), link("/r1", "prj_other")));
    const t = s.render();
    expect(history(t)).toEqual([]);
    expect(selected(navItem(t, /^Block 2\b/)), "the selection stays").toBe(true);
    expect(visibleText(t)).toMatch(/another project/i);
  });
});

describe("the More menu of a card", () => {
  const more = async (s: Screen, title: string) => {
    await press(one(controls(cardOf(s.render(), title), /^More\b/), "More"));
    return s.render();
  };

  it("an open-block card offers Copy link, History, Edit question, Relations, Clarify in chat and Cancel decision", async () => {
    const s = await openScreen();
    const t = await more(s, `Q3 ${Q3}`);
    for (const label of [/^Copy link$/, /^History$/, /^Edit question$/, /^Relations$/, /^Clarify in chat$/, /^Cancel decision$/]) {
      expect(controls(t, label).length, String(label)).toBeGreaterThan(0);
    }
    expect(controls(t, /^Copy answer link$/), "Q3 has no answer").toEqual([]);
  });

  it("an accepted-block card has no Edit question or Relations; an answered one offers Copy answer link", async () => {
    const s = await openScreen();
    await selectBlock(s, 1);
    const t = await more(s, `Q1 ${Q1}`);
    expect(controls(t, /^Edit question$/)).toEqual([]);
    expect(controls(t, /^Relations$/)).toEqual([]);
    expect(controls(t, /^Copy answer link$/).length).toBeGreaterThan(0);
  });
});

describe("Discuss in chat from a question card", () => {
  /** A planner composer as the 0.16 host resolves it: prompt snapshot, live draft with a selection. */
  function chatDraft(agentId: string, text: string, selection = { start: text.length, end: text.length }) {
    const live = { text, selection };
    const log: string[] = [];
    const focusRequests: Array<{ selection?: { start: number; end: number } }> = [];
    const composer = {
      get prompt() {
        return live.text;
      },
      insertText(t: string) {
        log.push("insert");
        live.text = live.text.slice(0, live.selection.start) + t + live.text.slice(live.selection.end);
        live.selection = { start: live.selection.start + t.length, end: live.selection.start + t.length };
      },
      async focus(o?: { selection?: { start: number; end: number } }) {
        log.push(`focus ${JSON.stringify(o ?? null)}`);
        focusRequests.push({ ...o });
        // The host clamps the offsets to the text.
        const clamp = (x: number) => Math.max(0, Math.min(x, live.text.length));
        if (o?.selection) live.selection = { start: clamp(o.selection.start), end: clamp(o.selection.end) };
      },
      setPrompt: () => void log.push("FORBIDDEN setPrompt"),
      setModel: async () => void log.push("FORBIDDEN setModel"),
      setMode: async () => void log.push("FORBIDDEN setMode"),
      setThinking: async () => void log.push("FORBIDDEN setThinking"),
      setProvider: async () => void log.push("FORBIDDEN setProvider"),
      setOptions: async () => void log.push("FORBIDDEN setOptions"),
    };
    return { agentId, live, log, focusRequests, composer };
  }
  function hostComposers(...drafts: Array<ReturnType<typeof chatDraft>>) {
    const selectors: unknown[] = [];
    h.state.composers = (selector: unknown) => {
      selectors.push(selector);
      const id = (selector as { agentId?: unknown }).agentId;
      return drafts.filter((d) => d.agentId === id).map((d) => d.composer);
    };
    return selectors;
  }
  const more = async (s: Screen, title: string) => {
    await press(one(controls(cardOf(s.render(), title), /^More\b/), "More"));
    return s.render();
  };

  for (const compact of [false, true]) {
    const where = compact ? "compact" : "wide";
    it(`${where}: the More item places Q3's block after the planner chat's draft, keeps a selection, and sends nothing`, async () => {
      const draft = chatDraft(PLANNER, "My notes so far", { start: 3, end: 8 });
      const other = chatDraft("agent-other", "other chat");
      const selectors = hostComposers(draft, other);
      const s = await openScreen({ compact });
      const t = await more(s, `Q3 ${Q3}`);
      const item = one(controls(t, /^Discuss in chat$/), "the Discuss in chat item");
      expect(String(item.props.hint ?? item.props.accessibilityHint ?? "")).toMatch(/without sending/i);
      const before = h.state.calls.length;
      await press(item);
      expect(draft.live.text).toBe(
        [
          "My notes so far",
          "",
          "--- Roadmap question Q3 ---",
          `Question: Q3 ${JSON.stringify(Q3)}`,
          "Current answer: none (status: Open)",
          `Link: roadmap://${P}/s/S/q/3`,
          "--- End of roadmap question Q3 ---",
        ].join("\n"),
      );
      // Observable placement, not a specific offset: one focus collapsing the cursor at or past the
      // draft's end, then one insert; the cursor ends after the block.
      expect(draft.log.map((l) => l.split(" ")[0])).toEqual(["focus", "insert"]);
      expect(draft.focusRequests).toHaveLength(1);
      const sel = draft.focusRequests[0]?.selection;
      if (sel === undefined) throw new Error("focus requested no selection");
      expect(sel.start).toBe(sel.end);
      expect(sel.start).toBeGreaterThanOrEqual("My notes so far".length);
      expect(draft.live.selection).toEqual({ start: draft.live.text.length, end: draft.live.text.length });
      expect(draft.log.filter((l) => l.startsWith("FORBIDDEN"))).toEqual([]);
      expect(other.live.text).toBe("other chat");
      expect(other.log).toEqual([]);
      expect(selectors.every((x) => JSON.stringify(x) === JSON.stringify({ agentId: PLANNER }))).toBe(true);
      expect(h.state.calls.slice(before).filter((c) => !READS.test(c.name))).toEqual([]);
      expect(h.state.toasts.at(-1)).toMatch(/placed in the chat draft/i);
      // The menu closed.
      expect(controls(s.render(), /^Discuss in chat$/)).toEqual([]);
    });
  }

  it("an answered question's block carries its current answer and revision", async () => {
    const draft = chatDraft(PLANNER, "");
    hostComposers(draft);
    const s = await openScreen();
    await selectBlock(s, 1);
    const t = await more(s, `Q1 ${Q1}`);
    await press(one(controls(t, /^Discuss in chat$/), "the Discuss in chat item"));
    expect(draft.live.text).toContain('Current answer (rev 1): "Email and password"');
    expect(draft.live.text).toContain(`Link: roadmap://${P}/s/S/q/1`);
  });

  it("without a bound planner there is no Discuss in chat item", async () => {
    hostComposers(chatDraft(PLANNER, ""));
    current = { view: sessionView({ session: { planner: undefined }, grilling: { status: "no_planner", plannerAgentId: undefined, epoch: undefined } }) };
    const s = await openScreen();
    const t = await more(s, `Q3 ${Q3}`);
    expect(controls(t, /^Discuss in chat$/)).toEqual([]);
  });

  it("the planner chat unavailable on this host: an actionable error, and no other chat's draft changes", async () => {
    const other = chatDraft("agent-other", "other chat");
    hostComposers(other);
    const s = await openScreen();
    const t = await more(s, `Q3 ${Q3}`);
    await press(one(controls(t, /^Discuss in chat$/), "the Discuss in chat item"));
    expect(h.state.toasts.at(-1)).toMatch(/planner chat is not available/i);
    expect(other.log).toEqual([]);
    expect(other.live.text).toBe("other chat");
  });

  it("a host without the composer API: the item reports that Paseo must be updated", async () => {
    const s = await openScreen();
    const t = await more(s, `Q3 ${Q3}`);
    await press(one(controls(t, /^Discuss in chat$/), "the Discuss in chat item"));
    expect(h.state.toasts.at(-1)).toMatch(/cannot place text in a chat draft/i);
  });

  it("the Clarify section keeps Send to chat and offers Discuss in chat next to it", async () => {
    const draft = chatDraft(PLANNER, "draft");
    hostComposers(draft);
    const s = await openScreen();
    const t = await more(s, `Q3 ${Q3}`);
    await press(one(controls(t, /^Clarify in chat$/), "Clarify in chat"));
    const card = cardOf(s.render(), `Q3 ${Q3}`);
    expect(controls(card, /^Send to chat$/).length).toBe(1);
    const discuss = one(controls(card, /^Discuss in chat$/), "the Discuss in chat button");
    await press(discuss);
    expect(draft.live.text.startsWith("draft\n\n--- Roadmap question Q3 ---")).toBe(true);
  });
});

// ---- W5: add a question with an optional free-text answer; Accept under the open block ----
describe("add question to the open block", () => {
  it("the row is on the open block only; an accepted block shows the accepted footer instead", async () => {
    const s = await openScreen();
    expect(controls(s.render(), /^Add question to Block 2$/).length).toBe(1);
    const t = await selectBlock(s, 1);
    expect(controls(t, /^Add question to Block/)).toEqual([]);
    expect(visibleText(t)).toMatch(/Block 1 is accepted/);
  });

  it("the form refuses an empty, a short and a duplicate title without any RPC", async () => {
    const s = await openScreen();
    await openAddForm(s);
    for (const title of ["", "abc", "  lock the ACCOUNT after failed attempts?  "]) {
      await type(s, QUESTION_FIELD, title);
      const add = controls(s.render(), SUBMIT);
      if (add.length > 0 && !isDisabled(add[0])) await press(add[0]);
    }
    expect(calls("question.create")).toEqual([]);
  });

  it("Add sends one question.create with no options, free text allowed and no answerText when the answer is empty", async () => {
    const s = await openScreen();
    await openAddForm(s);
    await type(s, QUESTION_FIELD, "  Which password rules apply?  ");
    await press(one(enabledControls(s.render(), SUBMIT), "Add"));
    expect(calls("question.create").map((c) => c.input)).toEqual([
      { projectId: P, expectedRevision: 7, sessionId: "S", blockId: "b2", title: "Which password rules apply?", context: "", options: [], allowFreeText: true, activatedBy: [], invalidatedBy: [] },
    ]);
  });

  // DeepSeek Flash review 01a1c822 c0115: with the answer recorded (rev 1) the form closes with no
  // "answer was not recorded" notice; without rev it says so (the control).
  it("an answer recorded with the question (rev 1) is not reported as not recorded; one without rev is", async () => {
    for (const [rev, said] of [
      [1, false],
      [undefined, true],
    ] as const) {
      h.state.calls = [];
      h.state.answers["question.create"] = () => ({ ok: true, value: { revision: 8, questionId: "q9", visibilityChanged: [], ...(rev !== undefined ? { rev } : {}) } });
      const s = await openScreen();
      await openAddForm(s);
      await type(s, QUESTION_FIELD, "Which password rules apply?");
      await type(s, ANSWER_FIELD, "At least twelve characters.");
      await press(one(enabledControls(s.render(), SUBMIT), "Add"));
      const t = s.render();
      expect(inputs(t, QUESTION_FIELD), `rev ${String(rev)}: the form closed`).toEqual([]);
      expect(/answer was not recorded/i.test(visibleText(t)), `rev ${String(rev)}`).toBe(said);
      expect(calls("question.create").length).toBe(1);
    }
  });

  it("an answer is sent as answerText", async () => {
    const s = await openScreen();
    await openAddForm(s);
    await type(s, QUESTION_FIELD, "Which password rules apply?");
    await type(s, ANSWER_FIELD, "At least twelve characters.");
    await press(one(enabledControls(s.render(), SUBMIT), "Add"));
    expect(calls("question.create").map((c) => c.input)).toEqual([expect.objectContaining({ blockId: "b2", options: [], allowFreeText: true, answerText: "At least twelve characters." })]);
  });

  it("Add is disabled while the request is pending, so a second press sends nothing", async () => {
    h.state.answers["question.create"] = () => new Promise(() => undefined);
    const s = await openScreen();
    await openAddForm(s);
    await type(s, QUESTION_FIELD, "Which password rules apply?");
    const add = one(enabledControls(s.render(), SUBMIT), "Add");
    add.props.onPress();
    await flush();
    const again = controls(s.render(), SUBMIT);
    for (const el of again) if (!isDisabled(el)) await press(el);
    expect(calls("question.create").length).toBe(1);
  });

  it("on revision_conflict the draft stays with a notice; when the open block changed the Add label names the new block and nothing is sent until the next press", async () => {
    h.state.answers["question.create"] = () => ({ ok: false, error: { code: "revision_conflict", message: "store revision changed" } });
    const s = await openScreen();
    await openAddForm(s);
    await type(s, QUESTION_FIELD, "Which password rules apply?");
    await press(one(enabledControls(s.render(), SUBMIT), "Add"));
    const moved = sessionView();
    moved.revision = 8;
    moved.session.blocks = [
      { id: "b1", order: 0, state: "accepted", openedAt: AT, acceptedAt: AT, acceptedBy: { kind: "human" } },
      { id: "b2", order: 1, state: "accepted", openedAt: AT, acceptedAt: AT, acceptedBy: { kind: "human" } },
      { id: "b3", order: 2, state: "open", openedAt: AT },
    ];
    current = { view: moved };
    h.state.cacheRevision = 8;
    const t = s.render();
    expect(calls("question.create").length).toBe(1);
    expect(one(inputs(t, QUESTION_FIELD), "the draft field").props.value).toBe("Which password rules apply?");
    expect(visibleText(t)).toMatch(/The roadmap changed meanwhile/);
    expect(visibleText(t)).toMatch(/Block 2 was accepted; this question will be added to Block 3/);
    h.state.answers["question.create"] = () => ({ ok: true, value: { revision: 9, questionId: "q9", visibilityChanged: [] } });
    await press(one(enabledControls(t, SUBMIT), "Add"));
    expect(calls("question.create").map((c) => c.input.blockId)).toEqual(["b2", "b3"]);
  });

  it("on a lost response the draft stays, one re-read is triggered and nothing is resent; a same-title question now present offers Discard draft and Add anyway", async () => {
    h.state.answers["question.create"] = () => {
      throw new Error("connection lost");
    };
    const s = await openScreen();
    await openAddForm(s);
    await type(s, QUESTION_FIELD, "Which password rules apply?");
    const before = h.state.invalidations.length;
    await press(one(enabledControls(s.render(), SUBMIT), "Add"));
    let t = s.render();
    expect(calls("question.create").length).toBe(1);
    expect(h.state.invalidations.length - before, "one re-read").toBe(1);
    expect(visibleText(t)).toMatch(/The request did not complete/);
    expect(one(inputs(t, QUESTION_FIELD), "the draft field").props.value).toBe("Which password rules apply?");
    const landed = sessionView();
    landed.revision = 8;
    landed.questions.push(qv(q("q9", "which password rules apply?", { blockId: "b2", allowFreeText: true })));
    current = { view: landed };
    h.state.cacheRevision = 8;
    t = s.render();
    expect(visibleText(t)).toMatch(/Q9 with this title now exists in Block 2/);
    expect(controls(t, /^Discard draft$/).length).toBe(1);
    expect(controls(t, /^Add anyway$/).length).toBe(1);
    expect(calls("question.create").length).toBe(1);
  });

  // DeepSeek Flash review 01a1c67a c0027: where a new question can go (addTarget, through the form on
  // the screen). A legacy session (no blocks) adds to its one list: the row has no block in its label
  // and question.create carries no blockId. A closed session, with or without blocks, offers no add
  // row and sends nothing, also when it closes while a draft is open.
  describe("legacy and closed sessions", () => {
    const LEGACY_ROW = /^Add question$/;
    it("legacy session: the row is \"Add question\" (no block), and Add sends one question.create without a blockId", async () => {
      current = { view: legacyView() };
      const s = await openScreen();
      expect(controls(s.render(), /^Add question to Block/), "no block row").toEqual([]);
      await press(one(controls(s.render(), LEGACY_ROW), "the add row"));
      await type(s, QUESTION_FIELD, "  Which login methods apply?  ");
      await press(one(enabledControls(s.render(), SUBMIT), "Add"));
      const sent = calls("question.create").map((c) => c.input);
      expect(sent).toEqual([{ projectId: P, expectedRevision: 4, sessionId: "S", title: "Which login methods apply?", context: "", options: [], allowFreeText: true, activatedBy: [], invalidatedBy: [] }]);
      expect("blockId" in sent[0], "no blockId key at all").toBe(false);
      expect(controls(s.render(), /^Add to Block/), "no block named on the submit").toEqual([]);
    });

    it("legacy session: a title already in the session is refused without any RPC", async () => {
      current = { view: legacyView() };
      const s = await openScreen();
      await press(one(controls(s.render(), LEGACY_ROW), "the add row"));
      await type(s, QUESTION_FIELD, " legacy SECOND ");
      expect(enabledControls(s.render(), SUBMIT), "Add is disabled for a duplicate").toEqual([]);
      expect(visibleText(s.render())).toMatch(/Q2 .*already has this title/);
      expect(calls("question.create")).toEqual([]);
    });

    // The duplicate error reads "Q<n> in this block already has this title." (add-question-form.tsx);
    // a legacy session has no blocks, and the lost-response notice there says "in this session".
    it("legacy session: the duplicate-title error does not speak of a block", async () => {
      current = { view: legacyView() };
      const s = await openScreen();
      await press(one(controls(s.render(), LEGACY_ROW), "the add row"));
      await type(s, QUESTION_FIELD, "Legacy second");
      const text = visibleText(s.render());
      expect(text).toMatch(/Q2 .*already has this title/);
      expect(text, "no block in a session without blocks").not.toMatch(/Q2 in this block already has this title/);
    });

    it("legacy session: on revision_conflict the draft stays and the next press sends again without a blockId, only then", async () => {
      h.state.answers["question.create"] = () => ({ ok: false, error: { code: "revision_conflict", message: "store revision changed" } });
      current = { view: legacyView() };
      const s = await openScreen();
      await press(one(controls(s.render(), LEGACY_ROW), "the add row"));
      await type(s, QUESTION_FIELD, "Which login methods apply?");
      await press(one(enabledControls(s.render(), SUBMIT), "Add"));
      const later = legacyView();
      later.revision = 5;
      current = { view: later };
      h.state.cacheRevision = 5;
      const t = s.render();
      expect(calls("question.create")).toHaveLength(1);
      expect(one(inputs(t, QUESTION_FIELD), "the draft field").props.value).toBe("Which login methods apply?");
      expect(visibleText(t)).toMatch(/The roadmap changed meanwhile/);
      h.state.answers["question.create"] = () => ({ ok: true, value: { revision: 6, questionId: "l3", visibilityChanged: [] } });
      await press(one(enabledControls(t, SUBMIT), "Add"));
      const sent = calls("question.create").map((c) => c.input);
      expect(sent.map((x) => [x.expectedRevision, "blockId" in x])).toEqual([[4, false], [5, false]]);
    });

    it("legacy session: on a lost response nothing is resent; the same title now present names the session, with Discard draft and Add anyway", async () => {
      h.state.answers["question.create"] = () => {
        throw new Error("connection lost");
      };
      current = { view: legacyView() };
      const s = await openScreen();
      await press(one(controls(s.render(), LEGACY_ROW), "the add row"));
      await type(s, QUESTION_FIELD, "Which login methods apply?");
      await press(one(enabledControls(s.render(), SUBMIT), "Add"));
      const landed = legacyView();
      landed.revision = 5;
      landed.questions.push(qv(q("l3", "which login methods apply?", { allowFreeText: true })));
      current = { view: landed };
      h.state.cacheRevision = 5;
      const t = s.render();
      expect(calls("question.create")).toHaveLength(1);
      expect(visibleText(t)).toMatch(/Q3 with this title now exists in this session/);
      expect(controls(t, /^Add anyway$/).length).toBe(1);
      expect(controls(t, /^Discard draft$/).length).toBe(1);
      expect(calls("question.create")).toHaveLength(1);
    });

    it("closed session with blocks: no add row on any block, and nothing can be sent", async () => {
      current = { view: sessionView({ session: { status: "closed" } }) };
      const s = await openScreen();
      for (const n of [1, 2]) {
        const t = await selectBlock(s, n);
        expect(controls(t, /^Add question/), `Block ${n}`).toEqual([]);
        expect(inputs(t, QUESTION_FIELD), `Block ${n}`).toEqual([]);
      }
      expect(calls("question.create")).toEqual([]);
    });

    it("closed legacy session: no add row, and nothing can be sent", async () => {
      const v = legacyView();
      v.session.status = "closed";
      current = { view: v };
      const s = await openScreen();
      expect(controls(s.render(), /^Add question/)).toEqual([]);
      expect(inputs(s.render(), QUESTION_FIELD)).toEqual([]);
      expect(calls("question.create")).toEqual([]);
    });

    it("a session closed (elsewhere) while a draft is open: the form goes and nothing is sent; reopened, the draft is back and is sent only on Add", async () => {
      const s = await openScreen();
      await openAddForm(s);
      await type(s, QUESTION_FIELD, "Which password rules apply?");
      const closed = sessionView({ session: { status: "closed" } });
      closed.revision = 8;
      current = { view: closed };
      h.state.cacheRevision = 8;
      let t = s.render();
      expect(inputs(t, QUESTION_FIELD), "the form is gone").toEqual([]);
      expect(controls(t, /^Add question|^Add( to Block \d+)?$/), "no add row and no Add").toEqual([]);
      await flush();
      expect(calls("question.create")).toEqual([]);
      const reopened = sessionView();
      reopened.revision = 9;
      current = { view: reopened };
      h.state.cacheRevision = 9;
      t = s.render();
      expect(one(inputs(t, QUESTION_FIELD), "the draft is back").props.value).toBe("Which password rules apply?");
      await flush();
      expect(calls("question.create"), "nothing sent on reopen").toEqual([]);
      await press(one(enabledControls(s.render(), SUBMIT), "Add"));
      expect(calls("question.create").map((c) => [c.input.expectedRevision, c.input.blockId])).toEqual([[9, "b2"]]);
    });
  });

  // KensAI 9126580 c0007 (fix d131d45): a create that was answered is never shown as a lost request,
  // even when the re-read after it fails: the form closes on the answer and offers no "Add anyway", so
  // nothing can write the question twice. The version poll still re-reads (case below).
  it("an answered create whose re-read fails closes the form and offers no recovery or second write", async () => {
    h.state.answers["question.create"] = () => ({ ok: true, value: { revision: 8, questionId: "q9", visibilityChanged: [] } });
    h.state.invalidateError = new Error("re-read failed");
    const s = await openScreen();
    await openAddForm(s);
    await type(s, QUESTION_FIELD, "Which password rules apply?");
    await press(one(enabledControls(s.render(), SUBMIT), "Add"));
    const t = s.render();
    expect(inputs(t, QUESTION_FIELD), "the form closed on the answer").toEqual([]);
    expect(visibleText(t)).not.toMatch(/The request did not complete/);
    expect(controls(t, /^(Add anyway|Discard draft)$/)).toEqual([]);
    expect(calls("question.create")).toHaveLength(1);
    expect(h.state.toasts.join(" ")).not.toMatch(/re-read failed/);
  });

  // After a lost call the owner decides: "Discard draft" writes nothing, "Add anyway" writes exactly
  // one question with the duplicate allowed, and nothing is sent without a press.
  it("after a lost call, Discard draft writes nothing and Add anyway writes once", async () => {
    for (const choice of ["Discard draft", "Add anyway"] as const) {
      h.state.calls = [];
      current = { view: sessionView() };
      h.state.cacheRevision = 7;
      h.state.answers["question.create"] = () => {
        throw new Error("connection lost");
      };
      const s = await openScreen();
      await openAddForm(s);
      await type(s, QUESTION_FIELD, "Which password rules apply?");
      await press(one(enabledControls(s.render(), SUBMIT), "Add"));
      const landed = sessionView();
      landed.revision = 8;
      landed.questions.push(qv(q("q9", "Which password rules apply?", { blockId: "b2", allowFreeText: true })));
      current = { view: landed };
      h.state.cacheRevision = 8;
      h.state.answers["question.create"] = () => ({ ok: true, value: { revision: 9, questionId: "q10", visibilityChanged: [] } });
      for (let i = 0; i < 3; i++) s.render();
      expect(calls("question.create"), `${choice}: nothing sent without a press`).toHaveLength(1);
      await press(one(controls(s.render(), new RegExp(`^${choice}$`)), choice));
      const sent = calls("question.create");
      if (choice === "Discard draft") {
        expect(sent, "Discard draft writes nothing").toHaveLength(1);
        expect(inputs(s.render(), QUESTION_FIELD), "the draft is gone").toEqual([]);
      } else {
        expect(sent, "Add anyway writes once").toHaveLength(2);
        expect(sent[1].input.title).toBe("Which password rules apply?");
        expect(sent[1].input.expectedRevision, "against the re-read revision").toBe(8);
      }
    }
  });

  // d131d45 leaves a failed re-read to "the version poll". The panel's version query must poll, and a
  // new store revision must re-read the roadmap's other queries (not only the version).
  it("the roadmap version is polled, and a new revision re-reads the roadmap's other queries", async () => {
    const s = await openScreen();
    const versionOpts = h.state.queryOptions.filter((o) => Array.isArray(o.queryKey) && o.queryKey.at(-1) === "version");
    expect(versionOpts.length, "the version query is read").toBeGreaterThan(0);
    const interval = versionOpts.at(-1).refetchInterval;
    expect(typeof interval === "number" && interval > 0 && interval <= 10_000, `polls (refetchInterval ${String(interval)})`).toBe(true);
    const before = h.state.invalidations.length;
    const next = sessionView();
    next.revision = 8;
    current = { view: next };
    s.render();
    await flush();
    s.render();
    const reread = h.state.invalidations.slice(before) as Array<{ queryKey?: unknown[]; predicate?: (q: { queryKey: unknown[] }) => boolean }>;
    const roadmap = reread.filter((f) => JSON.stringify(f.queryKey) === JSON.stringify(["decision-roadmap", HOST, P]));
    expect(roadmap.length, "a re-read of the roadmap after the new revision").toBeGreaterThan(0);
    const covers = (key: unknown[]) => roadmap.some((f) => f.predicate === undefined || f.predicate({ queryKey: key }));
    expect(covers(["decision-roadmap", HOST, P, "session", "S"]), "the session is re-read").toBe(true);
  });

  it("a successful create with an answer but without rev says the answer was not recorded", async () => {
    h.state.answers["question.create"] = () => ({ ok: true, value: { revision: 8, questionId: "q9", visibilityChanged: [] } });
    const s = await openScreen();
    await openAddForm(s);
    await type(s, QUESTION_FIELD, "Which password rules apply?");
    await type(s, ANSWER_FIELD, "At least twelve characters.");
    await press(one(enabledControls(s.render(), SUBMIT), "Add"));
    expect(visibleText(s.render())).toMatch(/the answer was not recorded/i);
  });
});

describe("Accept under the open block", () => {
  it("Accept block and continue is under the open block only and sends one block.accept; no Previous, Next or To current question exists", async () => {
    const s = await openScreen();
    let t = s.render();
    expect(controls(t, /^(Previous|Next|To current question)$/)).toEqual([]);
    const accept = one(enabledControls(t, /^Accept block and continue$/), "Accept");
    t = await selectBlock(s, 1);
    expect(controls(t, /^Accept block and continue$/)).toEqual([]);
    await selectBlock(s, 2);
    expect(accept).toBeDefined();
    await press(one(enabledControls(s.render(), /^Accept block and continue$/), "Accept"));
    expect(calls("block.accept").map((c) => c.input)).toEqual([{ projectId: P, expectedRevision: 7, sessionId: "S", blockId: "b2" }]);
  });

  it("after a successful Accept the new open block is selected; after a failed one the selection stays", async () => {
    h.state.answers["block.accept"] = () => {
      const next = sessionView();
      next.revision = 8;
      next.session.blocks = [
        { id: "b1", order: 0, state: "accepted", openedAt: AT, acceptedAt: AT, acceptedBy: { kind: "human" } },
        { id: "b2", order: 1, state: "accepted", openedAt: AT, acceptedAt: AT, acceptedBy: { kind: "human" } },
        { id: "b3", order: 2, state: "open", openedAt: AT },
      ];
      current = { view: next };
      h.state.cacheRevision = 8;
      return { ok: true, value: { revision: 8, blockId: "b2", nextBlockId: "b3" } };
    };
    let s = await openScreen();
    await press(one(enabledControls(s.render(), /^Accept block and continue$/), "Accept"));
    expect(selected(navItem(s.render(), /^Block 3\b/))).toBe(true);

    current = { view: sessionView() };
    h.state.cacheRevision = 7;
    h.state.answers["block.accept"] = () => ({ ok: false, error: { code: "invalid_input", message: "refused" } });
    s = await openScreen();
    await press(one(enabledControls(s.render(), /^Accept block and continue$/), "Accept"));
    expect(selected(navItem(s.render(), /^Block 2\b/))).toBe(true);
  });
});

// ---- W6b: the finish proposal canvas, the manual finish and the closed-state line ----
describe("finish proposal and manual finish", () => {
  const SUMMARY = "Sign-in is settled: email and password, verified addresses.";
  const proposed = (over: Record<string, unknown> = {}) =>
    sessionView({
      session: { finishProposal: { at: PROPOSED_AT, agentId: PLANNER, summary: SUMMARY, skipped: [2], outOfScope: [] }, ...over },
      grilling: { finishProposal: { at: PROPOSED_AT, summary: SUMMARY, skipped: [2], outOfScope: [] } },
    });

  it("the proposal item shows the full summary and numbers with Accept finish proposal, which sends one session.finish on the proposal basis", async () => {
    current = { view: proposed() };
    const s = await openScreen();
    expect(controls(s.render(), /^Accept finish proposal$/), "no proposal action outside the proposal canvas").toEqual([]);
    await press(navItem(s.render(), /^Finish proposal/));
    const t = s.render();
    expect(visibleText(t)).toContain(SUMMARY);
    expect(visibleText(t)).toMatch(/Skipped: Q?2/);
    expect(visibleText(t)).toMatch(/Out of scope: none/);
    await press(one(enabledControls(t, /^Accept finish proposal$/), "Accept finish proposal"));
    expect(calls("session.finish").map((c) => c.input)).toEqual([{ projectId: P, expectedRevision: 7, sessionId: "S", basis: "proposal", proposalAt: PROPOSED_AT }]);
  });

  it("a replaced proposal says it was proposed again", async () => {
    current = { view: proposed({ finishHistory: [{ at: AT, agentId: PLANNER, summary: "Earlier", skipped: [], outOfScope: [] }] }) };
    const t = (await openScreen()).render();
    expect(textOf(navItem(t, /^Finish proposal/))).toMatch(/Proposed again/);
  });

  it("Finish discussion… is offered in an active session with blocks without a proposal or recovery; Cancel sends nothing; confirming sends one manual session.finish", async () => {
    const s = await openScreen();
    await press(one(enabledControls(await openMenu(s), /^Finish discussion…$/), "Finish discussion…"));
    let t = s.render();
    expect(visibleText(t)).toMatch(/own decision/i);
    await press(one(controls(t, /^Cancel$/), "Cancel"));
    expect(calls("session.finish")).toEqual([]);
    expect(controls(s.render(), /^Finish discussion$/), "the confirmation closed").toEqual([]);

    await press(one(enabledControls(await openMenu(s), /^Finish discussion…$/), "Finish discussion…"));
    t = s.render();
    await press(one(enabledControls(t, /^Finish discussion$/), "confirm"));
    expect(calls("session.finish").map((c) => c.input)).toEqual([{ projectId: P, expectedRevision: 7, sessionId: "S", basis: "manual" }]);
  });

  it("with a proposal shown, one surface never renders a primary Finish twice and nothing offers Continue in chat", async () => {
    current = { view: proposed() };
    const s = await openScreen();
    await press(navItem(s.render(), /^Finish proposal/));
    const t = s.render();
    expect(controls(t, /^(Accept finish proposal|Finish discussion|Finish)$/).length).toBe(1);
    expect(controls(t, /Continue in chat/)).toEqual([]);
    await press(one(controls(t, /^Accept finish proposal$/), "Accept finish proposal"));
    expect(calls("session.finish").length).toBe(1);
  });

  it("a closed session shows no proposal item", async () => {
    current = { view: { ...proposed({ status: "closed" }), grilling: { ...proposed().grilling, finishProposal: undefined } } };
    expect(controls((await openScreen()).render(), /^Finish proposal/)).toEqual([]);
  });
});

describe("the closed-state line comes from the last closure", () => {
  const closure = (basis: "manual" | "proposal", at: string, extra: Record<string, unknown> = {}) => ({
    at, basis, ...(basis === "proposal" ? { proposalAt: PROPOSED_AT } : {}), source: "ui", actor: { kind: "human" }, ...extra,
  });
  const closedWith = (session: Record<string, unknown>) => sessionView({ session: { status: "closed", ...session } });
  const closedLines = async () => textLines((await openScreen()).render()).filter((l) => /^Closed\b/.test(l));

  it("accepting the proposal reads by accepting the chat's proposal", async () => {
    current = { view: closedWith({ closures: [closure("proposal", CLOSED_AT)], finishProposal: { at: PROPOSED_AT, agentId: PLANNER, summary: "S", skipped: [], outOfScope: [], finishedAt: CLOSED_AT, finishedBy: "proposal" } }) };
    const lines = await closedLines();
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join("\n")).toMatch(/by accepting the chat's proposal/);
  });

  it("a manual close with a standing proposal reads manually and says the proposal was not accepted; without one it does not", async () => {
    current = { view: closedWith({ closures: [closure("manual", CLOSED_AT)], finishProposal: { at: PROPOSED_AT, agentId: PLANNER, summary: "S", skipped: [], outOfScope: [], finishedAt: CLOSED_AT, finishedBy: "manual" } }) };
    let lines = (await closedLines()).join("\n");
    expect(lines).toMatch(/manually/);
    expect(lines).toMatch(/not accepted/);
    current = { view: closedWith({ closures: [closure("manual", CLOSED_AT)] }) };
    lines = (await closedLines()).join("\n");
    expect(lines).toMatch(/manually/);
    expect(lines).not.toMatch(/not accepted/);
  });

  it("a closed session without closures reads basis not recorded", async () => {
    current = { view: closedWith({}) };
    const lines = (await closedLines()).join("\n");
    expect(lines).toMatch(/basis not recorded/);
    expect(lines).not.toMatch(/manually|by accepting/);
  });

  it("closed again by the chat after a manual close and a reopen: the earlier manual closure is never presented as the current close", async () => {
    current = { view: closedWith({ closures: [closure("manual", CLOSED_AT, { reopenedAt: REOPENED_AT })] }) };
    const lines = (await closedLines()).join("\n");
    expect(lines.length).toBeGreaterThan(0);
    expect(lines).toMatch(/not recorded|by the chat/);
    expect(lines).not.toMatch(/manually|by accepting/);
  });

  it("accept, reopen, manual close: the line says manually although the proposal was accepted earlier", async () => {
    current = {
      view: closedWith({
        closures: [closure("proposal", CLOSED_AT, { reopenedAt: REOPENED_AT }), closure("manual", "2026-11-09T13:00:00.000Z")],
        finishProposal: { at: PROPOSED_AT, agentId: PLANNER, summary: "S", skipped: [], outOfScope: [], finishedAt: CLOSED_AT, finishedBy: "proposal" },
      }),
    };
    const lines = (await closedLines()).join("\n");
    expect(lines).toMatch(/manually/);
    expect(lines).not.toMatch(/by accepting/);
    expect(lines, "the earlier proposal stood at no point of this close").not.toMatch(/not accepted/);
  });

  it("after a reopen the active session names the reopen and the previous close", async () => {
    current = { view: sessionView({ session: { closures: [closure("manual", CLOSED_AT, { reopenedAt: REOPENED_AT })] } }) };
    const text = textLines((await openScreen()).render()).join("\n");
    expect(text).toMatch(/Reopened\b[^\n]*previously closed[^\n]*manual/);
  });
});

// ---- Safeguards carried over from the earlier layout ----
describe("safeguards", () => {
  it("a legacy session offers no Accept, no Finish discussion… and no proposal item", async () => {
    current = { view: legacyView() };
    const s = await openScreen();
    const t = s.render();
    expect(controls(t, /^Accept block and continue$/)).toEqual([]);
    expect(controls(t, /^Finish proposal/)).toEqual([]);
    expect(controls(await openMenu(s), /^Finish discussion…$/)).toEqual([]);
  });

  it("a cancelled question's card says Cancelled with its reason and cannot be answered; a stale one says Stale", async () => {
    const base = sessionView();
    base.questions = base.questions.map((x: any) =>
      x.question.id === "q4" ? { ...x, question: { ...x.question, validity: "stale", stale: { causeSessionId: "S", causeQuestionId: "q1", causeRev: 1, at: AT } }, status: "stale" } : x,
    );
    current = { view: { ...base, cancellations: [{ id: "c-q3", ref: ref("q3"), reason: "Dropped from scope", at: AT, actor: { kind: "human" } }] } };
    const s = await openScreen();
    const q3 = cardOf(s.render(), `Q3 ${Q3}`);
    expect(textOf(q3)).toMatch(/Cancelled/);
    expect(textOf(q3)).toContain("Dropped from scope");
    expect(enabledControls(q3, /^Edit$/), "a cancelled decision cannot be answered").toEqual([]);
    expect(textOf(cardOf(s.render(), `Q4 ${Q4}`))).toMatch(/Stale/);
  });

  it("a refused retry re-reads the roadmap at once; nothing is resent", async () => {
    current = { view: sessionView({ grilling: { status: "needs_manual", manualRecovery: true, retryCount: 1, lastRetry: { id: "r1", at: PROPOSED_AT, state: "failed" } } }) };
    h.state.agentStatuses = { [PLANNER]: "idle" };
    h.state.answers["discussion.retry"] = () => ({ ok: false, error: { code: "internal", message: "the host refused the retry before sending it; you may retry" } });
    const s = await openScreen();
    const before = h.state.invalidations.length;
    await press(one(enabledControls(await openMenu(s), /^Retry\b/), "Retry"));
    expect(calls("discussion.retry").length).toBe(1);
    expect(h.state.invalidations.length).toBeGreaterThan(before);
  });

  it("Change chat… opens the picker for this session at the rendered revision with the current planner; selection is kept; the picker closes when the session closes", async () => {
    const s = await openScreen();
    await selectBlock(s, 1);
    await press(one(controls(await openMenu(s), /^Change chat…$/), "Change chat…"));
    const picker = one(all(s.render(), (el) => el.from === "PlannerPicker"), "the planner picker");
    expect(picker.ownProps).toMatchObject({ sessionId: "S", revision: 7, currentAgentId: PLANNER });
    expect(selected(navItem(s.render(), /^Block 1\b/)), "the block stays selected").toBe(true);
    picker.ownProps!.onDone();
    await flush();
    expect(all(s.render(), (el) => el.from === "PlannerPicker")).toEqual([]);
    expect(selected(navItem(s.render(), /^Block 1\b/))).toBe(true);

    await press(one(controls(await openMenu(s), /^Change chat…$/), "Change chat…"));
    expect(all(s.render(), (el) => el.from === "PlannerPicker").length).toBe(1);
    current = { view: sessionView({ session: { status: "closed" } }) };
    expect(all(s.render(), (el) => el.from === "PlannerPicker"), "closed: the picker closes").toEqual([]);
    expect(writes()).toEqual([]);
  });

  it("every enabled control of the screen, the open menu and an open card declares a 44 px minimum height", async () => {
    const s = await openScreen();
    await press(one(controls(cardOf(s.render(), `Q3 ${Q3}`), /^More\b/), "More"));
    await press(trigger(s.render()));
    const flat = (style: unknown): Record<string, any> =>
      Object.assign({}, ...[style].flat(Infinity).filter(Boolean).map((x: any) => (typeof x === "function" ? x({ pressed: false, hovered: false }) : x)));
    const small = all(s.render(), (el) => nameOf(el) === "Pressable" && typeof el.props.onPress === "function" && !isDisabled(el))
      .filter((el) => {
        const st = flat(el.props.style);
        return !((st.minHeight ?? st.height ?? 0) >= 44);
      })
      .map((el) => labelOf(el));
    expect(small).toEqual([]);
  });
});

describe("Finish and Accept safety while a request is pending", () => {
  const SUMMARY = "All decided.";
  it("Accept finish proposal sends once while pending; the menu's Finish discussion… is unavailable meanwhile", async () => {
    current = {
      view: sessionView({
        session: { finishProposal: { at: PROPOSED_AT, agentId: PLANNER, summary: SUMMARY, skipped: [], outOfScope: [] } },
        grilling: { finishProposal: { at: PROPOSED_AT, summary: SUMMARY, skipped: [], outOfScope: [] } },
      }),
    };
    h.state.answers["session.finish"] = () => new Promise(() => undefined);
    const s = await openScreen();
    await press(navItem(s.render(), /^Finish proposal/));
    const accept = one(enabledControls(s.render(), /^Accept finish proposal$/), "Accept finish proposal");
    accept.props.onPress();
    await flush();
    for (const el of controls(s.render(), /^Accept finish proposal$/)) if (!isDisabled(el)) await press(el);
    expect(calls("session.finish").length).toBe(1);
    const menu = await openMenu(s);
    for (const el of controls(menu, /^Finish discussion…$/)) expect(isDisabled(el), "no second finish while one is pending").toBe(true);
  });

  it("the manual Finish sends once; the confirmation closes on the press", async () => {
    h.state.answers["session.finish"] = () => new Promise(() => undefined);
    const s = await openScreen();
    await press(one(enabledControls(await openMenu(s), /^Finish discussion…$/), "Finish discussion…"));
    const confirm = one(enabledControls(s.render(), /^Finish discussion$/), "confirm");
    confirm.props.onPress();
    await flush();
    expect(controls(s.render(), /^Finish discussion$/), "the confirmation closed").toEqual([]);
    expect(calls("session.finish").map((c) => c.input.basis)).toEqual(["manual"]);
  });
});

describe("add form keys", () => {
  it("Escape closes the form without any RPC; Cmd/Ctrl+Enter submits once", async () => {
    const s = await openScreen();
    await openAddForm(s);
    await type(s, QUESTION_FIELD, "Which password rules apply?");
    const field = () => one(inputs(s.render(), QUESTION_FIELD), "question field");
    field().props.onKeyPress?.({ nativeEvent: { key: "Escape" }, preventDefault: () => undefined });
    await flush();
    expect(inputs(s.render(), QUESTION_FIELD), "Escape closed the form").toEqual([]);
    expect(writes()).toEqual([]);

    await openAddForm(s);
    await type(s, QUESTION_FIELD, "Which password rules apply?");
    field().props.onKeyPress?.({ nativeEvent: { key: "Enter", metaKey: true }, metaKey: true, preventDefault: () => undefined });
    await flush();
    expect(calls("question.create").map((c) => c.input.title)).toEqual(["Which password rules apply?"]);
  });
});

// DeepSeek Flash review 01a1c737 c0052: the Chat menu's Grilling / Map switches the body, and the
// Grilling body (with the add form's draft and the selected block) is unmounted while the Map is
// shown. The approved plan (r4 §12.7, "‹ Back to Grilling") says the switch back keeps the selection
// for the session; the template switches by hiding a view, so its form text and selection stay. The
// plan states no rule for the add form's draft across the switch; §2.6 keeps it on every refusal
// and lost response. The harness drops an unmounted component's state as React does
// (h.state.unmount); with it off, all of these pass, which is how the loss went unseen.
describe("switching to the Map and back keeps the Grilling state", () => {
  async function toMode(s: Screen, mode: "Map" | "Grilling") {
    const t = await openMenu(s);
    await press(one(controls(t, new RegExp(`^(✓ )?${mode}$`)), mode));
    return s.render();
  }
  const canvasShown = (t: unknown) => all(t, (el) => el.from === "GrillingBlocks").length > 0;

  it("control: the Map replaces the Grilling body, and the switch back draws the canvas again", async () => {
    const s = await openScreen();
    expect(canvasShown(s.render()), "Grilling first").toBe(true);
    const map = await toMode(s, "Map");
    expect(canvasShown(map), "the Grilling body is unmounted on the Map").toBe(false);
    expect(controls(map, /^(✓ )?Fit$/).length, "the Map is shown").toBe(1);
    const back = await toMode(s, "Grilling");
    expect(canvasShown(back), "the canvas is back").toBe(true);
    expect(controls(back, /^Add question to Block 2$/).length).toBe(1);
  });

  it("control: the harness drops an unmounted component's state and runs its cleanups, and keeps a mounted one's", async () => {
    const react = await import("react");
    const cleaned: string[] = [];
    let setShown: (v: boolean) => void = () => undefined;
    const typed: Record<string, (v: string) => void> = {};
    function Field(p: { id: string }) {
      const [text, setText] = react.useState("");
      typed[p.id] = setText;
      react.useEffect(() => () => void cleaned.push(p.id), []);
      return { type: h.marker("Text"), props: { children: `${p.id}:${text}` }, key: null };
    }
    function Root() {
      const [shown, set] = react.useState(true);
      setShown = set;
      return { type: h.marker("View"), props: { children: [shown ? { type: Field, props: { id: "a" }, key: "a" } : null, { type: Field, props: { id: "b" }, key: "b" }] }, key: null };
    }
    const saved = h.state.reactDeps;
    h.state.reactDeps = true;
    try {
      const m = deepMount(Root, {});
      m.render();
      typed.a?.("kept?");
      typed.b?.("kept");
      expect(visibleText(m.render())).toMatch(/a:kept\?.*b:kept/s);
      setShown(false);
      m.render();
      expect(cleaned, "the unmounted field's cleanup ran").toEqual(["a"]);
      setShown(true);
      expect(visibleText(m.render()), "a starts afresh, b keeps its text").toMatch(/a:(?!kept).*b:kept/s);
    } finally {
      h.state.reactDeps = saved;
    }
  });

  it("the selected block stays selected after Map and back (plan r4 §12.7)", async () => {
    const s = await openScreen();
    let t = await selectBlock(s, 1);
    expect(selected(navItem(t, /^Block 1\b/)), "Block 1 selected").toBe(true);
    await toMode(s, "Map");
    t = await toMode(s, "Grilling");
    expect(selected(navItem(t, /^Block 1\b/)), "Block 1 is still selected").toBe(true);
    expect(selected(navItem(t, /^Block 2\b/)), "the open block did not take the selection back").toBe(false);
    expect(visibleText(t)).toMatch(/Block 1 is accepted/);
    expect(writes()).toEqual([]);
  });

  it("an unsent question and answer are still in the form after Map and back", async () => {
    const s = await openScreen();
    await openAddForm(s);
    await type(s, QUESTION_FIELD, "Which password rules apply?");
    await type(s, ANSWER_FIELD, "At least twelve characters.");
    await toMode(s, "Map");
    const t = await toMode(s, "Grilling");
    expect(inputs(t, QUESTION_FIELD).map((el) => el.props.value), "the question text").toEqual(["Which password rules apply?"]);
    expect(inputs(t, ANSWER_FIELD).map((el) => el.props.value), "the answer text").toEqual(["At least twelve characters."]);
    expect(writes(), "nothing was sent").toEqual([]);
  });

  it("after a lost response, Map and back keep the draft and the notice, and still send nothing", async () => {
    h.state.answers["question.create"] = () => {
      throw new Error("connection lost");
    };
    const s = await openScreen();
    await openAddForm(s);
    await type(s, QUESTION_FIELD, "Which password rules apply?");
    await press(one(enabledControls(s.render(), SUBMIT), "Add"));
    expect(visibleText(s.render())).toMatch(/The request did not complete/);
    await toMode(s, "Map");
    const t = await toMode(s, "Grilling");
    expect(inputs(t, QUESTION_FIELD).map((el) => el.props.value), "the draft").toEqual(["Which password rules apply?"]);
    expect(visibleText(t), "the uncertain outcome is still said").toMatch(/The request did not complete/);
    expect(calls("question.create").length, "nothing was resent").toBe(1);
  });

  it("after a revision_conflict, Map and back keep the draft and its notice", async () => {
    h.state.answers["question.create"] = () => ({ ok: false, error: { code: "revision_conflict", message: "store revision changed" } });
    const s = await openScreen();
    await openAddForm(s);
    await type(s, QUESTION_FIELD, "Which password rules apply?");
    await press(one(enabledControls(s.render(), SUBMIT), "Add"));
    expect(visibleText(s.render())).toMatch(/The roadmap changed meanwhile/);
    await toMode(s, "Map");
    const t = await toMode(s, "Grilling");
    expect(inputs(t, QUESTION_FIELD).map((el) => el.props.value), "the draft").toEqual(["Which password rules apply?"]);
    expect(visibleText(t)).toMatch(/The roadmap changed meanwhile/);
    expect(calls("question.create").length, "nothing was resent").toBe(1);
  });

  // ---- Audit of 57c036e (the session screen keeps the add form and the chosen block) ----
  /** question.create answers when the case says so. */
  function deferredCreate() {
    let settle: (v: unknown) => void = () => undefined;
    let fail: (e: unknown) => void = () => undefined;
    h.state.answers["question.create"] = () =>
      new Promise((res, rej) => {
        settle = res;
        fail = rej;
      });
    return { ok: (v: unknown) => settle(v), lose: () => fail(new Error("connection lost")) };
  }
  const draftValue = (t: unknown) => inputs(t, QUESTION_FIELD).map((el) => el.props.value);
  const noEnabledAdd = (t: unknown) => controls(t, SUBMIT).filter((el) => !isDisabled(el));
  async function sendPending(s: Screen) {
    await openAddForm(s);
    await type(s, QUESTION_FIELD, "Which password rules apply?");
    await type(s, ANSWER_FIELD, "At least twelve characters.");
    one(enabledControls(s.render(), SUBMIT), "Add").props.onPress();
    await flush();
  }

  it("Add in flight across Map and back: Add stays disabled with the draft shown, and nothing more is sent", async () => {
    deferredCreate();
    const s = await openScreen();
    await sendPending(s);
    await toMode(s, "Map");
    const t = await toMode(s, "Grilling");
    expect(draftValue(t), "the draft is shown while its request is in flight").toEqual(["Which password rules apply?"]);
    expect(controls(t, SUBMIT).length, "the Add button is there").toBe(1);
    expect(noEnabledAdd(t), "Add is disabled while pending").toEqual([]);
    for (const el of controls(t, SUBMIT)) if (!isDisabled(el)) await press(el);
    expect(calls("question.create").length).toBe(1);
  });

  it("a success that lands while the Map is shown: back on Grilling the form is closed and nothing is resent", async () => {
    const d = deferredCreate();
    const s = await openScreen();
    await sendPending(s);
    await toMode(s, "Map");
    d.ok({ ok: true, value: { revision: 8, questionId: "q9", visibilityChanged: [], rev: 1 } });
    await flush();
    s.render();
    const t = await toMode(s, "Grilling");
    expect(draftValue(t), "the form closed after its success").toEqual([]);
    expect(controls(t, /^Add question to Block 2$/).length, "the add row is back").toBe(1);
    expect(visibleText(t)).not.toMatch(/The request did not complete|The roadmap changed meanwhile/);
    // DeepSeek Flash review 01a1c822 c0115: the answer was recorded (rev 1), so nothing says otherwise.
    expect(visibleText(t), "a recorded answer is not reported as not recorded").not.toMatch(/answer was not recorded/i);
    expect(calls("question.create").length).toBe(1);
  });

  it("a refusal that lands while the Map is shown: back on Grilling the draft and the notice are there, nothing is resent", async () => {
    const d = deferredCreate();
    const s = await openScreen();
    await sendPending(s);
    await toMode(s, "Map");
    d.ok({ ok: false, error: { code: "revision_conflict", message: "store revision changed" } });
    await flush();
    s.render();
    const t = await toMode(s, "Grilling");
    expect(draftValue(t)).toEqual(["Which password rules apply?"]);
    expect(inputs(t, ANSWER_FIELD).map((el) => el.props.value)).toEqual(["At least twelve characters."]);
    expect(visibleText(t)).toMatch(/The roadmap changed meanwhile/);
    expect(one(controls(t, SUBMIT), "Add").props.disabled === true, "Add is enabled again for the owner's decision").toBe(false);
    expect(calls("question.create").length).toBe(1);
  });

  it("a lost response that lands while the Map is shown: back on Grilling the draft and the notice are there, one re-read, nothing is resent", async () => {
    const d = deferredCreate();
    const s = await openScreen();
    await sendPending(s);
    const before = h.state.invalidations.length;
    await toMode(s, "Map");
    d.lose();
    await flush();
    s.render();
    const t = await toMode(s, "Grilling");
    expect(draftValue(t)).toEqual(["Which password rules apply?"]);
    expect(visibleText(t)).toMatch(/The request did not complete/);
    expect(h.state.invalidations.length - before, "one re-read").toBe(1);
    expect(calls("question.create").length).toBe(1);
  });

  it("Cancel after Map and back discards the draft: the form reopens empty and nothing was sent", async () => {
    const s = await openScreen();
    await openAddForm(s);
    await type(s, QUESTION_FIELD, "Which password rules apply?");
    await toMode(s, "Map");
    let t = await toMode(s, "Grilling");
    await press(one(controls(t, /^Cancel$/), "Cancel"));
    t = s.render();
    expect(draftValue(t), "the form is closed").toEqual([]);
    await toMode(s, "Map");
    await toMode(s, "Grilling");
    t = await openAddForm(s);
    expect(draftValue(t), "a new form starts empty").toEqual([""]);
    expect(writes()).toEqual([]);
  });

  it("after a lost response, Map and back, a same-title question that landed: Discard draft closes the form and writes nothing more", async () => {
    const d = deferredCreate();
    const s = await openScreen();
    await sendPending(s);
    await toMode(s, "Map");
    d.lose();
    await flush();
    const landed = sessionView();
    landed.revision = 8;
    landed.questions.push(qv(q("q9", "which password rules apply?", { blockId: "b2", allowFreeText: true })));
    current = { view: landed };
    h.state.cacheRevision = 8;
    let t = await toMode(s, "Grilling");
    expect(visibleText(t)).toMatch(/Q9 with this title now exists in Block 2/);
    await press(one(controls(t, /^Discard draft$/), "Discard draft"));
    t = s.render();
    expect(draftValue(t)).toEqual([]);
    expect(writes().map((c) => c.name), "only the one create").toEqual(["question.create"]);
  });

  it("an applied link target is not applied again after Map and back; a new Open in Grilling is", async () => {
    const s = await openScreen();
    const mapNode = (t: unknown, n: number) => one(controls(t, new RegExp(`^Q${n} .*, Block \\d+, \\d+ incoming, \\d+ outgoing$`)), `node Q${n}`);
    // Open in Grilling from the Map's detail is a navigation target (a nonce) the canvas applies once.
    let t = await toMode(s, "Map");
    await press(mapNode(t, 3));
    await press(one(enabledControls(s.render(), /^Open (Q3 )?in Grilling$/), "Open in Grilling"));
    expect(selected(navItem(s.render(), /^Block 2\b/)), "the target selected Block 2").toBe(true);
    // The owner then chooses Block 1, which is not the default (the open Block 2 is): neither a reset
    // nor the old target applied again can leave Block 1 selected.
    await selectBlock(s, 1);
    await toMode(s, "Map");
    t = await toMode(s, "Grilling");
    expect(selected(navItem(t, /^Block 1\b/)), "the owner's later choice stands").toBe(true);
    expect(selected(navItem(t, /^Block 2\b/)), "the old target is not applied again").toBe(false);
    // A new navigation from the Map is applied.
    t = await toMode(s, "Map");
    await press(mapNode(t, 3));
    await press(one(enabledControls(s.render(), /^Open (Q3 )?in Grilling$/), "Open in Grilling"));
    expect(selected(navItem(s.render(), /^Block 2\b/)), "a new Open in Grilling selects Block 2").toBe(true);
    expect(writes()).toEqual([]);
  });

  it("the draft stays with its session: Session T opened from a link shows no draft, and its own form starts empty", async () => {
    const s = await openScreen();
    await openAddForm(s);
    await type(s, QUESTION_FIELD, "Which password rules apply?");
    await press(one(controls(cardOf(s.render(), `Q4 ${Q4}`), /^Superseded by\b/), "Superseded by"));
    let t = s.render();
    expect(all(t, (el) => /^Q\d+ T1 replacement$/.test(textOf(el))).length, "Session T is shown").toBeGreaterThan(0);
    expect(draftValue(t), "no form is open in Session T").toEqual([]);
    await press(one(controls(t, /^Add question$/), "Session T's add row"));
    t = s.render();
    expect(draftValue(t), "Session T's form starts empty").toEqual([""]);
    expect(writes()).toEqual([]);
  });
});

// DeepSeek Flash review 01a1c7df-fec1 c0094: Cancel stays enabled while a question.create is in flight,
// the add row then opens a new draft, and the earlier request's late reply is applied to whatever draft
// is current (client/add-question-form.tsx: a success closes it, a refusal or a lost response writes its
// outcome into it). Approved plan r4 §2.6 / SPEC: a refusal or lost response keeps *the* draft with its
// notice; nothing is resent on its own; Cancel closes the form and discards that draft. Nothing says a
// reply may close or annotate a different draft the owner typed afterwards. These cases send one create,
// Cancel, reopen and type a new draft, then let the first reply land.
describe("a late reply to an earlier question.create leaves a newer draft alone", () => {
  function deferredCreate() {
    let settle: (v: unknown) => void = () => undefined;
    let fail: (e: unknown) => void = () => undefined;
    h.state.answers["question.create"] = () =>
      new Promise((res, rej) => {
        settle = res;
        fail = rej;
      });
    return { ok: (v: unknown) => settle(v), lose: () => fail(new Error("connection lost")) };
  }
  const FIRST = "Which password rules apply?";
  const SECOND = "Who may reset a password?";
  const draftValue = (t: unknown) => inputs(t, QUESTION_FIELD).map((el) => el.props.value);
  /** Sends FIRST, cancels while it is in flight, reopens the form and types SECOND (with an answer). */
  async function cancelAndRetype() {
    const d = deferredCreate();
    const s = await openScreen();
    await openAddForm(s);
    await type(s, QUESTION_FIELD, FIRST);
    one(enabledControls(s.render(), SUBMIT), "Add").props.onPress();
    await flush();
    const cancel = one(controls(s.render(), /^Cancel$/), "Cancel");
    expect(isDisabled(cancel), "Cancel can be pressed while the request is in flight (the situation)").toBe(false);
    await press(cancel);
    expect(draftValue(s.render()), "the form closed").toEqual([]);
    await openAddForm(s);
    await type(s, QUESTION_FIELD, SECOND);
    await type(s, ANSWER_FIELD, "Only the account owner.");
    expect(draftValue(s.render()), "the new draft").toEqual([SECOND]);
    return { s, d };
  }

  it("an earlier success does not close the new draft or discard its text", async () => {
    const { s, d } = await cancelAndRetype();
    d.ok({ ok: true, value: { revision: 8, questionId: "q9", visibilityChanged: [], rev: undefined } });
    await flush();
    const t = s.render();
    expect(draftValue(t), "the new draft is still open with its text").toEqual([SECOND]);
    expect(inputs(t, ANSWER_FIELD).map((el) => el.props.value)).toEqual(["Only the account owner."]);
    expect(calls("question.create").map((c) => c.input.title), "only the first was sent").toEqual([FIRST]);
  });

  it("an earlier revision_conflict does not mark the new, unsent draft", async () => {
    const { s, d } = await cancelAndRetype();
    d.ok({ ok: false, error: { code: "revision_conflict", message: "store revision changed" } });
    await flush();
    const t = s.render();
    expect(draftValue(t)).toEqual([SECOND]);
    expect(visibleText(t), "no refusal notice on a draft that was never sent").not.toMatch(/The roadmap changed meanwhile/);
    expect(calls("question.create").length, "nothing resent").toBe(1);
  });

  it("an earlier lost response does not mark the new, unsent draft as not completed", async () => {
    const { s, d } = await cancelAndRetype();
    d.lose();
    await flush();
    const t = s.render();
    expect(draftValue(t)).toEqual([SECOND]);
    expect(visibleText(t), "no lost-response notice on a draft that was never sent").not.toMatch(/The request did not complete/);
    expect(calls("question.create").length, "nothing resent").toBe(1);
  });

  it("an earlier lost response whose title then exists does not offer the new draft Discard draft / Add anyway", async () => {
    const { s, d } = await cancelAndRetype();
    // The new draft retyped the same title as the first request (a likely retry after Cancel).
    await type(s, QUESTION_FIELD, FIRST);
    d.lose();
    await flush();
    const landed = sessionView();
    landed.revision = 8;
    landed.questions.push(qv(q("q9", FIRST, { blockId: "b2", allowFreeText: true })));
    current = { view: landed };
    h.state.cacheRevision = 8;
    const t = s.render();
    // The new draft was never sent: it is an ordinary duplicate, not a lost request's draft.
    expect(controls(t, /^(Discard draft|Add anyway)$/), "no lost-request recovery for a draft never sent").toEqual([]);
    expect(visibleText(t), "the ordinary duplicate error").toMatch(/Q9 in this block already has this title/);
    expect(calls("question.create").length).toBe(1);
  });

  // Audit of 1406488: a late success whose answer was not recorded (no `rev` in the output; SPEC: "A
  // create with an answer whose output has no rev says that the answer was not recorded") sets a notice
  // naming the earlier question. The notice is drawn only with the add row (no draft open), and the
  // newer draft's submit clears notices before it sends. The owner must be told at least once; when and
  // where is not decided here.
  async function sendWithAnswerCancelRetype() {
    const d = deferredCreate();
    const s = await openScreen();
    await openAddForm(s);
    await type(s, QUESTION_FIELD, FIRST);
    await type(s, ANSWER_FIELD, "At least twelve characters.");
    one(enabledControls(s.render(), SUBMIT), "Add").props.onPress();
    await flush();
    await press(one(controls(s.render(), /^Cancel$/), "Cancel"));
    return { s, d };
  }
  const NOT_RECORDED = /answer was not recorded/;
  const namesFirst = (t: unknown) => NOT_RECORDED.test(visibleText(t)) && visibleText(t).includes(FIRST);

  it("an earlier success whose answer was not recorded is told to the owner, though a newer draft was open and then sent", async () => {
    const { s, d } = await sendWithAnswerCancelRetype();
    await openAddForm(s);
    await type(s, QUESTION_FIELD, SECOND);
    d.ok({ ok: true, value: { revision: 8, questionId: "q9", visibilityChanged: [] } });
    await flush();
    const seenWhileOpen = namesFirst(s.render());
    // The newer draft is sent and lands (no answer, so no notice of its own).
    h.state.answers["question.create"] = () => ({ ok: true, value: { revision: 9, questionId: "q10", visibilityChanged: [] } });
    await press(one(enabledControls(s.render(), SUBMIT), "Add"));
    const seenAfter = namesFirst(s.render());
    expect({ seenWhileOpen, seenAfter }, `the owner is told, at some point, that ${FIRST}'s answer was not recorded`).not.toEqual({ seenWhileOpen: false, seenAfter: false });
    expect(calls("question.create").map((c) => c.input.title), "each draft sent once").toEqual([FIRST, SECOND]);
  });

  // Audit of 4850937 (SPEC: an alert above the open form or under the add row, one line per question,
  // kept through opening and sending other drafts until Dismiss; held only by the screen).
  const lateLines = (t: unknown) => all(t, (el) => nameOf(el) === "Text" && /was added, but its answer was not recorded/.test(textOf(el))).map((el) => textOf(el));
  const lateAlert = (t: unknown) => all(t, (el) => el.props.accessibilityRole === "alert" && /was added, but its answer was not recorded/.test(textOf(el)));
  it("the late notice is an alert naming the question, kept through the new draft's edits, Map and back, its submission, Cancel and reopening, until Dismiss", async () => {
    const { s, d } = await sendWithAnswerCancelRetype();
    await openAddForm(s);
    await type(s, QUESTION_FIELD, SECOND);
    d.ok({ ok: true, value: { revision: 8, questionId: "q9", visibilityChanged: [] } });
    await flush();
    let t = s.render();
    expect(lateLines(t), "one line, naming the first question").toEqual([expect.stringContaining(`“${FIRST}”`)]);
    const alert = one(lateAlert(t), "the late notice's alert");
    expect(alert.props.accessibilityLiveRegion, "a live region").toBe("polite");
    expect(draftValue(t), "the new draft is untouched").toEqual([SECOND]);
    await type(s, ANSWER_FIELD, "Only the account owner.");
    await press(one(controls(await openMenu(s), /^(✓ )?Map$/), "Map"));
    await press(one(controls(await openMenu(s), /^(✓ )?Grilling$/), "Grilling"));
    t = s.render();
    expect(lateLines(t).length, "after Map and back").toBe(1);
    expect(draftValue(t)).toEqual([SECOND]);
    h.state.answers["question.create"] = () => ({ ok: true, value: { revision: 9, questionId: "q10", visibilityChanged: [], rev: 1 } });
    await press(one(enabledControls(s.render(), SUBMIT), "Add"));
    expect(lateLines(s.render()).length, "after the new draft was sent").toBe(1);
    await openAddForm(s);
    expect(lateLines(s.render()).length, "after opening another draft").toBe(1);
    await press(one(controls(s.render(), /^Cancel$/), "Cancel"));
    t = s.render();
    expect(lateLines(t).length, "after Cancel").toBe(1);
    await press(one(controls(t, /^Dismiss$/), "Dismiss"));
    t = s.render();
    expect(lateLines(t), "dismissed").toEqual([]);
    expect(controls(t, /^Dismiss$/)).toEqual([]);
    expect(calls("question.create").map((c) => c.input.title), "each draft sent once").toEqual([FIRST, SECOND]);
  });

  it("two late notices for two questions are two lines; Dismiss leaves the open draft and its own notices alone", async () => {
    const d1 = deferredCreate();
    const s = await openScreen();
    // FIRST, with an answer, sent and cancelled; SECOND reopened.
    await openAddForm(s);
    await type(s, QUESTION_FIELD, FIRST);
    await type(s, ANSWER_FIELD, "At least twelve characters.");
    one(enabledControls(s.render(), SUBMIT), "Add").props.onPress();
    await flush();
    await press(one(controls(s.render(), /^Cancel$/), "Cancel"));
    await openAddForm(s);
    await type(s, QUESTION_FIELD, SECOND);
    await type(s, ANSWER_FIELD, "Only the account owner.");
    d1.ok({ ok: true, value: { revision: 8, questionId: "q9", visibilityChanged: [] } });
    await flush();
    // SECOND sent and cancelled the same way; a third draft opened.
    const d2 = deferredCreate();
    one(enabledControls(s.render(), SUBMIT), "Add").props.onPress();
    await flush();
    await press(one(controls(s.render(), /^Cancel$/), "Cancel"));
    await openAddForm(s);
    await type(s, QUESTION_FIELD, "Which sessions expire first?");
    d2.ok({ ok: false, error: { code: "revision_conflict", message: "x" } });
    await flush();
    let t = s.render();
    expect(lateLines(t), "only FIRST's: SECOND's refusal belongs to a closed draft").toEqual([expect.stringContaining(`“${FIRST}”`)]);
    expect(visibleText(t), "the open draft is not marked by SECOND's refusal").not.toMatch(/The roadmap changed meanwhile/);
    // A second late success for another question adds its own line.
    const d3 = deferredCreate();
    await type(s, ANSWER_FIELD, "The oldest.");
    one(enabledControls(s.render(), SUBMIT), "Add").props.onPress();
    await flush();
    await press(one(controls(s.render(), /^Cancel$/), "Cancel"));
    await openAddForm(s);
    await type(s, QUESTION_FIELD, "Who audits the sessions?");
    d3.ok({ ok: true, value: { revision: 9, questionId: "q11", visibilityChanged: [] } });
    await flush();
    t = s.render();
    expect(lateLines(t), "one line per question").toEqual([expect.stringContaining(`“${FIRST}”`), expect.stringContaining("“Which sessions expire first?”")]);
    await press(one(controls(t, /^Dismiss$/), "Dismiss"));
    t = s.render();
    expect(lateLines(t)).toEqual([]);
    expect(draftValue(t), "Dismiss leaves the open draft").toEqual(["Who audits the sessions?"]);
    expect(calls("question.create").length, "three drafts, three sends").toBe(3);
  });

  it("the late notice stays with its session: Session T opened meanwhile shows none", async () => {
    const { s, d } = await sendWithAnswerCancelRetype();
    d.ok({ ok: true, value: { revision: 8, questionId: "q9", visibilityChanged: [] } });
    await flush();
    expect(lateLines(s.render()).length, "shown in Session S").toBe(1);
    await press(one(controls(cardOf(s.render(), `Q4 ${Q4}`), /^Superseded by\b/), "Superseded by"));
    const t = s.render();
    expect(all(t, (el) => /^Q\d+ T1 replacement$/.test(textOf(el))).length, "Session T is shown").toBeGreaterThan(0);
    expect(lateLines(t), "none in Session T").toEqual([]);
  });

  it("control: Cancel with no new draft, then a success without its answer recorded: the row names that question", async () => {
    const { s, d } = await sendWithAnswerCancelRetype();
    d.ok({ ok: true, value: { revision: 8, questionId: "q9", visibilityChanged: [] } });
    await flush();
    const t = s.render();
    expect(draftValue(t)).toEqual([]);
    expect(namesFirst(t), "the notice names the question that was added").toBe(true);
    expect(visibleText(t)).not.toContain(SECOND);
    expect(calls("question.create").length).toBe(1);
  });

  it("control: the same draft's success without its answer recorded closes the form with the notice", async () => {
    const d = deferredCreate();
    const s = await openScreen();
    await openAddForm(s);
    await type(s, QUESTION_FIELD, FIRST);
    await type(s, ANSWER_FIELD, "At least twelve characters.");
    one(enabledControls(s.render(), SUBMIT), "Add").props.onPress();
    await flush();
    d.ok({ ok: true, value: { revision: 8, questionId: "q9", visibilityChanged: [] } });
    await flush();
    const t = s.render();
    expect(draftValue(t), "the form closed").toEqual([]);
    expect(visibleText(t)).toMatch(NOT_RECORDED);
  });

  it("control: Map and back while the earlier request is in flight keeps it the same draft: its refusal still marks it", async () => {
    const d = deferredCreate();
    const s = await openScreen();
    await openAddForm(s);
    await type(s, QUESTION_FIELD, FIRST);
    one(enabledControls(s.render(), SUBMIT), "Add").props.onPress();
    await flush();
    await press(one(controls(await openMenu(s), /^(✓ )?Map$/), "Map"));
    await press(one(controls(await openMenu(s), /^(✓ )?Grilling$/), "Grilling"));
    d.ok({ ok: false, error: { code: "revision_conflict", message: "store revision changed" } });
    await flush();
    const t = s.render();
    expect(draftValue(t)).toEqual([FIRST]);
    expect(visibleText(t)).toMatch(/The roadmap changed meanwhile/);
    expect(calls("question.create").length).toBe(1);
  });

  // Controls (they pass at 79642eb): one request at a time, nothing resent, and the screen's session.
  it("control: while the first request is in flight the new draft's Add is disabled, so nothing more is sent", async () => {
    const { s } = await cancelAndRetype();
    const t = s.render();
    expect(controls(t, SUBMIT).filter((el) => !isDisabled(el)), "Add disabled while one create is pending").toEqual([]);
    for (const el of controls(t, SUBMIT)) if (!isDisabled(el)) await press(el);
    expect(calls("question.create").length).toBe(1);
  });

  it("control: after Cancel with no new draft, the late success lands and nothing is resent or reopened", async () => {
    const d = deferredCreate();
    const s = await openScreen();
    await openAddForm(s);
    await type(s, QUESTION_FIELD, FIRST);
    one(enabledControls(s.render(), SUBMIT), "Add").props.onPress();
    await flush();
    await press(one(controls(s.render(), /^Cancel$/), "Cancel"));
    d.ok({ ok: true, value: { revision: 8, questionId: "q9", visibilityChanged: [] } });
    await flush();
    const t = s.render();
    expect(draftValue(t), "the form stays closed").toEqual([]);
    expect(controls(t, /^Add question to Block 2$/).length).toBe(1);
    expect(calls("question.create").length).toBe(1);
  });

  it("control: a late reply after leaving for another session neither opens nor annotates that session's form", async () => {
    const d = deferredCreate();
    const s = await openScreen();
    await openAddForm(s);
    await type(s, QUESTION_FIELD, FIRST);
    one(enabledControls(s.render(), SUBMIT), "Add").props.onPress();
    await flush();
    await press(one(controls(cardOf(s.render(), `Q4 ${Q4}`), /^Superseded by\b/), "Superseded by"));
    d.ok({ ok: false, error: { code: "revision_conflict", message: "store revision changed" } });
    await flush();
    const t = s.render();
    expect(all(t, (el) => /^Q\d+ T1 replacement$/.test(textOf(el))).length, "Session T is shown").toBeGreaterThan(0);
    expect(draftValue(t), "no form in Session T").toEqual([]);
    expect(visibleText(t)).not.toMatch(/The roadmap changed meanwhile/);
    expect(calls("question.create").length).toBe(1);
  });
});

describe("the desktop Chat menu closes on Escape and on an outside press", () => {
  it("Escape closes the open menu and leaves the trigger", async () => {
    const s = await openScreen();
    const t = await openMenu(s);
    expect(controls(t, /^Change chat…$/).length, "the menu is open").toBe(1);
    const handlers = all(t, (el) => typeof el.props.onKeyDown === "function" || typeof el.props.onKeyPress === "function");
    expect(handlers.length, "some element of the open menu handles keys").toBeGreaterThan(0);
    for (const el of handlers) {
      const event = { key: "Escape", nativeEvent: { key: "Escape" }, preventDefault: () => undefined, stopPropagation: () => undefined };
      el.props.onKeyDown?.(event);
      el.props.onKeyPress?.(event);
    }
    await flush();
    const after = s.render();
    expect(controls(after, /^Change chat…$/), "Escape closed the menu").toEqual([]);
    trigger(after);
    expect(writes()).toEqual([]);
  });

  it("a press outside the open menu closes it without acting", async () => {
    const s = await openScreen();
    const t = await openMenu(s);
    const menuItems = new Set(controls(t, /^((✓ )?Grilling|(✓ )?Map|Finish discussion…|Change chat…|Bind chat…|Retry\b|Reopen)/));
    const dismiss = all(t, (el) => typeof el.props.onPress === "function" && !menuItems.has(el) && el !== trigger(t) && /close|dismiss/i.test(String(el.props.accessibilityLabel ?? "")));
    expect(dismiss.length, "an outside-press layer labelled to close the menu").toBeGreaterThan(0);
    await press(dismiss[0]);
    expect(controls(s.render(), /^Change chat…$/)).toEqual([]);
    expect(writes()).toEqual([]);
  });
});

describe("an empty open block says what the session state is, never a promise", () => {
  const emptyOpen = (grilling: Record<string, unknown>, session: Record<string, unknown> = {}) =>
    sessionView({ questions: sessionView().questions.filter((x: any) => x.question.blockId === "b1"), grilling, session });
  const guidance = async () => visibleText((await openScreen()).render());
  const MANUAL = "Continue the conversation in the chat, or bind another chat.";

  it("no planner: no chat is bound", async () => {
    current = { view: emptyOpen({ status: "no_planner", manualRecovery: true, plannerAgentId: undefined, epoch: undefined }, { planner: undefined }) };
    expect(await guidance()).toMatch(/No chat is bound/);
  });

  it("an open proposal: the chat proposes to finish", async () => {
    current = { view: emptyOpen({ finishProposal: { at: PROPOSED_AT, summary: "Done.", skipped: [], outOfScope: [] } }, { finishProposal: { at: PROPOSED_AT, agentId: PLANNER, summary: "Done.", skipped: [], outOfScope: [] } }) };
    expect(await guidance()).toMatch(/proposes to finish/i);
  });

  it("an automatic continuation that is waiting: nothing was sent yet, and no manual recovery wording", async () => {
    current = { view: emptyOpen({ automatic: "waiting" }) };
    const text = await guidance();
    expect(text).toMatch(/Nothing was sent yet/);
    expect(text).not.toContain(MANUAL);
  });

  it("a summary being sent is not confirmed yet and is never worded as given or sent", async () => {
    current = { view: emptyOpen({ status: "needs_manual", manualRecovery: true, retryCount: 1, lastRetry: { id: "r1", at: PROPOSED_AT, state: "sending" } }) };
    const text = await guidance();
    expect(text).toMatch(/not confirmed yet/);
    expect(text).not.toMatch(/was given|Nothing has been added here since/);
  });

  it("an automatic continuation that was sent: the chat was given the summary; no manual recovery wording", async () => {
    current = { view: emptyOpen({ status: "continued", retryCount: 1, lastRetry: { id: "r1", at: PROPOSED_AT, state: "sent", origin: "automatic" } }) };
    const text = await guidance();
    expect(text).toMatch(/was given Block 1's summary/);
    expect(text).not.toContain(MANUAL);
  });

  it("manual recovery names the recovery; any other state says nothing has been added yet", async () => {
    current = { view: emptyOpen({ status: "needs_manual", manualRecovery: true }) };
    expect(await guidance()).toMatch(/The chat did not continue/);
    current = { view: emptyOpen({ status: "waiting_for_answers" }) };
    expect(await guidance()).toMatch(/Nothing has been added here yet/);
  });

  // DeepSeek Flash review 01a1c6c1 c0099: the remaining branches of the empty open block's line.
  it("a closed session: nothing more is added; never a promise of more questions", async () => {
    current = { view: emptyOpen({}, { status: "closed" }) };
    const text = await guidance();
    expect(text).toMatch(/The session is closed; nothing more is added here/);
    expect(text).not.toMatch(/Nothing has been added here yet/);
  });

  it("grilling complete: the chat asks nothing more", async () => {
    current = { view: emptyOpen({ status: "complete" }) };
    expect(await guidance()).toMatch(/Grilling is complete; the chat asks nothing more in this session/);
  });

  it("a manual retry that was sent: when it was sent, and that nothing has been added since; not the automatic wording", async () => {
    current = { view: emptyOpen({ status: "continued", retryCount: 1, lastRetry: { id: "r1", at: PROPOSED_AT, state: "sent", origin: "manual" } }) };
    const text = await guidance();
    expect(text).toMatch(new RegExp(`Retry sent at ${PROPOSED_AT.replace("T", " ").slice(0, 16)}\\. Nothing has been added here since`));
    expect(text).not.toMatch(/The chat was given Block/);
  });

  it("a delivery that is unknown: says so and asks to check the chat, without claiming it was sent", async () => {
    current = { view: emptyOpen({ status: "needs_manual", manualRecovery: true, retryCount: 1, lastRetry: { id: "r1", at: PROPOSED_AT, state: "unknown" } }) };
    const text = await guidance();
    expect(text).toMatch(/Delivery of the summary is unknown since .*: check the chat and mark the outcome/);
    expect(text).not.toMatch(/Retry sent at|was given Block/);
  });

  it("a delivery that failed: not delivered, and Retry is in the Chat menu", async () => {
    current = { view: emptyOpen({ status: "needs_manual", manualRecovery: true, retryCount: 1, lastRetry: { id: "r1", at: PROPOSED_AT, state: "failed" } }) };
    const text = await guidance();
    expect(text).toMatch(/The summary was not delivered: .*\. Retry is in the Chat menu/);
    expect(text).not.toMatch(/Retry sent at|was given Block/);
  });
});

// ---- W6c: the Map from stored relations, with zoom, a detail panel and an accessible list ----
describe("the Map", () => {
  async function openMap(opts: { compact?: boolean } = {}) {
    const s = await openScreen(opts);
    await press(one(controls(await openMenu(s), /^(✓ )?Map$/), "Map item"));
    return s;
  }
  /** Node controls: one per question, labelled "Q<n> <title>, <status>, Block <k>, <in> incoming, <out> outgoing". */
  const nodes = (tree: unknown) => controls(tree, /^Q\d+ .*, Block \d+, \d+ incoming, \d+ outgoing$/);
  const node = (tree: unknown, n: number) => one(nodes(tree).filter((el) => labelOf(el).startsWith(`Q${n} `)), `node Q${n}`);
  const zoomText = (tree: unknown) => visibleText(tree).match(/\b(\d+)\s?%/)?.[1];

  it("draws one node per active question with its number, title, status, block and edge counts, in reading order", async () => {
    const t = (await openMap()).render();
    expect(labelOf(node(t, 3))).toMatch(new RegExp(`^Q3 ${Q3.replace(/[?]/g, "\\?")}, [Oo]pen, Block 2, 1 incoming, 1 outgoing$`));
    expect(nodes(t).map((el) => labelOf(el).split(" ")[0]), "lane, then column: Q4 has no local parent, Q3 depends on Q1").toEqual(["Q1", "Q2", "Q4", "Q3"]);
    expect(controls(t, /^Accept block and continue$/), "the Map replaces the canvas").toEqual([]);
    expect(writes()).toEqual([]);
  });

  // DeepSeek Flash review 01a1c737 c0048, audit of 57c036e: Zoom out / Zoom in are icon buttons like
  // the screen's others: the Lucide Minus / Plus icon alone, the label as accessibility label, a hint
  // as accessibility hint and tooltip (shown on focus and hover, hidden on blur and hover out), a 44 px
  // target, and disabled at the ends of the steps.
  it("Zoom out and Zoom in are 44 px icon buttons with a hint and a tooltip, disabled at the ends", async () => {
    const s = await openMap();
    const zoomButton = (label: string) => one(controls(s.render(), new RegExp(`^${label}$`)), label);
    const style = (el: El) => Object.assign({}, ...[el.props.style].flat(Infinity).filter(Boolean)) as Record<string, unknown>;
    for (const [label, icon] of [
      ["Zoom out", "Minus"],
      ["Zoom in", "Plus"],
    ] as const) {
      const b = zoomButton(label);
      expect(all(b, (el) => nameOf(el) === "Icon").map((el) => el.props.name), `${label}: its icon`).toEqual([icon]);
      expect(textLines(b).join(" ").trim(), `${label}: no text glyph or label drawn`).toBe("");
      expect(String(b.props.accessibilityHint), `${label}: hint`).toMatch(new RegExp(`^${label} one step`));
      expect(Number(style(b).minHeight), `${label}: 44 px high`).toBeGreaterThanOrEqual(44);
      expect(Number(style(b).minWidth), `${label}: 44 px wide`).toBeGreaterThanOrEqual(44);
      const hint = String(b.props.accessibilityHint);
      expect(visibleText(s.render()), "no tooltip before").not.toContain(hint);
      b.props.onFocus?.({});
      await flush();
      expect(visibleText(s.render()), `${label}: the tooltip shows on focus`).toContain(hint);
      zoomButton(label).props.onBlur?.({});
      await flush();
      expect(visibleText(s.render()), `${label}: hidden on blur`).not.toContain(hint);
      zoomButton(label).props.onHoverIn?.({});
      await flush();
      expect(visibleText(s.render()), `${label}: the tooltip shows on hover`).toContain(hint);
      zoomButton(label).props.onHoverOut?.({});
      await flush();
      expect(visibleText(s.render()), `${label}: hidden on hover out`).not.toContain(hint);
    }
    for (let i = 0; i < 6 && !isDisabled(zoomButton("Zoom out")); i++) await press(zoomButton("Zoom out"));
    expect(zoomText(s.render()), "at the lowest step").toBe("50");
    expect(isDisabled(zoomButton("Zoom out")), "Zoom out disabled at 50 %").toBe(true);
    for (let i = 0; i < 6 && !isDisabled(zoomButton("Zoom in")); i++) await press(zoomButton("Zoom in"));
    expect(zoomText(s.render()), "at the highest step").toBe("125");
    expect(isDisabled(zoomButton("Zoom in")), "Zoom in disabled at 125 %").toBe(true);
    expect(writes()).toEqual([]);
  });

  it("selecting a node opens its detail with Comes after and Leads to; a row moves the selection; Open in Grilling selects the block", async () => {
    const s = await openMap();
    await press(node(s.render(), 3));
    let t = s.render();
    expect(visibleText(t)).toMatch(/Comes after/);
    expect(visibleText(t)).toMatch(/Leads to/);
    const parent = one(controls(t, /^Q1 .*activat/i), "the activation parent row");
    await press(parent);
    t = s.render();
    expect(controls(t, /^Q2 .*/).length + controls(t, /^Q3 .*/).length, "Q1's dependents are listed").toBeGreaterThan(0);
    await press(one(enabledControls(t, /^Open (Q1 )?in Grilling$/), "Open in Grilling"));
    t = s.render();
    expect(selected(navItem(t, /^Block 1\b/))).toBe(true);
    expect(writes()).toEqual([]);
  });

  it("an external row opens the other session; a missing target is plain text", async () => {
    const s = await openMap();
    await press(node(s.render(), 4));
    let t = s.render();
    expect(controls(t, /no longer exists/)).toEqual([]);
    expect(visibleText(t)).toMatch(/a question that no longer exists/);
    const asked = () => h.state.queryOptions.filter((o) => Array.isArray(o.queryKey) && o.queryKey[4] === "T").length;
    const before = asked();
    await press(one(controls(t, /Session T \/ T1 replacement/), "the external row"));
    t = s.render();
    // DeepSeek Flash review 01a1c67a c0029: the open detail already writes "Session T / T1
    // replacement", so the press must open Session T: its view is read, its question has a card, and
    // the Map with Q4's detail is gone.
    expect(asked(), "Session T's view is read").toBeGreaterThan(before);
    expect(all(t, (el) => /^Q\d+ T1 replacement$/.test(textOf(el))).length, "Session T's question has a card").toBeGreaterThan(0);
    expect(controls(t, /^Q4 .*, Block \d+, \d+ incoming, \d+ outgoing$/), "the Map's Q4 node is gone").toEqual([]);
  });

  it("zoom steps by Zoom out and Zoom in; at 75 % and above nodes are pressable; at 50 % the graph is an overview with List and Find question", async () => {
    const s = await openMap();
    let t = s.render();
    expect(zoomText(t)).toBe("100");
    await press(one(controls(t, /^Zoom out$/), "Zoom out"));
    t = s.render();
    expect(zoomText(t)).toBe("75");
    expect(enabledControls(t, /^Q3 /).length, "pressable at 75 %").toBe(1);
    const scaled = all(t, (el) => {
      const st = Object.assign({}, ...[el.props.style].flat(Infinity).filter(Boolean));
      return Array.isArray(st.transform) && st.transform.some((x: Record<string, unknown>) => x.scale === 0.75);
    });
    expect(scaled.length, "the world is scaled by transform").toBeGreaterThan(0);
    expect(Object.assign({}, ...[scaled[0].props.style].flat(Infinity).filter(Boolean)).transformOrigin).toMatch(/top left|left top|0 0/);
    await press(one(controls(t, /^Zoom out$/), "Zoom out"));
    t = s.render();
    expect(zoomText(t)).toBe("50");
    expect(enabledControls(t, /^Q\d+ .*incoming/), "no node is pressable in the overview").toEqual([]);
    expect(visibleText(t)).toMatch(/Overview/);
    expect(controls(t, /^List$/).length).toBe(1);
    expect(controls(t, /Find question/).length).toBe(1);
    await press(one(controls(t, /^Zoom in$/), "Zoom in"));
    expect(zoomText(s.render())).toBe("75");
    expect(controls(s.render(), /^Fit$/).length).toBe(1);
  });

  it("the List view writes every relation of a question with its kind and direction, and a Show inactive toggle exists", async () => {
    const s = await openMap();
    await press(one(controls(s.render(), /^List$/), "List"));
    const text = visibleText(s.render());
    for (const line of [/Needed by Q3/, /Depends on Q1/, /Informed by Q2/, /Informs Q4/, /Superseded by .*Session T/, /Informs session Session U/]) expect(text).toMatch(line);
    expect(controls(s.render(), /Show inactive/).length).toBe(1);
  });

  // KensAI 01a1c5cb c0110: a stored self-link (the store and link.create accept identical ends) must
  // not vanish from the question's relations: the List and the question card write them from the
  // same helper. The case is the open Block 6's Q37 informing itself.
  function selfLinked() {
    const data = mapRoadmap();
    const end = { sessionId: MAP_SESSION, questionId: "m37" };
    data.meta.links = [...data.meta.links, { id: "lk-self-37", kind: "informs", from: end, to: end }];
    return buildSessionView(data, 1, MAP_SESSION);
  }

  it("a stored self-link is written in the List row of its question, with its kind", async () => {
    current = { view: selfLinked() };
    const s = await openMap();
    await press(one(controls(s.render(), /^List$/), "List"));
    const text = visibleText(s.render());
    expect(text, "the List row of Q37").toMatch(/Show Q37 Map question 37 on the map/);
    expect(text).toMatch(/Informs Q37 Map question 37 \(itself\)/);
    expect(text, "the stored direction only").not.toMatch(/Informed by Q37 Map question 37/);
  });

  it("a stored self-link is shown on its question's card, with its kind", async () => {
    current = { view: selfLinked() };
    const s = await openScreen();
    const text = visibleText(s.render());
    expect(text, "the open block's card for Q37 is shown").toMatch(/Map question 37/);
    expect(text).toMatch(/Informs Q37 \(itself\)/);
    expect(text, "the stored direction only").not.toMatch(/Informed by Q37\b/);
  });

  it("a stored self-link: the node counts it once, as outgoing; the detail lists it once, under Leads to; the List says (itself)", async () => {
    current = { view: buildSessionView(mapRoadmap(), 1, MAP_SESSION) };
    const plain = labelOf(node((await openMap()).render(), 37));
    current = { view: selfLinked() };
    const s = await openMap();
    const label = labelOf(node(s.render(), 37));
    const counts = (l: string) => /, (\d+) incoming, (\d+) outgoing$/.exec(l)!.slice(1).map(Number);
    const [inBefore, outBefore] = counts(plain);
    expect(counts(label), `${plain} → ${label}`).toEqual([inBefore, outBefore + 1]);
    await press(node(s.render(), 37));
    const text = visibleText(s.render());
    const after = text.slice(text.indexOf("Leads to"));
    const before = text.slice(text.indexOf("Comes after"), text.indexOf("Leads to"));
    expect(text.indexOf("Leads to"), "the detail is open").toBeGreaterThan(-1);
    expect(after, "listed under Leads to").toMatch(/Q37 Map question 37 · informs itself/);
    expect(all(s.render(), (el) => typeof el.props.accessibilityLabel === "string" && /^Q37 Map question 37 · informs itself$/.test(el.props.accessibilityLabel)).length, "one detail row").toBe(1);
    expect(before, "not under Comes after").not.toMatch(/Q37 Map question 37/);
    await press(one(controls(s.render(), /^Clear$/), "Clear"));
    await press(one(controls(s.render(), /^List$/), "List"));
    const list = visibleText(s.render());
    expect((list.match(/Informs Q37 Map question 37 \(itself\)/g) ?? []).length, "one List entry").toBe(1);
    expect(list).not.toMatch(/Informed by Q37 Map question 37/);
  });

  // KensAI 01a1c636 c0123: Show inactive hides and shows the questions that are not active, and says so.
  it("Show inactive: pressing it hides the inactive questions and turns its pressed state off; pressing again shows them", async () => {
    current = { view: buildSessionView(mapRoadmap(), 1, MAP_SESSION) };
    const s = await openMap();
    const toggle = () => one(controls(s.render(), /Show inactive$/), "Show inactive");
    const inactiveShown = () => nodes(s.render()).filter((el) => /^Q(33|34|38|39) /.test(labelOf(el))).length;
    expect(toggle().props["aria-pressed"], "on at first").toBe(true);
    expect(inactiveShown(), "Q33, Q34, Q38 and Q39 are drawn").toBe(4);
    const total = nodes(s.render()).length;
    await press(toggle());
    expect(toggle().props["aria-pressed"], "off after a press").toBe(false);
    expect(inactiveShown(), "the inactive questions are hidden").toBe(0);
    expect(nodes(s.render()).length, "only they are hidden").toBe(total - 4);
    await press(toggle());
    expect(toggle().props["aria-pressed"], "on again").toBe(true);
    expect(inactiveShown(), "shown again").toBe(4);
  });

  // DeepSeek Flash review 01a1c67a c0020: the case accepted the Find question picker as "the detail"
  // (compact opens at Fit, where nodes are not pressable). It now zooms to 100 %, presses Q3 and
  // requires the Question detail in an open host Modal.
  // DeepSeek Flash review 01a1c6c1 c0101: React Native Web 0.21 keeps aria-* and the flat
  // accessibility* props but not `accessibilityState` or `accessibilityHint` (modules/createDOMProps);
  // the project's SPEC says the host drops them. A lane header must carry its expanded state, and a
  // collapsed lane's port its purpose (expanding the lane), through what the web keeps.
  it("above 120 nodes: a lane header's expanded state and a port's purpose reach the web", async () => {
    current = { view: buildSessionView(largeMapRoadmap(130), 1, MAP_SESSION) };
    const s = await openMap();
    const header = (n: number) => one(controls(s.render(), new RegExp(`^Block ${n} · `)).filter((el) => !/incoming/.test(labelOf(el))), `Block ${n} header`);
    const webExpanded = (el: El) => el.props["aria-expanded"] ?? el.props.accessibilityExpanded;
    expect(webExpanded(header(2)), "a collapsed header: aria-expanded false").toBe(false);
    expect(webExpanded(header(6)), "the open block's header: aria-expanded true").toBe(true);
    const port = one(controls(s.render(), /^→ Block \d+ \(\d+ edges?\)/), "a port");
    // DeepSeek Flash review 01a1c737 c0053: a description counts only when its id names an element
    // drawn on the screen (nativeID becomes the DOM id on the web), and that element says it.
    const describedBy = port.props["aria-describedby"] as string | undefined;
    const t = s.render();
    const notes = describedBy === undefined ? [] : all(t, (el) => el.props.nativeID === describedBy || el.props.id === describedBy);
    if (describedBy !== undefined) {
      expect(typeof describedBy === "string" && describedBy.length > 0, "aria-describedby is an id").toBe(true);
      expect(notes.length, `exactly one drawn element has the id ${describedBy}`).toBe(1);
      expect(visibleText(t), "the note is on the screen, not in a closed layer").toContain(textOf(notes[0]));
    }
    const webText = [port.props.accessibilityLabel, port.props["aria-label"], ...notes.map((el) => textOf(el))].join(" ");
    expect(webText, "the port says it expands its lane in its label or its description").toMatch(/expand/i);
  });

  // DeepSeek Flash review 01a1c6c1 c0114: a first block may be stored with the id "all" (the server
  // takes the caller's blockId for a session's first block). Above 120 nodes every lane but the open
  // block's starts collapsed, with a header to expand or collapse it; the legacy session's single lane
  // ("lane:all") is the one exception. A block whose id is "all" is a block like any other.
  it("above 120 nodes a first block stored as \"all\" starts collapsed and keeps its collapse control, like any other accepted block", async () => {
    const data = largeMapRoadmap(130);
    const session = data.sessions.find((x) => x.id === MAP_SESSION)!;
    const first = session.blocks![0].id;
    session.blocks![0] = { ...session.blocks![0], id: "all" };
    session.questions = session.questions.map((qq) => (qq.blockId === first ? { ...qq, blockId: "all" } : qq));
    current = { view: buildSessionView(data, 1, MAP_SESSION) };
    const s = await openMap();
    const header = (n: number) => controls(s.render(), new RegExp(`^Block ${n} · `)).filter((el) => !/incoming/.test(labelOf(el)));
    for (const n of [2, 3, 4, 5]) expect(header(n).map(labelOf), `Block ${n}`).toEqual([expect.stringMatching(/, collapsed$/)]);
    expect(header(1).map(labelOf), "Block 1 (id \"all\") starts collapsed with its header, like Blocks 2–5").toEqual([expect.stringMatching(/^Block 1 · accepted · 25 questions, collapsed$/)]);
  });

  it("compact: the detail panel is a host Modal", async () => {
    const s = await openMap({ compact: true });
    // Fit is an overview even when it lands at 100 %: step out of it to the 100 % level.
    await press(one(controls(s.render(), /^Zoom out$/), "Zoom out"));
    for (let i = 0; i < 6 && zoomText(s.render()) !== "100"; i++) await press(one(controls(s.render(), /^Zoom in$/), "Zoom in"));
    expect(zoomText(s.render()), "zoomed to 100 %").toBe("100");
    expect(visibleText(s.render()), "not an overview").not.toMatch(/Overview: zoom in/);
    await press(node(s.render(), 3));
    const open = all(s.render(), (el) => nameOf(el) === "Modal" && el.props.open !== false);
    const detail = open.filter((m) => /Comes after/.test(textOf(m)) && /Leads to/.test(textOf(m)));
    expect(detail.length, "the Question detail is an open host Modal").toBe(1);
    expect(textOf(detail[0]), "it describes Q3").toMatch(/Q3 /);
    expect(open.some((m) => m.props.title === "Find question"), "not the Find question picker").toBe(false);
  });
});

// ---- W6c: activation conditions, lane collapse above 120 nodes, list first above 400 ----
describe("the Map at scale", () => {
  async function openMap() {
    const s = await openScreen();
    await press(one(controls(await openMenu(s), /^(✓ )?Map$/), "Map item"));
    return s;
  }
  const nodeControls = (tree: unknown) => controls(tree, /^Q\d+ .*, Block \d+, \d+ incoming, \d+ outgoing$/);
  const nodeNumbers = (tree: unknown) => nodeControls(tree).map((el) => Number(/^Q(\d+) /.exec(labelOf(el))![1]));

  it("the detail keeps every activation condition: two activations of Q5 by Q2 with different options are two rows", async () => {
    current = { view: buildSessionView(mapRoadmap(), 1, MAP_SESSION) };
    const s = await openMap();
    await press(one(nodeControls(s.render()).filter((el) => labelOf(el).startsWith("Q5 ")), "node Q5"));
    const rows = controls(s.render(), /^Q2 Map question 2\b/).map((el) => labelOf(el) + textOf(el.props.children));
    expect(rows.some((r) => /when Option A(?! or)/.test(r)), rows.join(" | ")).toBe(true);
    expect(rows.some((r) => /when Option A or Option B/.test(r)), rows.join(" | ")).toBe(true);
  });

  /** The scaled world: the element whose style scales it. */
  const worldOf = (tree: unknown) =>
    one(
      all(tree, (el) => {
        const st = Object.assign({}, ...[el.props.style].flat(Infinity).filter(Boolean));
        return Array.isArray(st.transform) && st.transform.some((x: Record<string, unknown>) => typeof x.scale === "number");
      }),
      "the scaled world",
    );

  it("the graph draws activation conditions only on the selected node's edges", async () => {
    current = { view: buildSessionView(mapRoadmap(), 1, MAP_SESSION) };
    const s = await openMap();
    expect(textOf(worldOf(s.render())), "no condition labels without a selection").not.toMatch(/Option A/);
    await press(one(nodeControls(s.render()).filter((el) => labelOf(el).startsWith("Q5 ")), "node Q5"));
    const world = textOf(worldOf(s.render()));
    expect(world).toMatch(/Option A or Option B/);
    // DeepSeek Flash review 01a1c6c1 c0098: exactly the conditions of Q5's own activation edges
    // (Q2 activates Q5 on A, and on A or B; Q5 activates Q10 and Q11), none of another edge.
    const v = current.view as ReturnType<typeof buildSessionView>;
    const labelOfOpt = (parentId: string, ids: string[]) => {
      const parent = v.questions.find((x) => x.question.id === parentId)!.question;
      return `when ${ids.map((id) => parent.options.find((o) => o.id === id)!.label).join(" or ")}`;
    };
    const wanted = v.questions
      .flatMap((x) => x.question.activatedBy.filter((a) => a.parent.sessionId === MAP_SESSION).map((a) => ({ from: a.parent.questionId, to: x.question.id, ids: [...a.optionIds].sort() })))
      .filter((e) => e.from === "m5" || e.to === "m5")
      .map((e) => labelOfOpt(e.from, e.ids))
      .sort();
    const drawn = all(worldOf(s.render()), (el) => nameOf(el) === "Text" && /^when /.test(textOf(el.props.children))).map((el) => textOf(el.props.children)).sort();
    expect(wanted.length, "Q5 has four activation edges").toBe(4);
    expect(drawn).toEqual(wanted);
  });

  it("cross-lane edges carry a kind glyph, so the kind is not told by line style alone", async () => {
    current = { view: buildSessionView(mapRoadmap(), 1, MAP_SESSION) };
    const world = textOf(worldOf((await openMap()).render()));
    for (const glyph of ["▸", "⊘", "ⓘ", "⇢"]) expect(world, glyph).toContain(glyph);
  });

  describe("above 120 nodes", () => {
    // 130 questions in blocks of 25: Blocks 1–5 accepted, Block 6 (Q126–Q130) open; Q126–Q130 are
    // activated by Q63–Q65 in Block 3.
    beforeEach(() => {
      current = { view: buildSessionView(largeMapRoadmap(130), 1, MAP_SESSION) };
    });

    it("lanes are collapsed to headers with their counts, except the open block's lane", async () => {
      const t = (await openMap()).render();
      expect(nodeNumbers(t).sort((a, b) => a - b)).toEqual([126, 127, 128, 129, 130]);
      for (const n of [1, 2, 3, 4, 5]) expect(controls(t, new RegExp(`^Block ${n}\\b.*25 questions`)).length, `Block ${n} header`).toBe(1);
    });

    it("an edge into a collapsed lane ends at a labelled port with its edge count; pressing it expands that lane only", async () => {
      const s = await openMap();
      const port = one(controls(s.render(), /→ Block 3 \(\d+ edges?\)/), "the Block 3 port");
      expect(labelOf(port) + textOf(port.props.children)).toMatch(/\(5 edges\)/);
      await press(port);
      const shown = nodeNumbers(s.render());
      for (const n of [51, 63, 75]) expect(shown, `Q${n}`).toContain(n);
      expect(shown.some((n) => n <= 50 || (n > 75 && n < 126)), "other lanes stay collapsed").toBe(false);
    });

    it("pressing a collapsed header expands that lane only; pressing it again collapses it", async () => {
      const s = await openMap();
      await press(one(controls(s.render(), /^Block 1\b.*25 questions/), "Block 1 header"));
      let shown = nodeNumbers(s.render());
      expect(shown.filter((n) => n <= 25).length).toBe(25);
      expect(shown.some((n) => n > 25 && n < 126)).toBe(false);
      await press(one(controls(s.render(), /^Block 1\b/).filter((el) => !/incoming/.test(labelOf(el))), "Block 1 header"));
      shown = nodeNumbers(s.render());
      expect(shown.some((n) => n <= 25)).toBe(false);
    });

    it("Find question lists every node and selecting one in a collapsed lane expands its lane and selects it", async () => {
      const s = await openMap();
      await press(one(controls(s.render(), /Find question/), "Find question"));
      const t = s.render();
      expect(controls(t, /^Q\d+ Large question \d+$/).length, "every question is offered").toBe(130);
      await press(one(controls(t, /^Q10 Large question 10$/), "Q10 in the picker"));
      const after = s.render();
      expect(nodeNumbers(after)).toContain(10);
      expect(visibleText(after)).toMatch(/Comes after/);
      // DeepSeek Flash review 01a1c8d3 c0153: the detail is Q10's own, not another question of its lane.
      expect(visibleText(after), "the picked question is the one shown").toMatch(/Showing Q10 Large question 10 and its neighbours/);
    });

    it("the List shows every node whatever the collapse", async () => {
      const s = await openMap();
      await press(one(controls(s.render(), /^List$/), "List"));
      const text = visibleText(s.render());
      for (const n of [1, 10, 63, 100, 130]) expect(text, `Q${n}`).toContain(`Q${n} Large question ${n}`);
    });
  });

  it("above 400 nodes the Map opens on the List with a notice; Graph stays one press away", async () => {
    current = { view: buildSessionView(largeMapRoadmap(410), 1, MAP_SESSION) };
    const s = await openMap();
    let t = s.render();
    expect(nodeControls(t), "no graph nodes on open").toEqual([]);
    expect(visibleText(t)).toMatch(/410/);
    expect(visibleText(t)).toContain("Q410 Large question 410");
    await press(one(controls(t, /^Graph$/), "Graph"));
    t = s.render();
    expect(nodeControls(t).length).toBeGreaterThan(0);
  });
});

// ---- Map: Fit and the first view, as a browser shows them ----
// The world's position as a browser keeps it: the vertical and horizontal scroll recorders clamp
// every scrollTo to the content and viewport laid out at the call, a new scroll element (a new key)
// starts at its origin, and `pan` moves the position the way a user's drag or wheel does (also told
// to an onScroll handler, if the view keeps one). What a user sees is the world rectangle
// [x / scale, (x + width) / scale] × [y / scale, (y + height) / scale].
describe("Map host check: Fit and the first view", () => {
  type Pos = { x: number; y: number };
  function world(s: Screen) {
    const pos: Pos = { x: 0, y: 0 };
    let viewport = { width: 0, height: 0 };
    let keys = { v: null as unknown, h: null as unknown };
    const parts = () => {
      const tree = s.render();
      const vertical = one(all(tree, isGraphScroll), "the world's vertical scroll");
      const horizontal = one(all(vertical, (el) => nameOf(el) === "RNScrollView" && el.props.horizontal === true), "the world's horizontal scroll");
      const content = [horizontal.props.children].flat().find((c: any) => c && c.props) as El;
      const st = Object.assign({}, ...[content.props.style].flat(Infinity).filter(Boolean));
      const scaled = all(content, (el) => Array.isArray(Object.assign({}, ...[el.props.style].flat(Infinity).filter(Boolean)).transform))[0];
      const tr = scaled ? Object.assign({}, ...[scaled.props.style].flat(Infinity).filter(Boolean)).transform : [];
      const scale = Number((tr.find((t: Record<string, number>) => "scale" in t) ?? { scale: 1 }).scale);
      return { tree, vertical, horizontal, extent: { width: Number(st.width ?? 0), height: Number(st.height ?? 0) }, scale };
    };
    const attach = () => {
      const p = parts();
      // A new scroll element starts at its origin.
      if (keys.v !== null && (p.vertical as unknown as { key: unknown }).key !== keys.v) pos.y = 0;
      if (keys.h !== null && (p.horizontal as unknown as { key: unknown }).key !== keys.h) pos.x = 0;
      keys = { v: (p.vertical as unknown as { key: unknown }).key, h: (p.horizontal as unknown as { key: unknown }).key };
      // A browser keeps a scroll position inside the content: shrunk content pulls it back.
      if (viewport.width > 0) pos.x = Math.max(0, Math.min(pos.x, Math.max(0, p.extent.width - viewport.width)));
      if (viewport.height > 0) pos.y = Math.max(0, Math.min(pos.y, Math.max(0, p.extent.height - viewport.height)));
      const clampX = (x: number) => Math.max(0, Math.min(x || 0, Math.max(0, p.extent.width - viewport.width)));
      const clampY = (y: number) => Math.max(0, Math.min(y || 0, Math.max(0, p.extent.height - viewport.height)));
      p.vertical.props.ref.current = { scrollTo: (o: { y?: number }) => void (pos.y = clampY(o.y ?? pos.y)) };
      if (p.horizontal.props.ref != null && typeof p.horizontal.props.ref === "object") p.horizontal.props.ref.current = { scrollTo: (o: { x?: number }) => void (pos.x = clampX(o.x ?? pos.x)) };
      return p;
    };
    const layout = (next: { width: number; height: number }) => {
      viewport = next;
      attach().vertical.props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, ...next } } });
    };
    const pan = (to: Pos) => {
      const p = attach();
      pos.x = Math.max(0, Math.min(to.x, p.extent.width - viewport.width));
      pos.y = Math.max(0, Math.min(to.y, p.extent.height - viewport.height));
      p.vertical.props.onScroll?.({ nativeEvent: { contentOffset: { x: 0, y: pos.y }, layoutMeasurement: viewport, contentSize: p.extent } });
      p.horizontal.props.onScroll?.({ nativeEvent: { contentOffset: { x: pos.x, y: 0 }, layoutMeasurement: viewport, contentSize: p.extent } });
    };
    /** Settles renders and effects, re-attaching the recorders to the current scroll elements. */
    const settle = async () => {
      for (let i = 0; i < 3; i++) {
        attach();
        await flush();
      }
      return attach();
    };
    /** The world rectangle in view, in unscaled world coordinates. */
    const visible = () => {
      const p = attach();
      return { left: pos.x / p.scale, top: pos.y / p.scale, right: (pos.x + viewport.width) / p.scale, bottom: (pos.y + viewport.height) / p.scale, scale: p.scale, extent: p.extent };
    };
    return { pos, layout, pan, settle, visible, parts: attach };
  }
  const flat = (el: El): Record<string, any> => Object.assign({}, ...[el.props.style].flat(Infinity).filter(Boolean));
  /** Drawn nodes and ports with their world rectangles (overview nodes are labelled Views). */
  const drawn = (tree: unknown) =>
    all(tree, (el) => typeof el.props.accessibilityLabel === "string" && (/, Block \d+, \d+ incoming, \d+ outgoing$/.test(el.props.accessibilityLabel) || /^→ Block \d+ \(\d+ edges?\)$/.test(el.props.accessibilityLabel)) && flat(el).position === "absolute").map((el) => {
      const st = flat(el);
      return { label: String(el.props.accessibilityLabel), left: Number(st.left), top: Number(st.top), right: Number(st.left) + Number(st.width), bottom: Number(st.top) + Number(st.height) };
    });
  const intersects = (a: { left: number; top: number; right: number; bottom: number }, b: { left: number; top: number; right: number; bottom: number }) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

  // Plan r4 §12.7: Fit is "scale from the measured viewport; scroll to origin". RN Web host check at
  // 31a20ee: from 100 % scrolled down, Fit gave 30 % at scrollTop 1526 of 2136, not the origin; the
  // view only sets the zoom.
  it("wide: Fit after panning the world returns it to the origin", async () => {
    current = { view: buildSessionView(mapRoadmap(), 1, MAP_SESSION) };
    const s = await openScreen();
    await press(one(controls(await openMenu(s), /^(✓ )?Map$/), "Map item"));
    const w = world(s);
    w.layout({ width: 868, height: 559 });
    await w.settle();
    expect(/\b100\s?%/.test(visibleText(s.render())), "wide opens at 100 %").toBe(true);
    w.pan({ x: 400, y: 900 });
    expect(w.pos.y, "the world was panned").toBeGreaterThan(0);
    await press(one(controls(s.render(), /^(✓ )?Fit$/), "Fit"));
    await w.settle();
    expect(w.pos, "Fit scrolls to the origin").toEqual({ x: 0, y: 0 });
  });

  it("compact: Fit pressed again after zooming in and panning returns the world to the origin", async () => {
    current = { view: buildSessionView(largeMapRoadmap(130), 1, MAP_SESSION) };
    const s = await openScreen({ compact: true });
    await press(trigger(s.render()));
    const sheet = one(all(s.render(), (el) => nameOf(el) === "Modal" && el.props.open !== false && controls(el, /^(✓ )?Map$/).length > 0), "the Chat sheet");
    await press(one(controls(sheet, /^(✓ )?Map$/), "Map"));
    const w = world(s);
    w.layout({ width: 366, height: 320 });
    await w.settle();
    for (let i = 0; i < 6 && !/\b100\s?%/.test(visibleText(s.render())); i++) await press(one(controls(s.render(), /^Zoom in$/), "Zoom in"));
    await w.settle();
    w.pan({ x: 300, y: 500 });
    expect(w.pos.x + w.pos.y, "the world was panned").toBeGreaterThan(0);
    await press(one(controls(s.render(), /^(✓ )?Fit$/), "Fit"));
    await w.settle();
    expect(w.pos, "Fit scrolls to the origin").toEqual({ x: 0, y: 0 });
  });

  // RN Web host check at 31a20ee, 390 px, 130 questions: the Map opened at Fit (30 %, the plan's
  // floor) with Blocks 1–5 collapsed; the world was 700 px wide in a 366 px viewport, so the open
  // Block 6's five questions and the port "→ Block 3 (5 edges)" lay right of the view and the first
  // view showed only empty lane bands. The plan allows a world wider than the view at Fit; the first
  // view must still show something useful. Either the first view shows a question of the open block,
  // or the screen offers a labelled control that brings it into view. In both cases the open block's
  // questions and the port keep being drawn (nothing is hidden to make room).
  it("compact, 130 questions at Fit: the first view shows the open block's questions, or a control brings them into view", async () => {
    current = { view: buildSessionView(largeMapRoadmap(130), 1, MAP_SESSION) };
    const s = await openScreen({ compact: true });
    await press(trigger(s.render()));
    const sheet = one(all(s.render(), (el) => nameOf(el) === "Modal" && el.props.open !== false && controls(el, /^(✓ )?Map$/).length > 0), "the Chat sheet");
    await press(one(controls(sheet, /^(✓ )?Map$/), "Map"));
    const w = world(s);
    w.layout({ width: 366, height: 320 });
    await w.settle();
    const t = s.render();
    const items = drawn(t);
    const open = items.filter((n) => /, Block 6, /.test(n.label));
    // The situation: Fit at its floor, a world wider than the view, the open block's questions and the port drawn.
    const v = w.visible();
    expect(v.scale, "Fit").toBeLessThan(0.75);
    // DeepSeek Flash review 01a1c7df-fec1 c0092: at its floor, 30 % (SPEC; the fitted scale of this
    // world in a 366 × 320 view is below it), not lower.
    expect(v.scale, "Fit stops at the 30 % floor").toBeCloseTo(0.3, 5);
    expect(v.extent.width, "a world wider than the view").toBeGreaterThan(366);
    expect(open.map((n) => /^Q(\d+) /.exec(n.label)?.[1]).sort(), "the open block's questions are drawn").toEqual(["126", "127", "128", "129", "130"]);
    expect(items.some((n) => /^→ Block 3 \(5 edges\)$/.test(n.label)), "the port to Block 3 is drawn").toBe(true);
    if (open.some((n) => intersects(n, v))) return;
    // Otherwise: a labelled control (not a question, the toolbar, List or Find question) brings them into view.
    const toolbar = /^(✓ )?(Zoom in|Zoom out|Fit|Graph|List|Show inactive|Find question)$/;
    // Matched by the control's own accessible name, not by the text drawn inside it (the overview's
    // "Zoom in here" press holds the whole world, lane labels included).
    const offers = all(t, (el) => typeof handlerOf(el) === "function" && /Block 6|open block|questions? (are )?(off|out of)/i.test(String(el.props.accessibilityLabel ?? el.props.label ?? ""))).filter((el) => !/, Block \d+, \d+ incoming/.test(labelOf(el)) && !toolbar.test(labelOf(el)) && !isDisabled(el));
    expect(offers.map(labelOf), `none of Q126–Q130 is in the first view (world x ${Math.round(v.left)}–${Math.round(v.right)}, y ${Math.round(v.top)}–${Math.round(v.bottom)}; Block 6 at x ${Math.min(...open.map((n) => n.left))}–${Math.max(...open.map((n) => n.right))}) and no control offers to bring them into view`).not.toEqual([]);
    await press(offers[0]);
    await w.settle();
    const after = w.visible();
    expect(drawn(s.render()).filter((n) => /, Block 6, /.test(n.label)).some((n) => intersects(n, after)), `${labelOf(offers[0])} brings a question of Block 6 into view`).toBe(true);
  });
});

// ---- Map: a user's pan after Go to open Block survives a later lane expand ----
// RN Web host check at f9c9850 (docs/reviews/2026-11-10-r7-map-label-room-sandbox-0153.md), 130
// questions at 100 %: Go to open Block 6 scrolled to (1458, 244) with Q126 centred; the user scrolled
// back to the origin (by setting the scroll position, and again with the mouse wheel) and expanded
// Block 3 (then Block 2) by its header; the view jumped back to Q126, leaving the expanded lane off
// screen. Without a prior Go to the same expand kept (0, 0).
//
// The scroll model follows React Native Web 0.21 and Chrome, so that a view cannot pass by telling
// its own scrolls from the user's in a way a browser would not allow:
// - scrollTo({ animated: true }) is a smooth scroll: the position moves over several frames, each
//   move a DOM scroll event; a new scrollTo on the same element replaces the running one.
//   scrollTo({ animated: false }) moves at once, its scroll event follows in the next frame.
//   RN Web scrolls with node.scroll({ top: y || 0, left: x || 0 }).
// - RN Web's ScrollView (scrollEventThrottle 0) calls onScroll on the first scroll event of a run and
//   once more 100 ms after the run's last event, with the position as it is then. A programmatic
//   scroll and a user's scroll give the same onScroll calls.
// - A user's pan is one of: wheel (onWheel bubbles from the inner horizontal scroller to the vertical
//   one, then a smooth scroll of the axis's scroller), touch drag (onTouchStart / onTouchMove /
//   onTouchEnd bubble the same way, the position follows each move), or scroll bar / keyboard (scroll
//   events only).
// - Content that shrinks under the scroll position pulls it back, with a scroll event; a new scroll
//   element (a new key) starts at its origin; onLayout of the viewport arrives after the render that
//   changed it; onContentSizeChange, if the view sets one, follows each content size change.
describe("Map host check: Go to open Block, then the user's pan, then a lane expand", () => {
  // Effects and memos follow React's dependency rules here: with a scroll that takes frames, an
  // effect that ran after every render would restart it on every render.
  beforeEach(() => {
    h.state.reactDeps = true;
  });
  afterEach(() => {
    h.state.reactDeps = false;
  });
  type Pos = { x: number; y: number };
  const FRAME = 16;
  const SCROLL_END = 100;
  // A programmatic smooth scroll: on the host (RN Web, Chrome 157, a6b10d1) Go to's scroll moved from
  // about 200 ms to 800 ms after the press, so about 36 frames.
  const SMOOTH_FRAMES = 36;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  function browser(s: Screen) {
    const pos: Pos = { x: 0, y: 0 };
    let viewport = { width: 0, height: 0 };
    let keys = { v: null as unknown, h: null as unknown };
    let lastExtent = { width: -1, height: -1 };
    const pending = new Set<ReturnType<typeof setTimeout>>();
    const later = (ms: number, f: () => void) => {
      const t = setTimeout(() => {
        pending.delete(t);
        f();
      }, ms);
      pending.add(t);
      return t;
    };
    const cancel = (t: ReturnType<typeof setTimeout> | null) => {
      if (t !== null) {
        clearTimeout(t);
        pending.delete(t);
      }
    };
    const parts = () => {
      const tree = s.render();
      const vertical = one(all(tree, isGraphScroll), "the world's vertical scroll");
      const horizontal = one(all(vertical, (el) => nameOf(el) === "RNScrollView" && el.props.horizontal === true), "the world's horizontal scroll");
      const content = [horizontal.props.children].flat().find((c: any) => c && c.props) as El;
      const st = Object.assign({}, ...[content.props.style].flat(Infinity).filter(Boolean));
      const scaled = all(content, (el) => Array.isArray(Object.assign({}, ...[el.props.style].flat(Infinity).filter(Boolean)).transform))[0];
      const tr = scaled ? Object.assign({}, ...[scaled.props.style].flat(Infinity).filter(Boolean)).transform : [];
      const scale = Number((tr.find((t: Record<string, number>) => "scale" in t) ?? { scale: 1 }).scale);
      return { tree, vertical, horizontal, extent: { width: Number(st.width ?? 0), height: Number(st.height ?? 0) }, scale };
    };
    /** Whether the graph's scroll views are mounted (the List replaces them). */
    const mounted = () => all(s.render(), isGraphScroll).length === 1;
    const maxOf = (p: ReturnType<typeof parts>) => ({ x: Math.max(0, p.extent.width - viewport.width), y: Math.max(0, p.extent.height - viewport.height) });
    // RN Web's ScrollViewBase per element: the first scroll event of a run calls onScroll, and the
    // run's end (100 ms after its last event) calls it again.
    type Axis = "x" | "y";
    const run: Record<Axis, { scrolling: boolean; lastTick: number; lastEvent: number; end: ReturnType<typeof setTimeout> | null; anim: ReturnType<typeof setTimeout>[] }> = {
      x: { scrolling: false, lastTick: 0, lastEvent: 0, end: null, anim: [] },
      y: { scrolling: false, lastTick: 0, lastEvent: 0, end: null, anim: [] },
    };
    const elementOf = (p: ReturnType<typeof parts>, axis: Axis) => (axis === "y" ? p.vertical : p.horizontal);
    const onScrollOf = (axis: Axis) => {
      const p = parts();
      const out = (elementOf(p, axis).props.onScroll as ((e: unknown) => void) | undefined)?.({
        nativeEvent: { contentOffset: axis === "y" ? { x: 0, y: pos.y } : { x: pos.x, y: 0 }, layoutMeasurement: { ...viewport }, contentSize: { ...p.extent } },
        timeStamp: Date.now(),
      });
      // React renders after an event handler's state updates.
      parts();
      return out;
    };
    // ScrollViewBase.handleScroll: a run's first event calls onScroll, later events call it only when
    // scrollEventThrottle > 0 and that many ms have passed since the last call, and the run's end
    // (100 ms after its last event) calls it once more.
    const domScroll = (axis: Axis) => {
      const r = run[axis];
      if (!mounted()) return;
      r.lastEvent = Date.now();
      cancel(r.end);
      r.end = later(SCROLL_END, () => {
        r.end = null;
        r.scrolling = false;
        if (mounted()) onScrollOf(axis);
      });
      const throttle = Number(elementOf(parts(), axis).props.scrollEventThrottle ?? 0);
      if (!r.scrolling) {
        r.scrolling = true;
        r.lastTick = Date.now();
        onScrollOf(axis);
      } else if (throttle > 0 && Date.now() - r.lastTick >= throttle) {
        r.lastTick = Date.now();
        onScrollOf(axis);
      }
    };
    /** A user's scroll on `axis` cancels a smooth scroll running there (Chrome). */
    const interrupt = (axis: Axis) => {
      for (const t of run[axis].anim) cancel(t);
      run[axis].anim = [];
    };
    /** Moves `axis` to `target` over `frames` frames (0: at once, the event in the next frame). */
    const move = (axis: Axis, target: number, frames: number) => {
      const r = run[axis];
      for (const t of r.anim) cancel(t);
      r.anim = [];
      const clampNow = (v: number) => Math.max(0, Math.min(v, maxOf(parts())[axis]));
      if (frames === 0) {
        const to = clampNow(target);
        if (to === pos[axis]) return;
        pos[axis] = to;
        r.anim.push(later(FRAME, () => domScroll(axis)));
        return;
      }
      if (!mounted()) return;
      const from = pos[axis];
      for (let i = 1; i <= frames; i++) {
        r.anim.push(
          later(FRAME * i, () => {
            // An unmounted element's scroll stops with it.
            if (!mounted()) return interrupt(axis);
            const to = clampNow(from + ((target - from) * i) / frames);
            if (to === pos[axis]) return;
            pos[axis] = to;
            domScroll(axis);
          }),
        );
      }
    };
    const attach = () => {
      const p = parts();
      // A new scroll element starts at its origin, with nothing running.
      const fresh = (axis: Axis) => {
        pos[axis] = 0;
        interrupt(axis);
        cancel(run[axis].end);
        run[axis] = { scrolling: false, lastTick: 0, lastEvent: 0, end: null, anim: [] };
      };
      if (keys.v !== null && (p.vertical as unknown as { key: unknown }).key !== keys.v) fresh("y");
      if (keys.h !== null && (p.horizontal as unknown as { key: unknown }).key !== keys.h) fresh("x");
      keys = { v: (p.vertical as unknown as { key: unknown }).key, h: (p.horizontal as unknown as { key: unknown }).key };
      if (viewport.width > 0) {
        const m = maxOf(p);
        for (const axis of ["x", "y"] as const) {
          if (pos[axis] > m[axis]) {
            pos[axis] = m[axis];
            later(FRAME, () => domScroll(axis));
          }
        }
      }
      if (p.extent.width !== lastExtent.width || p.extent.height !== lastExtent.height) {
        lastExtent = { ...p.extent };
        const cb = p.vertical.props.onContentSizeChange as ((w: number, h: number) => void) | undefined;
        if (cb !== undefined) later(0, () => cb(p.extent.width, p.extent.height));
      }
      // RN Web: scrollTo({ x, y, animated }) scrolls the element to left x || 0, top y || 0.
      const scrollTo = (axis: Axis) => (o: { x?: number; y?: number; animated?: boolean }) => move(axis, (axis === "x" ? o.x : o.y) || 0, o.animated === false ? 0 : SMOOTH_FRAMES);
      p.vertical.props.ref.current = { scrollTo: scrollTo("y") };
      if (p.horizontal.props.ref != null && typeof p.horizontal.props.ref === "object") p.horizontal.props.ref.current = { scrollTo: scrollTo("x") };
      return p;
    };
    /** Lets renders, effects, layout callbacks, animations and scroll ends run out. */
    const settle = async () => {
      for (let i = 0; i < 200; i++) {
        attach();
        await flush();
        attach();
        if (pending.size === 0) {
          await flush();
          attach();
          if (pending.size === 0) return attach();
        }
        await sleep(FRAME);
      }
      throw new Error("the scroll model did not settle");
    };
    /** The viewport's onLayout, delivered after the render that changed it (and `afterMs` later). */
    const layout = async (next: { width: number; height: number }, afterMs = 0) => {
      await flush();
      if (afterMs > 0) await sleep(afterMs);
      viewport = next;
      attach().vertical.props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, ...next } } });
      await settle();
    };
    const bubble = (name: string, e: unknown) => {
      const p = attach();
      for (const el of [p.horizontal, p.vertical]) (el.props[name] as ((ev: unknown) => void) | undefined)?.(e);
      attach();
    };
    /** Time passing with renders, effects and the browser's frames (no settle). */
    const wait = async (ms: number) => {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        attach();
        await flush();
        await sleep(FRAME);
      }
      attach();
      await flush();
    };
    /**
     * Frames pass (renders, effects, timers) until `cond` holds; fails at once when `abort` holds and
     * after `maxMs` otherwise. Returns at the first frame the condition is seen, so the case does not
     * depend on how much wall-clock time a fixed wait covers.
     */
    const until = async (what: string, cond: () => boolean, abort: () => boolean = () => false, maxMs = 3000) => {
      const end = Date.now() + maxMs;
      for (;;) {
        attach();
        await flush();
        if (cond()) return;
        if (abort()) throw new Error(`${what}: it can no longer happen`);
        if (Date.now() > end) throw new Error(`${what}: not seen within ${maxMs} ms`);
        await sleep(FRAME);
      }
    };
    /** Mouse wheel: steps of (dx, dy) over the world, each a wheel event and a smooth scroll. */
    const wheel = async (dx: number, dy: number, steps: number) => {
      for (let i = 0; i < steps; i++) {
        bubble("onWheel", { nativeEvent: { deltaX: dx, deltaY: dy, deltaMode: 0 }, preventDefault: () => undefined, stopPropagation: () => undefined });
        if (dx !== 0) move("x", pos.x + dx, 3);
        if (dy !== 0) move("y", pos.y + dy, 3);
        await sleep(FRAME * 4);
        await flush();
      }
      await settle();
    };
    /**
     * Scroll bar drag: the position follows the thumb, each move a scroll event, nothing else reaches
     * the view. An axis left out of `to` is not dragged (its smooth scroll, if any, runs on).
     */
    const scrollBar = async (to: Partial<Pos>, steps: number, opts: { settle?: boolean } = {}) => {
      const from = { ...pos };
      const axes = (["x", "y"] as const).filter((a) => to[a] !== undefined);
      for (const axis of axes) interrupt(axis);
      for (let i = 1; i <= steps; i++) {
        const m = maxOf(attach());
        for (const axis of axes) {
          // The last step lands on the target exactly, as a released thumb does.
          const next = Math.max(0, Math.min(i === steps ? to[axis]! : from[axis] + ((to[axis]! - from[axis]) * i) / steps, m[axis]));
          if (next !== pos[axis]) {
            pos[axis] = next;
            domScroll(axis);
          }
        }
        await sleep(FRAME);
        await flush();
        attach();
      }
      if (opts.settle !== false) await settle();
    };
    /**
     * Keyboard (PageUp / PageDown / arrows), with the focus outside the map's controls (the host case:
     * a click on an empty part of the map, then the keys). The key events go to the focused element,
     * not to the scroll views, so the view sees only scroll events: each press cancels a smooth scroll
     * on that axis and smoothly scrolls by `delta` (8 frames), `gap` ms apart.
     */
    const keyboard = async (axis: Axis, delta: number, presses: number, gap = 150) => {
      for (let i = 0; i < presses; i++) {
        interrupt(axis);
        move(axis, pos[axis] + delta, 8);
        await wait(gap);
      }
      await settle();
    };
    /** A touch drag by (dx, dy) of content in `steps` moves (the content follows the finger). */
    const drag = async (dx: number, dy: number, steps: number) => {
      const touch = (x: number, y: number) => ({ nativeEvent: { touches: [{ pageX: x, pageY: y, locationX: x, locationY: y }], changedTouches: [{ pageX: x, pageY: y }], pageX: x, pageY: y, locationX: x, locationY: y, timestamp: Date.now() }, persist: () => undefined, preventDefault: () => undefined, stopPropagation: () => undefined });
      const start = { x: 150, y: 150 };
      bubble("onTouchStart", touch(start.x, start.y));
      interrupt("x");
      interrupt("y");
      const from = { ...pos };
      for (let i = 1; i <= steps; i++) {
        const fx = start.x + (dx * i) / steps;
        const fy = start.y + (dy * i) / steps;
        bubble("onTouchMove", touch(fx, fy));
        const m = maxOf(attach());
        const next = { x: Math.max(0, Math.min(from.x - (dx * i) / steps, m.x)), y: Math.max(0, Math.min(from.y - (dy * i) / steps, m.y)) };
        for (const axis of ["x", "y"] as const) {
          if (next[axis] !== pos[axis]) {
            pos[axis] = next[axis];
            domScroll(axis);
          }
        }
        await sleep(FRAME);
        await flush();
      }
      bubble("onTouchEnd", touch(start.x + dx, start.y + dy));
      await settle();
    };
    /** A wheel turn during whatever runs now (no settle): onWheel, then a smooth scroll of the axis. */
    const wheelNow = (dx: number, dy: number) => {
      bubble("onWheel", { nativeEvent: { deltaX: dx, deltaY: dy, deltaMode: 0 }, preventDefault: () => undefined, stopPropagation: () => undefined });
      if (dx !== 0) move("x", pos.x + dx, 6);
      if (dy !== 0) move("y", pos.y + dy, 6);
    };
    const running = (axis: Axis) => run[axis].anim.some((t) => pending.has(t));
    /** Whether RN Web's end-of-run onScroll is still due on `axis`, and how long ago its last scroll event was. */
    const endPending = (axis: Axis) => {
      const end = run[axis].end;
      return end !== null && pending.has(end);
    };
    const sinceLastEvent = (axis: Axis) => Date.now() - run[axis].lastEvent;
    /**
     * Delivers RN Web's pending end-of-run report on `axis` now, as its 100 ms timer would when no
     * scroll event came in between: the order of a late end report and a new run, without timing.
     */
    const endNow = (axis: Axis) => {
      const r = run[axis];
      if (r.end === null || !pending.has(r.end)) throw new Error(`no end report is pending on ${axis}`);
      cancel(r.end);
      r.end = null;
      r.scrolling = false;
      onScrollOf(axis);
    };
    const visible = () => {
      const p = attach();
      return { left: pos.x / p.scale, top: pos.y / p.scale, right: (pos.x + viewport.width) / p.scale, bottom: (pos.y + viewport.height) / p.scale, scale: p.scale, extent: p.extent, viewport: { ...viewport } };
    };
    return { pos, layout, settle, wait, until, wheel, wheelNow, scrollBar, keyboard, drag, running, endPending, sinceLastEvent, endNow, visible, parts: attach };
  }
  const flat = (el: El): Record<string, any> => Object.assign({}, ...[el.props.style].flat(Infinity).filter(Boolean));
  /** A drawn node's world rectangle, by its number. */
  const nodeRect = (tree: unknown, number: number) => {
    const el = one(all(tree, (x) => typeof x.props.accessibilityLabel === "string" && new RegExp(`^Q${number} .*, Block \\d+, \\d+ incoming, \\d+ outgoing$`).test(x.props.accessibilityLabel) && flat(x).position === "absolute"), `node Q${number}`);
    const st = flat(el);
    return { left: Number(st.left), top: Number(st.top), right: Number(st.left) + Number(st.width), bottom: Number(st.top) + Number(st.height) };
  };
  /** The scroll position that centres a world point, clamped as a browser clamps it. */
  const centred = (b: ReturnType<typeof browser>, cx: number, cy: number) => {
    const v = b.visible();
    return { x: Math.max(0, Math.min(cx * v.scale - v.viewport.width / 2, v.extent.width - v.viewport.width)), y: Math.max(0, Math.min(cy * v.scale - v.viewport.height / 2, v.extent.height - v.viewport.height)) };
  };
  const expectCentredOn = (b: ReturnType<typeof browser>, s: Screen, number: number, what: string) => {
    const r = nodeRect(s.render(), number);
    const want = centred(b, (r.left + r.right) / 2, (r.top + r.bottom) / 2);
    expect(Math.abs(b.pos.x - want.x), `${what}: x ${b.pos.x}, centred ${want.x}`).toBeLessThanOrEqual(1);
    expect(Math.abs(b.pos.y - want.y), `${what}: y ${b.pos.y}, centred ${want.y}`).toBeLessThanOrEqual(1);
  };
  const header = (tree: unknown, block: number) => one(controls(tree, new RegExp(`^Block ${block} · `)).filter((el) => !/incoming/.test(labelOf(el))), `Block ${block} header`);
  const isCollapsed = (tree: unknown, block: number) => /, collapsed$/.test(labelOf(header(tree, block)));
  const goTo = (tree: unknown) => one(controls(tree, /^Go to open Block 6$/), "Go to open Block 6");
  const DESKTOP = { width: 868, height: 612 };
  const COMPACT = { width: 366, height: 320 };

  async function desktop() {
    current = { view: buildSessionView(largeMapRoadmap(130), 1, MAP_SESSION) };
    const s = await openScreen();
    await press(one(controls(await openMenu(s), /^(✓ )?Map$/), "Map item"));
    const b = browser(s);
    await b.layout(DESKTOP);
    expect(/\b100\s?%/.test(visibleText(s.render())), "desktop opens at 100 %").toBe(true);
    expect([1, 2, 3, 4, 5].map((n) => isCollapsed(s.render(), n)), "Blocks 1–5 start collapsed").toEqual([true, true, true, true, true]);
    expect(isCollapsed(s.render(), 6), "the open Block 6 starts expanded").toBe(false);
    return { s, b };
  }
  async function compact() {
    current = { view: buildSessionView(largeMapRoadmap(130), 1, MAP_SESSION) };
    const s = await openScreen({ compact: true });
    await press(trigger(s.render()));
    const sheet = one(all(s.render(), (el) => nameOf(el) === "Modal" && el.props.open !== false && controls(el, /^(✓ )?Map$/).length > 0), "the Chat sheet");
    await press(one(controls(sheet, /^(✓ )?Map$/), "Map"));
    const b = browser(s);
    await b.layout(COMPACT);
    for (let i = 0; i < 6 && !/\b100\s?%/.test(visibleText(s.render())); i++) await press(one(controls(s.render(), /^Zoom in$/), "Zoom in"));
    await b.settle();
    expect(/\b100\s?%/.test(visibleText(s.render())), "zoomed in to 100 %").toBe(true);
    return { s, b };
  }

  // ---- The reported case (RED at f9c9850) ----
  it("desktop, wheel: after Go to open Block 6 and a wheel pan back to the origin, expanding Block 3 keeps the user's position", async () => {
    const { s, b } = await desktop();
    await press(goTo(s.render()));
    await b.settle();
    expectCentredOn(b, s, 126, "Go to centres Q126");
    expect(b.pos.x + b.pos.y, "Go to scrolled away from the origin").toBeGreaterThan(0);
    await b.wheel(-400, -400, 6);
    expect(b.pos, "the wheel pan reached the origin").toEqual({ x: 0, y: 0 });
    await press(header(s.render(), 3));
    await b.settle();
    expect(isCollapsed(s.render(), 3), "Block 3 expanded").toBe(false);
    expect(b.pos, "expanding Block 3 keeps the user's pan (the host jumped back to Q126)").toEqual({ x: 0, y: 0 });
  });

  it("desktop, scroll bar: after Go to and a scroll bar pan to a middle position, expanding Block 2 keeps that position", async () => {
    const { s, b } = await desktop();
    await press(goTo(s.render()));
    await b.settle();
    expectCentredOn(b, s, 126, "Go to centres Q126");
    await b.scrollBar({ x: 300, y: 100 }, 5);
    expect(b.pos, "the scroll bar pan").toEqual({ x: 300, y: 100 });
    await press(header(s.render(), 2));
    await b.settle();
    expect(isCollapsed(s.render(), 2), "Block 2 expanded").toBe(false);
    expect(b.pos, "expanding Block 2 keeps the user's pan").toEqual({ x: 300, y: 100 });
  });

  it("compact, touch: after Go to open Block 6 and a drag back to the origin, expanding Block 2 keeps the user's position", async () => {
    const { s, b } = await compact();
    await press(goTo(s.render()));
    await b.settle();
    expectCentredOn(b, s, 126, "Go to centres Q126");
    const before = { ...b.pos };
    expect(before.x + before.y, "Go to scrolled away from the origin").toBeGreaterThan(0);
    await b.drag(before.x, before.y, 8);
    expect(b.pos, "the drag reached the origin").toEqual({ x: 0, y: 0 });
    await press(header(s.render(), 2));
    await b.settle();
    expect(isCollapsed(s.render(), 2), "Block 2 expanded").toBe(false);
    expect(b.pos, "expanding Block 2 keeps the user's pan").toEqual({ x: 0, y: 0 });
  });

  // ---- What must keep working (the centring the fix must not lose) ----
  it("Go to still centres the open block's first question when its lane was collapsed, through the smooth scroll and the expansion", async () => {
    const { s, b } = await desktop();
    await press(header(s.render(), 6));
    await b.settle();
    expect(isCollapsed(s.render(), 6), "the owner collapsed Block 6").toBe(true);
    await b.scrollBar({ x: 0, y: 0 }, 2);
    await press(goTo(s.render()));
    await b.settle();
    expect(isCollapsed(s.render(), 6), "Go to expands Block 6").toBe(false);
    expectCentredOn(b, s, 126, "Go to centres Q126 in the expanded lane");
  });

  it("Go to pressed again after a pan centres the open block again", async () => {
    const { s, b } = await desktop();
    await press(goTo(s.render()));
    await b.settle();
    await b.wheel(-400, -400, 6);
    expect(b.pos).toEqual({ x: 0, y: 0 });
    await press(goTo(s.render()));
    await b.settle();
    expectCentredOn(b, s, 126, "the second Go to centres Q126");
  });

  it("compact, Go to with no pan: Q126 stays centred once its own smooth scroll has ended", async () => {
    const { s, b } = await compact();
    await press(goTo(s.render()));
    await b.settle();
    expectCentredOn(b, s, 126, "Go to centres Q126");
    await sleep(SCROLL_END * 2);
    await b.settle();
    expectCentredOn(b, s, 126, "still centred after the scroll run ended");
  });

  it("desktop selection: the selected question is centred, and centred again once the detail panel narrows the viewport", async () => {
    const { s, b } = await desktop();
    await press(header(s.render(), 1));
    await b.settle();
    await press(one(controls(s.render(), /^Q13 Large question 13, /), "Q13"));
    // The detail panel opens beside the map; the map's new width arrives in a later layout callback,
    // while the first centring scroll is still animating (its first onScroll already delivered).
    await b.layout({ width: 536, height: 583 }, FRAME * 3);
    expectCentredOn(b, s, 13, "Q13 centred in the narrowed map");
  });

  it("desktop selection: the narrowing layout arriving after the first centring scroll has ended still re-centres", async () => {
    const { s, b } = await desktop();
    await press(header(s.render(), 1));
    await b.settle();
    await press(one(controls(s.render(), /^Q13 Large question 13, /), "Q13"));
    await b.settle();
    expectCentredOn(b, s, 13, "Q13 centred in the full-width map");
    const wide = { ...b.pos };
    await b.layout({ width: 536, height: 583 });
    expect(b.pos.x, "the narrowed map needs another position").not.toBe(wide.x);
    expectCentredOn(b, s, 13, "Q13 centred in the narrowed map");
  });

  it("selection after Go to and a pan: the new selection is centred", async () => {
    const { s, b } = await desktop();
    await press(goTo(s.render()));
    await b.settle();
    await b.wheel(-400, -400, 6);
    await press(one(controls(s.render(), /^Q126 Large question 126, /), "Q126"));
    await b.layout({ width: 536, height: 583 });
    expectCentredOn(b, s, 126, "the selected Q126 centred");
  });

  it("compact overview: Zoom in here centres the pressed point at 100 %", async () => {
    current = { view: buildSessionView(largeMapRoadmap(130), 1, MAP_SESSION) };
    const s = await openScreen({ compact: true });
    await press(trigger(s.render()));
    const sheet = one(all(s.render(), (el) => nameOf(el) === "Modal" && el.props.open !== false && controls(el, /^(✓ )?Map$/).length > 0), "the Chat sheet");
    await press(one(controls(sheet, /^(✓ )?Map$/), "Map"));
    const b = browser(s);
    await b.layout(COMPACT);
    const v = b.visible();
    expect(v.scale, "the Map opens as an overview").toBeLessThan(0.75);
    // A press on Q126 as drawn at the overview's scale (wrapper coordinates).
    const r = nodeRect(s.render(), 126);
    const at = { x: ((r.left + r.right) / 2) * v.scale, y: ((r.top + r.bottom) / 2) * v.scale };
    const zoomHere = one(all(s.render(), (el) => el.props.accessibilityLabel === "Zoom in here" && typeof el.props.onPress === "function"), "Zoom in here");
    zoomHere.props.onPress({ nativeEvent: { locationX: at.x, locationY: at.y }, preventDefault: () => undefined, stopPropagation: () => undefined });
    await b.settle();
    expect(/\b100\s?%/.test(visibleText(s.render())), "zoomed in to 100 %").toBe(true);
    expectCentredOn(b, s, 126, "the pressed point (Q126) centred");
  });

  // ---- A pan made while the view's own smooth scroll is still running ----
  // Host recheck at a6b10d1 (docs/reviews/2026-11-10-r7-map-goto-pan-recheck-a6b10d1.md, cases 7 and
  // 8): Go to's smooth scroll ran about 600 ms; PageUp about 150 ms into it (focus on the page after a
  // click on an empty part of the map), or the scroll position moved to the top about 200 ms into it,
  // stopped the vertical run short of its target while the horizontal run finished; a later lane
  // change scrolled the view back to Q126. The view gets no key or pointer event for these pans, only
  // scroll events: with scrollEventThrottle 0 one when the run starts (Go to's own first frame) and
  // one 100 ms after the run's last event, at the position the user left it. That end position is
  // neither the target the view asked for nor that target clamped to the content's extent at the
  // event (contentSize and layoutMeasurement come with it), which is what tells an interrupted run
  // from the view's own run ending. When the user's pan ends exactly at the target (or at the limit
  // the target was clamped to) the two are not distinguishable, and these cases do not ask for it.
  describe("interrupted by the user", () => {
    // DeepSeek Flash review 01a1c737 c0056: the pan comes while the view's own smooth scroll is under
    // way (on the host 150–200 ms into it). Instead of a fixed wait on real timers, which a stall
    // of a few hundred ms turns into a finished scroll, the case waits for the run to be seen in
    // flight: running on the named axes and moved from where it started. A run that ends first
    // fails the case as such, not as a product defect.
    type Need = "both" | "either" | "x" | "y";
    const midRun = async (b: ReturnType<typeof browser>, need: Need) => {
      const from = { ...b.pos };
      const axes: Array<"x" | "y"> = need === "x" || need === "y" ? [need] : ["x", "y"];
      const moved = () => axes.some((a) => b.pos[a] !== from[a]);
      const on = () => (need === "either" ? axes.some((a) => b.running(a)) : axes.every((a) => b.running(a)));
      await b.until(`the smooth scroll under way (${need})`, () => on() && moved(), () => moved() && !axes.some((a) => b.running(a)));
    };
    it("desktop, keyboard: PageUp 150 ms into Go to's scroll, then a lane expand: the view keeps the user's position", async () => {
      const { s, b } = await desktop();
      await press(goTo(s.render()));
      await midRun(b, "both");
      expect(b.running("y") && b.running("x"), "Go to's smooth scroll is under way").toBe(true);
      const midway = { ...b.pos };
      await b.keyboard("y", -612, 3);
      expect(b.pos.y, `PageUp took the view to the top (it was at y ${midway.y} on the way down)`).toBe(0);
      const left = { ...b.pos };
      expect(left.x, "the horizontal run finished at its target").toBeGreaterThan(midway.x);
      await press(header(s.render(), 3));
      await b.settle();
      expect(isCollapsed(s.render(), 3), "Block 3 expanded").toBe(false);
      expect(b.pos, "expanding Block 3 keeps the user's position (the host scrolled back to Q126)").toEqual(left);
    });

    it("desktop, scroll bar: the vertical thumb dragged to the top 200 ms into Go to's scroll, then a lane expand: the view keeps that position", async () => {
      const { s, b } = await desktop();
      await press(goTo(s.render()));
      await midRun(b, "y");
      expect(b.running("y"), "Go to's vertical scroll is under way").toBe(true);
      await b.scrollBar({ y: 0 }, 5, { settle: false });
      await b.settle();
      expect(b.pos.y, "the thumb was left at the top").toBe(0);
      const left = { ...b.pos };
      await press(header(s.render(), 2));
      await b.settle();
      expect(isCollapsed(s.render(), 2), "Block 2 expanded").toBe(false);
      expect(b.pos, "expanding Block 2 keeps the user's position").toEqual(left);
    });

    it("desktop, scroll bar on both axes during the scroll, then a lane collapse: the view keeps that position", async () => {
      const { s, b } = await desktop();
      await press(header(s.render(), 3));
      await b.settle();
      await press(goTo(s.render()));
      await midRun(b, "either");
      await b.scrollBar({ x: 300, y: 100 }, 5);
      expect(b.pos).toEqual({ x: 300, y: 100 });
      await press(header(s.render(), 3));
      await b.settle();
      expect(isCollapsed(s.render(), 3), "Block 3 collapsed again").toBe(true);
      expect(b.pos, "collapsing Block 3 keeps the user's position").toEqual({ x: 300, y: 100 });
    });

    // ---- What an interrupted run must not be confused with ----
    it("Go to's own scroll ending at its target (clamped at the bottom) is not a pan: a later lane expand centres Q126 again", async () => {
      const { s, b } = await desktop();
      await press(goTo(s.render()));
      await b.settle();
      expectCentredOn(b, s, 126, "Go to centres Q126");
      const v = b.visible();
      expect(b.pos.y, "the vertical target is the content's bottom limit").toBe(v.extent.height - v.viewport.height);
      await press(header(s.render(), 3));
      await b.settle();
      expectCentredOn(b, s, 126, "Q126 is centred again after Block 3 grows above it");
    });

    it("a selection replaced 150 ms into its scroll: the new selection's scroll is the view's own, and a later lane expand keeps it centred", async () => {
      const { s, b } = await desktop();
      await press(header(s.render(), 1));
      await b.settle();
      await press(one(controls(s.render(), /^Q13 Large question 13, /), "Q13"));
      await b.layout({ width: 536, height: 583 }, FRAME * 2);
      await press(one(controls(s.render(), /^Q20 Large question 20, /), "Q20"));
      await midRun(b, "either");
      expect(b.running("y") || b.running("x"), "Q20's scroll is under way").toBe(true);
      await press(one(controls(s.render(), /^Q24 Large question 24, /), "Q24"));
      await b.settle();
      expectCentredOn(b, s, 24, "Q24 centred");
      await press(header(s.render(), 3));
      await b.settle();
      expectCentredOn(b, s, 24, "Q24 still centred after Block 3 expands");
    });

    it("the detail panel narrowing the map during the selection's scroll re-targets it; the selection stays centred through a later lane expand", async () => {
      const { s, b } = await desktop();
      await press(header(s.render(), 1));
      await b.settle();
      await press(one(controls(s.render(), /^Q13 Large question 13, /), "Q13"));
      await b.layout({ width: 536, height: 583 }, 150);
      expectCentredOn(b, s, 13, "Q13 centred in the narrowed map");
      await press(header(s.render(), 4));
      await b.settle();
      expectCentredOn(b, s, 13, "Q13 still centred after Block 4 expands");
    });

    // At Fit the lanes are not pressable (an overview), so the later layout change is a zoom.
    it("Fit pressed during Go to's scroll: the world is at the origin and stays there when zoomed in", async () => {
      const { s, b } = await desktop();
      await press(goTo(s.render()));
      await midRun(b, "either");
      await press(one(controls(s.render(), /^(✓ )?Fit$/), "Fit"));
      await b.settle();
      expect(b.pos, "Fit scrolls to the origin").toEqual({ x: 0, y: 0 });
      await press(one(controls(s.render(), /^Zoom in$/), "Zoom in"));
      await b.settle();
      expect(b.visible().scale, "zoomed in").toBeGreaterThan(0.3);
      expect(b.pos, "the origin is kept").toEqual({ x: 0, y: 0 });
    });

    it("desktop, wheel during Go to's scroll, then a lane expand: the view keeps the user's position", async () => {
      const { s, b } = await desktop();
      await press(goTo(s.render()));
      await midRun(b, "either");
      b.wheelNow(0, -400);
      b.wheelNow(-400, 0);
      await b.settle();
      const left = { ...b.pos };
      await press(header(s.render(), 3));
      await b.settle();
      expect(b.pos, "expanding Block 3 keeps the user's position").toEqual(left);
    });

    it("compact, touch drag during Go to's scroll, then a lane expand: the view keeps the user's position", async () => {
      const { s, b } = await compact();
      await press(goTo(s.render()));
      await midRun(b, "either");
      expect(b.running("x") || b.running("y"), "Go to's smooth scroll is under way").toBe(true);
      await b.drag(200, 100, 6);
      const left = { ...b.pos };
      await press(header(s.render(), 2));
      await b.settle();
      expect(b.pos, "expanding Block 2 keeps the user's position").toEqual(left);
    });

    // ---- Audit at 82c7502 ----
    // RN Web reports a run's end 100 ms after its last scroll event, at the position then. A new
    // programmatic scroll that starts in the last frame of that window (its first scroll event comes
    // after the old run's end is due) makes the old end arrive while the new run is in flight, at the
    // position of the call before. That is the view's own scroll ending, not a user's pan; nothing of
    // the user's happened. Here Go to's scroll has ended on its target, and Q128 is pressed 88 ms after
    // the run's last scroll event: the press scrolls right to Q128's centre (clamped), and the detail
    // panel then narrows the map, which must re-centre Q128.
    it("a selection pressed in the last frame before the previous run's end report is still kept centred when the detail narrows the map", async () => {
      const { s, b } = await desktop();
      await press(goTo(s.render()));
      await b.wait(FRAME * 2);
      expect(b.running("x"), "Go to's scroll started").toBe(true);
      while (b.running("x") || b.running("y")) await b.wait(FRAME);
      expectCentredOn(b, s, 126, "Go to centred Q126");
      expect(b.endPending("x"), "the run's end report is still due").toBe(true);
      // The press, its render and the selection's scrollTo, at once (as a browser handles one event).
      one(controls(b.parts().tree, /^Q128 Large question 128, /), "Q128").props.onPress({ nativeEvent: {}, preventDefault: () => undefined, stopPropagation: () => undefined });
      b.parts();
      expect(b.running("x"), "the selection's scroll to Q128 has started").toBe(true);
      // DeepSeek Flash review 01a1c67a c0030: the window (a press 88–99 ms after the last scroll event,
      // so the old report comes before the new run's first frame) is reproduced by order, not by a
      // busy wait on real timers: the old run's end report is delivered now, before the new run's
      // first frame.
      b.endNow("x");
      await b.layout({ width: 536, height: 583 }, FRAME * 3);
      expectCentredOn(b, s, 128, "Q128 centred in the narrowed map");
    });

    it("control: the same press while the old report is due, without forcing it, keeps Q128 centred when the detail narrows the map", async () => {
      const { s, b } = await desktop();
      await press(goTo(s.render()));
      await b.wait(FRAME * 2);
      while (b.running("x") || b.running("y")) await b.wait(FRAME);
      // Pressed while the old report is still due, with no delivery forced: the new run's first frame
      // comes first and postpones it, as on the host.
      expect(b.endPending("x"), "the old run's end report is still due").toBe(true);
      one(controls(b.parts().tree, /^Q128 Large question 128, /), "Q128").props.onPress({ nativeEvent: {}, preventDefault: () => undefined, stopPropagation: () => undefined });
      b.parts();
      await b.layout({ width: 536, height: 583 }, FRAME * 3);
      expectCentredOn(b, s, 128, "Q128 centred in the narrowed map");
    });

    it("the horizontal scroll bar dragged during Go to's scroll while the vertical run finishes: a later lane expand keeps both", async () => {
      const { s, b } = await desktop();
      await press(goTo(s.render()));
      await midRun(b, "both");
      expect(b.running("x") && b.running("y"), "both runs under way").toBe(true);
      await b.scrollBar({ x: 300 }, 4);
      const left = { ...b.pos };
      expect(left.x, "left where the thumb was released").toBe(300);
      expect(left.y, "the vertical run reached its target").toBeGreaterThan(0);
      await press(header(s.render(), 3));
      await b.settle();
      expect(b.pos, "expanding Block 3 keeps the user's position").toEqual(left);
    });

    it("PageDown during Go to's downward scroll that stops short of its target: a later lane expand keeps it", async () => {
      const { s, b } = await desktop();
      await press(goTo(s.render()));
      await midRun(b, "y");
      const mid = b.pos.y;
      await b.keyboard("y", 60, 1);
      const left = { ...b.pos };
      expect(left.y, `stopped between ${mid} and the target`).toBeGreaterThan(mid);
      expect(left.y, "short of the run's target (244)").toBeLessThan(240);
      await press(header(s.render(), 3));
      await b.settle();
      expect(b.pos, "expanding Block 3 keeps the user's position").toEqual(left);
    });

    it("a keyboard pan during a selection's centring scroll ends that centring too: a later lane expand keeps the user's position", async () => {
      const { s, b } = await desktop();
      await press(header(s.render(), 1));
      await b.settle();
      await press(one(controls(s.render(), /^Q13 Large question 13, /), "Q13"));
      await b.layout({ width: 536, height: 583 });
      await press(one(controls(s.render(), /^Q24 Large question 24, /), "Q24"));
      await midRun(b, "either");
      expect(b.running("x") || b.running("y"), "Q24's scroll is under way").toBe(true);
      await b.keyboard("y", -300, 1);
      const left = { ...b.pos };
      await press(header(s.render(), 3));
      await b.settle();
      expect(b.pos, "expanding Block 3 keeps the user's position").toEqual(left);
    });

    it("List and back to Graph during Go to's scroll: the remounted world starts at its origin, and Go to, a pan and a lane expand behave as before", async () => {
      const { s, b } = await desktop();
      await press(goTo(s.render()));
      await midRun(b, "either");
      await press(one(controls(s.render(), /^(✓ )?List$/), "List"));
      await press(one(controls(s.render(), /^(✓ )?Graph$/), "Graph"));
      await b.settle();
      await press(goTo(s.render()));
      await b.settle();
      expectCentredOn(b, s, 126, "Go to centres Q126 in the remounted world");
      await b.keyboard("y", -612, 2);
      const left = { ...b.pos };
      expect(left.y, "the keyboard pan after the run").toBeLessThan(244);
      await press(header(s.render(), 3));
      await b.settle();
      expect(b.pos, "expanding Block 3 keeps the user's position").toEqual(left);
    });
  });
});

// ---- Map: the selected question's activation conditions ----
// Selecting a question shows the condition of each of its activations on the map. Each condition is
// a different statement (which option of the parent activates which child), so every label must be
// readable on its own: two labels in one place hide one of them. Here one parent has four long,
// distinct options and each activates its own child in the same lane, so four labels compete for one
// lane's track in a narrow world (at 8a0514c each label is up to 360 px wide and its left edge is
// clamped to the world's width, so labels that do not fit share one position).
describe("Map: activation condition labels stay apart", () => {
  const LONG = [
    "Codes from an authenticator app on the owner's phone",
    "A one-time code sent by text message to a verified number",
    "A hardware security key registered in account settings",
    "Backup codes printed once and kept somewhere safe offline",
  ];
  function fanOut() {
    const opts = LONG.map((label, i) => ({ id: `o${i + 1}`, label }));
    const parent = storedAnswered(storedQuestion("p1", { order: 0, number: 1, title: "Which second factor is offered?", options: opts, blockId: "b1" }), "o1");
    const children = LONG.map((_, i) =>
      storedQuestion(`c${i + 1}`, { order: i + 1, number: i + 2, title: `Child ${i + 1}`, options: [{ id: "a", label: "A" }], blockId: "b1", activatedBy: [{ parent: { sessionId: MAP_SESSION, questionId: "p1" }, optionIds: [`o${i + 1}`] }] }),
    );
    return roadmapData([{ id: MAP_SESSION, title: "Session S", createdAt: NOW_ISO, status: "active", questions: [parent, ...children], blocks: [{ id: "b1", order: 0, state: "open", openedAt: NOW_ISO }] } as never]);
  }
  const flat = (el: El): Record<string, any> => Object.assign({}, ...[el.props.style].flat(Infinity).filter(Boolean));

  it("four conditions of one parent in one lane: every label is drawn and no two overlap", async () => {
    current = { view: buildSessionView(fanOut(), 1, MAP_SESSION) };
    const s = await openScreen();
    await press(one(controls(await openMenu(s), /^(✓ )?Map$/), "Map item"));
    expect(/\b100\s?%/.test(visibleText(s.render())), "wide opens at 100 %").toBe(true);
    await press(one(controls(s.render(), /^Q1 Which second factor is offered\?, /), "the parent node"));
    const labels = all(s.render(), (el) => nameOf(el) === "Text" && flat(el).position === "absolute" && /^when /.test(textOf(el.props.children))).map((el) => {
      const st = flat(el);
      return { text: textOf(el.props.children), left: Number(st.left), right: Number(st.left) + Number(st.width), top: Number(st.top), bottom: Number(st.top) + Number(st.lineHeight ?? 14) };
    });
    for (const label of LONG) expect(labels.filter((l) => l.text.includes(label.slice(0, 20))).length, `a label for "${label}"`).toBe(1);
    const overlapping: string[] = [];
    for (let i = 0; i < labels.length; i++) {
      for (let j = i + 1; j < labels.length; j++) {
        const [a, b] = [labels[i], labels[j]];
        if (a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom) overlapping.push(`"${a.text}" [${a.left}–${a.right}, ${a.top}] / "${b.text}" [${b.left}–${b.right}, ${b.top}]`);
      }
    }
    expect(overlapping).toEqual([]);
  });
});

const canonicalJsonOf = (x: unknown) => JSON.stringify(x);
// ---- Map: condition labels across lanes ----
// Every activation condition of the selected question must stay readable: inside the world, clear of
// every node and port (of any lane) and of every other label. Here a parent in Block 1 has six long,
// distinct options, each activating its own child; Block 2 below holds two questions in the columns
// the labels need, so labels that run out of room in Block 1's track must not settle on Block 2's
// nodes. The same holds with Block 2 collapsed (its port takes the place of its nodes), at 75 %, and
// when a child is selected.
describe("Map: condition labels never cover nodes, ports or each other", () => {
  const OPTIONS = [
    "Codes from an authenticator app on the owner's phone",
    "A one-time code sent by text message to a verified number",
    "A hardware security key registered in account settings",
    "Backup codes printed once and kept somewhere safe offline",
    "A push approval in the company's mobile sign-in app",
    "A call to the registered landline that reads out a code",
  ];
  function twoLanes() {
    const sref = (questionId: string) => ({ sessionId: MAP_SESSION, questionId });
    const opts = OPTIONS.map((label, i) => ({ id: `o${i + 1}`, label }));
    const one = [{ id: "a", label: "A" }];
    const parent = storedAnswered(storedQuestion("p1", { order: 0, number: 1, title: "Which second factor is offered?", options: opts, blockId: "b1" }), "o1");
    const children = OPTIONS.map((_, i) => storedQuestion(`c${i + 1}`, { order: i + 1, number: i + 2, title: `Child ${i + 1}`, options: one, blockId: "b1", activatedBy: [{ parent: sref("p1"), optionIds: [`o${i + 1}`] }] }));
    const z1 = storedAnswered(storedQuestion("z1", { order: 7, number: 8, title: "Lane two root", options: one, blockId: "b2" }), "a");
    const z2 = storedQuestion("z2", { order: 8, number: 9, title: "Lane two child", options: one, blockId: "b2", activatedBy: [{ parent: sref("z1"), optionIds: ["a"] }] });
    return roadmapData([
      {
        id: MAP_SESSION,
        title: "Session S",
        createdAt: NOW_ISO,
        status: "active",
        questions: [parent, ...children, z1, z2],
        blocks: [
          { id: "b1", order: 0, state: "accepted", openedAt: NOW_ISO, acceptedAt: NOW_ISO, acceptedBy: { kind: "human" } },
          { id: "b2", order: 1, state: "open", openedAt: NOW_ISO },
        ],
      } as never,
    ]);
  }
  const flat = (el: El): Record<string, any> => Object.assign({}, ...[el.props.style].flat(Infinity).filter(Boolean));
  type Box = { name: string; left: number; top: number; right: number; bottom: number };
  /** The scaled world element (its unscaled width and height), the node and port boxes, and the condition labels. */
  function measure(tree: unknown) {
    const worldEl = all(tree, (el) => Array.isArray(flat(el).transform) && flat(el).transformOrigin === "top left")[0];
    const w = worldEl === undefined ? { width: 0, height: 0 } : { width: Number(flat(worldEl).width), height: Number(flat(worldEl).height) };
    const boxes: Box[] = all(worldEl, (el) => typeof el.props.accessibilityLabel === "string" && flat(el).position === "absolute" && (/, Block \d+, \d+ incoming, \d+ outgoing$/.test(el.props.accessibilityLabel) || /^→ Block \d+ \(\d+ edges?\)$/.test(el.props.accessibilityLabel) || /^Block \d+ · /.test(el.props.accessibilityLabel))).map((el) => {
      const st = flat(el);
      return { name: String(el.props.accessibilityLabel).slice(0, 40), left: Number(st.left), top: Number(st.top), right: Number(st.left) + Number(st.width ?? 0), bottom: Number(st.top) + Number(st.height ?? st.minHeight ?? 0) };
    }).filter((b) => b.right > b.left && b.bottom > b.top);
    const labels: Box[] = all(worldEl, (el) => nameOf(el) === "Text" && flat(el).position === "absolute" && /^when /.test(textOf(el.props.children))).map((el) => {
      const st = flat(el);
      return { name: textOf(el.props.children), left: Number(st.left), top: Number(st.top), right: Number(st.left) + Number(st.width), bottom: Number(st.top) + Number(st.lineHeight ?? 14) };
    });
    return { world: w, boxes, labels };
  }
  const meets = (a: Box, b: Box) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
  function problems(m: ReturnType<typeof measure>): string[] {
    const out: string[] = [];
    for (const l of m.labels) {
      if (l.left < 0 || l.top < 0 || l.right > m.world.width || l.bottom > m.world.height) out.push(`outside the world ${m.world.width}×${m.world.height}: "${l.name}" [${l.left}–${l.right}, ${l.top}–${l.bottom}]`);
      for (const b of m.boxes) if (meets(l, b)) out.push(`"${l.name}" [${l.left}–${l.right}, ${l.top}–${l.bottom}] covers ${b.name} [${b.left}–${b.right}, ${b.top}–${b.bottom}]`);
    }
    for (let i = 0; i < m.labels.length; i++) for (let j = i + 1; j < m.labels.length; j++) if (meets(m.labels[i], m.labels[j])) out.push(`"${m.labels[i].name}" overlaps "${m.labels[j].name}"`);
    return out;
  }
  async function openWith() {
    current = { view: buildSessionView(twoLanes(), 1, MAP_SESSION) };
    const s = await openScreen();
    await press(one(controls(await openMenu(s), /^(✓ )?Map$/), "Map item"));
    return s;
  }
  const select = async (s: Screen, title: RegExp) => press(one(controls(s.render(), title), `node ${String(title)}`));

  it("the parent selected at 100 %: six labels, one per condition, inside the world and clear of every node and label", async () => {
    const s = await openWith();
    expect(/\b100\s?%/.test(visibleText(s.render()))).toBe(true);
    await select(s, /^Q1 Which second factor is offered\?, /);
    const m = measure(s.render());
    for (const o of OPTIONS) expect(m.labels.filter((l) => l.name.includes(o.slice(0, 24))).length, `one label for "${o}"`).toBe(1);
    expect(m.boxes.some((b) => /^Q9 /.test(b.name)), "Block 2's nodes are drawn").toBe(true);
    expect(problems(m)).toEqual([]);
  });

  it("at 75 % the same labels keep clear (the world is scaled as a whole)", async () => {
    const s = await openWith();
    await press(one(controls(s.render(), /^Zoom out$/), "Zoom out"));
    expect(/\b75\s?%/.test(visibleText(s.render()))).toBe(true);
    await select(s, /^Q1 Which second factor is offered\?, /);
    expect(problems(measure(s.render()))).toEqual([]);
  });

  // Above 120 nodes lanes start collapsed. Block 2 here is a collapsed lane of 115 questions right
  // below the labels, each activated by Child 1, so its header and its port sit where the labels of
  // Block 1 run out of room; Block 3 is open below it.
  function threeLanes() {
    const sref = (questionId: string) => ({ sessionId: MAP_SESSION, questionId });
    const opts = OPTIONS.map((label, i) => ({ id: `o${i + 1}`, label }));
    const one = [{ id: "a", label: "A" }];
    let n = 0;
    const next = () => ({ order: n, number: ++n });
    const parent = storedAnswered(storedQuestion("p1", { ...next(), title: "Which second factor is offered?", options: opts, blockId: "b1" }), "o1");
    const children = OPTIONS.map((_, i) => {
      const c = storedQuestion(`c${i + 1}`, { ...next(), title: `Child ${i + 1}`, options: one, blockId: "b1", activatedBy: [{ parent: sref("p1"), optionIds: [`o${i + 1}`] }] });
      return i === 0 ? storedAnswered(c, "a") : c;
    });
    const filler = Array.from({ length: 115 }, (_, i) => storedQuestion(`f${i + 1}`, { ...next(), title: `Filler ${i + 1}`, options: one, blockId: "b2", activatedBy: [{ parent: sref("c1"), optionIds: ["a"] }] }));
    const z1 = storedAnswered(storedQuestion("z1", { ...next(), title: "Lane three root", options: one, blockId: "b3" }), "a");
    const z2 = storedQuestion("z2", { ...next(), title: "Lane three child", options: one, blockId: "b3", activatedBy: [{ parent: sref("z1"), optionIds: ["a"] }] });
    const accepted = (id: string, order: number) => ({ id, order, state: "accepted" as const, openedAt: NOW_ISO, acceptedAt: NOW_ISO, acceptedBy: { kind: "human" as const } });
    return roadmapData([
      { id: MAP_SESSION, title: "Session S", createdAt: NOW_ISO, status: "active", questions: [parent, ...children, ...filler, z1, z2], blocks: [accepted("b1", 0), accepted("b2", 1), { id: "b3", order: 2, state: "open", openedAt: NOW_ISO }] } as never,
    ]);
  }

  it("above 120 nodes, with the lane below collapsed: the labels keep clear of its header and port and of the open lane's nodes", async () => {
    current = { view: buildSessionView(threeLanes(), 1, MAP_SESSION) };
    const s = await openScreen();
    await press(one(controls(await openMenu(s), /^(✓ )?Map$/), "Map item"));
    const header = (b: number, collapsedNow: boolean) => controls(s.render(), new RegExp(`^Block ${b} · `)).filter((el) => !/incoming/.test(labelOf(el)) && /collapsed$/.test(labelOf(el)) === collapsedNow);
    expect(header(2, true).length, "Block 2 starts collapsed").toBe(1);
    await press(one(header(1, true), "Block 1 header (collapsed)"));
    await select(s, /^Q1 Which second factor is offered\?, /);
    expect(header(2, true).length, "Block 2 stays collapsed").toBe(1);
    const m = measure(s.render());
    expect(m.labels.length, "six labels").toBe(6);
    expect(m.boxes.some((b) => /^→ Block 2 \(\d+ edges?\)$/.test(b.name)), "Block 2's port is drawn").toBe(true);
    expect(problems(m)).toEqual([]);
  });

  // Several lanes grow at once, above the selected question: the parent sits in Block 3 and activates
  // three children in Block 1 and three in Block 2, so the labels need room in Blocks 1 and 2 and the
  // parent itself moves down by that room. Block 4 (open) holds two questions; a link runs from Child 1
  // (Block 1) to Block 4 across the grown lanes, another back from Child 5 to Child 4 in Block 2, and
  // one from Block 4 back up to the parent. The view must centre the parent where it now is, clearing
  // the selection must give the room back, and Go to open Block must reach Block 4 at its moved place.
  function grownAbove() {
    const sref = (questionId: string) => ({ sessionId: MAP_SESSION, questionId });
    const opts = OPTIONS.map((label, i) => ({ id: `o${i + 1}`, label }));
    const one = [{ id: "a", label: "A" }];
    const children = OPTIONS.map((_, i) => storedQuestion(`c${i + 1}`, { order: i, number: i + 1, title: `Child ${i + 1}`, options: one, blockId: i < 3 ? "b1" : "b2", activatedBy: [{ parent: sref("p1"), optionIds: [`o${i + 1}`] }] }));
    const parent = storedQuestion("p1", { order: 6, number: 7, title: "Which second factor is offered?", options: opts, blockId: "b3" });
    const z1 = storedAnswered(storedQuestion("z1", { order: 7, number: 8, title: "Lane four root", options: one, blockId: "b4" }), "a");
    const z2 = storedQuestion("z2", { order: 8, number: 9, title: "Lane four child", options: one, blockId: "b4", activatedBy: [{ parent: sref("z1"), optionIds: ["a"] }] });
    const accepted = (id: string, order: number) => ({ id, order, state: "accepted" as const, openedAt: NOW_ISO, acceptedAt: NOW_ISO, acceptedBy: { kind: "human" as const } });
    const data = roadmapData([
      { id: MAP_SESSION, title: "Session S", createdAt: NOW_ISO, status: "active", questions: [...children, parent, z1, z2], blocks: [accepted("b1", 0), accepted("b2", 1), accepted("b3", 2), { id: "b4", order: 3, state: "open", openedAt: NOW_ISO }] } as never,
    ]);
    data.meta.links = [
      { id: "g-across", kind: "informs", from: sref("c1"), to: sref("z2") },
      { id: "g-back", kind: "informs", from: sref("c5"), to: sref("c4") },
      { id: "g-up", kind: "supersedes", from: sref("z1"), to: sref("p1") },
    ];
    return data;
  }
  /** Scroll recorders clamped to the content and view at each call, as a browser keeps them. */
  function scrollRecorder(s: Screen, viewport: { width: number; height: number }) {
    const pos = { x: 0, y: 0 };
    const attach = () => {
      const tree = s.render();
      const vertical = one(all(tree, isGraphScroll), "the world's vertical scroll");
      const horizontal = one(all(vertical, (el) => nameOf(el) === "RNScrollView" && el.props.horizontal === true), "the world's horizontal scroll");
      const content = [horizontal.props.children].flat().find((c: any) => c && c.props) as El;
      const st = flat(content);
      const ext = { width: Number(st.width ?? 0), height: Number(st.height ?? 0) };
      pos.x = Math.max(0, Math.min(pos.x, Math.max(0, ext.width - viewport.width)));
      pos.y = Math.max(0, Math.min(pos.y, Math.max(0, ext.height - viewport.height)));
      vertical.props.ref.current = { scrollTo: (o: { y?: number }) => void (pos.y = Math.max(0, Math.min(o.y ?? pos.y, Math.max(0, ext.height - viewport.height)))) };
      if (horizontal.props.ref != null && typeof horizontal.props.ref === "object") horizontal.props.ref.current = { scrollTo: (o: { x?: number }) => void (pos.x = Math.max(0, Math.min(o.x ?? pos.x, Math.max(0, ext.width - viewport.width)))) };
      return { vertical, tree };
    };
    const settle = async () => {
      for (let i = 0; i < 4; i++) {
        attach();
        await flush();
      }
      return attach().tree;
    };
    attach().vertical.props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, ...viewport } } });
    return { pos, settle };
  }
  const boxOf = (tree: unknown, re: RegExp) => measure(tree).boxes.find((b) => re.test(b.name))!;

  it("several lanes grow above the selected question: labels clear, the parent centred where it moved, room given back on Clear, Go reaches the open block", async () => {
    current = { view: buildSessionView(grownAbove(), 1, MAP_SESSION) };
    const s = await openScreen();
    await press(one(controls(await openMenu(s), /^(✓ )?Map$/), "Map item"));
    const viewport = { width: 868, height: 400 };
    const rec = scrollRecorder(s, viewport);
    let tree = await rec.settle();
    const heightBefore = measure(tree).world.height;
    const parentBefore = boxOf(tree, /^Q7 /);
    const z1Before = boxOf(tree, /^Q8 /);
    await select(s, /^Q7 Which second factor is offered\?, /);
    tree = await rec.settle();
    const m = measure(tree);
    // The labels: one per condition, clear of everything.
    for (const o of OPTIONS) expect(m.labels.filter((l) => l.name.includes(o.slice(0, 24))).length, `one label for "${o}"`).toBe(1);
    expect(problems(m)).toEqual([]);
    // The room: the world grew, and the parent and Block 4 moved down with the lanes above them.
    const parentNow = boxOf(tree, /^Q7 /);
    expect(m.world.height, "the world grew to hold the labels").toBeGreaterThan(heightBefore);
    expect(parentNow.top, "the parent moved down with the grown lanes").toBeGreaterThan(parentBefore.top);
    expect(boxOf(tree, /^Q8 /).top - z1Before.top, "Block 4 moved by the same room").toBe(parentNow.top - parentBefore.top);
    // Centred where it now is (clamped to the scrollable extent).
    const maxY = Math.max(0, m.world.height - viewport.height);
    const want = Math.max(0, Math.min((parentNow.top + parentNow.bottom) / 2 - viewport.height / 2, maxY));
    expect(Math.abs(rec.pos.y - want), `scrolled to ${rec.pos.y}, the moved parent centres at ${want}`).toBeLessThanOrEqual(1);
    // Clear gives the room back.
    await press(one(controls(s.render(), /^Clear$/), "Clear"));
    tree = await rec.settle();
    expect(measure(tree).labels, "no labels without a selection").toEqual([]);
    expect(measure(tree).world.height, "the room is given back").toBe(heightBefore);
    expect(boxOf(tree, /^Q7 /).top, "the parent is back in place").toBe(parentBefore.top);
    // Selected again, Go to open Block 4 brings Block 4's first question into view at its moved place.
    await select(s, /^Q7 Which second factor is offered\?, /);
    await rec.settle();
    await press(one(controls(s.render(), /^Go to open Block 4$/), "Go to open Block 4"));
    tree = await rec.settle();
    const z = boxOf(tree, /^Q8 /);
    expect(z.bottom > rec.pos.y && z.top < rec.pos.y + viewport.height, `Q8 [${z.top}–${z.bottom}] in view [${rec.pos.y}–${rec.pos.y + viewport.height}]`).toBe(true);
    expect(problems(measure(tree))).toEqual([]);
  });

  it("the label layout is deterministic: the same selection twice draws the same labels at the same places", async () => {
    current = { view: buildSessionView(grownAbove(), 1, MAP_SESSION) };
    const s = await openScreen();
    await press(one(controls(await openMenu(s), /^(✓ )?Map$/), "Map item"));
    await select(s, /^Q7 Which second factor is offered\?, /);
    const first = canonicalJsonOf(measure(s.render()));
    await press(one(controls(s.render(), /^Clear$/), "Clear"));
    await select(s, /^Q7 Which second factor is offered\?, /);
    expect(canonicalJsonOf(measure(s.render()))).toBe(first);
  });

  it("a child selected shows its own condition, inside the world and clear of every node", async () => {
    const s = await openWith();
    await select(s, /^Q5 Child 4, /);
    const m = measure(s.render());
    expect(m.labels.map((l) => l.name)).toEqual([`when ${OPTIONS[3]}`]);
    expect(problems(m)).toEqual([]);
  });
});

// ---- Review-driven guards ----
describe("cancel decision from a card", () => {
  it("needs a non-empty reason and a second confirming press; one decision.cancel carries the trimmed reason", async () => {
    const s = await openScreen();
    await press(one(controls(cardOf(s.render(), `Q3 ${Q3}`), /^More\b/), "More"));
    await press(one(controls(s.render(), /^Cancel decision$/), "the More item"));
    const button = () => one(controls(s.render(), /^(Confirm cancel decision|Cancel decision)$/).filter((el) => el.from === "ActionButton" || nameOf(el) === "Pressable"), "the cancel button");
    expect(isDisabled(button()), "a blank reason keeps it disabled").toBe(true);
    one(inputs(s.render(), /^Cancellation reason$/), "reason").props.onChangeText("   ");
    await flush();
    expect(isDisabled(button()), "spaces only are blank").toBe(true);
    one(inputs(s.render(), /^Cancellation reason$/), "reason").props.onChangeText("  Dropped from scope  ");
    await flush();
    await press(button());
    expect(calls("decision.cancel"), "the first press only asks for confirmation").toEqual([]);
    expect(labelOf(button())).toBe("Confirm cancel decision");
    await press(button());
    expect(calls("decision.cancel").map((c) => c.input)).toEqual([{ projectId: P, expectedRevision: 7, sessionId: "S", questionId: "q3", reason: "Dropped from scope" }]);
  });

  it("editing the reason after the first press asks for confirmation again", async () => {
    const s = await openScreen();
    await press(one(controls(cardOf(s.render(), `Q3 ${Q3}`), /^More\b/), "More"));
    await press(one(controls(s.render(), /^Cancel decision$/), "the More item"));
    one(inputs(s.render(), /^Cancellation reason$/), "reason").props.onChangeText("Dropped");
    await flush();
    await press(one(enabledControls(s.render(), /^Cancel decision$/).filter((el) => el.from === "ActionButton" || nameOf(el) === "Pressable"), "first press"));
    one(inputs(s.render(), /^Cancellation reason$/), "reason").props.onChangeText("Dropped for now");
    await flush();
    expect(controls(s.render(), /^Confirm cancel decision$/)).toEqual([]);
    expect(calls("decision.cancel")).toEqual([]);
  });
});

describe("the reverse finish direction", () => {
  it("while the confirmed manual Finish is pending, Accept finish proposal is disabled", async () => {
    const SUMMARY = "All decided.";
    current = {
      view: sessionView({
        session: { finishProposal: { at: PROPOSED_AT, agentId: PLANNER, summary: SUMMARY, skipped: [], outOfScope: [] } },
        grilling: { finishProposal: { at: PROPOSED_AT, summary: SUMMARY, skipped: [], outOfScope: [] } },
      }),
    };
    h.state.answers["session.finish"] = () => new Promise(() => undefined);
    const s = await openScreen();
    await press(one(enabledControls(await openMenu(s), /^Finish discussion…$/), "Finish discussion…"));
    one(enabledControls(s.render(), /^Finish discussion$/), "confirm").props.onPress();
    await flush();
    await press(navItem(s.render(), /^Finish proposal/));
    const accept = one(controls(s.render(), /^Accept finish proposal$/), "Accept finish proposal");
    expect(isDisabled(accept)).toBe(true);
    if (!isDisabled(accept)) await press(accept);
    expect(calls("session.finish").map((c) => c.input.basis)).toEqual(["manual"]);
  });
});

describe("the planner picker keeps the canvas visible", () => {
  it("the picker sits in a vertical scroll region of bounded height, not in the non-shrinking header alone", async () => {
    const s = await openScreen();
    await press(one(controls(await openMenu(s), /^Change chat…$/), "Change chat…"));
    const tree = s.render();
    const chain: Node[] = [];
    const walk = (n: unknown, path: Node[]): boolean => {
      if (Array.isArray(n)) return n.some((x) => walk(x, path));
      if (!n || typeof n !== "object") return false;
      const el = n as Node;
      if (!el.props || isClosedModal(el)) return false;
      if (el.from === "PlannerPicker") {
        chain.push(...path);
        return true;
      }
      return walk(el.props.children, [...path, el]);
    };
    expect(walk(tree, []), "the picker is shown").toBe(true);
    const flatStyle = (el: El) => Object.assign({}, ...[el.props.style].flat(Infinity).filter(Boolean));
    const scrolls = chain.filter((el) => ["ScrollView", "RNScrollView"].includes(nameOf(el)) && el.props.horizontal !== true);
    const bounded = scrolls.filter((el) => typeof flatStyle(el).maxHeight === "number" || (flatStyle(el).flex === 1 && flatStyle(el).minHeight === 0));
    expect(bounded.length, "a bounded vertical scroll region holds the candidate list").toBeGreaterThan(0);
  });
});

// ---- Map review regressions: Find in List, centring at the drawn scale, Fit, status words, work per render ----
describe("the Map after review", () => {
  async function openMap() {
    const s = await openScreen();
    await press(one(controls(await openMenu(s), /^(✓ )?Map$/), "Map item"));
    return s;
  }
  const nodeControls = (tree: unknown) => controls(tree, /^Q\d+ .*, Block \d+, \d+ incoming, \d+ outgoing$/);
  const VIEWPORT = { width: 200, height: 100 };
  /** Records the world's scroll calls and gives it a measured viewport. */
  function instrument(tree: unknown) {
    const xs: number[] = [];
    const ys: number[] = [];
    const vertical = one(all(tree, (el) => nameOf(el) === "ScrollView" && typeof el.props.onLayout === "function" && el.props.ref != null), "the world's vertical scroll");
    const horizontal = one(all(vertical, (el) => nameOf(el) === "RNScrollView" && el.props.horizontal === true && el.props.ref != null), "the world's horizontal scroll");
    vertical.props.ref.current = { scrollTo: (o: { y: number }) => void ys.push(o.y) };
    horizontal.props.ref.current = { scrollTo: (o: { x: number }) => void xs.push(o.x) };
    vertical.props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, ...VIEWPORT } } });
    return { xs, ys };
  }
  /** The scroll that centres question `id` when the world is drawn at scale 1, clamped as the view clamps. */
  async function centredAt1(id: string) {
    const layout = (await import(/* @vite-ignore */ String("./map-layout"))) as { mapModel: (v: unknown, o: unknown) => any };
    const m = layout.mapModel(current.view, { showInactive: true });
    const n = m.nodes.find((x: any) => x.questionId === id);
    const clamp = (v: number, max: number) => Math.max(0, Math.min(v, Math.max(0, max)));
    return { x: clamp(n.x + n.width / 2 - VIEWPORT.width / 2, m.world.width - VIEWPORT.width), y: clamp(n.y + n.height / 2 - VIEWPORT.height / 2, m.world.height - VIEWPORT.height) };
  }

  it("Find question works from the List: the picker opens there and a pick shows the question on the graph", async () => {
    const s = await openMap();
    await press(one(controls(s.render(), /^List$/), "List"));
    await press(one(controls(s.render(), /Find question/), "Find question"));
    const rows = controls(s.render(), /^Find Q\d+ /);
    expect(rows.length, "the picker lists the questions in List mode").toBeGreaterThan(0);
    await press(one(rows.filter((el) => labelOf(el).startsWith("Find Q4 ")), "Find Q4"));
    const t = s.render();
    expect(nodeControls(t).length, "back on the graph").toBeGreaterThan(0);
    expect(visibleText(t)).toMatch(/Comes after/);
  });

  it("a pick from the overview centres the question at the scale the world is drawn at after zooming in", async () => {
    const s = await openMap();
    await press(one(controls(s.render(), /^Zoom out$/), "Zoom out"));
    await press(one(controls(s.render(), /^Zoom out$/), "Zoom out"));
    const rec = instrument(s.render());
    await press(one(controls(s.render(), /Find question/), "Find question"));
    await press(one(controls(s.render(), /^Find Q4 /), "Find Q4"));
    s.render();
    const want = await centredAt1("q4");
    expect(rec.xs.at(-1)).toBe(want.x);
    expect(rec.ys.at(-1)).toBe(want.y);
  });

  it("a List row shows its question on the graph centred, not at the top-left corner", async () => {
    const s = await openMap();
    const rec = instrument(s.render());
    await press(one(controls(s.render(), /^List$/), "List"));
    await press(one(controls(s.render(), /^Show Q4 .* on the map$/), "Show Q4 on the map"));
    s.render();
    const want = await centredAt1("q4");
    expect(rec.xs.at(-1)).toBe(want.x);
    expect(rec.ys.at(-1)).toBe(want.y);
  });

  it("Fit is an overview: nodes are not pressable and the overview line shows", async () => {
    const s = await openMap();
    await press(one(controls(s.render(), /^Fit$/), "Fit"));
    const t = s.render();
    expect(visibleText(t)).toMatch(/Overview/);
    expect(nodeControls(t).filter((el) => !isDisabled(el))).toEqual([]);
  });

  // DeepSeek Flash review 01a1c6ee c0012: the Map's detail prints "No answer yet." when the question
  // has no current answer (client/map-view.tsx, answerText), which is also the case for a settled
  // question: skipped or out of scope, with or without an earlier answer. The card says what is true
  // (its status, and that an earlier answer is kept as history); the detail must not say the question
  // is still waiting for an answer.
  it.each([
    ["out of scope, with an earlier answer", "out_of_scope", true],
    ["skipped, with an earlier answer", "skipped", true],
    ["skipped, never answered", "skipped", false],
  ] as const)("the detail of a question %s does not say \"No answer yet.\"", async (_name, validity, hadAnswer) => {
    const v = sessionView();
    v.questions = v.questions.map((x: any) =>
      x.question.id === "q4" ? { ...x, question: { ...x.question, validity, ...(hadAnswer ? {} : { answer: undefined }) }, status: validity } : x,
    );
    current = { view: v };
    const s = await openMap();
    await press(one(nodeControls(s.render()).filter((el) => labelOf(el).startsWith("Q4 ")), "node Q4"));
    const detail = all(s.render(), (el) => /Comes after/.test(textOf(el)) && /Leads to/.test(textOf(el)) && /Open (Q4 )?in Grilling/.test(textOf(el))).map((el) => textOf(el)).sort((a, b) => a.length - b.length)[0];
    expect(detail, "the detail opened").toBeDefined();
    expect(detail).toMatch(validity === "skipped" ? /skipped/i : /out of scope/i);
    expect(detail, "a settled question is not waiting for an answer").not.toMatch(/No answer yet/);
  });

  it("an out-of-scope question's status is written in words on the node, the detail and the List", async () => {
    const v = sessionView();
    v.questions = v.questions.map((x: any) => (x.question.id === "q4" ? { ...x, question: { ...x.question, validity: "out_of_scope" }, status: "out_of_scope" } : x));
    current = { view: v };
    const s = await openMap();
    await press(one(nodeControls(s.render()).filter((el) => labelOf(el).startsWith("Q4 ")), "node Q4"));
    let text = visibleText(s.render());
    expect(text).toMatch(/out of scope/i);
    expect(text).not.toContain("out_of_scope");
    // DeepSeek Flash review 01a1c67a c0033: the node's own label already says "out of scope", so the
    // detail itself must open and say it.
    const detailText = all(s.render(), (el) => /Comes after/.test(textOf(el)) && /Leads to/.test(textOf(el)) && /Open (Q4 )?in Grilling/.test(textOf(el))).map((el) => textOf(el)).sort((a, b) => a.length - b.length)[0];
    expect(detailText, "the detail opened").toBeDefined();
    expect(detailText, "the detail writes the status in words").toMatch(/out of scope/i);
    await press(one(controls(s.render(), /^List$/), "List"));
    text = visibleText(s.render());
    expect(text).not.toContain("out_of_scope");
  });

  it("a cancelled decision's node is struck through; the others are not", async () => {
    current = { view: { ...sessionView(), cancellations: [{ id: "c-q3", ref: ref("q3"), reason: "Dropped", at: AT, actor: { kind: "human" } }] } };
    const t = (await openMap()).render();
    const struck = (n: number) =>
      all(one(nodeControls(t).filter((el) => labelOf(el).startsWith(`Q${n} `)), `node Q${n}`), (el) => nameOf(el) === "Text").some(
        (el) => Object.assign({}, ...[el.props.style].flat(Infinity).filter(Boolean)).textDecorationLine === "line-through",
      );
    expect(struck(3)).toBe(true);
    expect(struck(4)).toBe(false);
  });

  it("the graph does not derive every question's relation list while the List is hidden", async () => {
    const s = await openMap();
    h.state.relationCalls = 0;
    s.render();
    expect(h.state.relationCalls, "relationLinks calls in one graph render with nothing selected").toBe(0);
  });
});

// ---- Accessibility props on React Native Web ----
// RN Web in the host maps aria-* props to the DOM; accessibilityState alone produced no
// aria-checked, aria-expanded or aria-selected there, and the host's own controls pass aria-* props.
describe("W7: accessibility props reach the web", () => {
  const aria = (el: El, name: string) => el.props[name];

  it("the Chat trigger states expanded, and the Grilling and Map items state checked", async () => {
    const s = await openScreen();
    expect(aria(trigger(s.render()), "aria-expanded"), "closed").toBe(false);
    const t = await openMenu(s);
    expect(aria(trigger(t), "aria-expanded"), "open").toBe(true);
    expect(aria(one(controls(t, /^(✓ )?Grilling$/), "Grilling"), "aria-checked")).toBe(true);
    expect(aria(one(controls(t, /^(✓ )?Map$/), "Map"), "aria-checked")).toBe(false);
  });

  it("the selected block card states selected (or current)", async () => {
    const t = (await openScreen()).render();
    const state = (el: El) => aria(el, "aria-selected") === true || (aria(el, "aria-current") !== undefined && aria(el, "aria-current") !== false);
    expect(state(navItem(t, /^Block 2\b/)), "the open block is selected").toBe(true);
    expect(state(navItem(t, /^Block 1\b/))).toBe(false);
  });

  // DeepSeek Flash review 01a1c8d3 c0152: a Map node is a button (it toggles its selection), and WAI-ARIA
  // does not allow aria-selected on the button role, so assistive technology does not announce it. The
  // selected state must reach the web through an attribute its role supports: aria-pressed for a
  // button, as ActionButton does, or aria-selected with a role that takes it.
  // DeepSeek Flash review 01a1c8d3 c0155: the Retry item's state wording ("Nothing to retry", "Sent at
  // …", "Delivery unknown since …: check the chat", the interruption warning) is drawn in the item, but
  // its accessible name is the label "Retry" and the wording is passed only as accessibilityHint, which
  // React Native Web drops (SPEC: the host keeps aria-describedby). The wording must reach the web: in
  // the item's label, or through aria-describedby naming a drawn element (nativeID) that holds it.
  it("the Retry item's state wording reaches the web, in its label or a description", async () => {
    for (const [view, wording] of [
      [() => sessionView(), /Nothing to retry/],
      [() => sessionView({ grilling: { status: "needs_manual", manualRecovery: true, retryCount: 1, lastRetry: { id: "r1", at: PROPOSED_AT, state: "unknown" } } }), /Delivery unknown since/],
    ] as const) {
      current = { view: view() };
      const s = await openScreen();
      const t = await openMenu(s);
      const retry = one(controls(t, /^Retry\b/), "the Retry item");
      const describedBy = retry.props["aria-describedby"] as string | undefined;
      const described = describedBy === undefined ? [] : all(t, (el) => el.props.nativeID === describedBy || el.props.id === describedBy);
      const web = [String(retry.props["aria-label"] ?? retry.props.accessibilityLabel ?? ""), ...described.map((el) => textOf(el))].join(" ");
      expect(web, `${String(wording)}: what the web announces for the item`).toMatch(wording);
      if (describedBy !== undefined) expect(described.length, `exactly one drawn element has the id ${describedBy}`).toBe(1);
    }
  });

  it("a Map node states its selection with an attribute its role supports", async () => {
    const s = await openScreen();
    await press(one(controls(await openMenu(s), /^(✓ )?Map$/), "Map item"));
    for (let i = 0; i < 6 && !/\b100\s?%/.test(visibleText(s.render())); i++) {
      const zoomIn = controls(s.render(), /^Zoom in$/);
      if (zoomIn.length === 0 || isDisabled(zoomIn[0])) break;
      await press(zoomIn[0]);
    }
    const nodeOf = (n: number) => one(controls(s.render(), new RegExp(`^Q${n} .*, Block \\d+, \\d+ incoming, \\d+ outgoing$`)), `node Q${n}`);
    await press(nodeOf(3));
    const SELECTABLE_ROLES = ["option", "tab", "row", "gridcell", "treeitem"];
    const webState = (el: El) => {
      const role = String(el.props.role ?? el.props.accessibilityRole ?? "");
      if (role === "button") return el.props["aria-pressed"];
      if (SELECTABLE_ROLES.includes(role)) return el.props["aria-selected"];
      return undefined;
    };
    expect(webState(nodeOf(3)), "the selected node: true through a role-valid attribute").toBe(true);
    expect(webState(nodeOf(1)), "another node: false through the same attribute").toBe(false);
  });

  it("Description and the card's Edit state expanded", async () => {
    const s = await openScreen();
    await selectBlock(s, 1);
    let card = cardOf(s.render(), `Q1 ${Q1}`);
    const desc = one(controls(card, /^Description$/), "Description");
    expect(aria(desc, "aria-expanded")).toBe(false);
    await press(desc);
    card = cardOf(s.render(), `Q1 ${Q1}`);
    expect(aria(one(controls(card, /^Description$/), "Description"), "aria-expanded")).toBe(true);
    const edit = one(controls(card, /^Edit$/), "Edit");
    expect(aria(edit, "aria-expanded")).toBe(false);
    await press(edit);
    card = cardOf(s.render(), `Q1 ${Q1}`);
    const toggle = controls(card, /^(Edit|Cancel)$/).find((el) => aria(el, "aria-expanded") !== undefined);
    expect(toggle && aria(toggle, "aria-expanded"), "the toggle states expanded while the panel is open").toBe(true);
  });
});

describe("W7: the card's Edit turns into Cancel, as in the template", () => {
  it("while the answer panel is open the toggle reads Cancel and closes it; no Edit control remains on the card", async () => {
    const s = await openScreen();
    await press(one(controls(cardOf(s.render(), `Q3 ${Q3}`), /^Edit$/), "Edit"));
    let card = cardOf(s.render(), `Q3 ${Q3}`);
    expect(controls(card, /^Edit$/), "Edit is replaced while editing").toEqual([]);
    const toggles = controls(card, /^Cancel$/).filter((el) => el.props["aria-expanded"] === true);
    await press(one(toggles, "the Cancel toggle"));
    card = cardOf(s.render(), `Q3 ${Q3}`);
    expect(controls(card, /^Edit$/).length).toBe(1);
    expect(textOf(card)).not.toContain("Long-lived session");
    expect(writes()).toEqual([]);
  });
});

describe("W7: text inputs keep a 44 px target", () => {
  const minHeight = (el: El) => {
    const st = Object.assign({}, ...[el.props.style].flat(Infinity).filter(Boolean));
    return Math.max(st.minHeight ?? 0, st.height ?? 0);
  };

  it("the add form's fields and the answer panel's note and free text are at least 44 px tall", async () => {
    const s = await openScreen();
    await openAddForm(s);
    for (const field of [QUESTION_FIELD, ANSWER_FIELD]) expect(minHeight(one(inputs(s.render(), field), String(field))), String(field)).toBeGreaterThanOrEqual(44);
    await press(controls(s.render(), /^Cancel$/)[0]);
    await selectBlock(s, 1);
    await press(one(controls(cardOf(s.render(), `Q2 ${Q2}`), /^Edit$/), "Edit"));
    for (const label of [/^Answer note$/, /^Free-text answer$/]) expect(minHeight(one(inputs(s.render(), label), String(label))), String(label)).toBeGreaterThanOrEqual(44);
  });
});

describe("W7: closing the add form returns focus to its row", () => {
  for (const how of ["Escape", "Cancel"] as const) {
    it(`${how} closes the form and focuses "Add question to Block 2"`, async () => {
      const s = await openScreen();
      const row = one(controls(s.render(), /^Add question to Block 2$/), "the add row");
      const ref: unknown = row.props.ref;
      expect(typeof ref === "object" && ref !== null && "current" in ref, "the row carries a ref").toBe(true);
      let focused = 0;
      (ref as { current: unknown }).current = { focus: () => void focused++ };
      await press(row);
      await type(s, QUESTION_FIELD, "Draft that is thrown away");
      if (how === "Escape") one(inputs(s.render(), QUESTION_FIELD), "question").props.onKeyPress?.({ nativeEvent: { key: "Escape" }, preventDefault: () => undefined });
      else await press(controls(s.render(), /^Cancel$/)[0]);
      await flush();
      s.render();
      expect(inputs(s.render(), QUESTION_FIELD), "the form closed").toEqual([]);
      expect(focused, "focus returned to the row").toBe(1);
      expect(writes()).toEqual([]);
    });
  }
});

describe("W7: the Finish confirmation names itself once", () => {
  it("the dialog's content does not repeat the Modal title as a heading", async () => {
    const s = await openScreen();
    await press(one(enabledControls(await openMenu(s), /^Finish discussion…$/), "Finish discussion…"));
    const modal = one(all(s.render(), (el) => nameOf(el) === "Modal" && el.props.open !== false && /Finish discussion/.test(String(el.props.title ?? ""))), "the Finish dialog");
    const headings = all(modal, (el) => nameOf(el) === "Text" && textOf(el).trim() === "Finish discussion" && !all(el, (x) => typeof handlerOf(x) === "function").length);
    const insideButtons = new Set(controls(modal, /^Finish discussion$/).flatMap((b) => all(b)));
    expect(headings.filter((el) => !insideButtons.has(el)), "no second 'Finish discussion' heading").toEqual([]);
  });
});

describe("W7: Open chat leaves the plugin's screen as it is", () => {
  it("calls the host's openAgent once and neither writes nor changes the session screen", async () => {
    const s = await openScreen();
    await selectBlock(s, 1);
    await press(one(controls(s.render(), /^Open chat$/), "Open chat"));
    expect(s.opened).toEqual([PLANNER]);
    const t = s.render();
    expect(visibleText(t)).toContain("Session S");
    expect(selected(navItem(t, /^Block 1\b/)), "the plugin keeps its own state; a reset on the host is a remount").toBe(true);
    expect(writes()).toEqual([]);
  });
});

// Host check of 28ef13c (docs/reviews/2026-11-10-r7-57c036e-audit-host.md, RN Web 0.15.3, Chrome 157):
// the tooltip bubbles of Zoom in (Map toolbar) and Summary (block header) were 32–66 px wide, a word per
// line, and painted under the controls and text after them; on a touch screen a tap left the tooltip
// shown, because the browser focuses the button after the release and onFocus shows it again.
//
// What is modelled, and what is not:
// - STRUCTURE, not geometry. Nothing here measures a box. The cases read the declared styles and the
//   tree, and apply two rules that React Native Web and React Native (Yoga) share:
//   1. Width: an absolutely positioned box with no width of its own (no `width`, no `minWidth`) is laid
//      out in its containing block, its parent View (RN Web gives every View `position: relative`; Yoga
//      always uses the parent), so text inside it wraps at that parent's width. A parent that only wraps
//      the 44 px control (`alignSelf: "flex-start"`) is 44 px wide.
//   2. Stacking: two elements are ordered where their branches meet. At the nearest common parent, the
//      child holding each one is compared by `zIndex` (absent = 0: RN Web gives every View `z-index: 0`,
//      so each View is a stacking context, and a `zIndex` deeper inside one does not lift it above that
//      View's later siblings; native orders siblings by `zIndex` within one parent), then by order (later
//      paints over earlier). Content in an open host Modal is a layer above the screen.
//   A tooltip may overlap whatever it is drawn over, and where it lands is geometry these cases do not
//   compute, so they ask for the bubble above every control and text drawn after its control.
// - Focus: React Native Web's Pressable passes the DOM focus event to onFocus (after checking that its
//   target is the control's own node) and does not report hover for touch pointers (useHover skips
//   pointerType "touch"). After a tap, Chrome sends pointerup, touchend, mouseover and then focus to the
//   button (the host log). An implementation can tell that focus from a keyboard's by what RN Web and the
//   DOM expose: the press that came first (its nativeEvent has pointerType "touch"), or the node's
//   `matches(":focus-visible")`, which these fakes answer as Chrome does (false after a tap, true for
//   keyboard focus). React Native on a device does not focus a control on a tap, so nothing is
//   modelled for it.
describe("tooltips on the host: bubble width, stacking, and the focus a tap leaves", () => {
  type Trail = Node[];
  /** The elements from the root down to `target` (same object), or null. */
  function trail(root: unknown, target: unknown): Trail | null {
    const walk = (n: unknown, up: Node[]): Trail | null => {
      if (n === null || typeof n !== "object") return null;
      if (Array.isArray(n)) {
        for (const c of n) {
          const r = walk(c, up);
          if (r) return r;
        }
        return null;
      }
      const el = n as Node;
      if (!el.props) return null;
      const here = [...up, el];
      if (el === target) return here;
      return walk(el.props.children, here);
    };
    return walk(root, []);
  }
  const styleOf = (el: El): Record<string, any> => Object.assign({}, ...[el.props.style].flat(Infinity).filter(Boolean));
  const isOpenModal = (el: El) => nameOf(el) === "Modal" && el.props.open !== false && el.props.visible !== false;
  /**
   * A Fragment (a symbol type) draws nothing and forms no stacking context: its children are children
   * of its parent (review of e587ca9: the Map toolbar's zoom buttons sit in one).
   */
  const host = (path: Trail) => path.filter((el) => typeof el.type !== "symbol");
  /** Rule 2: whether `a` paints over `b` in the same rendered tree. */
  function paintsOver(root: unknown, a: El, b: El): boolean {
    const ta = trail(root, a);
    const tb = trail(root, b);
    if (ta === null || tb === null) throw new Error("not in the tree");
    const pa = host(ta);
    const pb = host(tb);
    let i = 0;
    while (i < pa.length && i < pb.length && pa[i] === pb[i]) i++;
    const modalA = pa.slice(i).some(isOpenModal);
    const modalB = pb.slice(i).some(isOpenModal);
    if (modalA !== modalB) return modalA;
    if (i === pb.length) return true; // b is an ancestor of a
    if (i === pa.length) return false;
    const ca = pa[i];
    const cb = pb[i];
    const za = Number(styleOf(ca).zIndex ?? 0);
    const zb = Number(styleOf(cb).zIndex ?? 0);
    if (za !== zb) return za > zb;
    // Equal: the later one in document order paints over (siblings under the same parent, Fragments flattened).
    const order = all(root);
    return order.indexOf(ca) > order.indexOf(cb);
  }
  /** The shown bubble of `hint`: the nearest absolutely positioned element holding its text, else the text's parent. */
  function bubbleOf(root: unknown, hint: string): { bubble: Node; path: Trail } {
    const text = one(all(root, (el) => nameOf(el) === "Text" && textOf(el) === hint), `the shown tooltip "${hint}"`);
    const path = trail(root, text)!;
    const k = [...path].reverse().findIndex((el) => styleOf(el).position === "absolute");
    const at = k === -1 ? path.length - 2 : path.length - 1 - k;
    return { bubble: path[at], path: path.slice(0, at + 1) };
  }
  /** Rule 1: the width the bubble's text wraps at, from declared styles; null when nothing in the tree bounds it. */
  function wrapWidth(path: Trail, control: El): { width: number | null; why: string } {
    const bubble = path[path.length - 1];
    const own = styleOf(bubble);
    const declared = typeof own.width === "number" ? own.width : typeof own.minWidth === "number" ? own.minWidth : null;
    if (declared !== null) return { width: declared, why: `its own ${typeof own.width === "number" ? "width" : "minWidth"}` };
    if (own.position !== "absolute") return { width: null, why: "in flow" };
    const parent = path[path.length - 2];
    const ps = styleOf(parent);
    if (typeof ps.width === "number") return { width: ps.width, why: "its parent's width" };
    const holdsControl = trail(parent, control) !== null;
    if (holdsControl && ps.alignSelf === "flex-start") {
      const cs = styleOf(control);
      return { width: Number(cs.width ?? cs.minWidth ?? 44), why: "its parent, which only wraps the control" };
    }
    return { width: null, why: "a parent not sized by the control" };
  }
  /** About 6.6 px a character at the bubble's 12 px text, plus its padding: a text-only estimate, not a measurement. */
  const needed = (hint: string) => Math.min(120, Math.round(hint.length * 6.6) + 16);
  /**
   * Everything drawn after the control: other controls and texts, except the control's own subtree and
   * the bubble's. (Before the review of e587ca9 the exclusion was the lowest element holding both, which
   * for a bubble in a screen-level overlay is the whole screen, so such a design found nothing to
   * compare and failed on that alone.)
   */
  function drawnAfter(root: unknown, control: El, bubble: El): El[] {
    const order = all(root);
    const from = order.indexOf(control);
    const own = new Set([...all(control), ...all(bubble)]);
    if (from === -1) throw new Error("the control is not in the tree");
    const drawn = (el: El) => typeof handlerOf(el) === "function" || (nameOf(el) === "Text" && textOf(el) !== "");
    return order.slice(from + 1).filter((el) => !own.has(el) && drawn(el));
  }
  /**
   * Non-blocking: the bubble's own branch (below the lowest element it shares with its control) takes no
   * touches, so the layer never stops a press on what it is drawn over. In React Native (web and native)
   * `pointerEvents: "none"` on a view takes its whole subtree out of hit testing, and "box-none" only
   * the view itself; the branch must reach a "none" passing only "box-none" (or "none") views on the
   * way. An open Modal on the branch blocks the screen behind it, whatever its content does.
   */
  function blockingOf(root: unknown, bubble: El, control: El): string | null {
    const tb = host(trail(root, bubble)!);
    const tc = host(trail(root, control)!);
    let i = 0;
    while (i < tb.length && i < tc.length && tb[i] === tc[i]) i++;
    for (const el of tb.slice(i)) {
      if (isOpenModal(el)) return "an open Modal, which blocks the screen behind it";
      const pe = el.props.pointerEvents ?? styleOf(el).pointerEvents;
      if (pe === "none") return null;
      if (pe !== "box-none") return `a ${nameOf(el) || "view"} on the bubble's branch takes touches (pointerEvents ${String(pe ?? "auto")})`;
    }
    return "the bubble itself takes touches";
  }
  /** The shared check of a shown bubble: what is drawn over it, and whether its layer blocks presses. */
  function stacking(root: unknown, hint: string, control: El) {
    const { bubble } = bubbleOf(root, hint);
    const later = drawnAfter(root, control, bubble);
    const under = later.filter((el) => !paintsOver(root, bubble, el)).map((el) => labelOf(el) || textOf(el)).filter((x) => x !== "");
    return { later: later.length, under, blocking: blockingOf(root, bubble, control) };
  }

  // Fakes for what React Native Web hands to the handlers.
  const node = (keyboard: boolean) => ({ matches: (sel: string) => (sel === ":focus-visible" ? keyboard : false), focus: () => undefined, blur: () => undefined });
  const pressEvent = (n: unknown, type: string) => ({ nativeEvent: { type, pointerType: "touch", target: n, touches: type === "pointerdown" ? [{ pageX: 10, pageY: 10 }] : [], changedTouches: [{ pageX: 10, pageY: 10 }] }, preventDefault: () => undefined, stopPropagation: () => undefined });
  const focusEvent = (n: unknown) => ({ nativeEvent: { type: "focus", target: n }, target: n, currentTarget: n });
  /** Gives the control a node through its own ref, as React Native Web attaches the DOM button. */
  const attach = (control: El, n: unknown) => {
    const ref = control.props.ref;
    if (typeof ref === "function") ref(n);
    else if (ref && typeof ref === "object") ref.current = n;
  };
  /** A tap as RN Web delivers it on a touch screen, then the browser's focus on the button. */
  async function tap(get: () => El, n: unknown) {
    get().props.onPressIn?.(pressEvent(n, "pointerdown"));
    get().props.onPressOut?.(pressEvent(n, "pointerup"));
    get().props.onPress?.(pressEvent(n, "click"));
    await flush();
    get().props.onFocus?.(focusEvent(n));
    await flush();
  }

  async function mapScreen() {
    const s = await openScreen();
    await press(one(controls(await openMenu(s), /^(✓ )?Map$/), "Map item"));
    return s;
  }
  const ZOOM_IN = "Zoom in one step (50, 75, 100, 125 %)";
  const zoomIn = (s: Screen) => one(controls(s.render(), /^Zoom in$/), "Zoom in");
  const summary = (s: Screen) => one(controls(s.render(), /^Summary$/), "Summary");
  const summaryHint = (s: Screen) => String(summary(s).props.accessibilityHint);
  const PREVIEW = "Synthetic preview of the open block.";
  /** The open Block 2 with a preview, so its Summary button is enabled and opens the preview. */
  async function summaryScreen() {
    current = { view: { ...sessionView(), openBlockPreview: PREVIEW } };
    const s = await openScreen();
    expect(isDisabled(summary(s)), "Block 2's Summary is enabled").toBe(false);
    return s;
  }

  // ---- Width (structural) ----
  for (const [name, open, control, hintOf] of [
    ["Zoom in (Map toolbar)", mapScreen, zoomIn, () => ZOOM_IN],
    ["Summary (block header)", summaryScreen, summary, summaryHint],
  ] as const) {
    it(`${name}: the shown bubble is not wrapped at the 44 px control's width`, async () => {
      const s = await open();
      const hint = hintOf(s);
      control(s).props.onHoverIn?.({});
      await flush();
      const t = s.render();
      const { path } = bubbleOf(t, hint);
      const w = wrapWidth(path, one(controls(t, name.startsWith("Zoom") ? /^Zoom in$/ : /^Summary$/), "the control"));
      if (w.width === null) return; // bounded by nothing derived from the control
      expect(w.width, `the text wraps at ${w.width} px (${w.why}); "${hint}" needs about ${needed(hint)} px`).toBeGreaterThanOrEqual(needed(hint));
    });

    it(`${name}: the shown bubble paints over the controls and text drawn after its control`, async () => {
      const s = await open();
      const hint = hintOf(s);
      control(s).props.onHoverIn?.({});
      await flush();
      const t = s.render();
      const ctl = one(controls(t, name.startsWith("Zoom") ? /^Zoom in$/ : /^Summary$/), "the control");
      const r = stacking(t, hint, ctl);
      expect(r.later, "there is content after the control").toBeGreaterThan(0);
      expect(r.blocking, "the tooltip's layer takes no touches").toBeNull();
      expect(r.under.slice(0, 8), `drawn over the bubble: ${r.under.length} elements`).toEqual([]);
    });
  }

  // ---- The focus a tap leaves (RN Web) ----
  it("Zoom in: a tap on a touch screen zooms and leaves no tooltip, though the browser focuses the button after it", async () => {
    const s = await mapScreen();
    const n = node(false);
    attach(zoomIn(s), n);
    const before = visibleText(s.render()).match(/\b(\d+)\s?%/)?.[1];
    await tap(() => zoomIn(s), n);
    const t = s.render();
    expect(t && visibleText(t).match(/\b(\d+)\s?%/)?.[1], "the tap zoomed").not.toBe(before);
    expect(visibleText(t), "no tooltip after the tap").not.toContain(ZOOM_IN);
  });

  it("Zoom in: a long press shows the tooltip; after the release and the browser's focus it is gone", async () => {
    const s = await mapScreen();
    const n = node(false);
    attach(zoomIn(s), n);
    zoomIn(s).props.onPressIn?.(pressEvent(n, "pointerdown"));
    zoomIn(s).props.onLongPress?.(pressEvent(n, "pointerdown"));
    await flush();
    expect(visibleText(s.render()), "a long press shows it").toContain(ZOOM_IN);
    zoomIn(s).props.onPressOut?.(pressEvent(n, "pointerup"));
    await flush();
    zoomIn(s).props.onFocus?.(focusEvent(n));
    await flush();
    expect(visibleText(s.render()), "gone after the release").not.toContain(ZOOM_IN);
  });

  // On the host the summary then opens and moves focus into itself, which blurs the button and would
  // hide the tooltip anyway; the harness does not move focus, so this case looks at the moment of the
  // tap's focus, which is the rule under test, and again after Close.
  it("Summary: the focus a tap leaves does not show the tooltip, before or after the summary closes", async () => {
    const s = await summaryScreen();
    const hint = summaryHint(s);
    const n = node(false);
    attach(summary(s), n);
    await tap(() => summary(s), n);
    expect(visibleText(s.render()), "the tap opened the block summary").toContain(PREVIEW);
    expect(visibleText(s.render()), "no tooltip from the tap's focus").not.toContain(hint);
    await press(one(controls(s.render(), /^(Close|Done)$/), "the summary's Close"));
    expect(visibleText(s.render()), "none after Close").not.toContain(hint);
  });

  // ---- Audit of 442226f (the tooltip layer) ----
  // The Summary modal (a host Modal, which the host portals above the panel) holds the icon button
  // Copy ("Copy the summary text"). The layer the bubble is drawn in must be one the Modal does not
  // cover: the panel's layer is under the portalled Modal, so a bubble drawn there is hidden by it.
  it("Copy in the Summary modal: the shown bubble is not under the Modal that holds its control", async () => {
    const s = await summaryScreen();
    await press(summary(s));
    let t = s.render();
    const modal = one(all(t, (el) => isOpenModal(el) && controls(el, /^Copy$/).length > 0), "the open Summary modal");
    const copy = () => one(controls(s.render(), /^Copy$/), "Copy");
    const hint = String(copy().props.accessibilityHint);
    copy().props.onHoverIn?.({});
    await flush();
    t = s.render();
    const { bubble } = bubbleOf(t, hint);
    const modalNow = one(all(t, (el) => isOpenModal(el) && controls(el, /^Copy$/).length > 0), "the open Summary modal");
    expect(modal.props.title, "the same modal").toBe(modalNow.props.title);
    expect(paintsOver(t, bubble, modalNow), "the bubble is drawn over (or inside) the Modal, not under it").toBe(true);
    const r = stacking(t, hint, one(controls(t, /^Copy$/), "Copy"));
    expect(r.blocking).toBeNull();
    expect(r.under, "nothing after Copy is drawn over the bubble").toEqual([]);
  });

  // A bubble in a layer does not move or clip with its control, so after a scroll it is placed again
  // (web: a captured document scroll listener). When the control has scrolled out of the clipping
  // region that holds it (the canvas's registered scroll view), the control is not visible, and its
  // bubble must not be drawn over what lies outside that region (the header above the canvas). Before
  // 442226f the bubble was beside the control, inside the region, and clipped with it.
  // Model: measureInWindow answers from fixed rectangles (panel layer 0,0,1220×847; canvas region
  // 320,140,620×700; Summary 524,192,44×44, then 524,40 after the scroll); the document is a fake that
  // records the captured listeners. Real geometry and Chrome's scroll timing need the host.
  /** Keyboard-shows Summary's tooltip, scrolls Summary to `afterY`, and returns the layer bubbles' tops before and after. */
  async function scrollWhileShown(afterY: number) {
    const listeners: Record<string, Array<() => void>> = {};
    vi.stubGlobal("document", {
      addEventListener: (type: string, fn: () => void) => void (listeners[type] ??= []).push(fn),
      removeEventListener: (type: string, fn: () => void) => void (listeners[type] = (listeners[type] ?? []).filter((f) => f !== fn)),
    });
    try {
      const s = await summaryScreen();
      const box = (r: { x: number; y: number; w: number; h: number }) => ({ measureInWindow: (cb: (x: number, y: number, w: number, h: number) => void) => cb(r.x, r.y, r.w, r.h) });
      const control = { x: 524, y: 192, w: 44, h: 44 };
      const layers = () => all(s.render(), (el) => el.props.pointerEvents === "box-none" && styleOf(el).position === "absolute" && el.props.ref && typeof el.props.ref === "object");
      const region = () => one(all(s.render(), (el) => nameOf(el) === "ScrollView" && el.props.ref && typeof el.props.ref === "object" && controls(el, /^Summary$/).length > 0), "the canvas scroll region");
      const fit = () => {
        for (const l of layers()) l.props.ref.current = box(SCROLL_LAYER);
        region().props.ref.current = box(SCROLL_REGION);
        const n = { ...box(control), matches: (sel: string) => sel === ":focus-visible", focus: () => undefined, blur: () => undefined };
        attach(summary(s), n);
        return n;
      };
      const n = fit();
      const hint = summaryHint(s);
      summary(s).props.onFocus?.(focusEvent(n));
      await flush();
      fit();
      /** The bubbles drawn in a layer (the layer's own absolute children holding the hint), by their top. */
      const bubbleTops = () =>
        layers().flatMap((l) => all(l, (el) => el !== l && styleOf(el).position === "absolute" && all(el, (x) => nameOf(x) === "Text" && textOf(x) === hint).length > 0)).map((el) => Number(styleOf(el).top ?? NaN));
      const before = bubbleTops();
      control.y = afterY;
      fit();
      const scrollListeners = listeners.scroll?.length ?? 0;
      for (const fn of listeners.scroll ?? []) fn();
      await new Promise((r) => setTimeout(r, 40));
      await flush();
      return { before, after: bubbleTops(), scrollListeners };
    } finally {
      vi.unstubAllGlobals();
    }
  }
  const SCROLL_LAYER = { x: 0, y: 0, w: 1220, h: 847 };
  const SCROLL_REGION = { x: 320, y: 140, w: 620, h: 700 };

  // Model: measureInWindow answers from fixed rectangles (panel layer 0,0 1220×847; canvas region
  // 320,140 620×700; Summary 524,192 44×44 before the scroll); the document is a fake that records the
  // captured listeners. Real geometry and Chrome's scroll timing need the host.
  it("a keyboard-shown bubble whose control scrolls out of its region is not drawn outside the region", async () => {
    const r = await scrollWhileShown(40);
    expect(r.before, "before the scroll: in the panel's layer, below Summary (192 + 44 + 4)").toEqual([240]);
    expect(r.scrollListeners, "a scroll listener was registered").toBeGreaterThan(0);
    const outside = r.after.filter((top) => !(top >= SCROLL_REGION.y - SCROLL_LAYER.y && top <= SCROLL_REGION.y + SCROLL_REGION.h - SCROLL_LAYER.y));
    expect(outside, "bubble tops outside the canvas region (the header is above y 140)").toEqual([]);
  });

  // Audit of 16f6d01 (the hide when the control leaves its region): a scroll that keeps the control in
  // the region places the bubble again beside it, it does not hide it; so does one that leaves the
  // control partly in the region (the region's edge at 140, Summary 120–164).
  for (const [label, y] of [
    ["inside the region", 300],
    ["partly inside the region", 120],
  ] as const) {
    it(`a keyboard-shown bubble whose control scrolls but stays ${label} moves with it`, async () => {
      const r = await scrollWhileShown(y);
      expect(r.before).toEqual([240]);
      expect(r.after, `placed again below Summary (${y} + 44 + 4)`).toEqual([y + 48]);
    });
  }

  // Host check of 16f6d01 (docs/reviews/2026-11-10-r7-16f6d01-tooltip-host.md, desktop 1220×847): in the
  // Summary modal, Copy's bubble opened below Copy (675–700) and ran 5 px past the modal's own layer
  // (218–695), where the modal's scroll view clipped it; SPEC says the bubble is kept inside the layer.
  // Model: measureInWindow answers with the host's rectangles (the modal's layer 351,218 518×477; the
  // panel's layer 0,0 1220×847; the canvas region behind the modal 336,192 604×639; Copy 375,627 44×44);
  // the bubble's height is not computed here, so a one-line bubble is taken as 25 px (measured on the
  // host). Where the bubble lands is the layer's style, not a measurement.
  it("Copy near the bottom of the Summary modal: the bubble stays inside the modal's layer", async () => {
    const s = await summaryScreen();
    await press(summary(s));
    const ONE_LINE = 25;
    const box = (r: { x: number; y: number; w: number; h: number }) => ({ measureInWindow: (cb: (x: number, y: number, w: number, h: number) => void) => cb(r.x, r.y, r.w, r.h) });
    const MODAL_LAYER = { x: 351, y: 218, w: 518, h: 477 };
    const PANEL_LAYER = { x: 0, y: 0, w: 1220, h: 847 };
    const isLayer = (el: El) => el.props.pointerEvents === "box-none" && styleOf(el).position === "absolute" && el.props.ref && typeof el.props.ref === "object";
    const modalOf = (t: unknown) => one(all(t, (el) => isOpenModal(el) && controls(el, /^Copy$/).length > 0), "the open Summary modal");
    const fit = () => {
      const t = s.render();
      const inModal = all(modalOf(t), isLayer);
      expect(inModal.length, "the modal has its own layer").toBe(1);
      for (const l of all(t, isLayer)) l.props.ref.current = box(inModal.includes(l) ? MODAL_LAYER : PANEL_LAYER);
      const region = all(t, (el) => nameOf(el) === "ScrollView" && el.props.ref && typeof el.props.ref === "object" && controls(el, /^Summary$/).length > 0);
      for (const r of region) r.props.ref.current = box({ x: 336, y: 192, w: 604, h: 639 });
      attach(one(controls(t, /^Copy$/), "Copy"), { ...box({ x: 375, y: 627, w: 44, h: 44 }), matches: () => false, focus: () => undefined, blur: () => undefined });
    };
    fit();
    const hint = String(one(controls(s.render(), /^Copy$/), "Copy").props.accessibilityHint);
    one(controls(s.render(), /^Copy$/), "Copy").props.onHoverIn?.({});
    await flush();
    fit();
    const t = s.render();
    const layer = one(all(modalOf(t), isLayer), "the modal's layer");
    const placed = all(layer, (el) => el !== layer && styleOf(el).position === "absolute" && all(el, (x) => nameOf(x) === "Text" && textOf(x) === hint).length > 0);
    expect(placed.length, "drawn in the modal's layer").toBe(1);
    const st = styleOf(placed[0]);
    if (typeof st.bottom === "number") {
      // Opened above Copy: its top (at least one line above its bottom edge) is inside the layer.
      expect(MODAL_LAYER.h - st.bottom - ONE_LINE, "above Copy, inside the layer's top").toBeGreaterThanOrEqual(0);
    } else {
      expect(Number(st.top) + ONE_LINE, `below Copy: one line from top ${String(st.top)} must end inside the layer (height ${MODAL_LAYER.h})`).toBeLessThanOrEqual(MODAL_LAYER.h);
    }
  });

  // Audit of c7d0dcf: once drawn, the bubble's own onLayout height decides whether it still fits on its
  // side of the control within the layer (a long hint wraps); a later placement of the same tooltip (a
  // scroll) reuses that height, since a move alone may not report a layout. Model: the host's modal
  // layer frame (or a smaller one), Copy where the estimate (two short lines, 56 px) says "below", and a
  // drawn height delivered through the bubble's onLayout as React Native reports it.
  async function copyWithLayer(opts: { layer: { x: number; y: number; w: number; h: number }; copyY: number }) {
    const listeners: Record<string, Array<() => void>> = {};
    vi.stubGlobal("document", {
      addEventListener: (type: string, fn: () => void) => void (listeners[type] ??= []).push(fn),
      removeEventListener: (type: string, fn: () => void) => void (listeners[type] = (listeners[type] ?? []).filter((f) => f !== fn)),
    });
    const s = await summaryScreen();
    await press(summary(s));
    const box = (r: { x: number; y: number; w: number; h: number }) => ({ measureInWindow: (cb: (x: number, y: number, w: number, h: number) => void) => cb(r.x, r.y, r.w, r.h) });
    const copy = { x: 375, y: opts.copyY, w: 44, h: 44 };
    const isLayer = (el: El) => el.props.pointerEvents === "box-none" && styleOf(el).position === "absolute" && el.props.ref && typeof el.props.ref === "object";
    const modalLayerIn = (t: unknown) => one(all(one(all(t, (el) => isOpenModal(el) && controls(el, /^Copy$/).length > 0), "the Summary modal"), isLayer), "the modal's layer");
    const modalLayer = () => modalLayerIn(s.render());
    const fit = () => {
      const t = s.render();
      const mine = modalLayerIn(t);
      for (const l of all(t, isLayer)) l.props.ref.current = box(l === mine ? opts.layer : { x: 0, y: 0, w: 1220, h: 847 });
      for (const r of all(t, (el) => nameOf(el) === "ScrollView" && el.props.ref && typeof el.props.ref === "object" && controls(el, /^Summary$/).length > 0)) r.props.ref.current = box({ x: 336, y: 192, w: 604, h: 639 });
      attach(one(controls(t, /^Copy$/), "Copy"), { ...box(copy), matches: () => true, focus: () => undefined, blur: () => undefined });
    };
    fit();
    const hint = String(one(controls(s.render(), /^Copy$/), "Copy").props.accessibilityHint);
    const placed = () => {
      const l = modalLayer();
      return all(l, (el) => el !== l && styleOf(el).position === "absolute" && all(el, (x) => nameOf(x) === "Text" && textOf(x) === hint).length > 0);
    };
    const show = async () => {
      one(controls(s.render(), /^Copy$/), "Copy").props.onFocus?.(focusEvent({ matches: () => true }));
      await flush();
      fit();
    };
    /** React Native's onLayout of the drawn bubble, with its measured height. */
    const drawnHeight = async (height: number) => {
      const b = one(placed(), "the drawn bubble");
      b.props.onLayout?.({ nativeEvent: { layout: { x: 0, y: 0, width: 160, height } } });
      await flush();
      fit();
    };
    const scroll = async (dy: number) => {
      copy.y += dy;
      fit();
      for (const fn of listeners.scroll ?? []) fn();
      await new Promise((r) => setTimeout(r, 40));
      await flush();
      fit();
    };
    /** The bubble's top and bottom edges in the layer, for a bubble of `height`. */
    const edges = (height: number) => {
      const st = styleOf(one(placed(), "the drawn bubble"));
      const top = typeof st.bottom === "number" ? opts.layer.h - st.bottom - height : Number(st.top);
      return { side: typeof st.bottom === "number" ? "above" : "below", top, end: top + height };
    };
    return { show, drawnHeight, scroll, edges, copyTop: () => copy.y - opts.layer.y };
  }

  it("a bubble taller than the estimate flips above once its drawn height is known, and stays inside its layer", async () => {
    try {
      // Room below Copy: 695 - (580 + 44) - 4 = 67 px, more than the two-line estimate; the bubble is 80 px.
      const m = await copyWithLayer({ layer: { x: 351, y: 218, w: 518, h: 477 }, copyY: 580 });
      await m.show();
      expect(m.edges(80).side, "the estimate places it below").toBe("below");
      await m.drawnHeight(80);
      const e = m.edges(80);
      expect(e.side, "80 px do not fit below; they fit above").toBe("above");
      expect(e.top, "inside the layer's top").toBeGreaterThanOrEqual(0);
      expect(e.end, "ends above Copy").toBeLessThanOrEqual(m.copyTop());
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("after a scroll the same tooltip is placed with its known height at once (no new layout), still inside the layer", async () => {
    try {
      const m = await copyWithLayer({ layer: { x: 351, y: 218, w: 518, h: 477 }, copyY: 580 });
      await m.show();
      await m.drawnHeight(80);
      const before = m.edges(80);
      const copyBefore = m.copyTop();
      await m.scroll(6);
      const e = m.edges(80);
      expect(e.side, "kept above without a new onLayout").toBe("above");
      // DeepSeek Flash review 01a1c7df c0001: "ends above Copy" alone also holds when nothing is placed
      // again (the old bubble is above the moved Copy too). The bubble must move with Copy: its edge keeps
      // the same distance to Copy's top as before the scroll.
      expect(m.copyTop() - copyBefore, "Copy moved down by the scroll").toBe(6);
      expect(e.end - before.end, "the bubble moved with Copy").toBe(6);
      expect(m.copyTop() - e.end, "the same gap to Copy as before the scroll").toBe(copyBefore - before.end);
      expect(e.top).toBeGreaterThanOrEqual(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("when neither side fits, the bubble is clamped inside the layer", async () => {
    try {
      // A 100 px layer, Copy 30–74 in it, an 80 px bubble: 78 + 80 > 100 below, 30 - 4 - 80 < 0 above.
      const m = await copyWithLayer({ layer: { x: 351, y: 548, w: 518, h: 100 }, copyY: 578 });
      await m.show();
      await m.drawnHeight(80);
      const e = m.edges(80);
      expect(e.top, "inside the layer's top").toBeGreaterThanOrEqual(0);
      expect(e.end, "inside the layer's bottom").toBeLessThanOrEqual(100);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  // Controls: what must keep working (these pass at 28ef13c and must keep passing).
  it("control: keyboard focus shows the Zoom in tooltip; Escape and blur hide it; after a tap, a later keyboard focus shows it again", async () => {
    const s = await mapScreen();
    const k = node(true);
    attach(zoomIn(s), k);
    zoomIn(s).props.onFocus?.(focusEvent(k));
    await flush();
    expect(visibleText(s.render()), "keyboard focus").toContain(ZOOM_IN);
    zoomIn(s).props.onKeyDown?.({ key: "Escape", nativeEvent: { key: "Escape" } });
    await flush();
    expect(visibleText(s.render()), "Escape").not.toContain(ZOOM_IN);
    zoomIn(s).props.onBlur?.(focusEvent(k));
    zoomIn(s).props.onFocus?.(focusEvent(k));
    await flush();
    expect(visibleText(s.render()), "focus again").toContain(ZOOM_IN);
    zoomIn(s).props.onBlur?.(focusEvent(k));
    await flush();
    expect(visibleText(s.render()), "blur").not.toContain(ZOOM_IN);
    // A tap, then the focus leaves, then a keyboard focus comes back to the button.
    const n = node(false);
    attach(zoomIn(s), n);
    await tap(() => zoomIn(s), n);
    zoomIn(s).props.onBlur?.(focusEvent(n));
    attach(zoomIn(s), k);
    zoomIn(s).props.onFocus?.(focusEvent(k));
    await flush();
    expect(visibleText(s.render()), "keyboard focus after an earlier tap").toContain(ZOOM_IN);
  });

  it("control: mouse hover shows the Zoom in and Summary tooltips and hover out hides them", async () => {
    const s = await mapScreen();
    zoomIn(s).props.onHoverIn?.({});
    await flush();
    expect(visibleText(s.render())).toContain(ZOOM_IN);
    zoomIn(s).props.onHoverOut?.({});
    await flush();
    expect(visibleText(s.render())).not.toContain(ZOOM_IN);
    const g = await summaryScreen();
    const hint = summaryHint(g);
    summary(g).props.onHoverIn?.({});
    await flush();
    expect(visibleText(g.render())).toContain(hint);
    summary(g).props.onHoverOut?.({});
    await flush();
    expect(visibleText(g.render())).not.toContain(hint);
  });

  it("control: the stacking rule itself: a later sibling paints over an earlier one unless the earlier has a higher zIndex; a deeper zIndex does not lift it", () => {
    const V = h.marker("View");
    const T = h.marker("Text");
    const tip = { type: T, props: { children: "tip" } } as El;
    const inner = { type: V, props: { style: { position: "absolute", zIndex: 10 }, children: tip } } as El;
    const wrapper = { type: V, props: { style: { position: "relative" }, children: inner } } as El;
    const next = { type: V, props: { children: { type: T, props: { children: "next" } } } } as El;
    const row = { type: V, props: { children: [wrapper, next] } } as El;
    expect(paintsOver(row, inner, next), "zIndex 10 inside a View with zIndex 0").toBe(false);
    const raised = { type: V, props: { style: { position: "relative", zIndex: 1 }, children: inner } } as El;
    const row2 = { type: V, props: { children: [raised, next] } } as El;
    expect(paintsOver(row2, inner, next), "the wrapper raised among its siblings").toBe(true);
    const modal = { type: h.marker("Modal"), props: { open: true, children: tip } } as El;
    const row3 = { type: V, props: { children: [modal, next] } } as El;
    expect(paintsOver(row3, tip, next), "an open host Modal is a layer above").toBe(true);
    // A Fragment is not a level: a raised wrapper inside one is still above its parent's later children.
    const fragment = { type: Symbol.for("react.fragment"), props: { children: [raised] } } as unknown as El;
    const row4 = { type: V, props: { children: [fragment, next] } } as El;
    expect(paintsOver(row4, inner, next), "a raised wrapper inside a Fragment").toBe(true);
  });

  // Review of e587ca9: the check must accept a non-blocking layer drawn at screen level (a bubble placed
  // in a pointerEvents "none" overlay after the screen's content), reject the row-raised wrapper for
  // content in later rows (as the host showed), and reject a layer that takes touches.
  it("control: the check accepts a non-blocking screen-level overlay and rejects a row-raised wrapper and a blocking layer", () => {
    const V = h.marker("View");
    const T = h.marker("Text");
    const P = h.marker("Pressable");
    const mk = (type: unknown, props: Record<string, unknown>) => ({ type, props }) as El;
    const control = () => mk(P, { accessibilityLabel: "Zoom in", onPress: () => undefined, style: { minWidth: 44, minHeight: 44 } });
    const bubble = () => mk(V, { style: { position: "absolute", left: 100, top: 40 }, children: mk(T, { children: "HINT" }) });
    const rowLater = () => mk(P, { accessibilityLabel: "Graph", onPress: () => undefined });
    const nextRow = () => mk(V, { children: [mk(T, { children: "A note in the next row" }), mk(P, { accessibilityLabel: "Block 1 header", onPress: () => undefined })] });

    // 1. A screen-level overlay after the content, taking no touches: nothing is drawn over the bubble.
    {
      const ctl = control();
      const screen = mk(V, { children: [mk(V, { children: [mk(V, { children: [ctl, rowLater()] }), nextRow()] }), mk(V, { pointerEvents: "box-none", style: { position: "absolute", left: 0, top: 0, right: 0, bottom: 0 }, children: mk(V, { pointerEvents: "none", children: bubble() }) })] });
      const r = stacking(screen, "HINT", ctl);
      expect(r.later, "content after the control is compared").toBeGreaterThan(0);
      expect(r.under, "the overlay is above the row and the next row").toEqual([]);
      expect(r.blocking, "the overlay takes no touches").toBeNull();
    }
    // 2. The wrapper raised in its row (e587ca9's structure): above the row, under the next row.
    {
      const ctl = control();
      const wrapper = mk(V, { style: { position: "relative", alignSelf: "flex-start", zIndex: 10 }, children: [ctl, mk(V, { pointerEvents: "none", style: { position: "absolute", width: 240 }, children: bubble() })] });
      const screen = mk(V, { children: [mk(V, { children: [wrapper, rowLater()] }), nextRow()] });
      const r = stacking(screen, "HINT", ctl);
      expect(r.under, "the next row paints over it; the row's own Graph does not").toEqual(["A note in the next row", "Block 1 header"]);
      expect(r.blocking).toBeNull();
    }
    // 3. The same overlay that takes touches would block presses on what it covers.
    {
      const ctl = control();
      const screen = mk(V, { children: [mk(V, { children: [ctl, rowLater()] }), mk(V, { style: { position: "absolute", left: 0, top: 0, right: 0, bottom: 0 }, children: bubble() })] });
      expect(stacking(screen, "HINT", ctl).blocking, "a full-screen layer that takes touches").not.toBeNull();
    }
  });
});

describe("W7: the Map centres and zooms in the space it is drawn in", () => {
  async function openMap() {
    const s = await openScreen();
    await press(one(controls(await openMenu(s), /^(✓ )?Map$/), "Map item"));
    return s;
  }
  const nodeControls = (tree: unknown) => controls(tree, /^Q\d+ .*, Block \d+, \d+ incoming, \d+ outgoing$/);
  async function model() {
    const layout = (await import(/* @vite-ignore */ String("./map-layout"))) as { mapModel: (v: unknown, o: unknown) => any };
    return layout.mapModel(current.view, { showInactive: true });
  }
  /**
   * Scroll recorders that behave like a browser: a scroll is clamped to the content laid out and the
   * viewport measured at the moment of the call, so a scroll issued before the zoomed world is laid
   * out falls short. `layout` reports a new viewport size to the view and to the clamp.
   */
  function browserLike(s: Screen, initial: { width: number; height: number }) {
    const xs: number[] = [];
    const ys: number[] = [];
    let viewport = initial;
    let extent = { width: 0, height: 0 };
    const relayout = () => {
      const tree = s.render();
      const vertical = one(all(tree, (el) => nameOf(el) === "ScrollView" && typeof el.props.onLayout === "function" && el.props.ref != null), "vertical scroll");
      const horizontal = one(all(vertical, (el) => nameOf(el) === "RNScrollView" && el.props.horizontal === true && el.props.ref != null), "horizontal scroll");
      const content = [horizontal.props.children].flat().find((c: any) => c && c.props) as El;
      const st = Object.assign({}, ...[content.props.style].flat(Infinity).filter(Boolean));
      extent = { width: Number(st.width ?? 0), height: Number(st.height ?? 0) };
      // RN Web's ScrollView scrolls `y || 0` / `x || 0`: an undefined or NaN target goes to the origin.
      vertical.props.ref.current = { scrollTo: (o: { y: number }) => void ys.push(Math.max(0, Math.min(o.y || 0, extent.height - viewport.height))) };
      horizontal.props.ref.current = { scrollTo: (o: { x: number }) => void xs.push(Math.max(0, Math.min(o.x || 0, extent.width - viewport.width))) };
      return { vertical, horizontal, content };
    };
    const layout = (next: { width: number; height: number }) => {
      viewport = next;
      relayout().vertical.props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, ...next } } });
    };
    layout(initial);
    return { xs, ys, relayout, layout };
  }
  const centre = (m: any, id: string, viewport: { width: number; height: number }) => {
    const n = m.nodes.find((x: any) => x.questionId === id);
    const clamp = (v: number, max: number) => Math.max(0, Math.min(v, Math.max(0, max)));
    return { x: clamp(n.x + n.width / 2 - viewport.width / 2, m.world.width - viewport.width), y: clamp(n.y + n.height / 2 - viewport.height / 2, m.world.height - viewport.height), n };
  };

  it("a selected node is centred in the space left once the detail panel takes its width", async () => {
    const s = await openMap();
    const wide = { width: 868, height: 559 };
    const narrow = { width: 536, height: 559 };
    const rec = browserLike(s, wide);
    await press(one(nodeControls(s.render()).filter((el) => labelOf(el).startsWith("Q3 ")), "node Q3"));
    // The host lays the world out again, narrower, once the detail panel is shown.
    rec.layout(narrow);
    await flush();
    rec.relayout();
    const want = centre(await model(), "q3", narrow);
    expect(want.x, "the case needs a node whose centre moves with the viewport").toBeGreaterThan(0);
    expect(rec.xs.at(-1)).toBe(want.x);
  });

  // Overview press coordinates. Native React Native reports locationX/Y relative to the element that
  // receives the touch. The host's React Native Web computes locationX as clientX minus the bounding
  // box of the responder event's currentTarget; its responder listens on `document`, so that target
  // has no element box and locationX/Y are undefined, while pageX/pageY hold the pointer's page
  // position. Its ScrollView then scrolls `x || 0`, so a NaN target scrolls to the origin, as the host
  // recheck logged. Both event shapes are modelled here; refs inside the overview answer measurements
  // with the wrapper's page position. The real coordinates still need the host recheck.
  for (const shape of ["native", "web"] as const) {
    it(`an overview press on a node zooms to 100 % around the pressed world point (${shape} event)`, async () => {
      const s = await openMap();
      await press(one(controls(s.render(), /^Zoom out$/), "Zoom out"));
      await press(one(controls(s.render(), /^Zoom out$/), "Zoom out"));
      const viewport = { width: 200, height: 100 };
      const rec = browserLike(s, viewport);
      const m = await model();
      const target = centre(m, "q3", viewport);
      const scale = 0.5;
      const point = { x: target.n.x + target.n.width / 2, y: target.n.y + target.n.height / 2 };
      const PAGE = { x: 336, y: 272 };
      const { horizontal } = rec.relayout();
      const pressable = all(horizontal, (el) => typeof el.props.onPress === "function")[0];
      expect(pressable, "the overview is pressable").toBeDefined();
      const size = { width: m.world.width * scale, height: m.world.height * scale };
      for (const el of [pressable, ...all(pressable, (x) => x.props.ref != null && typeof x.props.ref === "object")]) {
        if (el.props.ref == null || typeof el.props.ref !== "object") continue;
        el.props.ref.current = {
          measure: (cb: (...a: number[]) => void) => cb(0, 0, size.width, size.height, PAGE.x, PAGE.y),
          measureInWindow: (cb: (...a: number[]) => void) => cb(PAGE.x, PAGE.y, size.width, size.height),
          getBoundingClientRect: () => ({ left: PAGE.x, top: PAGE.y, x: PAGE.x, y: PAGE.y, ...size }),
        };
      }
      // Native: the receiver is the deepest element under the point that takes pointer events.
      const box = (el: El) => {
        const st = Object.assign({}, ...[el.props.style].flat(Infinity).filter(Boolean));
        return typeof st.left === "number" && typeof st.top === "number" && typeof st.width === "number" && typeof st.height === "number" ? { x: st.left, y: st.top, w: st.width, h: st.height } : null;
      };
      const pe = (el: El) => el.props.pointerEvents ?? Object.assign({}, ...[el.props.style].flat(Infinity).filter(Boolean)).pointerEvents;
      const pathTo = (root: El, pred: (el: El) => boolean): El[] | null => {
        const walk = (n: unknown, path: El[]): El[] | null => {
          if (Array.isArray(n)) {
            for (const x of n) {
              const r = walk(x, path);
              if (r) return r;
            }
            return null;
          }
          if (!n || typeof n !== "object" || !(n as El).props) return null;
          const el = n as El;
          if (pred(el)) return [...path, el];
          return walk(el.props.children, [...path, el]);
        };
        return walk(root.props.children, [root]);
      };
      const nodePath = pathTo(pressable, (el) => {
        const b = box(el);
        return b !== null && b.x === target.n.x && b.y === target.n.y && b.w === target.n.width && b.h === target.n.height;
      });
      expect(nodePath, "the overview draws the node").not.toBeNull();
      const passesUp = nodePath!.slice(1).some((el) => pe(el) === "none") || nodePath!.slice(0, -1).some((el) => pe(el) === "box-only");
      const receiver = passesUp ? { x: 0, y: 0 } : { x: target.n.x * scale, y: target.n.y * scale };
      const page = { pageX: PAGE.x + point.x * scale, pageY: PAGE.y + point.y * scale };
      const nativeEvent =
        shape === "native"
          ? { locationX: point.x * scale - receiver.x, locationY: point.y * scale - receiver.y, ...page }
          : { locationX: undefined, locationY: undefined, ...page };
      pressable.props.onPress({ nativeEvent, currentTarget: shape === "web" ? null : passesUp ? pressable : nodePath!.at(-1) });
      await flush();
      rec.relayout();
      await flush();
      rec.relayout();
      expect(visibleText(s.render())).toMatch(/\b100\s?%/);
      expect(target.x, "the case needs a point away from the origin").toBeGreaterThan(0);
      expect(rec.xs.at(-1)).toBe(target.x);
      expect(rec.ys.at(-1)).toBe(target.y);
    });
  }

  it("the selected edge's condition label lies clear of every node", async () => {
    const s = await openMap();
    await press(one(nodeControls(s.render()).filter((el) => labelOf(el).startsWith("Q3 ")), "node Q3"));
    const m = await model();
    const labels = all(s.render(), (el) => nameOf(el) === "Text" && /^when /.test(textOf(el)));
    expect(labels.length, "the condition is drawn").toBeGreaterThan(0);
    for (const l of labels) {
      const st = Object.assign({}, ...[l.props.style].flat(Infinity).filter(Boolean));
      const box = { x: Number(st.left), y: Number(st.top), w: Number(st.width ?? st.maxWidth ?? 0), h: Number(st.lineHeight ?? 14) };
      for (const n of m.nodes) {
        const apart = box.x + box.w <= n.x || n.x + n.width <= box.x || box.y + box.h <= n.y || n.y + n.height <= box.y;
        expect(apart, `${textOf(l)} overlaps ${n.label}`).toBe(true);
      }
    }
  });
});

// ---- W8: compact layout (structure and calls only; touch, keyboard and native Back need a device) ----
describe("W8: compact session screen", () => {
  const flatStyle = (el: El): Record<string, any> =>
    Object.assign({}, ...[el.props.style].flat(Infinity).filter(Boolean).map((x: any) => (typeof x === "function" ? x({ pressed: false, hovered: false }) : x)));
  const isScroll = (el: El) => ["ScrollView", "RNScrollView"].includes(nameOf(el));
  /** The vertical scroll region of the compact canvas: a non-horizontal ScrollView that holds the Accept button. */
  const bodyScroll = (tree: unknown) =>
    one(all(tree, (el) => isScroll(el) && el.props.horizontal !== true && controls(el, /^Accept block and continue$/).length > 0).filter((el) => all(el, (x) => isScroll(x) && x.props.horizontal !== true && x !== el && controls(x, /^Accept block and continue$/).length > 0).length === 0), "the canvas scroll region");
  /** The navigator row: a horizontal ScrollView that holds the block items. */
  const navRow = (tree: unknown) => one(all(tree, (el) => isScroll(el) && el.props.horizontal === true && controls(el, /^Block 1\b/).length > 0), "the navigator row");

  it("the navigator is one horizontal row above the canvas, and the cards, add row and Accept share one vertical scroll region with it", async () => {
    const s = await openScreen({ compact: true });
    const t = s.render();
    const body = bodyScroll(t);
    const row = navRow(body);
    expect(controls(row, /^Block \d/).length).toBe(2);
    const order = all(body);
    const firstCard = order.findIndex((el) => textOf(el).startsWith(`Q3 ${Q3}`));
    expect(order.indexOf(row), "the row comes before the canvas").toBeLessThan(firstCard);
    expect(controls(body, /^Add question to Block 2$/).length).toBe(1);
    await press(one(controls(body, /^Add question to Block 2$/), "add row"));
    expect(inputs(bodyScroll(s.render()), QUESTION_FIELD).length, "the add form is in the same scroll region").toBe(1);
  });

  it("the navigator row scrolls so the selected block is fully in view", async () => {
    const s = await openScreen({ compact: true });
    let t = s.render();
    const row = navRow(bodyScroll(t));
    expect(row.props.ref != null && typeof row.props.ref === "object", "the row can be scrolled").toBe(true);
    const scrolled: number[] = [];
    row.props.ref.current = { scrollTo: (o: { x: number }) => void scrolled.push(o.x ?? 0) };
    // A narrow row: Block 1 at 0–168, Block 2 at 174–342, the row 200 px wide.
    row.props.onLayout?.({ nativeEvent: { layout: { x: 0, y: 0, width: 200, height: 46 } } });
    const items = controls(row, /^Block \d/);
    items.forEach((el, i) => el.props.onLayout?.({ nativeEvent: { layout: { x: i * 174, y: 0, width: 168, height: 46 } } }));
    for (const wrapper of all(row, (el) => typeof el.props.onLayout === "function" && el !== row && !items.includes(el))) {
      const i = items.findIndex((it) => all(wrapper, (x) => x === it).length > 0);
      if (i >= 0) wrapper.props.onLayout({ nativeEvent: { layout: { x: i * 174, y: 0, width: 168, height: 46 } } });
    }
    await flush();
    t = s.render();
    expect(selected(navItem(t, /^Block 2\b/))).toBe(true);
    const x = scrolled.at(-1);
    expect(x, "a scroll was requested for the selected block").toBeDefined();
    expect(x!).toBeGreaterThanOrEqual(342 - 200);
    expect(x!).toBeLessThanOrEqual(174);
  });

  it("the Chat menu is a host Modal whose dismissal closes it and returns focus to the trigger", async () => {
    const s = await openScreen({ compact: true });
    const trig = trigger(s.render());
    let focused = 0;
    expect(trig.props.ref != null && typeof trig.props.ref === "object", "the trigger carries a ref").toBe(true);
    trig.props.ref.current = { focus: () => void focused++ };
    await press(trig);
    let t = s.render();
    const sheet = one(all(t, (el) => nameOf(el) === "Modal" && el.props.open !== false && controls(el, /^(✓ )?Map$/).length > 0), "the menu sheet");
    expect(controls(sheet, /^Change chat…$/).length).toBe(1);
    sheet.props.onOpenChange(false);
    await flush();
    t = s.render();
    expect(controls(t, /^Change chat…$/), "the sheet closed").toEqual([]);
    expect(focused, "focus returned to the trigger").toBe(1);
  });

  it("the add form is kept clear of the software keyboard", async () => {
    const s = await openScreen({ compact: true });
    await press(one(controls(s.render(), /^Add question to Block 2$/), "add row"));
    const t = s.render();
    const field = one(inputs(t, QUESTION_FIELD), "question field");
    const chain: El[] = [];
    const walk = (n: unknown, path: El[]): boolean => {
      if (Array.isArray(n)) return n.some((x) => walk(x, path));
      if (!n || typeof n !== "object" || !(n as El).props) return false;
      const el = n as El;
      if (el === field) {
        chain.push(...path);
        return true;
      }
      return walk(el.props.children, [...path, el]);
    };
    walk(t, []);
    const avoiding = chain.some((el) => nameOf(el) === "KeyboardAvoidingView") || chain.some((el) => isScroll(el) && el.props.automaticallyAdjustKeyboardInsets === true);
    expect(avoiding, "a KeyboardAvoidingView, or a scroll region that adjusts for the keyboard, holds the form").toBe(true);
  });

  it("every enabled control of the compact screen, its menu sheet and an open card declares a 44 px minimum height", async () => {
    const s = await openScreen({ compact: true });
    await press(one(controls(cardOf(s.render(), `Q3 ${Q3}`), /^More\b/), "More"));
    await press(trigger(s.render()));
    const small = all(s.render(), (el) => nameOf(el) === "Pressable" && typeof el.props.onPress === "function" && !isDisabled(el))
      .filter((el) => !((flatStyle(el).minHeight ?? flatStyle(el).height ?? 0) >= 44))
      .map((el) => labelOf(el));
    expect(small).toEqual([]);
  });
});

describe("W8: compact Map", () => {
  async function openCompactMap() {
    const s = await openScreen({ compact: true });
    await press(trigger(s.render()));
    const sheet = one(all(s.render(), (el) => nameOf(el) === "Modal" && el.props.open !== false && controls(el, /^(✓ )?Map$/).length > 0), "the menu sheet");
    await press(one(controls(sheet, /^(✓ )?Map$/), "Map"));
    return s;
  }
  const flatStyle = (el: El): Record<string, any> => Object.assign({}, ...[el.props.style].flat(Infinity).filter(Boolean));
  const nodeControls = (tree: unknown) => controls(tree, /^Q\d+ .*, Block \d+, \d+ incoming, \d+ outgoing$/);

  it("opens at Fit as an overview, with the toolbar as one wrapping row of 44 px controls and List reachable", async () => {
    const s = await openCompactMap();
    const t = s.render();
    const fit = one(controls(t, /^Fit$/), "Fit");
    expect(fit.props["aria-selected"] === true || fit.props.accessibilityState?.selected === true || fit.props.accessibilityState?.checked === true, "Fit is the chosen zoom").toBe(true);
    expect(visibleText(t)).toMatch(/Overview/);
    const tools = [/^Zoom out$/, /^Zoom in$/, /^Fit$/, /^Graph$/, /^List$/, /Show inactive/, /Find question/].map((re) => one(controls(t, re), String(re)));
    for (const el of tools) expect((flatStyle(el).minHeight ?? 0) >= 44 || (flatStyle(el).height ?? 0) >= 44, labelOf(el)).toBe(true);
    const row = all(t, (el) => tools.every((tool) => all(el, (x) => x === tool).length > 0)).reduce<El | null>((a, b) => (a === null || all(b).length < all(a).length ? b : a), null);
    expect(row, "one container holds the toolbar").not.toBeNull();
    expect(flatStyle(row!).flexDirection).toBe("row");
    expect(flatStyle(row!).flexWrap).toBe("wrap");
    await press(one(controls(t, /^List$/), "List"));
    expect(visibleText(s.render())).toMatch(/Needed by Q3/);
  });

  it("the detail is a host Modal whose dismissal clears the selection and returns focus to the node", async () => {
    const s = await openCompactMap();
    // Leave Fit for the 100 % step, where nodes are pressable.
    for (let i = 0; i < 6 && !(/\b100\s?%/.test(visibleText(s.render())) && nodeControls(s.render()).some((el) => !isDisabled(el))); i++) {
      const level = Number(/\b(\d+)\s?%/.exec(visibleText(s.render()))?.[1] ?? 0);
      await press(one(controls(s.render(), level < 100 ? /^Zoom in$/ : /^Zoom out$/), "zoom step"));
    }
    expect(visibleText(s.render())).toMatch(/\b100\s?%/);
    const node = one(nodeControls(s.render()).filter((el) => labelOf(el).startsWith("Q3 ")), "node Q3");
    expect(node.props.ref != null && typeof node.props.ref === "object", "the node carries a ref").toBe(true);
    let focused = 0;
    node.props.ref.current = { focus: () => void focused++ };
    await press(node);
    const sheet = one(all(s.render(), (el) => nameOf(el) === "Modal" && el.props.open !== false && /Comes after/.test(textOf(el))), "the detail sheet");
    sheet.props.onOpenChange(false);
    await flush();
    const t = s.render();
    expect(all(t, (el) => nameOf(el) === "Modal" && el.props.open !== false && /Comes after/.test(textOf(el))), "the sheet closed").toEqual([]);
    expect(visibleText(t)).not.toMatch(/Showing Q3/);
    expect(focused, "focus returned to the node").toBe(1);
  });
});

// ---- Compact layout: header, Chat sheet focus, Map List and toggles ----
// Component tests check structure and calls; the real widths, focus and scroll positions need a check
// in a real browser at 390 and 320 px.
describe("W8 host findings: compact header, Chat sheet focus, Map List and toggles", () => {
  const flatStyle = (el: El): Record<string, any> => Object.assign({}, ...[el.props.style].flat(Infinity).filter(Boolean));

  // At 320 px the title row held Back (68 px), the title, the Chat trigger (157 px) and Open chat
  // (44 px); the title box was 3 px wide and the title stacked one letter per line. The title must not
  // share a non-wrapping row with the Chat trigger unless it keeps a usable width of its own.
  it("compact: the title does not share a non-wrapping row with the Chat trigger without a minimum width of its own", async () => {
    const s = await openScreen({ compact: true });
    const t = s.render();
    const heading: El = one(all(t, (el) => nameOf(el) === "Heading" || (nameOf(el) === "Text" && textOf(el) === "Session S")), "the title");
    const trig = trigger(t);
    // DeepSeek Flash review 01a1c67a c0013: a horizontal scroll view is a row too, and the case states
    // which arrangement it found instead of passing silently.
    const containers = all(t, (el) => ["View", "ScrollView", "RNScrollView"].includes(nameOf(el)) && all(el, (x) => x === heading).length > 0 && all(el, (x) => x === trig).length > 0);
    const shared = containers.find((r) => !containers.some((o) => o !== r && all(r, (x) => x === o).length > 0));
    expect(shared, "the title and the Chat trigger share a container").toBeDefined();
    const isRow = (el: El) => (nameOf(el) === "View" ? ["row", "row-reverse"].includes(String(flatStyle(el).flexDirection ?? "column")) : el.props.horizontal === true);
    if (!isRow(shared!)) {
      // Stacked: the title has the container's width; nothing else to check.
      expect(nameOf(shared!) === "View" && ["column", "column-reverse"].includes(String(flatStyle(shared!).flexDirection ?? "column")), `${nameOf(shared!)} is a column`).toBe(true);
    } else {
      expect(nameOf(shared!), "a shared row is a wrapping View, not a horizontal scroll view").toBe("View");
      const chain: El[] = [];
      const walk = (n: unknown, path: El[]): boolean => {
        if (Array.isArray(n)) return n.some((x) => walk(x, path));
        if (!n || typeof n !== "object" || !(n as El).props) return false;
        if (n === heading) {
          chain.push(...path);
          return true;
        }
        return walk((n as El).props.children, [...path, n as El]);
      };
      walk(shared!.props.children, []);
      const titleMin = Math.max(0, ...[heading, ...chain].map((el) => Number(flatStyle(el).minWidth ?? 0)));
      expect(flatStyle(shared!).flexWrap === "wrap" && titleMin >= 120, "a shared row must wrap and give the title at least 120 px").toBe(true);
    }
  });

  // On the host the sheet opened while focus stayed on the trigger behind it: the first item was not
  // yet mounted when the menu tried to focus it. Focus must reach an item once the sheet's content is
  // there.
  it("compact: focus moves into the Chat sheet once its items are mounted", async () => {
    const s = await openScreen({ compact: true });
    await press(trigger(s.render()));
    let focused = 0;
    const sheet = () => one(all(s.render(), (el) => nameOf(el) === "Modal" && el.props.open !== false && controls(el, /^(✓ )?Map$/).length > 0), "the sheet");
    for (const el of all(sheet(), (x) => x.props.ref != null && typeof x.props.ref === "object")) el.props.ref.current = { focus: () => void focused++ };
    for (const el of all(sheet(), (x) => typeof x.props.ref === "function")) el.props.ref({ focus: () => void focused++ });
    for (const el of all(sheet(), (x) => typeof x.props.onLayout === "function")) el.props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 300, height: 44 } } });
    await flush();
    s.render();
    await flush();
    s.render();
    expect(focused, "an item inside the sheet received focus").toBeGreaterThan(0);
  });

  async function openMapIn(s: Screen, compact: boolean) {
    await press(trigger(s.render()));
    const holder = compact ? one(all(s.render(), (el) => nameOf(el) === "Modal" && el.props.open !== false && controls(el, /^(✓ )?Map$/).length > 0), "the sheet") : s.render();
    await press(one(controls(holder, /^(✓ )?Map$/), "Map"));
  }

  // On the host the List opened scrolled after the graph had been scrolled to a selection: List and
  // graph render their vertical ScrollView at the same place, so the scroll element and its offset were
  // kept. The List must start at its top: a scroll region of its own (a distinct key) or a scroll to 0.
  it("the List starts at the top after the graph was scrolled", async () => {
    const s = await openScreen();
    await openMapIn(s, false);
    const verticals = (tree: unknown) => all(tree, (el) => ["ScrollView", "RNScrollView"].includes(nameOf(el)) && el.props.horizontal !== true && el.props.ref != null);
    const graphScroll = verticals(s.render()).find((el) => typeof el.props.onLayout === "function")!;
    expect(graphScroll, "the graph's vertical scroll").toBeDefined();
    const ys: number[] = [];
    graphScroll.props.ref.current = { scrollTo: (o: { y?: number }) => void ys.push(o.y ?? 0) };
    const graphKey = (graphScroll as unknown as { key: string | null }).key;
    await press(one(controls(s.render(), /^List$/), "List"));
    const t = s.render();
    const listScroll = verticals(t).concat(all(t, (el) => ["ScrollView", "RNScrollView"].includes(nameOf(el)) && el.props.horizontal !== true)).find((el) => /on the map/.test(controls(el, /on the map$/).map(labelOf).join(" ")));
    expect(listScroll, "the List's scroll region").toBeDefined();
    const listKey = (listScroll as unknown as { key: string | null }).key;
    const ownElement = listKey !== null && listKey !== graphKey;
    const scrolledToTop = ys.includes(0) || (listScroll!.props.ref != null && listScroll!.props.ref === graphScroll.props.ref && ys.includes(0));
    expect(ownElement || scrolledToTop, "a List scroll region of its own, or a scroll to its top").toBe(true);
  });

  // On the host Fit, Graph, List and Show inactive told their state only by a "✓" in the label text.
  it("the Map's toggles expose their state to assistive technology", async () => {
    const s = await openScreen();
    await openMapIn(s, false);
    const t = s.render();
    const stateOf = (el: El) => el.props["aria-pressed"] ?? el.props["aria-selected"] ?? el.props["aria-checked"] ?? el.props.accessibilityState?.selected ?? el.props.accessibilityState?.checked;
    const graph = one(controls(t, /^(✓ )?Graph$/), "Graph");
    const list = one(controls(t, /^(✓ )?List$/), "List");
    const inactive = one(controls(t, /Show inactive$/), "Show inactive");
    expect(stateOf(graph), "Graph is on").toBe(true);
    expect(stateOf(list), "List is off").toBe(false);
    expect(stateOf(inactive), "Show inactive is on").toBe(true);
    for (const el of [graph, list, inactive]) expect(el.props["aria-pressed"] ?? el.props["aria-selected"] ?? el.props["aria-checked"], `${labelOf(el)} carries a web state attribute`).toBeDefined();
  });

  // KensAI 9126580 c0017: Find question is a toggle too (it shows "✓" while its picker is open and a
  // second press closes it), so it must carry aria-pressed like Fit, Graph, List and Show inactive
  // (React Native Web drops accessibilityState). At c0017 it had no `pressed`; it now passes
  // `pressed={finding}` (DeepSeek Flash review 01a1c67a c0039: the comment had kept the old state).
  it("the Map's Find question toggle exposes its open state on the web", async () => {
    const s = await openScreen();
    await openMapIn(s, false);
    const find = () => one(controls(s.render(), /^(✓ )?Find question$/), "Find question");
    expect(find().props["aria-pressed"], "closed: aria-pressed false").toBe(false);
    await press(find());
    expect(visibleText(s.render()), "the picker is open").toMatch(/Filter by number or title|Filter questions/);
    expect(find().props["aria-pressed"], "open: aria-pressed true").toBe(true);
    await press(find());
    expect(find().props["aria-pressed"], "closed again: aria-pressed false").toBe(false);
  });
});

// ---- Compact sheets: initial focus, Tab, Escape and focus return ----
// Host evidence (Paseo 0.15.3 web bundle): the plugin `Modal` renders the host's AdaptiveModalSheet.
// On wide screens that is a `role="dialog"` `aria-modal` card registered as a web overlay: the host
// moves focus into it, keeps Tab inside it, closes it on Escape and restores focus on close. On
// compact screens it is a bottom sheet (`accessible: false`) with none of that: no initial focus, no
// Tab containment, no Escape handling, no focus restore. The Modal API takes only title, icon, open,
// onOpenChange and children, so on compact the plugin owns focus in its sheets. These cases model the
// web DOM with fakes (focus(), document.activeElement, contains, querySelectorAll) and React's
// bubbling of onKeyDown from the focused element; the real Tab order and the native screen reader
// need a real browser and a device.
describe("W8 recheck: compact sheets own their focus", () => {
  type Fake = { label: string; focus(options?: { preventScroll?: boolean }): void; contains(o: unknown): boolean; querySelectorAll(selector: string): Fake[]; getAttribute(name: string): string | null; hasAttribute(name: string): boolean; getClientRects(): object[] };
  const keyOf = (el: El) => `${String(el.props.accessibilityRole ?? el.props.role ?? nameOf(el))}:${labelOf(el) || String(el.props.placeholder ?? "")}`;
  const focusable = (el: El) => (typeof el.props.onPress === "function" && !isDisabled(el)) || typeof el.props.onChangeText === "function";

  // KensAI 01a1c636 c0125: the sheet's scope finds its controls with querySelectorAll(selector) and
  // reads their attributes, so the fake must answer that query the way the browser would over the DOM
  // React Native Web 0.21 renders (react-native-web/dist: exports/Pressable tabIndex = the prop, else
  // disabled ? -1 : 0; modules/createDOMProps: role "button" renders <button>, a disabled one carries
  // aria-disabled="true" and disabled, focusable false gives tabindex "-1", the roles button, checkbox,
  // link, radio, textbox and switch get tabindex "0", any other element only with focusable true;
  // TextInput renders <input>, or <textarea> when multiline). The selector is evaluated, not ignored;
  // a selector this matcher cannot read fails the case instead of passing it. Still a model of that
  // output: a real browser and a device remain unverified.
  type WebDom = { tag: string; attrs: Record<string, string> };
  const FOCUS_ROLES = new Set(["button", "checkbox", "link", "radio", "textbox", "switch"]);
  function webDomOf(el: El): WebDom {
    const role = String(el.props.accessibilityRole ?? el.props.role ?? "");
    const disabled = isDisabled(el);
    const attrs: Record<string, string> = {};
    if (role !== "") attrs.role = role;
    const explicit = el.props.tabIndex;
    if (typeof el.props.onChangeText === "function") {
      if (disabled) attrs.disabled = "";
      if (explicit !== undefined) attrs.tabindex = String(explicit);
      return { tag: el.props.multiline === true ? "textarea" : "input", attrs };
    }
    const tag = role === "button" ? "button" : "div";
    if (disabled) {
      attrs["aria-disabled"] = "true";
      if (tag === "button") attrs.disabled = "";
    }
    if (nameOf(el) === "Pressable") {
      attrs.tabindex = explicit !== undefined ? String(explicit) : disabled ? "-1" : "0";
      return { tag, attrs };
    }
    if (explicit === 0 || explicit === -1 || explicit === "0" || explicit === "-1") attrs.tabindex = String(explicit);
    else if (el.props.focusable === false) attrs.tabindex = "-1";
    else if (tag !== "button" && FOCUS_ROLES.has(role)) attrs.tabindex = "0";
    else if (tag !== "button" && el.props.focusable === true) attrs.tabindex = "0";
    return { tag, attrs };
  }
  /** Whether `dom` matches a selector list of tags, [attr] and [attr="v"] tests and :not([…]); anything else throws. */
  function matches(dom: WebDom, selector: string): boolean {
    return selector.split(",").some((raw) => {
      const part = raw.trim();
      const m = /^([a-z]+)?((?:\[[a-z-]+(?:="[^"]*")?\])*)((?::not\(\[[a-z-]+(?:="[^"]*")?\]\))*)$/.exec(part);
      if (m === null || part === "") throw new Error(`the fake DOM cannot evaluate the selector part "${part}"`);
      const test = (attr: string) => {
        const a = /^\[([a-z-]+)(?:="([^"]*)")?\]$/.exec(attr)!;
        return a[2] === undefined ? a[1] in dom.attrs : dom.attrs[a[1]] === a[2];
      };
      if (m[1] !== undefined && m[1] !== dom.tag) return false;
      if (!(m[2].match(/\[[^\]]+\]/g) ?? []).every(test)) return false;
      return !(m[3].match(/\[[^\]]+\]/g) ?? []).some(test);
    });
  }

  /** A fake web document over the latest rendered tree; fakes keep their identity across renders. */
  function fakeDom() {
    const listeners: Array<{ type: string; fn: (e: unknown) => void }> = [];
    const doc = {
      activeElement: null as Fake | null,
      addEventListener: (type: string, fn: (e: unknown) => void) => void listeners.push({ type, fn }),
      removeEventListener: (type: string, fn: (e: unknown) => void) => {
        const i = listeners.findIndex((l) => l.type === type && l.fn === fn);
        if (i >= 0) listeners.splice(i, 1);
      },
      /** Listeners the plugin added for `type`, as the page's document would call them. */
      dispatch: (type: string, e: unknown) => {
        for (const l of [...listeners]) if (l.type === type) l.fn(e);
      },
    };
    const log: string[] = [];
    /** Every focus() call with its options, as the browser receives them. */
    const calls: Array<{ label: string; options?: { preventScroll?: boolean } }> = [];
    /** Every selector the plugin queried with. */
    const selectors: string[] = [];
    const fakes = new Map<string, Fake>();
    let tree: unknown = null;
    const elementOf = (f: Fake) => all(tree, (el) => fakes.get(keyOf(el)) === f)[0];
    const fakeOf = (el: El): Fake => {
      const k = keyOf(el);
      let f = fakes.get(k);
      if (f === undefined) {
        const self: Fake = {
          label: labelOf(el) || String(el.props.placeholder ?? ""),
          focus: (options?: { preventScroll?: boolean }) => {
            doc.activeElement = self;
            log.push(self.label);
            calls.push({ label: self.label, ...(options !== undefined ? { options } : {}) });
          },
          contains: (o: unknown) => {
            const me = elementOf(self);
            return o === self || (me !== undefined && all(me, (x) => fakes.get(keyOf(x)) === o).length > 0);
          },
          querySelectorAll: (selector: string) => {
            selectors.push(selector);
            const me = elementOf(self);
            return me === undefined ? [] : all(me, (x) => x !== me && matches(webDomOf(x), selector)).map(fakeOf);
          },
          getAttribute: (name: string) => {
            const me = elementOf(self);
            return me === undefined ? null : (webDomOf(me).attrs[name] ?? null);
          },
          hasAttribute: (name: string) => {
            const me = elementOf(self);
            return me !== undefined && name in webDomOf(me).attrs;
          },
          getClientRects: () => [{}],
        };
        f = self;
        fakes.set(k, f);
      }
      return f;
    };
    /** Attaches fakes to every ref of the tree, as React Native Web attaches DOM nodes; as React does on unmount, a ref whose element left the tree is set to null. */
    let attached = new Set<unknown>();
    const attach = (t: unknown) => {
      tree = t;
      const els = all(t).filter((el) => el.props.ref != null);
      const now = new Set<unknown>(els.map((el) => el.props.ref));
      // React detaches first (an old callback ref, or an object ref whose element left, gets null),
      // then attaches the current refs.
      for (const ref of attached) {
        if (now.has(ref)) continue;
        if (typeof ref === "object" && ref !== null) (ref as { current: unknown }).current = null;
        else if (typeof ref === "function") (ref as (v: unknown) => void)(null);
      }
      for (const el of els) {
        if (typeof el.props.ref === "object") el.props.ref.current = fakeOf(el);
        else if (typeof el.props.ref === "function") el.props.ref(fakeOf(el));
      }
      attached = now;
    };
    return { doc, log, calls, selectors, attach, fakeOf };
  }

  /** The chain from the outermost element to `target`. */
  function pathTo(root: unknown, target: El): El[] {
    const found: El[] = [];
    const walk = (n: unknown, path: El[]): boolean => {
      if (Array.isArray(n)) return n.some((x) => walk(x, path));
      if (!n || typeof n !== "object" || !(n as El).props || isClosedModal(n as El)) return false;
      const el = n as El;
      if (el === target) {
        found.push(...path, el);
        return true;
      }
      return walk(el.props.children, [...path, el]);
    };
    walk(root, []);
    return found;
  }

  /**
   * A keydown on `target`, bubbling as on the host: from the target up through its ancestors, but not
   * past an open host `Modal`. The compact sheet renders its content through the bottom sheet's portal
   * host elsewhere in the React tree (RN Web recheck at 23d65c8: an Escape handler on the Map's root
   * never saw a key pressed in the Find question sheet), so only handlers inside the sheet's content
   * receive the event. The page's document listeners receive it last, unless propagation stopped.
   */
  function keyDown(root: unknown, target: El, key: string, shiftKey = false) {
    let prevented = false;
    let stopped = false;
    const event = {
      key,
      shiftKey,
      nativeEvent: { key, shiftKey },
      target: dom.fakeOf(target),
      preventDefault: () => void (prevented = true),
      stopPropagation: () => void (stopped = true),
      isDefaultPrevented: () => prevented,
      isPropagationStopped: () => stopped,
    };
    // React Native Web's TextInput handles keydown itself: it calls stopPropagation() first and then
    // only the input's onKeyPress (Paseo 0.15.3 web bundle; its own handler replaces any onKeyDown
    // prop). RN Web recheck at c850460: Escape and Shift+Tab in the Find filter never reached the
    // sheet's scope. A key in a text input reaches nothing but the input's onKeyPress.
    if (typeof target.props.onChangeText === "function") {
      target.props.onKeyPress?.(event);
      return { prevented };
    }
    target.props.onKeyPress?.(event);
    const path = pathTo(root, target);
    const sheetAt = path.map((el) => nameOf(el) === "Modal").lastIndexOf(true);
    for (const el of path.slice(sheetAt + 1).reverse()) {
      if (stopped) break;
      el.props.onKeyDown?.(event);
    }
    if (!stopped) dom.doc.dispatch("keydown", event);
    return { prevented };
  }

  let dom: ReturnType<typeof fakeDom>;
  beforeEach(() => {
    dom = fakeDom();
    vi.stubGlobal("document", dom.doc);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** Puts focus on `el` the way the browser does: the element becomes active and gets onFocus. */
  async function focusOn(s: Screen, el: El): Promise<Node> {
    dom.fakeOf(el).focus();
    el.props.onFocus?.({ nativeEvent: {} });
    await flush();
    const t = s.render();
    dom.attach(t);
    return t;
  }
  const chatSheet = (t: unknown) => one(all(t, (el) => nameOf(el) === "Modal" && el.props.open !== false && controls(el, /^(✓ )?Map$/).length > 0), "the Chat sheet");
  const findSheet = (t: unknown) => one(all(t, (el) => nameOf(el) === "Modal" && el.props.open !== false && el.props.title === "Find question"), "the Find question sheet");
  /** The menu's enabled items in Tab order. */
  const menuItems = (t: unknown) => all(chatSheet(t), (el) => typeof el.props.onPress === "function" && !isDisabled(el));

  async function openChatSheet() {
    const s = await openScreen({ compact: true });
    dom.attach(s.render());
    await press(trigger(s.render()));
    dom.attach(s.render());
    // Let the sheet's own focus on open settle before the user moves focus, as on the host.
    await flush();
    const t = s.render();
    dom.attach(t);
    return { s, t };
  }

  // RN Web recheck at 320 px: focus entered the sheet on `Grilling`, but Tab after the last item went
  // on to the host header ("Open menu", "Switch tabs"). Plan §2.9: the Chat menu sheet traps focus.
  it("compact Chat sheet: Tab on the last item wraps to the first and does not leave the sheet", async () => {
    const { s, t } = await openChatSheet();
    const items = menuItems(t);
    expect(items.length, "the sheet has several enabled items").toBeGreaterThan(2);
    const first = labelOf(items[0]);
    const after = await focusOn(s, items.at(-1)!);
    const last = menuItems(after).at(-1)!;
    const { prevented } = keyDown(after, last, "Tab");
    expect(prevented, "the browser's own Tab move is cancelled at the last item").toBe(true);
    expect(dom.log.at(-1), "focus wrapped to the first item").toBe(first);
    expect(controls(s.render(), /^(✓ )?Map$/).length, "the sheet stays open").toBe(1);
  });

  it("compact Chat sheet: Shift+Tab on the first item wraps to the last", async () => {
    const { s, t } = await openChatSheet();
    const lastLabel = labelOf(menuItems(t).at(-1)!);
    const after = await focusOn(s, menuItems(t)[0]);
    const { prevented } = keyDown(after, menuItems(after)[0], "Tab", true);
    expect(prevented, "the browser's own Shift+Tab move is cancelled at the first item").toBe(true);
    expect(dom.log.at(-1), "focus wrapped to the last item").toBe(lastLabel);
  });

  it("compact Chat sheet: Tab between items keeps the natural order, and Escape still closes and returns focus", async () => {
    const { s, t } = await openChatSheet();
    let tree = await focusOn(s, menuItems(t)[0]);
    const before = dom.log.length;
    const { prevented } = keyDown(tree, menuItems(tree)[0], "Tab");
    expect(prevented, "a Tab inside the sheet is left to the browser").toBe(false);
    expect(dom.log.length, "no item was focused by the plugin").toBe(before);
    tree = await focusOn(s, menuItems(tree)[1]);
    keyDown(tree, menuItems(tree)[1], "Escape");
    await flush();
    const closed = s.render();
    expect(controls(closed, /^Change chat…$/), "Escape closed the sheet").toEqual([]);
    expect(dom.log.at(-1), "focus is back on the trigger").toBe(labelOf(trigger(closed)));
  });

  async function openFindSheet() {
    const s = await openScreen({ compact: true });
    await press(trigger(s.render()));
    await press(one(controls(chatSheet(s.render()), /^(✓ )?Map$/), "Map"));
    dom.attach(s.render());
    await press(one(controls(s.render(), /^Find question$/), "Find question"));
    const t = s.render();
    dom.attach(t);
    return { s, t };
  }

  // RN Web recheck at 390 px: opening Find question left focus on its trigger behind the sheet.
  it("compact Find question sheet: focus moves to its filter or its first question once the sheet's content is mounted", async () => {
    const { s, t } = await openFindSheet();
    const sheet = findSheet(t);
    const filter = one(inputs(sheet, /Filter/), "the filter");
    const firstRow = all(sheet, (el) => typeof el.props.onPress === "function" && /^Find Q\d/.test(labelOf(el)))[0];
    expect(firstRow, "the sheet lists questions").toBeDefined();
    for (const el of all(sheet, (x) => typeof x.props.onLayout === "function")) el.props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 300, height: 44 } } });
    await flush();
    dom.attach(s.render());
    await flush();
    dom.attach(s.render());
    const wanted = [labelOf(filter) || String(filter.props.placeholder), labelOf(firstRow)];
    const focusedInside = dom.log.some((l) => wanted.includes(l));
    // autoFocus on the filter is the other way RN Web focuses an input when it mounts. On a phone it
    // also raises the software keyboard over the list: a device check either way.
    expect(focusedInside || filter.props.autoFocus === true, `focus reached ${wanted.join(" or ")}`).toBe(true);
  });

  // RN Web recheck at 390 px: closing the sheet with the host's × left focus on the page body.
  it("compact Find question sheet: the host's dismissal closes it and returns focus to Find question", async () => {
    const { s, t } = await openFindSheet();
    const before = dom.log.length;
    findSheet(t).props.onOpenChange(false);
    await flush();
    const after = s.render();
    expect(all(after, (el) => nameOf(el) === "Modal" && el.props.open !== false && el.props.title === "Find question"), "the sheet closed").toEqual([]);
    expect(dom.log.slice(before), "focus returned to the trigger").toContain("Find question");
  });

  it("compact Find question sheet: Escape in the filter closes it and returns focus to Find question", async () => {
    const { s, t } = await openFindSheet();
    const tree = await focusOn(s, one(inputs(findSheet(t), /Filter/), "the filter"));
    const before = dom.log.length;
    keyDown(tree, one(inputs(findSheet(tree), /Filter/), "the filter"), "Escape");
    await flush();
    const after = s.render();
    expect(all(after, (el) => nameOf(el) === "Modal" && el.props.open !== false && el.props.title === "Find question"), "Escape closed the sheet").toEqual([]);
    expect(dom.log.slice(before), "focus returned to the trigger").toContain("Find question");
  });

  // RN Web recheck at 23d65c8: focus lands on the first question, and Escape there left the sheet open.
  it("compact Find question sheet: Escape on a question (where focus lands) closes it and returns focus to Find question", async () => {
    const { s } = await openFindSheet();
    const firstRow = () => all(findSheet(s.render()), (el) => typeof el.props.onPress === "function" && /^Find Q\d/.test(labelOf(el)))[0];
    expect(firstRow(), "the sheet lists questions").toBeDefined();
    const tree = await focusOn(s, firstRow());
    const before = dom.log.length;
    keyDown(tree, all(findSheet(tree), (el) => typeof el.props.onPress === "function" && /^Find Q\d/.test(labelOf(el)))[0], "Escape");
    await flush();
    const after = s.render();
    expect(all(after, (el) => nameOf(el) === "Modal" && el.props.open !== false && el.props.title === "Find question"), "Escape closed the sheet").toEqual([]);
    expect(dom.log.slice(before), "focus returned to the trigger").toContain("Find question");
  });

  // RN Web recheck at 23d65c8: Tab went from the last question to the page body and the host header.
  /** The sheet's focusable controls in Tab order (the host's own header × is outside the content). */
  const sheetFocusables = (sheet: El) => all(sheet, (el) => focusable(el));
  it("compact Find question sheet: Tab on the last question wraps to the sheet's first control", async () => {
    const { s, t } = await openFindSheet();
    const order = sheetFocusables(findSheet(t));
    expect(order.length, "the filter and the questions").toBeGreaterThan(2);
    const first = dom.fakeOf(order[0]).label;
    const tree = await focusOn(s, order.at(-1)!);
    const { prevented } = keyDown(tree, sheetFocusables(findSheet(tree)).at(-1)!, "Tab");
    expect(prevented, "the browser's own Tab move is cancelled at the last question").toBe(true);
    expect(dom.log.at(-1), "focus wrapped to the sheet's first control").toBe(first);
  });

  it("compact Find question sheet: Shift+Tab on the sheet's first control wraps to the last question", async () => {
    const { s, t } = await openFindSheet();
    const order = sheetFocusables(findSheet(t));
    const last = dom.fakeOf(order.at(-1)!).label;
    const tree = await focusOn(s, order[0]);
    const { prevented } = keyDown(tree, sheetFocusables(findSheet(tree))[0], "Tab", true);
    expect(prevented, "the browser's own Shift+Tab move is cancelled at the first control").toBe(true);
    expect(dom.log.at(-1), "focus wrapped to the last question").toBe(last);
  });

  // KensAI 01a1c636 c0125: the scope's own browser query (its selector, evaluated over the DOM React
  // Native Web renders) finds the filter and every question, in order, and nothing the browser would
  // skip.
  it("compact Find question sheet: the scope's selector, evaluated over React Native Web's DOM, finds the filter and the questions", async () => {
    const { s, t } = await openFindSheet();
    // Tab on the last question makes the scope query its controls.
    const tree = await focusOn(s, sheetFocusables(findSheet(t)).at(-1)!);
    keyDown(tree, sheetFocusables(findSheet(tree)).at(-1)!, "Tab");
    expect(dom.selectors.length, "the scope queried the DOM with a selector").toBeGreaterThan(0);
    const selector = dom.selectors.at(-1)!;
    const sheet = findSheet(s.render());
    const scope = one(all(sheet, (el) => el.props.accessibilityLabel === "Find question" && nameOf(el) === "View" && el.props.onKeyDown !== undefined), "the sheet's focus scope");
    const found = dom.fakeOf(scope).querySelectorAll(selector).map((f) => f.label);
    expect(found[0], "the filter first").toBe("Filter questions");
    expect(found.length, "the filter and the rows").toBeGreaterThan(2);
    expect(found.slice(1).every((l) => /^Find /.test(l)), found.join(" | ")).toBe(true);
    expect(found, "the same controls as the sheet's own, in order").toEqual(sheetFocusables(sheet).map((el) => dom.fakeOf(el).label));
    // A control React Native Web renders with tabindex -1 is not offered to Tab.
    expect(found.some((l) => l === ""), "no unlabelled element").toBe(false);
  });

  // KensAI 01a1c636 c0127: with a filter that matches nothing, the sheet holds only the filter. The
  // filter reports keys only to its own onKeyPress (React Native Web's TextInput stops keydown), so the
  // scope never sees Tab there; with no question to wrap to, the browser's own Tab or Shift+Tab move
  // takes focus out of the sheet (to the host's sheet chrome or the page behind it).
  async function emptyFind() {
    const { s } = await openFindSheet();
    const filter = one(inputs(findSheet(s.render()), /Filter questions/), "the filter");
    filter.props.onChangeText("zz no question has this title");
    await flush();
    const t = s.render();
    dom.attach(t);
    expect(sheetFocusables(findSheet(t)).map((el) => dom.fakeOf(el).label), "only the filter is left").toEqual(["Filter questions"]);
    const tree = await focusOn(s, one(inputs(findSheet(t), /Filter questions/), "the filter"));
    return { s, tree, filter: one(inputs(findSheet(tree), /Filter questions/), "the filter") };
  }

  it("compact Find question sheet with no results: Tab in the filter keeps focus in the sheet", async () => {
    const { tree, filter } = await emptyFind();
    const { prevented } = keyDown(tree, filter, "Tab");
    expect(prevented, "the browser's own Tab move out of the sheet is cancelled").toBe(true);
    expect(dom.doc.activeElement?.label, "focus stays on the filter").toBe("Filter questions");
  });

  it("compact Find question sheet with no results: Shift+Tab in the filter keeps focus in the sheet", async () => {
    const { tree, filter } = await emptyFind();
    const { prevented } = keyDown(tree, filter, "Tab", true);
    expect(prevented, "the browser's own Shift+Tab move out of the sheet is cancelled").toBe(true);
    expect(dom.doc.activeElement?.label, "focus stays on the filter").toBe("Filter questions");
  });

  // RN Web host check at 7555b64 (docs/reviews/2026-11-10-r7-c0126-c0127-host-check.md): the filter
  // keeps its text when the sheet closes, so reopening Find question after a filter that matched nothing
  // opens a sheet with no question in it. The sheet moves focus to its first question once its content
  // is laid out; with none there, focus stayed on Find question behind the sheet, and Tab went on
  // through the map behind it ("Zoom in here"). On open with no matching question, focus must move into
  // the sheet, to the filter, without scrolling the page; Tab, Escape and the focus return stay as they
  // are. With matching questions, the first one still takes focus (the filter would raise a phone's
  // keyboard over the list).
  /** The sheet's content laid out, as the host's bottom sheet does once it has opened. */
  async function layOut(s: Screen) {
    for (const el of all(findSheet(s.render()), (x) => typeof x.props.onLayout === "function")) el.props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 300, height: 44 } } });
    await flush();
    dom.attach(s.render());
    await flush();
    const t = s.render();
    dom.attach(t);
    return t;
  }
  /** Find question opened, the filter set to `text`, the sheet closed with Escape in the filter, then opened again. */
  async function reopenAfter(text: string) {
    const { s } = await openFindSheet();
    one(inputs(findSheet(s.render()), /Filter questions/), "the filter").props.onChangeText(text);
    await flush();
    let tree = s.render();
    dom.attach(tree);
    tree = await focusOn(s, one(inputs(findSheet(tree), /Filter questions/), "the filter"));
    keyDown(tree, one(inputs(findSheet(tree), /Filter questions/), "the filter"), "Escape");
    await flush();
    tree = s.render();
    dom.attach(tree);
    expect(all(tree, (el) => nameOf(el) === "Modal" && el.props.open !== false && el.props.title === "Find question"), "the sheet closed").toEqual([]);
    expect(dom.doc.activeElement?.label, "focus returned to Find question").toBe("Find question");
    const before = dom.calls.length;
    await press(one(controls(tree, /^(✓ )?Find question$/), "Find question"));
    dom.attach(s.render());
    const t = await layOut(s);
    expect(one(inputs(findSheet(t), /Filter questions/), "the filter").props.value, "the filter kept its text").toBe(text);
    return { s, t, moves: dom.calls.slice(before) };
  }

  it("compact Find question sheet reopened with a filter that matches nothing: focus moves to the filter, without scrolling", async () => {
    const { t, moves } = await reopenAfter("zz no question has this title");
    expect(sheetFocusables(findSheet(t)).map((el) => dom.fakeOf(el).label), "only the filter is in the sheet").toEqual(["Filter questions"]);
    expect(dom.doc.activeElement?.label, "focus is in the sheet, on the filter (not on Find question behind it)").toBe("Filter questions");
    const toFilter = moves.filter((m) => m.label === "Filter questions");
    expect(toFilter.length, "focus was moved to the filter").toBeGreaterThan(0);
    expect(toFilter.every((m) => m.options?.preventScroll === true), "the move does not scroll the page").toBe(true);
  });

  it("compact Find question sheet reopened with no match: Tab and Shift+Tab stay on the filter, Escape closes it and returns focus to Find question", async () => {
    const { s, t } = await reopenAfter("zz no question has this title");
    let tree = await focusOn(s, one(inputs(findSheet(t), /Filter questions/), "the filter"));
    for (const shift of [false, true]) {
      const { prevented } = keyDown(tree, one(inputs(findSheet(tree), /Filter questions/), "the filter"), "Tab", shift);
      expect(prevented, `${shift ? "Shift+Tab" : "Tab"} is kept in the sheet`).toBe(true);
      expect(dom.doc.activeElement?.label).toBe("Filter questions");
    }
    keyDown(tree, one(inputs(findSheet(tree), /Filter questions/), "the filter"), "Escape");
    await flush();
    tree = s.render();
    dom.attach(tree);
    expect(all(tree, (el) => nameOf(el) === "Modal" && el.props.open !== false && el.props.title === "Find question"), "the sheet closed").toEqual([]);
    expect(dom.log.at(-1), "focus returned to Find question").toBe("Find question");
  });

  it("compact Find question sheet reopened with a filter that matches: the first result takes focus, not the filter", async () => {
    const { t, moves } = await reopenAfter("Q2");
    const rows = sheetFocusables(findSheet(t)).map((el) => dom.fakeOf(el).label);
    expect(rows[0], "the filter first").toBe("Filter questions");
    expect(rows.length, "a question matches").toBeGreaterThan(1);
    expect(dom.doc.activeElement?.label, "focus on the first result").toBe(rows[1]);
    expect(moves.some((m) => m.label === "Filter questions"), "the filter is not focused (no keyboard raised)").toBe(false);
    expect(one(inputs(findSheet(t), /Filter questions/), "the filter").props.autoFocus, "no autoFocus on the filter").not.toBe(true);
  });

  it("compact Find question sheet opened the first time: the first question takes focus, not the filter", async () => {
    const { s } = await openFindSheet();
    const before = dom.calls.length;
    const t = await layOut(s);
    const rows = sheetFocusables(findSheet(t)).map((el) => dom.fakeOf(el).label);
    expect(dom.doc.activeElement?.label).toBe(rows[1]);
    expect(dom.calls.slice(before).some((m) => m.label === "Filter questions")).toBe(false);
  });

  // DeepSeek Flash review 01a1c6c1 c0116; RN Web host check at f9c9850 (desktop: focus on <body>
  // after a Find question pick). On a wide layout a pick from Find question, or a List row, unmounts
  // the focused row; a browser then puts focus on the page body unless the view moves it. Focus must
  // be on a control that is still there.
  const stillThere = (tree: unknown) => dom.doc.activeElement !== null && all(tree, (el) => dom.fakeOf(el) === dom.doc.activeElement).length > 0;
  async function openWideMap() {
    const s = await openScreen();
    await press(trigger(s.render()));
    await press(one(controls(s.render(), /^(✓ )?Map$/), "Map"));
    dom.attach(s.render());
    return s;
  }

  // DeepSeek Flash review 01a1c6c1 c0112: Change chat… (Bind chat…) closes the Chat menu, whose items
  // unmount, and opens the planner picker under the header; the menu leaves focus to the picker
  // (choose(…, false)), and the picker moves none. Focus must end on a control that is still there
  // (the picker, or the Chat trigger).
  it("wide: Change chat… leaves focus on a control that is still on the screen", async () => {
    const s = await openScreen();
    dom.attach(s.render());
    await press(trigger(s.render()));
    let t = s.render();
    dom.attach(t);
    // The menu's own focus-in (to its first item) settles first; the user then moves to Change chat….
    for (const el of all(t, (x) => typeof x.props.onLayout === "function" && /^Grilling$/.test(labelOf(x)))) el.props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 200, height: 44 } } });
    await flush();
    t = s.render();
    dom.attach(t);
    t = await focusOn(s, one(controls(t, /^Change chat…$/), "Change chat…"));
    expect(dom.doc.activeElement?.label, "focus on Change chat…").toBe("Change chat…");
    await press(one(controls(t, /^Change chat…$/), "Change chat…"));
    await flush();
    t = s.render();
    dom.attach(t);
    expect(controls(t, /^Change chat…$/), "the menu closed").toEqual([]);
    expect(stillThere(t), `focus is on ${dom.doc.activeElement?.label ?? "nothing"}, which is no longer on the screen`).toBe(true);
  });

  // DeepSeek Flash review 01a1c7df-fec1 c0087: the picker moves focus in, to its first chat, or to
  // Cancel while the chats load or when there is none (client/planner-picker.tsx); the case above only
  // asks for focus somewhere still on the screen.
  for (const [label, entries, expected] of [
    ["no chats (still loading)", undefined, "Cancel"],
    ["two chats", [{ id: "agent-z", title: "Zulu chat" }, { id: "agent-a", title: "Alpha chat" }], "Alpha chat"],
  ] as const) {
    it(`wide: the planner picker takes focus on ${expected} (${label})`, async () => {
      const base = h.state.query;
      h.state.query = (key: unknown[]) =>
        key[3] === "planner-agents"
          ? entries === undefined
            ? { data: undefined, isError: false, isPending: true }
            : { data: entries.map((e) => ({ agent: { id: e.id, provider: "codex", title: e.title, status: "idle" }, project: { projectKey: P } })), isError: false, isPending: false }
          : base(key);
      const s = await openScreen();
      dom.attach(s.render());
      await press(trigger(s.render()));
      let t = s.render();
      dom.attach(t);
      await press(one(controls(t, /^Change chat…$/), "Change chat…"));
      await flush();
      t = s.render();
      dom.attach(t);
      await flush();
      t = s.render();
      dom.attach(t);
      one(all(t, (el) => el.from === "PlannerPicker"), "the planner picker");
      expect(dom.doc.activeElement?.label, "focus moved into the picker").toBe(expected);
    });
  }

  // DeepSeek Flash review 01a1c8d3 c0154: the picker belongs to a session that can be rebound and closes
  // when that stops being true (here the session is closed elsewhere while the picker holds focus).
  // SPEC: the Chat menu trigger takes focus when the picker closes. Focus must not stay on the
  // picker's unmounted control.
  it("wide: the planner picker closing because the session was closed elsewhere leaves focus on the Chat trigger", async () => {
    const s = await openScreen();
    dom.attach(s.render());
    await press(trigger(s.render()));
    let t = s.render();
    dom.attach(t);
    await press(one(controls(t, /^Change chat…$/), "Change chat…"));
    await flush();
    t = s.render();
    dom.attach(t);
    await flush();
    t = s.render();
    dom.attach(t);
    one(all(t, (el) => el.from === "PlannerPicker"), "the planner picker");
    expect(dom.doc.activeElement?.label, "focus in the picker (the situation)").toBe("Cancel");
    // Another tab closes the session; the view is read again.
    const closedView = sessionView({ session: { status: "closed", closures: [{ at: CLOSED_AT, basis: "manual", source: "ui", actor: { kind: "human" } }] } });
    closedView.revision = 8;
    current = { view: closedView };
    h.state.cacheRevision = 8;
    t = s.render();
    dom.attach(t);
    await flush();
    t = s.render();
    dom.attach(t);
    expect(all(t, (el) => el.from === "PlannerPicker"), "the picker closed").toEqual([]);
    // The trigger's label changes with the session's state (a closed session offers no Change chat),
    // and this fake keys a node by role and label, so "still on the screen" is read as the trigger
    // having been focused, not as node identity (a browser keeps the same button).
    expect(String(dom.doc.activeElement?.label ?? ""), `focus is on ${dom.doc.activeElement?.label ?? "nothing"}, not the Chat menu trigger`).toMatch(/^Chat\b/);
    expect(String(dom.calls.at(-1)?.label ?? ""), "the last focus() call went to the trigger").toMatch(/^Chat\b/);
  });

  it("wide: a pick in Find question leaves focus on a control that is still on the screen", async () => {
    const s = await openWideMap();
    await press(one(controls(s.render(), /^(✓ )?Find question$/), "Find question"));
    let t = s.render();
    dom.attach(t);
    const row = one(controls(t, /^Find Q2 /), "the Find row of Q2");
    t = await focusOn(s, row);
    expect(dom.doc.activeElement?.label, "focus on the row").toMatch(/^Find Q2 /);
    await press(one(controls(t, /^Find Q2 /), "the Find row of Q2"));
    t = s.render();
    dom.attach(t);
    expect(controls(t, /^Find Q2 /), "the picker closed").toEqual([]);
    expect(stillThere(t), `focus is on ${dom.doc.activeElement?.label ?? "nothing"}, which is no longer on the screen`).toBe(true);
  });

  // RN Web host check of 0350a60 (product as ac68d90), desktop: with Find question open beside the map,
  // List shows its rows and the picker stays open; a List row pick then left focus on <body> (no focus
  // call was made: the pick's focus waits while Find question is open).
  it("wide: a List row picked while Find question is open leaves focus on a control that is still on the screen", async () => {
    const s = await openWideMap();
    await press(one(controls(s.render(), /^(✓ )?Find question$/), "Find question"));
    await press(one(controls(s.render(), /^(✓ )?List$/), "List"));
    let t = s.render();
    dom.attach(t);
    expect(inputs(t, /Filter questions/).length, "Find question is still open beside the List").toBe(1);
    t = await focusOn(s, one(controls(t, /^Show Q2 .* on the map$/), "the List row of Q2"));
    await press(one(controls(t, /^Show Q2 .* on the map$/), "the List row of Q2"));
    t = s.render();
    dom.attach(t);
    expect(controls(t, /^Show Q2 /), "the List closed").toEqual([]);
    expect(stillThere(t), `focus is on ${dom.doc.activeElement?.label ?? "nothing"}, which is no longer on the screen`).toBe(true);
  });

  it("wide: a List row leaves focus on a control that is still on the screen", async () => {
    const s = await openWideMap();
    await press(one(controls(s.render(), /^(✓ )?List$/), "List"));
    let t = s.render();
    dom.attach(t);
    const row = one(controls(t, /^Show Q2 .* on the map$/), "the List row of Q2");
    t = await focusOn(s, row);
    await press(one(controls(t, /^Show Q2 .* on the map$/), "the List row of Q2"));
    t = s.render();
    dom.attach(t);
    expect(controls(t, /^Show Q2 /), "the List closed").toEqual([]);
    expect(stillThere(t), `focus is on ${dom.doc.activeElement?.label ?? "nothing"}, which is no longer on the screen`).toBe(true);
  });

  // The compact Question detail sheet: RN Web recheck at 23d65c8 found focus on the page body while it
  // was open (after a tap or Enter on a question); closing it returned focus to the node.
  const nodeControls = (tree: unknown) => controls(tree, /^Q\d+ .*, Block \d+, \d+ incoming, \d+ outgoing$/);
  const detailSheet = (t: unknown) => one(all(t, (el) => nameOf(el) === "Modal" && el.props.open !== false && /Comes after/.test(textOf(el))), "the Question detail sheet");
  async function openDetailSheet() {
    const s = await openScreen({ compact: true });
    await press(trigger(s.render()));
    await press(one(controls(chatSheet(s.render()), /^(✓ )?Map$/), "Map"));
    for (let i = 0; i < 6 && !(/\b100\s?%/.test(visibleText(s.render())) && nodeControls(s.render()).some((el) => !isDisabled(el))); i++) {
      const level = Number(/\b(\d+)\s?%/.exec(visibleText(s.render()))?.[1] ?? 0);
      await press(one(controls(s.render(), level < 100 ? /^Zoom in$/ : /^Zoom out$/), "zoom step"));
    }
    dom.attach(s.render());
    const node = one(nodeControls(s.render()).filter((el) => labelOf(el).startsWith("Q3 ")), "node Q3");
    await focusOn(s, node);
    await press(one(nodeControls(s.render()).filter((el) => labelOf(el).startsWith("Q3 ")), "node Q3"));
    const t = s.render();
    dom.attach(t);
    return { s, t, nodeLabel: labelOf(node) };
  }

  it("compact Question detail sheet: focus moves into the sheet once its content is mounted", async () => {
    const { s, t } = await openDetailSheet();
    const inside = sheetFocusables(detailSheet(t)).map((el) => dom.fakeOf(el).label);
    expect(inside.length, "the sheet has controls").toBeGreaterThan(1);
    const before = dom.log.length;
    for (const el of all(detailSheet(t), (x) => typeof x.props.onLayout === "function")) el.props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 300, height: 44 } } });
    await flush();
    dom.attach(s.render());
    await flush();
    dom.attach(s.render());
    expect(dom.log.slice(before).some((l) => inside.includes(l)), `focus reached one of: ${inside.join(", ")}`).toBe(true);
  });

  it("compact Question detail sheet: Tab and Shift+Tab stay inside the sheet", async () => {
    const { s, t } = await openDetailSheet();
    let order = sheetFocusables(detailSheet(t));
    const [first, last] = [dom.fakeOf(order[0]).label, dom.fakeOf(order.at(-1)!).label];
    let tree = await focusOn(s, order.at(-1)!);
    order = sheetFocusables(detailSheet(tree));
    const forward = keyDown(tree, order.at(-1)!, "Tab");
    expect(forward.prevented, "Tab on the last control is cancelled").toBe(true);
    expect(dom.log.at(-1), "Tab wrapped to the first control").toBe(first);
    tree = await focusOn(s, sheetFocusables(detailSheet(s.render()))[0]);
    const backward = keyDown(tree, sheetFocusables(detailSheet(tree))[0], "Tab", true);
    expect(backward.prevented, "Shift+Tab on the first control is cancelled").toBe(true);
    expect(dom.log.at(-1), "Shift+Tab wrapped to the last control").toBe(last);
  });

  it("compact Question detail sheet: Escape inside it closes it, clears the selection and returns focus to the node", async () => {
    const { s, t, nodeLabel } = await openDetailSheet();
    const tree = await focusOn(s, sheetFocusables(detailSheet(t))[0]);
    const before = dom.log.length;
    keyDown(tree, sheetFocusables(detailSheet(tree))[0], "Escape");
    await flush();
    const after = s.render();
    expect(all(after, (el) => nameOf(el) === "Modal" && el.props.open !== false && /Comes after/.test(textOf(el))), "Escape closed the sheet").toEqual([]);
    expect(visibleText(after)).not.toMatch(/Showing Q3/);
    expect(dom.log.slice(before), "focus returned to the node").toContain(nodeLabel);
  });

  // The Finish confirmation opens from a menu item that unmounts with the menu. On compact the host
  // sheet restores no focus, so the plugin must; RN Web recheck at 23d65c8 (desktop) left focus on the
  // page body after Cancel, because the host dialog restores focus to the element that was active when
  // it opened (that item) only if it is still in the document.
  async function openFinishDialog(compact: boolean) {
    const s = await openScreen({ compact });
    dom.attach(s.render());
    await press(trigger(s.render()));
    let t = s.render();
    dom.attach(t);
    await flush();
    t = s.render();
    dom.attach(t);
    const item = one(enabledControls(compact ? chatSheet(t) : t, /^Finish discussion…$/), "Finish discussion…");
    await focusOn(s, item);
    await press(one(enabledControls(compact ? chatSheet(s.render()) : s.render(), /^Finish discussion…$/), "Finish discussion…"));
    t = s.render();
    dom.attach(t);
    await flush();
    t = s.render();
    dom.attach(t);
    // What the host's dialog keeps as its restore target: the element active once the dialog is open.
    const activeAtOpen = dom.doc.activeElement?.label ?? null;
    const dialog = one(all(t, (el) => nameOf(el) === "Modal" && el.props.open !== false && el.props.title === "Finish discussion"), "the Finish dialog");
    return { s, t, dialog, activeAtOpen, triggerLabel: labelOf(trigger(t)) };
  }

  for (const how of ["Cancel", "the host's dismissal"] as const) {
    it(`compact Finish dialog: ${how} closes it and returns focus to the Chat trigger`, async () => {
      const { s, dialog, triggerLabel } = await openFinishDialog(true);
      const before = dom.log.length;
      if (how === "Cancel") await press(one(controls(dialog, /^Cancel$/), "Cancel"));
      else dialog.props.onOpenChange(false);
      await flush();
      const after = s.render();
      expect(all(after, (el) => nameOf(el) === "Modal" && el.props.open !== false && el.props.title === "Finish discussion"), "the dialog closed").toEqual([]);
      expect(dom.log.slice(before), "focus returned to the Chat trigger").toContain(triggerLabel);
      expect(calls("session.finish")).toEqual([]);
    });
  }

  // Wide screens: the host dialog owns its focus (initial focus, Tab trap, Escape, restore). The plugin
  // can only make the restore land somewhere: the Chat trigger is active when the dialog opens (so the
  // host restores to it), or the plugin focuses the trigger after the dialog closes. The host's own
  // restore is modelled, not run, here: the host recheck decides.
  it("wide Finish dialog: Cancel leaves focus on the Chat trigger (host restore target or plugin focus)", async () => {
    const { s, dialog, activeAtOpen, triggerLabel } = await openFinishDialog(false);
    const before = dom.log.length;
    await press(one(controls(dialog, /^Cancel$/), "Cancel"));
    await flush();
    s.render();
    const restoredByHost = activeAtOpen === triggerLabel;
    const focusedByPlugin = dom.log.slice(before).includes(triggerLabel);
    expect(restoredByHost || focusedByPlugin, `the trigger is the host's restore target (active at open: ${String(activeAtOpen)}) or is focused after Cancel`).toBe(true);
  });

  // Wide screens: the Chat menu is a plugin popover, not a host dialog, and is not a focus trap (plan
  // §2.1 asks for focus in on open, return on close, and Escape or an outside press to close it). RN
  // Web recheck at 23d65c8: Tab from the last item moved on to Open chat with the menu still open, and
  // Escape pressed there did not close it. Once focus has left the menu, the menu closes, or Escape
  // from where focus now is closes it; focus is not pulled back into the menu.
  it("wide Chat menu: after focus leaves the open menu, it closes then or on Escape, without pulling focus back in", async () => {
    const s = await openScreen();
    dom.attach(s.render());
    await press(trigger(s.render()));
    let t = s.render();
    dom.attach(t);
    await flush();
    t = s.render();
    dom.attach(t);
    const menuLabels = ["Grilling", "Map", "Finish discussion…", "Change chat…", "Retry"];
    const last = one(controls(t, /^Change chat…$/), "Change chat…");
    t = await focusOn(s, last);
    const openChat = one(controls(t, /^Open chat$/), "Open chat");
    // The browser's Tab: blur on the item, focus on the next control outside the menu.
    const lastNow = one(controls(t, /^Change chat…$/), "Change chat…");
    const outside = dom.fakeOf(openChat);
    lastNow.props.onBlur?.({ nativeEvent: { relatedTarget: outside }, relatedTarget: outside });
    const beforeMove = dom.log.length;
    t = await focusOn(s, openChat);
    const closedOnLeave = controls(t, /^Change chat…$/).length === 0;
    // Closing because focus moved on keeps focus where the user put it (not back on the trigger).
    if (closedOnLeave) expect(dom.log.slice(beforeMove + 1), "focus stays on Open chat").toEqual([]);
    const before = dom.log.length;
    if (!closedOnLeave) keyDown(t, one(controls(t, /^Open chat$/), "Open chat"), "Escape");
    await flush();
    const after = s.render();
    expect(controls(after, /^Change chat…$/), "the menu closed").toEqual([]);
    expect(dom.log.slice(before).filter((l) => menuLabels.includes(l)), "focus was not pulled back into the menu").toEqual([]);
    expect(writes()).toEqual([]);
  });

  // RN Web recheck at c850460: when focus moved into a compact sheet on open, an overflow: hidden host
  // container scrolled (scrollTop 252 of 952 at 320 px, 295 of 1139 at 390 px) and the whole sheet
  // jumped to the top of the viewport, leaving a blank band and hiding the page above it; the Finish
  // sheet, which took no focus, did not move. The likely cause is focus() scrolling its ancestors into
  // view; focus({ preventScroll: true }) is the web's way to move focus without scrolling. These cases
  // pin the option on the focus that moves into a sheet when it opens; that this removes the jump is
  // for the host recheck to show. (A Tab wrap may still scroll the sheet's own list to the control.)
  const openingFocus = (from: number, inside: string[]) => dom.calls.slice(from).filter((c) => inside.includes(c.label));
  async function settle(s: Screen, scope: (t: unknown) => El) {
    for (const el of all(scope(s.render()), (x) => typeof x.props.onLayout === "function")) el.props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 300, height: 44 } } });
    for (let i = 0; i < 2; i++) {
      await flush();
      dom.attach(s.render());
    }
  }

  it("compact Chat sheet: the focus that moves in on open does not scroll the page", async () => {
    const s = await openScreen({ compact: true });
    dom.attach(s.render());
    const from = dom.calls.length;
    await press(trigger(s.render()));
    dom.attach(s.render());
    await settle(s, chatSheet);
    const moved = openingFocus(from, menuItems(s.render()).map(labelOf));
    expect(moved.length, "focus moved into the sheet").toBeGreaterThan(0);
    expect(moved[0].options?.preventScroll, `${moved[0].label} was focused without scrolling`).toBe(true);
  });

  it("compact Find question sheet: the focus that moves in on open does not scroll the page", async () => {
    const s = await openScreen({ compact: true });
    await press(trigger(s.render()));
    await press(one(controls(chatSheet(s.render()), /^(✓ )?Map$/), "Map"));
    dom.attach(s.render());
    const from = dom.calls.length;
    await press(one(controls(s.render(), /^Find question$/), "Find question"));
    dom.attach(s.render());
    await settle(s, findSheet);
    const moved = openingFocus(from, sheetFocusables(findSheet(s.render())).map((el) => dom.fakeOf(el).label));
    expect(moved.length, "focus moved into the sheet").toBeGreaterThan(0);
    expect(moved[0].options?.preventScroll, `${moved[0].label} was focused without scrolling`).toBe(true);
  });

  it("compact Question detail sheet: the focus that moves in on open does not scroll the page", async () => {
    const { s } = await openDetailSheet();
    const from = 0;
    await settle(s, detailSheet);
    const moved = openingFocus(from, sheetFocusables(detailSheet(s.render())).map((el) => dom.fakeOf(el).label));
    expect(moved.length, "focus moved into the sheet").toBeGreaterThan(0);
    expect(moved[0].options?.preventScroll, `${moved[0].label} was focused without scrolling`).toBe(true);
  });

  // RN Web recheck at c850460: the compact Finish sheet kept focus on the Chat trigger behind it, Tab
  // walked the page behind the sheet and Escape left it open (Cancel, the host's × and a backdrop
  // press did return focus to the trigger). Like the other compact sheets, it must take focus, keep
  // Tab inside and close on Escape, returning focus to the trigger.
  const finishDialog = (t: unknown) => one(all(t, (el) => nameOf(el) === "Modal" && el.props.open !== false && el.props.title === "Finish discussion"), "the Finish dialog");

  it("compact Finish sheet: focus moves in once its content is mounted, without scrolling the page", async () => {
    const { s, dialog } = await openFinishDialog(true);
    const inside = sheetFocusables(dialog).map((el) => dom.fakeOf(el).label);
    expect(inside, "Cancel and Finish discussion").toEqual(expect.arrayContaining(["Cancel", "Finish discussion"]));
    const from = dom.calls.length;
    await settle(s, finishDialog);
    const moved = openingFocus(from, inside);
    expect(moved.length, `focus reached one of: ${inside.join(", ")}`).toBeGreaterThan(0);
    expect(moved[0].options?.preventScroll, `${moved[0].label} was focused without scrolling`).toBe(true);
    expect(calls("session.finish")).toEqual([]);
  });

  it("compact Finish sheet: Tab and Shift+Tab stay inside it", async () => {
    const { s, dialog } = await openFinishDialog(true);
    const order = sheetFocusables(dialog);
    const [first, last] = [dom.fakeOf(order[0]).label, dom.fakeOf(order.at(-1)!).label];
    let tree = await focusOn(s, order.at(-1)!);
    const forward = keyDown(tree, sheetFocusables(finishDialog(tree)).at(-1)!, "Tab");
    expect(forward.prevented, "Tab on the last control is cancelled").toBe(true);
    expect(dom.log.at(-1), "Tab wrapped to the first control").toBe(first);
    tree = await focusOn(s, sheetFocusables(finishDialog(s.render()))[0]);
    const backward = keyDown(tree, sheetFocusables(finishDialog(tree))[0], "Tab", true);
    expect(backward.prevented, "Shift+Tab on the first control is cancelled").toBe(true);
    expect(dom.log.at(-1), "Shift+Tab wrapped to the last control").toBe(last);
    expect(calls("session.finish")).toEqual([]);
  });

  it("compact Finish sheet: Escape inside it closes it without finishing and returns focus to the Chat trigger", async () => {
    const { s, dialog, triggerLabel } = await openFinishDialog(true);
    const tree = await focusOn(s, sheetFocusables(dialog)[0]);
    const before = dom.log.length;
    keyDown(tree, sheetFocusables(finishDialog(tree))[0], "Escape");
    await flush();
    const after = s.render();
    expect(all(after, (el) => nameOf(el) === "Modal" && el.props.open !== false && el.props.title === "Finish discussion"), "Escape closed the sheet").toEqual([]);
    expect(dom.log.slice(before), "focus returned to the Chat trigger").toContain(triggerLabel);
    expect(calls("session.finish")).toEqual([]);
  });

  // RN Web recheck at c850460 (desktop): the full-page layer that closes the open Chat menu on an
  // outside press was in the Tab order (tabIndex 0 although `accessible={false}`), between the trigger
  // and Grilling; Shift+Tab from Grilling focused it, the menu closed, the layer unmounted and focus
  // fell to the page body. A pointer-only layer must stay out of the keyboard order. React Native Web's
  // Pressable (Paseo 0.15.3 web bundle) renders tabIndex from its `tabIndex` prop, else -1 when
  // disabled and 0 otherwise; it never reads `focusable` (recheck at 305ad2d: `focusable={false}`
  // still rendered tabindex="0"). So the layer is either a Pressable with tabIndex -1, or not a
  // Pressable at all.
  it("wide Chat menu: the outside-press layer is not in the keyboard Tab order", async () => {
    const s = await openScreen();
    const t = await openMenu(s);
    const menuItemSet = new Set(controls(t, /^((✓ )?Grilling|(✓ )?Map|Finish discussion…|Change chat…|Bind chat…|Retry\b|Reopen)/));
    const closes = (el: El) => ["onPress", "onClick", "onResponderRelease", "onPointerUp", "onTouchEnd"].some((k) => typeof el.props[k] === "function");
    const named = (el: El) => /close|dismiss/i.test(String(el.props.accessibilityLabel ?? el.props["aria-label"] ?? ""));
    const layers = all(t, (el) => closes(el) && named(el) && !menuItemSet.has(el) && el !== trigger(t));
    expect(layers.length, "the outside-press layer").toBeGreaterThan(0);
    for (const el of layers) {
      const pressable = nameOf(el) === "Pressable";
      expect(!pressable || el.props.tabIndex === -1, `${labelOf(el)} is a Pressable without tabIndex -1 (focusable is ignored on the web)`).toBe(true);
    }
  });
});

// RN Web recheck: switching the emulation from 320 px compact to 1220 px desktop showed the Sessions
// list instead of the open session. Host evidence (Paseo 0.15.3 web bundle, workspace screen): the
// compact layout renders the active tab through the mobile pane model inside FloatingHeaderLayout,
// the wide one through SplitContainer's desktop panes; the two trees differ, so a breakpoint change
// unmounts the plugin panel and mounts it again. The plugin keeps its screen stack in component state
// (ProjectRoadmap), so the remount starts at the overview. The host passes workspace panels a
// `tab: { state, setState, setModified }` prop kept in its tab layout store (not declared by the
// pinned 0.12 SDK types), which outlives the remount. These cases mount the panel twice with fresh
// hook state, as the host does, and share one tab.
describe("W8 recheck: a host remount keeps the open session", () => {
  async function panelModule() {
    return (await import(/* @vite-ignore */ String("./panel"))) as { RoadmapPanel: (p: any) => unknown };
  }
  function hostTab() {
    const box: { state: unknown } = { state: undefined };
    const tab = {
      get state() {
        return box.state;
      },
      setState: (v: unknown) => void (box.state = typeof v === "function" ? (v as (p: unknown) => unknown)(box.state) : v),
      setModified: () => undefined,
    };
    return { box, tab };
  }
  const propsFor = (compact: boolean, tab?: unknown) => ({
    theme,
    layout: { compact, platform: "web" },
    host: { id: HOST },
    workspaceId: "w1",
    navigation: { openAgent: () => undefined },
    ...(tab !== undefined ? { tab } : {}),
  });
  const overviewList = (t: unknown) => all(t, (el) => nameOf(el) === "FlatList");
  async function openSession(p: { render(): Node }) {
    const list = one(overviewList(p.render()), "the overview list");
    const item = list.props.renderItem({ item: overview.sessions[0], index: 0 });
    await press(one(controls(item, /Session S/), "the session row"));
  }

  // KensAI 01a1c636 c0124: the tab state is the host's, shared with whatever else keeps data there;
  // saving the screen stack keeps every other key as it was.
  it("saving the screen stack keeps the tab's other keys", async () => {
    const panel = await panelModule();
    const { box, tab } = hostTab();
    box.state = { other: { keep: 1, nested: ["a"] }, flag: true };
    const p = deepMount(panel.RoadmapPanel, propsFor(false, tab));
    await openSession(p);
    p.render();
    await flush();
    const state = box.state as Record<string, unknown>;
    expect(state.other, "a sibling record is unchanged").toEqual({ keep: 1, nested: ["a"] });
    expect(state.flag, "a sibling value is unchanged").toBe(true);
    expect(Object.keys(state).length, "the stack was added beside them").toBe(3);
  });

  for (const [from, to] of [
    [true, false],
    [false, true],
  ] as const) {
    it(`${from ? "compact → wide" : "wide → compact"}: the remounted panel shows the same session, and Back leads to the overview`, async () => {
      const panel = await panelModule();
      const { tab } = hostTab();
      const first = deepMount(panel.RoadmapPanel, propsFor(from, tab));
      await openSession(first);
      trigger(first.render());
      const second = deepMount(panel.RoadmapPanel, propsFor(to, tab));
      const t = second.render();
      expect(overviewList(t), "the remount did not fall back to the overview").toEqual([]);
      trigger(t);
      expect(visibleText(t)).toMatch(/Session S/);
      await press(one(controls(t, /Back/), "Back"));
      expect(overviewList(second.render()).length, "Back leads to the overview").toBe(1);
      expect(writes()).toEqual([]);
    });
  }

  it("a new tab of the panel (no tab state yet) opens on the overview, even after another tab opened a session", async () => {
    const panel = await panelModule();
    const a = hostTab();
    const first = deepMount(panel.RoadmapPanel, propsFor(true, a.tab));
    await openSession(first);
    const b = hostTab();
    const other = deepMount(panel.RoadmapPanel, propsFor(true, b.tab));
    expect(overviewList(other.render()).length, "the new tab starts at the overview").toBe(1);
  });

  it("without the host's tab prop the panel still opens on the overview", async () => {
    const panel = await panelModule();
    const p = deepMount(panel.RoadmapPanel, propsFor(false));
    expect(overviewList(p.render()).length).toBe(1);
    await openSession(p);
    trigger(p.render());
  });
});
