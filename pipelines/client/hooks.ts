import { useRpc } from "@getpaseo/plugin/client";
import { createContext, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { z } from "zod";
import {
  runGet,
  workflowDraftDiscard,
  workflowDraftEdit,
  workflowDraftSetText,
  workflowGet,
  workflowProposalApply,
  workflowProposalDiscard,
  workflowSave,
  type EditOpSchema,
  type RpcError,
  type RunDetail,
  type RunDetailResult,
  type RunError,
  type ViewResult,
  type WorkflowView,
} from "../shared/rpc";

export type EditOp = z.input<typeof EditOpSchema>;

/** Timer functions, replaceable in tests; `set` returns the handle `clear` takes. */
export type Timers = {
  set(callback: () => void, ms: number): () => void;
};

export const realTimers: Timers = {
  set: (callback, ms) => {
    const handle = setTimeout(callback, ms);
    return () => clearTimeout(handle);
  },
};

// ---------------------------------------------------------------------------------------------
// run feed

/** A live subscription: `ready` settles once the host acknowledged it. */
export type FeedSubscription = { ready: Promise<void>; release(): void };

/** Opens `run.watch`; null when the host has no plugin subscriptions. */
export type RunSubscribe = (runId: string, onEvent: (detail: RunDetail) => void, onClosed: (error?: Error) => void) => FeedSubscription | null;

export type RunFeedState = {
  detail: RunDetail | null;
  error: RunError | null;
  mode: "connecting" | "watch" | "poll";
};

export type RunFeedDeps = {
  runId: string;
  get(runId: string): Promise<RunDetailResult>;
  subscribe: RunSubscribe | null;
  onChange(state: RunFeedState): void;
  pollMs?: number;
  timers?: Timers;
};

export const POLL_MS = 3_000;

function ended(detail: RunDetail | null): boolean {
  return detail !== null && (detail.view.status === "finished" || detail.view.status === "cancelled");
}

/**
 * Keeps one run's detail current: `run.watch` when the host has subscriptions, else polling of
 * `run.get`, which also takes over when the subscription is refused or closes. Polling stops once
 * the run has ended. A `run.get` answer or error is dropped when a newer request has already
 * answered or a watch event arrived after it was sent.
 */
export function createRunFeed(deps: RunFeedDeps): { refresh(): Promise<void>; dispose(): void; state(): RunFeedState } {
  const timers = deps.timers ?? realTimers;
  const pollMs = deps.pollMs ?? POLL_MS;
  let state: RunFeedState = { detail: null, error: null, mode: "connecting" };
  let disposed = false;
  let version = 0;
  let timer: (() => void) | null = null;
  let subscription: FeedSubscription | null = null;

  const update = (next: Partial<RunFeedState>): void => {
    if (disposed) return;
    state = { ...state, ...next };
    deps.onChange(state);
  };

  // A `run.get` answer applies only if no newer request has answered and no watch event arrived
  // since it was sent, so an old answer or error never replaces newer state.
  let requests = 0;
  let answered = 0;
  const fetchOnce = async (): Promise<void> => {
    const request = ++requests;
    const started = version;
    const current = (): boolean => request > answered && started === version;
    let result: RunDetailResult;
    try {
      result = await deps.get(deps.runId);
    } catch (error) {
      if (!current()) return;
      answered = request;
      update({ error: { code: "unavailable", message: error instanceof Error ? error.message : "The host did not answer." } });
      return;
    }
    if (!current()) return;
    answered = request;
    if (result.ok) update({ detail: result.value, error: null });
    else update({ error: result.error });
  };

  const schedule = (): void => {
    if (disposed || state.mode !== "poll" || ended(state.detail)) return;
    timer = timers.set(() => {
      timer = null;
      void fetchOnce().finally(schedule);
    }, pollMs);
  };

  const poll = (): void => {
    if (disposed || state.mode === "poll") return;
    subscription?.release();
    subscription = null;
    update({ mode: "poll" });
    schedule();
  };

  void fetchOnce();
  let opened: FeedSubscription | null = null;
  try {
    opened =
      deps.subscribe?.(
        deps.runId,
        (detail) => {
          version += 1;
          update({ detail, error: null, mode: "watch" });
        },
        () => {
          if (!ended(state.detail)) poll();
        },
      ) ?? null;
  } catch {
    opened = null;
  }
  if (opened === null) poll();
  else {
    subscription = opened;
    opened.ready.then(
      () => {
        if (state.mode === "connecting") update({ mode: "watch" });
      },
      () => poll(),
    );
  }

  return {
    refresh: fetchOnce,
    state: () => state,
    dispose() {
      disposed = true;
      timer?.();
      subscription?.release();
      subscription = null;
    },
  };
}

/** Supplies `run.watch` from the client context; null on a host without plugin subscriptions. */
export const RunSubscribeContext = createContext<RunSubscribe | null>(null);

export function useRunFeed(runId: string): RunFeedState & { refresh(): void; replace(detail: RunDetail): void } {
  const get = useRpc(runGet);
  const subscribe = useContext(RunSubscribeContext);
  const [state, setState] = useState<RunFeedState>({ detail: null, error: null, mode: "connecting" });
  const feed = useRef<ReturnType<typeof createRunFeed> | null>(null);
  useEffect(() => {
    setState({ detail: null, error: null, mode: "connecting" });
    const created = createRunFeed({ runId, get: (id) => get({ runId: id }), subscribe, onChange: setState });
    feed.current = created;
    return () => created.dispose();
  }, [runId, get, subscribe]);
  return {
    ...state,
    refresh: () => void feed.current?.refresh(),
    // An action's answer is the run as the server saw it after the action.
    replace: (detail) => setState((current) => ({ ...current, detail, error: null })),
  };
}

// ---------------------------------------------------------------------------------------------
// workflow session

export type WorkflowRpc = {
  get(): Promise<ViewResult>;
  setText(editableDigest: string, yaml: string): Promise<ViewResult>;
  edit(editableDigest: string, op: EditOp): Promise<ViewResult>;
  discard(editableDigest: string): Promise<ViewResult>;
  save(savedDigest: string, draftDigest: string): Promise<ViewResult>;
  applyProposal(editableDigest: string, proposalId: string): Promise<ViewResult>;
  discardProposal(proposalId: string): Promise<ViewResult>;
};

export type WorkflowSessionState = {
  view: WorkflowView | null;
  /** The YAML shown in the editor; ahead of `view` while edits are unsent. */
  text: string;
  /** True while `text` differs from the editable text the server holds. */
  unsent: boolean;
  busy: boolean;
  /** A refused mutation's text, kept for the person after a conflict. */
  conflict: { message: string; unsentText: string } | null;
  error: RpcError | null;
  loadError: string | null;
};

export const SYNC_DELAY_MS = 400;

function editableText(view: WorkflowView | null): string {
  return (view?.draft ?? view?.saved)?.yaml ?? "";
}

/**
 * One project's workflow over the server's single draft. Every mutation carries the editable digest
 * last read; a `workflow_conflict` keeps the person's unsent text and asks for a reload.
 */
export class WorkflowSession {
  private state: WorkflowSessionState = { view: null, text: "", unsent: false, busy: false, conflict: null, error: null, loadError: null };
  private readonly listeners = new Set<() => void>();
  private syncTimer: (() => void) | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly rpc: WorkflowRpc,
    private readonly timers: Timers = realTimers,
    private readonly delayMs = SYNC_DELAY_MS,
  ) {}

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly snapshot = (): WorkflowSessionState => this.state;

  private set(next: Partial<WorkflowSessionState>): void {
    this.state = { ...this.state, ...next };
    for (const listener of this.listeners) listener();
  }

  /** Runs mutations one at a time so each uses the digest the previous one returned. */
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private accept(result: ViewResult, sentText: string): boolean {
    if (result.ok) {
      const view = result.value;
      // Typing that arrived during the request stays in the editor and is sent next.
      const keepTyping = this.state.text !== sentText;
      this.set({ view, text: keepTyping ? this.state.text : editableText(view), unsent: keepTyping, error: null, conflict: null });
      if (keepTyping) this.scheduleSync();
      return true;
    }
    if (result.error.code === "workflow_conflict") {
      this.set({ conflict: { message: result.error.message, unsentText: this.state.text }, error: null });
    } else {
      this.set({ error: result.error });
    }
    return false;
  }

  async load(): Promise<void> {
    this.set({ busy: true });
    try {
      const result = await this.rpc.get();
      if (result.ok) this.set({ view: result.value, text: editableText(result.value), unsent: false, loadError: null, error: null });
      else this.set({ loadError: result.error.message });
    } catch (error) {
      this.set({ loadError: error instanceof Error ? error.message : "The workflow could not be loaded." });
    } finally {
      this.set({ busy: false });
    }
  }

  /** Reload after a conflict: shows the other change and keeps the refused text for the person. */
  async reload(): Promise<void> {
    await this.load();
    // Typing during the read updates the conflict's text, so read it after the load.
    const kept = this.state.conflict?.unsentText;
    if (kept !== undefined) this.set({ conflict: { message: "Reloaded. Your unsent text is kept below.", unsentText: kept } });
  }

  dismissConflict(): void {
    this.set({ conflict: null });
  }

  /** Reloads, then puts the kept text back as the new draft on top of the current digest. */
  async useKeptText(): Promise<void> {
    if (this.state.conflict === null) return;
    await this.load();
    const kept = this.state.conflict?.unsentText;
    if (kept === undefined) return;
    this.set({ conflict: null });
    this.setText(kept);
  }

  setText(text: string): void {
    if (this.state.conflict !== null) {
      // Edits wait for the reload; the text stays in the editor.
      this.set({ text, unsent: true, conflict: { ...this.state.conflict, unsentText: text } });
      return;
    }
    this.set({ text, unsent: text !== editableText(this.state.view) });
    this.scheduleSync();
  }

  private scheduleSync(): void {
    this.syncTimer?.();
    this.syncTimer = this.timers.set(() => {
      this.syncTimer = null;
      void this.flush();
    }, this.delayMs);
  }

  /** Sends unsent YAML now; resolves false when the server refused it. */
  flush(): Promise<boolean> {
    if (this.syncTimer !== null) {
      this.syncTimer();
      this.syncTimer = null;
    }
    return this.serial(async () => {
      const view = this.state.view;
      if (view === null || this.state.conflict !== null) return false;
      const text = this.state.text;
      if (text === editableText(view)) {
        this.set({ unsent: false });
        return true;
      }
      try {
        return this.accept(await this.rpc.setText(view.editableDigest, text), text);
      } catch (error) {
        this.set({ error: { code: "internal", message: error instanceof Error ? error.message : "The draft could not be sent." } });
        return false;
      }
    });
  }

  private mutate(work: (view: WorkflowView) => Promise<ViewResult>): Promise<boolean> {
    return this.serial(async () => {
      const view = this.state.view;
      if (view === null || this.state.conflict !== null) return false;
      const sent = this.state.text;
      this.set({ busy: true });
      try {
        return this.accept(await work(view), sent);
      } catch (error) {
        this.set({ error: { code: "internal", message: error instanceof Error ? error.message : "The request failed." } });
        return false;
      } finally {
        this.set({ busy: false });
      }
    });
  }

  /** A job edit from Diagram or Task list, applied to the shared draft by the server. */
  async edit(op: EditOp): Promise<boolean> {
    if (this.state.unsent && !(await this.flush())) return false;
    return this.mutate((view) => this.rpc.edit(view.editableDigest, op));
  }

  async save(): Promise<boolean> {
    if (this.state.unsent && !(await this.flush())) return false;
    return this.mutate((view) => this.rpc.save(view.saved?.digest ?? "absent", view.draft?.digest ?? "absent"));
  }

  discard(): Promise<boolean> {
    if (this.syncTimer !== null) {
      this.syncTimer();
      this.syncTimer = null;
    }
    const view = this.state.view;
    if (view !== null && view.draft === null) {
      // Nothing on the server to drop: restore the saved text locally.
      this.set({ text: editableText(view), unsent: false });
      return Promise.resolve(true);
    }
    return this.mutate((current) => this.rpc.discard(current.editableDigest));
  }

  async applyProposal(proposalId: string): Promise<boolean> {
    if (this.state.unsent && !(await this.flush())) return false;
    return this.mutate((view) => this.rpc.applyProposal(view.editableDigest, proposalId));
  }

  discardProposal(proposalId: string): Promise<boolean> {
    return this.mutate(() => this.rpc.discardProposal(proposalId));
  }

  /** Sends pending typing now instead of dropping it when the panel closes. */
  dispose(): void {
    if (this.syncTimer !== null) void this.flush();
  }
}

/** Save needs a server draft with zero diagnostics and nothing unsent. */
export function canSave(state: WorkflowSessionState): boolean {
  const view = state.view;
  return view !== null && view.draft !== null && view.diagnostics.length === 0 && !state.unsent && !state.busy && state.conflict === null;
}

export function useWorkflowSession(projectId: string): { session: WorkflowSession; state: WorkflowSessionState } {
  const get = useRpc(workflowGet);
  const setText = useRpc(workflowDraftSetText);
  const edit = useRpc(workflowDraftEdit);
  const discard = useRpc(workflowDraftDiscard);
  const save = useRpc(workflowSave);
  const apply = useRpc(workflowProposalApply);
  const drop = useRpc(workflowProposalDiscard);
  const session = useMemo(
    () =>
      new WorkflowSession({
        get: () => get({ projectId }),
        setText: (editableDigest, yaml) => setText({ projectId, editableDigest, yaml }),
        edit: (editableDigest, op) => edit({ projectId, editableDigest, op }),
        discard: (editableDigest) => discard({ projectId, editableDigest }),
        save: (savedDigest, draftDigest) => save({ projectId, savedDigest, draftDigest }),
        applyProposal: (editableDigest, proposalId) => apply({ projectId, editableDigest, proposalId }),
        discardProposal: (proposalId) => drop({ projectId, proposalId }),
      }),
    [projectId, get, setText, edit, discard, save, apply, drop],
  );
  useEffect(() => {
    void session.load();
    return () => session.dispose();
  }, [session]);
  const state = useSyncExternalStore(session.subscribe, session.snapshot, session.snapshot);
  return { session, state };
}
