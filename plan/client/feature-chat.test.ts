// Stage R4.1 (task card 2026-10-29 R4 §2): `FeatureChat({ hostId, projectId, feature, theme, compact })`.
// Node harness in the existing client-test pattern (client/timeline-card.test.ts): real React
// elements, a slot-based useState/useEffect stand-in, inert named markers for React Native and the
// shared UI, the card's own function components expanded. Mocked boundaries:
// - `./use-agent-timeline` returns a fixed timeline (records the agentId it was asked for);
// - `usePaseo()` returns a stub whose `agents.ref(id)` records send/respondToPermission and any
//   interrupt/cancel (which must never be called) and exposes `pendingPermissions`;
// - `useRpc`/`useQuery` (run data read directly, as RunTimelineCard does) and `useRoadmapMutation`
//   record the run contract called and its input; `useRoadmapVersion` reports revision 7.
// The component module is new in R4.1, so it is loaded through a non-literal specifier inside each test.
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

type El = { type: unknown; props: Record<string, any> };
const h = vi.hoisted(() => {
  const state = {
    slots: [] as unknown[],
    index: 0,
    effects: [] as Array<{ deps?: unknown[]; fn: () => unknown; ran: boolean; cleanup?: unknown }>,
    effectIndex: 0,
    dirty: false,
    timelineAgent: [] as Array<string | null>,
    timeline: { entries: [] as unknown[], status: "live" as string },
    ops: [] as Array<{ op: string; agentId?: string; args?: unknown }>,
    sendFails: false,
    pending: [] as unknown[],
    run: null as unknown,
    rpc: [] as Array<{ contract: string; input: unknown }>,
    // R4.1 verification harness additions: a held send, per-agent pending permissions, the agent
    // handle's update subscription and refresh (installed PaseoAgentHandle.subscribe/refresh).
    sendGate: null as null | Promise<void>,
    respondGate: null as null | Promise<void>,
    respondFails: false,
    pendingBy: {} as Record<string, unknown[]>,
    agentSubs: [] as Array<{ agentId: string; handler: (u: unknown) => void; active: boolean }>,
    refreshes: [] as Array<{ agentId: string; resolve: () => void }>,
  };
  const marker = (name: string) => Object.assign(() => null, { displayName: name });
  const useState = (init: unknown) => {
    const i = state.index++;
    if (!(i in state.slots)) state.slots[i] = typeof init === "function" ? (init as () => unknown)() : init;
    const set = (v: unknown) => {
      const next = typeof v === "function" ? (v as (p: unknown) => unknown)(state.slots[i]) : v;
      if (!Object.is(next, state.slots[i])) {
        state.slots[i] = next;
        state.dirty = true;
      }
    };
    return [state.slots[i], set];
  };
  const useEffect = (fn: () => unknown, deps?: unknown[]) => {
    const i = state.effectIndex++;
    const prev = state.effects[i];
    const changed = !prev || !deps || !prev.deps || deps.some((d, k) => !Object.is(d, prev.deps![k]));
    state.effects[i] = { deps, fn, ran: prev ? !changed : false, cleanup: prev?.cleanup };
  };
  const useRef = (v: unknown) => useState(() => ({ current: v }))[0];
  const useMemo = (fn: () => unknown) => fn();
  const useCallback = (fn: unknown) => fn;
  return { state, marker, useState, useEffect, useRef, useMemo, useCallback };
});

vi.mock("react", async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  const hooks = { useState: h.useState, useEffect: h.useEffect, useLayoutEffect: h.useEffect, useRef: h.useRef, useMemo: h.useMemo, useCallback: h.useCallback };
  return { ...real, ...hooks, default: { ...(real.default as object), ...hooks } };
});
vi.mock("react-native", () => ({
  Text: h.marker("Text"),
  View: h.marker("View"),
  Pressable: h.marker("Pressable"),
  TouchableOpacity: h.marker("TouchableOpacity"),
  TextInput: h.marker("TextInput"),
  ScrollView: h.marker("ScrollView"),
  FlatList: h.marker("FlatList"),
  KeyboardAvoidingView: h.marker("KeyboardAvoidingView"),
  ActivityIndicator: h.marker("ActivityIndicator"),
  Platform: { OS: "ios", select: (o: Record<string, unknown>) => o.ios ?? o.default },
  StyleSheet: { create: (x: unknown) => x, flatten: (x: unknown) => x },
}));
// R4.2 target-size regression (R42-UI-01): the REAL shared Button renders (expanded by the harness),
// so the chat's controls are measured as actually rendered, not as an inert marker. Heading and Muted
// stay inert markers.
vi.mock("./ui", async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  return { Button: real.Button, Heading: h.marker("Heading"), Muted: h.marker("Muted") };
});
// The plugin's own row cards, inert here: the chat must hand valid own rows to them (root follow-up).
vi.mock("./timeline-card", () => ({ DecisionTimelineCard: h.marker("DecisionTimelineCard") }));
vi.mock("./run-timeline-card", () => ({ RunTimelineCard: h.marker("RunTimelineCard") }));
vi.mock("./use-agent-timeline", () => ({
  useAgentTimeline: (agentId: string | null) => {
    h.state.timelineAgent.push(agentId);
    return { ...h.state.timeline, entries: agentId ? h.state.timeline.entries : [], reload: () => undefined };
  },
  mergeTimeline: (a: unknown[], b: unknown[]) => [...a, ...b],
  reduceTimelineEvent: (s: unknown) => s,
}));
vi.mock("@getpaseo/plugin/client", () => {
  // One stable PaseoApi per module, as the host's usePaseo() is (not a new object per render).
  const api = {
    agents: {
      ref: (agentId: string) => ({
        id: agentId,
        // A live snapshot mirror, read at access time like the SDK handle's getter.
        get pendingPermissions() {
          return h.state.pendingBy[agentId] ?? h.state.pending;
        },
        subscribe: (handler: (u: unknown) => void) => {
          const sub = { agentId, handler, active: true };
          h.state.agentSubs.push(sub);
          return () => void (sub.active = false);
        },
        refresh: () => new Promise<null>((resolve) => h.state.refreshes.push({ agentId, resolve: () => resolve(null) })),
        send: async (text: string, options?: unknown) => {
          h.state.ops.push({ op: "send", agentId, args: { text, options } });
          if (h.state.sendGate) await h.state.sendGate;
          if (h.state.sendFails) throw new Error("agent offline");
        },
        respondToPermission: async (o: unknown) => {
          h.state.ops.push({ op: "respondToPermission", agentId, args: o });
          if (h.state.respondGate) await h.state.respondGate;
          if (h.state.respondFails) throw new Error("permission answer lost");
        },
        interrupt: async () => void h.state.ops.push({ op: "interrupt", agentId }),
        cancel: async () => void h.state.ops.push({ op: "cancel", agentId }),
        current: () => null,
        timeline: { subscribe: () => Object.assign(() => undefined, { ready: Promise.resolve(), subscriptionId: null, release: async () => undefined }), refetch: async () => ({ entries: [] }) },
      }),
    },
  };
  return {
  usePaseo: () => api,
  useRpc: (contract: { name: string }) => async (input: unknown) => {
    h.state.rpc.push({ contract: contract.name, input });
    if (contract.name === "run.list") return { ok: true, value: { revision: 7, runs: h.state.run ? [h.state.run] : [] } };
    if (contract.name === "run.get") return { ok: true, value: { revision: 7, ...(h.state.run as object) } };
    return { ok: true, value: { revision: 8 } };
  },
  useWorkspace: () => null,
  };
});
vi.mock("@getpaseo/plugin/client/react-native", () => ({ useToast: () => ({ show: () => undefined, error: () => undefined }) }));
vi.mock("@tanstack/react-query", () => ({
  useQuery: (opts: { queryKey: unknown[] }) => {
    const key = JSON.stringify(opts.queryKey);
    if (/run/.test(key)) {
      const runs = h.state.run ? [h.state.run] : [];
      const single = h.state.run ? { revision: 7, ...(h.state.run as object) } : undefined;
      return { data: /runs|list/.test(key) ? { revision: 7, runs } : (single ?? { revision: 7, runs }), isPending: false, isError: false, error: null, isSuccess: true };
    }
    return { data: { revision: 7 }, isPending: false, isError: false, error: null, isSuccess: true };
  },
  useQueryClient: () => ({ invalidateQueries: async () => undefined, getQueryData: () => ({ revision: 7 }), getQueriesData: () => [] }),
  useMutation: () => ({ mutate: () => undefined, mutateAsync: async () => undefined, isPending: false }),
}));
vi.mock("./hooks", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useRoadmapVersion: () => ({ data: { revision: 7 }, error: null, isError: false, isPending: false }),
  useRoadmapMutation: (_host: string, projectId: string, contract: { name: string }) => ({
    pending: false,
    run: async (input: Record<string, unknown>) => {
      h.state.rpc.push({ contract: contract.name, input: { ...input, projectId, expectedRevision: 7 } });
      return { revision: 8 };
    },
  }),
}));

const chatPath = "./feature-chat";
const loadChat = async () => {
  const mod = (await import(/* @vite-ignore */ chatPath)) as Record<string, unknown>;
  expect(typeof mod.FeatureChat, "client/feature-chat exports FeatureChat").toBe("function");
  return mod.FeatureChat as (p: unknown) => unknown;
};
const T0 = "2026-10-29T10:00:00.000Z";
const ENTRIES = [
  { provider: "claude", item: { type: "user_message", text: "Please start task one" }, timestamp: T0, seqStart: 1, seqEnd: 1 },
  { provider: "claude", item: { type: "assistant_message", text: "Starting task one now" }, timestamp: T0, seqStart: 2, seqEnd: 2 },
  { provider: "claude", item: { type: "tool_call", callId: "c1", name: "mcp__decision-roadmap__roadmap_run_next", status: "completed", detail: { type: "unknown", input: {}, output: null }, error: null }, timestamp: T0, seqStart: 3, seqEnd: 3 },
];
const FEATURE = (coordinator = true) => ({
  id: "f-1",
  title: "Search",
  status: "executing",
  ...(coordinator ? { coordinator: { agentId: "agent-c", workspaceId: "ws-1", boundAt: T0, profileRef: "team-coordinator" } } : {}),
});
const RUN = (state: "running" | "paused") => ({
  run: { id: "run-1", featureId: "f-1", planId: "plan-1", planRev: 1, runToken: "tok-1", state, ...(state === "paused" ? { pauseReason: "owner", pausedAt: T0 } : {}), startAuth: { kind: "ui", at: T0 }, tasks: [], acks: [], events: [], lateEvidence: [] },
  ready: [],
  blocked: [],
});
const theme = { colors: new Proxy({}, { get: () => "#000" }), spacing: new Proxy({}, { get: () => 8 }) };

/** Renders until stable, running changed effects; expands the component's own function components. */
function render(Chat: (p: unknown) => unknown, props: Record<string, unknown>) {
  let tree: unknown;
  for (let pass = 0; pass < 20; pass++) {
    h.state.index = 0;
    h.state.effectIndex = 0;
    h.state.dirty = false;
    tree = Chat(props);
    for (const e of h.state.effects) {
      if (!e.ran) {
        e.ran = true;
        if (typeof e.cleanup === "function") (e.cleanup as () => void)();
        e.cleanup = e.fn();
      }
    }
    if (!h.state.dirty) break;
  }
  const els: El[] = [];
  const text: string[] = [];
  const walk = (n: unknown, depth = 0): void => {
    if (depth > 60 || n === null || n === undefined || typeof n === "boolean") return;
    if (typeof n === "string" || typeof n === "number") return void text.push(String(n));
    if (Array.isArray(n)) return n.forEach((x) => walk(x, depth + 1));
    if (typeof n !== "object") return;
    const el = n as El;
    if (typeof el.type === "function" && !(el.type as { displayName?: string }).displayName) return walk((el.type as (p: unknown) => unknown)(el.props ?? {}), depth + 1);
    els.push(el);
    for (const [k, v] of Object.entries(el.props ?? {})) {
      if (k === "children" || k === "label" || k === "title" || k === "placeholder" || k === "ListHeaderComponent" || k === "ListFooterComponent") walk(v, depth + 1);
      if (k === "data" && Array.isArray(v) && typeof el.props.renderItem === "function") v.forEach((item, index) => walk(el.props.renderItem({ item, index }), depth + 1));
    }
  };
  walk(tree);
  const all = text.join(" ");
  const pressables = els.filter((e) => typeof e.props?.onPress === "function");
  const labelOf = (e: El): string => {
    const t: string[] = [];
    const w = (n: unknown): void => {
      if (typeof n === "string" || typeof n === "number") return void t.push(String(n));
      if (Array.isArray(n)) return n.forEach(w);
      if (n && typeof n === "object") {
        const x = n as El;
        if (typeof x.type === "function" && !(x.type as { displayName?: string }).displayName) return w((x.type as (p: unknown) => unknown)(x.props ?? {}));
        w(x.props?.children);
        if (typeof x.props?.label === "string") t.push(x.props.label);
        if (typeof x.props?.title === "string") t.push(x.props.title);
      }
    };
    w(e);
    if (typeof e.props.accessibilityLabel === "string") t.push(e.props.accessibilityLabel);
    return t.join(" ");
  };
  const press = (re: RegExp) => {
    const found = pressables.filter((e) => re.test(labelOf(e)));
    expect(found.length, `one pressable matching ${re} (have: ${pressables.map(labelOf).join(" | ")})`).toBeGreaterThanOrEqual(1);
    return found[0].props.onPress();
  };
  const inputs = els.filter((e) => typeof e.props?.onChangeText === "function");
  return { tree, els, text: all, pressables, labelOf, press, inputs };
}
const flat = (style: unknown): Record<string, unknown> => (Array.isArray(style) ? Object.assign({}, ...style.map(flat)) : style && typeof style === "object" ? { ...(style) } : {});
const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};
const props = (coordinator = true) => ({ hostId: "host-1", projectId: "prj_test", feature: FEATURE(coordinator), theme, compact: true });
const agentCalls = () => h.state.ops.filter((o) => o.op !== "respondToPermission" && o.op !== "send");

beforeEach(() => {
  h.state.slots = [];
  h.state.effects = [];
  h.state.timelineAgent = [];
  h.state.timeline = { entries: ENTRIES, status: "live" };
  h.state.ops = [];
  h.state.sendFails = false;
  h.state.pending = [];
  h.state.run = RUN("running");
  h.state.rpc = [];
  h.state.sendGate = null;
  h.state.respondGate = null;
  h.state.respondFails = false;
  h.state.pendingBy = {};
  h.state.agentSubs = [];
  h.state.refreshes = [];
});

describe("R4.1 FeatureChat render", () => {
  it("renders user, assistant and tool items as text from the coordinator's timeline", async () => {
    const Chat = await loadChat();
    const r = render(Chat, props());
    expect(h.state.timelineAgent.at(-1)).toBe("agent-c");
    expect(r.text).toContain("Please start task one");
    expect(r.text).toContain("Starting task one now");
    expect(r.text).toMatch(/roadmap_run_next/);
  });

  it("without a coordinator: 'No coordinator chat yet', no composer, no SDK call", async () => {
    const Chat = await loadChat();
    const r = render(Chat, props(false));
    expect(r.text).toContain("No coordinator chat yet");
    expect(r.inputs).toEqual([]);
    expect(h.state.timelineAgent.every((a) => a === null)).toBe(true);
    expect(h.state.ops).toEqual([]);
  });
});

describe("R4.1 FeatureChat composer", () => {
  it("send goes only to the bound coordinator; success clears the input", async () => {
    const Chat = await loadChat();
    let r = render(Chat, props());
    expect(r.inputs.length).toBeGreaterThanOrEqual(1);
    r.inputs[0].props.onChangeText("Please continue");
    r = render(Chat, props());
    await r.press(/send/i);
    await flush();
    r = render(Chat, props());
    const sends = h.state.ops.filter((o) => o.op === "send");
    expect(sends).toHaveLength(1);
    expect(sends[0]).toMatchObject({ agentId: "agent-c", args: { text: "Please continue" } });
    expect(r.inputs[0].props.value ?? "").toBe("");
  });

  it("a failed send is visible, keeps the text and is not retried", async () => {
    const Chat = await loadChat();
    h.state.sendFails = true;
    let r = render(Chat, props());
    r.inputs[0].props.onChangeText("Please continue");
    r = render(Chat, props());
    await r.press(/send/i);
    await flush();
    r = render(Chat, props());
    await flush();
    expect(h.state.ops.filter((o) => o.op === "send")).toHaveLength(1);
    expect(r.text).toMatch(/agent offline|not sent|failed/i);
    expect(r.inputs[0].props.value).toBe("Please continue");
  });

  it("layout: the input is 16 px and the send target at least 44 px", async () => {
    const Chat = await loadChat();
    const r = render(Chat, props());
    expect(flat(r.inputs[0].props.style).fontSize).toBe(16);
    const send = r.pressables.find((e) => /send/i.test(r.labelOf(e)))!;
    const s = flat(send.props.style);
    expect(Math.max(Number(s.minHeight ?? 0), Number(s.height ?? 0)), "send height").toBeGreaterThanOrEqual(44);
  });
});

describe("R4.1 FeatureChat permissions", () => {
  const REQUEST = { id: "perm-1", provider: "claude", name: "Bash", kind: "tool", title: "Run npm test" };

  it("allow responds with exactly { requestId, response: { behavior: 'allow' } }", async () => {
    const Chat = await loadChat();
    h.state.pending = [REQUEST];
    const r = render(Chat, props());
    expect(r.text).toContain("Run npm test");
    await r.press(/allow/i);
    await flush();
    const calls = h.state.ops.filter((o) => o.op === "respondToPermission");
    expect(calls).toHaveLength(1);
    expect(calls[0].agentId).toBe("agent-c");
    const args = calls[0].args as { requestId: string; response: Record<string, unknown> };
    expect(Object.keys(args).sort()).toEqual(["requestId", "response"]);
    expect(args.requestId).toBe("perm-1");
    expect(args.response.behavior).toBe("allow");
    for (const k of ["interrupt", "updatedInput", "updatedPermissions"]) expect(k in args.response, `no ${k}`).toBe(false);
  });

  it("deny responds with behavior deny and never a forced interrupt", async () => {
    const Chat = await loadChat();
    h.state.pending = [REQUEST];
    const r = render(Chat, props());
    await r.press(/deny/i);
    await flush();
    const args = h.state.ops.find((o) => o.op === "respondToPermission")!.args as { requestId: string; response: Record<string, unknown> };
    expect(args.requestId).toBe("perm-1");
    expect(args.response.behavior).toBe("deny");
    for (const k of ["interrupt", "updatedInput", "updatedPermissions"]) expect(k in args.response, `no ${k}`).toBe(false);
    expect(agentCalls()).toEqual([]);
  });
});

describe("R4.1 FeatureChat safe pause and resume", () => {
  it("Pause calls the run.pause RPC with the run and its token at the current revision; no agent interrupt or cancel", async () => {
    const Chat = await loadChat();
    const r = render(Chat, props());
    await r.press(/pause/i);
    await flush();
    const pause = h.state.rpc.filter((c) => c.contract === "run.pause");
    expect(pause).toHaveLength(1);
    expect(pause[0].input).toMatchObject({ projectId: "prj_test", runId: "run-1", runToken: "tok-1", expectedRevision: 7 });
    expect(agentCalls()).toEqual([]);
  });

  it("Resume (paused run) calls the run.resume RPC; no agent interrupt or cancel", async () => {
    const Chat = await loadChat();
    h.state.run = RUN("paused");
    const r = render(Chat, props());
    await r.press(/resume/i);
    await flush();
    const resume = h.state.rpc.filter((c) => c.contract === "run.resume");
    expect(resume).toHaveLength(1);
    expect(resume[0].input).toMatchObject({ projectId: "prj_test", runId: "run-1", runToken: "tok-1", expectedRevision: 7 });
    expect(agentCalls()).toEqual([]);
  });
});

// R4 corrective (root browser QA R3QA-083311): FeatureChat's Resume read the run.list view's run and
// discarded its `blocked`, so a paused run the server refuses to resume (run-level blocker) still showed
// an enabled Resume while the feature screen correctly offered none (c0012 on a second surface). The
// server refuses run.resume for any run-level blocker other than run_not_running.
describe("R4 corrective: FeatureChat Resume follows the run view's run-level blockers", () => {
  const blockedRun = (blocked: Array<{ code: string; taskId?: string }>) => ({ ...RUN("paused"), blocked });
  const resumeButtons = (r: ReturnType<typeof render>) => r.pressables.filter((e) => /^\s*Resume\b/i.test(r.labelOf(e)));
  for (const code of ["approval_not_current", "start_unauthorised", "prerequisite_not_done"]) {
    it(`a paused run blocked by ${code}: no enabled Resume (a disabled one names the reason), no run.resume, Pause unaffected`, async () => {
      const Chat = await loadChat();
      h.state.run = blockedRun([{ code: "run_not_running" }, { code }]);
      const r = render(Chat, props());
      const resume = resumeButtons(r);
      expect(resume.filter((e) => e.props.disabled !== true), `${code}: Resume is not offered as enabled`).toEqual([]);
      if (resume.length > 0) expect(r.text, `${code}: a disabled Resume names the blocker`).toContain(code.replace(/_/g, " "));
      expect(h.state.rpc.filter((c) => c.contract === "run.resume"), code).toEqual([]);
      expect(r.pressables.filter((e) => /^\s*Pause\b/i.test(r.labelOf(e))), "a paused run offers no Pause").toEqual([]);
      expect(agentCalls()).toEqual([]);
    });
  }

  it("control: run_not_running and task-level blockers keep Resume enabled; it calls run.resume once with the run's token", async () => {
    const Chat = await loadChat();
    h.state.run = blockedRun([{ code: "run_not_running" }, { code: "not_todo", taskId: "t1" }, { code: "ceiling", taskId: "t2" }]);
    const r = render(Chat, props());
    const enabled = resumeButtons(r).filter((e) => e.props.disabled !== true);
    expect(enabled).toHaveLength(1);
    await enabled[0].props.onPress();
    await flush();
    const resume = h.state.rpc.filter((c) => c.contract === "run.resume");
    expect(resume).toHaveLength(1);
    expect(resume[0].input).toMatchObject({ projectId: "prj_test", runId: "run-1", runToken: "tok-1", expectedRevision: 7 });
    expect(agentCalls()).toEqual([]);
  });
});

describe("R4.1 module boundaries", () => {
  it("feature-chat.tsx and use-agent-timeline.ts use no DOM API and never interrupt or cancel an agent", () => {
    for (const rel of ["./feature-chat.tsx", "./use-agent-timeline.ts"]) {
      let src = "";
      try {
        src = readFileSync(new URL(rel, import.meta.url), "utf8");
      } catch {
        src = "";
      }
      expect(src.length, `${rel} exists`).toBeGreaterThan(0);
      expect(src, rel).not.toMatch(/\bdocument\.|\bwindow\.|HTMLElement|localStorage|react-dom/);
      expect(src, rel).not.toMatch(/\.interrupt\(|\.cancel\(|interrupt:\s*true/);
    }
  });
});

/** Runs every effect cleanup (unmount) in the stand-in. */
const unmountAll = () => {
  for (const e of h.state.effects) if (typeof e.cleanup === "function") (e.cleanup as () => void)();
  h.state.effects = [];
};
const withCoordinator = (agentId: string) => ({ ...props(), feature: { ...FEATURE(), coordinator: { agentId, workspaceId: "ws-1", boundAt: T0, profileRef: "team-coordinator" } } });

// R4.1 verification (root item 1): a permission raised or cleared after the first render reaches the
// card through the agent handle's update subscription or its refresh; agent change and unmount stop
// observing the old agent, and the old agent's late refresh does not show its requests.
describe("R4.1 verification: permissions arrive and clear after the first render", () => {
  const REQUEST = { id: "perm-9", provider: "claude", name: "Bash", kind: "tool", title: "Run the deploy script" };

  it("an agent update shows a new request and clears an answered one", async () => {
    const Chat = await loadChat();
    let r = render(Chat, props());
    expect(r.pressables.some((e) => /allow/i.test(r.labelOf(e)))).toBe(false);
    h.state.pending = [REQUEST];
    for (const sub of h.state.agentSubs.filter((x) => x.agentId === "agent-c" && x.active)) sub.handler({});
    for (const f of h.state.refreshes.splice(0)) f.resolve();
    await flush();
    r = render(Chat, props());
    expect(r.text).toContain("Run the deploy script");
    h.state.pending = [];
    for (const sub of h.state.agentSubs.filter((x) => x.agentId === "agent-c" && x.active)) sub.handler({});
    await flush();
    r = render(Chat, props());
    expect(r.text).not.toContain("Run the deploy script");
  });

  it("an agent change stops observing the old agent and ignores its late refresh; unmount stops observing", async () => {
    const Chat = await loadChat();
    render(Chat, withCoordinator("agent-c"));
    const oldRefresh = h.state.refreshes.find((x) => x.agentId === "agent-c");
    let r = render(Chat, withCoordinator("agent-d"));
    expect(h.state.agentSubs.filter((x) => x.agentId === "agent-c" && x.active), "old agent unsubscribed").toEqual([]);
    h.state.pendingBy["agent-c"] = [REQUEST];
    oldRefresh?.resolve();
    await flush();
    r = render(Chat, withCoordinator("agent-d"));
    expect(r.text, "the old agent's request is not shown for the new coordinator").not.toContain("Run the deploy script");
    unmountAll();
    expect(h.state.agentSubs.filter((x) => x.active), "unmount unsubscribes").toEqual([]);
  });
});

// R4.1 verification (root item 4): the composer stays editable while a send is in flight, so a
// success must clear only the text that was sent, never a draft typed meanwhile; a send that
// settles after the coordinator changed must not clear or mark an error in the new chat.
describe("R4.1 verification: in-flight send never loses a newer draft or leaks into a new chat", () => {
  it("text typed while the send awaits survives the send's success (or the input is not editable while sending)", async () => {
    const Chat = await loadChat();
    let release: () => void = () => undefined;
    h.state.sendGate = new Promise<void>((res) => (release = res));
    let r = render(Chat, props());
    r.inputs[0].props.onChangeText("first message");
    r = render(Chat, props());
    const sending = r.press(/send/i);
    await flush();
    r = render(Chat, props());
    if (r.inputs[0].props.editable === false) {
      release();
      await sending;
      return;
    }
    r.inputs[0].props.onChangeText("second draft");
    r = render(Chat, props());
    release();
    await sending;
    await flush();
    r = render(Chat, props());
    expect(h.state.ops.filter((o) => o.op === "send").map((o) => (o.args as { text: string }).text)).toEqual(["first message"]);
    expect(r.inputs[0].props.value).toBe("second draft");
  });

  it("a send to the old coordinator that fails after a coordinator change does not mark an error or clear the new chat's draft", async () => {
    const Chat = await loadChat();
    let release: () => void = () => undefined;
    h.state.sendGate = new Promise<void>((res) => (release = res));
    h.state.sendFails = true;
    let r = render(Chat, withCoordinator("agent-c"));
    r.inputs[0].props.onChangeText("for agent c");
    r = render(Chat, withCoordinator("agent-c"));
    const sending = r.press(/send/i);
    await flush();
    r = render(Chat, withCoordinator("agent-d"));
    if (r.inputs[0].props.editable !== false) r.inputs[0].props.onChangeText("for agent d");
    r = render(Chat, withCoordinator("agent-d"));
    release();
    await sending;
    await flush();
    r = render(Chat, withCoordinator("agent-d"));
    expect(r.text, "no stale send error in the new coordinator's chat").not.toMatch(/Not sent/);
    if (r.inputs[0].props.editable !== false) expect(r.inputs[0].props.value).toBe("for agent d");
  });
});

// R4.1 verification follow-up (root): card §2 says plugin rows render through their registered cards,
// and the installed SDK has no generic host renderer for a custom list. The chat therefore hands a
// valid own row to the existing card component, DecisionTimelineCard (decision-question v1, strict
// RowData) or RunTimelineCard (decision-run v1, strict RunRowData), with PluginTimelineItemProps
// { agentId, timestamp, item, theme, host: { id, label }, layout: { compact, platform } }. An unknown
// kind, another version or malformed data is never presented as one of those cards.
describe("R4.1 verification: own plugin rows render through the existing row cards", () => {
  const pluginRow = (seq: number, kind: string, version: number, data: unknown) => ({
    provider: "claude",
    item: { type: "plugin", id: `row-${seq}`, kind, version, data },
    timestamp: T0,
    seqStart: seq,
    seqEnd: seq,
  });
  const QUESTION = pluginRow(10, "decision-question", 1, { projectId: "prj_test", sessionId: "s1", questionId: "q1" });
  const RUN_ROW = pluginRow(11, "decision-run", 1, { projectId: "prj_test", runId: "run-1" });
  const MALFORMED = [
    pluginRow(12, "decision-question", 1, { projectId: "prj_test", sessionId: "s1" }), // missing questionId
    pluginRow(13, "decision-run", 1, { projectId: "prj_test", runId: "run-1", runToken: "tok-1" }), // not strict
    pluginRow(14, "decision-run", 2, { projectId: "prj_test", runId: "run-1" }), // another version
    pluginRow(15, "other-plugin-kind", 1, { projectId: "prj_test" }), // unknown kind
  ];

  it("a valid decision-question row renders DecisionTimelineCard and a valid decision-run row renders RunTimelineCard, with the item props", async () => {
    const Chat = await loadChat();
    h.state.timeline = { entries: [...ENTRIES, QUESTION, RUN_ROW], status: "live" };
    const r = render(Chat, props());
    const q = r.els.filter((e) => (e.type as { displayName?: string })?.displayName === "DecisionTimelineCard");
    const run = r.els.filter((e) => (e.type as { displayName?: string })?.displayName === "RunTimelineCard");
    expect(q, "one DecisionTimelineCard").toHaveLength(1);
    expect(run, "one RunTimelineCard").toHaveLength(1);
    for (const [el, row] of [[q[0], QUESTION], [run[0], RUN_ROW]] as const) {
      expect(el.props.agentId).toBe("agent-c");
      expect(el.props.item).toMatchObject({ type: "plugin", kind: row.item.kind, version: 1, data: row.item.data });
      expect(new Date(el.props.timestamp).toISOString()).toBe(T0);
      expect(el.props.theme).toBe(theme);
      expect(el.props.host).toMatchObject({ id: "host-1" });
      expect(typeof el.props.host.label).toBe("string");
      expect(el.props.layout).toMatchObject({ compact: true });
      expect(typeof el.props.layout.platform).toBe("string");
    }
    expect(r.text, "the ordinary rows still render").toContain("Starting task one now");
  });

  it("an unknown kind, another version or malformed data is never presented as an own row card", async () => {
    const Chat = await loadChat();
    h.state.timeline = { entries: [...ENTRIES, ...MALFORMED], status: "live" };
    const r = render(Chat, props());
    const cards = r.els.filter((e) => ["DecisionTimelineCard", "RunTimelineCard"].includes((e.type as { displayName?: string })?.displayName ?? ""));
    expect(cards).toEqual([]);
    expect(r.text).toContain("Starting task one now");
  });
});

// R4.1 final verification (T): D3 controls. A coordinator change while an old send is pending leaves
// the new chat's Send usable; returning to the first coordinator (A → B → A) still ignores the old
// send's completion or error; an old permission answer failing after a change is not shown.
describe("R4.1 final verification: old asynchronous outcomes never act in a newer coordinator context", () => {
  const holdSend = () => {
    let release: () => void = () => undefined;
    h.state.sendGate = new Promise<void>((res) => (release = res));
    return () => {
      h.state.sendGate = null;
      release();
    };
  };

  it("after a coordinator change while the old send is pending, the new chat can send", async () => {
    const Chat = await loadChat();
    const release = holdSend();
    let r = render(Chat, withCoordinator("agent-c"));
    r.inputs[0].props.onChangeText("for agent c");
    r = render(Chat, withCoordinator("agent-c"));
    const old = r.press(/send/i);
    await flush();
    r = render(Chat, withCoordinator("agent-d"));
    r.inputs[0].props.onChangeText("for agent d");
    r = render(Chat, withCoordinator("agent-d"));
    const fresh = r.press(/send/i);
    await flush();
    release();
    await Promise.all([old, fresh]);
    await flush();
    const sends = h.state.ops.filter((o) => o.op === "send").map((o) => [o.agentId, (o.args as { text: string }).text]);
    expect(sends).toEqual([["agent-c", "for agent c"], ["agent-d", "for agent d"]]);
  });

  it("A → B → A: the first send's failure is not shown and its success does not clear an identical new draft", async () => {
    const Chat = await loadChat();
    h.state.sendFails = true;
    let release = holdSend();
    let r = render(Chat, withCoordinator("agent-c"));
    r.inputs[0].props.onChangeText("same words");
    r = render(Chat, withCoordinator("agent-c"));
    let pending = r.press(/send/i);
    await flush();
    render(Chat, withCoordinator("agent-d"));
    r = render(Chat, withCoordinator("agent-c"));
    r.inputs[0].props.onChangeText("same words");
    r = render(Chat, withCoordinator("agent-c"));
    release();
    await pending;
    await flush();
    r = render(Chat, withCoordinator("agent-c"));
    expect(r.text, "no stale error after returning to the first coordinator").not.toMatch(/Not sent/);
    expect(r.inputs[0].props.value).toBe("same words");
    // The success path: a stale success must not clear the identical draft typed after A → B → A.
    h.state.sendFails = false;
    release = holdSend();
    r = render(Chat, withCoordinator("agent-c"));
    pending = r.press(/send/i);
    await flush();
    render(Chat, withCoordinator("agent-d"));
    r = render(Chat, withCoordinator("agent-c"));
    r.inputs[0].props.onChangeText("same words");
    r = render(Chat, withCoordinator("agent-c"));
    release();
    await pending;
    await flush();
    r = render(Chat, withCoordinator("agent-c"));
    expect(r.inputs[0].props.value).toBe("same words");
  });

  it("a permission answer to the old coordinator that fails after a change shows no error in the new chat", async () => {
    const Chat = await loadChat();
    const REQUEST = { id: "perm-7", provider: "claude", name: "Bash", kind: "tool", title: "Run the migration" };
    h.state.pendingBy["agent-c"] = [REQUEST];
    let release: () => void = () => undefined;
    h.state.respondGate = new Promise<void>((res) => (release = res));
    h.state.respondFails = true;
    let r = render(Chat, withCoordinator("agent-c"));
    const answering = r.press(/allow/i);
    await flush();
    r = render(Chat, withCoordinator("agent-d"));
    release();
    await answering;
    await flush();
    r = render(Chat, withCoordinator("agent-d"));
    expect(r.text).not.toMatch(/Answer not delivered/);
    // Control: the same failure in the same context is shown.
    h.state.respondGate = null;
    h.state.pendingBy["agent-d"] = [REQUEST];
    // The request reaches the chat through the agent update (as in the dynamic-permission test).
    for (const sub of h.state.agentSubs.filter((x) => x.agentId === "agent-d" && x.active)) sub.handler({});
    await flush();
    r = render(Chat, withCoordinator("agent-d"));
    await r.press(/allow/i);
    await flush();
    r = render(Chat, withCoordinator("agent-d"));
    expect(r.text).toMatch(/Answer not delivered/);
  });
});

// R4.2 browser QA defect R42-UI-01 (redesign-r4-2-browser-report.md, chat-targets.json): FeatureChat's
// Resume and Reload chat measured 35 px high in the real QA browser; the approved minimum touch target
// is 44 px (Send already meets it). FeatureChat's own controls (Pause, Resume, Reload chat, Allow,
// Deny, Send) must each be a pressable whose own style gives at least 44 px (minHeight or height). The
// fix is local to FeatureChat; the shared ui Button is not restyled globally. Payload tests above are
// unchanged. Node evidence of the declared style only; the device measurement is the QA browser's.
describe("R4.2 R42-UI-01: FeatureChat's own controls meet the 44 px target", () => {
  const heightOf = (el: El) => {
    const s = flat(typeof el.props.style === "function" ? el.props.style({ pressed: false }) : el.props.style);
    return Math.max(Number(s.minHeight ?? 0), Number(s.height ?? 0));
  };
  const target = (r: ReturnType<typeof render>, re: RegExp) => {
    const found = r.pressables.filter((e) => re.test(r.labelOf(e)));
    expect(found.length, `a pressable for ${re} (have: ${r.pressables.map(r.labelOf).join(" | ")})`).toBeGreaterThanOrEqual(1);
    return found[0];
  };

  it("Pause (running run) and Send are at least 44 px high", async () => {
    const Chat = await loadChat();
    const r = render(Chat, props());
    expect(heightOf(target(r, /^\s*Pause\b/i)), "Pause").toBeGreaterThanOrEqual(44);
    expect(heightOf(target(r, /^\s*Send\b/i)), "Send (control: already 44)").toBeGreaterThanOrEqual(44);
  });

  it("Resume (paused run) is at least 44 px high", async () => {
    const Chat = await loadChat();
    h.state.run = RUN("paused");
    const r = render(Chat, props());
    expect(heightOf(target(r, /^\s*Resume\b/i)), "Resume").toBeGreaterThanOrEqual(44);
  });

  it("Reload chat (stale timeline) is at least 44 px high", async () => {
    const Chat = await loadChat();
    h.state.timeline = { entries: ENTRIES, status: "stale" };
    const r = render(Chat, props());
    expect(heightOf(target(r, /Reload chat/i)), "Reload chat").toBeGreaterThanOrEqual(44);
  });

  it("Allow and Deny on a pending permission are at least 44 px high", async () => {
    const Chat = await loadChat();
    h.state.pending = [{ id: "perm-44", provider: "claude", name: "Bash", kind: "tool", title: "Run the checks" }];
    const r = render(Chat, props());
    expect(heightOf(target(r, /^\s*Allow\b/i)), "Allow").toBeGreaterThanOrEqual(44);
    expect(heightOf(target(r, /^\s*Deny\b/i)), "Deny").toBeGreaterThanOrEqual(44);
  });
});
