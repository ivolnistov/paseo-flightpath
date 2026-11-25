// Question body and card (redesign Stage R1.3b, task card §4.2.3, §4.2.4), in node: the REAL
// QuestionBody (modal-free) and QuestionCard (the modal wrapper) with the REAL useRoadmapMutation;
// `useRpc` records calls. Child components (the answer panel, editors) are not rendered. React keys
// are not modelled by this harness: a keyed remount is represented by mounting a new instance, and
// the parents' `key={questionId}` is asserted on their elements.
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
  const passthrough = { useState: h.useState, useEffect: h.useEffect, useCallback: (fn: unknown) => fn, useMemo: (fn: () => unknown) => fn(), useRef: (v: unknown) => ({ current: v }) };
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
const linksOf = (n: number) => ({ question: `roadmap://${P}/s/S/q/${n}`, answer: `roadmap://${P}/s/S/q/${n}/answer` });
const qv = (question: any, status = question.answer ? "answered" : "open") => ({ question, visibility: "active", status, depth: 0, number: numberOf(question.id), links: linksOf(numberOf(question.id)) });
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

const cardPath = "./question-card";
const load = async () => (await import(/* @vite-ignore */ cardPath));
function body(m: any, view: any, questionId: string, extra: Record<string, unknown> = {}) {
  const selected: string[] = [];
  const opened: any[] = [];
  const b = mount(m.QuestionBody, { hostId: HOST, projectId: P, view, questionId, theme, compact: false, ...extra });
  return { ...b, selected, opened };
}
const reasonInput = (tree: unknown) => {
  const found = all(tree, (el) => nameOf(el) === "TextInput" && el.props.accessibilityLabel === "Cancellation reason");
  expect(found.length).toBe(1);
  return found[0];
};
const REVIEW = /^Review latest before cancelling$/;
const reviewButton = (tree: unknown) => {
  const found = pressables(tree, REVIEW);
  expect(found.length, "one review action").toBe(1);
  return found[0];
};
const cancelButton = (tree: unknown) => {
  const found = pressables(tree, /^(Cancel decision|Confirm cancel decision)$/);
  expect(found.length).toBe(1);
  return found[0];
};

describe("QuestionBody content (§4.2.3)", () => {
  it("has no Discussion section and no Add note; Edit and Relations only when not read-only", async () => {
    const m = await load();
    const open = body(m, blockedView(), "q4").render();
    expect(allText(open)).not.toMatch(/Discussion|Stored discussion/);
    expect(pressables(open, /Add note/)).toEqual([]);
    expect(pressables(open, /^Edit$/).length).toBe(1);
    expect(pressables(open, /^Relations$/).length).toBe(1);
    for (const [view, id] of [[blockedView(), "q1"], [blockedView(), "q5"], [blockedView(), "q2"], [legacyView(), "l3"]] as const) {
      const tree = body(m, view, id).render();
      expect(pressables(tree, /^(Edit|Relations)$/), id).toEqual([]);
      expect(pressables(tree, /Add note/), id).toEqual([]);
    }
  });

  it("a cancelled question shows its reason and no cancel action; replaced and cancelled shows both", async () => {
    const m = await load();
    const cancelled = body(m, blockedView(), "q5").render();
    expect(allText(cancelled)).toContain("Cancelled: Dropped");
    expect(pressables(cancelled, /Cancel decision/)).toEqual([]);
    expect(all(cancelled, (el) => el.props.accessibilityLabel === "Cancellation reason")).toEqual([]);
    const both = body(m, blockedView(), "q3").render();
    const text = allText(both);
    expect(text).toContain("Cancelled: Superseded");
    expect(text).toContain("Replaced by Q4 open");
  });
});

describe("QuestionBody replacement link (§4.2.3)", () => {
  it("same session calls onSelectQuestion with the replacing question", async () => {
    const m = await load();
    const selected: string[] = [];
    const b = body(m, blockedView(), "q3", { onSelectQuestion: (id: string) => void selected.push(id) });
    const link = pressables(b.render(), /^Replaced by Q4 open/);
    expect(link.length).toBe(1);
    expect(flat(link[0].props.style).minHeight).toBeGreaterThanOrEqual(44);
    await press(link[0]);
    expect(selected).toEqual(["q4"]);
    expect(h.state.calls).toEqual([]);
  });

  it("cross session calls onOpenRef with the full ref; without onOpenRef it is plain text, never pressable", async () => {
    const m = await load();
    const opened: any[] = [];
    const withRef = body(m, blockedView(), "q1", { onOpenRef: (ref: any) => void opened.push(ref), onSelectQuestion: () => undefined });
    await press(pressables(withRef.render(), /^Replaced by T1 replacement/)[0]);
    expect(opened).toEqual([{ sessionId: "T", questionId: "t1" }]);
    const plain = body(m, blockedView(), "q1", { onSelectQuestion: () => undefined }).render();
    expect(pressables(plain, /Replaced by/)).toEqual([]);
    expect(allText(plain)).toContain("Replaced by T1 replacement (Session T)");
  });
});

describe("QuestionBody cancel decision (§4.2.3)", () => {
  for (const [label, view, id] of [["open", blockedView, "q4"], ["frozen", blockedView, "q1"], ["legacy", legacyView, "l2"]] as const) {
    it(`${label}: no call on open or first press; blank reason keeps it disabled; the trimmed payload at the pinned revision`, async () => {
      const m = await load();
      const v = view();
      const b = body(m, v, id);
      let tree = b.render();
      await flush();
      expect(h.state.calls).toEqual([]);
      expect(flat(reasonInput(tree).props.style).minHeight).toBeGreaterThanOrEqual(44);
      expect(cancelButton(tree).props.disabled).toBe(true);
      reasonInput(tree).props.onChangeText("   ");
      tree = b.render();
      expect(cancelButton(tree).props.disabled).toBe(true);
      reasonInput(tree).props.onChangeText("  Out of scope  ");
      tree = b.render();
      expect(cancelButton(tree).props.disabled).toBeFalsy();
      await press(cancelButton(tree));
      expect(h.state.calls).toEqual([]);
      // §9.3 (c0045): a newer view (and a newer cache) never moves the pin. The cancel control and the
      // reason are replaced by an explicit review action; nothing is sent.
      h.state.cacheRevision = 50;
      tree = b.render({ ...b.props(), view: { ...v, revision: v.revision + 3 } });
      expect(pressables(tree, /Cancel decision/)).toEqual([]);
      expect(all(tree, (el) => el.props.accessibilityLabel === "Cancellation reason")).toEqual([]);
      const review = reviewButton(tree);
      expect(h.state.calls).toEqual([]);
      // The review re-pins to the rendered revision and clears the reason and the confirmation.
      await press(review);
      tree = b.render();
      expect(reasonInput(tree).props.value ?? "").toBe("");
      expect(cancelButton(tree).props.label ?? labelOf(cancelButton(tree))).toBe("Cancel decision");
      reasonInput(tree).props.onChangeText("  Out of scope  ");
      await press(cancelButton(b.render()));
      await press(pressables(b.render(), /^Confirm cancel decision$/)[0]);
      expect(calls("decision.cancel").map((c) => c.input)).toEqual([
        { sessionId: v.session.id, questionId: id, reason: "Out of scope", projectId: P, expectedRevision: v.revision + 3 },
      ]);
    });
  }

  it("an error is surfaced by the hook and not retried", async () => {
    const m = await load();
    h.state.answers["decision.cancel"] = () => ({ ok: false, error: { code: "decision_cancelled", message: "already" } });
    const b = body(m, blockedView(), "q4");
    reasonInput(b.render()).props.onChangeText("x");
    await press(cancelButton(b.render()));
    await press(pressables(b.render(), /^Confirm cancel decision$/)[0]);
    expect(calls("decision.cancel").length).toBe(1);
    expect(h.state.toasts.length).toBeGreaterThan(0);
    await flush();
    expect(calls("decision.cancel").length).toBe(1);
  });

  it("a new question gets a fresh pin and an empty reason (keyed remount)", async () => {
    const m = await load();
    const v = blockedView();
    const first = body(m, v, "q4");
    reasonInput(first.render()).props.onChangeText("Draft reason");
    const next = { ...v, revision: 9 };
    const second = body(m, next, "q6");
    const tree = second.render();
    expect(reasonInput(tree).props.value ?? "").toBe("");
    reasonInput(tree).props.onChangeText("Other");
    await press(cancelButton(second.render()));
    await press(pressables(second.render(), /^Confirm cancel decision$/)[0]);
    expect(calls("decision.cancel").map((c) => [c.input.questionId, c.input.expectedRevision])).toEqual([["q6", 9]]);
  });
});

describe("QuestionCard wrapper (§4.2.3)", () => {
  it("renders a Modal around exactly one QuestionBody with the same props and key = questionId", async () => {
    const m = await load();
    const opened = () => undefined;
    const props = { hostId: HOST, projectId: P, view: blockedView(), questionId: "q4", open: true, onOpenChange: () => undefined, theme, compact: true, onOpenRef: opened };
    const tree = mount(m.QuestionCard, props).render();
    expect(all(tree, (el) => nameOf(el) === "Modal").length).toBe(1);
    const bodies = all(tree, (el) => el.type === m.QuestionBody);
    expect(bodies.length).toBe(1);
    expect(keyOf(bodies[0])).toBe("q4");
    expect(bodies[0].props).toMatchObject({ hostId: HOST, projectId: P, questionId: "q4", compact: true, onOpenRef: opened });
    expect(bodies[0].props.view).toBe(props.view);
    // Existing callers without onOpenRef keep working.
    const legacyCaller = mount(m.QuestionCard, { ...props, onOpenRef: undefined }).render();
    expect(all(legacyCaller, (el) => el.type === m.QuestionBody).length).toBe(1);
  });
});

// R1.3b correction: ordinary controls on the grilling screen meet the 44 px target. Edit and
// Relations are a real ActionButton or a rendered element with minHeight and minWidth of at least 44.
describe("R1.3b correction: Edit and Relations touch targets", () => {
  it("Edit and Relations on an editable question are 44 px targets", async () => {
    const m = await load();
    const rs = (await import(/* @vite-ignore */ String("./roadmap-screen"))); // non-literal: keeps TSX out of the node program
    for (const [view, id] of [[blockedView(), "q4"], [blockedView(), "q6"], [legacyView(), "l2"]] as const) {
      const tree = body(m, view, id).render();
      for (const label of [/^Edit$/, /^Relations$/]) {
        const found = pressables(tree, label);
        expect(found.length, `${id} ${label}`).toBe(1);
        const el = found[0];
        const s = flat(el.props.style);
        expect(el.type === rs.ActionButton || (s.minHeight >= 44 && s.minWidth >= 44), `${id} ${label}`).toBe(true);
      }
    }
  });
});

// R1 exact-review c0045 (card §9.3): the pin stays per question; when the view has moved past it, the
// cancel control is replaced by an explicit "Review latest before cancelling" action, and nothing is
// ever resent automatically.
describe("R1 review c0045: explicit review before cancelling on a stale pin", () => {
  it("the review action is a 44 px target with an explanatory line; while the view equals the pin the shipped control stays (control)", async () => {
    const m = await load();
    const rs = (await import(/* @vite-ignore */ String("./roadmap-screen")));
    const v = blockedView();
    const b = body(m, v, "q4");
    expect(pressables(b.render(), REVIEW)).toEqual([]);
    expect(cancelButton(b.render())).toBeDefined();
    const tree = b.render({ ...b.props(), view: { ...v, revision: v.revision + 1 } });
    const review = reviewButton(tree);
    expect(review.type === rs.ActionButton || flat(review.props.style).minHeight >= 44).toBe(true);
    expect(allText(tree)).toMatch(/changed/i);
    expect(h.state.calls).toEqual([]);
  });

  it("after the re-pin, a further foreign write shows the review action again with no call", async () => {
    const m = await load();
    const v = blockedView();
    const b = body(m, v, "q4");
    // The body opens on the original view, so the pin is v.revision.
    b.render();
    b.render({ ...b.props(), view: { ...v, revision: v.revision + 3 } });
    await press(reviewButton(b.render()));
    reasonInput(b.render()).props.onChangeText("Reason");
    expect(pressables(b.render(), REVIEW)).toEqual([]);
    const tree = b.render({ ...b.props(), view: { ...v, revision: v.revision + 4 } });
    reviewButton(tree);
    expect(pressables(tree, /Cancel decision/)).toEqual([]);
    expect(h.state.calls).toEqual([]);
  });

  it("a revision_conflict at confirm is surfaced once and not retried", async () => {
    const m = await load();
    h.state.answers["decision.cancel"] = () => ({ ok: false, error: { code: "revision_conflict", message: "stale" } });
    const b = body(m, blockedView(), "q4");
    reasonInput(b.render()).props.onChangeText("x");
    await press(cancelButton(b.render()));
    await press(pressables(b.render(), /^Confirm cancel decision$/)[0]);
    await flush();
    expect(calls("decision.cancel").length).toBe(1);
    expect(h.state.toasts.length).toBeGreaterThan(0);
  });

  it("an already-cancelled question shows neither the cancel nor the review action, even on a moved view (control)", async () => {
    const m = await load();
    const v = blockedView();
    const b = body(m, v, "q5");
    const tree = b.render({ ...b.props(), view: { ...v, revision: v.revision + 2 } });
    expect(pressables(tree, /Cancel decision|Review latest/)).toEqual([]);
  });
});

// R1 final review c0090: the cancelled body's title is struck through; an uncancelled title is not.
describe("R1 final review c0090: cancelled title strikethrough", () => {
  const titleStyle = (tree: unknown, title: string) =>
    all(tree, (el) => nameOf(el) === "Text" && textOf(el.props.children).endsWith(title)).map((el) => flat(el.props.style).textDecorationLine);
  it("the cancelled q5 title has line-through; the open q4 title does not (control)", async () => {
    const m = await load();
    expect(titleStyle(body(m, blockedView(), "q5").render(), "Q5 cancelled")).toContain("line-through");
    const open = titleStyle(body(m, blockedView(), "q4").render(), "Q4 open");
    expect(open.length).toBeGreaterThan(0);
    expect(open).not.toContain("line-through");
  });
});

// Stable numbers and links on the question: the heading names Q<n>, and Copy link copies the
// question link and, for an answered question, the current-answer link (never a pinned revision).
describe("QuestionBody number and copy links", () => {
  const renumbered = (id: string, n: number) => {
    const view = blockedView();
    const row = view.questions.find((x: any) => x.question.id === id);
    row.number = n;
    row.links = linksOf(n);
    return view;
  };

  it("the heading names the question by its stable number", async () => {
    const m = await load();
    const text = allText(body(m, renumbered("q4", 14), "q4").render());
    expect(text).toMatch(/Q14\b/);
    expect(text).toContain("Q4 open");
  });

  it("Copy link copies the question link; an answered question also offers its current-answer link", async () => {
    const m = await load();
    const answeredBody = body(m, renumbered("q1", 11), "q1");
    const controls = pressables(answeredBody.render(), /copy/i);
    expect(controls.length).toBeGreaterThanOrEqual(2);
    for (const c of controls) await press(c);
    expect(h.state.copied).toEqual(expect.arrayContaining([linksOf(11).question, linksOf(11).answer]));
    expect(h.state.copied.some((t) => /\/answer\/r\d+/.test(t))).toBe(false);
  });

  it("an unanswered question offers no answer link", async () => {
    const m = await load();
    const controls = pressables(body(m, renumbered("q4", 14), "q4").render(), /copy/i);
    expect(controls.length).toBeGreaterThanOrEqual(1);
    for (const c of controls) await press(c);
    expect(h.state.copied).toContain(linksOf(14).question);
    expect(h.state.copied).not.toContain(linksOf(14).answer);
  });
});

// UI feedback plan U2 (2026-11-09, §2.2): the question shows the effective session language as a
// text chip, English included; a non-English language has an info control that shows the
// no-translation notice again. A legacy session with no language information shows no chip.
describe("QuestionBody language chip", () => {
  const withLanguage = (language?: string) => {
    const view = blockedView();
    if (language !== undefined) view.session = { ...view.session, language };
    return view;
  };
  const modals = (tree: unknown) => all(tree, (el) => nameOf(el) === "Modal" && el.props.visible !== false);

  it("names the effective language, English included", async () => {
    const m = await load();
    expect(allText(body(m, withLanguage(), "q4").render())).toMatch(/Language: English/);
    expect(allText(body(m, withLanguage("Русский"), "q4").render())).toMatch(/Language: Русский/);
  });

  it("a non-English language has an info control that shows the no-translation notice", async () => {
    const m = await load();
    const b = body(m, withLanguage("Русский"), "q4");
    const info = pressables(b.render(), /about the language/i);
    expect(info.length, "an info control").toBe(1);
    await press(info[0]);
    const shown = [...modals(b.render()).map((x) => allText(x)), allText(b.render())].join("\n");
    expect(shown).toMatch(/no translation is performed/i);
  });

  it("a legacy session without any language information shows no chip", async () => {
    const m = await load();
    expect(allText(body(m, legacyView(), "l2").render())).not.toMatch(/Language: /);
  });
});
