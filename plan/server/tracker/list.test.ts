// Read-only tracker list (Stage 4 P4.8, T4.9) over a real temp store with a real Stage 3 approval.
// Tracker history is a valid synthetic fixture written through the real store.
import { mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { TicketMapping, TrackerIntent } from "../../shared/model";
import type { StoreOpener } from "../sessions";
import { openStore } from "../store";
import { fixedClock, nextId } from "../test-support/build";
import { approvedPlan } from "../test-support/tracker";
import { listTracker } from "./list";

beforeAll(async () => {
  await Promise.all([import("./sync"), import("./token"), import("../plans"), import("../sessions")]);
}, 60_000);

const START = fixedClock(); // 2026-10-20T10:00:00.000Z
const BEFORE = "2026-10-20T09:00:00.000Z";
const AFTER = "2026-10-20T11:00:00.000Z";
const FORBIDDEN = new Set(["payload", "destination", "idempotencyKey", "confirmToken", "settings", "receipt", "receiptId", "mode"]);

type R<T> = { ok: true; value: T } | { ok: false; error: { code: string; message: string } };
const ok = <T>(r: R<T>): T => {
  if (!r.ok) throw new Error(`expected ok, got ${r.error.code}: ${r.error.message}`);
  return r.value;
};
const err = <T>(r: R<T>) => {
  if (r.ok) throw new Error(`expected an error, got ${JSON.stringify(r.value)}`);
  return r.error;
};
function keysDeep(v: unknown, out: string[] = []): string[] {
  if (Array.isArray(v)) v.forEach((x) => keysDeep(x, out));
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) out.push(k), keysDeep(x, out);
  return out;
}

let env: Awaited<ReturnType<typeof approvedPlan>> | undefined;
const temps: string[] = [];
afterEach(async () => {
  await env?.cleanup();
  env = undefined;
  await Promise.all(temps.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

/** Approved plan with 4 tasks plus synthetic tracker history covering every row kind. */
async function seeded() {
  env = await approvedPlan({ tasks: 4 });
  const e = env;
  const intent = (intentId: string, taskId: string, state: TrackerIntent["state"], extra: Partial<TrackerIntent> = {}): TrackerIntent => ({
    intentId, planId: e.planId, taskId, planRev: e.rev, receiptId: e.receiptId, kind: "create",
    payload: { title: `secret title ${intentId}`, body: `secret body ${intentId}` },
    destination: "snailorbit:SYN", mode: "live", state, createdAt: AFTER, lastAttemptAt: AFTER, ...extra,
  });
  const ticket = (intentId: string, n: number): TicketMapping => ({
    provider: "snailorbit", remoteId: `remote-${n}`, remoteKey: `SYN-${n}`, url: `https://tracker.invalid/SYN-${n}`,
    idempotencyKey: `dr:${e.P}:${e.planId}:${e.rev}:t${n}:create`, intentId, state: "created", lastSyncAt: AFTER,
  });
  const intents = [
    intent("int-confirmed", "t1", "confirmed"),
    intent("int-unknown", "t2", "unknown", { error: "timeout" }),
    intent("int-failed", "t3", "failed", { error: "rejected" }),
    intent("int-pending-old", "t4", "pending", { createdAt: BEFORE, lastAttemptAt: BEFORE }),
    intent("int-sent-old", "t4", "sent", { createdAt: BEFORE, lastAttemptAt: BEFORE }),
    intent("int-sent-new", "t2", "sent"),
  ];
  const tickets = [ticket("int-confirmed", 1), ticket("int-orphan", 9)];
  const store = await e.open(e.P);
  await store.transact(await e.revision(), (d) => {
    const p = d.plans.find((x) => x.id === e.planId)!;
    p.intents.push(...intents);
    p.tickets.push(...tickets);
  });
  const ref = { projectId: e.P, planId: e.planId };
  return { e, ref, intents, tickets };
}

const expectedRows = (e: NonNullable<typeof env>) => ({
  tickets: [
    { intentId: "int-confirmed", taskId: "t1", planRev: e.rev, provider: "snailorbit", remoteKey: "SYN-1", url: "https://tracker.invalid/SYN-1", state: "created", lastSyncAt: AFTER },
    { intentId: "int-orphan", taskId: null, planRev: null, provider: "snailorbit", remoteKey: "SYN-9", url: "https://tracker.invalid/SYN-9", state: "created", lastSyncAt: AFTER },
  ],
  intents: [
    { intentId: "int-unknown", taskId: "t2", planRev: e.rev, kind: "create", state: "unknown", interrupted: false, errorClass: "timeout", createdAt: AFTER, lastAttemptAt: AFTER },
    { intentId: "int-failed", taskId: "t3", planRev: e.rev, kind: "create", state: "failed", interrupted: false, errorClass: "rejected", createdAt: AFTER, lastAttemptAt: AFTER },
    { intentId: "int-pending-old", taskId: "t4", planRev: e.rev, kind: "create", state: "pending", interrupted: true, errorClass: null, createdAt: BEFORE, lastAttemptAt: BEFORE },
    { intentId: "int-sent-old", taskId: "t4", planRev: e.rev, kind: "create", state: "sent", interrupted: true, errorClass: null, createdAt: BEFORE, lastAttemptAt: BEFORE },
    { intentId: "int-sent-new", taskId: "t2", planRev: e.rev, kind: "create", state: "sent", interrupted: false, errorClass: null, createdAt: AFTER, lastAttemptAt: AFTER },
  ],
});

/** Wraps the real opener and records every Store method call. */
function recordingOpener(real: StoreOpener) {
  const calls: string[] = [];
  const open: StoreOpener = async (projectId) => {
    const store = await real(projectId);
    return new Proxy(store, {
      get(target, prop, receiver) {
        const v: unknown = Reflect.get(target, prop, receiver);
        if (typeof v !== "function") return v;
        return (...args: unknown[]) => {
          calls.push(String(prop));
          const result: unknown = Reflect.apply(v, target, args);
          return result;
        };
      },
    });
  };
  return { open, calls };
}

describe("tracker.list", () => {
  it("returns tickets with the task/rev join (null when orphaned) and every non-confirmed intent with derived interrupted", async () => {
    const { e, ref } = await seeded();
    const out = ok(await listTracker(e.open, ref, { processStartedAt: START }));
    expect(out.revision).toBe(await e.revision());
    expect(out.latestRev).toBe(e.rev);
    expect({ tickets: out.tickets, intents: out.intents }).toEqual(expectedRows(e));
    expect(out.intents.some((i) => (i.state as string) === "confirmed")).toBe(false);
  });

  it("returns no payload, destination, idempotency key, token, settings, receipt or mode at any depth", async () => {
    const { e, ref } = await seeded();
    const out = ok(await listTracker(e.open, ref, { processStartedAt: START }));
    expect(keysDeep(out).filter((k) => FORBIDDEN.has(k))).toEqual([]);
    const text = JSON.stringify(out);
    expect(text).not.toContain("secret");
    expect(text).not.toContain("dr:");
    expect(text).not.toContain(e.receiptId);
  });

  it("has zero side effects: one store read, no transact, no key file, unchanged export and manifest bytes", async () => {
    const { e, ref } = await seeded();
    const exportPath = join(e.project.root, ".decisions", "plans", `${e.planId}.md`);
    const manifestPath = join(e.project.root, ".decisions", "manifest.json");
    const exportBytes = await readFile(exportPath, "utf8");
    const manifestBytes = await readFile(manifestPath, "utf8");
    const rec = recordingOpener(e.open);
    ok(await listTracker(rec.open, ref, { processStartedAt: START }));
    expect(rec.calls).toEqual(["read"]);
    expect(await readFile(exportPath, "utf8")).toBe(exportBytes);
    expect(await readFile(manifestPath, "utf8")).toBe(manifestBytes);
    expect(await stat(join(e.stateDir, "tracker-key.json")).then(() => true, () => false)).toBe(false);
  });

  it("does not depend on approval currency: the same rows after a re-answer makes the approval not current", async () => {
    const { e, ref } = await seeded();
    const before = ok(await listTracker(e.open, ref, { processStartedAt: START }));
    ok(await e.project.service.questionAnswer(e.project.paseo, { projectId: e.P, expectedRevision: await e.revision(), ...e.seed.q1, optionId: "b" }));
    expect(ok(await e.plans.get(e.open, ref)).approval).toBe("not_current");
    const after = ok(await listTracker(e.open, ref, { processStartedAt: START }));
    expect({ tickets: after.tickets, intents: after.intents, latestRev: after.latestRev }).toEqual({ tickets: before.tickets, intents: before.intents, latestRev: before.latestRev });
    expect(after.revision).toBe(before.revision + 1);
  });

  it("interrupted follows processStartedAt", async () => {
    const { e, ref } = await seeded();
    const early = ok(await listTracker(e.open, ref, { processStartedAt: new Date("2026-10-20T08:00:00.000Z") }));
    expect(early.intents.every((i) => i.interrupted === false)).toBe(true);
    const late = ok(await listTracker(e.open, ref, { processStartedAt: new Date("2026-10-20T12:00:00.000Z") }));
    expect(late.intents.filter((i) => i.interrupted).map((i) => i.intentId)).toEqual(["int-pending-old", "int-sent-old", "int-sent-new"]);
  });

  it("is scoped: another project, an unknown plan or a missing store never returns this plan", async () => {
    const { e, ref } = await seeded();
    const otherRoot = await realpath(await mkdtemp(join(tmpdir(), "dr-list-other-")));
    const emptyRoot = await realpath(await mkdtemp(join(tmpdir(), "dr-list-empty-")));
    temps.push(otherRoot, emptyRoot);
    await openStore({ storeRoot: otherRoot, projectId: "prj_other", now: fixedClock, newId: nextId }).init();
    const open: StoreOpener = async (projectId) =>
      projectId === "prj_other"
        ? openStore({ storeRoot: otherRoot, projectId, now: fixedClock, newId: nextId })
        : projectId === "prj_empty"
          ? openStore({ storeRoot: emptyRoot, projectId, now: fixedClock, newId: nextId })
          : e.open(projectId);
    expect(err(await listTracker(open, { projectId: "prj_other", planId: e.planId }, { processStartedAt: START })).code).toBe("not_found");
    expect(err(await listTracker(open, { ...ref, planId: "plan-missing" }, { processStartedAt: START })).code).toBe("not_found");
    expect(err(await listTracker(open, { projectId: "prj_empty", planId: e.planId }, { processStartedAt: START })).code).toBe("store_missing");
  });
});
