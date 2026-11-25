import { describe, expect, it, vi } from "vitest";
import type { WorkflowView } from "../shared/rpc";
import type { Workflow } from "../shared/workflow";
import { exampleGraph } from "./test-support/graphs";

// React Native cannot load under Node; these modules only need its names to exist.
vi.mock("react-native", () => {
  const host = (name: string) => name;
  return {
    View: host("View"),
    Text: host("Text"),
    TextInput: host("TextInput"),
    Pressable: host("Pressable"),
    ScrollView: host("ScrollView"),
    Platform: { OS: "ios", select: (options: Record<string, unknown>) => options.ios ?? options.default },
  };
});

const { default: contribute, runSubscribe } = await import("../index.client");
const { DEFAULT_TAB_STATE, PANEL_ID, PANEL_TITLE, projectIdOf, SECTIONS, TabStateSchema } = await import("./panel");
const { planSource, savedModel, yamlStatus } = await import("./planning-screen");
const { acceptReady } = await import("./job-details");
const { editorInputStyle } = await import("./yaml-view");
const { startKeyFor } = await import("./start-dialog");
const { startInputs } = await import("./start-dialog");
const { sortRuns } = await import("./execution-screen");

type Registration = { kind: string; value: unknown };

function fakeClient(withSubscribe: boolean) {
  const registered: Registration[] = [];
  const removed: string[] = [];
  const client = {
    addWorkspacePanel: (value: unknown) => {
      registered.push({ kind: "panel", value });
      return () => void removed.push("panel");
    },
    ...(withSubscribe ? { subscribe: vi.fn(() => Object.assign(vi.fn(), { ready: Promise.resolve(), release: () => Promise.resolve() })) } : {}),
  };
  return { client, registered, removed };
}

/** Calls the entry with a fake that implements only what the entry uses. */
async function runEntry(client: object): Promise<void> {
  const cleanup: unknown = Reflect.apply(contribute, undefined, [client]);
  if (typeof cleanup !== "function") throw new Error("the entry returned no cleanup");
  const done: unknown = Reflect.apply(cleanup, undefined, []);
  await done;
}

describe("client entry", () => {
  it("registers only the Pipeline workspace panel and removes it on cleanup", async () => {
    const { client, registered, removed } = fakeClient(true);
    await runEntry(client);
    expect(registered.map((entry) => entry.kind)).toEqual(["panel"]);
    expect(registered[0]?.value).toMatchObject({ id: PANEL_ID, title: PANEL_TITLE, icon: "Workflow" });
    expect(PANEL_ID).toBe("pipeline");
    expect(PANEL_TITLE).toBe("Pipeline");
    expect(removed).toEqual(["panel"]);
  });

  it("subscribes to run.watch through the client, or yields null so the feed polls", () => {
    expect(runSubscribe(fakeClient(false).client)).toBeNull();
    const { client } = fakeClient(true);
    const subscribe = runSubscribe(client);
    const onClosed = vi.fn();
    const handle = subscribe?.("r1", () => undefined, onClosed);
    expect(handle).not.toBeNull();
    const anyFunction: unknown = expect.any(Function);
    const options: unknown = expect.objectContaining({ onClosed: anyFunction });
    expect(client.subscribe).toHaveBeenCalledWith(expect.objectContaining({ name: "run.watch" }), { runId: "r1" }, expect.any(Function), options);
  });
});

describe("panel state", () => {
  it("has Planning and Execution sections, opening on Planning", () => {
    expect(SECTIONS).toEqual(["planning", "execution"]);
    expect(DEFAULT_TAB_STATE).toEqual({ section: "planning", runId: null });
    expect(TabStateSchema.safeParse({ section: "execution", runId: "r1" }).success).toBe(true);
    expect(TabStateSchema.safeParse({ section: "other", runId: null }).success).toBe(false);
  });

  it("accepts only project ids Pipeline can store data under", () => {
    expect(projectIdOf("proj-1")).toBe("proj-1");
    expect(projectIdOf("../escape")).toBeNull();
    expect(projectIdOf(null)).toBeNull();
  });
});

describe("planning source", () => {
  const model: Workflow = { inputs: {}, defaults: { maxParallel: 3, agent: {} }, jobs: [], source: {} };
  const graph = exampleGraph();
  const base: WorkflowView = { saved: { yaml: "saved", digest: "s".repeat(64) }, draft: null, editableDigest: "s".repeat(64), diagnostics: [], model, graph, savedPlan: null, proposals: [] };
  const diagnostic = { code: "uses_unknown", message: "x", line: 2, column: 3, range: null };

  it("shows a valid unsaved draft's graph", () => {
    const view: WorkflowView = { ...base, draft: { yaml: "draft", digest: "d".repeat(64) }, editableDigest: "d".repeat(64), savedPlan: { model, graph: exampleGraph() } };
    expect(planSource(view)).toMatchObject({ kind: "draft", graph });
  });

  it("keeps Diagram and Task list on the saved workflow, from the server's saved plan, while the draft is invalid", () => {
    const savedGraph = exampleGraph();
    const view: WorkflowView = { ...base, draft: { yaml: "bad", digest: "d".repeat(64) }, editableDigest: "d".repeat(64), diagnostics: [diagnostic], graph: null, savedPlan: { model, graph: savedGraph } };
    expect(planSource(view)).toEqual({ kind: "saved-fallback", graph: savedGraph, model, errors: 1 });
    expect(savedModel(view)).toBe(model);
    expect(yamlStatus({ view, text: "bad", unsent: false, busy: false, conflict: null, error: null, loadError: null })).toMatch(/1 problem/);
  });

  it("reports no workflow and an invalid one without a saved plan", () => {
    expect(planSource({ ...base, saved: null, model: null, graph: null })).toEqual({ kind: "none" });
    expect(planSource({ ...base, diagnostics: [diagnostic], graph: null })).toEqual({ kind: "invalid", errors: 1 });
    expect(savedModel({ ...base, diagnostics: [diagnostic], graph: null })).toBeNull();
  });
});

describe("execution helpers", () => {
  it("enables Accept only once every criterion is marked", () => {
    expect(acceptReady([0, 2], new Set([0]))).toBe(false);
    expect(acceptReady([0, 2], new Set([0, 2]))).toBe(true);
    expect(acceptReady([], new Set())).toBe(true);
  });

  it("sorts stored runs newest first", () => {
    const run = (runId: string, createdAt: string) => ({ runId, startKey: "k", createdAt, status: "running" as const, pauseReason: null, health: "ok" as const });
    expect(sortRuns([run("a", "2026-11-20T00:00:00Z"), run("b", "2026-11-21T00:00:00Z")]).map((entry) => entry.runId)).toEqual(["b", "a"]);
  });

  it("builds Start inputs from the form, leaving empty optional fields out", () => {
    expect(
      startInputs(
        { goal: { type: "string", required: true }, n: { type: "number", required: false }, dry: { type: "boolean", required: false }, tasks: { type: "tasks", required: false } },
        { goal: "Ship", n: "3", dry: true, tasks: "  " },
      ),
    ).toEqual({ goal: "Ship", n: 3, dry: true });
  });
});

describe("YAML editor layers", () => {
  it("keeps the input's glyphs transparent so the highlight is the only visible text, with a visible caret", () => {
    const style = editorInputStyle({ foreground: "#111111" }, { fontSize: 13, lineHeight: 20 });
    expect(style).toMatchObject({ color: "transparent", caretColor: "#111111", fontSize: 13, lineHeight: 20, backgroundColor: "transparent" });
  });
});

describe("Start keys", () => {
  it("reuses a key only for the same inputs and workflow digest", () => {
    const keys = new Map<string, string>();
    let next = 0;
    const make = (): string => `k${++next}`;
    const digest = "a".repeat(64);
    expect(startKeyFor(keys, { goal: "x" }, digest, make)).toBe("k1");
    expect(startKeyFor(keys, { goal: "x" }, digest, make)).toBe("k1");
    expect(startKeyFor(keys, { goal: "y" }, digest, make)).toBe("k2");
    expect(startKeyFor(keys, { goal: "x" }, "b".repeat(64), make)).toBe("k3");
    expect(startKeyFor(keys, { goal: "x" }, digest, make)).toBe("k1");
  });
});
