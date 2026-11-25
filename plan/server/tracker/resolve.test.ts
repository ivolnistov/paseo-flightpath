// Unknown-intent resolution (Stage 4 P4.7, owner ruling O2; T4.8) over a real temp store, real
// receipts and a loopback fake SnailOrbit server (official SDK). No real endpoint or config.
import { readdir, readFile, stat } from "node:fs/promises";
import { z } from "zod";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { TrackerIntent } from "../../shared/model";
import type { TrackerSettings } from "../../shared/settings";
import type { ApprovalFs } from "../approval-fs";
import { nodeApprovalFs } from "../approval-fs";
import { UI_ORIGIN, type WriteOrigin } from "../sessions";
import { startFakeSnailOrbit, richIssue, type FakeSnailOrbit } from "../test-support/fake-snailorbit";
import { wrapApprovalFs } from "../test-support/plans";
import { readJsonObject } from "../test-support/build";
import { approvedPlan, setFakeRender } from "../test-support/tracker";
import { listTracker } from "./list";
import type { RpcInput } from "@getpaseo/plugin";
import type { TrackerResolve } from "../../shared/rpc";

/** The resolution input of the real tracker.resolve contract (every value used below is a valid one). */
type Resolution = RpcInput<typeof TrackerResolve>["resolution"];

const CHAT: WriteOrigin = { source: "chat", actor: { kind: "agent" }, quoted: "resolve it" };
const LIVE: TrackerSettings = { provider: "snailorbit", mode: "live", projectKey: "SYN", closeByProject: { SYN: { field: "State", value: "Done" } } };
type R<T> = { ok: true; value: T } | { ok: false; error: { code: string; message: string } };
const ok = <T>(r: R<T>): T => {
  if (!r.ok) throw new Error(`expected ok, got ${r.error.code}: ${r.error.message}`);
  return r.value;
};
const err = <T>(r: R<T>) => {
  if (r.ok) throw new Error(`expected an error, got ${JSON.stringify(r.value)}`);
  return r.error;
};

let snail: typeof import("./snailorbit");
let resolveMod: typeof import("./resolve");
beforeAll(async () => {
  await Promise.all([import("./sync"), import("./token"), import("../plans"), import("../sessions")]);
  snail = await import("./snailorbit");
  resolveMod = await import("./resolve");
  setFakeRender((a) => snail.renderSnailOrbit(a.kind, a.neutral, a.destination, (a.settings).closeByProject?.[a.destination.projectKey]));
}, 60_000);

let env: Awaited<ReturnType<typeof approvedPlan>> | undefined;
let fakes: FakeSnailOrbit[] = [];
afterEach(async () => {
  await Promise.all(fakes.map((f) => f.stop().catch(() => undefined)));
  fakes = [];
  await env?.cleanup();
  env = undefined;
});

/** One live create through the real adapter whose create_issue reply is ambiguous → an `unknown` create intent. */
async function unknownCreate(opts: { auditFs?: ApprovalFs; createReply?: "isError" | "ok" } = {}) {
  const f = await startFakeSnailOrbit({ replies: { create_issue: opts.createReply === "ok" ? [] : [{ kind: "isError", text: "remote said maybe" }] } });
  fakes.push(f);
  env = await approvedPlan({ tasks: 1 });
  const e = env;
  e.connectionUrl.current = f.url;
  const settings = { current: LIVE };
  const audit = resolveMod.createAuditStore({ stateDir: e.stateDir, log: e.env.log, ...(opts.auditFs ? { fs: opts.auditFs } : {}) });
  const t = e.tracker({ settings: async () => settings.current, live: { snailorbit: snail.createSnailOrbitAdapter({}) }, audit });
  const ref = { projectId: e.P, planId: e.planId };
  const p = ok(await t.preview(e.open, ref, UI_ORIGIN));
  const applied = ok(await t.apply(e.open, { ...ref, actionIds: p.actions.map((a) => a.actionId!).filter(Boolean), confirmToken: p.confirmToken, expectedRevision: p.storeRevision }, UI_ORIGIN));
  const plan = async () => {
    const read = await (await e.open(e.P)).read();
    if (read.status !== "ok") throw new Error("store not ok");
    return read.data.plans.find((x) => x.id === e.planId)!;
  };
  const intent = (await plan()).intents[0];
  const resolve = async (intentId: string, resolution: Resolution, extra: { origin?: WriteOrigin; planRev?: number; expectedRevision?: number } = {}) =>
    t.resolve(e.open, { ...ref, intentId, planRev: extra.planRev ?? e.rev, expectedRevision: extra.expectedRevision ?? (await e.revision()), resolution }, extra.origin ?? UI_ORIGIN);
  const auditPath = (intentId: string) => join(e.stateDir, "tracker-audit", e.P, e.planId, `${intentId}.json`);
  return { e, f, t, ref, p, applied, plan, intent, resolve, auditPath, settings };
}

describe("tracker.resolve guards", () => {
  it("rejects chat origin, stale revision, wrong planRev, unknown intent, and non-resolvable states", async () => {
    const s = await unknownCreate();
    expect(s.intent.state).toBe("unknown");
    const link: Resolution = { kind: "link", remoteKey: "SYN-1" };
    expect(err(await s.resolve(s.intent.intentId, link, { origin: CHAT })).code).toBe("invalid_input");
    expect(err(await s.resolve(s.intent.intentId, link, { expectedRevision: 1 })).code).toBe("revision_conflict");
    expect(err(await s.resolve(s.intent.intentId, link, { planRev: s.e.rev + 1 })).code).toBe("plan_revision_mismatch");
    expect(err(await s.resolve("int-missing", link)).code).toBe("not_found");

    // An in-flight pending of this process (created after processStartedAt) and a confirmed intent.
    const store = await s.e.open(s.e.P);
    await store.transact(await s.e.revision(), (d) => {
      const p = d.plans.find((x) => x.id === s.e.planId)!;
      const base = p.intents[0];
      p.intents.push({ ...base, intentId: "int-inflight", state: "pending", createdAt: "2026-10-20T11:00:00.000Z", lastAttemptAt: "2026-10-20T11:00:00.000Z" } as TrackerIntent);
      p.intents.push({ ...base, intentId: "int-done", taskId: base.taskId, state: "confirmed" } as TrackerIntent);
    });
    expect(err(await s.resolve("int-inflight", { kind: "not_created", confirm: true })).code).toBe("tracker_intent_unresolved");
    expect(err(await s.resolve("int-done", { kind: "not_created", confirm: true })).code).toBe("tracker_intent_unresolved");
    expect(s.f.calls.filter((c) => c.tool === "get_issue")).toEqual([]);
  });
});

describe("link", () => {
  it("links an issue of the same project: mapping written, intent confirmed, audit 0600/0700, get only", async () => {
    const s = await unknownCreate();
    const writesBefore = s.f.writes().length;
    const out = ok(await s.resolve(s.intent.intentId, { kind: "link", remoteKey: "SYN-42" }));
    expect(out).toMatchObject({ state: "confirmed", remoteKey: "SYN-42", auditRecorded: true });
    const plan = await s.plan();
    expect(plan.intents[0].state).toBe("confirmed");
    expect(plan.tickets).toEqual([
      expect.objectContaining({ provider: "snailorbit", remoteKey: "SYN-42", url: "", intentId: s.intent.intentId, state: "created", idempotencyKey: `dr:${s.e.P}:${s.e.planId}:${s.intent.planRev}:${s.intent.taskId}:create` }),
    ]);
    expect(s.f.calls.filter((c) => c.tool === "get_issue").map((c) => c.args)).toEqual([{ issue_id: "SYN-42" }]);
    expect(s.f.writes().length, "no create_issue or update_issue during resolve").toBe(writesBefore);
    const file = s.auditPath(s.intent.intentId);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await stat(join(s.e.stateDir, "tracker-audit"))).mode & 0o777).toBe(0o700);
    const audit = readJsonObject(await readFile(file, "utf8"));
    expect(audit).toMatchObject({ intentId: s.intent.intentId, planRev: s.e.rev, resolution: "link", remoteKey: "SYN-42", actor: { kind: "human" } });
    expect(JSON.stringify(audit)).not.toContain("synthetic-secret-path");
    const listed = ok(await listTracker(s.e.open, s.ref, { processStartedAt: new Date("2026-10-20T10:00:00.000Z") }));
    expect(listed.tickets.map((x) => x.remoteKey)).toEqual(["SYN-42"]);
  });

  it("a changed connection fingerprint is tracker_unavailable with zero get calls and nothing written", async () => {
    const s = await unknownCreate();
    const before = JSON.stringify(await s.plan());
    const other = await startFakeSnailOrbit();
    fakes.push(other);
    s.e.connectionUrl.current = other.url;
    expect(err(await s.resolve(s.intent.intentId, { kind: "link", remoteKey: "SYN-42" })).code).toBe("tracker_unavailable");
    expect(other.calls).toEqual([]);
    expect(s.f.calls.filter((c) => c.tool === "get_issue")).toEqual([]);
    expect(JSON.stringify(await s.plan())).toBe(before);
  });

  it.each([
    ["an issue of another project", { kind: "issue" as const, issue: { ...richIssue(1), id_readable: "SYN-42", project: { id: "0-9", slug: "OTHER" } } }, ["invalid_input"]],
    ["a different issue key than requested", { kind: "issue" as const, issue: { ...richIssue(1), id_readable: "SYN-77" } }, ["invalid_input", "not_found"]],
    ["a tool isError", { kind: "isError" as const, text: "not found" }, ["not_found"]],
  ] as const)("a get reply with %s on the original connection writes nothing and sends nothing", async (_name, reply, codes) => {
    const f = await startFakeSnailOrbit({ replies: { create_issue: [{ kind: "isError", text: "maybe" }], get_issue: [reply] } });
    fakes.push(f);
    env = await approvedPlan({ tasks: 1 });
    const e = env;
    e.connectionUrl.current = f.url;
    const audit = resolveMod.createAuditStore({ stateDir: e.stateDir, log: e.env.log });
    const t = e.tracker({ settings: async () => LIVE, live: { snailorbit: snail.createSnailOrbitAdapter({}) }, audit });
    const ref = { projectId: e.P, planId: e.planId };
    const p = ok(await t.preview(e.open, ref, UI_ORIGIN));
    ok(await t.apply(e.open, { ...ref, actionIds: [p.actions[0].actionId!], confirmToken: p.confirmToken, expectedRevision: p.storeRevision }, UI_ORIGIN));
    const read = async () => {
      const r = await (await e.open(e.P)).read();
      if (r.status !== "ok") throw new Error("store not ok");
      return JSON.stringify(r.data.plans);
    };
    const before = await read();
    const intentId = z.array(z.object({ intents: z.array(z.object({ intentId: z.string() })) })).parse(JSON.parse(before))[0].intents[0].intentId;
    const out = err(await t.resolve(e.open, { ...ref, intentId, planRev: e.rev, expectedRevision: await e.revision(), resolution: { kind: "link", remoteKey: "SYN-42" } }, UI_ORIGIN));
    expect(codes as readonly string[], JSON.stringify(reply)).toContain(out.code);
    expect(await read()).toBe(before);
    expect(f.writes()).toHaveLength(1); // only the original ambiguous create
    expect(await stat(join(e.stateDir, "tracker-audit", e.P, e.planId, `${intentId}.json`)).then(() => true, () => false)).toBe(false);
  });
});

describe("not_created", () => {
  it("marks a create intent failed human_not_created with an audit; a fresh preview offers a new create and the old token is rejected", async () => {
    const s = await unknownCreate();
    const callsBefore = s.f.calls.length;
    const out = ok(await s.resolve(s.intent.intentId, { kind: "not_created", confirm: true }));
    expect(out).toMatchObject({ state: "failed", auditRecorded: true });
    expect(s.f.calls.length, "zero adapter calls during resolve").toBe(callsBefore);
    const intent = (await s.plan()).intents[0];
    expect(intent).toMatchObject({ state: "failed", error: "human_not_created" });
    expect(JSON.parse(await readFile(s.auditPath(s.intent.intentId), "utf8"))).toMatchObject({ resolution: "not_created", actor: { kind: "human" } });
    const fresh = ok(await s.t.preview(s.e.open, s.ref, UI_ORIGIN));
    expect(fresh.actions[0]).toMatchObject({ kind: "create" });
    expect(fresh.actions[0].intentId).not.toBe(s.intent.intentId);
    const stale = await s.t.apply(s.e.open, { ...s.ref, actionIds: [fresh.actions[0].actionId!], confirmToken: s.p.confirmToken, expectedRevision: fresh.storeRevision }, UI_ORIGIN);
    expect(stale.ok ? "ok" : stale.error.code).toBe("tracker_token_mismatch");
    const listed = ok(await listTracker(s.e.open, s.ref, { processStartedAt: new Date("2026-10-20T10:00:00.000Z") }));
    expect(listed.intents.map((i) => [i.state, i.errorClass])).toEqual([["failed", "human_not_created"]]);
  });

  it("an audit publication failure still returns the durable project change with auditRecorded: false", async () => {
    const failing = wrapApprovalFs(nodeApprovalFs, { publishNoClobber: async () => Promise.reject(new Error("audit disk full")) });
    const s = await unknownCreate({ auditFs: failing.fs });
    const out = ok(await s.resolve(s.intent.intentId, { kind: "not_created", confirm: true }));
    expect(out).toMatchObject({ state: "failed", auditRecorded: false });
    expect((await s.plan()).intents[0]).toMatchObject({ state: "failed", error: "human_not_created" });
  });

  it("an interrupted pending create from before process start is resolvable", async () => {
    const s = await unknownCreate();
    const store = await s.e.open(s.e.P);
    await store.transact(await s.e.revision(), (d) => {
      const p = d.plans.find((x) => x.id === s.e.planId)!;
      p.intents.push({ ...p.intents[0], intentId: "int-old", state: "pending", createdAt: "2026-10-20T09:00:00.000Z", lastAttemptAt: "2026-10-20T09:00:00.000Z" } as TrackerIntent);
    });
    const t = s.e.tracker({ settings: async () => LIVE, live: { snailorbit: snail.createSnailOrbitAdapter({}) }, audit: resolveMod.createAuditStore({ stateDir: s.e.stateDir, log: s.e.env.log }), processStartedAt: new Date("2026-10-20T10:00:00.000Z") });
    const out = ok(await t.resolve(s.e.open, { ...s.ref, intentId: "int-old", planRev: s.e.rev, expectedRevision: await s.e.revision(), resolution: { kind: "not_created", confirm: true } }, UI_ORIGIN));
    expect(out.state).toBe("failed");
  });
});

describe("sent intents", () => {
  it("an interrupted sent intent is resolvable; an active sent intent of this process is not", async () => {
    const s = await unknownCreate();
    const store = await s.e.open(s.e.P);
    await store.transact(await s.e.revision(), (d) => {
      const p = d.plans.find((x) => x.id === s.e.planId)!;
      p.intents.push({ ...p.intents[0], intentId: "int-sent-old", state: "sent", createdAt: "2026-10-20T09:00:00.000Z", lastAttemptAt: "2026-10-20T09:00:00.000Z" } as TrackerIntent);
      p.intents.push({ ...p.intents[0], intentId: "int-sent-live", state: "sent", createdAt: "2026-10-20T11:00:00.000Z", lastAttemptAt: "2026-10-20T11:00:00.000Z" } as TrackerIntent);
    });
    const t = s.e.tracker({ settings: async () => LIVE, live: { snailorbit: snail.createSnailOrbitAdapter({}) }, audit: resolveMod.createAuditStore({ stateDir: s.e.stateDir, log: s.e.env.log }), processStartedAt: new Date("2026-10-20T10:00:00.000Z") });
    const resolve = async (intentId: string) =>
      t.resolve(s.e.open, { ...s.ref, intentId, planRev: s.e.rev, expectedRevision: await s.e.revision(), resolution: { kind: "not_created", confirm: true } }, UI_ORIGIN);
    expect(err(await resolve("int-sent-live")).code).toBe("tracker_intent_unresolved");
    expect(ok(await resolve("int-sent-old")).state).toBe("failed");
  });
});

describe("close intents", () => {
  /** Create confirmed through the real adapter, task verified, then a close whose update_issue reply is ambiguous. */
  async function unknownClose() {
    const f = await startFakeSnailOrbit({
      replies: {
        update_issue: [{ kind: "isError", text: "maybe closed" }],
        get_issue: [{ kind: "issue", issue: richIssue(1, false) }, { kind: "issue", issue: richIssue(1, true) }],
      },
    });
    fakes.push(f);
    env = await approvedPlan({ tasks: 1 });
    const e = env;
    e.connectionUrl.current = f.url;
    const audit = resolveMod.createAuditStore({ stateDir: e.stateDir, log: e.env.log });
    const t = e.tracker({ settings: async () => LIVE, live: { snailorbit: snail.createSnailOrbitAdapter({}) }, audit });
    const ref = { projectId: e.P, planId: e.planId };
    const run = async () => {
      const p = ok(await t.preview(e.open, ref, UI_ORIGIN));
      return ok(await t.apply(e.open, { ...ref, actionIds: p.actions.map((a) => a.actionId!).filter(Boolean), confirmToken: p.confirmToken, expectedRevision: p.storeRevision }, UI_ORIGIN));
    };
    await run();
    for (const status of ["in_progress", "done", "verified"] as const) {
      ok(await e.plans.taskUpdate(e.open, { projectId: e.P, expectedRevision: await e.revision(), planId: e.planId, planRev: e.rev, contentHash: e.contentHash, taskId: "t1", status, ...(status === "verified" ? { note: "checked" } : {}) }, UI_ORIGIN));
    }
    const out = await run();
    expect(out.results.map((r) => r.state)).toEqual(["unknown"]);
    const plan = async () => {
      const read = await (await e.open(e.P)).read();
      if (read.status !== "ok") throw new Error("store not ok");
      return read.data.plans.find((x) => x.id === e.planId)!;
    };
    const close = (await plan()).intents.find((i) => i.kind === "close")!;
    const remoteKey = (await plan()).tickets[0].remoteKey;
    const resolve = async (resolution: Resolution) =>
      t.resolve(e.open, { ...ref, intentId: close.intentId, planRev: e.rev, expectedRevision: await e.revision(), resolution }, UI_ORIGIN);
    return { e, f, t, ref, plan, close, remoteKey, resolve };
  }

  it("linking a close intent to a still-open issue is rejected; to the closed issue it marks the mapping closed", async () => {
    const s = await unknownClose();
    const before = JSON.stringify(await s.plan());
    const open = err(await s.resolve({ kind: "link", remoteKey: s.remoteKey }));
    expect(["invalid_input", "not_found"]).toContain(open.code);
    expect(JSON.stringify(await s.plan())).toBe(before);
    const closed = ok(await s.resolve({ kind: "link", remoteKey: s.remoteKey }));
    expect(closed).toMatchObject({ state: "confirmed", remoteKey: s.remoteKey });
    const plan = await s.plan();
    expect(plan.tickets.map((x) => [x.remoteKey, x.state])).toEqual([[s.remoteKey, "closed"]]);
    expect(plan.intents.find((i) => i.intentId === s.close.intentId)?.state).toBe("confirmed");
    expect(s.f.calls.filter((c) => c.tool === "update_issue"), "no re-send").toHaveLength(1);
  });

  it("a close intent cannot be confirmed by linking a different closed issue of the same project", async () => {
    const s = await unknownClose();
    expect(s.remoteKey).toBe("SYN-1");
    const before = JSON.stringify(await s.plan());
    const getsBefore = s.f.calls.filter((c) => c.tool === "get_issue").length;
    const out = await s.resolve({ kind: "link", remoteKey: "SYN-42" });
    expect(out.ok, "only the originally mapped ticket can confirm a close").toBe(false);
    expect(JSON.stringify(await s.plan())).toBe(before);
    const plan = await s.plan();
    expect(plan.tickets.map((x) => [x.remoteKey, x.state])).toEqual([["SYN-1", "created"]]);
    expect(plan.intents.find((i) => i.intentId === s.close.intentId)?.state).toBe("unknown");
    expect(s.f.calls.filter((c) => c.tool === "update_issue"), "no send").toHaveLength(1);
    expect(s.f.calls.filter((c) => c.tool === "get_issue").length).toBeGreaterThanOrEqual(getsBefore);
  });

  it("not_created on a close is human_close_not_applied: mapping stays created, a fresh close is offered", async () => {
    const s = await unknownClose();
    const out = ok(await s.resolve({ kind: "not_created", confirm: true }));
    expect(out.state).toBe("failed");
    const plan = await s.plan();
    expect(plan.intents.find((i) => i.intentId === s.close.intentId)).toMatchObject({ state: "failed", error: "human_close_not_applied" });
    expect(plan.tickets.map((x) => x.state)).toEqual(["created"]);
    expect(JSON.parse(await readFile(join(s.e.stateDir, "tracker-audit", s.e.P, s.e.planId, `${s.close.intentId}.json`), "utf8"))).toMatchObject({ resolution: "close_not_applied" });
    const fresh = ok(await s.t.preview(s.e.open, s.ref, UI_ORIGIN));
    expect(fresh.actions[0]).toMatchObject({ kind: "close" });
    expect(fresh.actions[0].intentId).not.toBe(s.close.intentId);
    expect(s.f.calls.filter((c) => c.tool === "update_issue")).toHaveLength(1);
  });
});

describe("redaction", () => {
  it("resolve logs carry no URL, payload or remote error text", async () => {
    const s = await unknownCreate();
    ok(await s.resolve(s.intent.intentId, { kind: "not_created", confirm: true }));
    const logs = s.e.logs.join("\n");
    expect(logs).not.toContain("synthetic-secret-path");
    expect(logs).not.toContain("remote said maybe");
    expect(logs).not.toContain("decision-roadmap intent");
    const files = await readdir(join(s.e.stateDir, "tracker-audit", s.e.P, s.e.planId));
    expect(files).toEqual([`${s.intent.intentId}.json`]);
  });
});
