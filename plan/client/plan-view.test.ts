// Plan view (redesign Stage R1.2, task card §3.3 PlanView integration, §3.4), in node. Harness after
// client/roadmap-screen.test.ts with effects run after each pass, so the shipped review pin (`held`,
// set in an effect) is established exactly as in the component, not bypassed. The REAL PlanView runs;
// `useQuery` returns a fixed PlanView value and `useRpc` records calls. Child components (TaskSpecRow,
// DodEditor, tracker sections) are not rendered; assertions read their element props.
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
    runs: undefined as unknown,
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
  // R4.2 harness: the feature's run list (key [...roadmapKey, "runs", featureId]) answers from
  // `h.state.runs` (default: none); every other query keeps the fixed PlanView value.
  // An explicit run-list query state (pending or error) is returned as is (R4 final KensAI c0018).
  useQuery: (opts: { queryKey?: unknown[] }) =>
    JSON.stringify(opts?.queryKey ?? []).includes('"runs"')
      ? h.state.runs && typeof h.state.runs === "object" && "__queryState" in h.state.runs
        ? (h.state.runs as { __queryState: unknown }).__queryState
        : { data: h.state.runs, isError: false }
      : { data: h.state.view, isError: false },
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
  h.state.runs = undefined;
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
const enabled = (els: El[]) => els.filter((el) => !el.props.disabled);
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

const viewPath = "./plan-view";
const editorPath = "./dod-editor";
const rowPath = "./task-spec-row";
const load = async () => (await import(/* @vite-ignore */ viewPath));
const GATES = "Approval becomes available once the DoD and grilling gates are in place";
const HINT = "Bind this plan to a feature to edit its tasks";

function planView(revisions: any[], over: Record<string, unknown> = {}, plan: Record<string, unknown> = {}) {
  return {
    revision: 12,
    plan: { id: "plan1", title: "Rollout", sessionIds: ["s1"], revisions, taskStates: [], ...plan },
    approvals: [],
    approval: "unapproved",
    notCurrentReasons: [],
    exportWritten: true,
    blockers: [],
    ...over,
  };
}
const LEGACY = [legacyRev(1, [{ id: "t1", title: "Build", description: "do" }], "# Legacy body")];
const BOUND = [legacyRev(1, [{ id: "t1", title: "Build", description: "do" }], "# Old body"), v2Rev(2, [v2Task("t1", { title: "Build", description: "do", dod: "ok" }), v2Task("t2", { title: "Ship" })], "# New body")];

function screen(m: any) {
  return mount(m.PlanView, { hostId: HOST, projectId: P, planId: "plan1", theme, compact: false, onBack: () => undefined });
}
const isMarkdown = (el: El) => nameOf(el) === "MarkdownText";
const approveButtons = (tree: unknown) => pressables(tree, /^Approve revision/);

describe("PlanView approval (§3.3)", () => {
  it("server blockers disable Approve, show the gates text, and send no approve call", async () => {
    const m = await load();
    h.state.view = planView(BOUND, { blockers: [{ code: "gates_not_available" }] }, { featureId: "f1" });
    const s = screen(m);
    const tree = s.render();
    expect(allText(tree)).toContain(GATES);
    expect(enabled(approveButtons(tree))).toEqual([]);
    // R1 review c0042: the Approve control is present and disabled, not merely absent.
    expect(approveButtons(tree).map((el) => el.props.disabled)).toEqual([true]);
    expect(calls("plan.approve")).toEqual([]);
  });

  it("a legacy plan with blockers [] keeps the shipped Approve, enabled after the review pin, and shows the binding hint", async () => {
    const m = await load();
    h.state.view = planView(LEGACY);
    const s = screen(m);
    const tree = s.render();
    const approve = enabled(approveButtons(tree));
    expect(approve.map(labelOf)).toEqual(["Approve revision 1"]);
    expect(allText(tree)).toContain(HINT);
    expect(allText(tree)).not.toContain(GATES);
    expect(pressables(tree, /^Edit DoD$/)).toEqual([]);
    await press(approve[0]);
    expect(calls("plan.approve").map((c) => c.input)).toEqual([{ projectId: P, planId: "plan1", rev: 1, contentHash: HASH }]);
  });
});

describe("PlanView task rows and DoD editor entry (§3.3)", () => {
  it("renders the shown revision's tasks through TaskSpecRow", async () => {
    const m = await load();
    const r = (await import(/* @vite-ignore */ rowPath));
    h.state.view = planView(BOUND, { blockers: [{ code: "gates_not_available" }] }, { featureId: "f1" });
    const rows = all(screen(m).render(), (el) => el.type === r.TaskSpecRow);
    expect(rows.map((el) => el.props.spec.id)).toEqual(["t1", "t2"]);
    expect(rows[0].props.spec.v2).toMatchObject({ dod: "ok" });
  });

  it("Edit DoD appears for a bound schema 2 latest revision under review and opens DodEditor with the reviewed store revision", async () => {
    const m = await load();
    const d = (await import(/* @vite-ignore */ editorPath));
    h.state.view = planView(BOUND, { blockers: [{ code: "gates_not_available" }] }, { featureId: "f1" });
    const s = screen(m);
    const edit = pressables(s.render(), /^Edit DoD$/);
    expect(edit.length).toBe(1);
    await press(edit[0]);
    const editors = all(s.render(), (el) => el.type === d.DodEditor);
    expect(editors.length).toBe(1);
    expect(editors[0].props).toMatchObject({ hostId: HOST, projectId: P, storeRevision: 12 });
    expect(editors[0].props.revision.rev).toBe(2);
    expect(editors[0].props.plan.id).toBe("plan1");
    expect(h.state.calls).toEqual([]);
    expect(allText(s.render())).not.toContain(HINT);
  });

  it("no Edit DoD while an older revision is shown, or once a newer revision is loaded but not reviewed", async () => {
    const m = await load();
    h.state.view = planView(BOUND, { blockers: [{ code: "gates_not_available" }] }, { featureId: "f1" });
    const s = screen(m);
    expect(pressables(s.render(), /^Edit DoD$/).length).toBe(1);
    await press(pressables(s.render(), /^Show revision 1$/)[0]);
    expect(pressables(s.render(), /^Edit DoD$/)).toEqual([]);

    const s2 = screen(m);
    expect(pressables(s2.render(), /^Edit DoD$/).length).toBe(1);
    h.state.view = planView([...BOUND, v2Rev(3, [v2Task("t1", { title: "Build" })], "# Newer")], { revision: 13, blockers: [{ code: "gates_not_available" }] }, { featureId: "f1" });
    const tree = s2.render();
    expect(pressables(tree, /^Edit DoD$/)).toEqual([]);
    expect(pressables(tree, /^Review revision 3$/).length).toBe(1);
  });
});

describe("PlanView compare (§3.3)", () => {
  it("comparing with another revision shows the diff and hides the Markdown; the same revision or none shows the normal view", async () => {
    const m = await load();
    h.state.view = planView(BOUND, { blockers: [{ code: "gates_not_available" }] }, { featureId: "f1" });
    const s = screen(m);
    let tree = s.render();
    expect(all(tree, isMarkdown).length).toBe(1);
    const compareWith = (rev: number) => pressables(s.render(), new RegExp(`^Compare with.*\\b${rev}\\b`));
    expect(compareWith(1).length).toBe(1);
    await press(compareWith(1)[0]);
    tree = s.render();
    expect(all(tree, isMarkdown)).toEqual([]);
    const text = allText(tree);
    expect(text).toContain("Ship");
    expect(text).not.toContain("# New body");
    const same = compareWith(2);
    expect(same.length).toBe(1);
    await press(same[0]);
    expect(all(s.render(), isMarkdown).length).toBe(1);
    expect(h.state.calls).toEqual([]);
  });
});

// R1 review c0001 / c0013: the task preview resolves dependency titles from the shown revision only,
// and approval blockers (which describe the latest revision) appear only while the latest is shown.
describe("R1 review: shown-revision titles and latest-only blockers", () => {
  const renamed = () => [
    v2Rev(1, [v2Task("t1", { title: "Build" }), v2Task("t2", { title: "Ship", dependsOn: ["t1"] })], "# One"),
    v2Rev(2, [v2Task("t1", { title: "Build v2" }), v2Task("t2", { title: "Ship", dependsOn: ["t1"] })], "# Two"),
  ];

  it("c0001: rev 1's task rows resolve t1 to its rev-1 title; rev 2's rows to the renamed title (control)", async () => {
    const m = await load();
    const r = (await import(/* @vite-ignore */ rowPath));
    h.state.view = planView(renamed(), { blockers: [{ code: "gates_not_available" }] }, { featureId: "f1" });
    const s = screen(m);
    const titlesOf = () => all(s.render(), (el) => el.type === r.TaskSpecRow).map((el) => el.props.titles.t1);
    expect(titlesOf()).toEqual(["Build v2", "Build v2"]);
    await press(pressables(s.render(), /^Show revision 1$/)[0]);
    expect(titlesOf()).toEqual(["Build", "Build"]);
  });

  it("c0013: blockers show while the latest revision is shown and are hidden under an older revision", async () => {
    const m = await load();
    h.state.view = planView(renamed(), { blockers: [{ code: "gates_not_available" }] }, { featureId: "f1" });
    const s = screen(m);
    expect(allText(s.render())).toContain(GATES);
    await press(pressables(s.render(), /^Show revision 1$/)[0]);
    const older = allText(s.render());
    expect(older).not.toContain(GATES);
    expect(older).toContain("Only the latest revision can be approved");
    expect(h.state.calls).toEqual([]);
  });
});

// R1 exact-review c0050 / c0044 (card §9.5, §9.7).
describe("R1 review: back label and store-only move", () => {
  it("c0050: the loaded plan view's header back control is labelled ‹ Back, with no ‹ Overview", async () => {
    const m = await load();
    h.state.view = planView(LEGACY);
    const tree = screen(m).render();
    expect(pressables(tree, /^‹ Back$/).length).toBe(1);
    expect(pressables(tree, /‹ Overview/)).toEqual([]);
  });

  it("c0044: a store-only move (revision 13 vs the reviewed 12, no new plan revision) hides Edit DoD; at 12 it is shown (control)", async () => {
    const m = await load();
    h.state.view = planView(BOUND, { blockers: [{ code: "gates_not_available" }] }, { featureId: "f1" });
    const s = screen(m);
    expect(pressables(s.render(), /^Edit DoD$/).length).toBe(1);
    h.state.view = planView(BOUND, { revision: 13, blockers: [{ code: "gates_not_available" }] }, { featureId: "f1" });
    const tree = s.render();
    expect(pressables(tree, /^Edit DoD$/)).toEqual([]);
    expect(pressables(tree, /^Review revision/)).toEqual([]);
    expect(h.state.calls).toEqual([]);
  });
});

// Stage R2.3 (task card 2026-10-29 §4.2, §4.3, §6 G5): PlanView lists reuseCandidates as read-only
// text "Completed in revision N: <title>", followed by the date only when verifiedAt is present, and
// renders nothing for an absent or empty list. There is no Rework control in R2.
describe("R2.3 read-only reuse candidates", () => {
  const textLines = (tree: unknown) => allText(tree).split("\n").map((x) => x.trim()).filter((x) => x !== "");
  /** Text lines present in `tree` but not in the same view without candidates (structure-agnostic). */
  const added = (tree: unknown, without: unknown) => {
    const base = new Set(textLines(without));
    return [...new Set(textLines(tree))].filter((x) => !base.has(x));
  };
  const DATED = { planRev: 2, taskId: "t2", title: "Ship", verifiedAt: "2026-10-27T09:30:00.000Z" };
  const UNDATED = { planRev: 1, taskId: "t1", title: "Build" };
  const render = async (over: Record<string, unknown>) => {
    const m = await load();
    h.state.view = planView(BOUND, over, { featureId: "f1" });
    return screen(m).render();
  };

  it("lists each candidate in the given order; the date appears only when verifiedAt is present", async () => {
    const without = await render({});
    const tree = await render({ reuseCandidates: [DATED, UNDATED] });
    const text = added(tree, without).join("\n");
    expect(text).toContain("Completed in revision 2: Ship");
    expect(text).toContain("Completed in revision 1: Build");
    expect(text.indexOf("Completed in revision 2: Ship")).toBeLessThan(text.indexOf("Completed in revision 1: Build"));
    expect(text, "the known date is shown").toMatch(/2026/);
    const undatedOnly = added(await render({ reuseCandidates: [UNDATED] }), without).join(" ");
    expect(undatedOnly).toContain("Completed in revision 1: Build");
    expect(undatedOnly.split("Completed in revision 1: Build").join(""), "no invented date").not.toMatch(/\d/);
    expect(h.state.calls).toEqual([]);
  });

  it("renders nothing for an absent or empty list, and never offers a Rework control", async () => {
    const without = await render({});
    expect(allText(without)).not.toContain("Completed in revision");
    const empty = await render({ reuseCandidates: [] });
    expect(allText(empty)).not.toContain("Completed in revision");
    expect(added(empty, without)).toEqual([]);
    const listed = await render({ reuseCandidates: [UNDATED] });
    expect(allText(listed)).toContain("Completed in revision 1: Build");
    for (const tree of [without, empty, listed]) expect(pressables(tree, /rework/i)).toEqual([]);
    expect(all(listed, (el) => typeof handlerOf(el) === "function" && /Completed in revision/.test(labelOf(el)))).toEqual([]);
  });
});

// R2 corrective c0015 (task card 2026-10-29 §8.4, §8.6): pending approval effects are shown under the
// Approve area. "Retry approval effects" appears only when the displayed revision is the latest, not
// reworked, blockers are empty, the approval is current, and no entry has retryBlocked. Eligibility
// never reads the reason text. The control calls the existing plan.approve with the exact
// displayed rev and contentHash; otherwise the reasons stay visible with the gates line.
describe("R2 corrective c0015: pending approval effects and the retry control", () => {
  const GATES_NOW = "The approval gates now block this; resolve them first.";
  const COPY = { effect: "project_copy", reason: "the project copy of approval r1 is not recorded" };
  const PLANNED_EFFECT = { effect: "feature_planned", reason: "the feature is still created" };
  const retryControls = (tree: unknown) => pressables(tree, /^Retry approval effects$/);
  const render = async (over: Record<string, unknown>, plan: Record<string, unknown> = {}) => {
    const m = await load();
    h.state.view = planView(BOUND, { approval: "current", ...over }, { featureId: "f1", ...plan });
    const s = screen(m);
    return { s, tree: s.render() };
  };

  it("eligible: reasons shown, the control is enabled and calls plan.approve with the displayed latest rev and hash", async () => {
    const { tree } = await render({ approvalEffectsPending: [COPY, PLANNED_EFFECT] });
    const text = allText(tree);
    expect(text).toContain(COPY.reason);
    expect(text).toContain(PLANNED_EFFECT.reason);
    expect(text).not.toContain(GATES_NOW);
    const controls = retryControls(tree);
    expect(controls).toHaveLength(1);
    expect(enabled(controls)).toHaveLength(1);
    await press(controls[0]);
    expect(calls("plan.approve").map((c) => c.input)).toEqual([{ projectId: P, planId: "plan1", rev: 2, contentHash: HASH }]);
  });

  it("eligibility ignores the reason text: altered reasons keep the control; retryBlocked with an innocuous reason suppresses it", async () => {
    const altered = await render({ approvalEffectsPending: [{ effect: "project_copy", reason: "Something else entirely" }] });
    expect(retryControls(altered.tree)).toHaveLength(1);
    const blocked = await render({ approvalEffectsPending: [{ effect: "project_copy", reason: "All good", retryBlocked: "feature_has_multiple_plans" }] });
    expect(retryControls(blocked.tree)).toEqual([]);
    expect(allText(blocked.tree)).toContain("All good");
    // R2 c0036 (card §8.8): no generic gates line when retryBlocked, with or without blockers.
    expect(allText(blocked.tree)).not.toContain(GATES_NOW);
    const blockedWithGates = await render({ approvalEffectsPending: [{ effect: "project_copy", reason: "All good", retryBlocked: "feature_has_multiple_plans" }], blockers: [{ code: "dod_missing", taskId: "t1" }] });
    expect(retryControls(blockedWithGates.tree)).toEqual([]);
    expect(allText(blockedWithGates.tree)).not.toContain(GATES_NOW);
    const oneBlocked = await render({ approvalEffectsPending: [PLANNED_EFFECT, { ...COPY, retryBlocked: "feature_has_multiple_plans" }] });
    expect(retryControls(oneBlocked.tree)).toEqual([]);
    expect(calls("plan.approve")).toEqual([]);
  });

  it("blockers, a non-current approval or a reworked latest revision suppress the control; the reasons stay visible", async () => {
    const blocked = await render({ approvalEffectsPending: [COPY, PLANNED_EFFECT], blockers: [{ code: "grilling_required", sessionId: "s9" }] });
    expect(retryControls(blocked.tree)).toEqual([]);
    expect(allText(blocked.tree)).toContain(COPY.reason);
    expect(allText(blocked.tree)).toContain(GATES_NOW);
    const notCurrent = await render({ approval: "not_current", notCurrentReasons: ["x"], approvalEffectsPending: [COPY] });
    expect(retryControls(notCurrent.tree)).toEqual([]);
    expect(allText(notCurrent.tree)).toContain(COPY.reason);
    // R2 c0036 (card §8.8): with empty blockers the generic gates line would be untrue; it is omitted.
    expect(allText(notCurrent.tree)).not.toContain(GATES_NOW);
    const reworked = await render({ approvalEffectsPending: [COPY, PLANNED_EFFECT] }, { reworks: [{ planRev: 2, at: AT, reason: "Scope", actor: { kind: "human" } }] });
    expect(retryControls(reworked.tree)).toEqual([]);
    expect(allText(reworked.tree)).toContain(COPY.reason);
    expect(allText(reworked.tree)).toContain(PLANNED_EFFECT.reason);
    expect(allText(reworked.tree)).not.toContain(GATES_NOW);
    expect(calls("plan.approve")).toEqual([]);
  });

  it("an older displayed revision shows no control; absent, empty or current-without-pending shows neither control nor notice", async () => {
    const { s } = await render({ approvalEffectsPending: [COPY] });
    expect(retryControls(s.render())).toHaveLength(1);
    await press(pressables(s.render(), /^Show revision 1$/)[0]);
    expect(retryControls(s.render())).toEqual([]);
    for (const over of [{}, { approvalEffectsPending: [] }]) {
      const { tree } = await render(over);
      expect(retryControls(tree)).toEqual([]);
      expect(allText(tree)).not.toContain(GATES_NOW);
      expect(allText(tree)).not.toContain(COPY.reason);
    }
    expect(calls("plan.approve")).toEqual([]);
  });
});

// R4.2 verification (task card §3 "Plan-view alignment"): the plan view never offers Verify… for a
// revision that a run of the feature manages (same planId and planRev, in ANY state, ended included),
// exactly the server's refusal rule; a non-run revision keeps Verify….
describe("R4.2 verification: no manual Verify for a run-managed revision", () => {
  const DONE_T1 = { taskStates: [{ planRev: 2, taskId: "t1", status: "done", updatedAt: AT }], featureId: "f1" };
  const runOf = (planId: string, planRev: number, state: string) => ({ run: { id: `run-${planRev}`, featureId: "f1", planId, planRev, state, runToken: "tok" }, ready: [], blocked: [] });
  const verifyButtons = async (runs: unknown) => {
    const m = await load();
    h.state.view = planView(BOUND, { approval: "current" }, DONE_T1);
    h.state.runs = runs;
    const s = screen(m);
    s.render();
    await flush();
    return pressables(s.render(), /^Verify…$/);
  };

  it("control: without a run of this revision a done task offers Verify…", async () => {
    // A resolved, empty run list (was `undefined` data, which reads as an unresolved list; R4 final KensAI c0018).
    expect((await verifyButtons({ revision: 12, runs: [] })).length).toBeGreaterThanOrEqual(1);
    expect((await verifyButtons({ revision: 12, runs: [runOf("plan1", 1, "ended")] })).length, "a run of another revision does not hide it").toBeGreaterThanOrEqual(1);
    expect((await verifyButtons({ revision: 12, runs: [runOf("other-plan", 2, "running")] })).length, "a run of another plan does not hide it").toBeGreaterThanOrEqual(1);
  });

  // R4 final KensAI c0018: an unresolved feature run list (pending or failed) is not "no run": Verify… stays hidden.
  it("a pending or failed run list hides Verify…", async () => {
    const states: Array<[string, unknown]> = [
      ["pending", { data: undefined, isPending: true, isError: false }],
      ["failed", { data: undefined, isPending: false, isError: true, error: new Error("runs unreadable") }],
    ];
    for (const [label, state] of states) expect(await verifyButtons({ __queryState: state }), label).toEqual([]);
  });

  it("a run of exactly this plan revision in any state, ended included, hides Verify…", async () => {
    for (const state of ["running", "paused", "ended"]) {
      expect(await verifyButtons({ revision: 12, runs: [runOf("plan1", 2, state)] }), state).toEqual([]);
    }
  });
});

// ======================= Changes (R4 card §3.x addendum) =======================
// plan-view.tsx exports the existing DiffView unchanged and a stateless RevisionCompare({ revisions,
// shown, compareRev, onCompare, theme, fallback }) reused by PlanView (output unchanged; the PlanView
// compare tests above are the regression) and by the feature Changes section.
describe("Changes: RevisionCompare (stateless) and DiffView exports", () => {
  const expandAll = (tree: unknown): El[] => {
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
  const textAll = (tree: unknown) => expandAll(tree).map((el) => [typeof el.props.label === "string" ? el.props.label : "", typeof el.props.children === "string" ? el.props.children : Array.isArray(el.props.children) ? el.props.children.filter((c: unknown) => typeof c === "string").join("") : ""].join(" ")).join("\n");
  const REVS = [v2Rev(1, [v2Task("t1", { title: "Build" })], "# One"), v2Rev(2, [v2Task("t1", { title: "Build" }), v2Task("t2", { title: "Ship" })], "# Two")];
  const FALLBACK = { type: "Fallback", props: { children: "FALLBACK-MARKER" } };
  const loadCompare = async () => {
    const m = await load();
    for (const n of ["RevisionCompare", "DiffView"]) expect(typeof m[n], `plan-view exports ${n}`).toBe("function");
    return m as { RevisionCompare: (p: unknown) => unknown; DiffView: (p: unknown) => unknown };
  };

  it("compareRev null → the compare buttons (one per other revision) and the fallback; pressing one calls onCompare(rev) once", async () => {
    const m = await loadCompare();
    const picked: number[] = [];
    const tree = m.RevisionCompare({ revisions: REVS, shown: REVS[1], compareRev: null, onCompare: (r: number) => void picked.push(r), theme, fallback: FALLBACK });
    const els = expandAll(tree);
    expect(els.some((e) => e === (FALLBACK as unknown))).toBe(true);
    // The real ActionButton expands to a Pressable carrying the label as accessibilityLabel (verify repair).
    const labelOf = (e: El) => String(e.props.label ?? e.props.accessibilityLabel ?? "");
    const buttons = els.filter((e) => typeof e.props.onPress === "function" && /^Compare with revision \d+$/.test(labelOf(e)));
    expect(buttons.map(labelOf)).toEqual(["Compare with revision 1", "Compare with revision 2"]);
    buttons[0].props.onPress();
    expect(picked).toEqual([1]);
  });

  it("compareRev set and different from shown → DiffView (from → to) instead of the fallback; equal to shown → the fallback", async () => {
    const m = await loadCompare();
    const diff = m.RevisionCompare({ revisions: REVS, shown: REVS[1], compareRev: 1, onCompare: () => undefined, theme, fallback: FALLBACK });
    const els = expandAll(diff);
    expect(els.some((e) => e === (FALLBACK as unknown)), "no fallback while comparing").toBe(false);
    expect(textAll(diff)).toContain("Changes from revision 1 to 2");
    expect(textAll(diff)).toContain("Ship");
    const same = m.RevisionCompare({ revisions: REVS, shown: REVS[1], compareRev: 2, onCompare: () => undefined, theme, fallback: FALLBACK });
    expect(expandAll(same).some((e) => e === (FALLBACK as unknown))).toBe(true);
  });

  it("a single revision renders no compare buttons, only the fallback", async () => {
    const m = await loadCompare();
    const tree = m.RevisionCompare({ revisions: [REVS[0]], shown: REVS[0], compareRev: null, onCompare: () => undefined, theme, fallback: FALLBACK });
    const els = expandAll(tree);
    expect(els.filter((e) => /^Compare with/.test(String(e.props.label ?? e.props.accessibilityLabel ?? "")))).toEqual([]);
    expect(els.some((e) => e === (FALLBACK as unknown))).toBe(true);
  });
});
