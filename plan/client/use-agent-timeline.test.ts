// Stage R4.1 (task card 2026-10-29 R4 §2): the feature chat timeline hook. Pure core:
// `mergeTimeline(prev, next)` (ordered by seq, de-duplicated) and `reduceTimelineEvent(state, event)`
// (live append, replacement, error). Hook lifecycle over a stub `paseo` from `usePaseo()`:
// subscribe FIRST → await `ready` → `refetch({ direction: "tail", projection: "canonical", limit: 200 })`
// → merge → replay the buffered events (no loss, no duplicate) → release on agent change or unmount.
//
// Installed 0.12.0 facts pinned by the RED preflight (read-only, see the report):
// - The server ignores the requested projection: `handleFetchAgentTimelineRequest` sets
//   `const projection = "projected"` (@getpaseo/server dist/server/server/session.js:5863). Refetched
//   entries are PROJECTED: consecutive assistant chunks merge into one entry whose
//   [seqStart, seqEnd] spans several stored rows, and tool calls collapse by identity
//   (agent/timeline-projection.js:88-200, 246-255). A live `agent_stream` carries the stored row's
//   `seq` (session.js:1260-1266, 3597), so a live seq may fall INSIDE a refetched entry's range,
//   not only equal its seqEnd. These tests therefore treat a live event at or below the merged
//   endCursor.seq as a duplicate (card rule) and never assume seq === seqEnd.
// - `seq`/`epoch` are optional on `agent_stream` (present only when the source event had them).
//   A no-seq event is not plugin state: it may be shown transiently and is discarded by the next merge.
//
// The hook runs under a minimal React stand-in (slot state, effects with cleanups); no DOM, no
// renderer. The module is new in R4.1, so it is loaded inside each test.
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  const state = {
    slots: [] as unknown[],
    index: 0,
    refs: [] as Array<{ current: unknown }>,
    refIndex: 0,
    effects: [] as Array<{ deps?: unknown[]; cleanup?: (() => void) | void; fn?: () => (() => void) | void; pending: boolean }>,
    effectIndex: 0,
    dirty: false,
    paseo: null as unknown,
  };
  const changed = (a?: unknown[], b?: unknown[]) => !a || !b || a.length !== b.length || a.some((x, i) => !Object.is(x, b[i]));
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
  const useReducer = (reducer: (s: unknown, a: unknown) => unknown, init: unknown, initFn?: (x: unknown) => unknown) => {
    const [s, set] = useState(() => (initFn ? initFn(init) : init)) as [unknown, (v: unknown) => void];
    return [s, (a: unknown) => set((p: unknown) => reducer(p, a))];
  };
  const useRef = (v: unknown) => {
    const i = state.refIndex++;
    if (!(i in state.refs)) state.refs[i] = { current: v };
    return state.refs[i];
  };
  const useEffect = (fn: () => (() => void) | void, deps?: unknown[]) => {
    const i = state.effectIndex++;
    const prev = state.effects[i];
    if (!prev || changed(prev.deps, deps)) state.effects[i] = { deps, cleanup: prev?.cleanup, fn, pending: true };
  };
  const useMemo = (fn: () => unknown, deps?: unknown[]) => {
    const r = useRef(undefined) as { current: unknown };
    const d = useRef(undefined) as { current: unknown };
    if (d.current === undefined || changed(d.current as unknown[], deps)) {
      r.current = fn();
      d.current = deps ?? [];
    }
    return r.current;
  };
  const useCallback = (fn: unknown, deps?: unknown[]) => useMemo(() => fn, deps);
  return { state, useState, useReducer, useRef, useEffect, useMemo, useCallback };
});

vi.mock("react", async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  const hooks = { useState: h.useState, useReducer: h.useReducer, useRef: h.useRef, useEffect: h.useEffect, useLayoutEffect: h.useEffect, useMemo: h.useMemo, useCallback: h.useCallback };
  return { ...real, ...hooks, default: { ...(real.default as object), ...hooks } };
});
vi.mock("@getpaseo/plugin/client", () => ({ usePaseo: () => h.state.paseo }));

type Entry = { provider: string; item: { type: string; text?: string }; timestamp: string; seqStart: number; seqEnd: number; turnId?: string };
const T0 = "2026-10-29T10:00:00.000Z";
const entry = (seqStart: number, seqEnd = seqStart, text = `m${seqStart}`): Entry => ({ provider: "claude", item: { type: "assistant_message", text }, timestamp: T0, seqStart, seqEnd });
const stream = (agentId: string, seq: number | undefined, epoch: string | undefined, text = `live${seq}`) => ({
  agentId,
  event: { type: "timeline", provider: "claude", item: { type: "assistant_message", text } },
  timestamp: T0,
  ...(seq !== undefined ? { seq } : {}),
  ...(epoch !== undefined ? { epoch } : {}),
});
const page = (epoch: string, entries: Entry[], extra: Record<string, unknown> = {}) => {
  const last = entries.at(-1);
  const first = entries[0];
  return {
    requestId: "r",
    agentId: "a",
    agent: null,
    direction: "tail",
    projection: "projected",
    epoch,
    reset: false,
    staleCursor: false,
    gap: false,
    window: { minSeq: first?.seqStart ?? 0, maxSeq: last?.seqEnd ?? 0, nextSeq: (last?.seqEnd ?? 0) + 1 },
    startCursor: first ? { epoch, seq: first.seqStart } : null,
    endCursor: last ? { epoch, seq: last.seqEnd } : null,
    hasOlder: false,
    hasNewer: false,
    entries,
    error: null,
    ...extra,
  };
};

/** A deferred value the test settles. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  promise.catch(() => undefined);
  return { promise, resolve, reject };
}

/** A recording stub PaseoApi: each subscribe/refetch is a deferred the test settles. */
function stubPaseo() {
  const ops: Array<{ op: string; agentId: string; args?: unknown }> = [];
  const subs: Array<{ agentId: string; handler: (e: unknown) => void; ready: ReturnType<typeof deferred<void>>; released: number }> = [];
  const refetches: Array<{ agentId: string; options: Record<string, unknown>; reply: ReturnType<typeof deferred<unknown>> }> = [];
  const paseo = {
    agents: {
      ref: (agentId: string) => ({
        id: agentId,
        timeline: {
          subscribe: (handler: (e: unknown) => void) => {
            ops.push({ op: "subscribe", agentId });
            const sub = { agentId, handler, ready: deferred<void>(), released: 0 };
            subs.push(sub);
            const release = async () => {
              sub.released += 1;
              ops.push({ op: "release", agentId });
            };
            return Object.assign(() => void release(), { ready: sub.ready.promise, subscriptionId: `sub-${subs.length}`, release });
          },
          refetch: (options: Record<string, unknown> = {}) => {
            ops.push({ op: "refetch", agentId, args: options });
            const reply = deferred<unknown>();
            refetches.push({ agentId, options, reply });
            return reply.promise;
          },
          append: async () => ({ seq: 0, epoch: "x" }),
        },
        send: async () => {
          ops.push({ op: "send", agentId });
        },
        interrupt: async () => {
          ops.push({ op: "interrupt", agentId });
        },
        cancel: async () => {
          ops.push({ op: "cancel", agentId });
        },
      }),
    },
  };
  return { paseo, ops, subs, refetches, emit: (i: number, e: unknown) => subs[i].handler(e) };
}

type Hook = (agentId: string | null) => { entries: Entry[]; status: string; error?: string; reload(): void };
// Non-literal specifier: keeps the new module (and its host client types) out of the node TypeScript
// program; Vitest resolves it at runtime.
const modulePath = "./use-agent-timeline";
const loadModule = async () => {
  const mod = (await import(/* @vite-ignore */ modulePath)) as Record<string, unknown>;
  for (const name of ["useAgentTimeline", "mergeTimeline", "reduceTimelineEvent"]) expect(typeof mod[name], `client/use-agent-timeline exports ${name}`).toBe("function");
  return mod as unknown as {
    useAgentTimeline: Hook;
    mergeTimeline: (prev: Entry[], next: Entry[]) => Entry[];
    reduceTimelineEvent: (state: { entries: Entry[]; status: string; error?: string }, event: unknown) => { entries: Entry[]; status: string; error?: string };
  };
};

const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

/** Mounts the hook under the stand-in: renders, runs changed effects (cleanup first), re-renders until stable. */
function mount(hook: Hook, initial: string | null) {
  let agentId = initial;
  let last: ReturnType<Hook> | undefined;
  const renderOnce = () => {
    h.state.index = 0;
    h.state.refIndex = 0;
    h.state.effectIndex = 0;
    h.state.dirty = false;
    last = hook(agentId);
    for (const e of h.state.effects) {
      if (!e.pending) continue;
      e.pending = false;
      if (typeof e.cleanup === "function") e.cleanup();
      e.cleanup = e.fn?.();
    }
  };
  const settle = async () => {
    for (let pass = 0; pass < 30; pass++) {
      await flush();
      renderOnce();
      if (!h.state.dirty) {
        await flush();
        if (!h.state.dirty) return;
      }
    }
  };
  renderOnce();
  return {
    get value() {
      return last!;
    },
    settle,
    async setAgent(next: string | null) {
      agentId = next;
      renderOnce();
      await settle();
    },
    unmount() {
      for (const e of h.state.effects) if (typeof e.cleanup === "function") e.cleanup();
      h.state.effects = [];
    },
  };
}

beforeEach(() => {
  h.state.slots = [];
  h.state.refs = [];
  h.state.effects = [];
  h.state.paseo = null;
});

describe("R4.1 mergeTimeline", () => {
  it("orders by seq and de-duplicates by seq; a newer entry for the same seq replaces the older one", async () => {
    const { mergeTimeline } = await loadModule();
    const out = mergeTimeline([entry(3), entry(1), entry(2, 2, "old")], [entry(2, 2, "new"), entry(4)]);
    expect(out.map((e) => e.seqStart)).toEqual([1, 2, 3, 4]);
    expect(out.find((e) => e.seqStart === 2)!.item.text).toBe("new");
  });

  it("a projected entry spanning a range replaces the single-seq entries it covers (installed projection merges chunks)", async () => {
    const { mergeTimeline } = await loadModule();
    const out = mergeTimeline([entry(5), entry(6), entry(7), entry(9)], [entry(5, 7, "merged")]);
    expect(out.map((e) => [e.seqStart, e.seqEnd])).toEqual([[5, 7], [9, 9]]);
    expect(out[0].item.text).toBe("merged");
  });

  it("is pure: the inputs are not mutated", async () => {
    const { mergeTimeline } = await loadModule();
    const prev = [entry(1)];
    const next = [entry(2)];
    const snap = JSON.stringify([prev, next]);
    mergeTimeline(prev, next);
    expect(JSON.stringify([prev, next])).toBe(snap);
  });
});

describe("R4.1 reduceTimelineEvent", () => {
  const live = (entries: Entry[]) => ({ entries, status: "live" });

  it("appends a live agent_stream timeline event after the last seq and drops one at or below it", async () => {
    const { reduceTimelineEvent } = await loadModule();
    const s1 = reduceTimelineEvent(live([entry(1), entry(2)]), stream("a", 3, "e1"));
    expect(s1.entries.map((e) => e.seqEnd)).toEqual([1, 2, 3]);
    const dup = reduceTimelineEvent(s1, stream("a", 2, "e1", "again"));
    expect(dup.entries.map((e) => e.seqEnd)).toEqual([1, 2, 3]);
    expect(dup.entries[1].item.text).toBe("m2");
  });

  it("a live seq inside a projected entry's range is a duplicate (no seq === seqEnd assumption)", async () => {
    const { reduceTimelineEvent } = await loadModule();
    const s = reduceTimelineEvent(live([entry(5, 7, "merged")]), stream("a", 6, "e1"));
    expect(s.entries.map((e) => [e.seqStart, e.seqEnd])).toEqual([[5, 7]]);
  });

  it("an agent_stream without seq is never authoritative: seq-ordered entries stay, and the next merge leaves only seq entries", async () => {
    const { reduceTimelineEvent, mergeTimeline } = await loadModule();
    const s = reduceTimelineEvent(live([entry(1), entry(2)]), stream("a", undefined, undefined, "no-seq"));
    const seqd = s.entries.filter((e) => typeof e.seqStart === "number");
    expect(seqd.map((e) => e.seqStart)).toEqual([1, 2]);
    expect(s.status).toBe("live");
    const merged = mergeTimeline(s.entries, [entry(3)]);
    expect(merged.every((e) => typeof e.seqStart === "number" && typeof e.seqEnd === "number")).toBe(true);
  });

  it("replacement drops the old epoch's entries; error marks the timeline stale with the message", async () => {
    const { reduceTimelineEvent } = await loadModule();
    const r = reduceTimelineEvent(live([entry(1), entry(2)]), { agentId: "a", event: { type: "replacement", epoch: "e2" } });
    expect(r.entries).toEqual([]);
    const e = reduceTimelineEvent(live([entry(1)]), { agentId: "a", event: { type: "error", error: "observation lost" } });
    expect(e.status).toBe("stale");
    expect(e.error).toContain("observation lost");
  });

  it("an unknown event shape leaves the state unchanged", async () => {
    const { reduceTimelineEvent } = await loadModule();
    const s = live([entry(1)]);
    expect(reduceTimelineEvent(s, { agentId: "a", event: { type: "agent_status" } })).toEqual(s);
    expect(reduceTimelineEvent(s, null)).toEqual(s);
  });
});

describe("R4.1 useAgentTimeline lifecycle (stub paseo)", () => {
  it("subscribes first, awaits ready, then refetches the canonical tail (limit 200); an event between subscribe and the reply is neither lost nor duplicated", async () => {
    const { useAgentTimeline } = await loadModule();
    const p = stubPaseo();
    h.state.paseo = p.paseo;
    const m = mount(useAgentTimeline, "agent-1");
    await m.settle();
    expect(p.ops.map((o) => o.op), "nothing before ready but subscribe").toEqual(["subscribe"]);
    expect(m.value.status).toBe("loading");
    p.emit(0, stream("agent-1", 11, "e1")); // inside the history window → duplicate after merge
    p.emit(0, stream("agent-1", 20, "e0")); // an old epoch → dropped at replay
    p.subs[0].ready.resolve();
    await m.settle();
    expect(p.ops.map((o) => o.op)).toEqual(["subscribe", "refetch"]);
    expect(p.refetches[0].options).toMatchObject({ direction: "tail", projection: "canonical", limit: 200 });
    p.emit(0, stream("agent-1", 12, "e1")); // after the window, before the reply → replayed
    p.refetches[0].reply.resolve(page("e1", [entry(9), entry(10), entry(11)]));
    await m.settle();
    expect(m.value.status).toBe("live");
    expect(m.value.entries.map((e) => e.seqEnd)).toEqual([9, 10, 11, 12]);
    p.emit(0, stream("agent-1", 13, "e1"));
    await m.settle();
    expect(m.value.entries.map((e) => e.seqEnd)).toEqual([9, 10, 11, 12, 13]);
  });

  it("subscription_restored refetches after the last cursor and merges; a reset/staleCursor/gap reply refetches the tail", async () => {
    const { useAgentTimeline } = await loadModule();
    const p = stubPaseo();
    h.state.paseo = p.paseo;
    const m = mount(useAgentTimeline, "agent-1");
    p.subs[0].ready.resolve();
    await m.settle();
    p.refetches[0].reply.resolve(page("e1", [entry(1), entry(2)]));
    await m.settle();
    p.emit(0, { agentId: "agent-1", subscriptionId: "sub-1", event: { type: "subscription_restored" } });
    await m.settle();
    const after = p.refetches[1];
    expect(after.options).toMatchObject({ direction: "after", projection: "canonical", cursor: { epoch: "e1" } });
    expect((after.options.cursor as { seq: number }).seq).toBeGreaterThanOrEqual(2);
    after.reply.resolve(page("e1", [entry(3)]));
    await m.settle();
    expect(m.value.entries.map((e) => e.seqEnd)).toEqual([1, 2, 3]);
    for (const flag of ["reset", "staleCursor", "gap"] as const) {
      const n = p.refetches.length;
      p.emit(0, { agentId: "agent-1", subscriptionId: "sub-1", event: { type: "subscription_restored" } });
      await m.settle();
      p.refetches[n].reply.resolve(page("e1", [], { [flag]: true }));
      await m.settle();
      expect(p.refetches[n + 1]?.options, flag).toMatchObject({ direction: "tail", projection: "canonical" });
      p.refetches[n + 1].reply.resolve(page("e1", [entry(1), entry(2), entry(3)]));
      await m.settle();
      expect(m.value.entries.map((e) => e.seqEnd), flag).toEqual([1, 2, 3]);
    }
  });

  it("replacement drops the old epoch and refetches the tail; a late old-epoch event is not merged", async () => {
    const { useAgentTimeline } = await loadModule();
    const p = stubPaseo();
    h.state.paseo = p.paseo;
    const m = mount(useAgentTimeline, "agent-1");
    p.subs[0].ready.resolve();
    await m.settle();
    p.refetches[0].reply.resolve(page("e1", [entry(1), entry(2)]));
    await m.settle();
    p.emit(0, { agentId: "agent-1", event: { type: "replacement", epoch: "e2" } });
    await m.settle();
    expect(p.refetches[1].options).toMatchObject({ direction: "tail", projection: "canonical" });
    p.refetches[1].reply.resolve(page("e2", [entry(1, 1, "fresh")]));
    await m.settle();
    p.emit(0, stream("agent-1", 5, "e1"));
    await m.settle();
    expect(m.value.entries.map((e) => [e.seqEnd, e.item.text])).toEqual([[1, "fresh"]]);
  });

  it("error marks stale, releases the observation locally and reload() subscribes again", async () => {
    const { useAgentTimeline } = await loadModule();
    const p = stubPaseo();
    h.state.paseo = p.paseo;
    const m = mount(useAgentTimeline, "agent-1");
    p.subs[0].ready.resolve();
    await m.settle();
    p.refetches[0].reply.resolve(page("e1", [entry(1)]));
    await m.settle();
    p.emit(0, { agentId: "agent-1", event: { type: "error", error: "observation lost" } });
    await m.settle();
    expect(m.value.status).toBe("stale");
    expect(p.subs[0].released).toBeGreaterThanOrEqual(1);
    m.value.reload();
    await m.settle();
    expect(p.subs).toHaveLength(2);
    expect(p.ops.filter((o) => o.op === "subscribe")).toHaveLength(2);
  });

  it("a rejected ready sets status error and never refetches", async () => {
    const { useAgentTimeline } = await loadModule();
    const p = stubPaseo();
    h.state.paseo = p.paseo;
    const m = mount(useAgentTimeline, "agent-1");
    p.subs[0].ready.reject(new Error("establishment failed"));
    await m.settle();
    expect(m.value.status).toBe("error");
    expect(p.refetches).toHaveLength(0);
  });

  it("a null agentId (or no SDK) yields empty entries and makes no SDK call", async () => {
    const { useAgentTimeline } = await loadModule();
    const p = stubPaseo();
    h.state.paseo = p.paseo;
    const m = mount(useAgentTimeline, null);
    await m.settle();
    expect(m.value.entries).toEqual([]);
    expect(p.ops).toEqual([]);
    h.state.slots = [];
    h.state.refs = [];
    h.state.effects = [];
    h.state.paseo = null;
    const n = mount(useAgentTimeline, "agent-1");
    await n.settle();
    expect(n.value.entries).toEqual([]);
  });

  it("an agent change releases the old subscription and ignores the old agent's late refetch; unmount releases", async () => {
    const { useAgentTimeline } = await loadModule();
    const p = stubPaseo();
    h.state.paseo = p.paseo;
    const m = mount(useAgentTimeline, "agent-1");
    p.subs[0].ready.resolve();
    await m.settle();
    expect(p.refetches).toHaveLength(1);
    await m.setAgent("agent-2");
    expect(p.subs[0].released).toBeGreaterThanOrEqual(1);
    expect(p.subs[1].agentId).toBe("agent-2");
    p.subs[1].ready.resolve();
    await m.settle();
    p.refetches[1].reply.resolve(page("f1", [entry(1, 1, "agent-2 history")]));
    await m.settle();
    p.refetches[0].reply.resolve(page("e1", [entry(1, 1, "agent-1 late"), entry(2, 2, "agent-1 late")]));
    await m.settle();
    expect(m.value.entries.map((e) => e.item.text)).toEqual(["agent-2 history"]);
    m.unmount();
    await flush();
    expect(p.subs[1].released).toBeGreaterThanOrEqual(1);
    expect(p.ops.some((o) => o.op === "interrupt" || o.op === "cancel" || o.op === "send"), "the hook never drives the agent").toBe(false);
  });
});

// R4.1 verification (T): installed 0.12.0 pages `direction: "after"` with `limit` (an omitted limit
// defaults to 0 = everything after the cursor: session.js handleFetchAgentTimelineRequest
// `requestedLimit ?? (direction === "after" ? 0 : 200)`, timeline-projection.js:360 `limit === 0 ?
// eligible : …`). A bounded after-page with `hasNewer` must not be followed by live replay as if the
// history were complete: either the restored refetch requests the whole remainder (no limit) or it
// continues from the page's endCursor while `hasNewer`.
describe("R4.1 verification: restored refetch leaves no silent gap", () => {
  it("a bounded after-page with hasNewer continues after its endCursor before live events are applied", async () => {
    const { useAgentTimeline } = await loadModule();
    const p = stubPaseo();
    h.state.paseo = p.paseo;
    const m = mount(useAgentTimeline, "agent-1");
    p.subs[0].ready.resolve();
    await m.settle();
    p.refetches[0].reply.resolve(page("e1", [entry(1), entry(2)]));
    await m.settle();
    p.emit(0, { agentId: "agent-1", subscriptionId: "sub-1", event: { type: "subscription_restored" } });
    await m.settle();
    const after = p.refetches[1];
    expect(after.options).toMatchObject({ direction: "after", cursor: { epoch: "e1" } });
    // R4 final KensAI c0013: the continuation is asserted unconditionally (the implementation requests the whole
    // remainder and still follows any page that reports hasNewer).
    p.emit(0, stream("agent-1", 500, "e1")); // live, far past the bounded page
    after.reply.resolve(page("e1", [entry(3)], { hasNewer: true }));
    await m.settle();
    const next = p.refetches[2];
    expect(next?.options, "a further after-page is requested while hasNewer").toMatchObject({ direction: "after", cursor: { epoch: "e1", seq: 3 } });
    expect(m.value.entries.map((e) => e.seqEnd), "no live row past the unfetched history yet").not.toContain(500);
  });
});

// R4 successor KensAI c0044: a rejected refetch must not leave the hook buffering forever. While the
// history is not recovered, ordinary live events never render (no silent gap); a subscription_restored
// event still drives recovery (the tail when no history is known, else the after page from the last good
// cursor), and replacement and error control events are still handled.
describe("R4 successor c0044: recovery after a rejected refetch", () => {
  it("initial tail rejected: no live row before history; subscription_restored refetches the tail and recovery applies it", async () => {
    const { useAgentTimeline } = await loadModule();
    const p = stubPaseo();
    h.state.paseo = p.paseo;
    const m = mount(useAgentTimeline, "agent-1");
    p.subs[0].ready.resolve();
    await m.settle();
    p.refetches[0].reply.reject(new Error("tail failed"));
    await m.settle();
    expect(m.value.status).toBe("error");
    p.emit(0, stream("agent-1", 9, "e1"));
    await m.settle();
    expect(m.value.entries, "no live row over an unloaded history").toEqual([]);
    p.emit(0, { agentId: "agent-1", subscriptionId: "sub-1", event: { type: "subscription_restored" } });
    await m.settle();
    const next = p.refetches[1];
    expect(next, "subscription_restored drives a new tail refetch").toBeDefined();
    expect(next.options).not.toHaveProperty("cursor");
    next.reply.resolve(page("e1", [entry(1), entry(2)]));
    await m.settle();
    expect(m.value.status).toBe("live");
    expect(m.value.entries.map((e) => e.seqEnd)).toEqual([1, 2]);
  });

  it("after-page rejected: no live row past the last good history; subscription_restored continues after the last good cursor", async () => {
    const { useAgentTimeline } = await loadModule();
    const p = stubPaseo();
    h.state.paseo = p.paseo;
    const m = mount(useAgentTimeline, "agent-1");
    p.subs[0].ready.resolve();
    await m.settle();
    p.refetches[0].reply.resolve(page("e1", [entry(1), entry(2)]));
    await m.settle();
    p.emit(0, { agentId: "agent-1", subscriptionId: "sub-1", event: { type: "subscription_restored" } });
    await m.settle();
    p.refetches[1].reply.reject(new Error("after failed"));
    await m.settle();
    p.emit(0, stream("agent-1", 500, "e1"));
    await m.settle();
    expect(m.value.entries.map((e) => e.seqEnd), "no live row past unfetched history").not.toContain(500);
    p.emit(0, { agentId: "agent-1", subscriptionId: "sub-1", event: { type: "subscription_restored" } });
    await m.settle();
    const next = p.refetches[2];
    expect(next, "subscription_restored drives a new after page").toBeDefined();
    expect(next.options).toMatchObject({ direction: "after", cursor: { epoch: "e1", seq: 2 } });
  });

  it("control events after a rejected refetch: replacement refetches the tail; error releases the subscription", async () => {
    const { useAgentTimeline } = await loadModule();
    const p = stubPaseo();
    h.state.paseo = p.paseo;
    const m = mount(useAgentTimeline, "agent-1");
    p.subs[0].ready.resolve();
    await m.settle();
    p.refetches[0].reply.reject(new Error("tail failed"));
    await m.settle();
    p.emit(0, { agentId: "agent-1", event: { type: "replacement", epoch: "e2" } });
    await m.settle();
    expect(p.refetches[1], "replacement refetches the tail").toBeDefined();
    p.refetches[1].reply.reject(new Error("tail failed again"));
    await m.settle();
    p.emit(0, { agentId: "agent-1", event: { type: "error", error: "observation lost" } });
    await m.settle();
    expect(p.subs[0].released, "error releases the subscription").toBeGreaterThanOrEqual(1);
  });
});
