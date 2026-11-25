// useFeatureList (redesign Stage R1.4, task card §5.2, §5.3), in node: the REAL hook from
// client/hooks.ts; `useQuery` is mocked to record its options, and `useRpc` records calls. The
// recorded queryFn is run for real, so the RPC call and the error unwrap are the hook's own.
// Limitations: no react-query runtime (no caching or refetch behaviour is exercised).
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
    queries: [] as any[],
    // R4.2 harness additions: recorded invalidations and the host config read by useProfiles.
    invalidations: [] as unknown[],
    paseoConfig: undefined as unknown,
    // R4.2 verification: other cached roadmap queries with their own store revision.
    cachedQueries: [] as Array<[unknown[], unknown]>,
    // KensAI 9126580 c0007: a re-read (invalidateQueries) that rejects.
    invalidateError: null as Error | null,
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
vi.mock("@getpaseo/plugin/client", () => ({
  useRpc: h.useRpc,
  useWorkspace: () => ({}),
  useSettings: () => ({ status: "loading" }),
  usePaseo: () => ({ config: { get: async () => ({ revision: "r1", config: h.state.paseoConfig }) } }),
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: (opts: any) => {
    h.state.queries.push(opts);
    return { data: h.state.view, isError: false };
  },
  useQueryClient: () => ({
    getQueryData: (key: unknown[]) => (key.at(-1) === "version" && h.state.cacheRevision !== null ? { status: "ok", revision: h.state.cacheRevision } : undefined),
    getQueriesData: () => h.state.cachedQueries,
    invalidateQueries: async (opts: unknown) => {
      h.state.invalidations.push(opts);
      if (h.state.invalidateError !== null) throw h.state.invalidateError;
    },
  }),
}));

const HOST = "h1";
const P = "prj_test";

beforeEach(() => {
  h.state.calls = [];
  h.state.toasts = [];
  h.state.cacheRevision = null;
  h.state.view = undefined;
  h.state.answers = {};
  h.state.queries = [];
  h.state.invalidations = [];
  h.state.paseoConfig = undefined;
  h.state.cachedQueries = [];
  h.state.invalidateError = null;
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

const calls = (name: string): Call[] => h.state.calls.filter((c) => c.name === name);


const hooksPath = "./hooks";
const load = async () => (await import(/* @vite-ignore */ hooksPath));

describe("useFeatureList (§5.2)", () => {
  it("uses the features key under roadmapKey, passes enabled through, and sets no refetchInterval", async () => {
    const m = await load();
    expect(typeof m.useFeatureList).toBe("function");
    for (const enabledFlag of [true, false]) {
      h.state.queries = [];
      mount(() => (m.useFeatureList(HOST, P, enabledFlag), null), {}).render();
      const opts = h.state.queries.find((q: any) => q.queryKey?.at(-1) === "features");
      expect(opts, "a features query").toBeDefined();
      expect(opts.queryKey).toEqual([...m.roadmapKey(HOST, P), "features"]);
      expect(opts.enabled).toBe(enabledFlag);
      expect(opts.refetchInterval).toBeUndefined();
    }
  });

  it("queryFn calls feature.list { projectId } and returns the value; an error result throws RpcFailure with the code", async () => {
    const m = await load();
    h.state.answers["feature.list"] = () => ({ ok: true, value: { revision: 3, features: [] } });
    mount(() => (m.useFeatureList(HOST, P, true), null), {}).render();
    const opts = h.state.queries.find((q: any) => q.queryKey?.at(-1) === "features");
    await expect(opts.queryFn()).resolves.toEqual({ revision: 3, features: [] });
    expect(calls("feature.list").map((c) => c.input)).toEqual([{ projectId: P }]);
    h.state.answers["feature.list"] = () => ({ ok: false, error: { code: "store_missing", message: "none" } });
    const failed = await opts.queryFn().then(() => null, (e: any) => e);
    expect(failed).toBeInstanceOf(m.RpcFailure);
    expect(failed.rpcError.code).toBe("store_missing");
  });
});

// ---- Stage R4.2 (task card 2026-10-29 R4 §3): run queries, profiles and the mutation refetch rule ----
/** Calls a hook once outside a component (fresh slots); the hooks under test use only state/callback. */
const callHook = <T,>(fn: () => T): T => {
  h.state.slots = [];
  h.state.index = 0;
  return fn();
};
const KEY = ["decision-roadmap", HOST, P];

describe("R4.2 run and profile queries", () => {
  it("useRunList: key [...roadmapKey, 'runs', featureId] (shared with FeatureChat) reading run.list for the feature", async () => {
    const m = await load();
    expect(typeof m.useRunList, "hooks exports useRunList").toBe("function");
    h.state.answers["run.list"] = () => ({ ok: true, value: { revision: 4, runs: [] } });
    callHook(() => m.useRunList(HOST, P, "f-1"));
    const q = h.state.queries.at(-1);
    expect(q.queryKey).toEqual([...KEY, "runs", "f-1"]);
    expect(await q.queryFn()).toEqual({ revision: 4, runs: [] });
    expect(h.state.calls).toEqual([{ name: "run.list", input: { projectId: P, featureId: "f-1" } }]);
  });

  it("useRun: key [...roadmapKey, 'run', runId] reading run.get; no runId → no fetch", async () => {
    const m = await load();
    expect(typeof m.useRun, "hooks exports useRun").toBe("function");
    h.state.answers["run.get"] = () => ({ ok: true, value: { revision: 4, run: { id: "run-1" }, ready: [], blocked: [] } });
    callHook(() => m.useRun(HOST, P, "run-1"));
    const q = h.state.queries.at(-1);
    expect(q.queryKey).toEqual([...KEY, "run", "run-1"]);
    await q.queryFn();
    expect(h.state.calls).toEqual([{ name: "run.get", input: { projectId: P, runId: "run-1" } }]);
    callHook(() => m.useRun(HOST, P, null));
    expect(h.state.queries.at(-1).enabled).toBe(false);
  });

  it("useProfiles: key ['decision-roadmap', hostId, 'profiles'] reading usePaseo().config.get() into { id, label } options", async () => {
    const m = await load();
    expect(typeof m.useProfiles, "hooks exports useProfiles").toBe("function");
    h.state.paseoConfig = { agentProfiles: [{ id: "team-coordinator", name: "Coordinator", provider: "claude", model: "opus" }] };
    callHook(() => m.useProfiles(HOST));
    const q = h.state.queries.at(-1);
    expect(q.queryKey).toEqual(["decision-roadmap", HOST, "profiles"]);
    expect(await q.queryFn()).toEqual([{ id: "team-coordinator", label: "Coordinator" }]);
    expect(h.state.calls, "no plugin RPC for profiles").toEqual([]);
  });
});

describe("R4.2 useRoadmapMutation refetch rule", () => {
  const contracts = async () => {
    const runs = await import("../shared/rpc-runs");
    const features = await import("../shared/rpc-features");
    return { RunResume: runs.RunResume, CoordinatorReplace: runs.CoordinatorReplace, FeatureStatusSet: features.FeatureStatusSet };
  };
  const refuse = (name: string, code: string) => {
    h.state.answers[name] = () => ({ ok: false, error: { code, message: `${code} refusal`, ...(code === "run_not_ready" ? { details: { blocked: [{ code: "run_not_running" }] } } : {}) } });
  };
  const invalidatedRoadmap = () => h.state.invalidations.some((o) => JSON.stringify((o as { queryKey?: unknown }).queryKey) === JSON.stringify(KEY));

  it("run_stale and run_not_ready refusals invalidate roadmapKey, show the refusal and are never retried", async () => {
    const m = await load();
    const { RunResume } = await contracts();
    for (const code of ["run_stale", "run_not_ready"]) {
      h.state.calls = [];
      h.state.toasts = [];
      h.state.invalidations = [];
      refuse("run.resume", code);
      const mut = callHook(() => m.useRoadmapMutation(HOST, P, RunResume));
      expect(await mut.run({ runId: "run-1", runToken: "tok-1" }, { expectedRevision: 5 })).toBeNull();
      expect(h.state.calls, code).toHaveLength(1);
      expect(invalidatedRoadmap(), `${code} invalidates`).toBe(true);
      expect(h.state.toasts.length, `${code} visible`).toBeGreaterThan(0);
    }
  });

  it("a state invalid_input on a run contract invalidates (c0095 after a concurrent resume); on a non-run contract it does not", async () => {
    const m = await load();
    const { RunResume, CoordinatorReplace, FeatureStatusSet } = await contracts();
    for (const [contract, input] of [[RunResume, { runId: "run-1", runToken: "tok-1" }], [CoordinatorReplace, { featureId: "f-1", profileRef: "plain" }]] as const) {
      h.state.calls = [];
      h.state.invalidations = [];
      refuse(contract.name, "invalid_input");
      const mut = callHook(() => m.useRoadmapMutation(HOST, P, contract));
      expect(await mut.run(input, { expectedRevision: 5 })).toBeNull();
      expect(h.state.calls, contract.name).toHaveLength(1);
      expect(invalidatedRoadmap(), `${contract.name} invalid_input invalidates`).toBe(true);
    }
    h.state.calls = [];
    h.state.invalidations = [];
    refuse("feature.status.set", "invalid_input");
    const mut = callHook(() => m.useRoadmapMutation(HOST, P, FeatureStatusSet));
    expect(await mut.run({ featureId: "f-1", status: "deferred" }, { expectedRevision: 5 })).toBeNull();
    expect(invalidatedRoadmap(), "non-run invalid_input is unchanged (no invalidation)").toBe(false);
  });

  it("control: revision_conflict still invalidates, and an explicit draft expectedRevision is preserved", async () => {
    const m = await load();
    const { FeatureStatusSet } = await contracts();
    refuse("feature.status.set", "revision_conflict");
    h.state.cacheRevision = 99;
    const mut = callHook(() => m.useRoadmapMutation(HOST, P, FeatureStatusSet));
    await mut.run({ featureId: "f-1", status: "deferred" }, { expectedRevision: 5 });
    expect(h.state.calls[0].input.expectedRevision, "the explicit draft revision is never replaced").toBe(5);
    expect(invalidatedRoadmap()).toBe(true);
  });
});

// R4.2 verification (root factual check): a run write without an explicit draft revision must use the
// latest known store revision of this host and project. card §1/§3: the latest run.get carries the
// store revision; `cachedRevision` is documented as the "latest known store revision from any cached
// roadmap query". A cached version 17 next to a fresher run.get at 18 must send 18, not 17.
describe("R4.2 verification: the mutation's default revision is the newest cached one", () => {
  it("a fresher run.get revision wins over an older cached version; an explicit draft revision stays authoritative", async () => {
    const m = await load();
    const { RunPause } = await import("../shared/rpc-runs");
    h.state.cacheRevision = 17;
    h.state.cachedQueries = [
      [[...KEY, "version"], { status: "ok", revision: 17 }],
      [[...KEY, "run", "run-1"], { revision: 18, run: { id: "run-1" }, ready: [], blocked: [] }],
    ];
    const mut = callHook(() => m.useRoadmapMutation(HOST, P, RunPause));
    await mut.run({ runId: "run-1", runToken: "tok-1" });
    expect(h.state.calls[0].input.expectedRevision, "the newest known revision (run.get 18)").toBe(18);
    h.state.calls = [];
    await mut.run({ runId: "run-1", runToken: "tok-1" }, { expectedRevision: 5 });
    expect(h.state.calls[0].input.expectedRevision, "an explicit draft revision is never replaced").toBe(5);
  });
});

// Stage R4.4 (task card §5.2): useProjectRuns(hostId, projectId, enabled) reads run.list { projectId }
// (no featureId) under [...roadmapKey, "project-runs"], distinct from FeatureChat's per-feature key;
// read-only, refreshed by the roadmapKey version invalidation.
describe("R4.4 useProjectRuns", () => {
  it("key [...roadmapKey, 'project-runs'], run.list with only projectId, enabled passed through, no mutation", async () => {
    const m = await load();
    expect(typeof m.useProjectRuns, "hooks exports useProjectRuns").toBe("function");
    h.state.answers["run.list"] = () => ({ ok: true, value: { revision: 4, runs: [] } });
    callHook(() => m.useProjectRuns(HOST, P, true));
    const q = h.state.queries.at(-1);
    expect(q.queryKey).toEqual([...KEY, "project-runs"]);
    expect(q.enabled).toBe(true);
    expect(await q.queryFn()).toEqual({ revision: 4, runs: [] });
    expect(h.state.calls).toEqual([{ name: "run.list", input: { projectId: P } }]);
    expect("featureId" in h.state.calls[0].input).toBe(false);
    callHook(() => m.useProjectRuns(HOST, P, false));
    expect(h.state.queries.at(-1).enabled).toBe(false);
    expect(h.state.invalidations, "read-only").toEqual([]);
  });
});

// KensAI 9126580 c0007 (fix d131d45): `onCallError` means the RPC call itself failed, so whether it wrote
// is unknown and the add form offers recovery. A re-read (invalidateQueries) that fails after the call
// answered is not a lost call: the answered outcome stands. TanStack Query's own invalidateQueries does
// not reject by default; the harness makes it reject to pin the hook's contract either way.
describe("c0007: only a failed call is a lost call", () => {
  const create = async () => (await import("../shared/rpc")).QuestionCreate;
  const input = { sessionId: "S", blockId: "b2", title: "Which password rules apply?", context: "", options: [], allowFreeText: true, activatedBy: [], invalidatedBy: [] };

  it("an answered create whose re-read fails returns the created question; it reports no lost call and no error", async () => {
    const m = await load();
    const QuestionCreate = await create();
    h.state.answers["question.create"] = () => ({ ok: true, value: { revision: 8, questionId: "q9", visibilityChanged: [] } });
    h.state.invalidateError = new Error("re-read failed");
    const lost: unknown[] = [];
    const refused: unknown[] = [];
    const mut = callHook(() => m.useRoadmapMutation(HOST, P, QuestionCreate));
    const out = await mut.run(input, { expectedRevision: 7, onCallError: (e: unknown) => void lost.push(e), onError: (e: unknown) => void refused.push(e) });
    expect(out, "the answered value").toEqual({ revision: 8, questionId: "q9", visibilityChanged: [] });
    expect(lost, "no lost-call signal").toEqual([]);
    expect(refused).toEqual([]);
    expect(calls("question.create"), "one call, never resent").toHaveLength(1);
    expect(h.state.invalidations.length, "the re-read was attempted").toBeGreaterThan(0);
    expect(h.state.toasts.join(" "), "the re-read failure is not shown as the request's failure").not.toMatch(/re-read failed|Request failed/);
  });

  it("a refusal whose re-read fails reports the refusal only", async () => {
    const m = await load();
    const QuestionCreate = await create();
    h.state.answers["question.create"] = () => ({ ok: false, error: { code: "revision_conflict", message: "the roadmap changed" } });
    h.state.invalidateError = new Error("re-read failed");
    const lost: unknown[] = [];
    const refused: unknown[] = [];
    const mut = callHook(() => m.useRoadmapMutation(HOST, P, QuestionCreate));
    expect(await mut.run(input, { expectedRevision: 7, onCallError: (e: unknown) => void lost.push(e), onError: (e: unknown) => void refused.push(e) })).toBeNull();
    expect(refused.map((e) => (e as { code: string }).code)).toEqual(["revision_conflict"]);
    expect(lost, "a refusal is an answer, not a lost call").toEqual([]);
    expect(calls("question.create")).toHaveLength(1);
    // DeepSeek Flash review 01a1c737 c0058: the refusal's re-read was attempted (and its failure
    // swallowed), so deleting the re-read fails this case.
    expect(h.state.invalidations.length, "the re-read was attempted").toBeGreaterThan(0);
  });

  it("a call that throws is a lost call: reported once, shown, and never resent", async () => {
    const m = await load();
    const QuestionCreate = await create();
    h.state.answers["question.create"] = () => {
      throw new Error("connection lost");
    };
    const lost: unknown[] = [];
    const refused: unknown[] = [];
    const mut = callHook(() => m.useRoadmapMutation(HOST, P, QuestionCreate));
    expect(await mut.run(input, { expectedRevision: 7, onCallError: (e: unknown) => void lost.push(e), onError: (e: unknown) => void refused.push(e) })).toBeNull();
    expect(lost.map((e) => (e as Error).message)).toEqual(["connection lost"]);
    expect(refused).toEqual([]);
    expect(calls("question.create"), "never resent").toHaveLength(1);
    expect(h.state.toasts.join(" ")).toMatch(/connection lost/);
  });
});
