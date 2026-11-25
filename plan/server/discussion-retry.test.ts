// Retry of a manual continuation: at most one send per retry record, never exactly-once. The
// record is committed as `sending` before the single send, whose message id is the record id and
// whose text carries the token [DR-RETRY-<id>] with the accepted block's snapshot summary; no
// active-turn mode is passed. The outcome is written with a bounded compare-and-set: `sent` when
// the host accepted the message, `failed` only for rejections that happen before dispatch, and
// `unknown` for everything else. A record left `sending` is turned `unknown` by the start-up sweep;
// it is confirmed only by the token in the planner's timeline or by the owner's explicit mark.
// Nothing is ever sent again automatically.
//
// Real temp stores and commands; the host is a deterministic synthetic fake; daemon errors are the
// SDK's own classes. No model is invoked.
import type { PaseoApi } from "@getpaseo/client";
import { DaemonAuthenticationError, DaemonConnectionError } from "@getpaseo/client/internal/daemon-client";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { canonicalJson } from "../shared/canonical";
import { DomainError } from "../shared/errors";
import type { RoadmapData } from "../shared/model";
import { roadmapSettings } from "../shared/settings";
import { createRoadmapCommands, UI_ORIGIN, type StoreOpener } from "./sessions";
import { openProjectStore } from "./store-root";
import { fixedClock, NOW, nextId, opt } from "./test-support/build";
import { fakeDirectory } from "./test-support/fake-dir";
import { binding, BLK_OPEN, continuationIn, OP, PLANNER, seedGrilling } from "./test-support/grilling";
import { makeProject, ok as okCommand, type TestProject } from "./test-support/service";

const P = "prj_test";
const PREFIX = "Decision Roadmap (manual continuation)";
const later = (ms: number) => () => new Date(NOW.getTime() + ms);

const Failure = z.object({ ok: z.literal(false), error: z.looseObject({ code: z.string(), message: z.string() }) });
const resultOf = <T extends z.ZodType>(value: T) => z.union([z.object({ ok: z.literal(true), value }), Failure]);
const RetryResult = resultOf(z.looseObject({ revision: z.number().int(), retryId: z.string(), sentTo: z.string(), state: z.enum(["sent", "sending"]) }));
const ResolveResult = resultOf(z.looseObject({ revision: z.number().int() }));
const CheckResult = resultOf(z.looseObject({ state: z.enum(["sending", "sent", "failed", "unknown"]) }));
type Res<T> = { ok: true; value: T } | z.infer<typeof Failure>;
const ok = <T>(r: Res<T>): T => {
  if (!r.ok) throw new Error(`expected ok, got ${r.error.code}: ${r.error.message}`);
  return r.value;
};
const err = <T>(r: Res<T>) => {
  if (r.ok) throw new Error(`expected an error, got ok: ${JSON.stringify(r.value)}`);
  return r.error;
};
const RetryRecord = z.looseObject({
  id: z.string(),
  at: z.string(),
  operationId: z.string().optional(),
  blockId: z.string(),
  agentId: z.string(),
  epoch: z.number().int(),
  state: z.enum(["sending", "sent", "failed", "unknown"]),
  error: z.string().optional(),
  resolvedAt: z.string().optional(),
  resolvedBy: z.enum(["user", "sweep", "timeline"]).optional(),
});
const recordsOf = (session: unknown) => z.looseObject({ retries: z.array(RetryRecord).optional() }).parse(session).retries ?? [];

const modulePath = "./discussion";
/** One export of server/discussion.ts, loaded without a static import so each case fails on its own. */
async function exported(name: string): Promise<(...args: unknown[]) => unknown> {
  const mod: unknown = await import(/* @vite-ignore */ modulePath);
  const fn: unknown = typeof mod === "object" && mod !== null ? Object.entries(mod).find(([k]) => k === name)?.[1] : undefined;
  if (typeof fn !== "function") throw new Error(`missing export: discussion.${name}`);
  return (...args: unknown[]): unknown => {
    const out: unknown = Reflect.apply(fn, undefined, args);
    return out;
  };
}

let project: TestProject | undefined;
afterEach(async () => {
  await project?.cleanup();
  project = undefined;
});

function gate() {
  let release: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => (release = resolve));
  return { promise, release };
}

/**
 * A session whose accepted block BLK_OPEN (Q1 answered a) left its operation needing manual
 * continuation: the planner could not pause natively, so Accept moved the operation to
 * needs_manual with the block's summary.
 */
async function setup(opts: { needsManual?: boolean } = { needsManual: true }) {
  project = await makeProject();
  const proj = project;
  const dir = fakeDirectory({ projects: [{ projectId: P, projectRootPath: proj.root, projectKind: "git" }] });
  const storeOptions = { now: fixedClock, newId: nextId, log: () => undefined };
  const commands = createRoadmapCommands({ directory: () => dir, now: fixedClock, newId: nextId, storeOptions });
  const realOpen: StoreOpener = (projectId) => openProjectStore(dir, projectId, storeOptions);

  // Injected revision races: while armed, the next `conflicts` store writes through this opener fail
  // like a concurrent writer won, and every write attempt is counted.
  const race = { armed: false, conflicts: 0, attempts: 0 };
  const open: StoreOpener = async (projectId) => {
    const store = await realOpen(projectId);
    return {
      ...store,
      transact: <T>(expectedRevision: number, fn: (draft: RoadmapData) => T) => {
        if (race.armed) {
          race.attempts += 1;
          if (race.conflicts > 0) {
            race.conflicts -= 1;
            return Promise.reject(new DomainError("revision_conflict", "store revision changed", { expected: expectedRevision }));
          }
        }
        return store.transact(expectedRevision, fn);
      },
    };
  };

  okCommand(await commands.init(realOpen, { projectId: P }, UI_ORIGIN));
  const revision = async () => okCommand(await commands.version(realOpen, { projectId: P }, UI_ORIGIN)).revision!;
  const data = async (): Promise<RoadmapData> => {
    const read = await (await realOpen(P)).read();
    if (read.status !== "ok") throw new Error(`expected ok store, got ${read.status}`);
    return read.data;
  };
  const sessionId = okCommand(await commands.sessionCreate(realOpen, { projectId: P, expectedRevision: await revision(), title: "[feature] Login" }, UI_ORIGIN)).sessionId;
  const [q1] = okCommand(
    await commands.questionCreateBatch(
      realOpen,
      { projectId: P, expectedRevision: await revision(), sessionId, blockId: BLK_OPEN, questions: [{ title: "Q1", context: "", options: [opt("a"), opt("b")], allowFreeText: false, activatedBy: [], invalidatedBy: [] }] },
      { source: "chat", actor: { kind: "agent" } },
    ),
  ).questionIds;
  okCommand(await commands.questionAnswer(realOpen, { projectId: P, expectedRevision: await revision(), sessionId, questionId: q1, optionId: "a" }, UI_ORIGIN));
  await seedGrilling(realOpen, P, sessionId, {
    planner: binding(),
    ...(opts.needsManual === true ? { continuation: continuationIn("unsupported", { reason: "codex default mode" }) } : {}),
  });
  okCommand(await commands.blockAccept(realOpen, { projectId: P, expectedRevision: await revision(), sessionId, blockId: BLK_OPEN }, UI_ORIGIN));
  const session = async () => (await data()).sessions.find((s) => s.id === sessionId)!;
  const snapshotSummary = async () => {
    const block = (await session()).blocks?.find((b) => b.id === BLK_OPEN);
    return block?.state === "accepted" ? block.summary : undefined;
  };

  const host = {
    sent: [] as Array<{ agentId: string; text: string; options: Record<string, unknown> | undefined; recordsAtSend: z.infer<typeof RetryRecord>[] }>,
    refetches: [] as Array<{ agentId: string; options: unknown }>,
    timeline: [] as Array<{ item: { type: string; text?: string }; seqStart: number; seqEnd: number }>,
    failSend: undefined as unknown,
    sendGate: undefined as ReturnType<typeof gate> | undefined,
    sendIssued: gate(),
    onSend: undefined as undefined | (() => Promise<void> | void),
  };
  const paseo = {
    agents: {
      ref: (agentId: string) => ({
        id: agentId,
        send: async (text: string, options?: Record<string, unknown>) => {
          host.sent.push({ agentId, text, options, recordsAtSend: recordsOf(await session()) });
          host.sendIssued.release();
          if (host.onSend) await host.onSend();
          if (host.sendGate) await host.sendGate.promise;
          if (host.failSend !== undefined) throw host.failSend;
        },
        timeline: { refetch: async (options: unknown) => (host.refetches.push({ agentId, options }), { entries: host.timeline }) },
      }),
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- synthetic host: only the PaseoApi members the commands use exist
  const fakePaseo = paseo as unknown as PaseoApi;
  const deps = (over: Record<string, unknown> = {}) => ({
    open,
    commands,
    settings: async () => roadmapSettings.schema.parse({}),
    directory: () => dir,
    state: { grantForAgent: async () => null, grantsIssuedSince: async () => 0 },
    now: fixedClock,
    newId: nextId,
    log: () => undefined,
    ...over,
  });
  const retry = async (extra: { expectedRevision?: number; deps?: Record<string, unknown> } = {}) =>
    RetryResult.parse(await (await exported("retryContinuation"))(extra.deps ?? deps(), fakePaseo, { projectId: P, expectedRevision: extra.expectedRevision ?? (await revision()), sessionId }));
  const resolve = async (retryId: string, outcome: "delivered" | "not_delivered", expectedRevision?: number) =>
    ResolveResult.parse(await (await exported("resolveRetry"))(deps(), { projectId: P, expectedRevision: expectedRevision ?? (await revision()), sessionId, retryId, outcome }));
  const check = async (retryId: string) => CheckResult.parse(await (await exported("checkRetry"))(deps(), fakePaseo, { projectId: P, sessionId, retryId }));
  const sweep = async (nowMs: number, olderThanMs = 60_000) => {
    await (await exported("sweepStaleRetries"))(deps({ now: later(nowMs) }), P, olderThanMs);
  };
  const records = async () => recordsOf(await session());
  const lastRetry = async () => {
    const view = okCommand(await commands.sessionGet(realOpen, { projectId: P, sessionId }, UI_ORIGIN));
    return z.looseObject({ retryCount: z.number().optional(), lastRetry: z.looseObject({ id: z.string(), state: z.string() }).optional() }).parse(view.grilling ?? {});
  };
  const snapshot = async () => ({ revision: await revision(), text: canonicalJson(await data()) });
  return { commands, realOpen, revision, data, session, sessionId, snapshotSummary, host, deps, retry, resolve, check, sweep, records, lastRetry, snapshot, race };
}

describe("a retry is refused before anything is sent", () => {
  it("when the operation does not need manual continuation", async () => {
    const t = await setup({ needsManual: false });
    const before = await t.snapshot();
    expect(err(await t.retry()).code).toBe("invalid_input");
    expect(t.host.sent).toEqual([]);
    expect(await t.snapshot()).toEqual(before);
  });

  it("two simultaneous presses at one revision: one is a revision_conflict before any send", async () => {
    const t = await setup();
    const rev = await t.revision();
    const results = await Promise.all([t.retry({ expectedRevision: rev }), t.retry({ expectedRevision: rev })]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    const refused = results.find((r) => !r.ok);
    expect(refused !== undefined && !refused.ok ? refused.error.code : undefined).toBe("revision_conflict");
    expect(t.host.sent).toHaveLength(1);
  });
});

describe("one send, after the record", () => {
  it("commits a sending record, then sends once with the record id as message id and token, the snapshot summary and no turn mode", async () => {
    const t = await setup();
    const out = ok(await t.retry());
    expect(out).toMatchObject({ sentTo: PLANNER, state: "sent" });

    expect(t.host.sent).toHaveLength(1);
    const sent = t.host.sent[0];
    expect(sent.agentId).toBe(PLANNER);
    // The record existed, as sending, before the send.
    expect(sent.recordsAtSend.map((r) => ({ id: r.id, state: r.state }))).toEqual([{ id: out.retryId, state: "sending" }]);
    expect(sent.recordsAtSend[0]).toMatchObject({ operationId: OP, blockId: BLK_OPEN, agentId: PLANNER, epoch: 1 });
    expect(sent.options).toEqual({ messageId: out.retryId });
    expect(sent.options ?? {}).not.toHaveProperty("activeTurnBehavior");
    expect(sent.text.startsWith(`${PREFIX} [DR-RETRY-${out.retryId}]:\n`)).toBe(true);
    const summary = await t.snapshotSummary();
    expect(summary).toBeDefined();
    expect(sent.text).toContain(summary!);
    expect(sent.text).toContain("roadmap_ask");
    expect(sent.text).toContain("roadmap_grill_propose_finish");

    expect(await t.records()).toEqual([expect.objectContaining({ id: out.retryId, state: "sent" })]);
    expect(await t.lastRetry()).toMatchObject({ retryCount: 1, lastRetry: { id: out.retryId, state: "sent" } });
  });

  it("a later press is refused once a retry was sent", async () => {
    const t = await setup();
    ok(await t.retry());
    const before = await t.snapshot();
    expect(err(await t.retry()).message).toMatch(/already sent/);
    expect(t.host.sent).toHaveLength(1);
    expect(await t.snapshot()).toEqual(before);
  });
});

describe("rejections: failed only before dispatch, unknown otherwise", () => {
  it("classifies only the authentication refusal and the daemon's agent-not-found as failed", async () => {
    const classify = await exported("classifySendError");
    expect(classify(new DaemonAuthenticationError("password_required"))).toBe("failed");
    expect(classify(new Error(`Agent not found: ${PLANNER}`))).toBe("failed");
    expect(classify(new DaemonConnectionError("socket closed", "DAEMON_CONNECTION_LOST"))).toBe("unknown");
    expect(classify(new DaemonConnectionError("timeout", "DAEMON_REQUEST_TIMEOUT"))).toBe("unknown");
    expect(classify(new Error("Failed to send agent message"))).toBe("unknown");
    expect(classify(new Error(`agent not found: ${PLANNER}`))).toBe("unknown");
    expect(classify("boom")).toBe("unknown");
  });

  it("a pre-dispatch rejection records failed with its reason and lets the owner retry; the next retry is a new record", async () => {
    const t = await setup();
    t.host.failSend = new Error(`Agent not found: ${PLANNER}`);
    expect((await t.retry()).ok).toBe(false);
    const [first] = await t.records();
    expect(first).toMatchObject({ state: "failed", error: `Agent not found: ${PLANNER}` });
    t.host.failSend = undefined;
    const out = ok(await t.retry());
    expect(out.retryId).not.toBe(first.id);
    expect(t.host.sent.map((s) => s.options?.messageId)).toEqual([first.id, out.retryId]);
  });

  it("any other rejection records unknown and blocks further retries without a resend", async () => {
    const t = await setup();
    t.host.failSend = new DaemonConnectionError("timeout", "DAEMON_REQUEST_TIMEOUT");
    expect((await t.retry()).ok).toBe(false);
    expect((await t.records())[0]).toMatchObject({ state: "unknown" });
    t.host.failSend = undefined;
    expect(err(await t.retry()).message).toMatch(/unknown/);
    expect(t.host.sent).toHaveLength(1);
  });
});

describe("a send whose outcome was never written", () => {
  it("stays sending while in flight and blocks a second press", async () => {
    const t = await setup();
    t.host.sendGate = gate();
    const first = t.retry();
    // Waits for the send, or for the retry to end without one (a failure, asserted below).
    await Promise.race([t.host.sendIssued.promise, first.then(() => undefined, () => undefined)]);
    expect(t.host.sent).toHaveLength(1);
    expect((await t.records())[0]).toMatchObject({ state: "sending" });
    expect((await t.retry()).ok).toBe(false);
    t.host.sendGate.release();
    ok(await first);
    expect(t.host.sent).toHaveLength(1);
  });

  it("the start-up sweep turns a stale sending record unknown and sends nothing; a recent one is left alone", async () => {
    const t = await setup();
    t.host.sendGate = gate();
    const pending = t.retry().catch(() => undefined);
    await Promise.race([t.host.sendIssued.promise, pending]);
    expect(t.host.sent).toHaveLength(1);
    await t.sweep(10_000);
    expect((await t.records())[0]).toMatchObject({ state: "sending" });
    await t.sweep(120_000);
    expect((await t.records())[0]).toMatchObject({ state: "unknown", resolvedBy: "sweep" });
    expect(t.host.sent).toHaveLength(1);
  });

  it("a bounded compare-and-set: one lost race still records sent; persistent races leave sending and report it, never sent", async () => {
    const t = await setup();
    t.host.onSend = () => {
      t.race.armed = true;
      t.race.conflicts = 1;
    };
    expect(ok(await t.retry()).state).toBe("sent");
    expect((await t.records())[0]).toMatchObject({ state: "sent" });

    const u = await setup();
    u.host.onSend = () => {
      u.race.armed = true;
      u.race.conflicts = 1_000;
    };
    const out = ok(await u.retry());
    expect(out.state).toBe("sending");
    u.race.armed = false;
    expect((await u.records())[0]).toMatchObject({ state: "sending" });
    expect(u.race.attempts).toBeGreaterThan(1);
    expect(u.race.attempts).toBeLessThanOrEqual(4);
    expect(u.host.sent).toHaveLength(1);
  });

  it("a concurrent write between the record and the outcome is kept", async () => {
    const t = await setup();
    const [qid] = (await t.session()).questions.map((q) => q.id);
    t.host.onSend = async () => {
      okCommand(await t.commands.questionDiscuss(t.realOpen, { projectId: P, expectedRevision: await t.revision(), sessionId: t.sessionId, questionId: qid, text: "meanwhile" }, UI_ORIGIN));
    };
    expect(ok(await t.retry()).state).toBe("sent");
    expect((await t.records())[0]).toMatchObject({ state: "sent" });
    expect((await t.session()).questions[0].discussion.map((n) => n.text)).toContain("meanwhile");
  });
});

describe("reconciliation never resends", () => {
  async function unknownRetry() {
    const t = await setup();
    t.host.failSend = new Error("Failed to send agent message");
    expect((await t.retry()).ok).toBe(false);
    t.host.failSend = undefined;
    const [record] = await t.records();
    expect(record.state).toBe("unknown");
    return { t, retryId: record.id };
  }

  it("the token in a user message of the planner's timeline confirms sent; its absence, or an assistant echo, changes nothing", async () => {
    const { t, retryId } = await unknownRetry();
    t.host.timeline = [{ item: { type: "user_message", text: "unrelated" }, seqStart: 1, seqEnd: 1 }, { item: { type: "assistant_message", text: `quoting [DR-RETRY-${retryId}]` }, seqStart: 2, seqEnd: 2 }];
    const before = await t.snapshot();
    expect(ok(await t.check(retryId)).state).toBe("unknown");
    expect(await t.snapshot()).toEqual(before);

    t.host.timeline.push({ item: { type: "user_message", text: `${PREFIX} [DR-RETRY-${retryId}]:\nQ1 1` }, seqStart: 3, seqEnd: 3 });
    expect(ok(await t.check(retryId)).state).toBe("sent");
    expect((await t.records())[0]).toMatchObject({ state: "sent", resolvedBy: "timeline" });
    expect(t.host.refetches.every((r) => r.agentId === PLANNER)).toBe(true);
    expect(t.host.sent).toHaveLength(1);
  });

  it("the owner's not-delivered mark makes the record failed and re-enables Retry", async () => {
    const { t, retryId } = await unknownRetry();
    ok(await t.resolve(retryId, "not_delivered"));
    expect((await t.records())[0]).toMatchObject({ state: "failed", resolvedBy: "user" });
    ok(await t.retry());
    expect(t.host.sent).toHaveLength(2);
  });

  it("the owner's delivered mark makes the record sent and keeps Retry blocked", async () => {
    const { t, retryId } = await unknownRetry();
    ok(await t.resolve(retryId, "delivered"));
    expect((await t.records())[0]).toMatchObject({ state: "sent", resolvedBy: "user" });
    expect(err(await t.retry()).message).toMatch(/already sent/);
    expect(t.host.sent).toHaveLength(1);
  });

  it("a mark is revision-checked and refused on a settled record", async () => {
    const { t, retryId } = await unknownRetry();
    const before = await t.snapshot();
    expect(err(await t.resolve(retryId, "delivered", before.revision - 1)).code).toBe("revision_conflict");
    expect(await t.snapshot()).toEqual(before);
    ok(await t.resolve(retryId, "delivered"));
    expect(err(await t.resolve(retryId, "not_delivered")).code).toBe("invalid_input");
    expect(err(await t.resolve("no-such-retry", "delivered")).code).toBe("not_found");
  });

  it("reading the session, the sweep and checks send nothing", async () => {
    const { t, retryId } = await unknownRetry();
    await t.lastRetry();
    await t.sweep(600_000);
    await t.check(retryId);
    await t.check(retryId);
    expect(t.host.sent).toHaveLength(1);
  });
});

// Review regressions: a retry belongs to the current accepted block, its operation and the bound
// planner's epoch.
describe("retry scope", () => {
  it("after the owner rebinds the planner, one retry may reach the new planner; it is not sent twice", async () => {
    const t = await setup();
    const first = ok(await t.retry());
    expect(first.sentTo).toBe(PLANNER);
    okCommand(await t.commands.plannerSet(t.realOpen, { projectId: P, expectedRevision: await t.revision(), sessionId: t.sessionId, agentId: "agent-new", workspaceId: "ws-1" }, UI_ORIGIN));
    const second = ok(await t.retry());
    expect(second.sentTo).toBe("agent-new");
    expect((await t.records()).map((r) => [r.agentId, r.epoch, r.state])).toEqual([[PLANNER, 1, "sent"], ["agent-new", 2, "sent"]]);
    expect(t.host.sent[1].text).toContain((await t.snapshotSummary())!);
    expect(err(await t.retry()).message).toMatch(/already sent/);
    expect(t.host.sent.map((s) => s.agentId)).toEqual([PLANNER, "agent-new"]);
  });

  it("an operation on a new open block that needs manual continuation never resends the previous block's summary", async () => {
    const t = await setup();
    const previousSummary = (await t.snapshotSummary())!;
    const nextBlock = (await t.session()).blocks!.find((b) => b.state === "open")!.id;
    await seedGrilling(t.realOpen, P, t.sessionId, { continuation: continuationIn("unsupported", { operationId: "op-2", openBlockId: nextBlock, reason: "codex default mode" }) });
    const before = await t.snapshot();
    const out = await t.retry();
    expect(out.ok).toBe(false);
    expect(t.host.sent.filter((s) => s.text.includes(previousSummary))).toEqual([]);
    expect(t.host.sent).toEqual([]);
    expect(await t.snapshot()).toEqual(before);
  });
});

// What the owner sees: the session view the panel receives, read through the client's own action
// gate. Retry is offered again for a new manual-recovery operation and after a planner rebind, even
// though an earlier retry was sent; a retry already sent for the current operation keeps it blocked.
describe("Retry in the session view", () => {
  const headerPath = "../client/grilling-header";
  const retryAction = async (t: Awaited<ReturnType<typeof setup>>) => {
    const mod: unknown = await import(/* @vite-ignore */ headerPath);
    const fn: unknown = typeof mod === "object" && mod !== null ? Object.entries(mod).find(([k]) => k === "grillingActions")?.[1] : undefined;
    if (typeof fn !== "function") throw new Error("missing export: grilling-header.grillingActions");
    const view = okCommand(await t.commands.sessionGet(t.realOpen, { projectId: P, sessionId: t.sessionId }, UI_ORIGIN));
    const actions: unknown = Reflect.apply(fn, undefined, [view, { plannerStatus: "idle" }]);
    const retry: unknown = typeof actions === "object" && actions !== null && "retry" in actions ? actions.retry : undefined;
    return typeof retry === "object" && retry !== null ? Object.fromEntries(Object.entries(retry)) : null;
  };

  it("a sent retry blocks Retry for the current operation in the view", async () => {
    const t = await setup();
    expect(await retryAction(t)).toMatchObject({ enabled: true });
    ok(await t.retry());
    expect(await retryAction(t)).toMatchObject({ enabled: false });
    expect(err(await t.retry()).message).toMatch(/already sent/);
    expect(t.host.sent).toHaveLength(1);
  });

  it("after the owner rebinds the planner, the view offers Retry again, and one send blocks it again", async () => {
    const t = await setup();
    ok(await t.retry());
    okCommand(await t.commands.plannerSet(t.realOpen, { projectId: P, expectedRevision: await t.revision(), sessionId: t.sessionId, agentId: "agent-new", workspaceId: "ws-1" }, UI_ORIGIN));
    expect(await retryAction(t)).toMatchObject({ enabled: true });
    expect(ok(await t.retry()).sentTo).toBe("agent-new");
    expect(await retryAction(t)).toMatchObject({ enabled: false });
    expect(t.host.sent.map((s) => s.agentId)).toEqual([PLANNER, "agent-new"]);
  });

  it("a new manual-recovery operation on the next accepted block is offered Retry, and sends that block's summary once", async () => {
    const t = await setup();
    ok(await t.retry());
    const firstSummary = (await t.snapshotSummary())!;
    const next = (await t.session()).blocks!.find((b) => b.state === "open")!.id;
    const [q2] = okCommand(
      await t.commands.questionCreateBatch(
        t.realOpen,
        { projectId: P, expectedRevision: await t.revision(), sessionId: t.sessionId, blockId: next, questions: [{ title: "Q2", context: "", options: [opt("a"), opt("b")], allowFreeText: false, activatedBy: [], invalidatedBy: [] }] },
        { source: "chat", actor: { kind: "agent" } },
      ),
    ).questionIds;
    okCommand(await t.commands.questionAnswer(t.realOpen, { projectId: P, expectedRevision: await t.revision(), sessionId: t.sessionId, questionId: q2, optionId: "b" }, UI_ORIGIN));
    await seedGrilling(t.realOpen, P, t.sessionId, { continuation: continuationIn("unsupported", { operationId: "op-2", openBlockId: next, reason: "codex default mode" }) });
    okCommand(await t.commands.blockAccept(t.realOpen, { projectId: P, expectedRevision: await t.revision(), sessionId: t.sessionId, blockId: next }, UI_ORIGIN));

    expect(await retryAction(t)).toMatchObject({ enabled: true });
    ok(await t.retry());
    expect(t.host.sent).toHaveLength(2);
    expect(t.host.sent[1].text).not.toContain(firstSummary);
    expect(t.host.sent[1].text).toContain("Q2 2");
    expect(await retryAction(t)).toMatchObject({ enabled: false });
    expect(err(await t.retry()).message).toMatch(/already sent/);
    expect(t.host.sent).toHaveLength(2);
  });
});
