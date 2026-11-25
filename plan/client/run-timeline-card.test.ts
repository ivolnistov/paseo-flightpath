// Stage R3.5 (card §6.2a "Timeline run rows", consumer; root data-access ruling): `client/timeline-data.ts`
// adds RUN_ROW_KIND, RUN_ROW_VERSION and a strict RunRowData { projectId, runId }; RunTimelineCard reads
// `run.get` directly (useRpc(RunGet) + react-query useQuery, revision invalidation via useRoadmapVersion)
// and renders a read-only view: state, pause reason, task counts by state, ready and unresolved counts;
// not_found → "Run no longer available"; no actions. Rendering uses the existing node harness pattern
// (client/timeline-card.test.ts): real React elements, inert named markers for host UI, function
// components expanded, inline mocks for useRpc/useQuery/useRoadmapVersion. Registration in
// index.client.tsx is checked structurally from the source.
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

type El = { type: unknown; props: Record<string, any> };
const h = vi.hoisted(() => {
  const state = {
    rpcCalls: [] as Array<{ contract: string; input: unknown }>,
    queries: [] as Array<{ queryKey: unknown[]; queryFn?: () => Promise<unknown> }>,
    query: { data: undefined as unknown, isPending: true, isLoading: true, isError: false, error: null as unknown, isSuccess: false },
  };
  const marker = (name: string) => Object.assign(() => null, { displayName: name });
  return { state, marker };
});
vi.mock("react", async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  const useState = (init: unknown) => [typeof init === "function" ? (init as () => unknown)() : init, () => undefined];
  const useEffect = () => undefined;
  const useMemo = (fn: () => unknown) => fn();
  const useCallback = (fn: unknown) => fn;
  const useRef = (v: unknown) => ({ current: v });
  const hooks = { useState, useEffect, useMemo, useCallback, useRef };
  return { ...real, ...hooks, default: { ...(real.default as object), ...hooks } };
});
vi.mock("react-native", () => ({
  Text: h.marker("Text"), View: h.marker("View"), Pressable: h.marker("Pressable"), TouchableOpacity: h.marker("TouchableOpacity"),
  ActivityIndicator: h.marker("ActivityIndicator"), ScrollView: h.marker("ScrollView"), StyleSheet: { create: (x: unknown) => x, flatten: (x: unknown) => x },
}));
vi.mock("./ui", () => ({ Button: h.marker("Button"), Heading: h.marker("Heading"), Muted: h.marker("Muted") }));
vi.mock("@getpaseo/plugin/client", () => ({
  useRpc: (contract: { name: string }) => async (input: unknown) => {
    h.state.rpcCalls.push({ contract: contract.name, input });
    return { ok: true, value: RUN_VIEW };
  },
  useWorkspace: () => null,
}));
vi.mock("@getpaseo/plugin/client/react-native", () => ({ useToast: () => ({ show: () => undefined }) }));
vi.mock("@tanstack/react-query", () => ({
  useQuery: (opts: { queryKey: unknown[]; queryFn?: () => Promise<unknown> }) => {
    h.state.queries.push(opts);
    return h.state.query;
  },
  useQueryClient: () => ({ invalidateQueries: async () => undefined }),
}));
vi.mock("./hooks", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useRoadmapVersion: () => ({ data: { revision: 3 }, error: null, isError: false, isPending: false }),
}));

const TOKEN_MARKER = "RUN-TOKEN-MARKER-4410";
const RUN_VIEW = {
  revision: 3,
  run: {
    id: "run-1", featureId: "f-1", planId: "plan-1", planRev: 1, runToken: TOKEN_MARKER, state: "paused", pauseReason: "deferred", pausedAt: "2026-10-29T10:00:00.000Z",
    startAuth: { kind: "ui", at: "2026-10-29T09:00:00.000Z" },
    tasks: [
      { taskId: "t1", state: "verified", failedCycles: 0, extraBudget: 0, unresolved: [] },
      { taskId: "t2", state: "in_progress", agentId: "agent-w", failedCycles: 0, extraBudget: 0, unresolved: [] },
      { taskId: "t3", state: "in_progress", agentId: "agent-x", failedCycles: 0, extraBudget: 0, unresolved: [] },
    ],
    acks: [], events: [{ at: "2026-10-29T09:00:00.000Z", kind: "started", detail: "EVENT-DETAIL-MARKER" }], lateEvidence: [],
  },
  ready: ["t4"],
  blocked: [],
  unresolved: ["awaiting ack: t2 (agent-w)", "awaiting ack: t3 (agent-x)"],
};
const ok = (data: unknown) => ({ data, isPending: false, isLoading: false, isError: false, error: null, isSuccess: true });

const cardPath = "./run-timeline-card";
// Non-literal specifier (as for the card): keeps ./hooks and its React Native types out of the node
// TypeScript program; Vitest resolves it at runtime through the ./hooks mock above (real RpcFailure).
const hooksPath = "./hooks";
const loadRpcFailure = async () => ((await import(/* @vite-ignore */ hooksPath)) as { RpcFailure: unknown }).RpcFailure;
const loadCard = async () => {
  const mod = (await import(/* @vite-ignore */ cardPath)) as Record<string, unknown>;
  expect(typeof mod.RunTimelineCard, "client/run-timeline-card exports RunTimelineCard").toBe("function");
  return mod.RunTimelineCard as (props: unknown) => unknown;
};
const props = { agentId: "agent-synthetic", item: { type: "plugin", id: "run.run-1", kind: "decision-run", version: 1, data: { projectId: "prj_test", runId: "run-1" } }, timestamp: "2026-10-29T10:00:00.000Z", theme: { colors: new Proxy({}, { get: () => "#000" }) }, host: { id: "host-synthetic", label: "Synthetic" }, layout: { compact: true, platform: "ios" } };

/** Renders, expanding the card's own function components (markers stay inert), and collects elements and text. */
function render(Card: (p: unknown) => unknown) {
  const els: El[] = [];
  const text: string[] = [];
  const walk = (n: unknown, depth = 0): void => {
    if (depth > 50 || n === null || n === undefined || typeof n === "boolean") return;
    if (typeof n === "string" || typeof n === "number") return void text.push(String(n));
    if (Array.isArray(n)) return n.forEach((x) => walk(x, depth + 1));
    if (typeof n !== "object") return;
    const el = n as El;
    if (typeof el.type === "function" && !(el.type as { displayName?: string }).displayName) return walk((el.type as (p: unknown) => unknown)(el.props ?? {}), depth + 1);
    els.push(el);
    for (const [k, v] of Object.entries(el.props ?? {})) if (k === "children" || k === "label" || k === "title") walk(v, depth + 1);
  };
  walk(Card(props));
  return { els, text: text.join(" "), named: (name: string) => els.filter((e) => (e.type as { displayName?: string })?.displayName === name) };
}
const noActions = (r: ReturnType<typeof render>) => {
  expect(r.named("Pressable").length + r.named("TouchableOpacity").length + r.named("Button").length, "no pressables").toBe(0);
  expect(r.els.filter((e) => typeof e.props?.onPress === "function"), "no onPress handler").toEqual([]);
};

beforeEach(() => {
  h.state.rpcCalls = [];
  h.state.queries = [];
  h.state.query = { data: undefined, isPending: true, isLoading: true, isError: false, error: null, isSuccess: false };
});

describe("R3.5 RunTimelineCard render (root data-access ruling)", () => {
  it("queries run.get for exactly the row's project and run", async () => {
    const Card = await loadCard();
    h.state.query = ok(RUN_VIEW);
    render(Card);
    const q = h.state.queries.find((x) => JSON.stringify(x.queryKey).includes("run-1"));
    expect(q, JSON.stringify(h.state.queries.map((x) => x.queryKey))).toBeDefined();
    await q!.queryFn?.();
    expect(h.state.rpcCalls).toEqual([{ contract: "run.get", input: { projectId: "prj_test", runId: "run-1" } }]);
  });

  it("renders state, pause reason, task counts by state, ready and unresolved counts, read-only; no token or event detail", async () => {
    const Card = await loadCard();
    h.state.query = ok(RUN_VIEW);
    const r = render(Card);
    expect(r.text).toMatch(/paused/i);
    expect(r.text).toMatch(/deferred/i);
    expect(r.text).toMatch(/in[_ ]progress\D{0,6}2|2\D{0,6}in[_ ]progress/i);
    expect(r.text).toMatch(/verified\D{0,6}1|1\D{0,6}verified/i);
    expect(r.text).toMatch(/ready\D{0,6}1|1\D{0,6}ready/i);
    expect(r.text).toMatch(/unresolved\D{0,6}2|2\D{0,6}unresolved/i);
    for (const secret of [TOKEN_MARKER, "EVENT-DETAIL-MARKER", "awaiting ack"]) expect(r.text, secret).not.toContain(secret);
    noActions(r);
  });

  it("not_found renders 'Run no longer available' with no actions", async () => {
    const Card = await loadCard();
    const RpcFailure = await loadRpcFailure();
    const failure = new (RpcFailure as new (e: unknown) => Error)({ code: "not_found", message: "run not found" });
    h.state.query = { data: undefined, isPending: false, isLoading: false, isError: true, error: failure, isSuccess: false };
    const r = render(Card);
    expect(r.text).toContain("Run no longer available");
    noActions(r);
  });

  it("another error renders an error (not the missing-run text, not run state); loading renders no run state; neither has actions", async () => {
    const Card = await loadCard();
    const RpcFailure = await loadRpcFailure();
    const failure = new (RpcFailure as new (e: unknown) => Error)({ code: "store_unreadable", message: "store unreadable" });
    h.state.query = { data: undefined, isPending: false, isLoading: false, isError: true, error: failure, isSuccess: false };
    const e = render(Card);
    expect(e.text.trim().length).toBeGreaterThan(0);
    expect(e.text).not.toContain("Run no longer available");
    expect(e.text).not.toMatch(/deferred/i);
    noActions(e);
    h.state.query = { data: undefined, isPending: true, isLoading: true, isError: false, error: null, isSuccess: false };
    const l = render(Card);
    expect(l.text).not.toMatch(/deferred|unresolved/i);
    expect(l.text).not.toContain("Run no longer available");
    noActions(l);
  });
});

describe("R3.5 run row data contract", () => {
  it("RUN_ROW_KIND is decision-run, version 1, and RunRowData is strict { projectId, runId }", async () => {
    const td: Record<string, unknown> = await import("./timeline-data");
    expect(td.RUN_ROW_KIND).toBe("decision-run");
    expect(td.RUN_ROW_VERSION).toBe(1);
    expect(typeof td.RunRowData, "timeline-data exports RunRowData").toBe("object");
    const schema = td.RunRowData as { safeParse: (v: unknown) => { success: boolean } };
    expect(schema.safeParse({ projectId: "prj_test", runId: "run-1" }).success).toBe(true);
    expect(schema.safeParse({ projectId: "prj_test", runId: "run-1", runToken: "tok" }).success, "strict: no extra keys").toBe(false);
    expect(schema.safeParse({ projectId: "prj_test" }).success).toBe(false);
    expect(schema.safeParse({ projectId: "prj_test", runId: "" }).success).toBe(false);
    // Question rows keep their own kind and schema.
    expect(td.ROW_KIND).toBe("decision-question");
    expect(td.RUN_ROW_KIND).not.toBe(td.ROW_KIND);
  });
});

describe("R3.5 RunTimelineCard module and registration", () => {
  it("client/run-timeline-card.tsx exists and exports RunTimelineCard", () => {
    let src = "";
    try {
      src = readFileSync(new URL("./run-timeline-card.tsx", import.meta.url), "utf8");
    } catch {
      src = "";
    }
    expect(src.length, "client/run-timeline-card.tsx exists").toBeGreaterThan(0);
    expect(src).toMatch(/export\s+(function|const)\s+RunTimelineCard\b/);
    expect(src, "reads the current run through run.get").toMatch(/RunGet|run\.get/);
    expect(src, "missing run message").toContain("Run no longer available");
    expect(src, "no actions on the card").not.toMatch(/useRoadmapMutation|RunPause|RunResume|RunStart|TaskAccept/);
  });

  it("structural (render proven above): index.client.tsx registers the run renderer once with RUN_ROW_KIND, RUN_ROW_VERSION, RunRowData and RunTimelineCard; the question renderer stays", () => {
    const src = readFileSync(new URL("../index.client.tsx", import.meta.url), "utf8");
    const calls = src.match(/addTimelineRenderer\(\{[^}]*\}\)/g) ?? [];
    const run = calls.filter((c) => /RUN_ROW_KIND/.test(c));
    expect(run).toHaveLength(1);
    expect(run[0]).toMatch(/version:\s*RUN_ROW_VERSION/);
    expect(run[0]).toMatch(/schema:\s*RunRowData/);
    expect(run[0]).toMatch(/Component:\s*RunTimelineCard/);
    expect(calls.filter((c) => /kind:\s*ROW_KIND/.test(c))).toHaveLength(1);
  });
});
