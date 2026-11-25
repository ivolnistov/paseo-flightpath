// The decision-references card: the plugin-rendered row beside an agent's message lists each roadmap
// reference of the turn with the question's live title and an Open control; pressing Open leaves a
// one-shot question route (the whole link, kind and revision kept) for the agent's workspace, so the
// panel opens there. A question that no longer exists is said to be no longer available. The card is
// the clickable surface; the host-rendered message text itself is not touched.
//
// Node harness: the REAL ReferencesCard and the REAL pending-route store; React Native and plugin
// UI are inert markers; the session views and the agent's workspace come from stubs.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { QuestionView, SessionView } from "../shared/rpc";

type El = { type: unknown; props: Record<string, unknown> };

const h = vi.hoisted(() => {
  const state = {
    slots: [] as unknown[],
    index: 0,
    dirty: false,
    views: {} as Record<string, unknown>,
    /** A session view still loading or failed, by session id; absent means loaded from `views`. */
    pending: {} as Record<string, "loading" | "error">,
    workspaces: {} as Record<string, string>,
    rpcCalls: 0,
  };
  const useState = (init: unknown) => {
    const i = state.index++;
    if (!(i in state.slots)) {
      const first: unknown = typeof init === "function" ? Reflect.apply(init, undefined, []) : init;
      state.slots[i] = first;
    }
    const set = (v: unknown) => {
      const next: unknown = typeof v === "function" ? Reflect.apply(v, undefined, [state.slots[i]]) : v;
      if (next !== state.slots[i]) {
        state.slots[i] = next;
        state.dirty = true;
      }
    };
    return [state.slots[i], set];
  };
  const marker = (name: string) => Object.assign(() => null, { displayName: name });
  return { state, useState, marker };
});

vi.mock("react", async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  const hooks = { useState: h.useState, useEffect: () => undefined, useMemo: (fn: () => unknown) => fn(), useCallback: (fn: unknown) => fn };
  const original: unknown = real.default;
  return { ...real, ...hooks, default: { ...(typeof original === "object" && original !== null ? original : {}), ...hooks } };
});
vi.mock("react-native", () => ({ Text: h.marker("Text"), View: h.marker("View"), Pressable: h.marker("Pressable") }));
vi.mock("@getpaseo/plugin/client/react-native", () => ({ useToast: () => ({ show: () => undefined, error: () => undefined }), copyText: async () => undefined }));
vi.mock("@getpaseo/plugin/client", () => ({
  useAgent: (id: string, select?: (a: { workspaceId: string | null }) => unknown) => {
    const agent = { workspaceId: h.state.workspaces[id] ?? null };
    return select ? select(agent) : agent;
  },
  useRpc: () => async () => (h.state.rpcCalls++, { ok: true, value: {} }),
  usePaseo: () => null,
}));
vi.mock("./hooks", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useSessionView: (_host: string, _project: string, sessionId: string | null) => {
    const status = sessionId !== null ? h.state.pending[sessionId] : undefined;
    if (status === "loading") return { data: undefined, error: null, isError: false, isPending: true };
    if (status === "error") return { data: undefined, error: new Error("session view failed"), isError: true, isPending: false };
    return { data: sessionId !== null ? h.state.views[sessionId] : undefined, error: null, isError: false, isPending: false };
  },
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: undefined, isError: false }),
  useQueryClient: () => ({ getQueryData: () => undefined, getQueriesData: () => [], invalidateQueries: async () => undefined }),
}));

const AT = "2026-10-20T10:00:00.000Z";
const P = "prj_test";
const AGENT = "agent-refs";
const theme = { colors: new Proxy({}, { get: () => "#000" }) };

function qv(id: string, number: number, title: string): QuestionView {
  return {
    question: { id, order: number - 1, number, title, context: "", options: [], allowFreeText: true, definitionRev: 1, activatedBy: [], invalidatedBy: [], revisions: [], discussion: [], validity: "unanswered" },
    visibility: "active",
    status: "open",
    depth: 0,
    number,
    links: { question: `roadmap://${P}/s/s1/q/${number}`, answer: `roadmap://${P}/s/s1/q/${number}/answer` },
  };
}
const s1: SessionView = { revision: 4, session: { id: "s1", title: "Login", createdAt: AT, status: "active" }, cancellations: [], questions: [qv("q2", 2, "Which provider?"), qv("q3", 3, "Session length?")], links: [], catalog: [] };

beforeEach(() => {
  h.state.views = { s1 };
  h.state.pending = {};
  h.state.workspaces = { [AGENT]: "ws-refs" };
  h.state.rpcCalls = 0;
});

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isEl = (v: unknown): v is El => isRecord(v) && "type" in v && isRecord(v.props);
function all(tree: unknown, pred: (el: El) => boolean): El[] {
  const out: El[] = [];
  const walk = (n: unknown) => {
    if (Array.isArray(n)) return n.forEach(walk);
    if (!isEl(n)) return;
    if (pred(n)) out.push(n);
    walk(n.props.children);
  };
  walk(tree);
  return out;
}
const textOf = (n: unknown): string => {
  if (typeof n === "string" || typeof n === "number") return String(n);
  if (Array.isArray(n)) return n.map(textOf).join("");
  return isEl(n) ? textOf(n.props.children) : "";
};
const labelOf = (el: El) => String(el.props.label ?? el.props.accessibilityLabel ?? textOf(el.props.children));
const allText = (tree: unknown) => all(tree, () => true).map((el) => [typeof el.props.label === "string" ? el.props.label : "", textOf(el.props.children)].join(" ")).join("\n");
const openControls = (tree: unknown) => all(tree, (el) => typeof el.props.onPress === "function" && /open/i.test(labelOf(el)));

const modulePath = "./references-card";
async function render(refs: Array<{ link: string; sessionId: string; number: number; kind: "question" | "answer" }>): Promise<unknown> {
  const mod: unknown = await import(/* @vite-ignore */ modulePath);
  const card: unknown = isRecord(mod) ? mod.ReferencesCard : undefined;
  if (typeof card !== "function") throw new Error("missing export: references-card.ReferencesCard");
  const props = {
    agentId: AGENT,
    item: { type: "plugin", kind: "decision-references", version: 1, data: { projectId: P, turnId: "turn-1", refs } },
    timestamp: AT,
    theme,
    host: { id: "host-1", label: "Synthetic" },
    layout: { compact: true, platform: "web" },
  };
  h.state.slots = [];
  for (let pass = 0; pass < 20; pass++) {
    h.state.index = 0;
    h.state.dirty = false;
    const tree: unknown = Reflect.apply(card, undefined, [props]);
    if (!h.state.dirty) return tree;
  }
  throw new Error("component did not settle");
}
const refOf = (number: number, kind: "question" | "answer" = "question") => ({ link: `roadmap://${P}/s/s1/q/${number}${kind === "answer" ? "/answer" : ""}`, sessionId: "s1", number, kind });

describe("ReferencesCard", () => {
  it("lists each reference with its live title and one Open control", async () => {
    const tree = await render([refOf(2, "answer"), refOf(3)]);
    const text = allText(tree);
    expect(text).toContain("Which provider?");
    expect(text).toContain("Session length?");
    expect(openControls(tree)).toHaveLength(2);
    expect(h.state.rpcCalls).toBe(0);
  });

  it("Open leaves the whole link as a question route for the agent's workspace", async () => {
    const slash = await import("./slash");
    const tree = await render([refOf(2, "answer")]);
    const [open] = openControls(tree);
    const onPress = open.props.onPress;
    if (typeof onPress === "function") Reflect.apply(onPress, undefined, []);
    expect(slash.takePendingRoute({ workspaceId: "ws-refs", projectId: P })).toEqual({ kind: "question", link: { projectId: P, sessionId: "s1", number: 2, kind: "answer" } });
  });

  it("a question that no longer exists is said to be no longer available", async () => {
    const tree = await render([refOf(9)]);
    expect(allText(tree)).toMatch(/no longer available/i);
  });
});

// Review regression: a revision-pinned answer link is history, so its row names the revision and
// does not call it the current answer; a current-answer link stays labelled current.
describe("ReferencesCard pinned revisions", () => {
  it("labels a pinned answer link with its revision as history, never as the current answer", async () => {
    const tree = await render([{ link: `roadmap://${P}/s/s1/q/2/answer/r2`, sessionId: "s1", number: 2, kind: "answer" }]);
    const [open] = openControls(tree);
    const label = labelOf(open);
    const text = `${label}\n${allText(tree)}`;
    expect(text).toMatch(/\br(ev(ision)?)?\s?2\b/i);
    expect(text).toMatch(/history|not current|earlier/i);
    expect(label).not.toMatch(/current answer/i);
  });

  it("a current-answer link of an answered question is labelled as the current answer, never as history", async () => {
    h.state.views = { s1: answered() };
    const label = labelOf(openControls(await render([refOf(2, "answer")]))[0]);
    expect(label).toMatch(/current answer/i);
    expect(label).not.toMatch(/history|earlier|\brev(ision)?\s?\d/i);
    expect(label).not.toMatch(SAYS_NOT_CURRENT);
  });
});

// Review regression: whether a pinned revision is still the current answer is only known from the
// loaded session view. While the view is loading or has failed the row claims neither; once it is
// loaded, the current revision is said to be current and an earlier one is said not to be.
const answerAt = (rev: number, optionId: string) => ({ rev, optionId, source: "ui" as const, actor: { kind: "human" as const }, at: AT });
function answered(): SessionView {
  const q2 = qv("q2", 2, "Which provider?");
  q2.question = { ...q2.question, options: [{ id: "a", label: "A" }, { id: "b", label: "B" }], answer: answerAt(2, "b"), revisions: [answerAt(1, "a"), answerAt(2, "b")], validity: "valid" };
  return { ...s1, questions: [q2, qv("q3", 3, "Session length?")] };
}
const pinnedRef = (rev: number) => ({ link: `roadmap://${P}/s/s1/q/2/answer/r${rev}`, sessionId: "s1", number: 2, kind: "answer" as const });
const rowText = (tree: unknown) => [...openControls(tree).map(labelOf), allText(tree)].join("\n");
const SAYS_CURRENT = /\b(still|is) (the )?current\b|current one|\(current answer\)/i;
const SAYS_NOT_CURRENT = /\bnot current\b|no longer current|superseded/i;

describe("ReferencesCard pinned revision currency", () => {
  it("claims neither current nor not current while the session view is loading", async () => {
    h.state.pending = { s1: "loading" };
    const text = rowText(await render([pinnedRef(2)]));
    expect(text).not.toMatch(SAYS_CURRENT);
    expect(text).not.toMatch(SAYS_NOT_CURRENT);
  });

  it("claims neither current nor not current when the session view failed", async () => {
    h.state.pending = { s1: "error" };
    const text = rowText(await render([pinnedRef(2)]));
    expect(text).not.toMatch(SAYS_CURRENT);
    expect(text).not.toMatch(SAYS_NOT_CURRENT);
  });

  it("once loaded, the pinned current revision is said to be current", async () => {
    h.state.views = { s1: answered() };
    const text = rowText(await render([pinnedRef(2)]));
    expect(text).toMatch(/\br(ev(ision)?)?\s?2\b/i);
    expect(text).toMatch(SAYS_CURRENT);
    expect(text).not.toMatch(SAYS_NOT_CURRENT);
  });

  it("once loaded, an earlier pinned revision is history and said not to be current", async () => {
    h.state.views = { s1: answered() };
    const text = rowText(await render([pinnedRef(1)]));
    expect(text).toMatch(/\br(ev(ision)?)?\s?1\b/i);
    expect(text).toMatch(/history|earlier/i);
    expect(text).toMatch(SAYS_NOT_CURRENT);
    expect(text).not.toMatch(SAYS_CURRENT);
  });
});
