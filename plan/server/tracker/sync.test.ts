// Tracker preview/apply/reconcile (Stage 4 T4.4–T4.5) over a real temp store and real receipts.
// Faults: a wrapping Store whose transact aborts a draft that makes a chosen intent transition.
import { createHash } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Plan, RoadmapData } from "../../shared/model";
import type { TrackerSettings } from "../../shared/settings";
import type { StoreOpener, WriteOrigin } from "../sessions";
import { UI_ORIGIN } from "../sessions";
import { fixedClock, readJsonObject } from "../test-support/build";
import { startFakeSnailOrbit, type FakeSnailOrbit } from "../test-support/fake-snailorbit";
import { approvedPlan, fakeAdapter, setFakeRender, type AdapterStep } from "../test-support/tracker";
import { TrackerError, type RemoteIssue, type TrackerAdapter } from "./adapter";
import { decodeActionId, encodeActionId } from "./token";

const CHAT: WriteOrigin = { source: "chat", actor: { kind: "agent" }, quoted: "send it" };
const LIVE: TrackerSettings = { provider: "snailorbit", mode: "live", projectKey: "SYN", closeByProject: {} };
const DRY: TrackerSettings = { provider: "snailorbit", mode: "dry-run", projectKey: "SYN", closeByProject: {} };

type R<T> = { ok: true; value: T } | { ok: false; error: { code: string; message: string; details?: any } };
const ok = <T>(r: R<T>): T => {
  if (!r.ok) throw new Error(`expected ok, got ${r.error.code}: ${r.error.message}`);
  return r.value;
};
const err = <T>(r: R<T>) => {
  if (r.ok) throw new Error(`expected an error, got ${JSON.stringify(r.value)}`);
  return r.error;
};

// Load the lazily imported tracker and plan modules once: their cold import under a parallel full
// run exceeded the 5 s default on the first test (retained log stage4-server-green-full.log).
// Test timeouts and assertions are unchanged.
beforeAll(async () => {
  await Promise.all([import("./sync"), import("./token"), import("../plans"), import("../sessions")]);
  // The fake adapter renders with the production pure wire renderer (P4.6 C-WIRE).
  const { renderSnailOrbit } = await import("./snailorbit");
  setFakeRender((a) => renderSnailOrbit(a.kind, a.neutral, a.destination, (a.settings as { closeByProject?: Record<string, { field: string; value: string }> }).closeByProject?.[a.destination.projectKey]));
}, 60_000);

let env: Awaited<ReturnType<typeof approvedPlan>> | undefined;
afterEach(async () => {
  await env?.cleanup();
  env = undefined;
});

async function setup(opts: { tasks?: number; settings?: TrackerSettings } = {}) {
  env = await approvedPlan({ tasks: opts.tasks ?? 2 });
  const e = env;
  const settings = { current: opts.settings ?? DRY };
  const commands = (deps: Parameters<typeof e.tracker>[0] = {}) => e.tracker({ settings: async () => settings.current, ...deps });
  const plan = async (): Promise<Plan> => {
    const read = await (await e.open(e.P)).read();
    if (read.status !== "ok") throw new Error("store not ok");
    return read.data.plans.find((p) => p.id === e.planId)!;
  };
  const ref = { projectId: e.P, planId: e.planId };
  const actionable = (p: { actions: Array<{ actionId: string | null }> }) => p.actions.map((a) => a.actionId).filter((x): x is string => x !== null);
  return { e, settings, commands, plan, ref, actionable };
}

/** Wraps the real opener: a transact whose draft makes an intent transition matching `fail` is aborted. */
function faultOpener(real: StoreOpener, fail: (from: string | undefined, to: string, ticketsAdded: boolean) => boolean) {
  const hits = { n: 0 };
  const open: StoreOpener = async (projectId) => {
    const store = await real(projectId);
    return new Proxy(store, {
      get(target, prop, receiver) {
        if (prop === "transact") {
          return (expected: number, fn: (d: RoadmapData) => unknown) =>
            (target).transact(expected, (draft) => {
              const before = new Map(draft.plans.flatMap((p) => p.intents.map((i) => [i.intentId, i.state] as const)));
              const tickets = draft.plans.reduce((n, p) => n + p.tickets.length, 0);
              const out = fn(draft);
              const ticketsAdded = draft.plans.reduce((n, p) => n + p.tickets.length, 0) > tickets;
              for (const p of draft.plans) {
                for (const i of p.intents) {
                  if (before.get(i.intentId) !== i.state && fail(before.get(i.intentId), i.state, ticketsAdded)) {
                    hits.n++;
                    throw new Error("injected store failure");
                  }
                }
              }
              return out;
            });
        }
        const v: unknown = Reflect.get(target, prop, receiver);
        if (typeof v !== "function") return v;
        const bound: unknown = v.bind(target);
        return bound;
      },
    });
  };
  return { open, hits };
}

describe("preview", () => {
  it("requires a current approval: unapproved or re-answered plans are tracker_not_current", async () => {
    const s = await setup();
    const t = s.commands();
    // A new unapproved revision.
    ok(await s.e.plans.draft(s.e.open, { projectId: s.e.P, expectedRevision: await s.e.revision(), planId: s.e.planId, title: "v2", sessionIds: [s.e.seed.sessionId], markdown: "# v2", tasks: [] }, UI_ORIGIN));
    expect(err(await t.preview(s.e.open, s.ref, UI_ORIGIN)).code).toBe("tracker_not_current");
  });

  it("after an upstream re-answer it is tracker_not_current with reasons; a chat origin is invalid_input", async () => {
    const s = await setup();
    const t = s.commands();
    expect(err(await t.preview(s.e.open, s.ref, CHAT)).code).toBe("invalid_input");
    ok(await s.e.project.service.questionAnswer(s.e.project.paseo, { projectId: s.e.P, expectedRevision: await s.e.revision(), ...s.e.seed.q1, optionId: "b" }));
    const e2 = err(await t.preview(s.e.open, s.ref, UI_ORIGIN));
    expect(e2.code).toBe("tracker_not_current");
    expect(JSON.stringify(e2)).toContain(s.e.seed.q1.questionId);
  });

  it("provider none skips every task with \"provider none\"", async () => {
    const s = await setup({ settings: { provider: "none", mode: "dry-run", closeByProject: {} } });
    const p = ok(await s.commands().preview(s.e.open, s.ref, UI_ORIGIN));
    expect(p.actions.map((a) => [a.taskId, a.kind, a.actionId, a.reason])).toEqual([
      ["t1", "skip", null, "provider none"],
      ["t2", "skip", null, "provider none"],
    ]);
  });

  it("snailorbit creates one action per task with the exact SnailOrbit wire payload (C-WIRE), keys and destination", async () => {
    const s = await setup();
    const p = ok(await s.commands().preview(s.e.open, s.ref, UI_ORIGIN));
    expect(p.destination).toEqual({ provider: "snailorbit", projectKey: "SYN" });
    expect(p.mode).toBe("dry-run");
    expect(p.receiptId).toBe(s.e.receiptId);
    expect(p.storeRevision).toBe(await s.e.revision());
    expect(p.actions).toHaveLength(2);
    for (const [i, a] of p.actions.entries()) {
      const taskId = `t${i + 1}`;
      const key = `dr:${s.e.P}:${s.e.planId}:${s.e.rev}:${taskId}:create`;
      expect(a).toMatchObject({ kind: "create", taskId, planRev: s.e.rev, idempotencyKey: key, reason: null });
      // C-WIRE: the displayed and signed payload is the would-be wire object, never the neutral { title, body }.
      expect(a.payload).toEqual({ project_id: "SYN", subject: `Task ${i + 1}`, text: `Synthetic task ${i + 1}\n\ndecision-roadmap intent ${a.intentId} (${key})` });
      expect(decodeActionId(a.actionId!)).toEqual({ intentId: a.intentId, taskId, kind: "create", planRev: s.e.rev });
    }
    expect(new Set(p.actions.map((a) => a.intentId)).size).toBe(2);
  });
});

describe("apply: dry-run, unavailable, integrity and drift", () => {
  it("dry-run returns dry_run for the full batch with zero adapter calls and byte-identical intents/tickets", async () => {
    const s = await setup();
    const adapter = fakeAdapter(["ok", "ok"]);
    const t = s.commands({ live: { snailorbit: adapter } });
    const p = ok(await t.preview(s.e.open, s.ref, UI_ORIGIN));
    const before = JSON.stringify(await s.plan());
    const out = ok(await t.apply(s.e.open, { ...s.ref, actionIds: s.actionable(p), confirmToken: p.confirmToken, expectedRevision: p.storeRevision }, UI_ORIGIN));
    expect(out.results.map((r) => r.state)).toEqual(["dry_run", "dry_run"]);
    // C13: full identity of every dry_run result.
    expect(out.results.map((r) => r.actionId)).toEqual(s.actionable(p));
    for (const [i, r] of out.results.entries()) {
      const a = p.actions[i];
      expect(r.intentId).toBe(a.intentId);
      expect(decodeActionId(r.actionId)).toEqual({ intentId: a.intentId, taskId: a.taskId, kind: "create", planRev: s.e.rev });
    }
    expect(out.revision).toBe(p.storeRevision);
    expect(adapter.calls).toEqual([]);
    expect(JSON.stringify(await s.plan())).toBe(before);
    expect(await s.e.revision()).toBe(p.storeRevision);
  });

  it("live without an adapter is tracker_unavailable and persists nothing; a chat origin is invalid_input", async () => {
    const s = await setup({ settings: LIVE });
    const t = s.commands();
    const p = ok(await t.preview(s.e.open, s.ref, UI_ORIGIN));
    const input = { ...s.ref, actionIds: s.actionable(p), confirmToken: p.confirmToken, expectedRevision: p.storeRevision };
    expect(err(await t.apply(s.e.open, input, CHAT)).code).toBe("invalid_input");
    expect(err(await t.apply(s.e.open, input, UI_ORIGIN)).code).toBe("tracker_unavailable");
    expect((await s.plan()).intents).toEqual([]);
  });

  it("any change to the confirmed batch is tracker_token_mismatch with no writes or sends", async () => {
    const s = await setup({ tasks: 3, settings: LIVE });
    const adapter = fakeAdapter(["ok", "ok", "ok"]);
    const t = s.commands({ live: { snailorbit: adapter } });
    const p = ok(await t.preview(s.e.open, s.ref, UI_ORIGIN));
    const ids = s.actionable(p);
    const d = ids.map(decodeActionId);
    const base = { ...s.ref, confirmToken: p.confirmToken, expectedRevision: p.storeRevision };
    // Each variant is a well-typed apply input that the token binding must refuse.
    const variants: Array<[string, Pick<Parameters<typeof t.apply>[1], "actionIds"> & Partial<Pick<Parameters<typeof t.apply>[1], "confirmToken">>]> = [
      ["subset", { actionIds: ids.slice(0, 2) }],
      ["extra forged id", { actionIds: [...ids, encodeActionId({ intentId: "forged-intent", taskId: "t9", kind: "create", planRev: s.e.rev })] }],
      ["swapped taskIds", { actionIds: [encodeActionId({ ...d[0], taskId: d[1].taskId }), encodeActionId({ ...d[1], taskId: d[0].taskId }), ids[2]] }],
      ["duplicated actionId", { actionIds: [ids[0], ids[0], ids[1], ids[2]] }],
      ["same intentId twice", { actionIds: [ids[0], encodeActionId({ ...d[1], intentId: d[0].intentId }), ids[2]] }],
      ["stale planRev", { actionIds: ids.map((_, i) => encodeActionId({ ...d[i], planRev: s.e.rev + 1 })) }],
      ["tampered token", { actionIds: ids, confirmToken: p.confirmToken.slice(0, -1) + (p.confirmToken.endsWith("A") ? "B" : "A") }],
    ];
    for (const [name, change] of variants) {
      const out = await t.apply(s.e.open, { ...base, ...change }, UI_ORIGIN);
      expect(out.ok ? "ok" : out.error.code, name).toBe("tracker_token_mismatch");
    }
    expect(adapter.calls.filter((c) => c.op.startsWith("send"))).toEqual([]);
    expect((await s.plan()).intents).toEqual([]);
    expect(await s.e.revision()).toBe(p.storeRevision);
  });

  it("a token from another plan does not apply to this one", async () => {
    const s = await setup({ settings: LIVE });
    const adapter = fakeAdapter(["ok", "ok"]);
    const t = s.commands({ live: { snailorbit: adapter } });
    const p = ok(await t.preview(s.e.open, s.ref, UI_ORIGIN));
    // A second approved plan in the same project.
    const d2 = ok(await s.e.plans.draft(s.e.open, { projectId: s.e.P, expectedRevision: await s.e.revision(), title: "Other", sessionIds: [s.e.seed.sessionId], markdown: "# other", tasks: [{ id: "t1", title: "Other", description: "" }] }, UI_ORIGIN));
    ok(await s.e.plans.approve(s.e.open, { projectId: s.e.P, planId: d2.planId, rev: 1, contentHash: d2.contentHash }, UI_ORIGIN));
    const p2 = ok(await t.preview(s.e.open, { projectId: s.e.P, planId: d2.planId }, UI_ORIGIN));
    const out = await t.apply(s.e.open, { ...s.ref, actionIds: s.actionable(p), confirmToken: p2.confirmToken, expectedRevision: await s.e.revision() }, UI_ORIGIN);
    expect(out.ok ? "ok" : out.error.code).toBe("tracker_token_mismatch");
    expect(adapter.calls.filter((c) => c.op.startsWith("send"))).toEqual([]);
  });

  it("settings, mode and project-key drift on a still-current plan is tracker_token_mismatch", async () => {
    const s = await setup({ settings: LIVE });
    const adapter = fakeAdapter(["ok", "ok"]);
    const t = s.commands({ live: { snailorbit: adapter } });
    for (const drift of [{ ...LIVE, projectKey: "OTHER" }, { ...LIVE, mode: "dry-run" as const }]) {
      s.settings.current = LIVE;
      const p = ok(await t.preview(s.e.open, s.ref, UI_ORIGIN));
      s.settings.current = drift;
      const out = await t.apply(s.e.open, { ...s.ref, actionIds: s.actionable(p), confirmToken: p.confirmToken, expectedRevision: p.storeRevision }, UI_ORIGIN);
      expect(out.ok ? "ok" : out.error.code, JSON.stringify(drift)).toBe("tracker_token_mismatch");
    }
    expect(adapter.calls.filter((c) => c.op.startsWith("send"))).toEqual([]);
    expect((await s.plan()).intents).toEqual([]);
  });

  it("answer drift with a fresh revision is tracker_not_current; a stale expectedRevision is revision_conflict", async () => {
    const s = await setup({ settings: LIVE });
    const adapter = fakeAdapter(["ok", "ok"]);
    const t = s.commands({ live: { snailorbit: adapter } });
    const p = ok(await t.preview(s.e.open, s.ref, UI_ORIGIN));
    const input = { ...s.ref, actionIds: s.actionable(p), confirmToken: p.confirmToken };
    ok(await s.e.project.service.questionAnswer(s.e.project.paseo, { projectId: s.e.P, expectedRevision: await s.e.revision(), ...s.e.seed.q1, optionId: "b" }));
    expect(err(await t.apply(s.e.open, { ...input, expectedRevision: p.storeRevision }, UI_ORIGIN)).code).toBe("revision_conflict");
    expect(err(await t.apply(s.e.open, { ...input, expectedRevision: await s.e.revision() }, UI_ORIGIN)).code).toBe("tracker_not_current");
    expect(adapter.calls.filter((c) => c.op.startsWith("send"))).toEqual([]);
    expect((await s.plan()).intents).toEqual([]);
  });
});

describe("apply: live durability", () => {
  it("persists pending then sent before the call, sends the exact signed payload, then confirms and maps", async () => {
    const s = await setup({ tasks: 1, settings: LIVE });
    const seen: string[] = [];
    const base = fakeAdapter(["ok"]);
    let open: StoreOpener = s.e.open;
    // Same observation on the P4.6 session interface: the store is read when the send starts.
    const adapter: TrackerAdapter = {
      ...base,
      render: base.render,
      async connect(snapshot, signal) {
        const session = await base.connect(snapshot, signal);
        return {
          ...session,
          async send(kind, wire, sig) {
            const intents = (await s.plan()).intents;
            seen.push(`send with intent ${intents.map((i) => i.state).join(",")}`);
            return session.send(kind, wire, sig);
          },
        };
      },
    };
    const spy = faultOpener(s.e.open, (from, to) => {
      seen.push(`${from ?? "none"}->${to}`);
      return false;
    });
    open = spy.open;
    const t = s.commands({ live: { snailorbit: adapter } });
    const p = ok(await t.preview(open, s.ref, UI_ORIGIN));
    const out = ok(await t.apply(open, { ...s.ref, actionIds: s.actionable(p), confirmToken: p.confirmToken, expectedRevision: p.storeRevision }, UI_ORIGIN));
    expect(out.results).toHaveLength(1);
    expect(out.results[0]).toMatchObject({ state: "confirmed", intentId: p.actions[0].intentId });
    expect(seen).toEqual(["none->pending", "pending->sent", "send with intent sent", "sent->confirmed"]);
    expect(base.calls.find((c) => c.op === "send:create")!.payload).toEqual(p.actions[0].payload);
    const plan = await s.plan();
    expect(plan.intents.map((i) => i.state)).toEqual(["confirmed"]);
    expect(plan.tickets).toHaveLength(1);
    expect(plan.tickets[0]).toMatchObject({ provider: "snailorbit", remoteKey: out.results[0].remoteKey, intentId: p.actions[0].intentId, state: "created" });
    const again = ok(await t.preview(open, s.ref, UI_ORIGIN));
    expect(again.actions.map((a) => [a.kind, a.reason])).toEqual([["skip", "already mapped"]]);
  });

  it("a verified mapped task without closeByProject is skipped \"close not configured for <key>\", never signed or sent", async () => {
    const s = await setup({ tasks: 1, settings: LIVE });
    const adapter = fakeAdapter(["ok", "ok"]);
    const t = s.commands({ live: { snailorbit: adapter } });
    const p = ok(await t.preview(s.e.open, s.ref, UI_ORIGIN));
    ok(await t.apply(s.e.open, { ...s.ref, actionIds: s.actionable(p), confirmToken: p.confirmToken, expectedRevision: p.storeRevision }, UI_ORIGIN));
    const task = async (status: "in_progress" | "done" | "verified", note?: string) =>
      ok(
        await s.e.plans.taskUpdate(
          s.e.open,
          { projectId: s.e.P, expectedRevision: await s.e.revision(), planId: s.e.planId, planRev: s.e.rev, contentHash: s.e.contentHash, taskId: "t1", status, ...(note ? { note } : {}) },
          UI_ORIGIN,
        ),
      );
    await task("in_progress");
    await task("done");
    await task("verified", "checked in staging");
    expect((await s.plan()).taskStates.find((x) => x.taskId === "t1")?.status).toBe("verified");
    const sendsBefore = adapter.calls.filter((c) => c.op.startsWith("send")).length;
    const renderBefore = adapter.calls.filter((c) => c.op === "render").length;

    const again = ok(await t.preview(s.e.open, s.ref, UI_ORIGIN));
    expect(again.actions).toHaveLength(1);
    expect(again.actions[0]).toMatchObject({ taskId: "t1", kind: "skip", actionId: null, intentId: null, payload: null, reason: "close not configured for SYN" });
    expect(s.actionable(again)).toEqual([]);
    expect(adapter.calls.filter((c) => c.op === "render").length, "no close payload rendered").toBe(renderBefore);
    expect(adapter.calls.filter((c) => c.op.startsWith("send")).length).toBe(sendsBefore);
    expect(adapter.calls.some((c) => c.op === "send:close")).toBe(false);
  });

  async function barrierRun(drift: (s: Awaited<ReturnType<typeof setup>>) => Promise<void>) {
    const s = await setup({ tasks: 2, settings: LIVE });
    let release!: () => void;
    const released = new Promise<void>((r) => (release = r));
    let firstSent!: () => void;
    const firstSentP = new Promise<void>((r) => (firstSent = r));
    const base = fakeAdapter(["ok", "ok"]);
    let sends = 0;
    const adapter: TrackerAdapter = {
      ...base,
      render: base.render,
      async connect(snapshot, signal) {
        const session = await base.connect(snapshot, signal);
        return {
          ...session,
          async send(kind, wire, sig): Promise<RemoteIssue> {
            sends++;
            const issue = await session.send(kind, wire, sig);
            if (sends === 1) {
              firstSent();
              await released; // completion held before the outcome is recorded
            }
            return issue;
          },
        };
      },
    };
    const t = s.commands({ live: { snailorbit: adapter } });
    const p = ok(await t.preview(s.e.open, s.ref, UI_ORIGIN));
    const applying = t.apply(s.e.open, { ...s.ref, actionIds: s.actionable(p), confirmToken: p.confirmToken, expectedRevision: p.storeRevision }, UI_ORIGIN);
    await firstSentP;
    await drift(s);
    release();
    const out = ok(await applying);
    return { s, p, out, sends: () => sends };
  }

  it("a foreign answer change while the first call is in flight: first confirmed via the retry path, second not_attempted", async () => {
    const { s, p, out, sends } = await barrierRun(async (s) => {
      ok(await s.e.project.service.questionAnswer(s.e.project.paseo, { projectId: s.e.P, expectedRevision: await s.e.revision(), ...s.e.seed.q1, optionId: "b" }));
    });
    expect(sends()).toBe(1);
    expect(out.results.map((r) => [r.intentId, r.state])).toEqual([
      [p.actions[0].intentId, "confirmed"],
      [p.actions[1].intentId, "not_attempted"],
    ]);
    const plan = await s.plan();
    expect(plan.tickets.map((x) => x.intentId)).toEqual([p.actions[0].intentId]);
    expect(plan.intents.map((i) => i.state)).toEqual(["confirmed"]);
  });

  it("a settings change while the first call is in flight stops the batch the same way", async () => {
    const { s, p, out, sends } = await barrierRun(async (s) => {
      s.settings.current = { ...LIVE, projectKey: "MOVED" };
    });
    expect(sends()).toBe(1);
    expect(out.results.map((r) => r.state)).toEqual(["confirmed", "not_attempted"]);
    expect((await s.plan()).tickets.map((x) => x.intentId)).toEqual([p.actions[0].intentId]);
  });

  const CLOSE: TrackerSettings = { ...LIVE, closeByProject: { SYN: { field: "State", value: "Done" } } };
  /** One live create confirmed and mapped, then the task UI-verified. */
  async function mappedAndVerified(settings: TrackerSettings, script: AdapterStep[] = ["ok", "ok", "ok"]) {
    const s = await setup({ tasks: 1, settings });
    const adapter = fakeAdapter(script);
    const t = s.commands({ live: { snailorbit: adapter } });
    const p = ok(await t.preview(s.e.open, s.ref, UI_ORIGIN));
    ok(await t.apply(s.e.open, { ...s.ref, actionIds: s.actionable(p), confirmToken: p.confirmToken, expectedRevision: p.storeRevision }, UI_ORIGIN));
    for (const status of ["in_progress", "done", "verified"] as const) {
      ok(await s.e.plans.taskUpdate(s.e.open, { projectId: s.e.P, expectedRevision: await s.e.revision(), planId: s.e.planId, planRev: s.e.rev, contentHash: s.e.contentHash, taskId: "t1", status, ...(status === "verified" ? { note: "checked" } : {}) }, UI_ORIGIN));
    }
    return { s, adapter, t, create: p };
  }

  it("a configured close previews exactly { issue_id, fields }, is bound to the close config, and closes the mapping live", async () => {
    const { s, adapter, t } = await mappedAndVerified(CLOSE);
    const p = ok(await t.preview(s.e.open, s.ref, UI_ORIGIN));
    expect(p.actions).toHaveLength(1);
    const close = p.actions[0];
    expect(close).toMatchObject({ kind: "close", taskId: "t1", idempotencyKey: `dr:${s.e.P}:${s.e.planId}:${s.e.rev}:t1:close`, reason: null });
    expect(close.payload).toEqual({ issue_id: "SYN-1", fields: { State: "Done" } });
    expect(decodeActionId(close.actionId!)).toMatchObject({ kind: "close", taskId: "t1" });

    s.settings.current = { ...CLOSE, closeByProject: { SYN: { field: "State", value: "Fixed" } } };
    const drift = await t.apply(s.e.open, { ...s.ref, actionIds: s.actionable(p), confirmToken: p.confirmToken, expectedRevision: p.storeRevision }, UI_ORIGIN);
    expect(drift.ok ? "ok" : drift.error.code).toBe("tracker_token_mismatch");
    expect(adapter.calls.some((c) => c.op === "send:close")).toBe(false);

    s.settings.current = CLOSE;
    const p2 = ok(await t.preview(s.e.open, s.ref, UI_ORIGIN));
    const out = ok(await t.apply(s.e.open, { ...s.ref, actionIds: s.actionable(p2), confirmToken: p2.confirmToken, expectedRevision: p2.storeRevision }, UI_ORIGIN));
    expect(out.results.map((r) => r.state)).toEqual(["confirmed"]);
    expect(adapter.calls.filter((c) => c.op === "send:close").map((c) => c.payload)).toEqual([{ issue_id: "SYN-1", fields: { State: "Done" } }]);
    const plan = await s.plan();
    expect(plan.tickets.map((x) => x.state)).toEqual(["closed"]);
    expect(plan.intents.find((i) => i.kind === "close")?.state).toBe("confirmed");
  });

  it("dry-run with close configured returns dry_run and touches nothing", async () => {
    const { s, adapter } = await mappedAndVerified(CLOSE);
    s.settings.current = { ...CLOSE, mode: "dry-run" };
    const t = s.commands({ live: { snailorbit: adapter } });
    const callsBefore = adapter.calls.filter((c) => c.op !== "render").length;
    const p = ok(await t.preview(s.e.open, s.ref, UI_ORIGIN));
    expect(p.actions[0].payload).toEqual({ issue_id: "SYN-1", fields: { State: "Done" } });
    const before = JSON.stringify(await s.plan());
    const out = ok(await t.apply(s.e.open, { ...s.ref, actionIds: s.actionable(p), confirmToken: p.confirmToken, expectedRevision: p.storeRevision }, UI_ORIGIN));
    expect(out.results.map((r) => r.state)).toEqual(["dry_run"]);
    expect(adapter.calls.filter((c) => c.op !== "render").length).toBe(callsBefore);
    expect(JSON.stringify(await s.plan())).toBe(before);
  });

  it("C-DEST: a close uses the original destination; a later projectKey change never redirects it, a connection change blocks it", async () => {
    const both = { ...LIVE, closeByProject: { SYN: { field: "State", value: "Done" }, OTHER: { field: "Status", value: "Closed" } } };
    const { s, adapter, t } = await mappedAndVerified(both);
    s.settings.current = { ...both, projectKey: "OTHER" };
    const p = ok(await t.preview(s.e.open, s.ref, UI_ORIGIN));
    expect(p.actions[0]).toMatchObject({ kind: "close" });
    expect(p.actions[0].payload).toEqual({ issue_id: "SYN-1", fields: { State: "Done" } });
    // Coordinator clarification: each actionable row exposes its actual non-secret target.
    const first = p.actions[0];
    expect("destination" in first ? first.destination : undefined, "close row targets the original destination").toEqual({ provider: "snailorbit", projectKey: "SYN" });
    s.e.connectionUrl.current = new URL("http://127.0.0.1:9/mcp/synthetic-conn-B");
    const blocked = ok(await t.preview(s.e.open, s.ref, UI_ORIGIN));
    expect(blocked.actions[0]).toMatchObject({ kind: "skip", actionId: null, reason: "close blocked: connection differs from where the ticket was created" });
    expect(adapter.calls.some((c) => c.op === "send:close")).toBe(false);
  });

  it("every actionable row exposes its actual destination: a close keeps SYN while a new create uses the current OTHER", async () => {
    const both = { ...LIVE, closeByProject: { SYN: { field: "State", value: "Done" }, OTHER: { field: "Status", value: "Closed" } } };
    const s = await setup({ tasks: 2, settings: both });
    const adapter = fakeAdapter(["ok", "definitive", "ok"]);
    const t = s.commands({ live: { snailorbit: adapter } });
    const p0 = ok(await t.preview(s.e.open, s.ref, UI_ORIGIN));
    for (const a of p0.actions) expect("destination" in a ? a.destination : undefined).toEqual({ provider: "snailorbit", projectKey: "SYN" });
    ok(await t.apply(s.e.open, { ...s.ref, actionIds: s.actionable(p0), confirmToken: p0.confirmToken, expectedRevision: p0.storeRevision }, UI_ORIGIN));
    for (const status of ["in_progress", "done", "verified"] as const) {
      ok(await s.e.plans.taskUpdate(s.e.open, { projectId: s.e.P, expectedRevision: await s.e.revision(), planId: s.e.planId, planRev: s.e.rev, contentHash: s.e.contentHash, taskId: "t1", status, ...(status === "verified" ? { note: "checked" } : {}) }, UI_ORIGIN));
    }
    s.settings.current = { ...both, projectKey: "OTHER" };
    const p = ok(await t.preview(s.e.open, s.ref, UI_ORIGIN));
    const row = (taskId: string) => p.actions.find((a) => a.taskId === taskId)!;
    expect(row("t1")).toMatchObject({ kind: "close", destination: { provider: "snailorbit", projectKey: "SYN" } });
    expect(row("t2")).toMatchObject({ kind: "create", destination: { provider: "snailorbit", projectKey: "OTHER" } });
    const payload = row("t2").payload;
    expect(payload !== null && "project_id" in payload ? payload.project_id : undefined).toBe("OTHER");
  });

  it.each(["connection_missing", "connection_invalid", "connection_unsupported"] as const)(
    "a local connection source error (%s) previews liveAvailable:false with that reason, no network, no plan change (c0058)",
    async (code) => {
      const s = await setup({ tasks: 1, settings: LIVE });
      const adapter = fakeAdapter(["ok"]);
      const t = s.commands({ live: { snailorbit: adapter }, connection: { read: async () => ({ error: code }) } });
      const before = JSON.stringify(await s.plan());
      const revision = await s.e.revision();
      const p = ok(await t.preview(s.e.open, s.ref, UI_ORIGIN));
      expect(p.liveAvailable).toBe(false);
      expect(p.unavailableReason).toBe(code);
      expect(adapter.calls.filter((c) => c.op !== "render")).toEqual([]);
      expect(JSON.stringify(await s.plan())).toBe(before);
      expect(await s.e.revision()).toBe(revision);
    },
  );

  it("a supported local connection and adapter preview liveAvailable:true without any network call (c0058)", async () => {
    const s = await setup({ tasks: 1, settings: LIVE });
    const adapter = fakeAdapter(["ok"]);
    const t = s.commands({ live: { snailorbit: adapter } });
    const p = ok(await t.preview(s.e.open, s.ref, UI_ORIGIN));
    expect(p.liveAvailable).toBe(true);
    expect(p.unavailableReason).toBeNull();
    expect(adapter.calls.filter((c) => c.op !== "render")).toEqual([]);
  });

  it("a definitive connect_failed stops the whole batch: every action not_attempted with that code, nothing sent or written (c0061)", async () => {
    const s = await setup({ tasks: 2, settings: LIVE });
    const base = fakeAdapter(["ok", "ok"]);
    let connects = 0;
    const adapter: TrackerAdapter = {
      ...base,
      render: base.render,
      async connect() {
        connects++;
        throw new TrackerError("definitive", "connect_failed");
      },
    };
    const t = s.commands({ live: { snailorbit: adapter } });
    const p = ok(await t.preview(s.e.open, s.ref, UI_ORIGIN));
    const before = JSON.stringify(await s.plan());
    const out = ok(await t.apply(s.e.open, { ...s.ref, actionIds: s.actionable(p), confirmToken: p.confirmToken, expectedRevision: p.storeRevision }, UI_ORIGIN));
    expect(connects).toBe(1);
    expect(out.results).toEqual(
      p.actions.map((a) => ({ actionId: a.actionId, intentId: a.intentId, state: "not_attempted", error: "connect_failed" })),
    );
    expect(base.calls.filter((c) => c.op.startsWith("send"))).toEqual([]);
    const plan = await s.plan();
    expect(plan.intents).toEqual([]);
    expect(plan.tickets).toEqual([]);
    expect(JSON.stringify(plan)).toBe(before);
    expect(await s.e.revision()).toBe(p.storeRevision);
  });

  it("a connection switched between preview and apply is tracker_token_mismatch with no connect or send", async () => {
    const s = await setup({ tasks: 1, settings: LIVE });
    const adapter = fakeAdapter(["ok"]);
    const t = s.commands({ live: { snailorbit: adapter } });
    const p = ok(await t.preview(s.e.open, s.ref, UI_ORIGIN));
    expect(adapter.calls.filter((c) => c.op !== "render"), "preview makes no network call").toEqual([]);
    s.e.connectionUrl.current = new URL("http://127.0.0.1:9/mcp/synthetic-conn-B");
    const out = await t.apply(s.e.open, { ...s.ref, actionIds: s.actionable(p), confirmToken: p.confirmToken, expectedRevision: p.storeRevision }, UI_ORIGIN);
    expect(out.ok ? "ok" : out.error.code).toBe("tracker_token_mismatch");
    expect(adapter.calls.filter((c) => c.op === "connect" || c.op.startsWith("send"))).toEqual([]);
  });

  it("persisted intents carry connectionFp in destination and no URL in any stored byte; sessions are closed", async () => {
    const s = await setup({ tasks: 1, settings: LIVE });
    const adapter = fakeAdapter(["ok"]);
    const t = s.commands({ live: { snailorbit: adapter } });
    const p = ok(await t.preview(s.e.open, s.ref, UI_ORIGIN));
    ok(await t.apply(s.e.open, { ...s.ref, actionIds: s.actionable(p), confirmToken: p.confirmToken, expectedRevision: p.storeRevision }, UI_ORIGIN));
    const dest = readJsonObject((await s.plan()).intents[0].destination);
    expect(Object.keys(dest).sort()).toEqual(["connectionFp", "projectKey", "provider"]);
    expect(dest).toMatchObject({ provider: "snailorbit", projectKey: "SYN" });
    expect(String(dest.connectionFp)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const { readdir, readFile } = await import("node:fs/promises");
    const walk = async (d: string): Promise<string> => {
      let text = "";
      for (const e of await readdir(d, { withFileTypes: true })) text += e.isDirectory() ? await walk(join(d, e.name)) : await readFile(join(d, e.name), "utf8");
      return text;
    };
    const persisted = (await walk(join(s.e.project.root, ".decisions"))) + (await walk(s.e.stateDir)) + s.e.logs.join("\n");
    expect(persisted).not.toContain("synthetic-conn");
    expect(adapter.sessions).toEqual({ opened: 1, closed: 1 });
  });

  it("a connection switch after action 1 of 2 stops action 2 as not_attempted", async () => {
    const { s, out, sends } = await barrierRun(async (s) => {
      s.e.connectionUrl.current = new URL("http://127.0.0.1:9/mcp/synthetic-conn-B");
    });
    expect(sends()).toBe(1);
    expect(out.results.map((r) => r.state)).toEqual(["confirmed", "not_attempted"]);
    expect((await s.plan()).intents).toHaveLength(1);
  });

  it("an ambiguous close becomes unknown, keeps the mapping created and is never re-sent", async () => {
    const { s, adapter, t } = await mappedAndVerified(CLOSE, ["ok", "ambiguous", "ok"]);
    const p = ok(await t.preview(s.e.open, s.ref, UI_ORIGIN));
    const out = ok(await t.apply(s.e.open, { ...s.ref, actionIds: s.actionable(p), confirmToken: p.confirmToken, expectedRevision: p.storeRevision }, UI_ORIGIN));
    expect(out.results.map((r) => r.state)).toEqual(["unknown"]);
    const plan = await s.plan();
    expect(plan.tickets.map((x) => x.state)).toEqual(["created"]);
    expect(plan.intents.find((i) => i.kind === "close")?.state).toBe("unknown");
    const again = ok(await t.preview(s.e.open, s.ref, UI_ORIGIN));
    expect(s.actionable(again)).toEqual([]);
    expect(adapter.calls.filter((c) => c.op === "send:close")).toHaveLength(1);
  });

  it("a create intent whose destination lacks connectionFp blocks the close as original destination unknown", async () => {
    const { s, adapter, t } = await mappedAndVerified(CLOSE);
    const store = await s.e.open(s.e.P);
    await store.transact(await s.e.revision(), (d) => {
      const create = d.plans.find((x) => x.id === s.e.planId)!.intents.find((i) => i.kind === "create")!;
      create.destination = JSON.stringify({ provider: "snailorbit", projectKey: "SYN" });
    });
    const p = ok(await t.preview(s.e.open, s.ref, UI_ORIGIN));
    expect(p.actions[0]).toMatchObject({ kind: "skip", actionId: null, reason: "close blocked: original destination unknown" });
    expect(adapter.calls.some((c) => c.op === "send:close")).toBe(false);
  });

  describe("through the real SnailOrbit adapter and loopback fakes", () => {
    let fakes: FakeSnailOrbit[] = [];
    afterEach(async () => {
      await Promise.all(fakes.map((f) => f.stop().catch(() => undefined)));
      fakes = [];
    });
    const startFake = async (opts?: Parameters<typeof startFakeSnailOrbit>[0]) => {
      const f = await startFakeSnailOrbit(opts);
      fakes.push(f);
      return f;
    };
    const real = async (opts: { timeoutMs?: number } = {}) => (await import("./snailorbit")).createSnailOrbitAdapter(opts);

    it("a live apply sends the exact previewed wire and records the mapping", async () => {
      const f = await startFake();
      const s = await setup({ tasks: 1, settings: LIVE });
      s.e.connectionUrl.current = f.url;
      const t = s.commands({ live: { snailorbit: await real() } });
      const p = ok(await t.preview(s.e.open, s.ref, UI_ORIGIN));
      expect(f.calls, "preview makes no network call").toEqual([]);
      const out = ok(await t.apply(s.e.open, { ...s.ref, actionIds: s.actionable(p), confirmToken: p.confirmToken, expectedRevision: p.storeRevision }, UI_ORIGIN));
      expect(out.results.map((r) => r.state)).toEqual(["confirmed"]);
      expect(f.writes()).toEqual([{ tool: "create_issue", args: p.actions[0].payload }]);
      expect((await s.plan()).tickets).toEqual([expect.objectContaining({ remoteKey: "SYN-1", remoteId: "3-1", url: "", state: "created", intentId: p.actions[0].intentId })]);
    });

    it("a hanging create is aborted through the whole sync: unknown, abort observed, no second call", async () => {
      const f = await startFake({ replies: { create_issue: [{ kind: "hang" }] } });
      const s = await setup({ tasks: 1, settings: LIVE });
      s.e.connectionUrl.current = f.url;
      const t = s.commands({ live: { snailorbit: await real({ timeoutMs: 50 }) }, timeoutMs: 50 });
      const p = ok(await t.preview(s.e.open, s.ref, UI_ORIGIN));
      const out = ok(await t.apply(s.e.open, { ...s.ref, actionIds: s.actionable(p), confirmToken: p.confirmToken, expectedRevision: p.storeRevision }, UI_ORIGIN));
      expect(out.results.map((r) => r.state)).toEqual(["unknown"]);
      await expect.poll(() => f.aborted, { timeout: 2000 }).toEqual(["create_issue"]);
      expect((await s.plan()).intents.map((i) => i.state)).toEqual(["unknown"]);
      expect(s.actionable(ok(await t.preview(s.e.open, s.ref, UI_ORIGIN)))).toEqual([]);
      expect(f.writes()).toHaveLength(1);
    });

    it("two destinations A/B: a close for a ticket created through A is never sent to B or redirected", async () => {
      const a = await startFake();
      const b = await startFake();
      const both: TrackerSettings = { ...LIVE, closeByProject: { SYN: { field: "State", value: "Done" }, OTHER: { field: "Status", value: "Closed" } } };
      const s = await setup({ tasks: 1, settings: both });
      s.e.connectionUrl.current = a.url;
      const t = s.commands({ live: { snailorbit: await real() } });
      const p = ok(await t.preview(s.e.open, s.ref, UI_ORIGIN));
      ok(await t.apply(s.e.open, { ...s.ref, actionIds: s.actionable(p), confirmToken: p.confirmToken, expectedRevision: p.storeRevision }, UI_ORIGIN));
      for (const status of ["in_progress", "done", "verified"] as const) {
        ok(await s.e.plans.taskUpdate(s.e.open, { projectId: s.e.P, expectedRevision: await s.e.revision(), planId: s.e.planId, planRev: s.e.rev, contentHash: s.e.contentHash, taskId: "t1", status, ...(status === "verified" ? { note: "checked" } : {}) }, UI_ORIGIN));
      }
      s.settings.current = { ...both, projectKey: "OTHER" };
      s.e.connectionUrl.current = b.url;
      const blocked = ok(await t.preview(s.e.open, s.ref, UI_ORIGIN));
      expect(blocked.actions[0]).toMatchObject({ kind: "skip", reason: "close blocked: connection differs from where the ticket was created" });
      expect(s.actionable(blocked)).toEqual([]);
      expect(b.calls, "destination B never contacted").toEqual([]);
      expect(a.calls.filter((c) => c.tool === "update_issue"), "no update_issue anywhere").toEqual([]);
    });
  });

  it.each([
    ["removed", async (path: string) => rm(path)],
    ["corrupted", async (path: string) => writeFile(path, "{ not a receipt")],
  ] as const)("the authoritative receipt %s while the first call is in flight: first outcome recorded, second not_attempted", async (_name, damage) => {
    const { s, p, out, sends } = await barrierRun(async (s) => {
      await damage(join(s.e.stateDir, "approvals", s.e.P, s.e.planId, `${s.e.rev}.json`));
    });
    expect(sends(), "exactly one adapter send").toBe(1);
    expect(out.results.map((r) => [r.intentId, r.state])).toEqual([
      [p.actions[0].intentId, "confirmed"],
      [p.actions[1].intentId, "not_attempted"],
    ]);
    const plan = await s.plan();
    expect(plan.tickets.map((x) => x.intentId)).toEqual([p.actions[0].intentId]);
    expect(plan.intents.map((i) => [i.intentId, i.state])).toEqual([[p.actions[0].intentId, "confirmed"]]);
  });

  it.each([
    ["ambiguous", {}],
    ["hang", { timeoutMs: 50 }],
  ] as const)("an %s outcome becomes unknown, is never retried and reconcile does not search", async (step, extra) => {
    const s = await setup({ tasks: 1, settings: LIVE });
    const adapter = fakeAdapter([step]);
    const t = s.commands({ live: { snailorbit: adapter }, ...extra });
    const p = ok(await t.preview(s.e.open, s.ref, UI_ORIGIN));
    const out = ok(await t.apply(s.e.open, { ...s.ref, actionIds: s.actionable(p), confirmToken: p.confirmToken, expectedRevision: p.storeRevision }, UI_ORIGIN));
    expect(out.results[0].state).toBe("unknown");
    expect((await s.plan()).intents.map((i) => i.state)).toEqual(["unknown"]);
    const callsAfter = adapter.calls.length;
    const again = ok(await t.preview(s.e.open, s.ref, UI_ORIGIN));
    expect(again.actions.every((a) => a.kind === "skip")).toBe(true);
    expect(s.actionable(again)).toEqual([]);
    const rec = ok(await t.reconcile(s.e.open, { ...s.ref, intentId: p.actions[0].intentId! }));
    expect(rec).toMatchObject({ state: "unknown", humanDecisionRequired: true });
    expect(adapter.calls.length, "no lookup or retry").toBe(callsAfter);
    expect(err(await t.reconcile(s.e.open, { ...s.ref, intentId: "missing" })).code).toBe("not_found");
  });

  it("a definitive failure records failed with a redacted code; a later preview offers a fresh intent", async () => {
    const s = await setup({ tasks: 1, settings: LIVE });
    const adapter = fakeAdapter(["definitive", "ok"]);
    const t = s.commands({ live: { snailorbit: adapter } });
    const p = ok(await t.preview(s.e.open, s.ref, UI_ORIGIN));
    const out = ok(await t.apply(s.e.open, { ...s.ref, actionIds: s.actionable(p), confirmToken: p.confirmToken, expectedRevision: p.storeRevision }, UI_ORIGIN));
    expect(out.results[0].state).toBe("failed");
    const intent = (await s.plan()).intents[0];
    expect(intent.state).toBe("failed");
    expect(intent.error).toBe("rejected");
    const again = ok(await t.preview(s.e.open, s.ref, UI_ORIGIN));
    expect(again.actions[0].kind).toBe("create");
    expect(again.actions[0].intentId).not.toBe(p.actions[0].intentId);
  });

  it("a crash between pending and sent makes no call; after a restart it is interrupted and never re-sent", async () => {
    const s = await setup({ tasks: 1, settings: LIVE });
    const adapter = fakeAdapter(["ok", "ok"]);
    const crash = faultOpener(s.e.open, (from, to) => from === "pending" && to === "sent");
    const t = s.commands({ live: { snailorbit: adapter } });
    const p = ok(await t.preview(crash.open, s.ref, UI_ORIGIN));
    const out = await t.apply(crash.open, { ...s.ref, actionIds: s.actionable(p), confirmToken: p.confirmToken, expectedRevision: p.storeRevision }, UI_ORIGIN);
    expect(crash.hits.n).toBeGreaterThan(0);
    // C17: exactly the ruling 6 step-2 failure value, not a union.
    expect(ok(out).results).toEqual([{ actionId: p.actions[0].actionId, intentId: p.actions[0].intentId, state: "not_attempted", error: "intent_not_sent" }]);
    expect(adapter.calls.filter((c) => c.op.startsWith("send"))).toEqual([]);
    expect((await s.plan()).intents.map((i) => i.state)).toEqual(["pending"]);

    const later = s.commands({ live: { snailorbit: adapter }, processStartedAt: new Date(fixedClock().getTime() + 60_000) });
    const again = ok(await later.preview(s.e.open, s.ref, UI_ORIGIN));
    expect(again.interrupted).toEqual([{ intentId: p.actions[0].intentId, taskId: "t1", kind: "create", state: "pending" }]);
    expect(again.actions.map((a) => [a.kind, a.reason])).toEqual([["skip", "needs reconcile"]]);
    expect(s.actionable(again)).toEqual([]);
    expect(adapter.calls.filter((c) => c.op.startsWith("send"))).toEqual([]);
  });

  it("remote confirmed but the outcome never recorded: unknown, no mapping claimed, no blind duplicate after restart", async () => {
    const s = await setup({ tasks: 1, settings: LIVE });
    const adapter = fakeAdapter(["ok", "ok"]);
    const failOutcome = faultOpener(s.e.open, (from) => from === "sent");
    const t = s.commands({ live: { snailorbit: adapter } });
    const p = ok(await t.preview(failOutcome.open, s.ref, UI_ORIGIN));
    const out = ok(await t.apply(failOutcome.open, { ...s.ref, actionIds: s.actionable(p), confirmToken: p.confirmToken, expectedRevision: p.storeRevision }, UI_ORIGIN));
    expect(out.results[0]).toMatchObject({ state: "unknown", error: "outcome not recorded" });
    expect(out.results[0].remoteKey).toBe("SYN-1");
    const plan = await s.plan();
    expect(plan.tickets).toEqual([]);
    expect(plan.intents.map((i) => i.state)).toEqual(["sent"]);
    expect(adapter.calls.filter((c) => c.op.startsWith("send"))).toHaveLength(1);

    const later = s.commands({ live: { snailorbit: adapter }, processStartedAt: new Date(fixedClock().getTime() + 60_000) });
    const again = ok(await later.preview(s.e.open, s.ref, UI_ORIGIN));
    expect(again.interrupted.map((x) => x.state)).toEqual(["sent"]);
    expect(s.actionable(again)).toEqual([]);
    expect(adapter.calls.filter((c) => c.op.startsWith("send")), "no blind duplicate").toHaveLength(1);
  });

  it("logs never carry payload bodies, markers or error bodies", async () => {
    const s = await setup({ tasks: 2, settings: LIVE });
    const adapter = fakeAdapter(["ok", "definitive"]);
    const t = s.commands({ live: { snailorbit: adapter } });
    const p = ok(await t.preview(s.e.open, s.ref, UI_ORIGIN));
    await t.apply(s.e.open, { ...s.ref, actionIds: s.actionable(p), confirmToken: p.confirmToken, expectedRevision: p.storeRevision }, UI_ORIGIN);
    const logs = s.e.logs.join("\n");
    for (const a of p.actions) {
      expect(logs).not.toContain(a.intentId!);
      expect(logs).not.toContain(JSON.stringify(a.payload));
    }
    expect(logs).not.toContain("decision-roadmap intent");
    expect(logs).not.toContain("Synthetic task");
    // C22: positive oracle — each processed intent is logged by fingerprint with its state.
    const fp = (id: string) => createHash("sha256").update(id, "utf8").digest("hex").slice(0, 8);
    const lines = s.e.logs;
    expect(lines.some((l) => l.includes(fp(p.actions[0].intentId!)) && l.includes("confirmed"))).toBe(true);
    expect(lines.some((l) => l.includes(fp(p.actions[1].intentId!)) && l.includes("failed"))).toBe(true);
  });
});

// Stage R1.5 (task card §8.4 item 4; owner Q33=1): after a basis cancellation the approval is not
// current, so preview and apply are tracker_not_current with no tracker call and no mapping write;
// an unrelated cancellation keeps apply working.
describe("R1.5 tracker after a cancellation", () => {
  const cancel = async (s: Awaited<ReturnType<typeof setup>>, sessionId: string, questionId: string) =>
    ok(await s.e.project.service.decisionCancel(s.e.project.paseo, { projectId: s.e.P, expectedRevision: await s.e.revision(), sessionId, questionId, reason: "Dropped" }));

  it("a cancelled basis decision makes preview and apply tracker_not_current, with no send and no mapping", async () => {
    const s = await setup({ settings: LIVE });
    const adapter = fakeAdapter(["ok", "ok"]);
    const t = s.commands({ live: { snailorbit: adapter } });
    const p = ok(await t.preview(s.e.open, s.ref, UI_ORIGIN));
    await cancel(s, s.e.seed.q1.sessionId, s.e.seed.q1.questionId);
    const e1 = err(await t.preview(s.e.open, s.ref, UI_ORIGIN));
    expect(e1.code).toBe("tracker_not_current");
    expect(JSON.stringify(e1)).toContain("was cancelled");
    const input = { ...s.ref, actionIds: s.actionable(p), confirmToken: p.confirmToken, expectedRevision: await s.e.revision() };
    expect(err(await t.apply(s.e.open, input, UI_ORIGIN)).code).toBe("tracker_not_current");
    expect(adapter.calls.filter((c) => c.op.startsWith("send"))).toEqual([]);
    expect((await s.plan()).intents).toEqual([]);
    expect((await s.plan()).tickets).toEqual([]);
  });

  it("control: an unrelated cancellation keeps preview and dry-run apply working", async () => {
    const s = await setup();
    const { service, paseo } = s.e.project;
    const other = ok(await service.sessionCreate(paseo, { projectId: s.e.P, expectedRevision: await s.e.revision(), title: "Other" })).sessionId;
    const qid = ok(
      await service.questionCreate(paseo, { projectId: s.e.P, expectedRevision: await s.e.revision(), sessionId: other, title: "Elsewhere", context: "", options: [{ id: "a", label: "A" }], allowFreeText: false, activatedBy: [], invalidatedBy: [] }),
    ).questionId;
    await cancel(s, other, qid);
    const t = s.commands({ live: { snailorbit: fakeAdapter(["ok", "ok"]) } });
    const p = ok(await t.preview(s.e.open, s.ref, UI_ORIGIN));
    expect(p.actions).toHaveLength(2);
    ok(await t.apply(s.e.open, { ...s.ref, actionIds: s.actionable(p), confirmToken: p.confirmToken, expectedRevision: p.storeRevision }, UI_ORIGIN));
  });
});
