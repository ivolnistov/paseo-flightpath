// Decision timeline card regressions for the REAL DecisionTimelineCard (KensAI c0047, c0048), in node.
// Minimal harness (no React renderer is installed): `react` keeps its real elements but its
// useState/useEffect are a tiny slot-based implementation; React Native, the shared UI blocks, the
// answering panel and the question modal are inert named markers (counted, never executed); the
// data hooks return a fixture session view. The card's own handlers are invoked from the rendered
// element tree and the card is re-rendered until stable. Limitations: no reconciler, remounts,
// layout or host UI; only the card's render decisions and handler wiring are exercised.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RoadmapData, Session } from "../shared/model";
import type { SessionView } from "../shared/rpc";
import { loadBranching, NOW_ISO } from "../server/test-support/build";
import { buildSessionView } from "../server/views";

type El = { type: unknown; props: Record<string, any> };
const h = vi.hoisted(() => {
  const state = {
    slots: [] as unknown[],
    index: 0,
    effects: [] as Array<{ deps: unknown[]; prev?: unknown[]; fn: () => void }>,
    effectIndex: 0,
    dirty: false,
    view: null as unknown,
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
  const useEffect = (fn: () => void, deps: unknown[]) => {
    const i = state.effectIndex++;
    const prev = state.effects[i]?.deps;
    state.effects[i] = { deps, prev, fn };
  };
  const marker = (name: string) => Object.assign(() => null, { displayName: name });
  return { state, useState, useEffect, marker };
});

vi.mock("react", async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  return { ...real, default: { ...(real.default as object), useState: h.useState, useEffect: h.useEffect }, useState: h.useState, useEffect: h.useEffect };
});
vi.mock("react-native", () => ({ Text: h.marker("Text"), View: h.marker("View") }));
vi.mock("./ui", () => ({ Button: h.marker("Button"), Heading: h.marker("Heading"), Muted: h.marker("Muted") }));
vi.mock("./question-answer-panel", () => ({ QuestionAnswerPanel: h.marker("QuestionAnswerPanel") }));
vi.mock("./question-card", () => ({ QuestionCard: h.marker("QuestionCard") }));
vi.mock("./hooks", () => ({
  RpcFailure: function RpcFailure() {},
  useRoadmapVersion: () => ({ data: { revision: 1 }, error: null, isError: false }),
  useSessionView: () => ({ data: h.state.view, error: null, isError: false, isPending: false }),
}));

// Non-literal specifier keeps the client component (and its host UI types) out of the node
// TypeScript program; Vitest resolves it at runtime.
const componentPath = "./timeline-card";
const { DecisionTimelineCard } = (await import(/* @vite-ignore */ componentPath)) as { DecisionTimelineCard: (props: unknown) => unknown };
const theme = { colors: new Proxy({}, { get: () => "#000" }) };

const view = (sessionId: string): SessionView => {
  const sessions: Session[] = loadBranching();
  const data: RoadmapData = {
    meta: { version: 2, projectId: "prj_test", createdAt: NOW_ISO, links: [], sessionIds: sessions.map((s) => s.id), planIds: [], featureIds: [], runIds: [], settings: {} },
    sessions,
    plans: [],
    features: [],
    runs: [],
    delegations: [],
  };
  return buildSessionView(data, 1, sessionId);
};
const props = (questionId: string) => ({
  agentId: "agent-synthetic",
  item: { type: "plugin", kind: "decision-question", version: 1, data: { projectId: "prj_test", sessionId: "s1", questionId } },
  timestamp: NOW_ISO,
  theme,
  host: { id: "host-synthetic", label: "Synthetic" },
  layout: { compact: false, platform: "web" },
});

function render(questionId: string): El {
  for (let pass = 0; pass < 20; pass++) {
    h.state.index = 0;
    h.state.effectIndex = 0;
    h.state.dirty = false;
    const tree = DecisionTimelineCard(props(questionId)) as El;
    for (const e of h.state.effects) {
      if (!e.prev || e.deps.some((d, i) => !Object.is(d, e.prev![i]))) e.fn();
    }
    if (!h.state.dirty) return tree;
  }
  throw new Error("component did not settle");
}
function all(tree: El, typeName: string): El[] {
  const out: El[] = [];
  const walk = (n: unknown) => {
    if (Array.isArray(n)) return n.forEach(walk);
    if (!n || typeof n !== "object") return;
    const el = n as El;
    if ((el.type as { displayName?: string })?.displayName === typeName) out.push(el);
    walk(el.props?.children);
  };
  walk(tree);
  return out;
}
const one = (tree: El, typeName: string, label?: string) => {
  const found = all(tree, typeName).filter((e) => label === undefined || e.props.label === label);
  if (found.length !== 1) throw new Error(`expected one ${typeName}${label ? ` "${label}"` : ""}, found ${found.length}`);
  return found[0];
};
/** Root style as React Native applies it: arrays flattened in order, later entries win. */
const flatStyle = (style: unknown): Record<string, unknown> =>
  Array.isArray(style) ? Object.assign({}, ...style.map(flatStyle)) : style && typeof style === "object" ? { ...(style) } : {};
const headingText = (tree: El) => [one(tree, "Heading").props.children].flat().join("");

beforeEach(() => {
  h.state.slots = [];
  h.state.effects = [];
  h.state.view = view("s1");
});

describe("DecisionTimelineCard dims inactive questions like every other question surface (c0047)", () => {
  it("an inactive question renders at opacity 0.5, an active one at 1", () => {
    const sv = h.state.view as SessionView;
    const q2 = sv.questions.find((x) => x.question.id === "q2")!;
    expect(q2.visibility).toBe("inactive"); // fixture: q2 is active only when q1 = b
    const inactive = render("q2");
    expect(headingText(inactive)).toBe(q2.question.title);
    expect(flatStyle(inactive.props.style).opacity).toBe(0.5);

    h.state.slots = [];
    const active = render("q1");
    expect(sv.questions.find((x) => x.question.id === "q1")!.visibility).toBe("active");
    expect(flatStyle(active.props.style).opacity).toBe(1);
  });
});

describe("DecisionTimelineCard shows one answering surface at a time (c0048)", () => {
  it("Details swaps the inline answer panel for the question modal, and closing the modal restores it", () => {
    let tree = render("q1");
    expect(headingText(tree)).toBe("Root choice");
    expect(all(tree, "QuestionAnswerPanel")).toHaveLength(1);
    expect(all(tree, "QuestionCard")).toHaveLength(0);

    one(tree, "Button", "Details").props.onPress();
    tree = render("q1");
    expect(all(tree, "QuestionAnswerPanel"), "inline panel hidden while Details is open").toHaveLength(0);
    const modal = one(tree, "QuestionCard");
    expect(modal.props.open).toBe(true);
    expect(modal.props.questionId).toBe("q1");

    modal.props.onOpenChange(false);
    tree = render("q1");
    expect(all(tree, "QuestionAnswerPanel")).toHaveLength(1);
    expect(all(tree, "QuestionCard")).toHaveLength(0);
  });
});
