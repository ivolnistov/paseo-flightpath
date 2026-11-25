// Shared answer panel (redesign Stage R1.3b, task card §4.2.3, §4.2.4), in node: the REAL
// QuestionAnswerPanel and useRoadmapMutation run over hand-built SessionView values; React Native and
// host UI are inert markers; `useRpc` records calls. The panel is also used by timeline-card.tsx, so
// its props are unchanged. Child components are not rendered; assertions read element props.
// Limitations: no reconciler, layout, host or native behaviour; this does not prove the live UI.
import { beforeEach, describe, expect, it, vi } from "vitest";

type El = { type: unknown; props: Record<string, any> };

const h = vi.hoisted(() => {
  const state = {
    slots: [] as unknown[],
    index: 0,
    dirty: false,
    effects: [] as Array<() => unknown>,
    effectIndex: 0,
    effectDeps: [] as Array<unknown[] | undefined>,
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
  // Effects run after a render pass when their dependencies changed (always without a dependency
  // list), as React runs them; dependencies are kept per mounted component.
  const useEffect = (fn: () => unknown, deps?: unknown[]) => {
    const i = state.effectIndex++;
    const prev = state.effectDeps[i];
    if (deps === undefined || prev === undefined || deps.length !== prev.length || deps.some((d, k) => !Object.is(d, prev[k]))) {
      state.effectDeps[i] = deps;
      state.effects.push(fn);
    }
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
  const effectDeps: Array<unknown[] | undefined> = [];
  let props = initial;
  const render = (next?: Record<string, unknown>): El => {
    if (next) props = next;
    h.state.slots = slots;
    h.state.effectDeps = effectDeps;
    for (let pass = 0; pass < 30; pass++) {
      h.state.index = 0;
      h.state.effectIndex = 0;
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

// ---- Synthetic session views (hand-built SessionView values) ----
const ab = [{ id: "a", label: "Option A", description: "Because A" }, { id: "b", label: "Option B" }];
const answerOf = (optionId: string, note?: string) => ({ rev: 1, optionId, source: "ui", actor: { kind: "human" }, at: AT, ...(note ? { note } : {}) });
function q(id: string, title: string, extra: Record<string, unknown> = {}): any {
  return {
    id, order: 0, title, context: "", options: ab, allowFreeText: false, definitionRev: 1, activatedBy: [], invalidatedBy: [],
    revisions: [], discussion: [{ id: "n1", at: AT, actor: { kind: "agent", agentId: "ag" }, text: "Stored discussion" }], validity: "valid", ...extra,
  };
}
// Session views carry each question's stable number and links; the number is taken from the id.
const numberOf = (id: string) => Number(id.replace(/\D/g, "")) || 1;
const qv = (question: any, status = question.answer ? "answered" : "open") => ({
  question, visibility: "active", status, depth: 0, number: numberOf(question.id),
  links: { question: `roadmap://${P}/s/S/q/${numberOf(question.id)}`, answer: `roadmap://${P}/s/S/q/${numberOf(question.id)}/answer` },
});
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

const panelPath = "./question-answer-panel";
const load = async () => (await import(/* @vite-ignore */ panelPath));
function panel(m: any, view: any, questionId: string) {
  return mount(m.QuestionAnswerPanel, { hostId: HOST, projectId: P, view, questionId, theme, compact: false });
}
const MUTATIONS = /^(Answer|Confirm|Skip)$/;
const inputs = (tree: unknown) => all(tree, (el) => nameOf(el) === "TextInput").map((el) => String(el.props.accessibilityLabel ?? ""));

describe("QuestionAnswerPanel read-only gate (§4.2.3)", () => {
  it("an open question keeps Answer, option selection and the note input (control)", async () => {
    const m = await load();
    const tree = panel(m, blockedView(), "q4").render();
    expect(pressables(tree, /^Answer$/).length).toBe(1);
    expect(inputs(tree)).toContain("Answer note");
    expect(pressables(tree, /^Option A$/).length).toBe(1);
    expect(allText(tree)).not.toMatch(/Read-only/);
  });

  // Answers on accepted blocks: the accepted definition stays frozen, but the owner may re-answer,
  // skip or mark out of scope; the current answer and its note stay visible.
  it("a frozen answered question keeps Skip and Out of scope, offers a re-answer, and shows the answer and Answer.note", async () => {
    const m = await load();
    const p = panel(m, blockedView(), "q1");
    let tree = p.render();
    expect(pressables(tree, /^Skip$/).length).toBe(1);
    expect(pressables(tree, /^Out of scope$/).length).toBe(1);
    if (pressables(tree, /^Answer$/).length === 0) {
      await press(pressables(tree, /edit answer/i)[0]);
      tree = p.render();
    }
    expect(pressables(tree, /^Answer$/).length).toBe(1);
    expect(pressables(tree, /^Option B$/).length).toBe(1);
    const text = allText(tree);
    expect(text).toContain("Option A");
    expect(text).toContain("because");
  });

  // A cancelled decision stays read-only, also in an accepted block, where its cancellation (not the
  // accepted block) is what forbids answering.
  it("a cancelled open-block question, a frozen cancelled one and a cancelled legacy one are read-only", async () => {
    const m = await load();
    for (const [view, id] of [
      [blockedView(), "q5"],
      [blockedView(), "q2"],
      [legacyView(), "l3"],
    ] as const) {
      const tree = panel(m, view, id).render();
      expect(pressables(tree, MUTATIONS), id).toEqual([]);
      expect(pressables(tree, /^Out of scope$/), id).toEqual([]);
      expect(inputs(tree).filter((l) => /note|Free-text/i.test(l)), id).toEqual([]);
      expect(allText(tree), id).toContain("Read-only");
    }
    expect(allText(panel(m, blockedView(), "q5").render())).toContain("Read-only: decision cancelled");
  });

  it("a closed legacy session is never frozen; a stale question is not read-only", async () => {
    const m = await load();
    const closed = panel(m, legacyView("closed"), "l2").render();
    expect(allText(closed)).not.toMatch(/Read-only/);
    const stale = panel(m, blockedView(), "q6").render();
    expect(allText(stale)).not.toMatch(/Read-only/);
    expect(pressables(stale, /^Answer$/).length).toBe(1);
  });
});

describe("QuestionAnswerPanel display (§4.2.3)", () => {
  it("the Why toggle shows the option description, also when read-only", async () => {
    const m = await load();
    for (const id of ["q4", "q1"]) {
      const p = panel(m, blockedView(), id);
      expect(allText(p.render()), id).not.toContain("Because A");
      const why = pressables(p.render(), /^Why/);
      expect(why.length, id).toBeGreaterThan(0);
      await press(why[0]);
      expect(allText(p.render()), id).toContain("Because A");
    }
  });

  it("the recommended option is rendered first with a Recommended mark; the options array is not mutated", async () => {
    const m = await load();
    const view = blockedView();
    const before = JSON.stringify(view.questions.find((x: any) => x.question.id === "q4").question.options);
    const text = allText(panel(m, view, "q4").render());
    expect(text.indexOf("Option B")).toBeGreaterThanOrEqual(0);
    expect(text.indexOf("Option B")).toBeLessThan(text.indexOf("Option A"));
    expect(text).toContain("Recommended");
    expect(JSON.stringify(view.questions.find((x: any) => x.question.id === "q4").question.options)).toBe(before);
  });

  it("the chosen option shows ✓ Chosen and there is no Answered pill", async () => {
    const m = await load();
    const text = allText(panel(m, blockedView(), "q1").render());
    expect(text).toContain("✓ Chosen");
    expect(text).not.toMatch(/\bAnswered\b/);
    expect(allText(panel(m, blockedView(), "q4").render())).not.toContain("✓ Chosen");
  });
});

// R1.3b correction: Answer, Confirm and Skip on the grilling screen meet the 44 px target, as a real
// ActionButton or a rendered element with minHeight and minWidth of at least 44.
describe("R1.3b correction: answer panel touch targets", () => {
  it("Answer and Skip on an open question, and Confirm on a stale one, are 44 px targets", async () => {
    const m = await load();
    const rs = (await import(/* @vite-ignore */ String("./roadmap-screen"))); // non-literal: keeps TSX out of the node program
    const big = (el: El) => {
      const s = flat(el.props.style);
      return el.type === rs.ActionButton || (s.minHeight >= 44 && s.minWidth >= 44);
    };
    const open = panel(m, blockedView(), "q4").render();
    const stale = panel(m, blockedView(), "q6").render();
    for (const [tree, label] of [[open, /^Answer$/], [open, /^Skip$/], [stale, /^Confirm$/], [stale, /^Answer$/]] as const) {
      const found = pressables(tree, label);
      expect(found.length, String(label)).toBe(1);
      expect(big(found[0]), String(label)).toBe(true);
    }
  });
});

// The recommended option is preselected on an unanswered question; submitting it unchanged records
// the owner's accepted default. Out of scope is its own explicit action beside Skip.
describe("QuestionAnswerPanel defaults and Out of scope", () => {
  const unanswered = () => {
    const view = blockedView();
    const q4 = view.questions.find((x: any) => x.question.id === "q4");
    q4.question = { ...q4.question, validity: "unanswered" };
    return view;
  };
  const selectedOptions = (tree: unknown) => all(tree, (el) => el.props.accessibilityRole === "radio" && el.props.accessibilityState?.selected === true).map(labelOf);

  it("preselects the recommended option of an unanswered question and submits it as defaulted", async () => {
    h.state.cacheRevision = 7;
    const m = await load();
    const p = panel(m, unanswered(), "q4");
    expect(selectedOptions(p.render())).toEqual(["Option B"]);
    await press(pressables(p.render(), /^Answer$/)[0]);
    const call = h.state.calls.find((c) => c.name === "question.answer");
    expect(call?.input).toMatchObject({ sessionId: "S", questionId: "q4", optionId: "b", defaulted: true });
  });

  it("an option the owner picked is not a default", async () => {
    h.state.cacheRevision = 7;
    const m = await load();
    const p = panel(m, unanswered(), "q4");
    await press(pressables(p.render(), /^Option A$/)[0]);
    expect(selectedOptions(p.render())).toEqual(["Option A"]);
    await press(pressables(p.render(), /^Answer$/)[0]);
    const call = h.state.calls.find((c) => c.name === "question.answer");
    expect(call?.input).toMatchObject({ optionId: "a" });
    expect(call?.input.defaulted).not.toBe(true);
  });

  it("nothing is preselected on an answered or stale question, or without a recommendation", async () => {
    const m = await load();
    expect(selectedOptions(panel(m, blockedView(), "q6").render())).toEqual([]);
    expect(selectedOptions(panel(m, legacyView(), "l2").render())).toEqual([]);
  });

  it("Out of scope is offered beside Skip and calls question.out_of_scope for this question", async () => {
    h.state.cacheRevision = 7;
    const m = await load();
    const tree = panel(m, unanswered(), "q4").render();
    expect(pressables(tree, /^Skip$/).length).toBe(1);
    await press(pressables(tree, /^Out of scope$/)[0]);
    const calls = h.state.calls.filter((c) => c.name === "question.out_of_scope");
    expect(calls).toHaveLength(1);
    expect(calls[0].input).toMatchObject({ sessionId: "S", questionId: "q4" });
    expect(h.state.calls.filter((c) => c.name === "question.skip")).toEqual([]);
  });

  it("Out of scope is also available on a question of an accepted block", async () => {
    h.state.cacheRevision = 7;
    const m = await load();
    await press(pressables(panel(m, blockedView(), "q1").render(), /^Out of scope$/)[0]);
    expect(h.state.calls.filter((c) => c.name === "question.out_of_scope").map((c) => c.input.questionId)).toEqual(["q1"]);
  });

  it("Out of scope is a 44 px target", async () => {
    const m = await load();
    const [control] = pressables(panel(m, unanswered(), "q4").render(), /^Out of scope$/);
    expect(control).toBeDefined();
    const screenPath = "./roadmap-screen";
    const rs = await import(/* @vite-ignore */ screenPath);
    expect(control.type === rs.ActionButton || flat(control.props.style).minHeight >= 44).toBe(true);
  });
});

// One panel instance shown for another question starts a fresh draft: the earlier question's typed
// text, note and option choice never carry over, and the new question's own recommendation is
// preselected.
describe("QuestionAnswerPanel draft per question", () => {
  const draftView = () => {
    const view = blockedView({ cancellations: [] });
    for (const x of view.questions) {
      if (x.question.id === "q4") x.question = { ...x.question, validity: "unanswered", allowFreeText: true, recommendedOptionId: "b" };
      if (x.question.id === "q5") x.question = { ...x.question, validity: "unanswered", allowFreeText: true, recommendedOptionId: "a" };
    }
    return view;
  };
  const selectedOptions = (tree: unknown) => all(tree, (el) => el.props.accessibilityRole === "radio" && el.props.accessibilityState?.selected === true).map(labelOf);
  const field = (tree: unknown, label: string) => {
    const found = all(tree, (el) => el.props.accessibilityLabel === label && typeof el.props.onChangeText === "function");
    expect(found.length, label).toBe(1);
    return found[0];
  };

  it("switching the question clears the typed text, the note and the choice, and preselects the new recommendation", async () => {
    h.state.cacheRevision = 7;
    const m = await load();
    const view = draftView();
    const p = panel(m, view, "q4");
    await press(pressables(p.render(), /^Option A$/)[0]);
    field(p.render(), "Answer note").props.onChangeText("note for Q4");
    field(p.render(), "Free-text answer").props.onChangeText("text for Q4");
    await flush();
    const tree = p.render({ ...p.props(), questionId: "q5" });
    expect(field(tree, "Answer note").props.value).toBe("");
    expect(field(tree, "Free-text answer").props.value).toBe("");
    expect(selectedOptions(tree)).toEqual(["Option A"]);
    const back = p.render({ ...p.props(), questionId: "q4" });
    expect(selectedOptions(back), "Q4's own recommendation, not the earlier choice").toEqual(["Option B"]);
    expect(field(back, "Answer note").props.value).toBe("");
    expect(h.state.calls.filter((c) => c.name.startsWith("question."))).toEqual([]);
  });
});
