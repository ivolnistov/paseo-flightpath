// Live agent timeline for the feature chat (Stage R4.1). Order (card §2): subscribe FIRST, await
// `ready`, refetch the tail, merge, replay the events buffered meanwhile, release on agent change or
// unmount. The installed 0.12.0 server answers with PROJECTED entries (consecutive assistant chunks
// and tool-call updates merged into one entry spanning [seqStart, seqEnd]), so merges are
// range-authoritative and a live `seq` is never assumed to equal an entry's `seqEnd`.
import type { PaseoAgentTimelineEvent, PaseoAgentTimelineHandle, PaseoAgentTimelineRefetchOptions } from "@getpaseo/client";
import { usePaseo } from "@getpaseo/plugin/client";
import { useCallback, useEffect, useState } from "react";

type FetchPayload = Awaited<ReturnType<PaseoAgentTimelineHandle["refetch"]>>;
type FetchEntry = FetchPayload["entries"][number];
type Cursor = NonNullable<FetchPayload["endCursor"]>;

/** One timeline row: a fetched (projected) entry or a live event with its stored `seq`. */
export type TimelineEntry = Pick<FetchEntry, "provider" | "item" | "timestamp" | "seqStart" | "seqEnd"> & { turnId?: string };
/** A live event without `seq`: shown until the next merge, never ordered among the seq entries. */
export type TransientEntry = Pick<FetchEntry, "provider" | "item" | "timestamp"> & { turnId?: string };

export type TimelineState = {
  entries: TimelineEntry[];
  status: "idle" | "loading" | "live" | "stale" | "error";
  error?: string;
  transient?: TransientEntry[];
};

const IDLE: TimelineState = { entries: [], status: "idle" };
const TAIL: PaseoAgentTimelineRefetchOptions = { direction: "tail", projection: "canonical", limit: 200 };

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const hasSeq = (e: { seqStart?: unknown; seqEnd?: unknown }): e is TimelineEntry => typeof e.seqStart === "number" && typeof e.seqEnd === "number";
const lastSeq = (entries: TimelineEntry[]) => entries.reduce((m, e) => Math.max(m, e.seqEnd), 0);

/**
 * Merges a fetched page into the rows: a `next` entry replaces every `prev` entry whose range it
 * overlaps (the projection merged them), the newer entry wins for the same seq, the result is
 * ordered by `seqStart`, and rows without numeric seqs (transient) are dropped. Pure.
 */
export function mergeTimeline(prev: TimelineEntry[], next: TimelineEntry[]): TimelineEntry[] {
  const incoming = next.filter(hasSeq);
  const kept = prev.filter((p) => hasSeq(p) && !incoming.some((n) => p.seqStart <= n.seqEnd && n.seqStart <= p.seqEnd));
  return [...kept, ...incoming].sort((a, b) => a.seqStart - b.seqStart || a.seqEnd - b.seqEnd);
}

type Item = TimelineEntry["item"];
const textOf = (item: Item): string | undefined => ("text" in item && typeof item.text === "string" ? item.text : undefined);
const messageIdOf = (item: Item): string | undefined => ("messageId" in item && typeof item.messageId === "string" ? item.messageId : undefined);

/**
 * Folds one live row into the rows the way the installed projection does, so a stream of chunks
 * does not render as fragments: a tool-call update replaces the row of the same `callId` (same
 * turn); an assistant or reasoning chunk extends the previous row of the same kind when the seqs are
 * contiguous and both rows carry the same `turnId` (and no conflicting `messageId`).
 */
function foldLive(entries: TimelineEntry[], row: TimelineEntry): TimelineEntry[] {
  const item = row.item;
  if (item.type === "tool_call" && "callId" in item) {
    const at = entries.findIndex((e) => e.item.type === "tool_call" && "callId" in e.item && e.item.callId === item.callId && e.turnId === row.turnId);
    if (at >= 0) {
      const existing = entries[at];
      const merged = { ...existing, item: { ...existing.item, ...item } as Item, timestamp: row.timestamp, seqEnd: row.seqEnd };
      return [...entries.slice(0, at), merged, ...entries.slice(at + 1)];
    }
  }
  const previous = entries.at(-1);
  if (
    previous &&
    (item.type === "assistant_message" || item.type === "reasoning") &&
    previous.item.type === item.type &&
    previous.seqEnd + 1 === row.seqStart &&
    previous.turnId !== undefined &&
    previous.turnId === row.turnId &&
    (messageIdOf(item) === undefined || messageIdOf(item) === messageIdOf(previous.item))
  ) {
    const merged = { ...previous, item: { ...previous.item, text: `${textOf(previous.item) ?? ""}${textOf(item) ?? ""}` } as Item, timestamp: row.timestamp, seqEnd: row.seqEnd };
    return [...entries.slice(0, -1), merged];
  }
  return [...entries, row];
}

/**
 * Applies one subscription event. A live `timeline` event with a `seq` after the last row is
 * folded in; one at or below it (or inside a projected range) is a duplicate. A live event without
 * `seq` is kept only as transient. `replacement` empties the rows; `error` marks the timeline
 * stale. Anything else leaves the state unchanged.
 */
export function reduceTimelineEvent(state: TimelineState, event: unknown): TimelineState {
  if (!isObj(event) || !isObj(event.event)) return state;
  const inner = event.event;
  if (inner.type === "replacement") return { ...state, entries: [], transient: [] };
  if (inner.type === "error") return { ...state, status: "stale", error: typeof inner.error === "string" ? inner.error : "timeline observation lost" };
  if (inner.type !== "timeline" || !isObj(inner.item) || typeof inner.provider !== "string") return state;
  const base = {
    provider: inner.provider,
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- transport boundary: the SDK subscription types this as a timeline item (PaseoAgentTimelineEvent); the reducer keeps its existing object-only acceptance and does not validate the item at runtime
    item: inner.item as Item,
    timestamp: typeof event.timestamp === "string" ? event.timestamp : new Date(0).toISOString(),
    ...(typeof inner.turnId === "string" ? { turnId: inner.turnId } : {}),
  };
  if (typeof event.seq !== "number") return { ...state, transient: [...(state.transient ?? []), base] };
  const seq = event.seq;
  if (seq <= lastSeq(state.entries) || state.entries.some((e) => e.seqStart <= seq && seq <= e.seqEnd)) return state;
  return { ...state, entries: foldLive(state.entries, { ...base, seqStart: seq, seqEnd: seq }) };
}

/** The coordinator's live timeline (R4.1). A null `agentId` or no host SDK makes no SDK call. */
export function useAgentTimeline(agentId: string | null): TimelineState & { reload(): void } {
  const paseo = usePaseo() as ReturnType<typeof usePaseo> | null;
  const [state, setState] = useState<TimelineState>(IDLE);
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    if (agentId === null || !paseo) {
      setState(IDLE);
      return;
    }
    let alive = true;
    const timeline = paseo.agents.ref(agentId).timeline;
    let epoch: string | null = null;
    let endCursor: Cursor | null = null;
    let buffering = true;
    let buffer: unknown[] = [];
    // After a rejected refetch the history is unknown: ordinary live events are dropped (never applied
    // over the missing window) and only control events are handled, so subscription_restored or a
    // replacement can start a new refetch from the last good cursor and an error still releases.
    let failed = false;
    let fetches = 0;
    const fail = (e: unknown) => (e instanceof Error ? e.message : "timeline unavailable");
    const isControl = (event: unknown) => {
      const type = isObj(event) && isObj(event.event) ? event.event.type : undefined;
      return type === "subscription_restored" || type === "replacement" || type === "error";
    };
    const refetchFailed = (e: unknown) => {
      buffer = [];
      failed = true;
      setState((s) => ({ ...s, status: "error", error: fail(e) }));
    };

    const advance = (event: Obj) => {
      if (typeof event.seq === "number" && (endCursor === null || event.seq > endCursor.seq)) {
        endCursor = { epoch: typeof event.epoch === "string" ? event.epoch : (epoch ?? ""), seq: event.seq };
      }
    };
    const apply = (event: unknown) => {
      if (!isObj(event) || !isObj(event.event)) return;
      const type = event.event.type;
      if (type === "subscription_restored") return void refetchAfter();
      if (type === "replacement") {
        epoch = typeof event.event.epoch === "string" ? event.event.epoch : null;
        endCursor = null;
        setState((s) => reduceTimelineEvent(s, event));
        return void refetchTail();
      }
      if (type === "error") {
        alive = false;
        setState((s) => reduceTimelineEvent(s, event));
        return void subscription.release().catch(() => undefined);
      }
      // A live event of another epoch belongs to a replaced timeline.
      if (typeof event.epoch === "string" && epoch !== null && event.epoch !== epoch) return;
      advance(event);
      setState((s) => reduceTimelineEvent(s, event));
    };
    const replay = () => {
      buffering = false;
      const pending = buffer;
      buffer = [];
      for (const event of pending) apply(event);
    };
    const refetchTail = async (): Promise<void> => {
      const mine = ++fetches;
      buffering = true;
      failed = false;
      try {
        const page = await timeline.refetch(TAIL);
        if (!alive || mine !== fetches) return;
        epoch = page.epoch;
        endCursor = page.endCursor ?? null;
        const entries = mergeTimeline([], page.entries);
        setState({ entries, status: "live" });
        replay();
      } catch (e) {
        if (alive && mine === fetches) refetchFailed(e);
      }
    };
    const refetchAfter = async (): Promise<void> => {
      if (endCursor === null) return refetchTail();
      const mine = ++fetches;
      buffering = true;
      failed = false;
      try {
        // No limit: the installed server returns every row after the cursor for an `after` fetch
        // without one (session.js:5864-5865). Any page that still reports `hasNewer` is followed
        // from its end cursor, so no history gap is left before the buffered live events replay.
        let cursor: Cursor = endCursor;
        let fetched: TimelineEntry[] = [];
        for (;;) {
          const page = await timeline.refetch({ direction: "after", cursor, projection: "canonical" });
          if (!alive || mine !== fetches) return;
          // A reset, a stale cursor, a gap or a new epoch: the window cannot be continued.
          if (page.reset || page.staleCursor || page.gap || (epoch !== null && page.epoch !== epoch)) return refetchTail();
          fetched = mergeTimeline(fetched, page.entries);
          if (!page.endCursor || !page.hasNewer || page.endCursor.seq <= cursor.seq) {
            if (page.endCursor) cursor = page.endCursor;
            break;
          }
          cursor = page.endCursor;
        }
        endCursor = cursor;
        setState((s) => ({ ...s, entries: mergeTimeline(s.entries, fetched), transient: [], status: "live" }));
        replay();
      } catch (e) {
        if (alive && mine === fetches) refetchFailed(e);
      }
    };

    setState({ entries: [], status: "loading" });
    const subscription = timeline.subscribe((event: PaseoAgentTimelineEvent) => {
      if (!alive) return;
      if (failed) {
        if (isControl(event)) apply(event);
      } else if (buffering) buffer.push(event);
      else apply(event);
    });
    subscription.ready.then(
      () => {
        if (alive) void refetchTail();
      },
      (e: unknown) => {
        if (!alive) return;
        alive = false;
        setState({ entries: [], status: "error", error: fail(e) });
      },
    );
    return () => {
      alive = false;
      void subscription.release().catch(() => undefined);
    };
  }, [agentId, paseo, generation]);

  const reload = useCallback(() => setGeneration((g) => g + 1), []);
  return { ...state, reload };
}
