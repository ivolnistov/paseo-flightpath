// useLiveRevision against a `useSubscription` that follows the 0.16 SDK hook: state starts
// "connecting" (a new object on each subscribe), becomes the shared LIVE object when the daemon
// acknowledges, the shared CLOSED object when the handler finishes, or a new "error" object; a new
// contract object or input re-subscribes and releases the previous one. The transport is a fake;
// the version query and its 3 s poll come from the real useRoadmapVersion with useQuery recorded.
//
// Node harness: React hooks are a slot-based implementation with persistent refs, dependency-keyed
// memos and effects with cleanup, so retries and unmount behave as in React.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Sub = {
  contract: { name: string };
  input: unknown;
  released: boolean;
  emit(event: unknown): void;
  ack(): void;
  refuse(e: Error): void;
  close(e?: Error): void;
};

/** One hook's state in the node harness, by kind. */
type HarnessSlot =
  | { kind: "state"; value: unknown }
  | { kind: "ref"; ref: { current: unknown } }
  | { kind: "memo"; value: unknown; deps: unknown[] | undefined }
  | { kind: "effect"; deps: unknown[] | undefined; cleanup: unknown; fresh: boolean };

const h = vi.hoisted(() => {
  const state = {
    slots: [] as HarnessSlot[],
    index: 0,
    dirty: false,
    effects: [] as Array<() => void>,
    subs: [] as Sub[],
    invalidations: [] as unknown[],
    cache: new Map<string, unknown>(),
    queries: [] as Array<Record<string, unknown>>,
    subscriptionThrows: false,
  };
  const sameDeps = (a: unknown[] | undefined, b: unknown[] | undefined) => a !== undefined && b !== undefined && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  const call = (fn: unknown, ...args: unknown[]): unknown => {
    if (typeof fn !== "function") return fn;
    const out: unknown = Reflect.apply(fn, undefined, args);
    return out;
  };
  const next = <K extends HarnessSlot["kind"]>(kind: K): HarnessSlot | undefined => {
    const i = state.index++;
    const found = state.slots[i];
    if (found !== undefined && found.kind !== kind) throw new Error(`hook order changed at ${i}`);
    return found;
  };
  const put = (slot: HarnessSlot) => {
    state.slots[state.index - 1] = slot;
  };
  const react = {
    useState(init: unknown): [unknown, (value: unknown) => void] {
      let s = next("state");
      if (s?.kind !== "state") {
        s = { kind: "state", value: typeof init === "function" ? call(init) : init };
        put(s);
      }
      const slot = s;
      const set = (value: unknown) => {
        const v = typeof value === "function" ? call(value, slot.value) : value;
        if (!Object.is(v, slot.value)) {
          slot.value = v;
          state.dirty = true;
        }
      };
      return [slot.value, set];
    },
    useRef(init: unknown): { current: unknown } {
      let s = next("ref");
      if (s?.kind !== "ref") {
        s = { kind: "ref", ref: { current: init } };
        put(s);
      }
      return s.ref;
    },
    useMemo(fn: () => unknown, deps?: unknown[]): unknown {
      let s = next("memo");
      if (s?.kind !== "memo" || !sameDeps(s.deps, deps)) {
        s = { kind: "memo", value: fn(), deps };
        put(s);
      }
      return s.value;
    },
    useCallback(fn: unknown, deps?: unknown[]): unknown {
      return react.useMemo(() => fn, deps);
    },
    useEffect(fn: () => unknown, deps?: unknown[]): void {
      let s = next("effect");
      if (s?.kind !== "effect") {
        s = { kind: "effect", deps: undefined, cleanup: undefined, fresh: true };
        put(s);
      }
      const slot = s;
      if (slot.fresh || !sameDeps(slot.deps, deps)) {
        state.effects.push(() => {
          if (typeof slot.cleanup === "function") call(slot.cleanup);
          slot.deps = deps;
          slot.fresh = false;
          slot.cleanup = fn();
        });
      }
    },
  };

  const LIVE = { status: "live" };
  const CLOSED = { status: "closed" };
  const shallowEqual = (a: Record<string, unknown>, b: Record<string, unknown>) => {
    const ka = Object.keys(a);
    return ka.length === Object.keys(b).length && ka.every((k) => Object.is(a[k], b[k]));
  };
  /** The 0.16 SDK hook's behaviour, over a fake transport. */
  function useSubscription(contract: { name: string; input: { parse(v: unknown): unknown } }, input: { projectId: string }, onEvent: (e: unknown) => void) {
    if (state.subscriptionThrows) throw new Error("useSubscription must run inside a contributed plugin surface");
    const onEventRef = react.useRef(onEvent);
    onEventRef.current = onEvent;
    const stableRef = react.useRef(input);
    const kept = stableRef.current;
    if (typeof kept !== "object" || kept === null || !shallowEqual({ ...kept }, input)) stableRef.current = input;
    const stable = stableRef.current;
    const [st, setState] = react.useState({ status: "connecting" });
    react.useEffect(() => {
      let active = true;
      setState({ status: "connecting" });
      contract.input.parse(stable);
      let ready!: () => void;
      let refused!: (e: Error) => void;
      const readyP = new Promise<void>((res, rej) => ((ready = res), (refused = rej)));
      let closed = false;
      const sub: Sub = {
        contract,
        input: stable,
        released: false,
        emit: (event) => {
          if (!sub.released && !closed) call(onEventRef.current, event);
        },
        ack: () => ready(),
        refuse: (e) => refused(e),
        close: (e) => {
          if (closed || sub.released) return;
          closed = true;
          if (active) setState(e ? { status: "error", error: e } : CLOSED);
        },
      };
      state.subs.push(sub);
      readyP.then(
        () => active && setState((c: { status: string }) => (c.status === "connecting" ? LIVE : c)),
        (e: Error) => active && setState({ status: "error", error: e }),
      );
      return () => {
        active = false;
        sub.released = true;
      };
    }, [contract, stable]);
    return st;
  }
  const client = {
    getQueryData: (key: unknown[]) => state.cache.get(JSON.stringify(key)),
    getQueriesData: () => [],
    invalidateQueries: async (opts: unknown) => void state.invalidations.push(opts),
  };
  return { state, react, useSubscription, client };
});

vi.mock("react", async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  const original: unknown = real.default;
  return { ...real, ...h.react, default: { ...(typeof original === "object" && original !== null ? original : {}), ...h.react } };
});
vi.mock("@getpaseo/plugin/client/react-native", () => ({ useToast: () => ({ show: () => undefined, error: () => undefined }) }));
vi.mock("@getpaseo/plugin/client", () => ({
  useRpc: () => async () => ({ ok: true, value: {} }),
  useWorkspace: () => null,
  usePaseo: () => ({}),
  useSubscription: h.useSubscription,
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: (opts: Record<string, unknown>) => {
    h.state.queries.push(opts);
    return { data: h.state.cache.get(JSON.stringify(opts.queryKey)), isError: false };
  },
  // The provider's client: one object for the life of the app, as react-query's useQueryClient returns.
  useQueryClient: () => h.client,
}));

/** The hooks under test, checked at run time: a variable-path import keeps the client module out of the node type check. */
interface HooksModule {
  useRoadmapVersion(hostId: string, projectId: string): unknown;
  useLiveRevision(hostId: string, projectId: string): string;
  liveRetryDelay(failures: number): number;
}
const isHooksModule = (m: unknown): m is HooksModule =>
  typeof m === "object" && m !== null && ["useRoadmapVersion", "useLiveRevision", "liveRetryDelay"].every((k) => typeof Reflect.get(m, k) === "function");
const modulePath = "./hooks";
async function load(): Promise<HooksModule> {
  const mod: unknown = await import(/* @vite-ignore */ modulePath);
  if (!isHooksModule(mod)) throw new Error("client/hooks does not export the expected API");
  return mod;
}

function mount<P, R>(hook: (props: P) => R, initial: NoInfer<P>) {
  const slots: HarnessSlot[] = [];
  let props = initial;
  let out!: R;
  let mounted = true;
  const render = (next?: P): R => {
    if (!mounted) return out;
    if (next !== undefined) props = next;
    h.state.slots = slots;
    for (let pass = 0; pass < 30; pass++) {
      h.state.index = 0;
      h.state.dirty = false;
      h.state.effects = [];
      out = hook(props);
      for (const fn of h.state.effects) fn();
      if (!h.state.dirty) return out;
    }
    throw new Error("did not settle");
  };
  render();
  return {
    render,
    current: () => out,
    /** Lets promise callbacks run, then renders whatever state they set. */
    async settle() {
      for (let i = 0; i < 3; i++) {
        await Promise.resolve();
        await new Promise((r) => setImmediate(r));
        render();
      }
      return out;
    },
    unmount() {
      mounted = false;
      for (const e of slots) if (e.kind === "effect" && typeof e.cleanup === "function") Reflect.apply(e.cleanup, undefined, []);
    },
  };
}

const HOST = "host-1";
const P = "prj_a";
const versionKey = (host: string, project: string) => ["decision-roadmap", host, project, "version"];
const versionInvalidation = (host: string, project: string) => ({ queryKey: versionKey(host, project), exact: true });
const event = (projectId: string, revision: number | null, status: "ok" | "missing" | "invalid" = "ok") => ({
  exists: status !== "missing",
  status,
  revision,
  schemaVersion: status === "ok" ? 2 : null,
  projectId,
});
const cacheVersion = (host: string, project: string, status: string, revision: number | null) =>
  h.state.cache.set(JSON.stringify(versionKey(host, project)), { exists: true, status, revision, schemaVersion: 2 });
const open = () => h.state.subs.filter((s) => !s.released);
const useBoth = (m: HooksModule) => (p: { hostId: string; projectId: string }) => {
  m.useRoadmapVersion(p.hostId, p.projectId);
  return m.useLiveRevision(p.hostId, p.projectId);
};

beforeEach(() => {
  h.state.subs = [];
  h.state.invalidations = [];
  h.state.cache = new Map();
  h.state.queries = [];
  h.state.subscriptionThrows = false;
});
afterEach(() => {
  vi.useRealTimers();
});

describe("useLiveRevision: subscription and re-reads", () => {
  it("subscribes to roadmap.revision.watch for the project and re-reads the version when it becomes live", async () => {
    const m = await load();
    const view = mount(useBoth(m), { hostId: HOST, projectId: P });
    expect(view.current()).toBe("connecting");
    expect(open()).toHaveLength(1);
    expect(open()[0].contract.name).toBe("roadmap.revision.watch");
    expect(open()[0].input).toEqual({ projectId: P });
    expect(h.state.invalidations).toEqual([]);
    open()[0].ack();
    expect(await view.settle()).toBe("live");
    expect(h.state.invalidations).toEqual([versionInvalidation(HOST, P)]);
  });

  it("an event with new facts re-reads the version; facts equal to the cached version do not", async () => {
    const m = await load();
    cacheVersion(HOST, P, "ok", 4);
    const view = mount(useBoth(m), { hostId: HOST, projectId: P });
    open()[0].ack();
    await view.settle();
    h.state.invalidations = [];
    open()[0].emit(event(P, 4));
    expect(h.state.invalidations).toEqual([]);
    open()[0].emit(event(P, 5));
    expect(h.state.invalidations).toEqual([versionInvalidation(HOST, P)]);
    open()[0].emit(event(P, 4, "invalid"));
    expect(h.state.invalidations).toHaveLength(2);
    open()[0].emit(event(P, null, "missing"));
    expect(h.state.invalidations).toHaveLength(3);
  });

  it("an event naming another project is ignored", async () => {
    const m = await load();
    const view = mount(useBoth(m), { hostId: HOST, projectId: P });
    open()[0].ack();
    await view.settle();
    h.state.invalidations = [];
    open()[0].emit(event("prj_other", 9));
    expect(h.state.invalidations).toEqual([]);
  });

  it("re-reads only the version query of its own host and project (the version comparison re-reads the rest)", async () => {
    const m = await load();
    const view = mount(useBoth(m), { hostId: HOST, projectId: P });
    open()[0].ack();
    await view.settle();
    open()[0].emit(event(P, 2));
    for (const inv of h.state.invalidations) expect(inv).toEqual(versionInvalidation(HOST, P));
  });
});

describe("useLiveRevision: failure, retry and reconnection", () => {
  it("an error is retried after 1 s with a fresh subscription, which re-reads when live again", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const m = await load();
    const view = mount(useBoth(m), { hostId: HOST, projectId: P });
    const first = open()[0];
    first.ack();
    await view.settle();
    first.close(new Error("plugin stopped"));
    expect(await view.settle()).toBe("retrying");
    expect(h.state.subs).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(999);
    view.render();
    expect(h.state.subs).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    view.render();
    expect(h.state.subs).toHaveLength(2);
    expect(first.released).toBe(true);
    expect(h.state.subs[1].contract).not.toBe(first.contract);
    expect(h.state.subs[1].contract.name).toBe(first.contract.name);
    h.state.invalidations = [];
    h.state.subs[1].ack();
    expect(await view.settle()).toBe("live");
    // Events are not replayed: re-establishment always re-reads.
    expect(h.state.invalidations).toEqual([versionInvalidation(HOST, P)]);
  });

  it("a closed subscription (handler finished) is retried too", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const m = await load();
    const view = mount(useBoth(m), { hostId: HOST, projectId: P });
    open()[0].ack();
    await view.settle();
    open()[0].close();
    expect(await view.settle()).toBe("retrying");
    await vi.advanceTimersByTimeAsync(1000);
    view.render();
    expect(open()).toHaveLength(1);
    expect(h.state.subs).toHaveLength(2);
  });

  it("repeated failures back off 1, 2, 4, 8, 16, 30, 30 s; a live subscription resets the delay", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const m = await load();
    const view = mount(useBoth(m), { hostId: HOST, projectId: P });
    const delays: number[] = [];
    for (let i = 0; i < 7; i++) {
      const sub = h.state.subs.at(-1)!;
      sub.refuse(new Error("Unknown subscription: roadmap.revision.watch"));
      expect(await view.settle()).toBe("retrying");
      const count = h.state.subs.length;
      let waited = 0;
      while (h.state.subs.length === count) {
        await vi.advanceTimersByTimeAsync(500);
        view.render();
        waited += 500;
        if (waited > 60_000) throw new Error("no retry");
      }
      delays.push(waited);
    }
    expect(delays).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000]);
    h.state.subs.at(-1)!.ack();
    expect(await view.settle()).toBe("live");
    h.state.subs.at(-1)!.close(new Error("again"));
    await view.settle();
    const count = h.state.subs.length;
    await vi.advanceTimersByTimeAsync(1000);
    view.render();
    expect(h.state.subs.length).toBe(count + 1);
  });

  it("the version poll stays on while live, connecting and retrying", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const m = await load();
    const view = mount(useBoth(m), { hostId: HOST, projectId: P });
    const polls = () => h.state.queries.filter((q) => JSON.stringify(q.queryKey) === JSON.stringify(versionKey(HOST, P)));
    expect(polls().at(-1)?.refetchInterval).toBe(3000);
    open()[0].ack();
    await view.settle();
    expect(polls().at(-1)?.refetchInterval).toBe(3000);
    open()[0].close(new Error("x"));
    await view.settle();
    expect(view.current()).toBe("retrying");
    expect(polls().at(-1)?.refetchInterval).toBe(3000);
  });

  it("the delay function caps at 30 s", async () => {
    const m = await load();
    expect([0, 1, 2, 3, 4, 5, 6, 20].map((n) => m.liveRetryDelay(n))).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);
  });
});

describe("useLiveRevision: project switch and unmount", () => {
  it("a project switch releases the old subscription, subscribes for the new project and re-reads only its version", async () => {
    const m = await load();
    const view = mount(useBoth(m), { hostId: HOST, projectId: P });
    const old = open()[0];
    old.ack();
    await view.settle();
    view.render({ hostId: HOST, projectId: "prj_b" });
    expect(old.released).toBe(true);
    expect(open()).toHaveLength(1);
    expect(open()[0].input).toEqual({ projectId: "prj_b" });
    h.state.invalidations = [];
    open()[0].ack();
    await view.settle();
    expect(h.state.invalidations).toEqual([versionInvalidation(HOST, "prj_b")]);
    h.state.invalidations = [];
    // A late event of the previous project on the new subscription is not this project's.
    open()[0].emit(event(P, 99));
    expect(h.state.invalidations).toEqual([]);
    // Released subscriptions deliver nothing.
    old.emit(event(P, 100));
    expect(h.state.invalidations).toEqual([]);
  });

  it("a host switch re-subscribes and re-reads under the new host's key", async () => {
    const m = await load();
    const view = mount(useBoth(m), { hostId: HOST, projectId: P });
    open()[0].ack();
    await view.settle();
    const before = h.state.subs.length;
    view.render({ hostId: "host-2", projectId: P });
    expect(h.state.subs.length).toBe(before + 1);
    h.state.invalidations = [];
    open()[0].ack();
    await view.settle();
    expect(h.state.invalidations.every((i) => JSON.stringify(i) === JSON.stringify(versionInvalidation("host-2", P)))).toBe(true);
    expect(h.state.invalidations.length).toBeGreaterThan(0);
  });

  it("unmount releases the subscription and cancels a pending retry", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const m = await load();
    const view = mount(useBoth(m), { hostId: HOST, projectId: P });
    open()[0].ack();
    await view.settle();
    open()[0].close(new Error("x"));
    await view.settle();
    const count = h.state.subs.length;
    view.unmount();
    expect(open()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.state.subs.length).toBe(count);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("unmount while live releases the subscription", async () => {
    const m = await load();
    const view = mount(useBoth(m), { hostId: HOST, projectId: P });
    open()[0].ack();
    await view.settle();
    view.unmount();
    expect(open()).toHaveLength(0);
  });
});

describe("useLiveRevision: hosts without subscriptions", () => {
  it("a surface without the RPC context (the hook throws) is unsupported and keeps polling", async () => {
    h.state.subscriptionThrows = true;
    const m = await load();
    const view = mount(useBoth(m), { hostId: HOST, projectId: P });
    expect(view.current()).toBe("unsupported");
    expect(h.state.invalidations).toEqual([]);
    expect(h.state.queries.at(-1)?.refetchInterval).toBe(3000);
  });

  it("a 0.15 SDK (no useSubscription export) is unsupported, subscribes nothing and keeps polling", async () => {
    vi.resetModules();
    vi.doMock("@getpaseo/plugin/client", () => ({
      useRpc: () => async () => ({ ok: true, value: {} }),
      useWorkspace: () => null,
      usePaseo: () => ({}),
    }));
    try {
      const m = await load();
      const view = mount(useBoth(m), { hostId: HOST, projectId: P });
      expect(view.current()).toBe("unsupported");
      expect(h.state.subs).toEqual([]);
      expect(h.state.invalidations).toEqual([]);
      expect(h.state.queries.at(-1)?.refetchInterval).toBe(3000);
    } finally {
      vi.doUnmock("@getpaseo/plugin/client");
      vi.resetModules();
    }
  });
});
