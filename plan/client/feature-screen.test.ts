// Feature detail subset (redesign Stage R1.1, task card §2.5, §2.6), in node. Same minimal harness
// as client/roadmap-screen.test.ts: `react` state hooks are a slot implementation; React Native and
// host UI are inert markers. The REAL FeatureScreen, FeatureForm and useRoadmapMutation run; only
// `useRpc` is replaced, recording each call and answering ok. Child components are not rendered: assertions read element props and invoke their
// handlers. The module under test is loaded per test, so every case is collected while it is missing.
// Limitations: no reconciler, layout, host or native behaviour; this does not prove the live UI.
import { beforeEach, describe, expect, it, vi } from "vitest";

type El = { type: unknown; props: Record<string, any> };
type Call = { name: string; input: Record<string, any> };

const h = vi.hoisted(() => {
  const state = {
    slots: [] as unknown[],
    index: 0,
    dirty: false,
    calls: [] as Array<{ name: string; input: Record<string, any> }>,
    toasts: [] as string[],
    cacheRevision: null as number | null,
    // R4.2 harness additions: query data by key (default {} keeps every R1 test unchanged), RPC
    // answers by contract name, and agent calls (which must never include interrupt or cancel).
    queryData: ((_key: unknown[]) => ({})) as (key: unknown[]) => unknown,
    answers: {} as Record<string, (input: Record<string, any>) => unknown>,
    agentOps: [] as string[],
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
  const marker = (name: string) => Object.assign(() => null, { displayName: name });
  const useRpc = (contract: { name: string }) => (input: Record<string, any>) => {
    state.calls.push({ name: contract.name, input });
    const answer = state.answers[contract.name];
    if (answer) return Promise.resolve(answer(input));
    return Promise.resolve({ ok: true, value: { revision: (input.expectedRevision ?? 0) + 1, featureId: "fNew" } });
  };
  return { state, useState, marker, useRpc };
});

vi.mock("react", async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  const passthrough = { useState: h.useState, useEffect: () => undefined, useCallback: (fn: unknown) => fn, useMemo: (fn: () => unknown) => fn(), useRef: (v: unknown) => ({ current: v }) };
  return { ...real, ...passthrough, default: { ...(real.default as object), ...passthrough } };
});
vi.mock("react-native", () => ({
  FlatList: h.marker("FlatList"),
  KeyboardAvoidingView: h.marker("KeyboardAvoidingView"),
  Platform: { OS: "ios", select: (o: Record<string, unknown>) => o.ios ?? o.default },
  Text: h.marker("Text"),
  View: h.marker("View"),
  Pressable: h.marker("Pressable"),
  ScrollView: h.marker("ScrollView"),
  Switch: h.marker("Switch"),
}));
vi.mock("@getpaseo/plugin/client/react-native", () => ({
  TextInput: h.marker("TextInput"),
  // R4.2 harness completeness: the host scroll primitives P may use for the bounded content region.
  ScrollView: h.marker("PScrollView"),
  FlatList: h.marker("PFlatList"),
  useToast: () => ({ show: (m: string) => void h.state.toasts.push(m), error: (m: string) => void h.state.toasts.push(m) }),
}));
vi.mock("@getpaseo/plugin/client", () => {
  const agent = (id: string) => ({
    id,
    pendingPermissions: [],
    subscribe: () => () => undefined,
    refresh: async () => null,
    send: async () => void h.state.agentOps.push(`send:${id}`),
    interrupt: async () => void h.state.agentOps.push(`interrupt:${id}`),
    cancel: async () => void h.state.agentOps.push(`cancel:${id}`),
  });
  const api = { agents: { ref: agent }, config: { get: async () => ({ revision: "r1", config: { agentProfiles: [] } }) } };
  return { useRpc: h.useRpc, useWorkspace: () => ({}), usePaseo: () => api };
});
// R4.2: the chat and the start dialog are their own tested units; here they are inert markers.
vi.mock("./feature-chat", () => ({ FeatureChat: h.marker("FeatureChat") }));
vi.mock("./start-dialog", async (importOriginal) => ({ ...(await importOriginal<Record<string, unknown>>().catch(() => ({}))), StartDialog: h.marker("StartDialog") }));
vi.mock("@tanstack/react-query", () => ({
  useQuery: (opts: { queryKey?: unknown[] }) => {
    const data = h.state.queryData(opts?.queryKey ?? []);
    return data && typeof data === "object" && "data" in (data) ? data : { data: Object.keys(data as object).length === 0 ? undefined : data, isPending: false, isError: false };
  },
  useQueryClient: () => ({
    getQueryData: (key: unknown[]) => (key.at(-1) === "version" && h.state.cacheRevision !== null ? { status: "ok", revision: h.state.cacheRevision } : undefined),
    getQueriesData: () => [],
    invalidateQueries: async () => undefined,
  }),
}));

const screenPath = "./feature-screen";
const roadmapPath = "./roadmap-screen";
const load = async () => (await import(/* @vite-ignore */ screenPath));
const loadRoadmap = async () => (await import(/* @vite-ignore */ roadmapPath));

const COLORS = { foregroundMuted: "#muted", accent: "#accent", statusWarning: "#warn", statusSuccess: "#success", statusDanger: "#danger" };
const theme = { colors: new Proxy(COLORS as Record<string, string>, { get: (t, k: string) => t[k] ?? "#other" }) } as never;
const HOST = "h1";
const P = "prj_test";
const AT = "2026-10-20T10:00:00.000Z";

beforeEach(() => {
  h.state.calls = [];
  h.state.toasts = [];
  h.state.cacheRevision = null;
  h.state.queryData = () => ({});
  h.state.answers = {};
  h.state.agentOps = [];
});

// ---------------------------------------------------------------------------------------------
// Harness

function feature(id: string, over: Record<string, unknown> = {}) {
  return {
    id, title: `Title ${id}`, description: `About ${id}`, kind: "feature", status: "created", dependsOn: [], relatedTo: [], everStarted: false,
    createdAt: AT, createdBy: { kind: "human" }, coordinatorHistory: [], events: [{ at: AT, actor: { kind: "human" }, kind: "created" }], ...over,
  } as any;
}

/** One mounted component: its own hook slots, re-rendered with whatever props the caller passes. */
function mount(component: (props: any) => unknown, initial: Record<string, unknown>) {
  const slots: unknown[] = [];
  let props = initial;
  const render = (next?: Record<string, unknown>): El => {
    if (next) props = next;
    h.state.slots = slots;
    for (let pass = 0; pass < 20; pass++) {
      h.state.index = 0;
      h.state.dirty = false;
      const tree = component(props) as El;
      if (!h.state.dirty) return tree;
    }
    throw new Error("component did not settle");
  };
  return { render, props: () => props };
}

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
const labelOf = (el: El): string => String(el.props.label ?? el.props.accessibilityLabel ?? textOf(el.props.children) ?? "");
const handlerOf = (el: El) => el.props.onPress ?? el.props.onChange ?? el.props.onValueChange;
/** Every element carrying a handler whose label matches. */
const pressables = (tree: unknown, label: RegExp) => all(tree, (el) => typeof handlerOf(el) === "function" && label.test(labelOf(el)));
const enabled = (els: El[]) => els.filter((el) => !el.props.disabled);
/** Every text in the tree: Text children and element labels. */
const isText = (el: El) => (el.type as { displayName?: string })?.displayName === "Text";
/**
 * DeepSeek Flash review 01a1c67a c0036: the text of every element outside the elements `isCell`
 * picks, with each cell's whole subtree left out by structure (a stray line that only repeats a
 * cell's words is still reported).
 */
function textOutside(tree: unknown, isCell: (el: El) => boolean): string {
  const out: string[] = [];
  const walk = (n: unknown, d = 0): void => {
    if (d > 80 || !n || typeof n !== "object") return;
    if (Array.isArray(n)) return n.forEach((x) => walk(x, d + 1));
    const el = n as El;
    if (typeof el.type === "function" && !(el.type as { displayName?: string }).displayName) return walk((el.type as (p: unknown) => unknown)(el.props ?? {}), d + 1);
    if (!el.props) return;
    if (isCell(el)) return;
    out.push([typeof el.props.label === "string" ? el.props.label : "", isText(el) ? textOf(el.props.children) : ""].join(" "));
    walk(el.props.children, d + 1);
  };
  walk(tree);
  return out.join("\n");
}
const allText = (tree: unknown) =>
  all(tree, () => true)
    .map((el) => [typeof el.props.label === "string" ? el.props.label : "", isText(el) ? textOf(el.props.children) : ""].join(" "))
    .join("\n");
const flush = () => new Promise((r) => setTimeout(r, 0));
const press = async (el: El, value: unknown = true) => {
  const fn = handlerOf(el);
  if (el.props.onPress) el.props.onPress();
  else fn(value);
  await flush();
};
const calls = (name: string): Call[] => h.state.calls.filter((c) => c.name === name);

function detail(m: any, target: any, features: any[], plans: any[] = [], revision = 7) {
  const opened: string[] = [];
  const plansOpened: string[] = [];
  const s = mount(m.FeatureScreen, {
    hostId: HOST, projectId: P, theme, compact: false, feature: target, features, plans, revision,
    onOpenFeature: (id: string) => void opened.push(id), onOpenPlan: (id: string) => void plansOpened.push(id), onBack: () => undefined,
  });
  return { ...s, opened, plansOpened };
}
const plan = (id: string, featureId?: string) => ({ id, title: `Plan ${id}`, latestRev: 1, approval: "unapproved", ...(featureId ? { featureId } : {}) });


// ---------------------------------------------------------------------------------------------

describe("boundPlans and eventText (§2.5)", () => {
  it("boundPlans keeps the plans bound to the feature, in list order", async () => {
    const m = await load();
    const plans = [plan("p1", "f"), plan("p2"), plan("p3", "g"), plan("p4", "f")];
    expect(m.boundPlans(plans, "f").map((p: any) => p.id)).toEqual(["p1", "p4"]);
    expect(m.boundPlans(plans, "none")).toEqual([]);
  });

  it("eventText: status with labels, reorder positions 1-based, fixed text for the rest, actor you or agent", async () => {
    const m = await load();
    const list = [feature("a")];
    const human = { kind: "human" };
    const agent = { kind: "agent", agentId: "ag1" };
    const status = m.eventText({ at: AT, actor: human, kind: "status", from: "planned", to: "deferred" }, list);
    expect(status).toContain("Status: Planned → Deferred");
    expect(status).toContain("you");
    const moved = m.eventText({ at: AT, actor: agent, kind: "reordered", from: "0", to: "2" }, list);
    expect(moved).toContain("Moved from position 1 to 3");
    expect(moved).toContain("agent");
    for (const kind of ["created", "updated", "dependencies"]) {
      const a = m.eventText({ at: AT, actor: human, kind }, list);
      const b = m.eventText({ at: AT, actor: human, kind }, [feature("a"), feature("b")]);
      expect(typeof a).toBe("string");
      expect(a.length, kind).toBeGreaterThan(0);
      expect(a).toBe(b);
    }
    const kinds = ["created", "updated", "dependencies"].map((kind) => m.eventText({ at: AT, actor: human, kind }, list));
    expect(new Set(kinds).size).toBe(3);
  });
});

describe("FeatureScreen (§2.5)", () => {
  const history = [
    { at: AT, actor: { kind: "human" }, kind: "created" },
    { at: AT, actor: { kind: "agent", agentId: "ag1" }, kind: "reordered", from: "1", to: "0" },
    { at: AT, actor: { kind: "human" }, kind: "status", from: "created", to: "deferred" },
  ];

  it("shows the header, the history oldest first, dependency and relation titles that open the feature", async () => {
    const m = await load();
    const target = feature("t", { title: "Target", kind: "bug", status: "executing", statusReason: "in review", dependsOn: ["a"], relatedTo: ["b"], events: history });
    const list = [feature("a", { title: "Alpha" }), feature("b", { title: "Beta" }), target];
    const s = detail(m, target, list);
    const tree = s.render();
    const text = allText(tree);
    for (const x of ["Target", "Executing", "in review"]) expect(text, x).toContain(x);
    const lines = history.map((e) => m.eventText(e, list));
    const positions = lines.map((l: string) => text.indexOf(l));
    for (const p of positions) expect(p).toBeGreaterThanOrEqual(0);
    expect([...positions].sort((x, y) => x - y)).toEqual(positions);
    await press(pressables(tree, /Alpha/)[0]);
    await press(pressables(s.render(), /Beta/)[0]);
    expect(s.opened).toEqual(["a", "b"]);
    expect(h.state.calls).toEqual([]);
  });

  it("lists only the bound plans, each opening its plan; No plan yet when none is bound", async () => {
    const m = await load();
    const target = feature("t");
    const s = detail(m, target, [target], [plan("p1", "t"), plan("p2"), plan("p3", "other")]);
    const tree = s.render();
    const text = allText(tree);
    expect(text).toContain("Plan p1");
    expect(text).not.toContain("Plan p2");
    expect(text).not.toContain("Plan p3");
    expect(text).not.toContain("No plan yet");
    await press(pressables(tree, /Plan p1/)[0]);
    expect(s.plansOpened).toEqual(["p1"]);
    const empty = detail(m, target, [target], [plan("p2"), plan("p3", "other")]).render();
    expect(allText(empty)).toContain("No plan yet");
  });

  // R4.2 (root-authorised replacement of the R1.1 "no run, task, chat, start" test): run, task, chat
  // and start controls now exist, but without a bound plan whose latest revision is currently approved
  // nothing can start, no run write is offered, and no "built"/progress claim is invented. The R1
  // positive control (exactly one Edit) is kept.
  it("without a currently approved bound plan nothing starts, no run write or agent stop is offered, and no built/progress claim appears", async () => {
    const m = await load();
    for (const status of ["created", "planned", "executing", "done", "deferred", "cancelled"]) {
      h.state.calls = [];
      const target = feature("t", { status, ...(status === "deferred" ? { statusBeforeDefer: "planned" } : {}) });
      const tree = detail(m, target, [target], [plan("p1", "t")]).render();
      const labels = deep(tree).filter((el) => typeof handlerOf(el) === "function").map(labelOf);
      for (const l of labels) expect(l, status).not.toMatch(/\b(interrupt|kill)\b|cancel agent|stop agent/i);
      expect(enabled(deepPress(tree, /^Start/i)), `${status}: Start is not enabled`).toEqual([]);
      // Run pause/resume only (the R1 feature action "Resume" for a deferred feature is a status action).
      expect(deepPress(tree, /^(Pause|Resume) run\b/i), status).toEqual([]);
      // The stage cells' own state words (e.g. "In progress" on Questions) describe stages, not a build.
      const isCell = (el: El) => typeof el.props.accessibilityLabel === "string" && /^(Questions|Plan|Tasks|Execution): /.test(el.props.accessibilityLabel);
      const cells = deep(tree).filter(isCell);
      const outside = textOutside(tree, isCell);
      expect(cells.length, status).toBe(4);
      expect(outside, status).not.toMatch(/\bbuilt\b|not built|progress/i);
      // Positive control: the screen does offer Edit.
      expect(pressables(tree, /^edit$/i).length, status).toBe(1);
      expect(h.state.calls.filter((c) => c.name.startsWith("run.") || c.name === "task.accept"), status).toEqual([]);
    }
  });

  it("Edit opens the edit form for this feature pinned to the rendered revision", async () => {
    const m = await load();
    const r = await loadRoadmap();
    const target = feature("t");
    const s = detail(m, target, [target], [], 13);
    await press(pressables(s.render(), /^edit$/i)[0]);
    const forms = all(s.render(), (el) => el.type === r.FeatureForm);
    expect(forms.length).toBe(1);
    expect(forms[0].props).toMatchObject({ mode: "edit", revision: 13 });
    expect(forms[0].props.feature.id).toBe("t");
  });

  it("defer from the detail screen sends feature.status.set with the rendered revision", async () => {
    const m = await load();
    const target = feature("t", { status: "planned" });
    const s = detail(m, target, [target], [], 21);
    h.state.cacheRevision = 99;
    const defer = enabled(pressables(s.render(), /^defer$/i));
    expect(defer.length).toBe(1);
    await press(defer[0]);
    expect(calls("feature.status.set").map((c) => c.input)).toEqual([{ featureId: "t", status: "deferred", projectId: P, expectedRevision: 21 }]);
  });

  it("Create removal feature exists only for a done feature and opens a create form with the removal title and relatedTo", async () => {
    const m = await load();
    const r = await loadRoadmap();
    const notDone = feature("t", { status: "executing" });
    expect(pressables(detail(m, notDone, [notDone]).render(), /^Create removal feature$/)).toEqual([]);
    const done = feature("d", { title: "Old export", status: "done" });
    const s = detail(m, done, [done], [], 30);
    await press(pressables(s.render(), /^Create removal feature$/)[0]);
    const forms = all(s.render(), (el) => el.type === r.FeatureForm);
    expect(forms.length).toBe(1);
    expect(forms[0].props).toMatchObject({ mode: "create", revision: 30, initial: { title: "Remove: Old export", relatedTo: ["d"] } });
    expect(h.state.calls).toEqual([]);

    // The form the screen opened sends a normal create; nothing targets the done feature.
    const f = mount(r.FeatureForm, forms[0].props);
    const submit = enabled(pressables(f.render(), /^(create|save|create feature|save feature)$/i));
    expect(submit.length).toBe(1);
    await press(submit[0]);
    const sent = h.state.calls.map((c) => c.input);
    expect(h.state.calls.map((c) => c.name)).toEqual(["feature.create"]);
    expect(sent[0]).toMatchObject({ title: "Remove: Old export", relatedTo: ["d"], projectId: P, expectedRevision: 30 });
    expect(sent[0]).not.toHaveProperty("featureId");
    expect(sent[0]).not.toHaveProperty("dependsOn");
    for (const c of h.state.calls) expect(c.input.featureId).toBeUndefined();

    // On success the real form calls the screen's onDone, which opens the new feature.
    expect(s.opened).toEqual(["fNew"]);
  });
});

// Stage R3.4 (task card 2026-10-29 R3 §5.1): eventText renders a note event with its actual reason.
describe("R3.4 note events in eventText", () => {
  it("shows the note's reason; different reasons give different text", async () => {
    const m = await load();
    const list = [feature("a")];
    const reason = "delegated start skipped: no coordinator profile configured";
    const text = m.eventText({ at: AT, actor: { kind: "human" }, kind: "note", reason }, list);
    expect(text).toContain(reason);
    const other = m.eventText({ at: AT, actor: { kind: "human" }, kind: "note", reason: "orphan coordinator agent agent-9 could not be archived" }, list);
    expect(other).toContain("agent-9");
    expect(other).not.toBe(text);
  });
});

// ---- Stage R4.2 (task card 2026-10-29 R4 §3 "Layout and integration", truth sources) ----
// FeatureScreen's props are unchanged; it reads runs, the bound plan and profiles through the hooks
// (real hooks here; `useQuery` answers by key). Children are expanded for these tests (the R1 tests
// above read element props only). FeatureChat and StartDialog are inert markers. Node style checks do
// not prove the absence of overflow on a device.
const deep = (tree: unknown): El[] => {
  const out: El[] = [];
  const walk = (n: unknown, d = 0): void => {
    if (d > 80 || !n || typeof n !== "object") return;
    if (Array.isArray(n)) return n.forEach((x) => walk(x, d + 1));
    const el = n as El;
    if (typeof el.type === "function" && !(el.type as { displayName?: string }).displayName) return walk((el.type as (p: unknown) => unknown)(el.props ?? {}), d + 1);
    if (el.props) out.push(el);
    walk(el.props?.children, d + 1);
    if (Array.isArray(el.props?.data) && typeof el.props?.renderItem === "function") el.props.data.forEach((item: unknown, index: number) => walk(el.props.renderItem({ item, index }), d + 1));
  };
  walk(tree);
  return out;
};
const deepText = (tree: unknown) => deep(tree).map((el) => [typeof el.props.label === "string" ? el.props.label : "", isText(el) ? textOf(el.props.children) : ""].join(" ")).join("\n");
const deepPress = (tree: unknown, label: RegExp) => deep(tree).filter((el) => typeof handlerOf(el) === "function" && label.test(labelOf(el)));
const named = (tree: unknown, name: string) => deep(tree).filter((el) => (el.type as { displayName?: string })?.displayName === name);

describe("R4.2 FeatureScreen with runs, tasks, chat and controls", () => {
  const BOUND_PLAN = { id: "plan-1", title: "Rollout", latestRev: 2, approval: "current", featureId: "f1" };
  const v2Task = (id: string, title: string, over: Record<string, unknown> = {}) => ({ id, title, description: "", dependsOn: [], parallel: false, completion: "auto", grill: false, dod: "x", ...over });
  const PLAN_VIEW = {
    revision: 9,
    plan: {
      id: "plan-1", title: "Rollout", featureId: "f1", sessionIds: ["s1"], taskStates: [],
      revisions: [{ rev: 2, schema: 2, createdAt: AT, contentHash: "a".repeat(64), markdown: "# R", basedOn: [], decisionSnapshotHash: "b".repeat(64), tasks: [v2Task("t1", "Build the index"), v2Task("t2", "Ship the search", { dependsOn: ["t1"] })] }],
    },
    approvals: [], approval: "current", notCurrentReasons: [], exportWritten: true, blockers: [],
  };
  const runRecord = (token: string, tasks: Array<[string, string]>) => ({
    id: "run-1", featureId: "f1", planId: "plan-1", planRev: 2, runToken: token, state: "running", startAuth: { kind: "ui", at: AT },
    tasks: tasks.map(([taskId, state]) => ({ taskId, state, agentId: "agent-w", failedCycles: 0, extraBudget: 0, unresolved: [] })), acks: [], events: [], lateEvidence: [],
  });
  /** run.list carries an OLD token; run.get the latest: every run write must use run.get's. */
  const withRun = (tasks: Array<[string, string]> = [["t1", "in_progress"], ["t2", "todo"]]) => {
    h.state.cacheRevision = 9;
    h.state.queryData = (key) => {
      const k = JSON.stringify(key);
      if (k.includes('"runs"')) return { revision: 9, runs: [{ run: runRecord("tok-stale", tasks), ready: [], blocked: [] }] };
      if (k.includes('"run"')) return { revision: 9, run: runRecord("tok-latest", tasks), ready: ["t2"], blocked: [] };
      if (k.includes('"plan"')) return PLAN_VIEW;
      if (k.includes('"profiles"')) return [];
      if (k.includes('"version"')) return { revision: 9 };
      return {};
    };
  };
  const coordinated = (status = "executing") => feature("f1", { status, everStarted: true, coordinator: { agentId: "agent-c", workspaceId: "ws-1", boundAt: AT, profileRef: "team-coordinator" } });

  it("wide: the task list (from plan.get + run.get) and FeatureChat side by side, with the run controls", async () => {
    const m = await load();
    withRun();
    const target = coordinated();
    const s = detail(m, target, [target], [BOUND_PLAN], 9);
    const tree = s.render();
    const text = deepText(tree);
    expect(text).toContain("Build the index");
    expect(text).toContain("Ship the search");
    expect(named(tree, "FeatureChat").length).toBe(1);
    expect(named(tree, "FeatureChat")[0].props).toMatchObject({ hostId: HOST, projectId: P });
    expect(deepPress(tree, /^Pause/i).length, "the running run offers Pause").toBeGreaterThanOrEqual(1);
  });

  it("compact: Tasks / Chat / Plan segments switch between the task list and the chat; the R1 sections stay reachable", async () => {
    const m = await load();
    withRun();
    const target = coordinated();
    const s = mount(m.FeatureScreen, {
      hostId: HOST, projectId: P, theme, compact: true, feature: target, features: [target], plans: [BOUND_PLAN], revision: 9,
      onOpenFeature: () => undefined, onOpenPlan: () => undefined, onBack: () => undefined,
    });
    let tree = s.render();
    for (const seg of [/^Tasks$/, /^Chat$/, /^Plan$/]) expect(deepPress(tree, seg).length, String(seg)).toBeGreaterThanOrEqual(1);
    await press(deepPress(tree, /^Chat$/)[0]);
    tree = s.render();
    expect(named(tree, "FeatureChat").length, "Chat shows the coordinator chat").toBe(1);
    expect(deepText(tree)).not.toContain("Build the index");
    await press(deepPress(tree, /^Tasks$/)[0]);
    tree = s.render();
    expect(named(tree, "FeatureChat").length).toBe(0);
    expect(deepText(tree)).toContain("Build the index");
  });

  it("Pause sends run.pause once with run.get's latest token (never the list summary's); a refusal is shown and not retried", async () => {
    const m = await load();
    withRun();
    const target = coordinated();
    h.state.answers["run.pause"] = () => ({ ok: false, error: { code: "run_stale", message: "the run token is stale" } });
    const s = detail(m, target, [target], [BOUND_PLAN], 9);
    await press(deepPress(s.render(), /^Pause/i)[0]);
    const pauses = calls("run.pause");
    expect(pauses).toHaveLength(1);
    expect(pauses[0].input).toMatchObject({ projectId: P, runId: "run-1", runToken: "tok-latest" });
    expect(h.state.toasts.length + (deepText(s.render()).match(/stale/i) ? 1 : 0), "the refusal is visible").toBeGreaterThan(0);
    expect(h.state.agentOps.filter((o) => /^(interrupt|cancel):/.test(o))).toEqual([]);
  });

  // R4 final KensAI c0015: Resume calls exactly run.resume, once, with run.get's latest token.
  it("Resume sends run.resume once with run.get's latest token (never the list summary's)", async () => {
    const m = await load();
    const paused = (token: string) => ({ ...runRecord(token, [["t1", "in_progress"], ["t2", "todo"]]), state: "paused", pauseReason: "owner", pausedAt: AT });
    h.state.cacheRevision = 9;
    h.state.queryData = (key) => {
      const k = JSON.stringify(key);
      if (k.includes('"runs"')) return { revision: 9, runs: [{ run: paused("tok-stale"), ready: [], blocked: [{ code: "run_not_running" }] }] };
      if (k.includes('"run"')) return { revision: 9, run: paused("tok-latest"), ready: [], blocked: [{ code: "run_not_running" }] };
      if (k.includes('"plan"')) return PLAN_VIEW;
      if (k.includes('"profiles"')) return [];
      if (k.includes('"version"')) return { revision: 9 };
      return {};
    };
    const target = coordinated();
    const s = detail(m, target, [target], [BOUND_PLAN], 9);
    const resume = enabled(deepPress(s.render(), /^Resume run$/));
    expect(resume, "the paused run offers Resume run").toHaveLength(1);
    await press(resume[0]);
    const resumes = calls("run.resume");
    expect(resumes).toHaveLength(1);
    expect(resumes[0].input).toMatchObject({ projectId: P, runId: "run-1", runToken: "tok-latest" });
    expect(calls("run.pause")).toEqual([]);
  });

  // R4 final KensAI c0016: an unresolved run read (run.list or run.get pending or failed) is not "no live run":
  // the screen must not say so, nor enable Start or Replace coordinator.
  describe("R4 KensAI c0016: unresolved run reads are unknown, not absent", () => {
    const PENDING = { data: undefined, isPending: true, isError: false };
    const FAILED = { data: undefined, isPending: false, isError: true, error: new Error("run read failed") };
    const LIVE_LIST = { revision: 9, runs: [{ run: runRecord("tok-stale", [["t1", "in_progress"]]), ready: [], blocked: [] }] };
    const serve = (runs: unknown, run: unknown) => {
      h.state.cacheRevision = 9;
      h.state.queryData = (key) => {
        const k = JSON.stringify(key);
        if (k.includes('"runs"')) return runs;
        if (k.includes('"run"')) return run;
        if (k.includes('"plan"')) return PLAN_VIEW;
        if (k.includes('"profiles"')) return [];
        if (k.includes('"version"')) return { revision: 9 };
        return {};
      };
    };
    const cases: Array<[string, unknown, unknown]> = [
      ["run.list pending", PENDING, PENDING],
      ["run.list failed", FAILED, PENDING],
      ["run.get pending for the live run", LIVE_LIST, PENDING],
      ["run.get failed for the live run", LIVE_LIST, FAILED],
    ];
    for (const [label, runs, run] of cases) {
      it(`${label}: no "No live run", Start and Replace coordinator not enabled`, async () => {
        const m = await load();
        serve(runs, run);
        const target = coordinated();
        const tree = detail(m, target, [target], [BOUND_PLAN], 9).render();
        expect(deepText(tree), label).not.toContain("No live run");
        expect(enabled(deepPress(tree, /^Start/)), `${label}: Start`).toEqual([]);
        expect(enabled(deepPress(tree, /^Replace coordinator/)), `${label}: Replace coordinator`).toEqual([]);
      });
    }

    it("control: a resolved run list with no live run says so and keeps Start and Replace coordinator enabled", async () => {
      const m = await load();
      serve({ revision: 9, runs: [] }, PENDING);
      const target = coordinated();
      const tree = detail(m, target, [target], [BOUND_PLAN], 9).render();
      expect(deepText(tree)).toContain("No live run");
      expect(enabled(deepPress(tree, /^Start/))).toHaveLength(1);
      expect(enabled(deepPress(tree, /^Replace coordinator/))).toHaveLength(1);
    });
  });

  it("Accept sends task.accept { runId, runToken (latest), taskId } for a task awaiting acceptance", async () => {
    const m = await load();
    withRun([["t1", "awaiting_acceptance"], ["t2", "todo"]]);
    const target = coordinated();
    const s = detail(m, target, [target], [BOUND_PLAN], 9);
    const accept = deepPress(s.render(), /accept/i);
    expect(accept.length).toBeGreaterThanOrEqual(1);
    await press(accept[0]);
    expect(calls("task.accept")).toHaveLength(1);
    expect(calls("task.accept")[0].input).toMatchObject({ runId: "run-1", runToken: "tok-latest", taskId: "t1" });
  });

  it("Start (no live run, current approval) opens StartDialog in start mode; no run write happens before the dialog", async () => {
    const m = await load();
    h.state.cacheRevision = 9;
    h.state.queryData = (key) => {
      const k = JSON.stringify(key);
      if (k.includes('"runs"')) return { revision: 9, runs: [] };
      if (k.includes('"plan"')) return PLAN_VIEW;
      if (k.includes('"profiles"')) return [];
      return {};
    };
    const target = feature("f1", { status: "planned" });
    const s = detail(m, target, [target], [BOUND_PLAN], 9);
    const start = deepPress(s.render(), /^Start/i);
    expect(start.length).toBeGreaterThanOrEqual(1);
    await press(start[0]);
    const dialogs = named(s.render(), "StartDialog");
    expect(dialogs.length).toBe(1);
    expect(dialogs[0].props).toMatchObject({ hostId: HOST, projectId: P, mode: "start" });
    expect(h.state.calls.filter((c) => c.name.startsWith("run.")), "no write before the dialog").toEqual([]);
  });
});

// ---- R4.2 independent verification (T): payloads, ended runs and the bounded layout ----
describe("R4.2 verification: budget grant, rework, ended runs and layout", () => {
  const BOUND = { id: "plan-1", title: "Rollout", latestRev: 2, approval: "current", featureId: "f1" };
  const task2 = (id: string, title: string, over: Record<string, unknown> = {}) => ({ id, title, description: "", dependsOn: [], parallel: false, completion: "auto", grill: false, dod: "x", ...over });
  const rev = (n: number, tasks: unknown[]) => ({ rev: n, schema: 2, createdAt: AT, contentHash: String(n).repeat(64).slice(0, 64), markdown: "# R", basedOn: [], decisionSnapshotHash: "b".repeat(64), tasks });
  const planView = (approvedLatest: boolean) => ({
    revision: 9,
    plan: { id: "plan-1", title: "Rollout", featureId: "f1", sessionIds: ["s1"], taskStates: [], revisions: [rev(1, [task2("t1", "Old task")]), rev(2, [task2("t1", "Build the index"), task2("t2", "Ship the search", { dependsOn: ["t1"] })])] },
    approvals: approvedLatest ? [{ verified: true, receipt: { planRev: 2 } }] : [], approval: "current", notCurrentReasons: [], exportWritten: true, blockers: [],
  });
  const runRec = (id: string, planRev: number, state: string, token: string, tasks: Array<[string, string, number?]>, extra: Record<string, unknown> = {}) => ({
    id, featureId: "f1", planId: "plan-1", planRev, runToken: token, state, startAuth: { kind: "ui", at: AT },
    tasks: tasks.map(([taskId, st, failed]) => ({ taskId, state: st, agentId: "agent-w", failedCycles: failed ?? 0, extraBudget: 0, unresolved: [] })), acks: [], events: [], lateEvidence: [], ...extra,
  });
  /** run.list lists the given runs with a stale token; run.get answers per runId with the latest token. */
  const serve = (runs: Array<ReturnType<typeof runRec>>, approvedLatest = true) => {
    h.state.cacheRevision = 9;
    h.state.queryData = (key) => {
      const k = JSON.stringify(key);
      if (k.includes('"runs"')) return { revision: 9, runs: runs.map((r) => ({ run: { ...r, runToken: "tok-stale" }, ready: [], blocked: [] })) };
      if (k.includes('"run"')) {
        const r = runs.find((x) => k.includes(`"${x.id}"`));
        return r ? { revision: 9, run: r, ready: [], blocked: [] } : {};
      }
      if (k.includes('"plan"')) return planView(approvedLatest);
      if (k.includes('"profiles"')) return [];
      return {};
    };
  };
  const target = () => feature("f1", { status: "executing", everStarted: true, coordinator: { agentId: "agent-c", workspaceId: "ws-1", boundAt: AT, profileRef: "team-coordinator" } });
  const inputs = (tree: unknown) => deep(tree).filter((el) => typeof el.props.onChangeText === "function");

  it("grant budget sends run.budget.grant once with run.get's token, the task and an integer 1..1000; invalid amounts send nothing", async () => {
    const m = await load();
    serve([runRec("run-1", 2, "running", "tok-latest", [["t1", "ceiling", 3], ["t2", "todo"]])]);
    const t = target();
    const s = detail(m, t, [t], [BOUND], 9);
    for (const bad of ["", "abc", "0", "1001", "2.5", "-3"]) {
      const field = inputs(s.render()).find((el) => !/reason/i.test(String(el.props.placeholder ?? "")));
      expect(field, "a cycles input for the task at its ceiling").toBeDefined();
      field!.props.onChangeText(bad);
      const grant = deepPress(s.render(), /grant/i)[0];
      expect(grant, "a grant control").toBeDefined();
      if (!grant.props.disabled) await press(grant);
      expect(calls("run.budget.grant"), `no grant for ${JSON.stringify(bad)}`).toEqual([]);
    }
    inputs(s.render()).find((el) => !/reason/i.test(String(el.props.placeholder ?? "")))!.props.onChangeText("3");
    await press(deepPress(s.render(), /grant/i)[0]);
    expect(calls("run.budget.grant")).toHaveLength(1);
    expect(calls("run.budget.grant")[0].input).toMatchObject({ runId: "run-1", runToken: "tok-latest", taskId: "t1", cycles: 3 });
  });

  it("stop and rework needs a reason and sends plan.rework { planId, planRev: latest, reason } once", async () => {
    const m = await load();
    serve([runRec("run-1", 2, "running", "tok-latest", [["t1", "in_progress"], ["t2", "todo"]])]);
    const t = target();
    const s = detail(m, t, [t], [BOUND], 9);
    await press(deepPress(s.render(), /rework/i)[0]);
    let send = deepPress(s.render(), /send for rework/i)[0];
    expect(send, "a confirm control").toBeDefined();
    if (!send.props.disabled) await press(send);
    expect(calls("plan.rework"), "no rework without a reason").toEqual([]);
    inputs(s.render()).find((el) => /reason/i.test(String(el.props.placeholder ?? "")))!.props.onChangeText("  Scope changed  ");
    send = deepPress(s.render(), /send for rework/i)[0];
    await press(send);
    expect(calls("plan.rework")).toHaveLength(1);
    expect(calls("plan.rework")[0].input).toMatchObject({ planId: "plan-1", planRev: 2, reason: "Scope changed" });
  });

  it("an ended run of the latest revision shows its end reason and task outcomes with no live action; an older revision's run is never mapped", async () => {
    const m = await load();
    serve([
      runRec("run-old", 1, "ended", "tok-old", [["t1", "verified", 4]], { endReason: "finished" }),
      runRec("run-2", 2, "ended", "tok-ended", [["t1", "verified", 1], ["t2", "in_progress", 2]], { endReason: "cancelled_for_rework" }),
    ]);
    const t = target();
    const s = detail(m, t, [t], [BOUND], 9);
    const tree = s.render();
    const text = deepText(tree);
    expect(text).toMatch(/ended/i);
    expect(text).toMatch(/cancelled for rework/i);
    expect(text).toMatch(/Failed verification cycles: 1/);
    expect(text).toMatch(/Failed verification cycles: 2/);
    expect(text, "the rev-1 run's counters are not mapped onto rev 2").not.toMatch(/Failed verification cycles: 4/);
    for (const re of [/^Pause/i, /^Resume/i, /accept/i, /grant/i]) expect(enabled(deepPress(tree, re)), String(re)).toEqual([]);
    expect(h.state.calls.filter((c) => c.name.startsWith("run.") || c.name === "task.accept")).toEqual([]);
    // Only an older revision's run: the latest revision's tasks stay todo with zero counters.
    serve([runRec("run-old", 1, "ended", "tok-old", [["t1", "verified", 4]], { endReason: "finished" })]);
    const only1 = deepText(detail(m, t, [t], [BOUND], 9).render());
    expect(only1).not.toMatch(/Failed verification cycles: 4/);
  });

  it("compact layout: FeatureScreen owns a bounded content scroll for the tasks, and the run action bar stays outside it (structural evidence only)", async () => {
    const m = await load();
    serve([runRec("run-1", 2, "running", "tok-latest", [["t1", "in_progress"], ["t2", "todo"]])]);
    const t = target();
    const s = mount(m.FeatureScreen, { hostId: HOST, projectId: P, theme, compact: true, feature: t, features: [t], plans: [BOUND], revision: 9, onOpenFeature: () => undefined, onOpenPlan: () => undefined, onBack: () => undefined });
    const tree = s.render();
    const SCROLLS = new Set(["ScrollView", "PScrollView", "RNScrollView", "FlatList", "PFlatList"]);
    const isScroll = (el: El) => SCROLLS.has((el.type as { displayName?: string })?.displayName ?? "");
    // Walk with ancestry (expanding the screen's own components).
    const found: Array<{ el: El; inScroll: boolean }> = [];
    const walk = (n: unknown, inScroll: boolean, d = 0): void => {
      if (d > 80 || !n || typeof n !== "object") return;
      if (Array.isArray(n)) return n.forEach((x) => walk(x, inScroll, d + 1));
      const el = n as El;
      if (typeof el.type === "function" && !(el.type as { displayName?: string }).displayName) return walk((el.type as (p: unknown) => unknown)(el.props ?? {}), inScroll, d + 1);
      if (!el.props) return;
      found.push({ el, inScroll });
      const next = inScroll || isScroll(el);
      walk(el.props.children, next, d + 1);
      if (Array.isArray(el.props.data) && typeof el.props.renderItem === "function") el.props.data.forEach((item: unknown, index: number) => walk(el.props.renderItem({ item, index }), next, d + 1));
      for (const k of ["ListHeaderComponent", "ListFooterComponent"]) if (el.props[k]) walk(el.props[k], next, d + 1);
    };
    walk(tree, false);
    const textIn = (re: RegExp) => found.filter(({ el }) => isText(el) && re.test(textOf(el.props.children)));
    const taskTexts = textIn(/Build the index/);
    expect(taskTexts.length, "the task list renders").toBeGreaterThan(0);
    expect(taskTexts.every((x) => x.inScroll), "the task content scrolls inside FeatureScreen's own bounded region").toBe(true);
    const pause = found.filter(({ el }) => typeof handlerOf(el) === "function" && /^Pause/i.test(labelOf(el)));
    expect(pause.length).toBeGreaterThan(0);
    expect(pause.every((x) => !x.inScroll), "the action bar is outside the scrolling content").toBe(true);
  });
});

// R4.2 final verification (T): with the page ScrollView removed from the feature route, every
// FeatureScreen view must scroll on its own. The edit and removal forms are wrapped in a scroll
// region, and on wide screens the task content scrolls independently of the chat column.
// Node structural evidence only (not real sticky behaviour or the absence of overflow).
describe("R4.2 final verification: forms and the wide layout keep their own scroll regions", () => {
  const SCROLLS = new Set(["ScrollView", "PScrollView", "RNScrollView", "FlatList", "PFlatList"]);
  const nameOf = (el: El) => (el.type as { displayName?: string; name?: string })?.displayName ?? (el.type as { name?: string })?.name ?? "";
  /** Every element with whether a scroll primitive encloses it (expanding the screen's own components unless `stop`). */
  const scan = (tree: unknown, stop: (el: El) => boolean = () => false) => {
    const out: Array<{ el: El; inScroll: boolean }> = [];
    const walk = (n: unknown, inScroll: boolean, d = 0): void => {
      if (d > 80 || !n || typeof n !== "object") return;
      if (Array.isArray(n)) return n.forEach((x) => walk(x, inScroll, d + 1));
      const el = n as El;
      if (!el.props) return;
      if (typeof el.type === "function" && !(el.type as { displayName?: string }).displayName && !stop(el)) return walk((el.type as (p: unknown) => unknown)(el.props ?? {}), inScroll, d + 1);
      out.push({ el, inScroll });
      if (stop(el)) return;
      walk(el.props.children, inScroll || SCROLLS.has(nameOf(el)), d + 1);
    };
    walk(tree, false);
    return out;
  };

  it("Edit and Create removal render their form inside a scroll region", async () => {
    const m = await load();
    for (const [label, status] of [[/^edit$/i, "created"], [/remov/i, "done"]] as const) {
      const target = feature("f1", { status });
      const s = detail(m, target, [target], []);
      const open = pressables(s.render(), label);
      expect(open.length, String(label)).toBeGreaterThanOrEqual(1);
      await press(open[0]);
      const forms = scan(s.render(), (el) => nameOf(el) === "FeatureForm").filter((x) => nameOf(x.el) === "FeatureForm");
      expect(forms.length, `${String(label)} opens the form`).toBe(1);
      expect(forms[0].inScroll, `${String(label)}: the form scrolls`).toBe(true);
    }
  });

  it("wide: the task content scrolls in its own region and the chat column is not inside it", async () => {
    const m = await load();
    h.state.cacheRevision = 9;
    const v2 = { id: "t1", title: "Build the index", description: "", dependsOn: [], parallel: false, completion: "auto", grill: false, dod: "x" };
    h.state.queryData = (key) => {
      const k = JSON.stringify(key);
      if (k.includes('"runs"')) return { revision: 9, runs: [] };
      if (k.includes('"plan"'))
        return { revision: 9, plan: { id: "plan-1", title: "Rollout", featureId: "f1", sessionIds: ["s1"], taskStates: [], revisions: [{ rev: 1, schema: 2, createdAt: AT, contentHash: "a".repeat(64), markdown: "# R", basedOn: [], decisionSnapshotHash: "b".repeat(64), tasks: [v2] }] }, approvals: [], approval: "current", notCurrentReasons: [], exportWritten: true, blockers: [] };
      return {};
    };
    const target = feature("f1", { status: "planned", coordinator: { agentId: "agent-c", workspaceId: "ws-1", boundAt: AT, profileRef: "team-coordinator" } });
    const s = detail(m, target, [target], [{ id: "plan-1", title: "Rollout", latestRev: 1, approval: "current", featureId: "f1" }], 9);
    const all2 = scan(s.render());
    const task = all2.filter(({ el }) => isText(el) && /Build the index/.test(textOf(el.props.children)));
    expect(task.length).toBeGreaterThan(0);
    expect(task.every((x) => x.inScroll), "task content scrolls").toBe(true);
    const chat = all2.filter(({ el }) => nameOf(el) === "FeatureChat");
    expect(chat.length).toBe(1);
    expect(chat[0].inScroll, "the chat column is not inside the content scroll").toBe(false);
    expect(all2.filter(({ el }) => /^Back$/.test(labelOf(el))).every((x) => !x.inScroll), "Back stays outside the content scroll").toBe(true);
  });
});

// Stage R4.3 (task card §4 "Client"): the feature header shows the replacement request from
// `replacementRequested` and the cause feature's title; no request → no line.
describe("R4.3 replacement request header line", () => {
  const cause = () => feature("fA", { title: "Indexer", status: "cancelled" });
  const requested = (state: "requested" | "queued") => feature("f1", { status: "created", replacementRequested: { at: AT, becauseOf: "fA", state } });

  it("requested: 'Replacement plan requested — <cause> was cancelled'", async () => {
    const m = await load();
    const target = requested("requested");
    const text = deepText(detail(m, target, [cause(), target], []).render());
    expect(text).toMatch(/Replacement plan requested\s*[—-]\s*Indexer was cancelled/);
  });

  it("queued: 'Replacement queued until a coordinator is bound'", async () => {
    const m = await load();
    const target = requested("queued");
    const text = deepText(detail(m, target, [cause(), target], []).render());
    expect(text).toContain("Replacement queued until a coordinator is bound");
  });

  it("control: no request, no replacement line", async () => {
    const m = await load();
    const target = feature("f1", { status: "created" });
    expect(deepText(detail(m, target, [cause(), target], []).render())).not.toMatch(/Replacement (plan requested|queued)/);
  });
});

// ======================= Changes = plan revision comparison (R4 card §3.x addendum) =======================
// Pure changesState(bound, planQuery) with six states; compact "Changes" segment and wide "Changes"
// header toggle render RevisionCompare (shown = latest, local compareRev null by default, fallback
// "Choose a revision to compare with revision N."). Read-only: no RPC write, no actions; the header,
// run bar and chat are unchanged. Data comes from the existing usePlan (useQuery by key here).
describe("Changes: changesState and the Changes section", () => {
  const AT2 = "2026-10-29T10:00:00.000Z";
  const t2 = (id: string, title: string) => ({ id, title, description: "", dependsOn: [], parallel: false, completion: "auto", grill: false, dod: "x" });
  const rev = (n: number, tasks: unknown[]) => ({ rev: n, schema: 2, createdAt: AT2, contentHash: String(n).repeat(64).slice(0, 64), markdown: `# R${n}`, basedOn: [], decisionSnapshotHash: "b".repeat(64), tasks });
  const R1 = rev(1, [t2("t1", "Build the index")]);
  const R2 = rev(2, [t2("t1", "Build the index"), t2("t2", "Ship the search")]);
  const view = (revisions: unknown[]) => ({ revision: 9, plan: { id: "plan-1", title: "Rollout", featureId: "f1", sessionIds: ["s1"], taskStates: [], revisions }, approvals: [], approval: "current", notCurrentReasons: [], exportWritten: true, blockers: [] });
  const BOUND1 = [{ id: "plan-1", title: "Rollout", latestRev: 2, approval: "current", featureId: "f1" }];
  const loadState = async () => {
    const m = await load();
    expect(typeof m.changesState, "feature-screen exports changesState").toBe("function");
    return m.changesState as (bound: unknown[], q: Record<string, unknown>) => Record<string, any>;
  };

  it("changesState covers the six states", async () => {
    const changesState = await loadState();
    expect(changesState([], { isPending: false, isError: false })).toEqual({ kind: "no_plan" });
    const two = [BOUND1[0], { ...BOUND1[0], id: "plan-2", title: "Other" }];
    expect(changesState(two, { isPending: false, isError: false })).toMatchObject({ kind: "several_plans", plans: two });
    expect(changesState(BOUND1, { isPending: true, isError: false })).toEqual({ kind: "loading" });
    expect(changesState(BOUND1, { isPending: false, isError: true, error: new Error("plan unreadable") })).toMatchObject({ kind: "error", message: expect.stringContaining("plan unreadable") });
    expect(changesState(BOUND1, { data: view([R1]), isPending: false, isError: false })).toEqual({ kind: "single", rev: 1 });
    const ready = changesState(BOUND1, { data: view([R1, R2]), isPending: false, isError: false });
    expect(ready.kind).toBe("ready");
    expect(ready.latest.rev).toBe(2);
    expect(ready.revisions.map((r: { rev: number }) => r.rev)).toEqual([1, 2]);
  });

  const serveChanges = (revisions: unknown[]) => {
    h.state.cacheRevision = 9;
    h.state.queryData = (key) => {
      const k = JSON.stringify(key);
      if (k.includes('"plan"')) return view(revisions);
      if (k.includes('"runs"')) return { revision: 9, runs: [] };
      return {};
    };
  };
  const coordinated = () => feature("f1", { status: "planned", coordinator: { agentId: "agent-c", workspaceId: "ws-1", boundAt: AT2, profileRef: "team-coordinator" } });

  it("compact: the Changes segment shows latest with no preselected comparison; choosing revision 1 shows 'Changes from revision 1 to 2'; no writes", async () => {
    const m = await load();
    serveChanges([R1, R2]);
    const target = coordinated();
    const s = mount(m.FeatureScreen, { hostId: HOST, projectId: P, theme, compact: true, feature: target, features: [target], plans: BOUND1, revision: 9, onOpenFeature: () => undefined, onOpenPlan: () => undefined, onBack: () => undefined });
    let tree = s.render();
    const seg = deepPress(tree, /^Changes$/);
    expect(seg.length, "a Changes segment").toBeGreaterThanOrEqual(1);
    await press(seg[0]);
    tree = s.render();
    let text = deepText(tree);
    expect(text).toContain("Choose a revision to compare with revision 2.");
    expect(text).not.toContain("Changes from revision");
    const pick = deepPress(tree, /^Compare with revision 1$/);
    expect(pick.length).toBe(1);
    await press(pick[0]);
    tree = s.render();
    text = deepText(tree);
    expect(text).toContain("Changes from revision 1 to 2");
    expect(text).toContain("Ship the search");
    expect(h.state.calls.filter((c) => !/\.(get|list|version)$/.test(c.name)), "read-only").toEqual([]);
  });

  it("compact single revision and no plan render their truthful texts", async () => {
    const m = await load();
    serveChanges([R1]);
    const target = coordinated();
    const props = { hostId: HOST, projectId: P, theme, compact: true, feature: target, features: [target], plans: BOUND1, revision: 9, onOpenFeature: () => undefined, onOpenPlan: () => undefined, onBack: () => undefined };
    let s = mount(m.FeatureScreen, props);
    await press(deepPress(s.render(), /^Changes$/)[0]);
    expect(deepText(s.render())).toContain("Only revision 1 exists; there is nothing to compare yet.");
    s = mount(m.FeatureScreen, { ...props, plans: [] });
    await press(deepPress(s.render(), /^Changes$/)[0]);
    expect(deepText(s.render())).toContain("No plan yet");
  });

  it("wide: a Changes header entry toggles the left region; the chat column and the run bar stay; toggling back shows the tasks", async () => {
    const m = await load();
    serveChanges([R1, R2]);
    const target = coordinated();
    const s = detail(m, target, [target], BOUND1, 9);
    let tree = s.render();
    const toggle = deepPress(tree, /^Changes$/);
    expect(toggle.length, "a Changes header entry").toBeGreaterThanOrEqual(1);
    await press(toggle[0]);
    tree = s.render();
    const text = deepText(tree);
    expect(text).toContain("Choose a revision to compare with revision 2.");
    expect(named(tree, "FeatureChat").length, "the chat column stays").toBe(1);
    expect(deepPress(tree, /^Back$/).length, "Back stays").toBeGreaterThanOrEqual(1);
    expect(deepPress(tree, /^Start/i).length, "the run bar stays").toBeGreaterThanOrEqual(1);
    await press(deepPress(tree, /^Changes$/)[0]);
    expect(deepText(s.render())).not.toContain("Choose a revision to compare with revision 2.");
  });
});

// ---- Changes: independent verification (T) ----
describe("Changes verification: refetch, selection fallback, no cross-plan leak, rendered states", () => {
  const AT3 = "2026-10-29T10:00:00.000Z";
  const t3 = (id: string, title: string) => ({ id, title, description: "", dependsOn: [], parallel: false, completion: "auto", grill: false, dod: "x" });
  const rv = (n: number, tasks: unknown[]) => ({ rev: n, schema: 2, createdAt: AT3, contentHash: String(n).repeat(64).slice(0, 64), markdown: `# R${n}`, basedOn: [], decisionSnapshotHash: "b".repeat(64), tasks });
  const A1 = rv(1, [t3("t1", "Build the index")]);
  const A2 = rv(2, [t3("t1", "Build the index"), t3("t2", "Ship the search")]);
  const A3 = rv(3, [t3("t1", "Build the index"), t3("t2", "Ship the search"), t3("t3", "Measure the search")]);
  const planOf = (planId: string, featureId: string, revisions: unknown[]) => ({ revision: 9, plan: { id: planId, title: `Plan ${planId}`, featureId, sessionIds: ["s1"], taskStates: [], revisions }, approvals: [], approval: "current", notCurrentReasons: [], exportWritten: true, blockers: [] });
  let plans: Record<string, unknown> = {};
  const serve = () => {
    h.state.cacheRevision = 9;
    h.state.queryData = (key) => {
      const k = JSON.stringify(key);
      for (const [planId, v] of Object.entries(plans)) if (k.includes('"plan"') && k.includes(`"${planId}"`)) return v;
      if (k.includes('"runs"')) return { revision: 9, runs: [] };
      return {};
    };
  };
  const featureF = (id: string) => feature(id, { status: "planned", coordinator: { agentId: "agent-c", workspaceId: "ws-1", boundAt: AT3, profileRef: "team-coordinator" } });
  const props = (f: unknown, bound: unknown[]) => ({ hostId: HOST, projectId: P, theme, compact: true, feature: f, features: [f], plans: bound, revision: 9, onOpenFeature: () => undefined, onOpenPlan: () => undefined, onBack: () => undefined });
  const open = async (s: ReturnType<typeof mount>) => press(deepPress(s.render(), /^Changes$/)[0]);

  it("a refetch moving latest 2 → 3 while revision 1 is selected shows 'Changes from revision 1 to 3'", async () => {
    const m = await load();
    plans = { "plan-a": planOf("plan-a", "fa", [A1, A2]) };
    serve();
    const f = featureF("fa");
    const s = mount(m.FeatureScreen, props(f, [{ id: "plan-a", title: "Plan a", latestRev: 2, approval: "current", featureId: "fa" }]));
    await open(s);
    await press(deepPress(s.render(), /^Compare with revision 1$/)[0]);
    expect(deepText(s.render())).toContain("Changes from revision 1 to 2");
    plans = { "plan-a": planOf("plan-a", "fa", [A1, A2, A3]) };
    const text = deepText(s.render());
    expect(text).toContain("Changes from revision 1 to 3");
    expect(text).toContain("Measure the search");
  });

  it("selecting the latest revision itself shows the fallback, not a diff", async () => {
    const m = await load();
    plans = { "plan-a": planOf("plan-a", "fa", [A1, A2]) };
    serve();
    const f = featureF("fa");
    const s = mount(m.FeatureScreen, props(f, [{ id: "plan-a", title: "Plan a", latestRev: 2, approval: "current", featureId: "fa" }]));
    await open(s);
    await press(deepPress(s.render(), /^Compare with revision 2$/)[0]);
    const text = deepText(s.render());
    expect(text).toContain("Choose a revision to compare with revision 2.");
    expect(text).not.toContain("Changes from revision");
  });

  it("a selection made for one bound plan never leaks to another feature's plan in the same screen instance", async () => {
    const m = await load();
    plans = { "plan-a": planOf("plan-a", "fa", [A1, A2]), "plan-b": planOf("plan-b", "fb", [A1, A2]) };
    serve();
    const fa = featureF("fa");
    const s = mount(m.FeatureScreen, props(fa, [{ id: "plan-a", title: "Plan a", latestRev: 2, approval: "current", featureId: "fa" }]));
    await open(s);
    await press(deepPress(s.render(), /^Compare with revision 1$/)[0]);
    expect(deepText(s.render())).toContain("Changes from revision 1 to 2");
    const fb = featureF("fb");
    const text = deepText(s.render(props(fb, [{ id: "plan-b", title: "Plan b", latestRev: 2, approval: "current", featureId: "fb" }])));
    expect(text, "plan-b starts without plan-a's selection").toContain("Choose a revision to compare with revision 2.");
    expect(text).not.toContain("Changes from revision");
  });

  it("rendered several_plans and error states", async () => {
    const m = await load();
    plans = {};
    serve();
    const f = featureF("fa");
    const two = [{ id: "plan-a", title: "Plan alpha", latestRev: 1, approval: "current", featureId: "fa" }, { id: "plan-b", title: "Plan beta", latestRev: 1, approval: "current", featureId: "fa" }];
    let s = mount(m.FeatureScreen, props(f, two));
    await open(s);
    let text = deepText(s.render());
    expect(text).toContain("This feature has several plans; open one to compare its revisions");
    expect(deepPress(s.render(), /^Plan alpha$/).length, "the existing plan buttons").toBeGreaterThanOrEqual(1);
    h.state.queryData = (key) => (JSON.stringify(key).includes('"plan"') ? { isError: true, isPending: false, error: new Error("plan unreadable"), data: undefined } : {});
    s = mount(m.FeatureScreen, props(f, [two[0]]));
    await open(s);
    text = deepText(s.render());
    expect(text).toContain("plan unreadable");
  });
});

// ---- R4 final DeepSeek c0075 / c0076 / c0081 (T): unknown reads are never shown as facts ----
// c0075: while the live run's run.get is pending or failed, task rows must not claim "To do" (no run
// data says so). c0076: while plan.get is pending or failed, the screen must not say "No approved
// tasks yet." nor give Start the approval reason. c0081: with RESOLVED run data (no live run), Start
// is gated by the approval itself, independent of the unknown-run reason. Cached data stays usable.
describe("R4 final DeepSeek: unknown run and plan reads (c0075, c0076) and the approval gate (c0081)", () => {
  const v2Task = (id: string, title: string, over: Record<string, unknown> = {}) => ({ id, title, description: "", dependsOn: [], parallel: false, completion: "auto", grill: false, dod: "x", ...over });
  const BOUND = (approval: string) => ({ id: "plan-1", title: "Rollout", latestRev: 2, approval, featureId: "f1" });
  const planView = (approval: string) => ({
    revision: 9,
    plan: {
      id: "plan-1", title: "Rollout", featureId: "f1", sessionIds: ["s1"], taskStates: [],
      revisions: [{ rev: 2, schema: 2, createdAt: AT, contentHash: "a".repeat(64), markdown: "# R", basedOn: [], decisionSnapshotHash: "b".repeat(64), tasks: [v2Task("t1", "Build the index"), v2Task("t2", "Ship the search", { dependsOn: ["t1"] })] }],
    },
    approvals: [], approval, notCurrentReasons: approval === "current" ? [] : ["synthetic reason"], exportWritten: true, blockers: [],
  });
  const runRecord = (tasks: Array<[string, string]>) => ({
    id: "run-1", featureId: "f1", planId: "plan-1", planRev: 2, runToken: "tok-latest", state: "running", startAuth: { kind: "ui", at: AT },
    tasks: tasks.map(([taskId, state]) => ({ taskId, state, agentId: "agent-w", failedCycles: 0, extraBudget: 0, unresolved: [] })), acks: [], events: [], lateEvidence: [],
  });
  const PENDING = { data: undefined, isPending: true, isError: false };
  const failed = (message: string) => ({ data: undefined, isPending: false, isError: true, error: new Error(message) });
  type Q = Record<string, unknown> | typeof PENDING;
  const serve = (x: { runs: Q; run?: Q; plan: Q }) => {
    h.state.cacheRevision = 9;
    h.state.queryData = (key) => {
      const k = JSON.stringify(key);
      if (k.includes('"runs"')) return x.runs;
      if (k.includes('"run"')) return x.run ?? {};
      if (k.includes('"plan"')) return x.plan;
      if (k.includes('"profiles"')) return [];
      return {};
    };
  };
  const LIVE_LIST = { revision: 9, runs: [{ run: runRecord([["t1", "in_progress"], ["t2", "todo"]]), ready: [], blocked: [] }] };
  const NO_RUNS = { revision: 9, runs: [] };
  const planned = () => feature("f1", { status: "planned" });
  const executing = () => feature("f1", { status: "executing", everStarted: true, coordinator: { agentId: "agent-c", workspaceId: "ws-1", boundAt: AT, profileRef: "team-coordinator" } });
  const render = async (target: any, approval = "current") => detail(await load(), target, [target], [BOUND(approval)], 9).render();

  for (const mode of ["pending", "failed"] as const) {
    it(`c0075: live run.get ${mode}: no task row claims "To do" (or readiness), and no run action is enabled`, async () => {
      serve({ runs: LIVE_LIST, run: mode === "pending" ? PENDING : failed("run store unreadable"), plan: planView("current") });
      const tree = await render(executing());
      const text = deepText(tree);
      expect(text, "the run line is truthful (existing behaviour)").toMatch(mode === "pending" ? /Loading run/ : /Run state unavailable/);
      expect(text, "no task state is claimed from an unknown run").not.toMatch(/\bTo do\b/);
      expect(text).not.toMatch(/\bReady\b/);
      expect(enabled(deepPress(tree, /^(Start|Pause|Resume)/i)), "no run action").toEqual([]);
    });
  }

  it("c0075 controls: a resolved empty run list shows 'To do'; cached run.get data during a failed refetch shows the run's real task states", async () => {
    serve({ runs: NO_RUNS, plan: planView("current") });
    expect(deepText(await render(planned())), "resolved, no run: To do is true").toMatch(/\bTo do\b/);
    serve({ runs: LIVE_LIST, run: { data: { revision: 9, run: runRecord([["t1", "in_progress"], ["t2", "verified"]]), ready: [], blocked: [] }, isPending: false, isError: true, error: new Error("refetch failed") }, plan: planView("current") });
    const cached = deepText(await render(executing()));
    expect(cached).toMatch(/In progress/);
    expect(cached).toMatch(/Verified/);
    expect(cached).not.toMatch(/\bTo do\b/);
  });

  for (const mode of ["pending", "failed"] as const) {
    it(`c0076: plan.get ${mode}: no "No approved tasks yet.", no approval reason for Start, Start disabled${mode === "failed" ? ", and the read error is visible" : ", and a loading text is shown"}`, async () => {
      serve({ runs: NO_RUNS, plan: mode === "pending" ? PENDING : failed("plan store unreadable") });
      const tree = await render(planned());
      const text = deepText(tree);
      expect(text, "the approved tasks are unknown, not absent").not.toContain("No approved tasks yet.");
      expect(text, "the approval is unknown, not 'not current'").not.toMatch(/approval is not current/);
      expect(enabled(deepPress(tree, /^Start/i)), "Start stays disabled while the plan is unknown").toEqual([]);
      if (mode === "failed") expect(text).toMatch(/plan store unreadable/);
      else expect(text).toMatch(/Loading plan|plan.{0,20}(loading|not known)/i);
    });
  }

  it("c0076 controls: a resolved plan with no approval keeps the approval reason; cached plan data during a failed refetch keeps the tasks", async () => {
    serve({ runs: NO_RUNS, plan: planView("unapproved") });
    expect(deepText(await render(planned(), "unapproved"))).toMatch(/Start: the approval is not current/);
    serve({ runs: NO_RUNS, plan: { data: planView("current"), isPending: false, isError: true, error: new Error("refetch failed") } });
    const cached = deepText(await render(planned()));
    expect(cached).toContain("Build the index");
    expect(cached).not.toContain("No approved tasks yet.");
  });

  it("c0081: with a RESOLVED empty run list, a non-current approval alone disables Start with the approval reason; a current one enables it", async () => {
    for (const approval of ["unapproved", "not_current"]) {
      serve({ runs: NO_RUNS, plan: planView(approval) });
      const tree = await render(planned(), approval);
      const text = deepText(tree);
      expect(text, `${approval}: the run state is known`).not.toMatch(/run state is not known/);
      expect(text, `${approval}: the approval gate is the visible reason`).toMatch(/Start: the approval is not current/);
      expect(enabled(deepPress(tree, /^Start/i)), `${approval}: Start disabled`).toEqual([]);
    }
    serve({ runs: NO_RUNS, plan: planView("current") });
    expect(enabled(deepPress(await render(planned()), /^Start/i)).length, "current approval: Start enabled").toBeGreaterThanOrEqual(1);
  });
});

// ---- R4 DeepSeek corrective verification (T): the latest ENDED run's task states ----
// With no live run, the task area shows the latest ended run of this revision. While that run's run.get
// is pending or failed, no task is claimed "To do"; Start keeps following the (known) run list and the
// approval, and no live run action appears. Resolved: its real outcomes. Older revisions never map.
describe("R4 DeepSeek corrective verify: latest ended run of this revision, run.get pending or failed", () => {
  const v2Task = (id: string, title: string) => ({ id, title, description: "", dependsOn: [], parallel: false, completion: "auto", grill: false, dod: "x" });
  const BOUND = { id: "plan-1", title: "Rollout", latestRev: 2, approval: "current", featureId: "f1" };
  const PLAN = {
    revision: 9,
    plan: {
      id: "plan-1", title: "Rollout", featureId: "f1", sessionIds: ["s1"], taskStates: [],
      revisions: [{ rev: 2, schema: 2, createdAt: AT, contentHash: "a".repeat(64), markdown: "# R", basedOn: [], decisionSnapshotHash: "b".repeat(64), tasks: [v2Task("t1", "Build the index"), v2Task("t2", "Ship the search")] }],
    },
    approvals: [], approval: "current", notCurrentReasons: [], exportWritten: true, blockers: [],
  };
  const ended = (planRev: number) => ({
    id: `run-r${planRev}`, featureId: "f1", planId: "plan-1", planRev, runToken: "tok-e", state: "ended", endReason: "cancelled_for_rework", startAuth: { kind: "ui", at: AT },
    tasks: [{ taskId: "t1", state: "verified", agentId: "agent-w", failedCycles: 0, extraBudget: 0, unresolved: [] }, { taskId: "t2", state: "in_progress", agentId: "agent-w", failedCycles: 0, extraBudget: 0, unresolved: [] }],
    acks: [], events: [], lateEvidence: [],
  });
  const serve = (runs: unknown[], run: unknown) => {
    h.state.cacheRevision = 9;
    h.state.queryData = (key) => {
      const k = JSON.stringify(key);
      if (k.includes('"runs"')) return { revision: 9, runs: runs.map((r) => ({ run: r, ready: [], blocked: [] })) };
      if (k.includes('"run"')) return run;
      if (k.includes('"plan"')) return PLAN;
      if (k.includes('"profiles"')) return [];
      return {};
    };
  };
  const planned = () => feature("f1", { status: "planned" });

  for (const mode of ["pending", "failed"] as const) {
    it(`ended run.get ${mode}: no "To do" claim, a truthful task-state line, no live run action, Start still follows the known run list`, async () => {
      serve([ended(2)], mode === "pending" ? { data: undefined, isPending: true, isError: false } : { data: undefined, isPending: false, isError: true, error: new Error("ended run unreadable") });
      const tree = detail(await load(), planned(), [planned()], [BOUND], 9).render();
      const text = deepText(tree);
      expect(text).not.toMatch(/\bTo do\b/);
      expect(text).toMatch(mode === "pending" ? /Loading task states/ : /Task states are unavailable: ended run unreadable/);
      for (const re of [/^Pause/i, /^Resume/i, /accept/i, /grant/i]) expect(enabled(deepPress(tree, re)), String(re)).toEqual([]);
      expect(enabled(deepPress(tree, /^Start/i)).length, "no live run and a current approval: Start stays available").toBeGreaterThanOrEqual(1);
    });
  }

  it("controls: resolved ended run shows its outcomes; only an older revision's ended run leaves the latest tasks 'To do'", async () => {
    serve([ended(2)], { revision: 9, run: ended(2), ready: [], blocked: [] });
    const resolved = deepText(detail(await load(), planned(), [planned()], [BOUND], 9).render());
    expect(resolved).toMatch(/Verified/);
    expect(resolved).toMatch(/In progress/);
    expect(resolved).not.toMatch(/Loading task states|unavailable/);
    serve([ended(1)], { data: undefined, isPending: true, isError: false });
    const older = deepText(detail(await load(), planned(), [planned()], [BOUND], 9).render());
    expect(older, "an older revision's run is never shown, so nothing is pending").toMatch(/\bTo do\b/);
  });
});

// ---- R4 exact-final DeepSeek c0109 (T): more than one bound plan ----
// Duplicate bound plans are a readable stored state on which every write fails closed (R2 c0011). The
// screen must not claim "No approved tasks yet." or an approval verdict it never read; Start and
// Stop-and-rework stay disabled, and the task area says that several plans are bound. Controls: no
// bound plan and a single bound plan keep their current behaviour.
describe("R4 exact-final DeepSeek c0109: several bound plans", () => {
  const v2Task = (id: string, title: string) => ({ id, title, description: "", dependsOn: [], parallel: false, completion: "auto", grill: false, dod: "x" });
  const planView = (approval: string, approved: boolean) => ({
    revision: 9,
    plan: {
      id: "plan-1", title: "Rollout", featureId: "f1", sessionIds: ["s1"], taskStates: [],
      revisions: [{ rev: 2, schema: 2, createdAt: AT, contentHash: "a".repeat(64), markdown: "# R", basedOn: [], decisionSnapshotHash: "b".repeat(64), tasks: [v2Task("t1", "Build the index")] }],
    },
    approvals: approved ? [{ verified: true, receipt: { planRev: 2 } }] : [], approval, notCurrentReasons: approval === "current" ? [] : ["synthetic reason"], exportWritten: true, blockers: [],
  });
  /** plan.get answers only for a real plan id (the hook is disabled for a null id). */
  const serve = (view: unknown) => {
    h.state.cacheRevision = 9;
    h.state.queryData = (key) => {
      const k = JSON.stringify(key);
      if (k.includes('"runs"')) return { revision: 9, runs: [] };
      if (k.includes('"plan"')) return k.includes('"plan-1"') ? view : {};
      if (k.includes('"profiles"')) return [];
      return {};
    };
  };
  const target = (status = "executing") => feature("f1", { status, everStarted: status === "executing" });
  const TWO = [
    { id: "plan-1", title: "Rollout", latestRev: 2, approval: "current", featureId: "f1" },
    { id: "plan-2", title: "Rollout copy", latestRev: 1, approval: "unapproved", featureId: "f1" },
  ];

  it("two bound plans (one approved), resolved empty run list: no empty-task or approval claim, Start and Stop-and-rework disabled, a several-plans notice", async () => {
    serve(planView("current", true));
    for (const status of ["planned", "executing"]) {
      const t = target(status);
      const tree = detail(await load(), t, [t], TWO, 9).render();
      const text = deepText(tree);
      expect(text, `${status}: no false empty-task claim`).not.toContain("No approved tasks yet.");
      expect(text, `${status}: no approval verdict that was never read`).not.toMatch(/approval is not current|latest revision is not approved/);
      // The Changes section's own several-plans sentence does not count as the task-area notice.
      const notice = text.split("\n").filter((l) => /(several|more than one|multiple)\b.{0,40}\bplans?\b/i.test(l) && !/compare its revisions/.test(l));
      expect(notice.length, `${status}: the task area says several plans are bound`).toBeGreaterThanOrEqual(1);
      expect(enabled(deepPress(tree, /^Start/i)), `${status}: Start disabled`).toEqual([]);
      expect(enabled(deepPress(tree, /^Stop and rework/i)), `${status}: Stop and rework disabled`).toEqual([]);
    }
  });

  it("controls: no bound plan keeps 'No plan yet' and the empty task text; a single approved current plan shows its tasks with Start and Stop-and-rework; a single unapproved plan keeps the approval reason", async () => {
    serve(planView("current", true));
    const none = deepText(detail(await load(), target("planned"), [target("planned")], [], 9).render());
    expect(none).toContain("No plan yet");
    expect(none).toContain("No approved tasks yet.");

    const single = detail(await load(), target("planned"), [target("planned")], [TWO[0]], 9).render();
    expect(deepText(single)).toContain("Build the index");
    expect(enabled(deepPress(single, /^Start/i)).length, "single current plan: Start enabled").toBeGreaterThanOrEqual(1);
    expect(enabled(deepPress(single, /^Stop and rework/i)).length, "single approved latest: Stop and rework offered").toBeGreaterThanOrEqual(1);

    serve(planView("unapproved", false));
    const unapproved = deepText(detail(await load(), target("planned"), [target("planned")], [{ ...TWO[0], approval: "unapproved" }], 9).render());
    expect(unapproved).toMatch(/Start: the approval is not current/);
  });
});

// UI feedback plan (2026-11-09, revision 2) U3: the stage strip on the feature screen. It sits under
// the title row and above the run bar in compact and wide, holds only the five stage pills (no
// approval, start or run control), and is fed by the same reads as the run bar: plan.get of the single
// bound plan, the feature's run list (a live run only, for the latest revision), and the session.
// Pills are read by their accessibility label "<label>: <state>, <detail>".
describe("UI feedback U3: the stage strip on the feature screen", () => {
  const PLAN = { id: "plan-1", title: "Rollout", latestRev: 2, approval: "current", featureId: "f1" };
  const task = (id: string) => ({ id, title: `Task ${id}`, description: "", dependsOn: [], parallel: false, completion: "auto", grill: false, dod: "x" });
  const planView = (approval: string) => ({
    revision: 9,
    plan: { id: "plan-1", title: "Rollout", featureId: "f1", sessionIds: ["S"], taskStates: [], revisions: [{ rev: 2, schema: 2, createdAt: AT, contentHash: "a".repeat(64), markdown: "# R", basedOn: [], decisionSnapshotHash: "b".repeat(64), tasks: [task("t1")] }] },
    approvals: [], approval, notCurrentReasons: [], exportWritten: true, blockers: [],
  });
  const run = (state: string, planRev = 2) => ({ id: "run-1", featureId: "f1", planId: "plan-1", planRev, runToken: "tok", state, startAuth: { kind: "ui", at: AT }, tasks: [], acks: [], events: [], lateEvidence: [] });
  const data = (o: { approval?: string; plan?: "failed" | "loading"; runs?: unknown[] | "failed"; session?: string }) => {
    h.state.cacheRevision = 9;
    h.state.queryData = (key) => {
      const k = JSON.stringify(key);
      if (k.includes('"runs"')) return o.runs === "failed" ? { isError: true, isPending: false, data: undefined } : { revision: 9, runs: (o.runs ?? []).map((r) => ({ run: r, ready: [], blocked: [] })) };
      if (k.includes('"run"')) return { revision: 9, run: (Array.isArray(o.runs) ? o.runs[0] : undefined) ?? run("ended"), ready: [], blocked: [] };
      if (k.includes('"plan"')) return o.plan === "failed" ? { isError: true, isPending: false, data: undefined } : o.plan === "loading" ? { isError: false, isPending: true, data: undefined } : planView(o.approval ?? "current");
      if (k.includes('"plans"')) return { revision: 9, plans: [PLAN] };
      if (k.includes('"session"')) return { revision: 9, session: { id: "S", title: "S", createdAt: AT, status: o.session ?? "active" }, questions: [], cancellations: [], links: [], catalog: [] };
      if (k.includes('"profiles"')) return [];
      if (k.includes('"version"')) return { revision: 9 };
      return {};
    };
  };
  const screen = async (compact: boolean, target = feature("f1", { grillSessionId: "S" })) => {
    const m = await load();
    const opened = { plans: [] as string[], sessions: [] as string[] };
    const s = mount(m.FeatureScreen, {
      hostId: HOST, projectId: P, theme, compact, feature: target, features: [target], plans: [PLAN], revision: 9,
      onOpenFeature: () => undefined, onOpenPlan: (id: string) => void opened.plans.push(id), onOpenSession: (id: string) => void opened.sessions.push(id), onBack: () => undefined,
    });
    return { s, opened };
  };
  const pills = (tree: unknown) => deep(tree).filter((el) => typeof el.props.accessibilityLabel === "string" && /^(Questions|Plan|Tasks|Execution|Done): /.test(el.props.accessibilityLabel));
  const STAGE_NAMES = ["Questions", "Plan", "Tasks", "Execution"];
  const pill = (tree: unknown, label: string) => {
    const found = pills(tree).filter((el) => el.props.accessibilityLabel.startsWith(`${label}: `));
    expect(found.length, `one ${label} pill`).toBe(1);
    return found[0];
  };

  it.each([true, false])("sits under the title row and above the run bar, with only the four stage pills (compact %s)", async (compact) => {
    data({ runs: [] });
    const { s } = await screen(compact);
    const tree = s.render();
    const order = deep(tree);
    const back = order.findIndex((el) => typeof handlerOf(el) === "function" && /^Back$/.test(labelOf(el)));
    const first = order.findIndex((el) => typeof el.props.accessibilityLabel === "string" && /^Questions: /.test(el.props.accessibilityLabel));
    const runControl = order.findIndex((el) => typeof handlerOf(el) === "function" && /^(Start…|Pause run|Resume run|Stop and rework…|Replace coordinator…)$/.test(labelOf(el)));
    expect(pills(tree).length).toBe(4);
    expect(back).toBeGreaterThanOrEqual(0);
    expect(first).toBeGreaterThan(back);
    expect(runControl, "the run bar's control").toBeGreaterThan(first);
    // From the strip to the run bar the only controls are the four pills; there is no Done pill.
    const between = order.slice(first, runControl).filter((el) => typeof handlerOf(el) === "function");
    expect(between.map((el) => String(el.props.accessibilityLabel).split(":")[0])).toEqual(STAGE_NAMES);
  });

  it("a live run of the latest revision with a current approval: Execution current, Plan and Tasks complete", async () => {
    data({ runs: [run("running")] });
    const tree = (await screen(false)).s.render();
    expect(pill(tree, "Execution").props.accessibilityLabel).toMatch(/^Execution: current/);
    expect(pill(tree, "Plan").props.accessibilityLabel).toMatch(/^Plan: complete/);
    expect(pill(tree, "Tasks").props.accessibilityLabel).toMatch(/^Tasks: complete/);
    expect(pill(tree, "Questions").props.accessibilityLabel).toMatch(/still open/i);
  });

  it("an ended run is history: it never makes Execution current or complete", async () => {
    for (const [label, r] of [["no end reason", run("ended")], ["cancelled for rework", { ...run("ended"), endReason: "cancelled_for_rework", endedAt: AT }]] as const) {
      data({ runs: [r] });
      const tree = (await screen(false)).s.render();
      expect(pill(tree, "Execution").props.accessibilityLabel, label).not.toMatch(/: (current|complete)/);
    }
  });

  it("an ended run of the current revision without a recorded end reason leaves Tasks unknown, never complete", async () => {
    data({ runs: [run("ended")] });
    const label = String(pill((await screen(false)).s.render(), "Tasks").props.accessibilityLabel);
    expect(label).toMatch(/^Tasks: unknown, /);
    expect(label).toMatch(/end reason/);
  });

  it("an ended run of the current revision cancelled for rework leaves Tasks current, not complete", async () => {
    data({ runs: [{ ...run("ended"), endReason: "cancelled_for_rework", endedAt: AT }] });
    expect(String(pill((await screen(false)).s.render(), "Tasks").props.accessibilityLabel)).toMatch(/^Tasks: current/);
  });

  it("a live run of an older revision does not complete Tasks", async () => {
    data({ runs: [run("running", 1)] });
    const tree = (await screen(false)).s.render();
    expect(pill(tree, "Tasks").props.accessibilityLabel).not.toMatch(/^Tasks: complete/);
  });

  it("an approval that is not current never completes Plan, and names its state", async () => {
    data({ approval: "not_current" });
    const label = pill((await screen(false)).s.render(), "Plan").props.accessibilityLabel;
    expect(label).not.toMatch(/^Plan: complete/);
    expect(label).toMatch(/not.current/i);
  });

  it("failed and loading reads are unknown, never complete", async () => {
    data({ plan: "failed", runs: "failed" });
    let tree = (await screen(false)).s.render();
    expect(pill(tree, "Plan").props.accessibilityLabel).toMatch(/^Plan: unknown, read failed/);
    data({ plan: "loading" });
    tree = (await screen(false)).s.render();
    expect(pill(tree, "Plan").props.accessibilityLabel).toMatch(/^Plan: unknown, loading/);
  });

  it("Questions opens the session, Plan the single bound plan, Tasks the tasks segment; upcoming pills are disabled with the hint", async () => {
    data({ approval: "unapproved" });
    const { s, opened } = await screen(false);
    const tree = s.render();
    await press(pill(tree, "Questions"));
    expect(opened.sessions).toEqual(["S"]);
    await press(pill(s.render(), "Plan"));
    expect(opened.plans).toEqual(["plan-1"]);
    expect(pills(s.render()).filter((el) => el.props.accessibilityLabel.startsWith("Done: ")), "no Done pill").toEqual([]);
    for (const label of ["Tasks", "Execution"]) {
      const p = pill(s.render(), label);
      expect(p.props.disabled, label).toBe(true);
      expect(p.props.accessibilityHint, label).toBe("Complete the previous stage first");
    }
  });

  // Owner decision: Tasks follows the run evidence that run.list carries (the run's plan revision,
  // state and endReason), not the feature's status. A run of the current revision that finished
  // completes Tasks; one cancelled for rework does not; a run of an older revision never does.
  const ended = (endReason: string, planRev = 2) => ({ ...run("ended", planRev), endReason, endedAt: AT });
  const tasksLabel = async (status: string) =>
    String(pill((await screen(false, feature("f1", { grillSessionId: "S", status }))).s.render(), "Tasks").props.accessibilityLabel);

  for (const status of ["planned", "executing", "done"]) {
    it(`a finished run of the current revision completes Tasks (feature ${status})`, async () => {
      data({ runs: [ended("finished")] });
      expect(await tasksLabel(status)).toMatch(/^Tasks: complete/);
    });

    it(`a run of the current revision cancelled for rework does not complete Tasks (feature ${status})`, async () => {
      data({ runs: [ended("cancelled_for_rework")] });
      expect(await tasksLabel(status)).not.toMatch(/^Tasks: complete/);
    });

    it(`a finished run of an older revision, or no run, does not complete Tasks (feature ${status})`, async () => {
      data({ runs: [ended("finished", 1)] });
      expect(await tasksLabel(status)).not.toMatch(/^Tasks: complete/);
      data({ runs: [] });
      expect(await tasksLabel(status)).not.toMatch(/^Tasks: complete/);
    });
  }
  // DeepSeek Flash review 01a1c67a c0034 and c0015: the strip's Questions detail comes from the
  // session's last closure (closeBasis in stage-strip-view), and the session header's closure line
  // from the same record (closureLine in grilling-header). Each closure state is read through the
  // feature screen, and the two must say the same about it.
  const closed = (closures: unknown[] | undefined, blocks = true) => ({
    id: "S", title: "S", createdAt: AT, status: "closed",
    ...(blocks ? { blocks: [{ id: "b1", order: 0, state: "accepted", openedAt: AT, acceptedAt: AT, acceptedBy: { kind: "human" } }] } : {}),
    ...(closures !== undefined ? { closures } : {}),
  });
  const withSession = (session: Record<string, unknown>) => {
    data({ runs: [] });
    const base = h.state.queryData;
    h.state.queryData = (key) => (JSON.stringify(key).includes('"session"') ? { revision: 9, session, questions: [], cancellations: [], links: [], catalog: [] } : base(key));
  };
  const LATER = "2026-01-02T10:00:00.000Z";
  const CASES: Array<[string, Record<string, unknown>, RegExp, RegExp]> = [
    ["a manual Finish", closed([{ at: AT, source: "ui", actor: { kind: "human" }, basis: "manual" }]), /finished by the owner manually/, /manually/],
    ["a Finish on the chat's proposal", closed([{ at: AT, source: "ui", actor: { kind: "human" }, basis: "proposal", proposalAt: AT }]), /finished by the owner on the chat's proposal/, /accepting the chat's proposal/],
    ["closed again after a reopen, without a new closure", closed([{ at: AT, source: "ui", actor: { kind: "human" }, basis: "manual", reopenedAt: LATER }]), /closed \(basis not recorded\)/, /basis not recorded/],
    ["closed without any closure", closed(undefined), /closed \(basis not recorded\)/, /basis not recorded/],
  ];
  for (const [name, session, strip, header] of CASES) {
    it(`${name}: the Questions stage and the session header say the same about the close`, async () => {
      withSession(session);
      const { s } = await screen(false);
      const label = String(pill(s.render(), "Questions").props.accessibilityLabel);
      expect(label).toMatch(/^Questions: complete/);
      expect(label).toMatch(strip);
      const { closureLine } = await import("./grilling-header");
      const line = closureLine({ session } as never);
      expect(line, String(line)).toMatch(header);
    });
  }

  // The one case where the two differ by design: a closed legacy session (no blocks, no closures) has
  // no header line, while the strip still says the basis is not recorded.
  it("a closed legacy session without closures: the strip says the basis is not recorded, the header has no line", async () => {
    const session = closed(undefined, false);
    withSession(session);
    const { s } = await screen(false);
    expect(String(pill(s.render(), "Questions").props.accessibilityLabel)).toMatch(/closed \(basis not recorded\)/);
    const { closureLine } = await import("./grilling-header");
    expect(closureLine({ session } as never)).toBeNull();
  });

  // c0034: two ended runs of the current revision: a finished one completes Tasks whatever else ended.
  const twoEnds: Array<[Array<string | undefined>, RegExp]> = [
    [["cancelled_for_rework", "finished"], /^Tasks: complete/],
    [["finished", "cancelled_with_feature"], /^Tasks: complete/],
    [["cancelled_for_rework", undefined], /without a recorded end reason/],
    // DeepSeek Flash review 01a1c737 c0054: two cancellations, in either order: the feature's
    // cancellation wins over the one for rework.
    [["cancelled_for_rework", "cancelled_with_feature"], /cancelled with the feature/],
    [["cancelled_with_feature", "cancelled_for_rework"], /cancelled with the feature/],
    [["cancelled_for_rework", "cancelled_for_rework"], /cancelled for rework/],
  ];
  for (const [ends, expected] of twoEnds) {
    it(`two ended runs of the current revision (${ends.map(String).join(", ")})`, async () => {
      data({ runs: ends.map((endReason, i) => ({ ...run("ended"), id: `run-${i}`, ...(endReason !== undefined ? { endReason } : {}), endedAt: AT })) });
      const { s } = await screen(false, feature("f1", { grillSessionId: "S", status: "executing" }));
      expect(String(pill(s.render(), "Tasks").props.accessibilityLabel)).toMatch(expected);
    });
  }
});

// Compact stage cells (four-stage template): four equal cells in one horizontally scrolling row, each
// a 44 px Pressable showing the stage name and a state word (Done, In progress, Not started,
// Loading, Read failed) with the full "<stage>: <state>, <detail>" accessibility label; the state is
// never shown by colour or a glyph alone. The viewed stage is selected; an upcoming stage is disabled
// with the hint, and a muted line under the strip names the disabled stages. Node structure only.
describe("the stage-text guard itself", () => {
  // DeepSeek Flash review 01a1c67a c0036: the guard must report a forbidden line outside the cells
  // even when it repeats a cell's own words.
  const Text = Object.assign(() => null, { displayName: "Text" });
  const View = Object.assign(() => null, { displayName: "View" });
  const el = (type: unknown, props: Record<string, unknown>) => ({ type, props }) as unknown as El;
  const isCell = (x: El) => typeof x.props.accessibilityLabel === "string" && /^(Questions|Plan|Tasks|Execution): /.test(x.props.accessibilityLabel);
  it("reports an outside 'In progress' line and leaves the cells' own words out", () => {
    const cell = el(View, { accessibilityLabel: "Questions: current, In progress", children: [el(Text, { children: "In progress" })] });
    const tree = el(View, { children: [cell, el(Text, { children: "In progress" })] });
    expect(textOutside(tree, isCell)).toMatch(/progress/i);
    expect(textOutside(el(View, { children: [cell] }), isCell)).not.toMatch(/progress/i);
  });
});

describe("compact stage cells", () => {
  const PLAN = { id: "plan-1", title: "Rollout", latestRev: 2, approval: "current", featureId: "f1" };
  const planView = { revision: 9, plan: { id: "plan-1", title: "Rollout", featureId: "f1", sessionIds: ["S"], taskStates: [], revisions: [{ rev: 2, schema: 2, createdAt: AT, contentHash: "a".repeat(64), markdown: "# R", basedOn: [], decisionSnapshotHash: "b".repeat(64), tasks: [{ id: "t1", title: "T", description: "", dependsOn: [], parallel: false, completion: "auto", grill: false, dod: "x" }] }] }, approvals: [], approval: "current", notCurrentReasons: [], exportWritten: true, blockers: [] };
  const liveRun = { id: "run-1", featureId: "f1", planId: "plan-1", planRev: 2, runToken: "tok", state: "running", startAuth: { kind: "ui", at: AT }, tasks: [], acks: [], events: [], lateEvidence: [] };
  const data = (o: { planFails?: boolean; runs?: unknown[] } = {}) => {
    h.state.cacheRevision = 9;
    h.state.queryData = (key) => {
      const k = JSON.stringify(key);
      if (k.includes('"runs"')) return { revision: 9, runs: (o.runs ?? [liveRun]).map((r) => ({ run: r, ready: [], blocked: [] })) };
      if (k.includes('"run"')) return { revision: 9, run: liveRun, ready: [], blocked: [] };
      if (k.includes('"plan"')) return o.planFails === true ? { isError: true, isPending: false, data: undefined } : planView;
      if (k.includes('"plans"')) return { revision: 9, plans: [PLAN] };
      if (k.includes('"session"')) return { revision: 9, session: { id: "S", title: "S", createdAt: AT, status: "active" }, questions: [], cancellations: [], links: [], catalog: [] };
      if (k.includes('"profiles"')) return [];
      if (k.includes('"version"')) return { revision: 9 };
      return {};
    };
  };
  const render = async (compact = true) => {
    const m = await load();
    const target = feature("f1", { grillSessionId: "S" });
    return mount(m.FeatureScreen, {
      hostId: HOST, projectId: P, theme, compact, feature: target, features: [target], plans: [PLAN], revision: 9,
      onOpenFeature: () => undefined, onOpenPlan: () => undefined, onOpenSession: () => undefined, onBack: () => undefined,
    }).render();
  };
  const STAGE = /^(Questions|Plan|Tasks|Execution|Done): /;
  const visible = (el: El) => deep(el).filter(isText).map((t) => textOf(t.props.children)).join(" ");
  const cells = (tree: unknown) => deep(tree).filter((el) => typeof el.props.accessibilityLabel === "string" && STAGE.test(el.props.accessibilityLabel));
  const cell = (tree: unknown, name: string) => cells(tree).find((el) => el.props.accessibilityLabel.startsWith(`${name}: `))!;
  const flatStyle = (style: unknown) => Object.assign({}, ...[style].flat(Infinity).filter(Boolean));

  it("four equal 44 px cells in one horizontal row, with the stage names and full accessibility labels; no Done cell", async () => {
    data();
    const tree = await render();
    const list = cells(tree);
    expect(list.map((el) => el.props.accessibilityLabel.split(":")[0])).toEqual(["Questions", "Plan", "Tasks", "Execution"]);
    expect(list.map((el) => visible(el).split(" ")[0])).toEqual(["Questions", "Plan", "Tasks", "Execution"]);
    for (const el of list) {
      const st = flatStyle(el.props.style);
      expect(st.minHeight, el.props.accessibilityLabel).toBeGreaterThanOrEqual(44);
      expect(st.minWidth, el.props.accessibilityLabel).toBeGreaterThanOrEqual(44);
      expect(el.props.accessibilityRole).toBe("button");
      expect(el.props.accessibilityLabel).toMatch(/^[A-Za-z]+: (complete|current|open|unknown), .+/);
    }
    const rows = deep(tree).filter((el) => ["ScrollView", "RNScrollView"].includes((el.type as { displayName?: string })?.displayName ?? "") && el.props.horizontal === true && cells(el).length === 4);
    expect(rows.length, "one horizontal row holds the four cells").toBe(1);
  });

  it("each cell shows a state word: Done when complete, In progress when current, Not started when open, Read failed when unknown", async () => {
    data();
    let tree = await render();
    // A live run of the latest revision: Plan and Tasks complete, Execution current.
    expect(visible(cell(tree, "Plan"))).toMatch(/\bDone\b/);
    expect(visible(cell(tree, "Tasks"))).toMatch(/\bDone\b/);
    expect(visible(cell(tree, "Execution"))).toMatch(/\bIn progress\b/);
    data({ runs: [] });
    tree = await render();
    expect(visible(cell(tree, "Execution"))).toMatch(/\bNot started\b/);
    data({ planFails: true });
    tree = await render();
    expect(cell(tree, "Plan").props.accessibilityLabel).toMatch(/^Plan: unknown, read failed/);
    expect(visible(cell(tree, "Plan"))).toMatch(/\bRead failed\b/);
  });

  it("the viewed stage is selected; an upcoming stage is disabled with the hint; a line under the strip names the disabled stages", async () => {
    data({ runs: [] });
    const tree = await render();
    const list = cells(tree);
    // Approved plan and no run: Tasks is current and viewed on the compact screen; Execution is upcoming.
    expect(list.filter((el) => el.props.accessibilityState?.selected === true).map((el) => el.props.accessibilityLabel.split(":")[0])).toEqual(["Tasks"]);
    const execution = cell(tree, "Execution");
    expect(execution.props.disabled).toBe(true);
    expect(execution.props.accessibilityState).toMatchObject({ disabled: true });
    expect(execution.props.accessibilityHint).toBe("Complete the previous stage first");
    const hint = deep(tree).filter(isText).map((t) => textOf(t.props.children)).filter((x) => /complete the previous stage first/i.test(x));
    expect(hint.some((x) => /Execution/.test(x)), "the hint line names the disabled stage").toBe(true);
  });

  // Real host (RN Web): accessibilityState and accessibilityHint reached no DOM attribute; aria-*
  // props do. The viewed cell must state that it is the current one, and a disabled cell its hint.
  it("the viewed cell states selected or current, and a disabled cell carries its hint where the host renders it", async () => {
    data({ runs: [] });
    const tree = await render();
    const viewed = cell(tree, "Tasks");
    const current = viewed.props["aria-selected"] === true || (viewed.props["aria-current"] !== undefined && viewed.props["aria-current"] !== false);
    expect(current, "Tasks is the viewed cell").toBe(true);
    // The host's RN Web forwards aria-label / accessibilityLabel and aria-describedby /
    // accessibilityDescribedBy (to an element's nativeID); it drops aria-description and
    // accessibilityHint, which therefore do not count here.
    const execution = cell(tree, "Execution");
    const label = String(execution.props["aria-label"] ?? execution.props.accessibilityLabel ?? "");
    const describedBy = String(execution.props["aria-describedby"] ?? execution.props.accessibilityDescribedBy ?? "");
    const described = describedBy === "" ? "" : deep(tree).filter((el) => describedBy.split(/\s+/).includes(String(el.props.nativeID ?? el.props.id ?? ""))).map((el) => textOf(el.props.children)).join(" ");
    expect(`${label} | ${described}`, "the hint reaches the host through the label or a described-by element").toMatch(/complete the previous stage first/i);
  });

  // Host (RN Web, 320 and 390 px): the four compact cells needed 392 px and "Questions" was cut to
  // "Questi…", because each name and state word is held to one unbreakable line. The plan wants one
  // row of four cells with labels that wrap and never clip. Real widths need the host recheck.
  it("compact cells let the stage name and state word wrap instead of cutting them to one line", async () => {
    data();
    const tree = await render(true);
    for (const el of cells(tree)) {
      for (const t of deep(el).filter(isText)) {
        expect(t.props.numberOfLines, `${el.props.accessibilityLabel}: ${textOf(t.props.children)}`).not.toBe(1);
        expect(t.props.ellipsizeMode, textOf(t.props.children)).toBeUndefined();
      }
      const st = flatStyle(el.props.style);
      expect(st.width, "no fixed cell width").toBeUndefined();
      expect(st.minWidth ?? 0, "a cell may shrink to a quarter of a 320 px row").toBeLessThanOrEqual(74);
    }
  });

  it("the visible cells carry no glyph-only state", async () => {
    data();
    const tree = await render();
    for (const el of cells(tree)) expect(visible(el), el.props.accessibilityLabel).not.toMatch(/[✓●○…]/);
  });
});


// The Questions stage has no surface from the feature screen when the feature has no
// session or the screen cannot open one; its cell is then disabled and pressing it opens nothing.
describe("stage strip: an unavailable Questions stage", () => {
  const PLAN = { id: "plan-1", title: "Rollout", latestRev: 1, approval: "unapproved", featureId: "f1" };
  const cellOf = (tree: unknown) => {
    const found = deep(tree).filter((el) => typeof el.props.accessibilityLabel === "string" && el.props.accessibilityLabel.startsWith("Questions: "));
    expect(found.length, "one Questions cell").toBe(1);
    return found[0];
  };
  const screenOf = async (target: any, onOpenSession?: (id: string) => void) => {
    h.state.queryData = (key) => (JSON.stringify(key).includes('"plans"') ? { revision: 9, plans: [PLAN] } : {});
    const m = await load();
    return mount(m.FeatureScreen, {
      hostId: HOST, projectId: P, theme, compact: false, feature: target, features: [target], plans: [PLAN], revision: 9,
      onOpenFeature: () => undefined, onOpenPlan: () => undefined, onBack: () => undefined, ...(onOpenSession ? { onOpenSession } : {}),
    }).render();
  };

  it("without a session the Questions cell is disabled and pressing it opens nothing", async () => {
    const opened: string[] = [];
    const cell = cellOf(await screenOf(feature("f1"), (id) => void opened.push(id)));
    expect(cell.props.disabled).toBe(true);
    expect(cell.props.accessibilityState).toMatchObject({ disabled: true });
    cell.props.onPress?.();
    expect(opened).toEqual([]);
  });

  it("with a session but no way to open it the cell is disabled; with both it is enabled", async () => {
    expect(cellOf(await screenOf(feature("f1", { grillSessionId: "S" }))).props.disabled).toBe(true);
    const opened: string[] = [];
    const cell = cellOf(await screenOf(feature("f1", { grillSessionId: "S" }), (id) => void opened.push(id)));
    expect(cell.props.disabled).not.toBe(true);
    cell.props.onPress();
    expect(opened).toEqual(["S"]);
  });
});
