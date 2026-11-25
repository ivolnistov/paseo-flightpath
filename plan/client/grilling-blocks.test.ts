// Grilling screen (redesign Stage R1.3b, task card §4.2.2–§4.2.4), in node: the pure helpers, the
// REAL GrillingBlocks with the REAL useRoadmapMutation (recording `useRpc`, effects run after each
// pass). Child components are not rendered; their props are read and their handlers invoked. Modules are
// loaded per test, so every case is collected while they are missing.
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
    // S3: chat titles the mocked useAgent returns (absent id → no snapshot).
    agentTitles: {} as Record<string, string | null>,
    agentStatuses: {} as Record<string, string>,
    invalidations: 0,
    /** Texts passed to copyText. */
    copied: [] as string[],
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
  // Refs keep their object across passes (slot-backed), like React's.
  const useRef = (v: unknown) => {
    const i = h.state.index++;
    if (!(i in h.state.slots)) h.state.slots[i] = { current: v };
    return h.state.slots[i];
  };
  const passthrough = { useState: h.useState, useEffect: h.useEffect, useCallback: (fn: unknown) => fn, useMemo: (fn: () => unknown) => fn(), useRef };
  return { ...real, ...passthrough, default: { ...(real.default as object), ...passthrough } };
});
vi.mock("react-native", () => ({ Text: h.marker("Text"), View: h.marker("View"), Pressable: h.marker("Pressable"), ScrollView: h.marker("RNScrollView") }));
vi.mock("@getpaseo/plugin/client/react-native", () => ({
  TextInput: h.marker("TextInput"),
  ScrollView: h.marker("ScrollView"),
  Modal: Object.assign(h.marker("Modal"), { Content: h.marker("ModalContent") }),
  Icon: h.marker("Icon"),
  useToast: () => ({ show: (m: string) => void h.state.toasts.push(m), error: (m: string) => void h.state.toasts.push(m) }),
  copyText: async (text: string) => void h.state.copied.push(text),
}));
vi.mock("@getpaseo/plugin/client", () => ({
  useRpc: h.useRpc,
  useWorkspace: () => ({}),
  useSettings: () => ({ status: "loading" }),
  // S3: the header bar reads the planner's chat title; the picker (not rendered here) reads the host.
  useAgent: (id: string, select?: (a: { title: string | null; status?: string }) => unknown) => {
    if (!(id in h.state.agentTitles) && !(id in h.state.agentStatuses)) return null;
    const agent = { title: h.state.agentTitles[id] ?? null, ...(id in h.state.agentStatuses ? { status: h.state.agentStatuses[id] } : {}) };
    return select ? select(agent) : agent;
  },
  usePaseo: () => null,
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: h.state.view, isError: false }),
  useQueryClient: () => ({
    getQueryData: (key: unknown[]) => (key.at(-1) === "version" && h.state.cacheRevision !== null ? { status: "ok", revision: h.state.cacheRevision } : undefined),
    getQueriesData: () => [],
    invalidateQueries: async () => void h.state.invalidations++,
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
  h.state.agentTitles = {};
  h.state.agentStatuses = {};
  h.state.invalidations = 0;
  h.state.copied = [];
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

const blocksPath = "./grilling-blocks";
const cardPath = "./question-card";
const load = async () => (await import(/* @vite-ignore */ blocksPath));
const canvasCardPath = "./question-canvas-card";
const loadCanvasCard = async () => (await import(/* @vite-ignore */ canvasCardPath));
/** The navigator item of Block n. */
const blockItem = (tree: unknown, n: number): El => {
  const found = pressables(tree, new RegExp(`^Block ${n},`));
  expect(found.length, `one navigator item for Block ${n}`).toBe(1);
  return found[0];
};
const loadCard = async () => (await import(/* @vite-ignore */ cardPath));

describe("pure helpers (§4.2.2)", () => {
  it("blockGroups: stored blocks in order with their questions; a legacy session is one never-frozen group", async () => {
    const m = await load();
    const groups = m.blockGroups(blockedView());
    expect(groups.length).toBe(2);
    expect(groups[0]).toMatchObject({ legacy: false, state: "accepted", blockId: "b1", order: 0, acceptedAt: AT, questionIds: ["q1", "q2"] });
    expect(groups[1]).toMatchObject({ legacy: false, state: "open", blockId: "b2", order: 1, questionIds: ["q3", "q4", "q5", "q6"] });
    expect(groups[1].acceptedAt).toBeUndefined();
    expect(new Set(groups.map((g: any) => g.key)).size).toBe(2);
    for (const status of ["active", "closed"] as const) {
      const [g, ...rest] = m.blockGroups(legacyView(status));
      expect(rest).toEqual([]);
      expect(g).toEqual({ key: "legacy", legacy: true, state: status === "active" ? "legacy-active" : "legacy-closed", order: 0, questionIds: ["l1", "l2", "l3"] });
    }
  });

  it("openBlockId, groupLabel, isFrozen and cancellationOf", async () => {
    const m = await load();
    const v = blockedView();
    expect(m.openBlockId(v)).toBe("b2");
    const [g1, g2] = m.blockGroups(v);
    expect(m.groupLabel(g1)).toBe("Block 1 (accepted)");
    expect(m.groupLabel(g2)).toBe("Block 2 (open)");
    expect(m.groupLabel(m.blockGroups(legacyView())[0])).toBe("All questions");
    expect(["q1", "q2", "q3", "q4"].map((id) => m.isFrozen(v, id))).toEqual([true, true, false, false]);
    expect(m.isFrozen(legacyView("closed"), "l1")).toBe(false);
    expect(m.cancellationOf(v, "q5")).toMatchObject({ reason: "Dropped", ref: { sessionId: "S", questionId: "q5" } });
    expect(m.cancellationOf(v, "q4")).toBeUndefined();
  });

  it("readOnlyReason: frozen wins over cancelled; stale and closed legacy are not read-only", async () => {
    const m = await load();
    const v = blockedView();
    expect(m.readOnlyReason(v, "q2")).toBe("frozen");
    expect(m.readOnlyReason(v, "q1")).toBe("frozen");
    expect(m.readOnlyReason(v, "q5")).toBe("cancelled");
    expect(m.readOnlyReason(v, "q3")).toBe("cancelled");
    expect(m.readOnlyReason(v, "q4")).toBeNull();
    expect(m.readOnlyReason(v, "q6")).toBeNull();
    expect(m.readOnlyReason(legacyView("closed"), "l2")).toBeNull();
    expect(m.readOnlyReason(legacyView("closed"), "l3")).toBe("cancelled");
  });

  it("replacementOf: supersedes from → to, same and cross session, titles from the catalog", async () => {
    const m = await load();
    const v = blockedView();
    expect(m.replacementOf(v, "q3")).toEqual({ ref: { sessionId: "S", questionId: "q4" }, title: "Q4 open", sessionTitle: "Session S", sameSession: true });
    expect(m.replacementOf(v, "q1")).toEqual({ ref: { sessionId: "T", questionId: "t1" }, title: "T1 replacement", sessionTitle: "Session T", sameSession: false });
    expect(m.replacementOf(v, "q4")).toBeUndefined();
  });

  it("decisionMarks: cancelled, replaced, both, frozen, chosen; stale is not cancelled", async () => {
    const m = await load();
    const v = blockedView();
    const both = m.decisionMarks(v, "q3");
    expect(both.cancelled).toEqual({ reason: "Superseded" });
    expect(both.replacedBy).toMatchObject({ ref: { sessionId: "S", questionId: "q4" }, sameSession: true });
    expect(both.frozen).toBe(false);
    expect(both.chosen).toBe("Option B");
    const frozen = m.decisionMarks(v, "q1");
    expect(frozen.frozen).toBe(true);
    expect(frozen.cancelled).toBeUndefined();
    expect(frozen.chosen).toBe("Option A");
    const stale = m.decisionMarks(v, "q6");
    expect(stale.cancelled).toBeUndefined();
    expect(stale.replacedBy).toBeUndefined();
    const open = m.decisionMarks(v, "q4");
    expect(open).toMatchObject({ frozen: false });
    expect(open.chosen).toBeUndefined();
  });

  it("defaultSelection: first unanswered of the open block; else its first question; else the last group; null for an empty group", async () => {
    const m = await load();
    const v = blockedView();
    const [, g2] = m.blockGroups(v);
    expect(m.defaultSelection(v)).toEqual({ groupKey: g2.key, questionId: "q4" });
    const allAnswered = blockedView({ questions: blockedView().questions.filter((x: any) => ["q1", "q2", "q3", "q6"].includes(x.question.id)) });
    expect(m.defaultSelection(allAnswered)).toEqual({ groupKey: g2.key, questionId: "q3" });
    expect(m.defaultSelection(legacyView())).toEqual({ groupKey: "legacy", questionId: "l1" });
    const empty = blockedView({ questions: blockedView().questions.filter((x: any) => x.question.blockId === "b1") });
    expect(m.defaultSelection(empty)).toEqual({ groupKey: m.blockGroups(empty)[1].key, questionId: null });
  });

  it("resolveSelection keeps a valid selection, falls back for an unknown id or group, and is idempotent", async () => {
    const m = await load();
    const v = blockedView();
    const [g1] = m.blockGroups(v);
    const keep = { groupKey: g1.key, questionId: "q2" };
    expect(m.resolveSelection(v, keep)).toEqual(keep);
    expect(m.resolveSelection(v, { groupKey: g1.key, questionId: "missing" })).toEqual(m.defaultSelection(v));
    expect(m.resolveSelection(v, { groupKey: "nope", questionId: "q1" })).toEqual(m.defaultSelection(v));
    expect(m.resolveSelection(v, null)).toEqual(m.defaultSelection(v));
    for (const cur of [keep, null, { groupKey: "nope", questionId: null }]) {
      const once = m.resolveSelection(v, cur);
      expect(m.resolveSelection(v, once)).toEqual(once);
    }
    const before = JSON.stringify(keep);
    m.resolveSelection(v, keep);
    expect(JSON.stringify(keep)).toBe(before);
  });

  it("stepQuestion moves within the group and is null past either end", async () => {
    const m = await load();
    const [, g2] = m.blockGroups(blockedView());
    expect(m.stepQuestion(g2, "q3", 1)).toBe("q4");
    expect(m.stepQuestion(g2, "q4", -1)).toBe("q3");
    expect(m.stepQuestion(g2, "q3", -1)).toBeNull();
    expect(m.stepQuestion(g2, "q6", 1)).toBeNull();
  });
});

describe("import cycle (§4.2.1)", () => {
  for (const order of [[blocksPath, cardPath], [cardPath, blocksPath]]) {
    it(`importing ${order[0]} then ${order[1]} leaves every export defined`, async () => {
      vi.resetModules();
      const first = (await import(/* @vite-ignore */ order[0])) as Record<string, unknown>;
      const second = (await import(/* @vite-ignore */ order[1])) as Record<string, unknown>;
      for (const [mod, name] of [[first, order[0]], [second, order[1]]] as const) {
        expect(Object.keys(mod).length, name).toBeGreaterThan(0);
        for (const [k, v] of Object.entries(mod)) expect(v, `${name}.${k}`).toBeDefined();
      }
      const blocks = order[0] === blocksPath ? first : second;
      const card = order[0] === cardPath ? first : second;
      for (const k of ["blockGroups", "openBlockId", "groupLabel", "isFrozen", "cancellationOf", "readOnlyReason", "replacementOf", "decisionMarks", "defaultSelection", "resolveSelection", "stepQuestion", "GrillingBlocks"]) {
        expect(typeof blocks[k], k).toBe("function");
      }
      for (const k of ["QuestionBody", "QuestionCard"]) expect(typeof card[k], k).toBe("function");
    });
  }
});

describe("GrillingBlocks wide layout (§4.2.3)", () => {
  async function wide(view = blockedView()) {
    const m = await load();
    const c = await loadCard();
    const opened: any[] = [];
    const g = mount(m.GrillingBlocks, { hostId: HOST, projectId: P, view, theme, compact: false, onOpenRef: (r: any) => void opened.push(r) });
    return { m, c, g, opened };
  }




  // DeepSeek Flash review 01a1c6c1 c0109: the case collected `QuestionBody`, which the canvas no longer
  // renders, so it could not fail. It now reads the canvas cards, with the full view as the control.
  it("an empty group shows no card and the empty text", async () => {
    const cards = await loadCanvasCard();
    const canvasCards = (tree: unknown) => all(tree, (el) => el.type === cards.QuestionCanvasCard);
    expect(canvasCards((await wide()).g.render()).length, "control: the open block's questions have cards").toBeGreaterThan(0);
    const empty = blockedView({ questions: blockedView().questions.filter((x: any) => x.question.blockId === "b1") });
    const { g } = await wide(empty);
    const tree = g.render();
    expect(canvasCards(tree), "no card in the empty open block").toEqual([]);
    expect(allText(tree)).toContain("No questions in this block yet");
  });
});

describe("GrillingBlocks compact layout (§4.2.3)", () => {
  async function compact(view = blockedView()) {
    const m = await load();
    const c = await loadCard();
    const g = mount(m.GrillingBlocks, { hostId: HOST, projectId: P, view, theme, compact: true });
    return { m, c, g };
  }



  it("Accept block and continue sends block.accept at the rendered revision only on the open stored block", async () => {
    const { g } = await compact();
    h.state.cacheRevision = 99;
    const accept = enabled(pressables(g.render(), /^Accept block and continue$/));
    expect(accept.length).toBe(1);
    await press(accept[0]);
    expect(calls("block.accept").map((x) => x.input)).toEqual([{ sessionId: "S", blockId: "b2", projectId: P, expectedRevision: 7 }]);
  });



});

// R1.3b corrections: the compact screen owns a bounded layout in which the canvas scrolls inside it.
// This is a structure contract, not a native persistence proof; the parent gives it a bounded
// height and does not wrap the whole screen in a ScrollView.
describe("R1.3b correction: compact bounded layout", () => {
  const isScroll = (el: El) => ["ScrollView", "RNScrollView"].includes(nameOf(el));
  it("root flex 1 / minHeight 0; the canvas cards and Accept are inside one flex 1 / minHeight 0 vertical ScrollView", async () => {
    const m = await load();
    const cards = await loadCanvasCard();
    const root = mount(m.GrillingBlocks, { hostId: HOST, projectId: P, view: blockedView(), theme, compact: true }).render();
    expect(flat(root.props.style)).toMatchObject({ flex: 1, minHeight: 0 });
    const scrolls = all(root, isScroll).filter((sv) => sv.props.horizontal !== true && all(sv, (el) => el.type === cards.QuestionCanvasCard).length > 0);
    expect(scrolls.length).toBe(1);
    expect(flat(scrolls[0].props.style)).toMatchObject({ flex: 1, minHeight: 0 });
    expect(pressables(scrolls[0], /^Accept block and continue$/).length, "Accept is inside the scroll region").toBe(1);
  });
});

// R1.3b correction: "Accept block and continue" moves on even after a manual selection. After a
// successful accept the refetched view (old block accepted, new block open) selects the new open
// block; an old manual selection must not win. A failed accept leaves the selection and is not retried.
describe("R1.3b correction: accept and continue after a manual selection", () => {
  const afterAccept = (newQuestions: any[]) => {
    const v = blockedView();
    return {
      ...v,
      revision: 8,
      session: {
        ...v.session,
        blocks: [
          v.session.blocks[0],
          { id: "b2", order: 1, state: "accepted", openedAt: AT, acceptedAt: AT, acceptedBy: { kind: "human" } },
          { id: "b3", order: 2, state: "open", openedAt: AT },
        ],
      },
      questions: [...v.questions, ...newQuestions.map((x) => qv(x))],
    };
  };
  /** Block 1, then Block 2 chosen by hand: the owner's own selection of the open block. */
  async function manual() {
    const m = await load();
    const cards = await loadCanvasCard();
    const g = mount(m.GrillingBlocks, { hostId: HOST, projectId: P, view: blockedView(), theme, compact: false });
    await press(blockItem(g.render(), 1));
    await press(blockItem(g.render(), 2));
    const ids = () => all(g.render(), (el) => el.type === cards.QuestionCanvasCard).map((el) => el.props.questionId);
    expect(ids()).toEqual(["q3", "q4", "q5", "q6"]);
    return { g, ids };
  }

  it("success: the refetched view selects the new open block, not the old manual selection (positive control)", async () => {
    const { g, ids } = await manual();
    h.state.answers["block.accept"] = (i) => ({ ok: true, value: { revision: i.expectedRevision + 1, blockId: "b2", nextBlockId: "b3" } });
    await press(enabled(pressables(g.render(), /^Accept block and continue$/))[0]);
    expect(calls("block.accept").map((x) => x.input)).toEqual([{ sessionId: "S", blockId: "b2", projectId: P, expectedRevision: 7 }]);
    const tree = g.render({ ...g.props(), view: afterAccept([q("q7", "Q7 next block", { blockId: "b3" })]) });
    expect(ids()).toEqual(["q7"]);
    expect(blockItem(tree, 3).props.accessibilityState?.selected).toBe(true);
  });

  it("success into an empty new block: no cards, the empty text, and Accept on the new open block", async () => {
    const { g, ids } = await manual();
    h.state.answers["block.accept"] = (i) => ({ ok: true, value: { revision: i.expectedRevision + 1, blockId: "b2", nextBlockId: "b3" } });
    await press(enabled(pressables(g.render(), /^Accept block and continue$/))[0]);
    const tree = g.render({ ...g.props(), view: afterAccept([]) });
    expect(ids()).toEqual([]);
    expect(allText(tree)).toContain("No questions in this block yet");
    expect(pressables(tree, /^Accept block and continue$/).length).toBe(1);
  });

  it("failure: the selection is unchanged and the accept is not retried", async () => {
    const { g, ids } = await manual();
    h.state.answers["block.accept"] = () => ({ ok: false, error: { code: "revision_conflict", message: "stale" } });
    await press(enabled(pressables(g.render(), /^Accept block and continue$/))[0]);
    g.render({ ...g.props(), view: { ...blockedView(), revision: 9 } });
    expect(ids()).toEqual(["q3", "q4", "q5", "q6"]);
    await flush();
    expect(calls("block.accept").length).toBe(1);
    expect(h.state.toasts.length).toBeGreaterThan(0);
  });
});

// Stage R1.4 (task card §5.2): an optional `target` drives explicit navigation. A new nonce selects
// the question (in any group); the same nonce on a background refetch never overrides a later manual
// selection; an unknown question keeps the current selection; nothing loops.
describe("R1.4 GrillingBlocks target", () => {
  async function targeted(target?: { questionId: string; nonce: number }) {
    const m = await load();
    const cards = await loadCanvasCard();
    const g = mount(m.GrillingBlocks, { hostId: HOST, projectId: P, view: blockedView(), theme, compact: false, ...(target ? { target } : {}) });
    const shown = () => all(g.render(), (el) => el.type === cards.QuestionCanvasCard);
    const ids = () => shown().map((el) => el.props.questionId);
    const outlined = () => shown().filter((el) => el.props.highlighted === true).map((el) => el.props.questionId);
    return { g, ids, outlined };
  }

  it("without a target the open block is shown (control); a target selects its block and outlines its card, also in an accepted block", async () => {
    const plain = await targeted();
    expect(plain.ids()).toEqual(["q3", "q4", "q5", "q6"]);
    expect(plain.outlined()).toEqual([]);
    const t = await targeted({ questionId: "q1", nonce: 1 });
    expect(t.ids()).toEqual(["q1", "q2"]);
    expect(t.outlined()).toEqual(["q1"]);
    expect(blockItem(t.g.render(), 1).props.accessibilityState?.selected).toBe(true);
  });

  it("the outline fades after 1.5 s; the block stays selected", async () => {
    vi.useFakeTimers();
    try {
      const t = await targeted({ questionId: "q1", nonce: 1 });
      expect(t.outlined()).toEqual(["q1"]);
      vi.advanceTimersByTime(1499);
      expect(t.outlined()).toEqual(["q1"]);
      vi.advanceTimersByTime(2);
      expect(t.outlined()).toEqual([]);
      expect(t.ids()).toEqual(["q1", "q2"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("the same nonce with a newer view keeps a later manual selection; a new nonce selects again", async () => {
    const t = await targeted({ questionId: "q1", nonce: 1 });
    expect(t.ids()).toEqual(["q1", "q2"]);
    await press(blockItem(t.g.render(), 2));
    expect(t.ids()).toEqual(["q3", "q4", "q5", "q6"]);
    t.g.render({ ...t.g.props(), view: { ...blockedView(), revision: 8 }, target: { questionId: "q1", nonce: 1 } });
    expect(t.ids()).toEqual(["q3", "q4", "q5", "q6"]);
    t.g.render({ ...t.g.props(), target: { questionId: "q2", nonce: 2 } });
    expect(t.ids()).toEqual(["q1", "q2"]);
    expect(t.outlined()).toEqual(["q2"]);
    expect(h.state.calls).toEqual([]);
  });

  it("an unknown question id keeps the current selection and consumes the nonce", async () => {
    const t = await targeted({ questionId: "q1", nonce: 1 });
    expect(t.ids(), "the first target is applied").toEqual(["q1", "q2"]);
    t.g.render({ ...t.g.props(), target: { questionId: "missing", nonce: 2 } });
    expect(t.ids()).toEqual(["q1", "q2"]);
    await press(blockItem(t.g.render(), 2));
    t.g.render({ ...t.g.props(), target: { questionId: "missing", nonce: 2 } });
    expect(t.ids()).toEqual(["q3", "q4", "q5", "q6"]);
  });
});

// ---- Automatic grilling S3/G5 (S3-TASKS §3.5, §4 B1–B5): header bar, actions, planner picker, Reopen ----
const PLANNER = "agent-planner-1";
const MANUAL = "Continue the conversation in the chat, or bind another chat.";
const bindingOf = (agentId = PLANNER) => ({ agentId, workspaceId: "ws-1", boundAt: AT, boundBy: "ask", epoch: 1 });
/** The blocked session S with an S3 grilling view: unbound (no_planner) or bound to a planner. */
function grillView(o: { planner?: string; status?: "active" | "closed"; grilling?: any; sessionId?: string } = {}): any {
  const v = blockedView();
  const grilling =
    o.grilling ??
    (o.planner !== undefined ? { status: "waiting_for_answers", manualRecovery: false, plannerAgentId: o.planner, epoch: 1 } : { status: "no_planner", manualRecovery: true });
  return {
    ...v,
    session: { ...v.session, id: o.sessionId ?? "S", status: o.status ?? "active", ...(o.planner !== undefined ? { planner: bindingOf(o.planner) } : {}) },
    grilling,
  };
}
const ALLOWED_RPCS = ["session.planner.set", "session.reopen", "block.accept"];
const onlyAllowedRpcs = () => expect(h.state.calls.map((c) => c.name).filter((n) => !ALLOWED_RPCS.includes(n))).toEqual([]);

describe("S3 B1 GrillingHeaderBar placement", () => {
  it("a view with grilling renders one GrillingHeaderBar before the question cards in compact and wide; a legacy view renders none", async () => {
    const m = await load();
    const cards = await loadCanvasCard();
    expect(typeof m.GrillingHeaderBar, "GrillingHeaderBar is exported").toBe("function");
    for (const compact of [true, false]) {
      const view = grillView({ planner: PLANNER });
      const tree = mount(m.GrillingBlocks, { hostId: HOST, projectId: P, view, theme, compact }).render();
      const bars = all(tree, (el) => el.type === m.GrillingHeaderBar);
      expect(bars.length, `compact ${compact}`).toBe(1);
      expect(bars[0].props.view).toBe(view);
      const order = all(tree, () => true);
      const body = order.findIndex((el) => el.type === cards.QuestionCanvasCard);
      expect(body, `cards rendered (compact ${compact})`).toBeGreaterThan(-1);
      expect(order.indexOf(bars[0]), `header before the cards (compact ${compact})`).toBeLessThan(body);
    }
    for (const compact of [true, false]) {
      const tree = mount(m.GrillingBlocks, { hostId: HOST, projectId: P, view: legacyView(), theme, compact }).render();
      expect(all(tree, (el) => typeof m.GrillingHeaderBar === "function" && el.type === m.GrillingHeaderBar)).toEqual([]);
    }
    onlyAllowedRpcs();
  });
});

describe("S3 GrillingHeaderBar output", () => {
  const headerText = (m: any, view: any) => allText(mount(m.GrillingHeaderBar, { view, theme }).render());

  it("names the planner by its chat title, falls back to the agent id, and follows a rebind", async () => {
    const m = await load();
    expect(typeof m.GrillingHeaderBar, "GrillingHeaderBar is exported").toBe("function");
    h.state.agentTitles = { [PLANNER]: "Claude planner", "agent-B": "Codex planner" };
    expect(headerText(m, grillView({ planner: PLANNER }))).toContain("Planner: Claude planner · waiting for answers");
    h.state.agentTitles = { [PLANNER]: null };
    expect(headerText(m, grillView({ planner: PLANNER }))).toContain(`Planner: ${PLANNER} · waiting for answers`);
    h.state.agentTitles = {};
    expect(headerText(m, grillView({ planner: PLANNER }))).toContain(`Planner: ${PLANNER} · waiting for answers`);
    // One mounted bar across a rebind and across the planner binding appearing (no hook-order assumption).
    h.state.agentTitles = { [PLANNER]: "Claude planner", "agent-B": "Codex planner" };
    const bar = mount(m.GrillingHeaderBar, { view: grillView(), theme });
    expect(allText(bar.render())).toContain("No planner bound");
    expect(allText(bar.render({ view: grillView({ planner: PLANNER }), theme }))).toContain("Planner: Claude planner");
    expect(allText(bar.render({ view: grillView({ planner: "agent-B" }), theme }))).toContain("Planner: Codex planner");
    expect(allText(bar.render({ view: grillView(), theme }))).toContain("No planner bound");
  });

  it("shows the manual recovery line (muted) exactly when manualRecovery is true; superseded by the next batch is worded distinctly", async () => {
    const m = await load();
    expect(typeof m.GrillingHeaderBar, "GrillingHeaderBar is exported").toBe("function");
    const unbound = mount(m.GrillingHeaderBar, { view: grillView(), theme }).render();
    expect(allText(unbound)).toContain("No planner bound");
    const recovery = all(unbound, (el) => textOf(el.props.children).includes(MANUAL) && ["Text", "Muted"].includes(nameOf(el)));
    expect(recovery.length).toBeGreaterThan(0);
    expect(recovery.some((el) => nameOf(el) === "Muted" || flat(el.props.style).color === "#foregroundMuted"), "muted recovery line").toBe(true);
    const fine = headerText(m, grillView({ planner: PLANNER }));
    expect(fine).not.toContain(MANUAL);
    h.state.agentTitles = { [PLANNER]: "P" };
    const advanced = headerText(m, grillView({ planner: PLANNER, grilling: { status: "planner_changed", reason: "block_advanced", manualRecovery: true, plannerAgentId: PLANNER, epoch: 1 } }));
    const rebound = headerText(m, grillView({ planner: PLANNER, grilling: { status: "planner_changed", reason: "rebind", manualRecovery: true, plannerAgentId: PLANNER, epoch: 1 } }));
    expect(advanced).toContain("superseded by the chat's next batch");
    expect(rebound).toContain("planner changed");
    expect(advanced).not.toContain("planner changed");
  });
});

describe("S3 B2 action labels follow the grilling gates", () => {
  const labels = async (view: any) => {
    const m = await load();
    return mount(m.GrillingBlocks, { hostId: HOST, projectId: P, view, theme, compact: true }).render();
  };


  it("closed: no Accept; complete while active: no Accept even on the open block (Reopen and Bind/Change live in the Chat menu)", async () => {
    const closed = await labels(grillView({ planner: PLANNER, status: "closed", grilling: { status: "complete", manualRecovery: false, plannerAgentId: PLANNER, epoch: 1 } }));
    expect(pressables(closed, /^Accept block and continue$/)).toEqual([]);
    const complete = await labels(grillView({ planner: PLANNER, grilling: { status: "complete", manualRecovery: false, plannerAgentId: PLANNER, epoch: 1 } }));
    expect(pressables(complete, /^Accept block and continue$/)).toEqual([]);
    const active = await labels(grillView({ planner: PLANNER }));
    expect(pressables(active, /^Accept block and continue$/).length, "control: an active open block offers Accept").toBe(1);
  });

});


// Stable numbers and hidden conditional questions: navigator rows name Q<n>; an inactive question
// is kept out of the navigator, the main list and the default selection, and is listed on demand in
// a hidden section, read-only, with the condition that would show it.
const hiddenPath = "./hidden-questions";
describe("GrillingBlocks numbers and hidden questions", () => {
  /** blockedView plus q7 in the open block, shown only when q4 is Option A (so hidden now). */
  const withHidden = () => {
    const view = blockedView();
    const hidden = q("q7", "Q7 conditional", { blockId: "b2", validity: "unanswered", activatedBy: [{ parent: { sessionId: "S", questionId: "q4" }, optionIds: ["a"] }] });
    view.questions.push({ ...qv(hidden), visibility: "inactive", status: "inactive" });
    view.catalog.push({ ref: { sessionId: "S", questionId: "q7" }, sessionTitle: "Session S", questionTitle: "Q7 conditional", options: ab, status: "inactive" });
    return view;
  };
  const wide = async (view: any) => {
    const m = await load();
    return mount(m.GrillingBlocks, { hostId: HOST, projectId: P, view, theme, compact: false });
  };


  // KensAI 9126580 c0023: this case collected `QuestionBody` elements, which the rebuilt canvas no longer
  // renders (it renders `QuestionCanvasCard`), so the list was always empty and the case could not fail.
  // It now reads the canvas cards themselves, with the open block's active questions as the control
  // that the collection is not empty.
  it("an inactive question is not a navigator row and gets no card on the canvas of its block", async () => {
    const cards: unknown = await loadCanvasCard();
    const Card = typeof cards === "object" && cards !== null ? Reflect.get(cards, "QuestionCanvasCard") : undefined;
    expect(typeof Card, "question-canvas-card exports QuestionCanvasCard").toBe("function");
    const g = await wide(withHidden());
    const tree = g.render();
    expect(pressables(tree, /Q7 conditional/)).toEqual([]);
    const shown = all(tree, (el) => el.type === Card).map((el) => String(el.props.questionId));
    expect(shown, "the open block's active questions have cards (the collection is live)").toEqual(expect.arrayContaining(["q3", "q4"]));
    expect(shown, "the inactive question of the same block has none").not.toContain("q7");
  });

  it("a hidden section is offered for the session's hidden questions", async () => {
    const hq = await import(/* @vite-ignore */ hiddenPath);
    const view = withHidden();
    const sections = all((await wide(view)).render(), (el) => el.type === hq.HiddenQuestions);
    expect(sections).toHaveLength(1);
    expect(sections[0].props.view).toBe(view);
  });

  it("the hidden section is closed by default and shows each hidden question read-only with its condition on demand", async () => {
    const hq = await import(/* @vite-ignore */ hiddenPath);
    const c = await loadCard();
    const view = withHidden();
    const section = mount(hq.HiddenQuestions, { hostId: HOST, projectId: P, view, theme, compact: true });
    let tree = section.render();
    expect(all(tree, (el) => el.type === c.QuestionBody)).toEqual([]);
    const toggle = pressables(tree, /hidden/i);
    expect(toggle).toHaveLength(1);
    expect(labelOf(toggle[0])).toContain("1");
    await press(toggle[0]);
    tree = section.render();
    const shown = all(tree, (el) => el.type === c.QuestionBody);
    expect(shown.map((b) => b.props.questionId)).toEqual(["q7"]);
    expect(shown[0].props.readOnly).toBe(true);
    const text = allText(tree);
    expect(text).toContain("Q7 conditional");
    expect(text).toContain("Q4");
    expect(text).toContain("Option A");
  });
});

// Finish, Retry, language and summaries on the grilling screen. Nothing is sent or resent on render;
// every call follows an explicit press.
describe("GrillingBlocks finish, retry, language and summaries", () => {
  const PLANNER_BINDING = { agentId: "agent-planner-1", workspaceId: "ws-1", boundAt: AT, boundBy: "ask", epoch: 1 };
  const grilling = (extra: Record<string, unknown>) => ({ status: "idle", manualRecovery: false, plannerAgentId: "agent-planner-1", epoch: 1, ...extra });
  const withSession = (view: any, extra: Record<string, unknown>) => ({ ...view, session: { ...view.session, planner: PLANNER_BINDING }, ...extra });
  const wide = async (view: any) => {
    h.state.cacheRevision = view.revision;
    const m = await load();
    return mount(m.GrillingBlocks, { hostId: HOST, projectId: P, view, theme, compact: false });
  };
  /** Press the first control matching `label`, or fail naming the labels present. */
  const pressLabel = async (g: { render(): El }, label: RegExp) => {
    const found = pressables(g.render(), label);
    expect(found.length, `a control ${String(label)}`).toBeGreaterThan(0);
    await press(found[0]);
  };



  it("a sent retry is shown with its time and Retry cannot send again", async () => {
    const g = await wide(withSession(blockedView(), { grilling: grilling({ status: "needs_manual", manualRecovery: true, retryCount: 1, lastRetry: { id: "r1", at: AT, state: "sent" } }) }));
    const tree = g.render();
    expect(allText(tree)).toMatch(/Retry sent at/);
    for (const r of pressables(tree, /^Retry$/)) {
      if (r.props.disabled !== true) await press(r);
    }
    expect(h.state.calls.filter((c) => c.name === "discussion.retry")).toEqual([]);
  });

  it("an unknown outcome offers Check chat and the owner's marks for that retry, and never resends", async () => {
    const g = await wide(withSession(blockedView(), { grilling: grilling({ status: "needs_manual", manualRecovery: true, retryCount: 1, lastRetry: { id: "r1", at: AT, state: "unknown" } }) }));
    expect(allText(g.render())).toMatch(/Delivery outcome unknown since/);
    await pressLabel(g, /^Check chat$/);
    await pressLabel(g, /^Mark as delivered$/);
    await pressLabel(g, /^Mark as not delivered$/);
    expect(h.state.calls.filter((c) => c.name === "discussion.retry.check").map((c) => c.input)).toEqual([expect.objectContaining({ sessionId: "S", retryId: "r1" })]);
    expect(h.state.calls.filter((c) => c.name === "discussion.retry.resolve").map((c) => [c.input.retryId, c.input.outcome])).toEqual([["r1", "delivered"], ["r1", "not_delivered"]]);
    expect(h.state.calls.filter((c) => c.name === "discussion.retry")).toEqual([]);
  });

  // UI feedback plan U2 (2026-11-09): the header no longer carries language lines (the effective
  // language is a chip at the question, client/question-card.test.ts). The no-translation notice is
  // shown once per session and language until the owner presses Got it, which stores the
  // acknowledgement (session.language_notice.ack at the rendered revision) and hides it.
  describe("the session language notice", () => {
    const withLanguage = (answer?: string, extra: Record<string, unknown> = {}) => {
      const view = withSession(blockedView(), { grilling: grilling({}) });
      const options = [{ id: "en", label: "English" }, { id: "ru", label: "Russian" }];
      const lang = q("q8", "Session language", { blockId: "b2", tag: "language", options, recommendedOptionId: "en", allowFreeText: true, validity: answer ? "valid" : "unanswered", ...(answer ? { answer: answerOf(answer), revisions: [answerOf(answer)] } : {}) });
      view.questions.push(qv(lang));
      view.session = { ...view.session, ...extra };
      return view;
    };
    const stored = (language: string, ack?: string) => {
      const view = withSession(blockedView(), { grilling: grilling({}) });
      view.session = { ...view.session, language, ...(ack !== undefined ? { languageNoticeAck: { language: ack, at: AT } } : {}) };
      return view;
    };
    const WARNING = /no translation is performed/i;

    it("English shows no notice and the header carries no language line", async () => {
      for (const answer of [undefined, "en"]) {
        const text = allText((await wide(withLanguage(answer))).render());
        expect(text, String(answer)).not.toMatch(WARNING);
        expect(text, String(answer)).not.toMatch(/Language: /);
      }
    });

    it("a non-English language shows the notice with Got it until acknowledged; the header carries no language line", async () => {
      for (const view of [withLanguage("ru"), stored("Русский")]) {
        const tree = (await wide(view)).render();
        expect(allText(tree)).toMatch(WARNING);
        expect(allText(tree)).not.toMatch(/Language: /);
        expect(enabled(pressables(tree, /^Got it$/)).length).toBe(1);
      }
    });

    it("the shown notice recommends English for the questions", async () => {
      const text = allText((await wide(withLanguage("ru"))).render());
      const line = text.split("\n").find((l) => WARNING.test(l)) ?? "";
      expect(line).toMatch(/recommend/i);
      expect(line).toMatch(/English/);
      expect(line).toMatch(/ultimately/i);
      expect(line).toMatch(/this version/i);
    });

    it("Got it sends one acknowledgement for the shown language at the rendered revision and hides the notice", async () => {
      const g = await wide(stored("Русский"));
      expect(h.state.calls).toEqual([]);
      await pressLabel(g, /^Got it$/);
      const acks = h.state.calls.filter((c) => c.name === "session.language_notice.ack");
      expect(acks.map((c) => c.input)).toEqual([expect.objectContaining({ sessionId: "S", language: "Русский", expectedRevision: 7 })]);
      expect(allText(g.render())).not.toMatch(WARNING);
    });

    it("an acknowledged language shows no notice; a different label shows it again", async () => {
      expect(allText((await wide(stored("Русский", "Русский"))).render())).not.toMatch(WARNING);
      expect(pressables((await wide(stored("Русский", "Русский"))).render(), /^Got it$/)).toEqual([]);
      expect(allText((await wide(stored("Deutsch", "Русский"))).render())).toMatch(WARNING);
    });
  });

  // UI feedback plan U4 (2026-11-09): the inline summary disclosures are replaced by one Summary icon
  // button that opens a modal; a changed accepted block keeps a short visible line beside it.
  describe("the block summary in a modal", () => {
    const summaryView = (summary: Record<string, unknown> | null, preview?: string) =>
      withSession(blockedView(), {
        grilling: grilling({}),
        ...(summary !== null ? { summaries: [{ blockId: "b1", ...summary }] } : {}),
        ...(preview !== undefined ? { openBlockPreview: preview } : {}),
      });
    const CHANGED = { acceptedSummary: "ACCEPTED-SUMMARY-TEXT", currentSummary: "CURRENT-SUMMARY-TEXT", changedSinceAcceptance: true, changed: [1] };
    const summaryButton = (tree: unknown) => {
      const found = pressables(tree, /^Summary/);
      expect(found.length, "one Summary control").toBe(1);
      return found[0];
    };
    const modals = (tree: unknown) => all(tree, (el) => nameOf(el) === "Modal" && el.props.visible !== false);
    const modalText = (tree: unknown) => modals(tree).map((m) => allText(m)).join("\n");

    it("the open block's preview is shown only in the modal, behind the Summary button", async () => {
      const g = await wide(summaryView(null, "PREVIEW-SUMMARY-TEXT"));
      expect(allText(g.render())).not.toContain("PREVIEW-SUMMARY-TEXT");
      expect(modals(g.render())).toEqual([]);
      await press(summaryButton(g.render()));
      expect(modalText(g.render())).toMatch(/Summary preview/);
      expect(modalText(g.render())).toContain("PREVIEW-SUMMARY-TEXT");
      expect(h.state.calls).toEqual([]);
    });

    it("an accepted block with changes keeps a visible changed line beside the button; the modal has the snapshot, the notice and the current answers", async () => {
      const g = await wide(summaryView(CHANGED, "PREVIEW-SUMMARY-TEXT"));
      await press(blockItem(g.render(), 1));
      const tree = g.render();
      expect(allText(tree)).toMatch(/Answers changed after acceptance: Q1/);
      expect(allText(tree)).not.toContain("ACCEPTED-SUMMARY-TEXT");
      const button = summaryButton(tree);
      expect(`${String(button.props.label)} ${String(button.props.hint ?? button.props.accessibilityHint ?? "")}`).toMatch(/Answers changed after acceptance/);
      await press(button);
      const text = modalText(g.render());
      expect(text).toMatch(/Summary at acceptance/);
      expect(text).toContain("ACCEPTED-SUMMARY-TEXT");
      expect(text).toMatch(/the chat was told the earlier values/);
      expect(text).toMatch(/Current answers/);
      expect(text).toContain("CURRENT-SUMMARY-TEXT");
      expect(h.state.calls).toEqual([]);
    });

    it("an accepted block without a snapshot says so in the modal", async () => {
      const g = await wide(summaryView({ noSnapshot: true, currentSummary: "CURRENT-SUMMARY-TEXT", changedSinceAcceptance: false, changed: [] }));
      await press(blockItem(g.render(), 1));
      await press(summaryButton(g.render()));
      expect(modalText(g.render())).toMatch(/No summary was recorded when this block was accepted/);
    });

    it("a block without a summary or preview has the button disabled", async () => {
      const g = await wide(summaryView(null));
      expect(summaryButton(g.render()).props.disabled).toBe(true);
    });

    it("Copy copies the shown text and confirms it", async () => {
      const g = await wide(summaryView(null, "PREVIEW-SUMMARY-TEXT"));
      await press(summaryButton(g.render()));
      const copy = pressables(modals(g.render()), /^Copy/);
      expect(copy.length, "a Copy control in the modal").toBe(1);
      await press(copy[0]);
      expect(h.state.copied.length).toBe(1);
      expect(h.state.copied[0]).toContain("PREVIEW-SUMMARY-TEXT");
      expect(h.state.toasts.length).toBeGreaterThan(0);
    });

    it("closing the modal returns focus to the Summary button", async () => {
      const g = await wide(summaryView(null, "PREVIEW-SUMMARY-TEXT"));
      await press(summaryButton(g.render()));
      const ref: unknown = summaryButton(g.render()).props.ref;
      expect(typeof ref === "object" && ref !== null && "current" in ref, "the Summary button carries a ref").toBe(true);
      let focused = 0;
      (ref as { current: unknown }).current = { focus: () => void focused++ };
      const [modal] = modals(g.render());
      const close = modal.props.onClose ?? modal.props.onRequestClose ?? modal.props.onDismiss;
      if (typeof close === "function") close();
      else await press(pressables(modal, /^Close$/)[0]);
      await flush();
      g.render();
      expect(modals(g.render())).toEqual([]);
      expect(focused).toBe(1);
    });

    it("the other notices stay: tools and the retry outcome; the finish proposal has its navigator item", async () => {
      const view = withSession(blockedView(), {
        grilling: grilling({ status: "needs_manual", manualRecovery: true, tools: "pending", retryCount: 1, lastRetry: { id: "r1", at: AT, state: "unknown" }, finishProposal: { at: AT, summary: "Nothing left to ask.", skipped: [], outOfScope: [] } }),
        openBlockPreview: "PREVIEW-SUMMARY-TEXT",
      });
      view.session = { ...view.session, planner: { ...view.session.planner, boundBy: "discussion" } };
      const tree = (await wide(view)).render();
      const text = allText(tree);
      expect(text).toMatch(/Roadmap tools: pending/);
      expect(text).toMatch(/Delivery outcome unknown since/);
      expect(pressables(tree, /^Finish proposal\b/).length, "the open proposal is reachable from the navigator").toBe(1);
    });
  });
});

// Owner decision, rendered: while the planner chat is responding, Retry stays available and the
// warning that it will interrupt the current answer is on screen before the owner presses it.
describe("GrillingBlocks Retry while the planner chat is responding", () => {
  const manual = () => ({
    ...blockedView(),
    session: { ...blockedView().session, planner: { agentId: "agent-planner-1", workspaceId: "ws-1", boundAt: AT, boundBy: "ask", epoch: 1 } },
    grilling: { status: "needs_manual", manualRecovery: true, plannerAgentId: "agent-planner-1", epoch: 1 },
  });
  const wide = async (view: any) => {
    h.state.cacheRevision = view.revision;
    const m = await load();
    return mount(m.GrillingBlocks, { hostId: HOST, projectId: P, view, theme, compact: false });
  };

  it("shows the interruption warning on the screen, outside the Chat menu, and sends nothing on render", async () => {
    h.state.agentStatuses = { "agent-planner-1": "running" };
    const tree = (await wide(manual())).render();
    expect(allText(tree)).toMatch(/interrupt/i);
    expect(h.state.calls).toEqual([]);
  });

  it("an idle chat shows no interruption warning", async () => {
    h.state.agentStatuses = { "agent-planner-1": "idle" };
    const tree = (await wide(manual())).render();
    expect(allText(tree)).not.toMatch(/interrupt/i);
  });
});

// R3: the discussion header keeps showing whether the chat has the roadmap tools, from the session
// view's tools state, not only in a toast after creation.
describe("GrillingBlocks discussion tools line", () => {
  const withTools = (tools?: string) => ({
    ...blockedView(),
    session: { ...blockedView().session, planner: { agentId: "agent-planner-1", workspaceId: "ws-1", boundAt: AT, boundBy: "discussion", epoch: 1 } },
    grilling: { status: "idle", manualRecovery: false, plannerAgentId: "agent-planner-1", epoch: 1, ...(tools !== undefined ? { tools } : {}) },
  });
  const textFor = async (tools?: string) => {
    const view = withTools(tools);
    const m = await load();
    return allText(mount(m.GrillingBlocks, { hostId: HOST, projectId: P, view, theme, compact: true }).render());
  };

  it("shows each state of the roadmap tools in the header", async () => {
    for (const [tools, shown] of [["attached", /Roadmap tools: attached/], ["pending", /Roadmap tools: pending/], ["not_attached", /Roadmap tools: not attached/], ["unknown", /Roadmap tools: unknown/]] as const) {
      expect(await textFor(tools), tools).toMatch(shown);
    }
  });

  it("shows no tools line when the view carries no tools state", async () => {
    expect(await textFor()).not.toMatch(/Roadmap tools/);
  });
  // Review regression: "not attached" is also reported for a chat whose grant was issued and later
  // invalidated by the MCP endpoint's port rotation (server/discussion-tools-accuracy.test.ts), so the
  // header never claims that none was ever issued.
  it("the not-attached line does not claim that none were ever issued", async () => {
    const text = await textFor("not_attached");
    expect(text).toMatch(/Roadmap tools: not attached/);
    expect(text).not.toMatch(/none (were|was) issued|never issued|(were|was) not issued|no (grant|tools?) (were|was) (ever )?issued/i);
  });
});

// c294f12: Got it acknowledges a legacy session's long free-text language label verbatim; closing
// the summary returns focus only where the view offers focus (a native view without it is skipped).
describe("long legacy labels and guarded focus return", () => {
  const LONG = "Русский, с примерами на английском для технических терминов и названий компонентов";
  const planner = { agentId: "agent-planner-1", workspaceId: "ws-1", boundAt: AT, boundBy: "ask", epoch: 1 };
  const grilling = { status: "idle", manualRecovery: false, plannerAgentId: "agent-planner-1", epoch: 1 };
  const legacyLanguage = () => {
    const v = blockedView();
    const a = { rev: 1, text: LONG, source: "ui", actor: { kind: "human" }, at: AT };
    const lang = q("q8", "Session language", { blockId: "b2", tag: "language", options: [{ id: "en", label: "English" }], allowFreeText: true, answer: a, revisions: [a] });
    return { ...v, session: { ...v.session, planner }, grilling, questions: [...v.questions, qv(lang)] };
  };
  const wide = async (view: any) => {
    h.state.cacheRevision = view.revision;
    const m = await load();
    return mount(m.GrillingBlocks, { hostId: HOST, projectId: P, view, theme, compact: false });
  };

  it("Got it sends the long label exactly", async () => {
    const g = await wide(legacyLanguage());
    const gotIt = enabled(pressables(g.render(), /^Got it$/));
    expect(gotIt.length).toBe(1);
    await press(gotIt[0]);
    expect(h.state.calls.filter((c) => c.name === "session.language_notice.ack").map((c) => c.input.language)).toEqual([LONG]);
  });

  it("closing the summary with a native view that has no focus does not throw and closes it", async () => {
    const g = await wide({ ...blockedView(), session: { ...blockedView().session, planner }, grilling, openBlockPreview: "PREVIEW-SUMMARY-TEXT" });
    const button = () => pressables(g.render(), /^Summary/)[0];
    await press(button());
    const ref: unknown = button().props.ref;
    if (typeof ref === "function") ref({ measureInWindow: () => undefined });
    else if (ref && typeof ref === "object" && "current" in ref) (ref as { current: unknown }).current = { measureInWindow: () => undefined };
    const modal = all(g.render(), (el) => nameOf(el) === "Modal" && el.props.visible !== false)[0];
    const close = () => {
      if (typeof modal.props.onOpenChange === "function") return modal.props.onOpenChange(false);
      const handler = modal.props.onClose ?? modal.props.onRequestClose ?? modal.props.onDismiss;
      if (typeof handler === "function") return handler();
      return pressables(modal, /^Close$/)[0].props.onPress();
    };
    expect(close).not.toThrow();
    await flush();
    expect(all(g.render(), (el) => nameOf(el) === "Modal" && el.props.visible !== false)).toEqual([]);
  });
});

// A refused acknowledgement (here a revision conflict) leaves the notice and Got it in
// place, says so, and is not retried; nothing is hidden on a failed write.
describe("Got it refused", () => {
  it("keeps the notice and Got it, reports the refusal and sends nothing more", async () => {
    const v = blockedView();
    const view = { ...v, session: { ...v.session, planner: { agentId: "agent-planner-1", workspaceId: "ws-1", boundAt: AT, boundBy: "ask", epoch: 1 }, language: "Русский" }, grilling: { status: "idle", manualRecovery: false, plannerAgentId: "agent-planner-1", epoch: 1 } };
    h.state.cacheRevision = view.revision;
    h.state.answers["session.language_notice.ack"] = () => ({ ok: false, error: { code: "revision_conflict", message: "store revision changed" } });
    const m = await load();
    const g = mount(m.GrillingBlocks, { hostId: HOST, projectId: P, view, theme, compact: false });
    await press(enabled(pressables(g.render(), /^Got it$/))[0]);
    await flush();
    const tree = g.render();
    expect(calls("session.language_notice.ack")).toHaveLength(1);
    expect(allText(tree)).toMatch(/no translation is performed/i);
    expect(enabled(pressables(tree, /^Got it$/)).length).toBe(1);
    // The owner sees the refusal itself, not only a refetch.
    expect(h.state.toasts).toEqual(["Changed elsewhere; reloaded. Review and retry."]);
  });
});

// A link to a card of another block scrolls the canvas to that card once it is laid out. The scroll
// must use the card's layout after the switch, never an offset recorded while that block was shown
// earlier: a card above it may have changed size in between. Layout values are synthetic onLayout
// events; the real scroll position needs the host.
describe("the link scroll uses the card's current layout", () => {
  const layoutAll = (tree: unknown, cardY: Record<string, number>) => {
    for (const el of all(tree, (x) => typeof x.props.onLayout === "function")) {
      const key = (el as unknown as { key: string | null }).key;
      const y = key !== null && key in cardY ? cardY[key] : 10;
      el.props.onLayout({ nativeEvent: { layout: { x: 0, y, width: 600, height: 80 } } });
    }
  };

  it.each([false, true])("after switching away and back, the scroll goes to the target's new offset, not the stale one (compact %s)", async (compact) => {
    const m = await load();
    const g = mount(m.GrillingBlocks, { hostId: HOST, projectId: P, view: blockedView(), theme, compact });
    const scrolled: number[] = [];
    const attach = () => {
      for (const sv of all(g.render(), (el) => ["ScrollView", "RNScrollView"].includes(nameOf(el)) && el.props.ref !== undefined && el.props.ref !== null)) {
        sv.props.ref.current = { scrollTo: (o: { y: number }) => void scrolled.push(o.y) };
      }
    };
    attach();
    // Block 2 shown first: Q6 at 300.
    layoutAll(g.render(), { q3: 0, q4: 100, q5: 200, q6: 300 });
    await press(blockItem(g.render(), 1));
    attach();
    layoutAll(g.render(), { q1: 0, q2: 100 });
    scrolled.length = 0;
    // A target in Block 2; meanwhile Q5 grew, so Q6 now sits at 420.
    g.render({ ...g.props(), target: { questionId: "q6", nonce: 1 } });
    attach();
    layoutAll(g.render(), { q3: 0, q4: 100, q5: 200, q6: 420 });
    await flush();
    const stale = 10 + 10 + 300 - 12;
    const fresh = 10 + 10 + 420 - 12;
    expect(scrolled, "never to the offset recorded before the switch").not.toContain(stale);
    expect(scrolled.at(-1)).toBe(fresh);
  });
});

// Host evidence (RN Web, compact, 2026-11-10): after a link selected another block, React Native
// Web's layout observer reported the canvas and every card again but sent no layout event for the
// card list container, although its height changed (a second ResizeObserver on the same element saw
// it). A scroll that waits for the list to report again never happens. This case replays exactly
// that event pattern; refs inside the canvas also answer measurements consistent with the same
// geometry, so a measuring implementation can pass too. Real positions still need the host.
describe("compact: a link to a card lower in another block scrolls to it with the layout events the host delivers", () => {
  it.each([
    ["the list reports again (control)", true],
    ["only the canvas and the cards report after the switch, as on the host", false],
  ] as const)("%s: the canvas scrolls to the target card", async (_label, listReports) => {
    const m = await load();
    const g = mount(m.GrillingBlocks, { hostId: HOST, projectId: P, view: blockedView(), theme, compact: true });
    const scrolled: number[] = [];
    const CANVAS_Y = 300;
    const LIST_Y = 40;
    const cardY: Record<string, number> = { q1: 0, q2: 210, q3: 0, q4: 190, q5: 380, q6: 560 };
    const keyOf = (el: El) => (el as unknown as { key: string | null }).key;
    const attach = () => {
      const tree = g.render();
      for (const sv of all(tree, (el) => ["ScrollView", "RNScrollView"].includes(nameOf(el)) && el.props.horizontal !== true && el.props.ref != null)) {
        sv.props.ref.current = { scrollTo: (o: { y?: number }) => void scrolled.push(o.y ?? 0), getInnerViewNode: () => "content" };
      }
      for (const el of all(tree, (x) => x.props.ref != null && typeof x.props.ref === "object" && !["ScrollView", "RNScrollView"].includes(nameOf(x)))) {
        const key = keyOf(el);
        const y = key !== null && key in cardY ? CANVAS_Y + LIST_Y + cardY[key] : CANVAS_Y;
        el.props.ref.current = {
          ...(el.props.ref.current ?? {}),
          measureLayout: (_rel: unknown, ok: (x: number, y: number, w: number, h: number) => void) => ok(0, y, 360, 150),
          measure: (cb: (...a: number[]) => void) => cb(0, y, 360, 150, 0, y),
        };
      }
      return tree;
    };
    /** Fires onLayout: the canvas (the View holding the cards' list), the list, and the cards by key. */
    const fire = (tree: El, opts: { list: boolean }) => {
      const cards = all(tree, (el) => typeof el.props.onLayout === "function" && keyOf(el) !== null && keyOf(el)! in cardY);
      const holders = all(tree, (el) => typeof el.props.onLayout === "function" && !cards.includes(el) && cards.length > 0 && all(el, (x) => cards.includes(x)).length > 0);
      // The innermost holder of the cards is the list; the one above it is the canvas.
      const list = holders.find((h) => !holders.some((o) => o !== h && all(h, (x) => x === o).length > 0));
      const canvas = holders.find((h) => h !== list);
      canvas?.props.onLayout({ nativeEvent: { layout: { x: 0, y: CANVAS_Y, width: 360, height: 900 } } });
      if (opts.list) list?.props.onLayout({ nativeEvent: { layout: { x: 0, y: LIST_Y, width: 360, height: 800 } } });
      for (const c of cards) c.props.onLayout({ nativeEvent: { layout: { x: 0, y: cardY[keyOf(c)!], width: 360, height: 150 } } });
    };
    // Block 2 shown first, with every layout reported.
    fire(attach(), { list: true });
    await press(blockItem(g.render(), 1));
    fire(attach(), { list: true });
    scrolled.length = 0;
    // A link to Q6, the last card of Block 2; after the switch the list reports nothing.
    g.render({ ...g.props(), target: { questionId: "q6", nonce: 7 } });
    fire(attach(), { list: listReports });
    await flush();
    attach();
    expect(scrolled.at(-1), "the canvas scrolled to the card").toBe(CANVAS_Y + LIST_Y + cardY.q6 - 12);
  });
});

// DeepSeek Flash review 01a1c6c1 c0115: the canvas scrolls to a link's card by measuring the card
// against the scroll content, with the cards' reported offsets as the fallback (docs/SPEC.md, the
// block canvas). When the measurement fails, the scroll is kept pending for the next layout report;
// if measuring keeps failing, the reported offsets must still bring the card into view.
describe("a link's card scroll when measureLayout fails", () => {
  it("every measurement fails, every layout is reported: the canvas scrolls to the card by its reported offsets", async () => {
    const m = await load();
    const g = mount(m.GrillingBlocks, { hostId: HOST, projectId: P, view: blockedView(), theme, compact: true });
    const scrolled: number[] = [];
    let failures = 0;
    const CANVAS_Y = 300;
    const LIST_Y = 40;
    const cardY: Record<string, number> = { q1: 0, q2: 210, q3: 0, q4: 190, q5: 380, q6: 560 };
    const keyOf = (el: El) => (el as unknown as { key: string | null }).key;
    const attach = () => {
      const tree = g.render();
      for (const sv of all(tree, (el) => ["ScrollView", "RNScrollView"].includes(nameOf(el)) && el.props.horizontal !== true && el.props.ref != null)) {
        sv.props.ref.current = { scrollTo: (o: { y?: number }) => void scrolled.push(o.y ?? 0), getInnerViewNode: () => "content" };
      }
      for (const el of all(tree, (x) => x.props.ref != null && typeof x.props.ref === "object" && !["ScrollView", "RNScrollView"].includes(nameOf(x)))) {
        el.props.ref.current = {
          ...(el.props.ref.current ?? {}),
          measureLayout: (_rel: unknown, _ok: unknown, fail: () => void) => {
            failures++;
            fail();
          },
        };
      }
      return tree;
    };
    const fire = (tree: El) => {
      const cards = all(tree, (el) => typeof el.props.onLayout === "function" && keyOf(el) !== null && keyOf(el)! in cardY);
      const holders = all(tree, (el) => typeof el.props.onLayout === "function" && !cards.includes(el) && cards.length > 0 && all(el, (x) => cards.includes(x)).length > 0);
      const list = holders.find((h) => !holders.some((o) => o !== h && all(h, (x) => x === o).length > 0));
      const canvas = holders.find((h) => h !== list);
      canvas?.props.onLayout({ nativeEvent: { layout: { x: 0, y: CANVAS_Y, width: 360, height: 900 } } });
      list?.props.onLayout({ nativeEvent: { layout: { x: 0, y: LIST_Y, width: 360, height: 800 } } });
      for (const c of cards) c.props.onLayout({ nativeEvent: { layout: { x: 0, y: cardY[keyOf(c)!], width: 360, height: 150 } } });
    };
    fire(attach());
    await press(blockItem(g.render(), 1));
    fire(attach());
    scrolled.length = 0;
    g.render({ ...g.props(), target: { questionId: "q6", nonce: 9 } });
    // The layout reports keep coming (as the host sends them on every change); measuring keeps failing.
    for (let i = 0; i < 3; i++) {
      fire(attach());
      await flush();
    }
    attach();
    expect(failures, "the measurement was tried and failed").toBeGreaterThan(0);
    expect(scrolled.at(-1), "the canvas scrolled to the card by its reported offsets").toBe(CANVAS_Y + LIST_Y + cardY.q6 - 12);
  });
});

// DeepSeek Flash review 01a1c737 c0035: a measurement's answer for an earlier target arriving after
// a newer target was chosen. The ordering is taken from React Native Web 0.21.2 (the version Paseo
// v0.15.3 ships, `exports/UIManager/index.js`): `measureLayout` answers from a `setTimeout(0)`, so
// answers come in request order, only while both nodes are still connected, and its failure
// callback is never called. A newer target's answer therefore always follows an earlier one's;
// an answer for an earlier target that overtakes a newer one is not reachable on that host, and the
// native hosts were not checked. These cases model the reachable orderings only.
describe("a late measurement for an earlier target, as React Native Web orders them", () => {
  const CANVAS_Y = 300;
  const LIST_Y = 40;
  const cardY: Record<string, number> = { q1: 0, q2: 210, q3: 0, q4: 190, q5: 380, q6: 560 };
  const keyOf = (el: El) => (el as unknown as { key: string | null }).key;
  async function setup() {
    const m = await load();
    const g = mount(m.GrillingBlocks, { hostId: HOST, projectId: P, view: blockedView(), theme, compact: true });
    const scrolled: number[] = [];
    /** The timer queue of RN Web's measureLayout: each entry answers once, in order. */
    const queue: Array<{ key: string; answer: () => void }> = [];
    const attach = () => {
      const tree = g.render();
      for (const sv of all(tree, (el) => ["ScrollView", "RNScrollView"].includes(nameOf(el)) && el.props.horizontal !== true && el.props.ref != null)) {
        sv.props.ref.current = { scrollTo: (o: { y?: number }) => void scrolled.push(o.y ?? 0), getInnerViewNode: () => "content" };
      }
      for (const el of all(tree, (x) => x.props.ref != null && typeof x.props.ref === "object" && !["ScrollView", "RNScrollView"].includes(nameOf(x)))) {
        const key = keyOf(el);
        if (key === null || !(key in cardY)) continue;
        const y = CANVAS_Y + LIST_Y + cardY[key];
        el.props.ref.current = {
          ...(el.props.ref.current ?? {}),
          measureLayout: (_rel: unknown, ok: (x: number, y: number, w: number, h: number) => void) => void queue.push({ key, answer: () => ok(0, y, 360, 150) }),
        };
      }
      return tree;
    };
    const fire = (tree: El) => {
      const cards = all(tree, (el) => typeof el.props.onLayout === "function" && keyOf(el) !== null && keyOf(el)! in cardY);
      const holders = all(tree, (el) => typeof el.props.onLayout === "function" && !cards.includes(el) && cards.length > 0 && all(el, (x) => cards.includes(x)).length > 0);
      const list = holders.find((h) => !holders.some((o) => o !== h && all(h, (x) => x === o).length > 0));
      const canvas = holders.find((h) => h !== list);
      canvas?.props.onLayout({ nativeEvent: { layout: { x: 0, y: CANVAS_Y, width: 360, height: 900 } } });
      list?.props.onLayout({ nativeEvent: { layout: { x: 0, y: LIST_Y, width: 360, height: 800 } } });
      for (const c of cards) c.props.onLayout({ nativeEvent: { layout: { x: 0, y: cardY[keyOf(c)!], width: 360, height: 150 } } });
    };
    /** Runs the queued answers in order; one whose card is no longer drawn does not answer (RN Web checks isConnected). */
    const drain = () => {
      while (queue.length > 0) {
        const next = queue.shift()!;
        const drawn = all(g.render(), (el) => keyOf(el) === next.key && el.props.ref != null).length > 0;
        if (drawn) next.answer();
      }
    };
    const choose = (questionId: string, nonce: number) => {
      g.render({ ...g.props(), target: { questionId, nonce } });
      fire(attach());
    };
    fire(attach());
    await press(blockItem(g.render(), 1));
    fire(attach());
    drain();
    scrolled.length = 0;
    return { scrolled, queue, choose, drain, attach };
  }
  const at = (id: string) => CANVAS_Y + LIST_Y + cardY[id] - 12;

  it("control: one target, its answer scrolls to its card", async () => {
    const t = await setup();
    t.choose("q6", 11);
    expect(t.queue.length, "a measurement is waiting").toBeGreaterThan(0);
    t.drain();
    await flush();
    expect(t.scrolled.at(-1)).toBe(at("q6"));
  });

  it("a newer target in the same block chosen before the earlier answer: the canvas ends at the newer card", async () => {
    const t = await setup();
    t.choose("q6", 12);
    t.choose("q4", 13);
    expect(t.queue.map((e) => e.key), "both measurements wait, in request order").toEqual(["q6", "q4"]);
    t.drain();
    await flush();
    t.attach();
    expect(t.scrolled.at(-1), "the last scroll is the newer target's").toBe(at("q4"));
  });

  // Audit of 57c036e (c0035, request identity): a host that answers out of order, or calls the
  // failure callback, is not React Native Web 0.21.2; these cases pin that only the latest request
  // scrolls, whatever order the answers take.
  it("a host answering out of order (not RN Web): the earlier target's late answer does not scroll", async () => {
    const t = await setup();
    t.choose("q6", 21);
    t.choose("q4", 22);
    expect(t.queue.map((e) => e.key)).toEqual(["q6", "q4"]);
    const [earlier, newer] = [t.queue[0], t.queue[1]];
    t.queue.length = 0;
    newer.answer();
    earlier.answer();
    await flush();
    t.attach();
    expect(t.scrolled, "only the newer target's scroll").toEqual([at("q4")]);
  });

  it("a host whose earlier measurement fails after the newer one was asked (not RN Web): nothing scrolls toward the earlier card", async () => {
    const m = await load();
    const g = mount(m.GrillingBlocks, { hostId: HOST, projectId: P, view: blockedView(), theme, compact: true });
    const scrolled: number[] = [];
    const fails: Array<() => void> = [];
    const oks: Array<{ key: string; ok: () => void }> = [];
    const attach = () => {
      const tree = g.render();
      for (const sv of all(tree, (el) => ["ScrollView", "RNScrollView"].includes(nameOf(el)) && el.props.horizontal !== true && el.props.ref != null)) {
        sv.props.ref.current = { scrollTo: (o: { y?: number }) => void scrolled.push(o.y ?? 0), getInnerViewNode: () => "content" };
      }
      for (const el of all(tree, (x) => x.props.ref != null && typeof x.props.ref === "object" && !["ScrollView", "RNScrollView"].includes(nameOf(x)))) {
        const key = keyOf(el);
        if (key === null || !(key in cardY)) continue;
        const y = CANVAS_Y + LIST_Y + cardY[key];
        el.props.ref.current = {
          ...(el.props.ref.current ?? {}),
          measureLayout: (_rel: unknown, ok: (x: number, y: number, w: number, h: number) => void, fail: () => void) => {
            oks.push({ key, ok: () => ok(0, y, 360, 150) });
            fails.push(fail);
          },
        };
      }
      return tree;
    };
    const fire = (tree: El) => {
      const cards = all(tree, (el) => typeof el.props.onLayout === "function" && keyOf(el) !== null && keyOf(el)! in cardY);
      const holders = all(tree, (el) => typeof el.props.onLayout === "function" && !cards.includes(el) && cards.length > 0 && all(el, (x) => cards.includes(x)).length > 0);
      const list = holders.find((h) => !holders.some((o) => o !== h && all(h, (x) => x === o).length > 0));
      const canvas = holders.find((h) => h !== list);
      canvas?.props.onLayout({ nativeEvent: { layout: { x: 0, y: CANVAS_Y, width: 360, height: 900 } } });
      list?.props.onLayout({ nativeEvent: { layout: { x: 0, y: LIST_Y, width: 360, height: 800 } } });
      for (const c of cards) c.props.onLayout({ nativeEvent: { layout: { x: 0, y: cardY[keyOf(c)!], width: 360, height: 150 } } });
    };
    fire(attach());
    await press(blockItem(g.render(), 1));
    fire(attach());
    oks.length = 0;
    fails.length = 0;
    scrolled.length = 0;
    g.render({ ...g.props(), target: { questionId: "q6", nonce: 31 } });
    fire(attach());
    g.render({ ...g.props(), target: { questionId: "q4", nonce: 32 } });
    fire(attach());
    expect(oks.map((e) => e.key), "both measurements asked, in order").toEqual(["q6", "q4"]);
    oks[1].ok();
    fails[0]();
    for (let i = 0; i < 2; i++) {
      fire(attach());
      await flush();
    }
    attach();
    expect(scrolled, "no scroll toward the earlier card, by measurement or by offsets").not.toContain(at("q6"));
    expect(scrolled.at(-1)).toBe(at("q4"));
  });

  it("a newer target in another block chosen before the earlier answer: the earlier card is gone and does not answer; the canvas ends at the newer card", async () => {
    const t = await setup();
    t.choose("q6", 14);
    t.choose("q2", 15);
    expect(t.queue.map((e) => e.key), "both measurements wait, in request order").toEqual(["q6", "q2"]);
    t.drain();
    await flush();
    t.attach();
    expect(t.scrolled, "never to the earlier block's card").not.toContain(at("q6"));
    expect(t.scrolled.at(-1)).toBe(at("q2"));
  });
});
