// DoD editor (redesign Stage R1.2, task card §3.3, §3.4, §7 C7/C8), in node. Harness after
// client/roadmap-screen.test.ts with effects run after each pass: the REAL DodEditor and the REAL
// useRoadmapMutation run; `useRpc` records each call and answers per contract. One case forwards the
// captured plan.draft input to the REAL plan commands over a temp store (server/test-support, not
// modified). The module is loaded per test, so every case is collected while it is missing.
// Limitations: no reconciler, layout, host or native behaviour; this does not prove the live UI.
import { beforeEach, describe, expect, it, vi } from "vitest";

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
const HOST = "h1";
const P = "prj_test";
const AT = "2026-10-20T10:00:00.000Z";
const HASH = "a".repeat(64);

beforeEach(() => {
  h.state.calls = [];
  h.state.toasts = [];
  h.state.cacheRevision = null;
  h.state.view = undefined;
  h.state.answers = {};
});

/** One mounted component: its own hook slots; effects run after each pass until nothing changes. */
function mount(component: (props: any) => unknown, initial: Record<string, unknown>) {
  const slots: unknown[] = [];
  let props = initial;
  const render = (next?: Record<string, unknown>): El => {
    if (next) props = next;
    h.state.slots = slots;
    for (let pass = 0; pass < 30; pass++) {
      h.state.index = 0;
      h.state.dirty = false;
      h.state.effects = [];
      const tree = component(props) as El;
      for (const fn of h.state.effects) fn();
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
const v2Task = (id: string, over: Record<string, unknown> = {}) => ({
  id, title: `Task ${id}`, description: `About ${id}`, dependsOn: [] as string[], parallel: false, completion: "auto", grill: false, dod: "", ...over,
});
const legacyRev = (rev: number, tasks: unknown[], markdown = "# Plan body"): any => ({ rev, createdAt: AT, contentHash: HASH, markdown, tasks, basedOn: [], decisionSnapshotHash: HASH });
const v2Rev = (rev: number, tasks: unknown[], markdown = "# Plan body"): any => ({ ...legacyRev(rev, tasks, markdown), schema: 2 });

const editorPath = "./dod-editor";
const load = async () => (await import(/* @vite-ignore */ editorPath));

const TASKS = [
  v2Task("t1", { title: "Build", dod: "$ npm test", grill: false, dependsOn: [], parallel: true, completion: "human" }),
  v2Task("t2", { title: "Ship", dod: "", grill: true, dependsOn: ["t1"], grillSessionId: "sess9" }),
];
const REV = v2Rev(2, TASKS, "# Rollout");
const PLAN = { id: "plan1", title: "Rollout", sessionIds: ["s1", "s2"], featureId: "f1", revisions: [legacyRev(1, [{ id: "t1", title: "Build", description: "" }]), REV], taskStates: [] };

function editor(m: any, extra: Record<string, unknown> = {}) {
  const saved: number[] = [];
  let cancelled = 0;
  const e = mount(m.DodEditor, {
    hostId: HOST, projectId: P, theme, compact: false, plan: PLAN, revision: REV, storeRevision: 17,
    onSaved: (rev: number) => void saved.push(rev), onCancel: () => void cancelled++, ...extra,
  });
  return { ...e, saved, cancelled: () => cancelled };
}
const dodInput = (tree: unknown, title: string) => {
  const found = all(tree, (el) => nameOf(el) === "TextInput" && el.props.accessibilityLabel === `DoD for ${title}`);
  expect(found.length, title).toBe(1);
  return found[0];
};
const grillBox = (tree: unknown, title: string) => {
  const found = all(tree, (el) => el.props.accessibilityRole === "checkbox" && el.props.accessibilityLabel === `Grill ${title}`);
  expect(found.length, title).toBe(1);
  return found[0];
};
const saveButton = (tree: unknown) => {
  const found = pressables(tree, /^Save$/);
  expect(found.length).toBe(1);
  return found[0];
};
const insertButtons = (tree: unknown) => pressables(tree, /^Insert template/);
const flat = (style: unknown) => Object.assign({}, ...[style].flat(Infinity).filter(Boolean).map((s: any) => (typeof s === "function" ? s({ pressed: false }) : s)));

describe("DodEditor (§3.3)", () => {
  it("makes no call on open or on a rerender with new props", async () => {
    const m = await load();
    const e = editor(m);
    e.render();
    e.render({ ...e.props(), storeRevision: 30 });
    await flush();
    expect(h.state.calls).toEqual([]);
  });

  it("shows one DoD input and one grill checkbox per task, 44 px minimum, with the revision values", async () => {
    const m = await load();
    const tree = editor(m).render();
    expect(dodInput(tree, "Build").props.value).toBe("$ npm test");
    expect(dodInput(tree, "Ship").props.value).toBe("");
    expect(dodInput(tree, "Build").props.multiline).toBe(true);
    const box = grillBox(tree, "Ship");
    expect(box.props.accessibilityState).toMatchObject({ checked: true });
    expect(grillBox(tree, "Build").props.accessibilityState).toMatchObject({ checked: false });
    for (const el of [box, dodInput(tree, "Build")]) expect(flat(el.props.style).minHeight).toBeGreaterThanOrEqual(44);
    expect(flat(box.props.style).minWidth).toBeGreaterThanOrEqual(44);
  });

  it("Save is disabled until a DoD or grill value differs from the revision, and the checkbox toggles", async () => {
    const m = await load();
    const e = editor(m);
    expect(saveButton(e.render()).props.disabled).toBe(true);
    await press(grillBox(e.render(), "Build"));
    let tree = e.render();
    expect(grillBox(tree, "Build").props.accessibilityState).toMatchObject({ checked: true });
    expect(saveButton(tree).props.disabled).toBeFalsy();
    await press(grillBox(tree, "Build"));
    tree = e.render();
    expect(grillBox(tree, "Build").props.accessibilityState).toMatchObject({ checked: false });
    expect(saveButton(tree).props.disabled).toBe(true);
    dodInput(tree, "Ship").props.onChangeText("Docs updated");
    expect(saveButton(e.render()).props.disabled).toBeFalsy();
  });

  it("Save sends the exact plan.draft input at the pinned store revision across a rerender with newer props, and no grillSessionId", async () => {
    const m = await load();
    h.state.answers["plan.draft"] = (i) => ({ ok: true, value: { revision: i.expectedRevision + 1, planId: "plan1", rev: 3, contentHash: HASH, exportWritten: true } });
    const e = editor(m);
    dodInput(e.render(), "Ship").props.onChangeText("Docs updated");
    await press(grillBox(e.render(), "Build"));
    h.state.cacheRevision = 80;
    const newer = v2Rev(4, [v2Task("t9", { title: "Other" })]);
    // The working base (store revision, plan revision and its tasks) is pinned at open.
    const tree = e.render({ ...e.props(), storeRevision: 40, revision: newer });
    await press(saveButton(tree));
    expect(calls("plan.draft").map((c) => c.input)).toEqual([
      {
        planId: "plan1", featureId: "f1", title: "Rollout", sessionIds: ["s1", "s2"], markdown: "# Rollout",
        tasks: [
          { id: "t1", title: "Build", description: "About t1", dependsOn: [], parallel: true, completion: "human", grill: true, dod: "$ npm test" },
          { id: "t2", title: "Ship", description: "About t2", dependsOn: ["t1"], parallel: false, completion: "auto", grill: true, dod: "Docs updated" },
        ],
        projectId: P, expectedRevision: 17,
      },
    ]);
    expect(JSON.stringify(calls("plan.draft"))).not.toContain("grillSessionId");
    expect(e.saved).toEqual([3]);
  });

  it("a server error is surfaced by the hook and nothing is retried or saved", async () => {
    const m = await load();
    h.state.answers["plan.draft"] = () => ({ ok: false, error: { code: "revision_conflict", message: "stale" } });
    const e = editor(m);
    dodInput(e.render(), "Ship").props.onChangeText("x");
    await press(saveButton(e.render()));
    expect(calls("plan.draft").length).toBe(1);
    expect(h.state.toasts.length).toBeGreaterThan(0);
    expect(e.saved).toEqual([]);
    await flush();
    expect(calls("plan.draft").length).toBe(1);
  });

  it("Insert template calls dod.template.get only on press and appends the template with its source label", async () => {
    const m = await load();
    h.state.answers["dod.template.get"] = () => ({ ok: true, value: { source: "project", text: "- [ ] Reviewed" } });
    const e = editor(m);
    const buttons = insertButtons(e.render());
    expect(buttons.length).toBe(2);
    expect(h.state.calls).toEqual([]);
    await press(buttons[0]);
    expect(calls("dod.template.get").map((c) => c.input)).toEqual([{ projectId: P }]);
    const tree = e.render();
    expect(dodInput(tree, "Build").props.value).toBe("$ npm test\n- [ ] Reviewed");
    expect(dodInput(tree, "Ship").props.value).toBe("");
    expect(allText(tree)).toContain("Template from: Project settings");
    expect(calls("plan.draft")).toEqual([]);
  });

  it("a none template or an error changes nothing; none shows that no template is set", async () => {
    const m = await load();
    h.state.answers["dod.template.get"] = () => ({ ok: true, value: { source: "none", text: "" } });
    const e = editor(m);
    await press(insertButtons(e.render())[1]);
    let tree = e.render();
    expect(dodInput(tree, "Ship").props.value).toBe("");
    expect(allText(tree)).toContain("No DoD template is set");
    expect(saveButton(tree).props.disabled).toBe(true);

    h.state.answers["dod.template.get"] = () => ({ ok: false, error: { code: "store_invalid", message: "broken" } });
    await press(insertButtons(e.render())[0]);
    tree = e.render();
    expect(dodInput(tree, "Build").props.value).toBe("$ npm test");
    expect(saveButton(tree).props.disabled).toBe(true);
    expect(calls("plan.draft")).toEqual([]);
  });
});

describe("DodEditor save through the real plan commands (temp store)", () => {
  it("the captured plan.draft input creates an unapproved rev + 1 and leaves the earlier revision byte-identical", async () => {
    const plansSupport = "../server/test-support/plans";
    const featuresPath = "../server/features";
    const sessionsPath = "../server/sessions";
    const { makePlanProject } = (await import(/* @vite-ignore */ plansSupport));
    const { createFeatureCommands } = (await import(/* @vite-ignore */ featuresPath));
    const { UI_ORIGIN } = (await import(/* @vite-ignore */ sessionsPath));
    const t = await makePlanProject();
    // Every forwarded plans.draft write, so cleanup waits for it even when an assertion fails.
    const forwarded: Array<Promise<unknown>> = [];
    try {
      const seed = await t.seedAnswered();
      const features = createFeatureCommands({ directory: () => { throw new Error("unused"); }, now: () => new Date(AT), newId: () => "feat1" });
      const unwrap = (r: any) => {
        if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
        return r.value;
      };
      const featureId = unwrap(await features.create(t.open, { projectId: t.P, expectedRevision: await t.revision(), title: "F", description: "", kind: "feature" }, UI_ORIGIN)).featureId;
      const drafted = unwrap(
        await t.plans.draft(t.open, {
          projectId: t.P, expectedRevision: await t.revision(), featureId, title: "Rollout", sessionIds: [seed.sessionId], markdown: "# Rollout",
          tasks: [{ id: "t1", title: "Build", description: "do", dod: "$ npm test", completion: "human" }, { id: "t2", title: "Ship", description: "", dependsOn: ["t1"] }],
        }, UI_ORIGIN),
      );
      const view = unwrap(await t.plans.get(t.open, { projectId: t.P, planId: drafted.planId }));
      const rev1 = JSON.stringify(view.plan.revisions[0]);
      h.state.answers["plan.draft"] = (input) => {
        const write = t.plans.draft(t.open, input, UI_ORIGIN);
        forwarded.push(write);
        return write;
      };
      const m = await load();
      const saved: number[] = [];
      const e = mount(m.DodEditor, { hostId: HOST, projectId: t.P, theme, compact: false, plan: view.plan, revision: view.plan.revisions[0], storeRevision: view.revision, onSaved: (r: number) => void saved.push(r), onCancel: () => undefined });
      dodInput(e.render(), "Ship").props.onChangeText("Docs updated");
      await press(grillBox(e.render(), "Ship"));
      await press(saveButton(e.render()));
      expect(forwarded.length).toBe(1);
      await forwarded[0];
      await vi.waitFor(() => expect(saved).toEqual([2]), { timeout: 2000, interval: 10 });
      const after = unwrap(await t.plans.get(t.open, { projectId: t.P, planId: drafted.planId }));
      expect(after.plan.revisions.map((r: any) => r.rev)).toEqual([1, 2]);
      expect(JSON.stringify(after.plan.revisions[0])).toBe(rev1);
      const rev2 = after.plan.revisions[1];
      expect(rev2.schema).toBe(2);
      // R2.2 (task card §3.2): the grill: true task t2 carries its server-created session; the client never sends one.
      const t2Session = rev2.tasks[1].grillSessionId;
      expect(typeof t2Session, "server-created t2 grilling session").toBe("string");
      const read = await (await t.open(t.P)).read();
      expect(read.data.sessions.find((x: { id: string }) => x.id === t2Session)?.title).toBe("[task:t2] Ship");
      expect(calls("plan.draft")).toHaveLength(1);
      expect(JSON.stringify(calls("plan.draft").map((c) => c.input))).not.toContain("grillSessionId");
      expect(rev2.tasks).toEqual([
        { id: "t1", title: "Build", description: "do", dependsOn: [], parallel: false, completion: "human", grill: false, dod: "$ npm test" },
        { id: "t2", title: "Ship", description: "", dependsOn: ["t1"], parallel: false, completion: "auto", grill: true, grillSessionId: t2Session, dod: "Docs updated" },
      ]);
      expect("grillSessionId" in rev2.tasks[0]).toBe(false);
      expect(after.plan.featureId).toBe(featureId);
      expect(after.approval).toBe("unapproved");
      expect(after.approvals).toEqual([]);
    } finally {
      await Promise.allSettled(forwarded);
      await t.cleanup();
    }
  });
});

// R1 final review c0087: Insert template appends to the latest working text, not to the revision value.
describe("R1 final review c0087: template after typing", () => {
  it("typed text is kept and the template follows it on a new line; the other task is untouched", async () => {
    const m = await load();
    h.state.answers["dod.template.get"] = () => ({ ok: true, value: { source: "project", text: "- [ ] Reviewed" } });
    const e = editor(m);
    dodInput(e.render(), "Build").props.onChangeText("Mine");
    await press(insertButtons(e.render())[0]);
    const tree = e.render();
    expect(dodInput(tree, "Build").props.value).toBe("Mine\n- [ ] Reviewed");
    expect(dodInput(tree, "Ship").props.value).toBe("");
    expect(calls("dod.template.get").length).toBe(1);
  });
});
