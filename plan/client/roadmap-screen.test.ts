// Roadmap screen (redesign Stage R1.1, task card §2.2–§2.4, §2.6), in node. Minimal harness after
// client/question-editor.test.ts: `react` keeps its real elements but its state hooks are a slot
// implementation; React Native and host UI are inert markers. The REAL RoadmapScreen, FeatureForm and
// useRoadmapMutation (client/hooks.ts) run; only `useRpc` is replaced, recording each call and
// answering ok. Child components are not rendered: assertions read element props and invoke their
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
    answers: {} as Record<string, (input: Record<string, any>) => unknown>,
    // R4.4 harness: query data by key (default {} keeps every earlier test unchanged).
    queryData: ((_key: unknown[]) => ({})) as (key: unknown[]) => unknown,
    queries: [] as Array<{ queryKey?: unknown[]; enabled?: boolean }>,
  };
  const useState = (init: unknown) => {
    const i = state.index++;
    // The component's own slots, also when a deep mount swaps `state.slots` per component.
    const slots = state.slots;
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
  const marker = (name: string) => Object.assign(() => null, { displayName: name });
  const useRpc = (contract: { name: string }) => (input: Record<string, any>) => {
    state.calls.push({ name: contract.name, input });
    const answer = state.answers[contract.name];
    return Promise.resolve(answer ? answer(input) : { ok: true, value: { revision: (input.expectedRevision ?? 0) + 1, featureId: "fNew" } });
  };
  const window = { width: 390, height: 844 };
  return { state, useState, marker, useRpc, window };
});

vi.mock("react", async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  const passthrough = { useState: h.useState, useEffect: () => undefined, useCallback: (fn: unknown) => fn, useMemo: (fn: () => unknown) => fn(), useRef: (v: unknown) => ({ current: v }) };
  return { ...real, ...passthrough, default: { ...(real.default as object), ...passthrough } };
});
vi.mock("react-native", () => ({
  Text: h.marker("Text"),
  View: h.marker("View"),
  Pressable: h.marker("Pressable"),
  ScrollView: h.marker("ScrollView"),
  Switch: h.marker("Switch"),
  // A 390×844 window, as a phone reports it; tests that need another size change it here.
  Dimensions: { get: () => ({ ...h.window }) },
}));
vi.mock("@getpaseo/plugin/client/react-native", () => ({
  TextInput: h.marker("TextInput"),
  Icon: h.marker("Icon"),
  useToast: () => ({ show: (m: string) => void h.state.toasts.push(m), error: (m: string) => void h.state.toasts.push(m) }),
}));
vi.mock("@getpaseo/plugin/client", () => ({ useRpc: h.useRpc, useWorkspace: () => ({}) }));
vi.mock("@tanstack/react-query", () => ({
  useQuery: (opts: { queryKey?: unknown[]; enabled?: boolean }) => {
    h.state.queries.push(opts ?? {});
    const data = h.state.queryData(opts?.queryKey ?? []);
    // An explicit query state (pending or error) is returned as is (R4 final KensAI c0017).
    if (data && typeof data === "object" && "__queryState" in data) return (data as { __queryState: unknown }).__queryState;
    return data && Object.keys(data as object).length > 0 ? { data, isPending: false, isError: false } : {};
  },
  useQueryClient: () => ({
    getQueryData: (key: unknown[]) => (key.at(-1) === "version" && h.state.cacheRevision !== null ? { status: "ok", revision: h.state.cacheRevision } : undefined),
    getQueriesData: () => [],
    invalidateQueries: async () => undefined,
  }),
}));

const screenPath = "./roadmap-screen";
const themePath = "./theme";
const load = async () => (await import(/* @vite-ignore */ screenPath));
const loadTheme = async () => (await import(/* @vite-ignore */ themePath));

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
  h.state.queries = [];
  h.state.answers = {};
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

function screen(m: any, features: any[], revision = 7, extra: Record<string, unknown> = {}) {
  const opened: string[] = [];
  const s = mount(m.RoadmapScreen, { hostId: HOST, projectId: P, theme, compact: false, features, revision, onOpenFeature: (id: string) => void opened.push(id), onBack: () => undefined, ...extra });
  return { ...s, opened };
}

const STATUSES = ["created", "planned", "executing", "done", "deferred", "cancelled"] as const;
const byStatus = (status: (typeof STATUSES)[number], over: Record<string, unknown> = {}) =>
  feature(status, { status, ...(status === "deferred" ? { statusBeforeDefer: "planned" } : {}), ...over });

// ---------------------------------------------------------------------------------------------

describe("theme (§2.2)", () => {
  it("labels the six feature statuses and colours them from existing theme keys", async () => {
    const t = await loadTheme();
    expect(t.FEATURE_STATUS_LABEL).toEqual({ created: "Created", planned: "Planned", executing: "Executing", done: "Done", deferred: "Deferred", cancelled: "Cancelled" });
    const colour = (s: string) => t.featureStatusColor(s, theme);
    expect(STATUSES.map(colour)).toEqual(["#muted", "#accent", "#warn", "#success", "#muted", "#danger"]);
    expect(t.TARGET_SIZE).toBe(44);
  });
});

describe("featureActions (§2.3)", () => {
  it("per status, in the fixed order; done and cancelled get no defer, resume or cancel", async () => {
    const m = await load();
    const list = STATUSES.map((s) => byStatus(s));
    const actionsOf = (s: (typeof STATUSES)[number]) => m.featureActions(list.find((f: any) => f.id === s), list);
    expect(actionsOf("created")).toEqual(["open", "edit", "dependencies", "defer", "cancel", "delete"]);
    expect(actionsOf("planned")).toEqual(["open", "edit", "dependencies", "defer", "cancel", "delete"]);
    expect(actionsOf("executing")).toEqual(["open", "edit", "dependencies", "defer", "cancel", "delete"]);
    expect(actionsOf("deferred")).toEqual(["open", "edit", "dependencies", "resume", "cancel", "delete"]);
    expect(actionsOf("done")).toEqual(["open", "edit", "dependencies", "delete", "createRemoval"]);
    expect(actionsOf("cancelled")).toEqual(["open", "edit", "dependencies", "delete"]);
  });

  it("delete only when never started and no other feature depends on it; edit and dependencies always", async () => {
    const m = await load();
    const a = feature("a");
    const b = feature("b", { dependsOn: ["a"] });
    const started = feature("s", { status: "executing", everStarted: true });
    const list = [a, b, started];
    expect(m.featureActions(a, list)).not.toContain("delete");
    expect(m.featureActions(b, list)).toContain("delete");
    expect(m.featureActions(started, list)).not.toContain("delete");
    // Positive control: without the dependent, a is deletable.
    expect(m.featureActions(a, [a, started])).toContain("delete");
    for (const f of list) expect(m.featureActions(f, list).slice(0, 3)).toEqual(["open", "edit", "dependencies"]);
    for (const f of [...list, ...STATUSES.map((s) => byStatus(s))]) {
      for (const x of m.featureActions(f, list)) expect(["open", "edit", "dependencies", "defer", "resume", "cancel", "delete", "createRemoval"]).toContain(x);
    }
  });

  it("resumeTarget is statusBeforeDefer for a deferred feature only", async () => {
    const m = await load();
    expect(m.resumeTarget(byStatus("deferred", { statusBeforeDefer: "executing" }))).toBe("executing");
    expect(m.resumeTarget(byStatus("deferred", { statusBeforeDefer: "created" }))).toBe("created");
    for (const s of ["created", "planned", "executing", "done", "cancelled"] as const) expect(m.resumeTarget(byStatus(s)), s).toBeUndefined();
  });
});

describe("featureRows, moveFeature, editPatch (§2.3)", () => {
  it("keeps roadmap order and resolves dependency and relation titles from the list; an unknown id shows itself", async () => {
    const m = await load();
    const list = [feature("c", { dependsOn: ["a"], relatedTo: ["b", "ghost"], statusReason: "waiting" }), feature("a", { kind: "bug" }), feature("b", { status: "done" })];
    const rows = m.featureRows(list);
    expect(rows.map((r: any) => r.id)).toEqual(["c", "a", "b"]);
    expect(rows[0]).toMatchObject({ title: "Title c", kind: "feature", status: "created", statusLabel: "Created", statusReason: "waiting" });
    expect(rows[0].dependsOn).toEqual([{ id: "a", title: "Title a" }]);
    expect(rows[0].relatedTo).toEqual([{ id: "b", title: "Title b" }, { id: "ghost", title: "ghost" }]);
    expect(rows[1].kind).toBe("bug");
    expect(rows[2].statusLabel).toBe("Done");
    expect(rows[2].actions).toEqual(m.featureActions(list[2], list));
  });

  it("moveFeature returns a full permutation with one step, and null at an edge or for an unknown id", async () => {
    const m = await load();
    const order = ["a", "b", "c"];
    expect(m.moveFeature(order, "b", "up")).toEqual(["b", "a", "c"]);
    expect(m.moveFeature(order, "b", "down")).toEqual(["a", "c", "b"]);
    expect(m.moveFeature(order, "a", "up")).toBeNull();
    expect(m.moveFeature(order, "c", "down")).toBeNull();
    expect(m.moveFeature(order, "x", "up")).toBeNull();
    expect(order).toEqual(["a", "b", "c"]);
  });

  it("editPatch carries only changed fields, trims the title, and is {} when nothing changed", async () => {
    const m = await load();
    const f = feature("a", { title: "Alpha", description: "Desc" });
    expect(m.editPatch(f, { title: "Alpha", description: "Desc" })).toEqual({});
    expect(m.editPatch(f, { title: "  Alpha  ", description: "Desc" })).toEqual({});
    expect(m.editPatch(f, { title: " Beta ", description: "Desc" })).toEqual({ title: "Beta" });
    expect(m.editPatch(f, { title: "Alpha", description: "New" })).toEqual({ description: "New" });
    expect(m.editPatch(f, { title: "Beta", description: "New" })).toEqual({ title: "Beta", description: "New" });
  });
});

describe("ActionButton (§2.4)", () => {
  it("is a Pressable button with a 44 px minimum target and its label as the accessibility label", async () => {
    const m = await load();
    const t = await loadTheme();
    let pressed = 0;
    const el = m.ActionButton({ label: "Move up", onPress: () => void pressed++, theme }) as El;
    const found = all(el, (x) => (x.type as { displayName?: string })?.displayName === "Pressable");
    expect(found.length).toBe(1);
    const p = found[0];
    const style = Object.assign({}, ...[p.props.style].flat(Infinity).filter(Boolean).map((s: any) => (typeof s === "function" ? s({ pressed: false }) : s)).flat(Infinity));
    expect(style.minHeight).toBe(t.TARGET_SIZE);
    expect(style.minWidth).toBe(t.TARGET_SIZE);
    expect(p.props.accessibilityRole).toBe("button");
    expect(p.props.accessibilityLabel).toBe("Move up");
    p.props.onPress();
    expect(pressed).toBe(1);
  });
});

// DeepSeek Flash review 01a1c6c1 c0100: React Native Web 0.21 writes aria attributes from the aria-*
// props and the flat accessibility* props (modules/createDOMProps); an `accessibilityState` object is
// not among them, and the project's SPEC says the host drops it. A selected ActionButton (the feature
// screen's Changes / Tasks / Chat segments, the discussion language and profile choices) must say so
// through an attribute the web keeps. A disabled one already does: Pressable maps `disabled` to
// aria-disabled (exports/Pressable).
describe("ActionButton: selected and disabled reach the web", () => {
  const webSelected = (p: El) => p.props["aria-selected"] ?? p.props.accessibilitySelected ?? p.props["aria-pressed"] ?? p.props["aria-checked"];
  const pressableOf = (el: El) => {
    const found = all(el, (x) => (x.type as { displayName?: string })?.displayName === "Pressable");
    expect(found.length, "one Pressable").toBe(1);
    return found[0];
  };
  it.each([true, false])("selected %s is carried by a web attribute", async (selected) => {
    const m = await load();
    const p = pressableOf(m.ActionButton({ label: "Changes", onPress: () => undefined, theme, selected }) as El);
    expect(webSelected(p), "aria-selected (or aria-pressed / aria-checked)").toBe(selected);
  });
  it("disabled is passed to the Pressable, which React Native Web writes as aria-disabled", async () => {
    const m = await load();
    const p = pressableOf(m.ActionButton({ label: "Changes", onPress: () => undefined, theme, disabled: true }) as El);
    expect(p.props.disabled).toBe(true);
  });
});

describe("RoadmapScreen list actions (§2.4)", () => {
  it("renders one row per feature with title, status label and dependency titles, and no built, not built or progress text", async () => {
    const m = await load();
    const list = [feature("a", { title: "Alpha" }), feature("b", { title: "Beta", status: "executing", dependsOn: ["a"], statusReason: "blocked on infra" })];
    const tree = screen(m, list).render();
    const text = allText(tree);
    for (const s of ["Alpha", "Beta", "Created", "Executing", "blocked on infra"]) expect(text, s).toContain(s);
    expect(text).not.toMatch(/\bbuilt\b|not built|progress/i);
    expect(pressables(tree, /^New feature$/).length).toBe(1);
  });

  it("Move up and Move down send feature.reorder with the moveFeature permutation and the rendered revision", async () => {
    const m = await load();
    const list = [feature("a"), feature("b"), feature("c")];
    h.state.cacheRevision = 99;
    const s = screen(m, list, 7);
    for (const el of enabled(pressables(s.render(), /^Move down$/))) await press(el);
    for (const el of enabled(pressables(s.render(), /^Move up$/))) await press(el);
    const orders = calls("feature.reorder").map((c) => JSON.stringify(c.input.order)).sort();
    const expected = [m.moveFeature(["a", "b", "c"], "a", "down"), m.moveFeature(["a", "b", "c"], "b", "down"), m.moveFeature(["a", "b", "c"], "b", "up"), m.moveFeature(["a", "b", "c"], "c", "up")]
      .map((o: string[]) => JSON.stringify(o))
      .sort();
    expect(orders).toEqual(expected);
    for (const c of calls("feature.reorder")) expect(c.input).toEqual({ order: c.input.order, projectId: P, expectedRevision: 7 });
  });

  it("defer and resume send feature.status.set with deferred and the resume target, with the rendered revision", async () => {
    const m = await load();
    const list = STATUSES.map((st) => byStatus(st));
    h.state.cacheRevision = 99;
    const s = screen(m, list, 11);
    for (const el of enabled(pressables(s.render(), /^defer$/i))) await press(el);
    for (const el of enabled(pressables(s.render(), /^resume$/i))) await press(el);
    const sent = calls("feature.status.set").map((c) => c.input);
    expect(sent.filter((i) => i.status === "deferred").map((i) => i.featureId).sort()).toEqual(["created", "executing", "planned"]);
    expect(sent.filter((i) => i.status !== "deferred")).toEqual([{ featureId: "deferred", status: "planned", projectId: P, expectedRevision: 11 }]);
    for (const i of sent) expect(i.expectedRevision).toBe(11);
    expect(sent.some((i) => i.featureId === "done" || i.featureId === "cancelled")).toBe(false);
  });

  it("cancel sends nothing on the first press and feature.status.set cancelled on the confirming press", async () => {
    const m = await load();
    const s = screen(m, [feature("a", { status: "planned" })], 5);
    for (const el of enabled(pressables(s.render(), /cancel/i))) await press(el);
    expect(h.state.calls).toEqual([]);
    const confirm = enabled(pressables(s.render(), /cancel|confirm/i));
    expect(confirm.length).toBeGreaterThan(0);
    for (const el of confirm) {
      if (calls("feature.status.set").length > 0) break;
      await press(el);
    }
    expect(calls("feature.status.set").map((c) => c.input)).toEqual([{ featureId: "a", status: "cancelled", projectId: P, expectedRevision: 5 }]);
  });

  it("delete sends nothing on the first press and feature.delete on the confirming press", async () => {
    const m = await load();
    const s = screen(m, [feature("a")], 6);
    for (const el of enabled(pressables(s.render(), /delete/i))) await press(el);
    expect(h.state.calls).toEqual([]);
    for (const el of enabled(pressables(s.render(), /delete|confirm/i))) {
      if (calls("feature.delete").length > 0) break;
      await press(el);
    }
    expect(calls("feature.delete").map((c) => c.input)).toEqual([{ featureId: "a", projectId: P, expectedRevision: 6 }]);
  });

  it("offers no delete for a prerequisite or a started feature, and no defer, resume or cancel for done and cancelled (positive control: created)", async () => {
    const m = await load();
    const prereq = screen(m, [feature("a"), feature("b", { status: "executing", everStarted: true, dependsOn: ["a"] })]).render();
    expect(enabled(pressables(prereq, /^delete$/i))).toEqual([]);
    const ended = screen(m, [byStatus("done"), byStatus("cancelled")]).render();
    expect(enabled(pressables(ended, /^(defer|resume|cancel)$/i))).toEqual([]);
    const control = screen(m, [byStatus("created")]).render();
    expect(enabled(pressables(control, /^delete$/i)).length).toBe(1);
    expect(enabled(pressables(control, /^defer$/i)).length).toBe(1);
  });

  it("the dependency picker excludes the feature itself, preselects its dependencies and sends feature.dependencies.set in roadmap order", async () => {
    const m = await load();
    const list = [feature("a", { title: "Alpha" }), feature("b", { title: "Beta" }), feature("c", { title: "Gamma", dependsOn: ["a"] })];
    const s = screen(m, list, 8);
    const before = s.render();
    const depButtons = pressables(before, /dependenc/i);
    expect(depButtons.length).toBe(3);
    const beforeLabels = new Set(pressables(before, /.*/).map(labelOf));
    await press(depButtons[2]);
    const picker = s.render();
    const fresh = pressables(picker, /.*/).filter((el) => !beforeLabels.has(labelOf(el)) || /Alpha|Beta|Gamma/.test(labelOf(el)));
    const choice = (title: string) => fresh.filter((el) => labelOf(el).includes(title) && (el.props.value !== undefined || el.props.selected !== undefined || el.props.checked !== undefined || el.props.accessibilityState !== undefined));
    expect(choice("Gamma")).toEqual([]);
    const alpha = choice("Alpha");
    const beta = choice("Beta");
    expect(alpha.length).toBe(1);
    expect(beta.length).toBe(1);
    const isOn = (el: El) => Boolean(el.props.value ?? el.props.selected ?? el.props.checked ?? el.props.accessibilityState?.checked ?? el.props.accessibilityState?.selected);
    expect(isOn(alpha[0])).toBe(true);
    expect(isOn(beta[0])).toBe(false);
    await press(beta[0], true);
    const save = enabled(pressables(s.render(), /^(save|apply|done|set dependencies|save dependencies)$/i));
    expect(save.length).toBe(1);
    await press(save[0]);
    expect(calls("feature.dependencies.set").map((c) => c.input)).toEqual([{ featureId: "c", dependsOn: ["a", "b"], projectId: P, expectedRevision: 8 }]);
  });

  it("New feature opens the create form pinned to the rendered revision; Edit opens the edit form for that row", async () => {
    const m = await load();
    const list = [feature("a"), feature("b")];
    const s = screen(m, list, 4);
    await press(pressables(s.render(), /^New feature$/)[0]);
    const forms = all(s.render(), (el) => el.type === m.FeatureForm);
    expect(forms.length).toBe(1);
    expect(forms[0].props).toMatchObject({ mode: "create", hostId: HOST, projectId: P, revision: 4 });
    const s2 = screen(m, list, 4);
    await press(pressables(s2.render(), /^edit$/i)[1]);
    const edit = all(s2.render(), (el) => el.type === m.FeatureForm);
    expect(edit.length).toBe(1);
    expect(edit[0].props).toMatchObject({ mode: "edit", revision: 4 });
    expect(edit[0].props.feature.id).toBe("b");
    expect(h.state.calls).toEqual([]);
  });
});

describe("FeatureForm (§2.4)", () => {
  function form(m: any, extra: Record<string, unknown>) {
    const done: Array<string | undefined> = [];
    const f = mount(m.FeatureForm, { hostId: HOST, projectId: P, theme, compact: false, revision: 5, onDone: (id?: string) => void done.push(id), onCancel: () => undefined, ...extra });
    return { ...f, done };
  }
  const input = (tree: unknown, label: RegExp) => {
    const found = all(tree, (el) => (el.type as { displayName?: string })?.displayName === "TextInput" && label.test(String(el.props.accessibilityLabel ?? el.props.placeholder ?? "")));
    expect(found.length, String(label)).toBe(1);
    return found[0];
  };
  const submit = (tree: unknown) => {
    const found = enabled(pressables(tree, /^(create|save|create feature|save feature)$/i));
    expect(found.length).toBe(1);
    return found[0];
  };

  it("create sends title (trimmed), description and kind, no dependsOn and no relatedTo, with the revision pinned at open", async () => {
    const m = await load();
    const f = form(m, { mode: "create" });
    let tree = f.render();
    input(tree, /title/i).props.onChangeText("  Email channel  ");
    tree = f.render();
    input(tree, /description/i).props.onChangeText("Send mail");
    tree = f.render();
    const bug = pressables(tree, /^bug$/i);
    expect(bug.length).toBe(1);
    await press(bug[0]);
    h.state.cacheRevision = 40;
    tree = f.render({ ...f.props(), revision: 9 });
    await press(submit(tree));
    expect(calls("feature.create").map((c) => c.input)).toEqual([{ title: "Email channel", description: "Send mail", kind: "bug", projectId: P, expectedRevision: 5 }]);
    expect(f.done).toEqual(["fNew"]);
  });

  it("create with an empty title sends nothing (positive control: a title sends)", async () => {
    const m = await load();
    const f = form(m, { mode: "create" });
    let tree = f.render();
    input(tree, /title/i).props.onChangeText("   ");
    tree = f.render();
    const buttons = pressables(tree, /^(create|save|create feature|save feature)$/i);
    for (const b of enabled(buttons)) await press(b);
    expect(h.state.calls).toEqual([]);
    input(f.render(), /title/i).props.onChangeText("Ok");
    await press(submit(f.render()));
    expect(calls("feature.create").length).toBe(1);
  });

  it("create with initial relatedTo sends it, and still no dependsOn", async () => {
    const m = await load();
    const f = form(m, { mode: "create", initial: { title: "Remove: Old", relatedTo: ["old"] } });
    await press(submit(f.render()));
    const sent = calls("feature.create").map((c) => c.input);
    expect(sent.length).toBe(1);
    expect(sent[0]).toMatchObject({ title: "Remove: Old", relatedTo: ["old"], projectId: P, expectedRevision: 5 });
    expect(sent[0]).not.toHaveProperty("dependsOn");
  });

  it("edit sends feature.update with only the changed fields and the pinned revision; no kind and nothing when unchanged", async () => {
    const m = await load();
    const target = feature("a", { title: "Alpha", description: "Desc", kind: "bug" });
    const unchanged = form(m, { mode: "edit", feature: target });
    await press(submit(unchanged.render()));
    expect(h.state.calls).toEqual([]);

    const f = form(m, { mode: "edit", feature: target });
    expect(pressables(f.render(), /^(bug|feature)$/i).filter((el) => !el.props.disabled)).toEqual([]);
    input(f.render(), /title/i).props.onChangeText(" Alpha 2 ");
    h.state.cacheRevision = 70;
    const tree = f.render({ ...f.props(), revision: 12, feature: { ...target, title: "Changed elsewhere" } });
    await press(submit(tree));
    expect(calls("feature.update").map((c) => c.input)).toEqual([{ featureId: "a", patch: { title: "Alpha 2" }, projectId: P, expectedRevision: 5 }]);
    expect(calls("feature.create")).toEqual([]);
  });
});

// R1 exact-review c0040 (card §9.2, UI side): Delete stays offered for an unstarted, non-prerequisite
// feature; the server's feature_transition refusal for a bound feature reaches the user through the
// existing mutation error path and is not retried.
describe("R1 review c0040: bound-feature delete refusal in the list", () => {
  it("Delete is offered; the refusal is shown and not retried", async () => {
    const m = await load();
    h.state.answers["feature.delete"] = () => ({ ok: false, error: { code: "feature_transition", message: "plans are bound to this feature", details: { featureId: "a", planIds: ["p1"] } } });
    const s = screen(m, [feature("a")], 6);
    expect(m.featureActions(feature("a"), [feature("a")])).toContain("delete");
    for (const el of enabled(pressables(s.render(), /delete/i))) await press(el);
    for (const el of enabled(pressables(s.render(), /delete|confirm/i))) {
      if (calls("feature.delete").length > 0) break;
      await press(el);
    }
    await flush();
    expect(calls("feature.delete").map((c) => c.input)).toEqual([{ featureId: "a", projectId: P, expectedRevision: 6 }]);
    expect(h.state.toasts.join("\n")).toMatch(/bound|plan/i);
    await flush();
    expect(calls("feature.delete").length).toBe(1);
  });
});

// R1 exact-review c0054 (card §9.4): the submit is disabled on an empty trimmed title in both modes.
describe("R1 review c0054: no empty edit title", () => {
  const editForm = async (m: any) => {
    const done: Array<string | undefined> = [];
    const f = mount(m.FeatureForm, { hostId: HOST, projectId: P, theme, compact: false, revision: 5, mode: "edit", feature: feature("a", { title: "Alpha", description: "Desc" }), onDone: (id?: string) => void done.push(id), onCancel: () => undefined });
    return { ...f, done };
  };
  const titleInput = (tree: unknown) => all(tree, (el) => (el.type as { displayName?: string })?.displayName === "TextInput" && /title/i.test(String(el.props.accessibilityLabel ?? el.props.placeholder ?? "")))[0];
  const descInput = (tree: unknown) => all(tree, (el) => (el.type as { displayName?: string })?.displayName === "TextInput" && /description/i.test(String(el.props.accessibilityLabel ?? el.props.placeholder ?? "")))[0];
  const save = (tree: unknown) => {
    const found = pressables(tree, /^Save feature$/);
    expect(found.length).toBe(1);
    return found[0];
  };

  it("edit mode: a whitespace-only title disables Save feature and sends nothing", async () => {
    const m = await load();
    const f = await editForm(m);
    titleInput(f.render()).props.onChangeText("   ");
    descInput(f.render()).props.onChangeText("New description");
    const button = save(f.render());
    expect(button.props.disabled).toBe(true);
    expect(h.state.calls).toEqual([]);
  });

  it("control: a description-only change with the title kept saves { description }", async () => {
    const m = await load();
    const f = await editForm(m);
    descInput(f.render()).props.onChangeText("New description");
    const button = save(f.render());
    expect(button.props.disabled).toBeFalsy();
    await press(button);
    expect(calls("feature.update").map((c) => c.input)).toEqual([{ featureId: "a", patch: { description: "New description" }, projectId: P, expectedRevision: 5 }]);
  });
});

// ======================= Stage R4.4 (task card §5.2, §5.3) =======================
const AT4 = "2026-10-29T10:00:00.000Z";
const r4task = (taskId: string, state = "todo") => ({ taskId, state, failedCycles: 0, extraBudget: 0, unresolved: [] });
const r4run = (over: Record<string, unknown> = {}, states: string[] = ["verified", "todo", "todo", "todo"]) => ({
  id: "run1", featureId: "f1", planId: "plan1", planRev: 1, runToken: "tok", state: "running", startAuth: { kind: "ui", at: AT4 },
  tasks: states.map((st, i) => r4task(`t${i + 1}`, st)), acks: [], events: [], lateEvidence: [], ...over,
});
const view = (run: Record<string, unknown>, blocked: unknown[] = []) => ({ run, ready: [], blocked });
const r4plan = (latestRev = 1) => ({ id: "plan1", featureId: "f1", revisions: Array.from({ length: latestRev }, (_, i) => ({ rev: i + 1, schema: 2, tasks: [] })) });
const r4feature = (over: Record<string, unknown> = {}) => ({
  id: "f1", title: "Search", description: "", kind: "feature", status: "executing", dependsOn: [], relatedTo: [], everStarted: true,
  createdAt: AT4, createdBy: { kind: "human" }, coordinatorHistory: [], events: [{ at: AT4, actor: { kind: "human" }, kind: "created" }], ...over,
});
const fp = async () => {
  const m = await load();
  expect(typeof m.featureProgress, "roadmap-screen exports featureProgress").toBe("function");
  return m.featureProgress as (f: unknown, p: unknown, runs: unknown[]) => Record<string, unknown>;
};

describe("R4.4 featureProgress (pure)", () => {
  it("no run ever → none (never 0/0); runs of another feature are ignored", async () => {
    const featureProgress = await fp();
    expect(featureProgress(r4feature(), r4plan(), [])).toEqual({ kind: "none" });
    expect(featureProgress(r4feature(), r4plan(), [view(r4run({ featureId: "f-other" }))])).toEqual({ kind: "none" });
  });

  it("live: the single non-ended run, verified/total from its own task runs, no latestRev when the plan is still at the run's revision", async () => {
    const featureProgress = await fp();
    const out = featureProgress(r4feature(), r4plan(1), [view(r4run({ id: "old", state: "ended", endedAt: AT4, endReason: "finished" }, ["verified"])), view(r4run())]);
    expect(out).toMatchObject({ kind: "live", state: "running", verified: 1, total: 4, planRev: 1, delegated: false, unauthorised: false });
    expect(out.latestRev).toBeUndefined();
  });

  it("ended: the most recently ended run (by endedAt) with its end reason; revision mismatch sets latestRev and never mixes counts", async () => {
    const featureProgress = await fp();
    const older = view(r4run({ id: "a", state: "ended", endedAt: "2026-10-29T09:00:00.000Z", endReason: "cancelled_for_rework" }, ["verified", "verified"]));
    const newer = view(r4run({ id: "b", state: "ended", endedAt: "2026-10-29T11:00:00.000Z", endReason: "finished" }, ["verified", "verified", "verified"]));
    const out = featureProgress(r4feature(), r4plan(2), [newer, older]);
    expect(out).toMatchObject({ kind: "ended", endReason: "finished", verified: 3, total: 3, planRev: 1, latestRev: 2 });
  });

  it("delegated marker: delegated for a delegation-started live run; unauthorised only when run.get blocks start_unauthorised; a UI run has no marker", async () => {
    const featureProgress = await fp();
    const del = r4run({ startAuth: { kind: "delegation", delegationId: "d1", at: AT4 } });
    expect(featureProgress(r4feature(), r4plan(), [view(del)])).toMatchObject({ delegated: true, unauthorised: false });
    expect(featureProgress(r4feature(), r4plan(), [view(del, [{ code: "start_unauthorised" }])])).toMatchObject({ delegated: true, unauthorised: true });
    expect(featureProgress(r4feature(), r4plan(), [view(r4run(), [{ code: "start_unauthorised" }])])).toMatchObject({ delegated: false });
  });
});

describe("R4.4 RoadmapScreen progress line and delegations strip", () => {
  /** Expands the screen's own function components (markers stay inert). */
  const deep = (tree: unknown): El[] => {
    const out: El[] = [];
    const walk = (n: unknown, d = 0): void => {
      if (d > 80 || !n || typeof n !== "object") return;
      if (Array.isArray(n)) return n.forEach((x) => walk(x, d + 1));
      const el = n as El;
      if (typeof el.type === "function" && !(el.type as { displayName?: string }).displayName) return walk((el.type as (p: unknown) => unknown)(el.props ?? {}), d + 1);
      if (!el.props) return;
      out.push(el);
      walk(el.props.children, d + 1);
    };
    walk(tree);
    return out;
  };
  const textOfDeep = (tree: unknown) => deep(tree).map((el) => [typeof el.props.label === "string" ? el.props.label : "", typeof el.props.children === "string" ? el.props.children : Array.isArray(el.props.children) ? el.props.children.filter((c: unknown) => typeof c === "string" || typeof c === "number").join("") : ""].join(" ")).join("\n");
  const projectRuns = (runs: unknown[]) => (key: unknown[]) => (JSON.stringify(key).includes('"project-runs"') ? { revision: 7, runs } : {});
  const D_FEATURE = { id: "d1", scope: "feature", featureId: "f1", grantedAt: AT4, provenance: { agentId: "agent-1", seqStart: 1, timestamp: AT4, quoted: "you may start Search now please" } };
  const D_REVOKED = { id: "d2", scope: "roadmap", grantedAt: AT4, revokedAt: AT4, provenance: { agentId: "agent-1", seqStart: 2, timestamp: AT4, quoted: "start everything revoked" } };

  it("the row shows 'not started' with no run and live verified/total with the delegated · unauthorised marker", async () => {
    const m = await load();
    h.state.queryData = projectRuns([]);
    const none = textOfDeep(screen(m, [r4feature()]).render());
    expect(none).toMatch(/not started/i);
    expect(none).not.toMatch(/0\s*\/\s*0/);
    h.state.queryData = projectRuns([view(r4run({ startAuth: { kind: "delegation", delegationId: "d1", at: AT4 } }), [{ code: "start_unauthorised" }])]);
    const live = textOfDeep(screen(m, [r4feature()]).render());
    expect(live).toMatch(/1\s*\/\s*4/);
    expect(live).toMatch(/delegated · unauthorised/);
    expect(live).not.toMatch(/revoked/i);
  });

  // R4 final KensAI c0017: a pending or failed project-runs query is not "no run": the row must not say "Not started".
  it("project runs pending or failed: the row never says 'not started'; resolved-empty and live controls", async () => {
    const m = await load();
    const states: Array<[string, unknown]> = [
      ["pending", { data: undefined, isPending: true, isError: false }],
      ["failed", { data: undefined, isPending: false, isError: true, error: new Error("runs unreadable") }],
    ];
    for (const [label, state] of states) {
      h.state.queryData = (key: unknown[]) => (JSON.stringify(key).includes('"project-runs"') ? { __queryState: state } : {});
      expect(textOfDeep(screen(m, [r4feature()]).render()), label).not.toMatch(/not started/i);
    }
    h.state.queryData = projectRuns([]);
    expect(textOfDeep(screen(m, [r4feature()]).render()), "resolved, no run").toMatch(/not started/i);
    h.state.queryData = projectRuns([view(r4run({}), [])]);
    const live = textOfDeep(screen(m, [r4feature()]).render());
    expect(live, "resolved, live run").toMatch(/1\s*\/\s*4/);
    expect(live).not.toMatch(/not started/i);
  });

  it("the screen reads project runs through useProjectRuns (key project-runs, run.list without featureId), read-only", async () => {
    const m = await load();
    h.state.queries = [];
    screen(m, [r4feature()]).render();
    const q = h.state.queries.find((x) => JSON.stringify(x.queryKey ?? []).includes('"project-runs"'));
    expect(q, "a project-runs query").toBeDefined();
    expect(h.state.calls.filter((c) => c.name !== "run.list" && c.name !== "feature.list"), "no mutation on render").toEqual([]);
  });

  it("the strip lists only unrevoked delegations; Revoke sends delegation.revoke { delegationId } once and does not retry a refusal (T interface assumption: RoadmapScreen receives feature.list delegations as a `delegations` prop)", async () => {
    const m = await load();
    h.state.queryData = projectRuns([]);
    h.state.cacheRevision = 7;
    h.state.answers["delegation.revoke"] = () => ({ ok: false, error: { code: "revision_conflict", message: "the roadmap changed" } });
    const s = screen(m, [r4feature()], 7, { delegations: [D_FEATURE, D_REVOKED] });
    const tree = s.render();
    const text = textOfDeep(tree);
    expect(text).toMatch(/you may start Search/);
    expect(text, "a revoked delegation is not listed").not.toMatch(/start everything revoked/);
    const revoke = deep(tree).filter((el) => typeof handlerOf(el) === "function" && /revoke/i.test(labelOf(el)));
    expect(revoke).toHaveLength(1);
    await press(revoke[0]);
    expect(calls("delegation.revoke")).toHaveLength(1);
    expect(calls("delegation.revoke")[0].input).toMatchObject({ delegationId: "d1" });
    await flush();
    expect(calls("delegation.revoke"), "no retry after a refusal").toHaveLength(1);
  });
});

// UI feedback plan (2026-11-09, revision 2) Task U1 (§2.1, §2.6): an icon-only ActionButton is a 44×44
// target whose label is its accessibility label and whose hint is its accessibility hint; selection
// is shown by state, not by a glyph. The hint shows as a tooltip on hover, keyboard focus and long
// press, and hides on hover out, blur, release and Escape; showing it never presses the control and
// never changes its size. Placement (flip above, clamp to the viewport) needs measured layout and is
// not covered by this node harness. Plain function components are expanded in place here.
const isMarker = (t: unknown) => typeof t === "function" && typeof (t as { displayName?: string }).displayName === "string";
/** Renders `root` with every plain function component expanded, effects run, until it settles. */
function mountDeep(root: (p: any) => unknown, props: Record<string, unknown>) {
  const store = new Map<string, unknown[]>();
  const expand = (node: unknown, path: string): unknown => {
    if (node === null || typeof node !== "object") return node;
    if (Array.isArray(node)) return node.map((n, i) => expand(n, `${path}[${i}]`));
    const el = node as El;
    if (typeof el.type === "function" && !isMarker(el.type)) {
      const k = `${path}/${(el.type as { name?: string }).name ?? "anon"}`;
      if (!store.has(k)) store.set(k, []);
      const saved = { slots: h.state.slots, index: h.state.index };
      h.state.slots = store.get(k)!;
      h.state.index = 0;
      const out = (el.type as (p: unknown) => unknown)(el.props);
      h.state.slots = saved.slots;
      h.state.index = saved.index;
      return expand(out, k);
    }
    if (!el.props) return el;
    return { ...el, props: { ...el.props, children: expand(el.props.children, path) } };
  };
  return () => {
    for (let pass = 0; pass < 30; pass++) {
      h.state.dirty = false;
      const tree = expand({ type: root, props, key: null }, "");
      if (!h.state.dirty) return tree as El;
    }
    throw new Error("did not settle");
  };
}
function allDeep(tree: unknown, pred: (el: El) => boolean): El[] {
  const out: El[] = [];
  const walk = (n: unknown) => {
    if (Array.isArray(n)) return n.forEach(walk);
    if (!n || typeof n !== "object") return;
    const el = n as El;
    if (!el.props) return;
    if (pred(el)) out.push(el);
    walk(el.props.children);
  };
  walk(tree);
  return out;
}
const markerName = (el: El) => (el.type as { displayName?: string })?.displayName ?? "";
const textDeep = (n: unknown): string => {
  if (n === null || n === undefined || typeof n === "boolean") return "";
  if (typeof n === "string" || typeof n === "number") return String(n);
  if (Array.isArray(n)) return n.map(textOf).join("");
  const el = n as El;
  return el.props ? textDeep(el.props.children) : "";
};
/** The text a sighted user sees: the children of Text leaves. */
const visibleText = (tree: unknown) => allDeep(tree, (el) => markerName(el) === "Text").map((el) => textDeep(el.props.children)).join("\n");
const flatStyle = (style: unknown) => Object.assign({}, ...[style].flat(Infinity).filter(Boolean).map((s: any) => (typeof s === "function" ? s({ pressed: false }) : s)));
/** The first element in the tree carrying a function prop `name`. */
const handler = (tree: unknown, name: string): ((...a: unknown[]) => unknown) => {
  const found = allDeep(tree, (el) => typeof el.props[name] === "function");
  expect(found.length, `an element with ${name}`).toBeGreaterThan(0);
  return found[0].props[name];
};

const loadScreen = async (): Promise<{ ActionButton: (p: any) => unknown }> => await import(/* @vite-ignore */ screenPath);

describe("U1 icon-only ActionButton", () => {
  const HINT = "Copy the link to this question";

  it("is a 44×44 target with the label as accessibility label and the hint as accessibility hint", async () => {
    const { ActionButton } = await loadScreen();
    const render = mountDeep(ActionButton, { label: "Copy link", icon: "link", iconOnly: true, hint: HINT, onPress: () => undefined, theme });
    const tree = render();
    const [button] = allDeep(tree, (el) => el.props.accessibilityLabel === "Copy link");
    expect(button, "the control").toBeDefined();
    expect(button.props.accessibilityRole).toBe("button");
    expect(button.props.accessibilityHint).toBe(HINT);
    const style = flatStyle(button.props.style);
    expect(style.minHeight ?? style.height).toBeGreaterThanOrEqual(44);
    expect(style.minWidth ?? style.width).toBeGreaterThanOrEqual(44);
    expect(allDeep(tree, (el) => markerName(el) === "Icon").length, "an icon").toBe(1);
  });

  it("shows selection by state and border, never by a glyph", async () => {
    const { ActionButton } = await loadScreen();
    const tree = mountDeep(ActionButton, { label: "Show hidden", icon: "eye", iconOnly: true, hint: "Show hidden questions", selected: true, onPress: () => undefined, theme })();
    const [button] = allDeep(tree, (el) => el.props.accessibilityLabel === "Show hidden");
    expect(button.props.accessibilityState).toMatchObject({ selected: true });
    expect(visibleText(tree)).not.toContain("✓");
  });
});

describe("U1 tooltip on an icon button", () => {
  const HINT = "Go to the next question";
  async function setup() {
    const { ActionButton } = await loadScreen();
    let pressed = 0;
    const render = mountDeep(ActionButton, { label: "Next", icon: "chevron-right", iconOnly: true, hint: HINT, onPress: () => void pressed++, theme });
    const size = () => flatStyle(allDeep(render(), (el) => el.props.accessibilityLabel === "Next")[0].props.style);
    return { render, pressed: () => pressed, size };
  }

  it("hover in shows the hint and hover out hides it", async () => {
    const t = await setup();
    expect(visibleText(t.render())).not.toContain(HINT);
    handler(t.render(), "onHoverIn")();
    expect(visibleText(t.render())).toContain(HINT);
    handler(t.render(), "onHoverOut")();
    expect(visibleText(t.render())).not.toContain(HINT);
  });

  it("keyboard focus shows it, blur hides it, and Escape dismisses it", async () => {
    const t = await setup();
    handler(t.render(), "onFocus")();
    expect(visibleText(t.render())).toContain(HINT);
    handler(t.render(), "onBlur")();
    expect(visibleText(t.render())).not.toContain(HINT);
    handler(t.render(), "onFocus")();
    expect(visibleText(t.render())).toContain(HINT);
    handler(t.render(), "onKeyDown")({ key: "Escape", nativeEvent: { key: "Escape" } });
    expect(visibleText(t.render())).not.toContain(HINT);
  });

  it("a long press shows it without pressing the control; release hides it", async () => {
    const t = await setup();
    handler(t.render(), "onLongPress")();
    expect(visibleText(t.render())).toContain(HINT);
    expect(t.pressed()).toBe(0);
    handler(t.render(), "onPressOut")();
    expect(visibleText(t.render())).not.toContain(HINT);
    expect(t.pressed()).toBe(0);
  });

  it("showing the tooltip never changes the control's size", async () => {
    const t = await setup();
    const before = t.size();
    handler(t.render(), "onHoverIn")();
    expect(visibleText(t.render())).toContain(HINT);
    expect(t.size()).toEqual(before);
  });
});


// UI feedback plan §2.6: a shown tooltip is dismissed by a press elsewhere, here a press on another
// control in the same screen; a plain press presses the control once and shows no tooltip.
describe("U1 tooltip dismissal and plain presses", () => {
  const HINT_A = "Copy the link to this question";
  const HINT_B = "Go to the next question";
  async function pair() {
    const { ActionButton } = await loadScreen();
    const pressed = { a: 0, b: 0 };
    const Pair = () => ({
      type: h.marker("View"),
      props: {
        children: [
          { type: ActionButton, props: { label: "Copy link", icon: "link", iconOnly: true, hint: HINT_A, onPress: () => void pressed.a++, theme }, key: "a" },
          { type: ActionButton, props: { label: "Next", icon: "chevron-right", iconOnly: true, hint: HINT_B, onPress: () => void pressed.b++, theme }, key: "b" },
        ],
      },
    });
    const render = mountDeep(Pair, {});
    const control = (label: string) => allDeep(render(), (el) => el.props.accessibilityLabel === label)[0];
    return { render, control, pressed };
  }

  it("a press on another control dismisses a shown tooltip", async () => {
    const t = await pair();
    t.control("Copy link").props.onLongPress();
    expect(visibleText(t.render())).toContain(HINT_A);
    const other = t.control("Next");
    other.props.onPressIn?.();
    other.props.onPress();
    other.props.onPressOut?.();
    expect(t.pressed.b).toBe(1);
    expect(visibleText(t.render())).not.toContain(HINT_A);
  });

  it("a plain press presses the control once and shows no tooltip", async () => {
    const t = await pair();
    const a = t.control("Copy link");
    a.props.onPressIn?.();
    a.props.onPress();
    a.props.onPressOut?.();
    expect(t.pressed.a).toBe(1);
    expect(visibleText(t.render())).not.toContain(HINT_A);
  });
});


// Icon names (9d0bbd2): the host's Icon (installed 0.15.3) resolves `name` among the Lucide module's
// component exports and renders nothing for any other name. This host double renders a mark only for
// those export names (each one was found in the installed host's web bundle; that is string evidence,
// not a proof of the host's lookup) and records every other name, so a kebab-case or unknown name
// shows up here as it would as an empty square on the host.
describe("Icon names reach the host as Lucide export names", () => {
  // Plus, List, Map, Flag, Repeat, RotateCw and RotateCcw were found the same way, each as a
  // `"<Name>",{enumerable:!0,get:function(){return <module>.default}` export of the installed host
  // bundle's Lucide module.
  // Check and ChevronDown: the Chat menu's selected item and its trigger chevron, passed to the host Icon
  // directly; both rendered in the RN Web checks of round 7 (KensAI 9126580 c0029).
  // "Minus" (the Map's Zoom out since 57c036e) is exported by the host's lucide-react-native 1.50.0
  // (`default as Minus` in its dist/esm/lucide-react-native.mjs, Paseo v0.15.3 checkout).
  const HOST_EXPORTS = new Set(["Link", "Link2", "ChevronLeft", "ChevronRight", "ChevronDown", "Check", "FileText", "Info", "Copy", "Eye", "EyeOff", "ExternalLink", "Plus", "Minus", "List", "Map", "Flag", "Repeat", "RotateCw", "RotateCcw"]);
  const loadLucide = async (): Promise<(n: string) => string> => {
    const mod: unknown = await import(/* @vite-ignore */ screenPath);
    const fn: unknown = typeof mod === "object" && mod !== null ? Reflect.get(mod, "lucideName") : undefined;
    if (typeof fn !== "function") throw new Error("missing export: roadmap-screen.lucideName");
    return (n: string) => String(Reflect.apply(fn, undefined, [n]));
  };
  /** Every icon name the client source passes to ActionButton, or to the host Icon through lucideName. */
  const usedNames = async () => {
    const { readdir, readFile } = await import("node:fs/promises");
    const dir = new URL(".", import.meta.url).pathname;
    const names = new Set<string>();
    for (const f of (await readdir(dir)).filter((x) => x.endsWith(".tsx") && !x.includes(".test."))) {
      const src = await readFile(`${dir}${f}`, "utf8");
      for (const m of src.matchAll(/\bicon=(?:"([^"]+)"|\{([^}]*)\})/g)) {
        if (m[1] !== undefined) names.add(m[1]);
        for (const q of (m[2] ?? "").matchAll(/"([^"]+)"/g)) names.add(q[1]);
      }
      // DeepSeek Flash review 01a1c6c1 c0106: every quoted name in a lucideName(…) argument, both
      // branches of a conditional included (lucideName(open ? "chevron-down" : "chevron-right")).
      for (const m of src.matchAll(/\blucideName\(([^()]*)\)/g)) for (const q of m[1].matchAll(/["']([^"']+)["']/g)) names.add(q[1]);
      // The Map's toolButton(label, icon, hint, …) passes its icon on to ActionButton (audit of 57c036e).
      for (const m of src.matchAll(/\btoolButton\(\s*"[^"]*",\s*"([^"]+)"/g)) names.add(m[1]);
    }
    return [...names];
  };

  it("maps the documented kebab-case names to the exact PascalCase export names", async () => {
    const lucide = await loadLucide();
    expect(lucide("link")).toBe("Link");
    expect(lucide("link-2")).toBe("Link2");
    expect(lucide("chevron-left")).toBe("ChevronLeft");
    expect(lucide("file-text")).toBe("FileText");
    expect(lucide("eye-off")).toBe("EyeOff");
    expect(lucide("external-link")).toBe("ExternalLink");
    expect(lucide("ExternalLink")).toBe("ExternalLink");
  });

  it("every icon the client uses renders on the host double; none falls through to an unknown name", async () => {
    const used = await usedNames();
    expect(used, "the Map's zoom icons are found").toEqual(expect.arrayContaining(["minus", "plus"]));
    expect(used.length, "icon names found in the client source").toBeGreaterThanOrEqual(8);
    const { ActionButton } = await loadScreen();
    const unknown: string[] = [];
    for (const name of used) {
      const tree = mountDeep(ActionButton, { label: name, icon: name, iconOnly: true, hint: `Hint ${name}`, onPress: () => undefined, theme })();
      const icons = allDeep(tree, (el) => markerName(el) === "Icon");
      expect(icons.length, name).toBe(1);
      const passed = String(icons[0].props.name);
      if (!HOST_EXPORTS.has(passed)) unknown.push(`${name} -> ${passed}`);
    }
    expect(unknown).toEqual([]);
  });
});

// Tooltip placement (c294f12): the hint is placed inside the clipping region that holds the control
// (a registered scroll region, measured in the window), else inside the window. These cases give the
// harness measured rectangles through `measureInWindow`; they check the placement rule, not how a
// device measures or clips.
describe("U1 tooltip placement from measured bounds", () => {
  const HINT = "Go to the next question";
  const loadTooltip = async (): Promise<(ref: { readonly current: unknown }) => () => void> => {
    const tooltipPath = "./tooltip";
    const mod: unknown = await import(/* @vite-ignore */ tooltipPath);
    const fn: unknown = typeof mod === "object" && mod !== null ? Reflect.get(mod, "registerTooltipBoundary") : undefined;
    if (typeof fn !== "function") throw new Error("missing export: tooltip.registerTooltipBoundary");
    return (ref) => {
      const off: unknown = Reflect.apply(fn, undefined, [ref]);
      return typeof off === "function" ? () => void Reflect.apply(off, undefined, []) : () => undefined;
    };
  };
  const rect = (x: number, y: number, width: number, height: number) => ({ measureInWindow: (cb: (x: number, y: number, w: number, h: number) => void) => cb(x, y, width, height) });
  const settle = async () => {
    for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
  };
  /** Shows the tooltip of a control measured at `control` and returns the tooltip's style. */
  async function placed(control: ReturnType<typeof rect>) {
    const { ActionButton } = await loadScreen();
    const render = mountDeep(ActionButton, { label: "Next", icon: "chevron-right", iconOnly: true, hint: HINT, onPress: () => undefined, theme });
    const button = allDeep(render(), (el) => el.props.accessibilityLabel === "Next")[0];
    // React attaches the platform view through the control's (callback) ref.
    const ref: unknown = button.props.ref;
    if (typeof ref === "function") Reflect.apply(ref, undefined, [control]);
    else if (typeof ref === "object" && ref !== null && "current" in ref) Reflect.set(ref, "current", control);
    else throw new Error("the control carries no ref for its anchor");
    button.props.onHoverIn();
    await settle();
    const tip = allDeep(render(), (el) => flatStyle(el.props.style).position === "absolute" && textDeep(el.props.children).includes(HINT));
    expect(tip.length, "the tooltip is shown").toBe(1);
    return flatStyle(tip[0].props.style);
  }

  it("inside a registered scroll region: near its bottom the hint opens above; near its top, below", async () => {
    const register = await loadTooltip();
    const off = register({ current: rect(0, 100, 390, 300) });
    try {
      const nearBottom = await placed(rect(20, 350, 44, 44));
      expect(nearBottom.bottom).toBe("100%");
      const nearTop = await placed(rect(20, 120, 44, 44));
      expect(nearTop.top).toBe("100%");
    } finally {
      off();
    }
  });

  it("inside a region it is clamped to the region's right edge, never past its left edge", async () => {
    const register = await loadTooltip();
    const off = register({ current: rect(10, 100, 300, 600) });
    try {
      const right = await placed(rect(270, 200, 44, 44));
      // 270 + 240 - (10 + 300) = 200, bounded by the control's distance from the region's left edge (260).
      expect(right.left).toBe(-200);
      const left = await placed(rect(20, 200, 44, 44));
      expect(left.left).toBe(0);
    } finally {
      off();
    }
  });

  it("a control outside every registered region is placed within the window", async () => {
    const register = await loadTooltip();
    const off = register({ current: rect(0, 0, 390, 200) });
    try {
      const style = await placed(rect(20, 800, 44, 44));
      expect(style.bottom).toBe("100%");
    } finally {
      off();
    }
  });
});

// 2f4290e (KensAI c0043, c0046): the tooltip takes the innermost registered clipping region that the
// control's rectangle overlaps, also when the control is mostly scrolled out of it, independently of
// the order in which the regions were registered; with no overlap it falls back to the window. These
// cases feed measured rectangles to the rule; they do not prove how a device measures or clips.
describe("U1 tooltip region selection by overlap", () => {
  const HINT = "Go to the next question";
  const rect = (x: number, y: number, width: number, height: number) => ({ measureInWindow: (cb: (x: number, y: number, w: number, h: number) => void) => cb(x, y, width, height) });
  const settle = async () => {
    for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
  };
  const register = async (...regions: Array<ReturnType<typeof rect>>) => {
    const tooltipPath = "./tooltip";
    const mod: unknown = await import(/* @vite-ignore */ tooltipPath);
    const fn: unknown = typeof mod === "object" && mod !== null ? Reflect.get(mod, "registerTooltipBoundary") : undefined;
    if (typeof fn !== "function") throw new Error("missing export: tooltip.registerTooltipBoundary");
    const offs = regions.map((r) => Reflect.apply(fn, undefined, [{ current: r }]) as unknown);
    return () => offs.forEach((off) => typeof off === "function" && Reflect.apply(off, undefined, []));
  };
  async function placed(control: ReturnType<typeof rect>) {
    const { ActionButton } = await loadScreen();
    const render = mountDeep(ActionButton, { label: "Next", icon: "chevron-right", iconOnly: true, hint: HINT, onPress: () => undefined, theme });
    const button = allDeep(render(), (el) => el.props.accessibilityLabel === "Next")[0];
    const ref: unknown = button.props.ref;
    if (typeof ref === "function") Reflect.apply(ref, undefined, [control]);
    else throw new Error("the control carries no ref for its anchor");
    button.props.onHoverIn();
    await settle();
    const tip = allDeep(render(), (el) => flatStyle(el.props.style).position === "absolute" && textDeep(el.props.children).includes(HINT));
    expect(tip.length, "the tooltip is shown").toBe(1);
    return flatStyle(tip[0].props.style);
  }
  // The body region spans y 100–400 in a 390×844 window.
  const BODY = () => rect(0, 100, 390, 300);

  it("c0043: a control mostly scrolled out of the region (its centre outside) still uses the region and opens above", async () => {
    const off = await register(BODY());
    try {
      // y 390–434: 10 px inside the region, centre at 412, below its bottom edge.
      expect((await placed(rect(20, 390, 44, 44))).bottom).toBe("100%");
    } finally {
      off();
    }
  });

  it("c0043: a control partly past the region's right edge is clamped to that region", async () => {
    const off = await register(rect(10, 100, 300, 600));
    try {
      // x 300–344 overlaps the region (10–310); 300 + 240 - 310 = 230, within the 290 px to its left edge.
      expect((await placed(rect(300, 200, 44, 44))).left).toBe(-230);
    } finally {
      off();
    }
  });

  it("c0046: nested regions select the innermost one, whichever was registered first", async () => {
    for (const order of ["outer first", "inner first"] as const) {
      const outer = rect(0, 0, 390, 844);
      const inner = BODY();
      const off = await register(...(order === "outer first" ? [outer, inner] : [inner, outer]));
      try {
        // y 380–424 near the inner region's bottom: above within the inner region; the outer one would leave room below.
        expect((await placed(rect(20, 380, 44, 44))).bottom, order).toBe("100%");
      } finally {
        off();
      }
    }
  });

  it("a control that overlaps no region falls back to the window; touching a region's edge is not overlapping", async () => {
    const off = await register(BODY());
    try {
      expect((await placed(rect(20, 500, 44, 44))).top, "below, within the window").toBe("100%");
      // y 400–444 touches the region's bottom edge (400) without sharing area: the window decides, room below.
      expect((await placed(rect(20, 400, 44, 44))).top, "touching is not overlapping").toBe("100%");
    } finally {
      off();
    }
  });
});


// A selected button (text or icon-only) is told apart by its accent border as
// well as its selected state; the remaining ui.Button keeps the same 44 px minimum target.
const uiPath = "./ui";
const loadUi = async (): Promise<{ Button: (p: any) => unknown }> => await import(/* @vite-ignore */ uiPath);
describe("selected border and the shared target size", () => {
  it("a selected ActionButton, text or icon-only, has the accent border; an unselected one does not", async () => {
    const { ActionButton } = await loadScreen();
    for (const extra of [{}, { icon: "eye", iconOnly: true, hint: "Show hidden questions" }]) {
      const borderOf = (selected: boolean) => {
        const tree = mountDeep(ActionButton, { label: "Choice", onPress: () => undefined, theme, selected, ...extra })();
        const [button] = allDeep(tree, (el) => el.props.accessibilityLabel === "Choice");
        expect(button.props.accessibilityState).toMatchObject({ selected });
        return flatStyle(button.props.style).borderColor;
      };
      expect(borderOf(true), JSON.stringify(extra)).toBe(COLORS.accent);
      expect(borderOf(false), JSON.stringify(extra)).not.toBe(COLORS.accent);
    }
  });

  it("ui.Button keeps the 44 px minimum target", async () => {
    const { Button } = await loadUi();
    const t = await loadTheme();
    const tree = mountDeep(Button, { label: "Copy", onPress: () => undefined, theme })();
    const pressable = allDeep(tree, (el) => markerName(el) === "Pressable");
    expect(pressable.length).toBe(1);
    const st = flatStyle(pressable[0].props.style);
    expect(st.minHeight).toBe(t.TARGET_SIZE);
    expect(st.minWidth).toBe(t.TARGET_SIZE);
  });
});
