// The automatic-grilling pause engine (PLAN §3.4–§3.5, TASKS §4.3). It watches the bound planner's
// native question cards and answers exactly one: the single pause card of the current operation,
// after the owner accepted its block. The answer is a plain-text summary sent through the public
// permission API; nothing is ever sent, run or denied.
//
// Every state change is a store compare-and-set fenced on the operation it observed (TR16). The
// claim of answer attempt n (`resolving`, `attempts: n`) commits before the one call for attempt n;
// a late event or acknowledgement can never move an operation that has moved on. After a failed call
// the request is retried only while it is still pending and still the current operation's card, up
// to MAX_ATTEMPTS calls; an outcome that cannot be confirmed stays visible as `unknown`.
//
// A chat bound by Discuss that cannot pause (Codex in default mode) or whose turn ended without the
// card is given its accepted block by one plugin-sent message instead, once per accepted block: the
// record is committed `sending` before the one send, and an existing record of the block, whatever its
// state, is never sent again. The host has no conditional send: every message interrupts a running
// turn and clears pending permissions and questions. So the send is issued only right after a bounded
// read, taken after the claim, shows the chat idle with nothing pending; otherwise the unsent claim is
// withdrawn and the continuation waits. A turn or prompt started by someone else between that read and
// the send's arrival cannot be excluded; that window is kept as short as one host round trip.
import type { PaseoApi } from "@getpaseo/client";
import type { PluginHookAgent, PluginLifecycleEvents, PluginServerContext } from "@getpaseo/plugin/server";
import type { AgentPermissionRequest, AgentPermissionResponse } from "@getpaseo/protocol/agent-types";
import { isRecord } from "../shared/canonical";
import { isDomainError } from "../shared/errors";
import { isTerminalContinuation, type Continuation, type ContinuationState, type PauseSnapshot, type Session } from "../shared/model";
import { fingerprint } from "./mcp-state";
import type { createPaseoHolder } from "./paseo-holder";
import { operationToken, PAUSE_HEADER, PAUSE_OPTIONS, pauseQuestionText } from "./pause-contract";
import { admissibleAutomatic, automaticContinuation, claimAutomatic, classifySendError, recordedError } from "./continuation-retry";
import { readAgent, SUPPORT_TIMEOUT_MS, type AgentRead } from "./pause-support";
import type { StoreOpener } from "./sessions";
import type { Store } from "./store";
import { projectForCwd, type ProjectDirectory } from "./store-root";

export const MAX_ATTEMPTS = 3;
/** Consecutive automatic-continuation decisions for one chat before the next waits CONTINUE_RETRY_DELAY_MS. */
const MAX_CONTINUE_PASSES = 3;
const CONTINUE_RETRY_DELAY_MS = 1000;
const DEFAULT_RETRY_DELAYS_MS = [1000, 3000] as const;
/** Bound of one host call (answer or refresh); a timed-out call counts as failed. */
const HOST_CALL_TIMEOUT_MS = 30_000;
const TOKEN_RE = /DR-OP-[A-Za-z0-9_-]+/g;

export type PauseMatch =
  | { kind: "match"; snapshot: Omit<PauseSnapshot, "seenAt"> }
  | { kind: "mismatch"; reason: string }
  | { kind: "stale"; token: string }
  | { kind: "foreign" };

const PAIRS: ReadonlyArray<readonly [string, string]> = [
  ["claude", "AskUserQuestion"],
  ["codex", "request_user_input"],
];

/**
 * Whether a permission request is the pause card of `target.operationId` shown by `target.agentId`
 * (PLAN §3.4). Only a `question` from Claude AskUserQuestion or Codex synchronous request_user_input
 * qualifies; the token is read from question text only; host decorations of a question are ignored.
 */
export function matchPause(agent: { id: string }, request: AgentPermissionRequest, target: { agentId: string; operationId: string }): PauseMatch {
  if (request.kind !== "question") return { kind: "foreign" };
  if (!PAIRS.some(([provider, name]) => request.provider === provider && request.name === name)) return { kind: "foreign" };
  if (agent.id !== target.agentId) return { kind: "foreign" };
  const raw = isRecord(request.input) ? request.input.questions : undefined;
  const questions: unknown[] = Array.isArray(raw) ? raw : [];
  const texts = questions.map((q) => (isRecord(q) && typeof q.question === "string" ? q.question : ""));
  const tokens = texts.flatMap((t) => t.match(TOKEN_RE) ?? []);
  if (tokens.length === 0) return { kind: "foreign" };
  const current = operationToken(target.operationId);
  if (!tokens.includes(current)) return { kind: "stale", token: tokens[0] };
  if (questions.length !== 1) return { kind: "mismatch", reason: `${questions.length} questions instead of one` };
  const q = questions[0];
  if (!isRecord(q)) return { kind: "mismatch", reason: "malformed question" };
  if (q.question !== pauseQuestionText(target.operationId)) return { kind: "mismatch", reason: "question text differs from the template" };
  if (q.header !== PAUSE_HEADER) return { kind: "mismatch", reason: "header differs from the template" };
  const options: unknown[] = Array.isArray(q.options) ? q.options : [];
  const labels = options.map((o) => (isRecord(o) && typeof o.label === "string" ? o.label : ""));
  if (labels.length !== PAUSE_OPTIONS.length || labels.some((l, i) => l !== PAUSE_OPTIONS[i])) {
    return { kind: "mismatch", reason: "options differ from the template" };
  }
  if (q.multiSelect === true) return { kind: "mismatch", reason: "multi-select card" };
  return {
    kind: "match",
    snapshot: { requestId: request.id, provider: request.provider, name: request.name, questionText: q.question, header: q.header, optionLabels: labels },
  };
}

/** The allow that answers the card, keyed by the request's own question text and header (TR2). */
export function answerResponse(pause: PauseSnapshot, summary: string): AgentPermissionResponse {
  return { behavior: "allow", updatedInput: { answers: { [pause.questionText]: summary, [pause.header]: summary } } };
}

/** Who resolved the card (TR4): our summary is the plugin's; other readable answers are external. */
export function attributeResolution(resolution: AgentPermissionResponse, pause: PauseSnapshot, summary: string | undefined): "plugin" | "external" | "host" {
  if (resolution.behavior !== "allow") return "external";
  const input = resolution.updatedInput;
  const answers = isRecord(input) && isRecord(input.answers) ? input.answers : undefined;
  if (answers === undefined) return "host";
  if (summary !== undefined && (answers[pause.questionText] === summary || answers[pause.header] === summary)) return "plugin";
  return "external";
}

export interface PauseEngineDeps {
  open: StoreOpener;
  paseo: () => PaseoApi | null;
  directory: (p: PaseoApi) => ProjectDirectory;
  log: (m: string) => void;
  now?: () => Date;
  /** Waits before the 2nd and 3rd answer call (default 1 s, 3 s). */
  retryDelaysMs?: readonly number[];
  /** Store compare-and-set retries on a revision conflict (default 5). */
  maxConflictRetries?: number;
  /** Aborting stops scheduled retries and clears their timers. */
  signal?: AbortSignal;
  /** Ids of automatic continuation records; without it no automatic continuation is sent. */
  newId?: () => string;
}

export interface PauseEngine {
  permissionRequested(e: PluginLifecycleEvents["agent.permission_requested"], paseo: PaseoApi): Promise<void>;
  permissionResolved(e: PluginLifecycleEvents["agent.permission_resolved"], paseo: PaseoApi): Promise<void>;
  turnEnded(e: PluginLifecycleEvents["agent.turn_ended"], paseo: PaseoApi): Promise<void>;
  agentGone(e: { agent: PluginHookAgent }, why: "archived" | "closed", paseo: PaseoApi): Promise<void>;
  afterAccept(x: { projectId: string; sessionId: string; operationId: string }): Promise<void>;
  reconcileAll(paseo: PaseoApi): Promise<void>;
  remember(agentId: string, projectId: string): void;
  /** Resolves when every started answer chain and scheduled retry has settled. */
  idle(): Promise<void>;
}

type ProjectRead = { store: Store; read: Extract<Awaited<ReturnType<Store["read"]>>, { status: "ok" }> };
/** One live (or, for resolution events, unconfirmed) operation of a session, with the read it was found in. */
type Candidate = { projectId: string; sessionId: string; c: Continuation; project?: ProjectRead };
type Transition = (c: Continuation, at: string) => Continuation | null;

const NO_CHANGE = new Error("no change");
const LIVE_PENDING: readonly ContinuationState[] = ["awaiting_pause", "accepted_awaiting_pause"];
/** States a resolution event of the operation's own card may still settle. */
const RESOLVABLE: readonly ContinuationState[] = ["paused", "resolving", "unknown"];

/**
 * A pre-Accept `pause_lost` (no accepted block refs) is the one terminal state the card's own canonical
 * resolution may still settle: a reconcile can record it before a late resolution event arrives (c121).
 * A post-Accept `pause_lost` or `needs_manual` is never settled this way.
 */
const lostBeforeAccept = (c: Continuation) => c.state === "pause_lost" && c.acceptedBlockId === undefined;
const resolvable = (c: Continuation) => RESOLVABLE.includes(c.state) || lostBeforeAccept(c);

/** The operation still targets the session's current planner binding (rebind fencing). */
const bound = (s: Session, c: Continuation) => s.planner !== undefined && c.target.agentId === s.planner.agentId && c.target.epoch === s.planner.epoch;

/** The same operation in the same state and attempt as observed. */
const same = (c: Continuation, seen: Continuation) => c.operationId === seen.operationId && c.state === seen.state && c.attempts === seen.attempts;

export function createPauseEngine(deps: PauseEngineDeps): PauseEngine {
  const now = deps.now ?? (() => new Date());
  const delays = deps.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  const maxConflicts = deps.maxConflictRetries ?? 5;
  const log = deps.log;
  const index = new Map<string, Set<string>>();
  const running = new Set<Promise<void>>();
  /** Operations this engine is answering right now (`project/session/operation`). */
  const answering = new Set<string>();
  const timers = new Set<{ id: ReturnType<typeof setTimeout>; done: (fired: boolean) => void }>();
  /** Agents whose automatic continuation is being decided; `true` asks for one more pass afterwards. */
  const continuing = new Map<string, boolean>();
  deps.signal?.addEventListener("abort", () => {
    for (const t of [...timers]) {
      clearTimeout(t.id);
      t.done(false);
    }
  });

  /**
   * After the abort (plugin cleanup) no new claim, host call, store open or store write starts. A host
   * call already issued cannot be revoked: `idle()` waits for it to settle or for its 30 s bound, and
   * its outcome is not written; the claim stays `resolving` for the next start's reconcile.
   */
  const stopped = () => deps.signal?.aborted === true;
  const keyOf = (x: { projectId: string; sessionId: string }, op: string) => `${x.projectId}/${x.sessionId}/${op}`;
  const fail = (what: string, e: unknown) => log(`pause engine: ${what} failed: ${isDomainError(e) ? e.code : e instanceof Error ? e.name : "error"}`);

  function remember(agentId: string, projectId: string): void {
    const set = index.get(agentId) ?? new Set<string>();
    set.add(projectId);
    index.set(agentId, set);
  }

  /** Starts background work that `idle()` waits for; it never rejects. */
  function spawn(work: () => Promise<void>): void {
    const p = work().catch((e: unknown) => fail("background answer", e));
    running.add(p);
    void p.finally(() => running.delete(p));
  }

  /** A cancellable wait registered at once (so retry spacing starts at the failure). */
  /**
   * A retry wait ends at once on abort (it guards no call in flight). A host-call bound
   * (`survivesAbort`) keeps running after the abort, so cleanup waits for an issued call to settle or
   * for that bound, whichever comes first, and never longer.
   */
  function sleep(ms: number, survivesAbort = false): { wait: Promise<boolean>; cancel: () => void } {
    let entry: { id: ReturnType<typeof setTimeout>; done: (fired: boolean) => void } | undefined;
    const wait = new Promise<boolean>((resolve) => {
      if (!survivesAbort && deps.signal?.aborted === true) return resolve(false);
      const t = {
        id: setTimeout(() => t.done(true), ms),
        done: (fired: boolean) => {
          timers.delete(t);
          resolve(fired);
        },
      };
      entry = t;
      if (!survivesAbort) timers.add(t);
    });
    return {
      wait,
      cancel: () => {
        if (entry === undefined) return;
        clearTimeout(entry.id);
        entry.done(false);
      },
    };
  }

  /** Every store access goes through here; none starts after the abort (an open can reach the host). */
  async function readProject(projectId: string, evenStopped = false): Promise<ProjectRead | null> {
    if (stopped() && !evenStopped) return null;
    try {
      const store = await deps.open(projectId);
      const read = await store.read();
      return read.status === "ok" && !read.disabled ? { store, read } : null;
    } catch (e) {
      fail("store read", e);
      return null;
    }
  }

  /**
   * One fenced compare-and-set of a session's continuation: `step` sees the continuation as stored
   * at the committed revision and returns the next one, or null to write nothing. A revision
   * conflict re-reads and re-evaluates. Returns the written continuation, or null.
   */
  async function transition(projectId: string, sessionId: string, step: Transition, first?: ProjectRead): Promise<Continuation | null> {
    for (let i = 0; i <= maxConflicts; i++) {
      // No write after the abort, not even an outcome: a claimed operation stays `resolving` for the
      // next start's reconcile, which settles it from evidence. Checked before and inside the CAS.
      if (stopped()) return null;
      // The read an event was matched in serves the first compare-and-set; a conflict re-reads.
      const project = i === 0 && first !== undefined ? first : await readProject(projectId);
      if (project === null) return null;
      const at = now().toISOString();
      let written: Continuation | null = null;
      try {
        await project.store.transact(project.read.revision, (draft) => {
          if (stopped()) throw NO_CHANGE;
          const s = draft.sessions.find((x) => x.id === sessionId);
          const c = s?.continuation;
          if (s === undefined || c === undefined || !bound(s, c)) throw NO_CHANGE;
          const next = step(c, at);
          if (next === null) throw NO_CHANGE;
          s.continuation = next;
          written = next;
        });
        return written;
      } catch (e) {
        if (e === NO_CHANGE) return null;
        if (isDomainError(e) && e.code === "revision_conflict") continue;
        fail("store write", e);
        return null;
      }
    }
    log("pause engine: store write gave up after repeated revision conflicts");
    return null;
  }

  /** The projects `agent` is known in (index, then its cwd). */
  async function projectsOf(agent: { id: string; cwd?: string }, paseo: PaseoApi): Promise<Set<string>> {
    const projects = new Set(index.get(agent.id) ?? []);
    if (typeof agent.cwd === "string") {
      try {
        const found = await projectForCwd(deps.directory(paseo), agent.cwd);
        if (found !== null) projects.add(found);
      } catch (e) {
        fail("project lookup", e);
      }
    }
    return projects;
  }

  /** Operations of `agentId` in the projects it is known in (index, then its cwd). */
  async function candidates(agent: { id: string; cwd?: string }, paseo: PaseoApi, accept: (c: Continuation) => boolean): Promise<Candidate[]> {
    const projects = await projectsOf(agent, paseo);
    const out: Candidate[] = [];
    for (const projectId of projects) {
      const project = await readProject(projectId);
      if (project === null) continue;
      for (const s of project.read.data.sessions) {
        const c = s.continuation;
        if (c !== undefined && c.target.agentId === agent.id && bound(s, c) && accept(c)) out.push({ projectId, sessionId: s.id, c, project });
      }
    }
    return out;
  }

  /** The host call for attempt n, bounded; true when the host accepted the answer. */
  async function respond(paseo: PaseoApi, agentId: string, requestId: string, response: AgentPermissionResponse): Promise<boolean> {
    // The issued call cannot be revoked; this bound survives the abort so cleanup waits for at most it.
    const limit = sleep(HOST_CALL_TIMEOUT_MS, true);
    try {
      const call = paseo.agents
        .ref(agentId)
        .respondToPermission({ requestId, response })
        .then(
          () => true,
          () => false,
        );
      return await Promise.race([call, limit.wait.then(() => false)]);
    } finally {
      limit.cancel();
    }
  }

  /** The current card of the operation as the host shows it now, by request id. */
  function pendingCard(read: AgentRead, c: Continuation): "pending" | "gone" | "unknown" {
    if (read.kind === "failed") return "unknown";
    if (read.kind === "missing" || c.pause === undefined) return "gone";
    const request = read.agent.pendingPermissions.find((r) => r.id === c.pause?.requestId);
    if (request === undefined) return "gone";
    return matchPause({ id: c.target.agentId }, request, { agentId: c.target.agentId, operationId: c.operationId }).kind === "match" ? "pending" : "gone";
  }

  /** The outcome of an answered-or-gone request from what is recorded (never a phantom resume). */
  function settled(c: Continuation, at: string): Continuation {
    const r = c.resolution;
    if (r?.source === "plugin") return { ...c, state: "resumed", at };
    if (r !== undefined && r.source === "external") return { ...c, state: "pause_answered_externally", at };
    return { ...c, state: "unknown", at };
  }

  /**
   * Answers the claimed attempt of an operation, then retries while the card stays pending. Only
   * the holder of the claim calls this; the caller marked the operation as answering.
   */
  async function answerChain(x: { projectId: string; sessionId: string }, claimed: Continuation): Promise<void> {
    const key = keyOf(x, claimed.operationId);
    try {
      let current = claimed;
      for (;;) {
        // Every call is admitted under the store lock (B, c79): a rebind, a newer operation, a completion
        // or any other move committed before admission prevents it. A call already made cannot be undone.
        const paseo = deps.paseo();
        if (paseo === null) return;
        const admitted = await admit(x, current, paseo);
        if (admitted === null) return;
        const c = admitted.c;
        const n = c.attempts;
        // Awaited outside the lock; bounded by the 30 s host-call limit.
        const delivered = await admitted.call;
        if (delivered) {
          await transition(x.projectId, x.sessionId, (cur, at) =>
            same(cur, c)
              ? { ...cur, state: "resumed", resolution: cur.resolution?.source === "plugin" ? cur.resolution : { behavior: "allow", at, source: "plugin" }, at }
              : null,
          );
          return;
        }
        // Stopped: leave the claim as it is (like a crash); the next start reconciles it.
        if (stopped()) return;
        // Spacing starts at the failure; the decision below may make the wait unnecessary.
        const pause = n < MAX_ATTEMPTS ? sleep(delays[Math.min(n - 1, delays.length - 1)] ?? 0) : undefined;
        const read = await readAgent(paseo, c.target.agentId, HOST_CALL_TIMEOUT_MS);
        const card = pendingCard(read, c);
        const next = await transition(x.projectId, x.sessionId, (cur, at) => {
          if (!same(cur, c)) return null;
          // A failed or timed-out host read shows nothing (A): no new claim or call, a visible outcome.
          if (card === "unknown") return { ...cur, state: "unknown", reason: "pending_state_unknown", at };
          if (card === "gone") return settled(cur, at);
          return n < MAX_ATTEMPTS ? { ...cur, attempts: n + 1, at } : { ...cur, state: "needs_manual", reason: "answer_failed", at };
        });
        if (next === null || next.state !== "resolving") {
          pause?.cancel();
          return;
        }
        if (pause === undefined || !(await pause.wait)) return;
        current = next;
      }
    } finally {
      answering.delete(key);
    }
  }

  /**
   * Admits one answer call (c79). Inside `store.transact`, under the same lock every store commit
   * (a rebind included) takes, on the snapshot at the committed revision, it checks that the stored
   * continuation is still exactly the claimed attempt, `resolving`, bound to the current planner and
   * epoch, and that the engine is not stopped. If so, it starts the host call synchronously and throws
   * `NO_CHANGE`, so nothing is written and the lock is released at once; the call is awaited outside the
   * lock. A revision conflict re-reads and re-checks within the same finite budget as `transition`; a
   * plain read never authorizes a call. The lock serializes this plugin process only, which is the single
   * process that writes this store.
   */
  async function admit(
    x: { projectId: string; sessionId: string },
    claimed: Continuation,
    paseo: PaseoApi,
  ): Promise<{ c: Continuation; call: Promise<boolean> } | null> {
    for (let i = 0; i <= maxConflicts; i++) {
      if (stopped()) return null;
      const project = await readProject(x.projectId);
      if (project === null) return null;
      const admitted: { value?: { c: Continuation; call: Promise<boolean> } } = {};
      try {
        await project.store.transact(project.read.revision, (draft) => {
          if (stopped()) throw NO_CHANGE;
          const s = draft.sessions.find((y) => y.id === x.sessionId);
          const c = s?.continuation;
          if (s === undefined || c === undefined || !bound(s, c) || c.state !== "resolving" || !same(c, claimed)) throw NO_CHANGE;
          if (c.pause === undefined || c.summary === undefined) throw NO_CHANGE;
          // `respond` issues the host call before its first await, i.e. while the lock is held.
          admitted.value = { c, call: respond(paseo, c.target.agentId, c.pause.requestId, answerResponse(c.pause, c.summary)) };
          throw NO_CHANGE;
        });
      } catch (e) {
        if (e === NO_CHANGE) return admitted.value ?? null;
        if (isDomainError(e) && e.code === "revision_conflict") continue;
        fail("answer admission", e);
        return admitted.value ?? null;
      }
    }
    log("pause engine: answer admission gave up after repeated revision conflicts");
    return null;
  }

  /** Claims the next attempt of an operation observed as `seen` and starts its answer chain. */
  async function claimAndAnswer(x: { projectId: string; sessionId: string; project?: ProjectRead }, seen: Continuation, step: Transition): Promise<void> {
    const key = keyOf(x, seen.operationId);
    if (answering.has(key) || stopped()) return;
    answering.add(key);
    let started = false;
    try {
      const claimed = await transition(x.projectId, x.sessionId, (cur, at) => (same(cur, seen) ? step(cur, at) : null), x.project);
      if (claimed?.state === "resolving") {
        started = true;
        spawn(() => answerChain(x, claimed));
      }
    } finally {
      if (!started) answering.delete(key);
    }
  }

  /** Why the chat cannot be given a message now without interrupting or dismissing anything; null when it can. */
  function notReady(read: AgentRead): string | null {
    if (read.kind === "failed") return "chat state unreadable";
    if (read.kind === "missing") return "chat not found";
    const archivedAt = read.agent.archivedAt;
    if (typeof archivedAt === "string" && archivedAt !== "") return "chat archived";
    if (read.agent.status !== "idle") return `chat ${read.agent.status}`;
    const pending = read.agent.pendingPermissions.length;
    return pending > 0 ? `${pending} pending permission request(s)` : null;
  }

  /** A chat the host closed (not loaded) that is not archived. */
  function closedNotArchived(read: AgentRead): boolean {
    if (read.kind !== "ok" || read.agent.status !== "closed") return false;
    const archivedAt = read.agent.archivedAt;
    return !(typeof archivedAt === "string" && archivedAt !== "");
  }

  /**
   * Loads a closed chat through a one-entry timeline read. In the installed host 0.15.3 the daemon
   * serves it by loading the agent from its stored session (`ensureAgentLoaded`, a no-op for a loaded
   * agent) and, unlike a reload, interrupts nothing; the 0.12 typing packages do not document this.
   * Bounded at 30 s; never issued after a stop.
   */
  async function loadChat(paseo: PaseoApi, agentId: string): Promise<"loaded" | "failed" | "timed out" | "stopped"> {
    if (stopped()) return "stopped";
    const limit = sleep(HOST_CALL_TIMEOUT_MS, true);
    try {
      // The async wrapper issues the call synchronously, right after the stop check above.
      const call = (async () => paseo.agents.ref(agentId).timeline.refetch({ direction: "tail", projection: "canonical", limit: 1 }))().then(
        () => "loaded" as const,
        () => "failed" as const,
      );
      return await Promise.race([call, limit.wait.then(() => "timed out" as const)]);
    } finally {
      limit.cancel();
    }
  }

  type AutoTarget = { projectId: string; sessionId: string; operationId: string };

  /** Sessions of `agentId` whose accepted block the plugin continues by itself and has no record for yet. */
  async function automaticTargets(agentId: string, projects: Iterable<string>): Promise<AutoTarget[]> {
    const out: AutoTarget[] = [];
    for (const projectId of projects) {
      const project = await readProject(projectId);
      if (project === null) continue;
      for (const s of project.read.data.sessions) {
        const found = s.planner?.agentId === agentId ? automaticContinuation(s) : null;
        if (found !== null) out.push({ projectId, sessionId: s.id, operationId: found.c.operationId });
      }
    }
    return out;
  }

  /**
   * Commits the automatic record `sending` for `x` under the store lock, after re-checking on the
   * committed state that the operation still qualifies and has no record; returns what to send, or
   * null when nothing was written.
   */
  async function claimContinuation(x: AutoTarget, id: string): Promise<{ agentId: string; text: string } | null> {
    for (let i = 0; i <= maxConflicts; i++) {
      if (stopped()) return null;
      const project = await readProject(x.projectId);
      if (project === null) return null;
      let claimed: { agentId: string; text: string } | null = null;
      try {
        await project.store.transact(project.read.revision, (draft) => {
          if (stopped()) throw NO_CHANGE;
          try {
            claimed = claimAutomatic(draft, x.sessionId, x.operationId, id, now().toISOString());
          } catch (e) {
            if (isDomainError(e)) throw NO_CHANGE;
            throw e;
          }
        });
        return claimed;
      } catch (e) {
        if (e === NO_CHANGE) return null;
        if (isDomainError(e) && e.code === "revision_conflict") continue;
        fail("automatic continuation claim", e);
        return null;
      }
    }
    log("pause engine: automatic continuation claim gave up after repeated revision conflicts");
    return null;
  }

  /**
   * Withdraws a claim that was never sent (the chat was found busy at the last read, the session
   * changed, or the engine stopped before admitting the send), so the continuation waits again; only
   * this engine's own unsent, unresolved automatic record is removed. The caller calls it only where no
   * send was started, so it also runs after the abort: a claim known to be unsent is never stranded.
   */
  async function withdrawContinuation(x: AutoTarget, id: string): Promise<void> {
    for (let i = 0; i <= maxConflicts; i++) {
      const project = await readProject(x.projectId, true);
      if (project === null) return;
      try {
        await project.store.transact(project.read.revision, (draft) => {
          const s = draft.sessions.find((y) => y.id === x.sessionId);
          const r = s?.retries?.find((y) => y.id === id);
          if (s === undefined || r === undefined || r.state !== "sending" || r.origin !== "automatic" || r.resolvedBy !== undefined) throw NO_CHANGE;
          const rest = (s.retries ?? []).filter((y) => y.id !== id);
          if (rest.length > 0) s.retries = rest;
          else delete s.retries;
        });
        return;
      } catch (e) {
        if (e === NO_CHANGE) return;
        if (isDomainError(e) && e.code === "revision_conflict") continue;
        fail("automatic continuation withdrawal", e);
        return;
      }
    }
    log("pause engine: automatic continuation withdrawal gave up after repeated revision conflicts");
  }

  /**
   * Admits the one send of a claimed record, like `admit` for card answers: inside `store.transact`, on
   * the state at the committed revision and under the lock every store commit of this process takes,
   * it checks `admissibleAutomatic` and, if it holds, starts the host call synchronously and writes
   * nothing; the call is awaited outside the lock. "stale": the claim no longer matches the session
   * (or the engine stopped), so nothing was sent; null: the store could not be read or written.
   */
  async function admitContinuation(x: AutoTarget, id: string, send: () => Promise<void>): Promise<{ call: Promise<void> } | "stale" | null> {
    for (let i = 0; i <= maxConflicts; i++) {
      if (stopped()) return "stale";
      const project = await readProject(x.projectId);
      if (project === null) return null;
      const admitted: { value?: { call: Promise<void> }; stale?: true } = {};
      try {
        await project.store.transact(project.read.revision, (draft) => {
          if (stopped() || !admissibleAutomatic(draft, x.sessionId, id)) {
            admitted.stale = true;
            throw NO_CHANGE;
          }
          admitted.value = { call: send() };
          throw NO_CHANGE;
        });
      } catch (e) {
        if (e === NO_CHANGE) return admitted.value ?? (admitted.stale === true ? "stale" : null);
        if (isDomainError(e) && e.code === "revision_conflict") continue;
        fail("automatic continuation admission", e);
        return admitted.value ?? null;
      }
    }
    log("pause engine: automatic continuation admission gave up after repeated revision conflicts");
    return null;
  }

  /** The outcome of the automatic send, written only while its record is still `sending`. */
  async function settleContinuation(x: AutoTarget, id: string, state: "sent" | "failed" | "unknown", error?: string): Promise<void> {
    for (let i = 0; i <= maxConflicts; i++) {
      const project = await readProject(x.projectId);
      if (project === null) return;
      try {
        await project.store.transact(project.read.revision, (draft) => {
          if (stopped()) throw NO_CHANGE;
          const r = draft.sessions.find((s) => s.id === x.sessionId)?.retries?.find((y) => y.id === id);
          // The owner's mark, the timeline check or the start-up sweep may have settled it already.
          if (r === undefined || r.state !== "sending") throw NO_CHANGE;
          r.state = state;
          if (error !== undefined) r.error = error;
        });
        return;
      } catch (e) {
        if (e === NO_CHANGE) return;
        if (isDomainError(e) && e.code === "revision_conflict") continue;
        fail("automatic continuation outcome", e);
        return;
      }
    }
    log("pause engine: automatic continuation outcome gave up after repeated revision conflicts");
  }

  /** One decision for `agent`: at most one message, sent only to an idle chat with nothing pending. */
  async function continueOnce(agent: { id: string; cwd?: string }, paseo: PaseoApi, known: Iterable<string>): Promise<void> {
    const newId = deps.newId;
    if (newId === undefined || stopped()) return;
    const projects = await projectsOf(agent, paseo);
    for (const p of known) projects.add(p);
    const targets = await automaticTargets(agent.id, projects);
    if (targets.length === 0 || stopped()) return;
    // A send to a running chat would interrupt it, and any send clears the chat's pending permissions
    // and questions. This read only avoids claiming while the chat is busy; the read that admits the
    // send is taken after the claim.
    let read = await readAgent(paseo, agent.id, HOST_CALL_TIMEOUT_MS);
    // No host call follows a stop that landed while the read was in flight.
    if (stopped()) return;
    if (closedNotArchived(read)) {
      // A chat the host closed after idling is not idle until it is loaded; loading it interrupts
      // nothing, and its state is then read again. Loading starts the chat's session again, so it is
      // done only for a continuation that is still due on the latest store (the owner may have
      // finished, rebound or moved on while the read was in flight). A load already issued cannot be
      // withdrawn. A failed or slow load sends nothing.
      if ((await automaticTargets(agent.id, projects)).length === 0) return;
      const loaded = await loadChat(paseo, agent.id);
      if (loaded !== "loaded") {
        log(`pause engine: automatic continuation waits (chat closed, load ${loaded}) agent=${fingerprint(agent.id)}`);
        return;
      }
      if (stopped()) return;
      read = await readAgent(paseo, agent.id, HOST_CALL_TIMEOUT_MS);
      if (stopped()) return;
    }
    const why = notReady(read);
    if (why !== null) {
      log(`pause engine: automatic continuation waits (${why}) agent=${fingerprint(agent.id)}`);
      return;
    }
    for (const x of targets) {
      const id = newId();
      const claimed = await claimContinuation(x, id);
      if (claimed === null) continue;
      if (stopped()) {
        await withdrawContinuation(x, id);
        return;
      }
      // The last check, as close to the send as the host allows, and short: a slow or failed read
      // admits nothing. The claim was never sent, so withdrawing it is exact.
      const late = notReady(await readAgent(paseo, agent.id, SUPPORT_TIMEOUT_MS));
      if (late !== null || stopped()) {
        log(`pause engine: automatic continuation withdrawn before sending (${late ?? "stopped"}) agent=${fingerprint(agent.id)}`);
        await withdrawContinuation(x, id);
        return;
      }
      // Committed `sending` above; this is the record's only send, started under the store lock only
      // while the claim still matches the session. Its outcome is written when it settles, also after
      // this bounded wait; a record left `sending` becomes `unknown` at the next start.
      // The async wrapper invokes the host call synchronously, i.e. while the admission holds the lock.
      const send = () =>
        (async () => paseo.agents.ref(claimed.agentId).send(claimed.text, { messageId: id }))()
          .then(
            () => settleContinuation(x, id, "sent"),
            (e: unknown) => {
              const state = classifySendError(e);
              log(`pause engine: automatic continuation ${state}: ${e instanceof Error ? e.name : "error"}`);
              return settleContinuation(x, id, state, recordedError(e, state));
            },
          )
          .catch((e: unknown) => fail("automatic continuation", e));
      const admitted = await admitContinuation(x, id, send);
      if (admitted === "stale") {
        // Finished, rebound, a newer operation, or settled by the owner meanwhile: never sent. Only a
        // claim still unsent and unresolved is withdrawn; an owner's mark stays as written.
        log(`pause engine: automatic continuation withdrawn: the session changed before sending agent=${fingerprint(agent.id)}`);
        await withdrawContinuation(x, id);
        return;
      }
      // Unreadable or unwritable store: nothing was sent; the claim stays `sending` and becomes `unknown`.
      if (admitted === null) return;
      const limit = sleep(HOST_CALL_TIMEOUT_MS, true);
      try {
        await Promise.race([admitted.call, limit.wait]);
      } finally {
        limit.cancel();
      }
      // The chat is no longer idle: any other target waits for its next turn end.
      return;
    }
  }

  /**
   * Continues the accepted blocks of `agent` that qualify. Concurrent triggers for one agent run one
   * after the other: a trigger arriving during a decision asks for one more pass, so a turn end that
   * follows a "chat running" read is not lost. Correctness never rests on this: every record is
   * claimed under the store lock.
   */
  async function continueAutomatically(agent: { id: string; cwd?: string }, paseo: PaseoApi | null, known: Iterable<string> = []): Promise<void> {
    if (paseo === null || deps.newId === undefined || stopped()) return;
    if (continuing.has(agent.id)) {
      continuing.set(agent.id, true);
      return;
    }
    continuing.set(agent.id, false);
    const projects = [...known];
    let again = false;
    try {
      for (let pass = 1; ; pass++) {
        await continueOnce(agent, paseo, projects);
        if (continuing.get(agent.id) !== true) return;
        continuing.set(agent.id, false);
        if (pass === MAX_CONTINUE_PASSES) {
          again = true;
          break;
        }
      }
    } finally {
      continuing.delete(agent.id);
    }
    // Triggers kept arriving through every pass: the last one is served after a pause, never dropped
    // and never in a tight loop.
    if (again && !stopped()) {
      spawn(async () => {
        if (await sleep(CONTINUE_RETRY_DELAY_MS).wait) await continueAutomatically(agent, paseo, projects);
      });
    }
  }

  /** Brings one live operation in line with what the host shows now (reload, restart, turn end, Accept). */
  async function reconcileOne(x: Candidate, read: AgentRead, lostReason: string): Promise<void> {
    const { c } = x;
    if (stopped() || answering.has(keyOf(x, c.operationId)) || read.kind === "failed") return;
    if (read.kind === "missing") {
      await transition(x.projectId, x.sessionId, (cur, at) => (same(cur, c) ? { ...cur, state: "pause_lost", reason: "unavailable", at } : null));
      return;
    }
    const archivedAt = read.agent.archivedAt;
    if (typeof archivedAt === "string" && archivedAt !== "") {
      await transition(x.projectId, x.sessionId, (cur, at) => (same(cur, c) ? { ...cur, state: "pause_lost", reason: "archived", at } : null));
      return;
    }
    if (c.state === "awaiting_pause" || c.state === "accepted_awaiting_pause") {
      const target = { agentId: c.target.agentId, operationId: c.operationId };
      let card: Omit<PauseSnapshot, "seenAt"> | undefined;
      let mismatch: string | undefined;
      for (const r of read.agent.pendingPermissions) {
        const m = matchPause({ id: c.target.agentId }, r, target);
        if (m.kind === "match") card = m.snapshot;
        else if (m.kind === "mismatch") mismatch ??= m.reason;
      }
      if (card === undefined && mismatch !== undefined) {
        // This operation's own token on a deviating card: recorded exactly as the hook path does, never answered.
        const reason = mismatch;
        await transition(x.projectId, x.sessionId, (cur, at) => {
          if (!same(cur, c)) return null;
          return cur.state === "awaiting_pause"
            ? { ...cur, state: "pause_mismatch", reason, at }
            : { ...cur, state: "needs_manual", reason: `pause_mismatch: ${reason}`, at };
        });
      } else if (card !== undefined) {
        const pause = card;
        if (c.state === "awaiting_pause") {
          await transition(x.projectId, x.sessionId, (cur, at) => (same(cur, c) ? { ...cur, state: "paused", pause: { ...pause, seenAt: at }, at } : null));
        } else {
          await claimAndAnswer(x, c, (cur, at) => ({ ...cur, state: "resolving", attempts: cur.attempts + 1, pause: { ...pause, seenAt: at }, at }));
        }
      } else if (c.state === "accepted_awaiting_pause" && read.agent.status === "idle") {
        await transition(x.projectId, x.sessionId, (cur, at) => (same(cur, c) ? { ...cur, state: "needs_manual", reason: "no_pause", at } : null));
      }
      return;
    }
    const card = pendingCard(read, c);
    if (c.state === "paused") {
      if (card === "gone") {
        await transition(x.projectId, x.sessionId, (cur, at) =>
          same(cur, c) ? (cur.resolution !== undefined ? settled(cur, at) : { ...cur, state: "pause_lost", reason: lostReason, at }) : null,
        );
      }
      return;
    }
    if (c.state === "resolving") {
      if (card === "gone") {
        await transition(x.projectId, x.sessionId, (cur, at) => (same(cur, c) ? settled(cur, at) : null));
      } else if (c.attempts >= MAX_ATTEMPTS) {
        await transition(x.projectId, x.sessionId, (cur, at) => (same(cur, c) ? { ...cur, state: "needs_manual", reason: "answer_failed", at } : null));
      } else {
        await claimAndAnswer(x, c, (cur, at) => ({ ...cur, attempts: cur.attempts + 1, at }));
      }
    }
  }

  /**
   * Runs `body` and logs instead of throwing: the engine never fails a hook or a caller. Every entry
   * point runs through here, so `idle()` also covers work started without awaiting it (the host-context
   * subscriber's reconcile); nothing new starts once stopped.
   */
  function guarded(what: string, body: () => Promise<void>): Promise<void> {
    if (stopped()) return Promise.resolve();
    const p = body().catch((e: unknown) => fail(what, e));
    running.add(p);
    void p.finally(() => running.delete(p));
    return p;
  }

  const isLive = (c: Continuation) => !isTerminalContinuation(c.state);

  return {
    remember,

    permissionRequested: ({ agent, request }, paseo) =>
      guarded("permission request", async () => {
        for (const x of await candidates(agent, paseo, (c) => LIVE_PENDING.includes(c.state))) {
          const m = matchPause(agent, request, { agentId: x.c.target.agentId, operationId: x.c.operationId });
          if (m.kind === "stale") {
            log(`pause engine: stale_operation card ignored agent=${fingerprint(agent.id)}`);
          } else if (m.kind === "mismatch") {
            await transition(x.projectId, x.sessionId, (cur, at) => {
              if (!same(cur, x.c)) return null;
              return cur.state === "awaiting_pause"
                ? { ...cur, state: "pause_mismatch", reason: m.reason, at }
                : { ...cur, state: "needs_manual", reason: `pause_mismatch: ${m.reason}`, at };
            });
          } else if (m.kind === "match") {
            const pause = m.snapshot;
            if (x.c.state === "awaiting_pause") {
              await transition(x.projectId, x.sessionId, (cur, at) => (same(cur, x.c) ? { ...cur, state: "paused", pause: { ...pause, seenAt: at }, at } : null));
            } else {
              await claimAndAnswer(x, x.c, (cur, at) => ({ ...cur, state: "resolving", attempts: cur.attempts + 1, pause: { ...pause, seenAt: at }, at }));
            }
          }
        }
      }),

    permissionResolved: ({ agent, requestId, resolution }, paseo) =>
      guarded("permission resolution", async () => {
        // The canonical event for the card: fenced on the operation and request, not on the state
        // observed earlier, so it also confirms an outcome this engine had to leave `unknown`.
        const accept = (c: Continuation) => c.pause?.requestId === requestId && resolvable(c);
        for (const x of await candidates(agent, paseo, accept)) {
          await transition(x.projectId, x.sessionId, (cur, at) => {
            if (cur.operationId !== x.c.operationId || cur.pause?.requestId !== requestId || !resolvable(cur)) return null;
            if (cur.state === "paused") {
              return { ...cur, state: "pause_answered_externally", resolution: { behavior: resolution.behavior, at, source: "external" }, at };
            }
            if (lostBeforeAccept(cur)) {
              // Recorded exactly as for `paused`; the lost reason is replaced by the canonical resolution.
              const { reason: _lost, ...rest } = cur;
              return { ...rest, state: "pause_answered_externally", resolution: { behavior: resolution.behavior, at, source: "external" }, at };
            }
            const source = attributeResolution(resolution, cur.pause, cur.summary);
            const recorded = { behavior: resolution.behavior, at, source };
            if (source === "plugin") return { ...cur, state: "resumed", resolution: recorded, at };
            if (source === "external") return { ...cur, state: "pause_answered_externally", resolution: recorded, at };
            // Unattributed: record it; the answer call's own outcome decides.
            return { ...cur, resolution: recorded, at };
          });
        }
        // A resolved prompt may have been the only thing holding an automatic continuation back.
        await continueAutomatically(agent, paseo);
      }),

    turnEnded: ({ agent, outcome }, paseo) =>
      guarded("turn end", async () => {
        const found = await candidates(agent, paseo, isLive);
        let read: AgentRead | undefined;
        for (const x of found) {
          if (x.c.state === "awaiting_pause") {
            await transition(x.projectId, x.sessionId, (cur, at) => (same(cur, x.c) ? { ...cur, state: "pause_lost", reason: "no_pause", at } : null));
          } else if (x.c.state === "accepted_awaiting_pause") {
            await transition(x.projectId, x.sessionId, (cur, at) => (same(cur, x.c) ? { ...cur, state: "needs_manual", reason: "no_pause", at } : null));
          } else {
            if (stopped()) return;
            read ??= await readAgent(paseo, agent.id, HOST_CALL_TIMEOUT_MS);
            await reconcileOne(x, read, `turn_ended:${outcome.kind}`);
          }
        }
        await continueAutomatically(agent, paseo);
      }),

    agentGone: ({ agent }, why, paseo) =>
      guarded("agent gone", async () => {
        for (const x of await candidates(agent, paseo, isLive)) {
          if (answering.has(keyOf(x, x.c.operationId))) continue;
          await transition(x.projectId, x.sessionId, (cur, at) => (same(cur, x.c) ? { ...cur, state: "pause_lost", reason: why, at } : null));
        }
      }),

    afterAccept: (x) =>
      guarded("after accept", async () => {
        const project = await readProject(x.projectId);
        const s = project?.read.data.sessions.find((y) => y.id === x.sessionId);
        const c = s?.continuation;
        if (s === undefined || c === undefined || c.operationId !== x.operationId || !bound(s, c)) return;
        remember(c.target.agentId, x.projectId);
        if (c.state === "resolving") {
          // The Accept transaction committed the claim of this attempt; this process answers it.
          const key = keyOf(x, c.operationId);
          if (answering.has(key)) return;
          answering.add(key);
          spawn(() => answerChain(x, c));
          return;
        }
        if (c.state === "accepted_awaiting_pause") {
          if (stopped()) return;
          await reconcileOne({ ...x, c }, await readAgent(deps.paseo(), c.target.agentId, HOST_CALL_TIMEOUT_MS), "restart");
        }
        // Accepted without a card to answer (or the turn already ended without one): the chat bound by
        // Discuss is given the block by one message, when it is idle with nothing pending.
        await continueAutomatically({ id: c.target.agentId }, deps.paseo(), [x.projectId]);
      }),

    reconcileAll: (paseo) =>
      guarded("reconcile", async () => {
        const projects = await deps.directory(paseo).listProjects();
        for (const p of projects) {
          const project = await readProject(p.projectId);
          if (project === null) continue;
          const reads = new Map<string, AgentRead>();
          for (const s of project.read.data.sessions) {
            const c = s.continuation;
            if (c === undefined || !isLive(c) || !bound(s, c)) continue;
            remember(c.target.agentId, p.projectId);
            let read = reads.get(c.target.agentId);
            if (stopped()) return;
            if (read === undefined) {
              read = await readAgent(paseo, c.target.agentId, HOST_CALL_TIMEOUT_MS);
              reads.set(c.target.agentId, read);
            }
            await reconcileOne({ projectId: p.projectId, sessionId: s.id, c }, read, "restart");
          }
          // Continuations decided while this process was not running, still waiting for the chat, or
          // made due by the reconcile above: each chat bound by Discuss is checked on a fresh read.
          const discussionChats = new Set(project.read.data.sessions.flatMap((s) => (s.planner?.boundBy === "discussion" && s.status === "active" ? [s.planner.agentId] : [])));
          for (const agentId of discussionChats) await continueAutomatically({ id: agentId }, paseo, [p.projectId]);
        }
      }),

    idle: async () => {
      while (running.size > 0) await Promise.allSettled([...running]);
    },
  };
}

/**
 * Registers the five 0.12 lifecycle hooks (0.14/0.15 aliases). Every handler records the host
 * context in the holder and never throws or rejects; the returned function unregisters all of them.
 */
export function registerPauseEngine(server: Pick<PluginServerContext, "on">, engine: PauseEngine, holder: ReturnType<typeof createPaseoHolder>): () => void {
  const safe = async (paseo: PaseoApi, run: () => Promise<void>) => {
    holder.set(paseo);
    await Promise.resolve()
      .then(run)
      .catch(() => undefined);
  };
  const off = [
    server.on("agent.permission_requested", (e, ctx) => safe(ctx.paseo, () => engine.permissionRequested(e, ctx.paseo))),
    server.on("agent.permission_resolved", (e, ctx) => safe(ctx.paseo, () => engine.permissionResolved(e, ctx.paseo))),
    server.on("agent.turn_ended", (e, ctx) => safe(ctx.paseo, () => engine.turnEnded(e, ctx.paseo))),
    server.on("agent.archived", (e, ctx) => safe(ctx.paseo, () => engine.agentGone(e, "archived", ctx.paseo))),
    server.on("agent.closed", (e, ctx) => safe(ctx.paseo, () => engine.agentGone(e, "closed", ctx.paseo))),
  ];
  return () => {
    for (const unregister of off) unregister();
  };
}
