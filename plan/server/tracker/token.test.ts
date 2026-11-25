// Tracker confirmation tokens and action ids (Stage 4 ruling 5, T4.3). Expected values are computed
// here with node:crypto over hand-written canonical JSON (sorted keys, no whitespace).
import { createHmac } from "node:crypto";
import { chmod, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DomainError } from "../../shared/errors";
import { makeApprovalEnv } from "../test-support/plans";
import { confirmToken, createTrackerKeyStore, decodeActionId, encodeActionId, tokensEqual, type Binding } from "./token";

const KEY = Buffer.from(Array.from({ length: 32 }, (_, i) => i + 1));
const A64 = "a".repeat(64);
const D64 = "d".repeat(64);

const actionA = { actionId: "act-a", kind: "create", taskId: "t1", intentId: "int-1", idempotencyKey: "dr:prj_test:plan-1:2:t1:create", payload: { title: "One", body: "b1" } };
const actionB = { actionId: "act-b", kind: "create", taskId: "t2", intentId: "int-2", idempotencyKey: "dr:prj_test:plan-1:2:t2:create", payload: { title: "Two", body: "b2" } };
const binding = (): Binding => ({
  v: 1,
  projectId: "prj_test",
  planId: "plan-1",
  planRev: 2,
  contentHash: A64,
  receiptId: "rcpt-1",
  destination: { provider: "none", projectKey: null },
  settingsDigest: D64,
  mode: "dry-run",
  storeRevision: 7,
  actions: [structuredClone(actionB), structuredClone(actionA)], // unsorted on purpose
});

const CANONICAL =
  '{"actions":[' +
  '{"actionId":"act-a","idempotencyKey":"dr:prj_test:plan-1:2:t1:create","intentId":"int-1","kind":"create","payload":{"body":"b1","title":"One"},"taskId":"t1"},' +
  '{"actionId":"act-b","idempotencyKey":"dr:prj_test:plan-1:2:t2:create","intentId":"int-2","kind":"create","payload":{"body":"b2","title":"Two"},"taskId":"t2"}],' +
  `"contentHash":"${A64}",` +
  '"destination":{"projectKey":null,"provider":"none"},' +
  '"mode":"dry-run","planId":"plan-1","planRev":2,"projectId":"prj_test","receiptId":"rcpt-1",' +
  `"settingsDigest":"${D64}",` +
  '"storeRevision":7,"v":1}';
const EXPECTED = createHmac("sha256", KEY).update(CANONICAL, "utf8").digest("base64url");

describe("confirmToken", () => {
  it("equals an independently computed HMAC-SHA256 over the canonical binding with actions sorted by actionId", () => {
    expect(confirmToken(KEY, binding())).toBe(EXPECTED);
    const sorted = { ...binding(), actions: [actionA, actionB] };
    expect(confirmToken(KEY, sorted)).toBe(EXPECTED);
  });

  it("changes when any binding field or any action field changes, and with another key", () => {
    const base = confirmToken(KEY, binding());
    // Edits an existing payload field in place; a payload without that field fails the fixture.
    const setPayloadField = (b: Binding, field: "title" | "body", value: string) => {
      const payload = b.actions[1].payload;
      if (payload === null || typeof payload !== "object" || !(field in payload)) throw new Error(`fixture payload has no ${field}`);
      Object.assign(payload, { [field]: value });
    };
    const edits: Array<[string, (b: Binding) => void]> = [
      ["projectId", (b) => (b.projectId = "prj_other")],
      ["planId", (b) => (b.planId = "plan-2")],
      ["planRev", (b) => (b.planRev = 3)],
      ["contentHash", (b) => (b.contentHash = "b".repeat(64))],
      ["receiptId", (b) => (b.receiptId = "rcpt-2")],
      ["destination", (b) => (b.destination = { provider: "snailorbit", projectKey: "SYN" })],
      ["settingsDigest", (b) => (b.settingsDigest = "e".repeat(64))],
      ["mode", (b) => (b.mode = "live")],
      ["storeRevision", (b) => (b.storeRevision = 8)],
      ["action actionId", (b) => (b.actions[1].actionId = "act-c")],
      ["action kind", (b) => (b.actions[1].kind = "close")],
      ["action taskId", (b) => (b.actions[1].taskId = "t9")],
      ["action intentId", (b) => (b.actions[1].intentId = "int-9")],
      ["action idempotencyKey", (b) => (b.actions[1].idempotencyKey = "dr:x")],
      ["action payload title", (b) => setPayloadField(b, "title", "Changed")],
      ["action payload body", (b) => setPayloadField(b, "body", "changed")],
      ["action removed", (b) => b.actions.pop()],
      ["action added", (b) => b.actions.push({ ...actionA, actionId: "act-z", taskId: "t3", intentId: "int-3" })],
    ];
    const seen = new Set([base]);
    for (const [name, edit] of edits) {
      const b = binding();
      edit(b);
      const token = confirmToken(KEY, b);
      expect(token, name).not.toBe(base);
      seen.add(token);
    }
    expect(seen.size).toBe(edits.length + 1);
    const otherKey = Buffer.from(KEY);
    otherKey[0] ^= 0xff;
    expect(confirmToken(otherKey, binding())).not.toBe(base);
  });

  it("a binding with a close action and connectionFp equals an independently computed HMAC (P4.6 close, C-ID)", () => {
    const close = { actionId: "act-c", kind: "close", taskId: "t1", intentId: "int-c", idempotencyKey: "dr:prj_test:plan-1:2:t1:close", payload: { issue_id: "SYN-1", fields: { State: "Done" } } };
    const FP = "f".repeat(43);
    const b = { ...binding(), mode: "live", connectionFp: FP, destination: { provider: "snailorbit", projectKey: "SYN" }, actions: [close] } as Binding;
    const literal =
      '{"actions":[{"actionId":"act-c","idempotencyKey":"dr:prj_test:plan-1:2:t1:close","intentId":"int-c","kind":"close","payload":{"fields":{"State":"Done"},"issue_id":"SYN-1"},"taskId":"t1"}],' +
      `"connectionFp":"${FP}",` +
      `"contentHash":"${A64}",` +
      '"destination":{"projectKey":"SYN","provider":"snailorbit"},' +
      '"mode":"live","planId":"plan-1","planRev":2,"projectId":"prj_test","receiptId":"rcpt-1",' +
      `"settingsDigest":"${D64}",` +
      '"storeRevision":7,"v":1}';
    expect(confirmToken(KEY, b)).toBe(createHmac("sha256", KEY).update(literal, "utf8").digest("base64url"));
    expect(confirmToken(KEY, { ...b, connectionFp: "g".repeat(43) } as Binding)).not.toBe(confirmToken(KEY, b));
    expect(confirmToken(KEY, { ...b, actions: [{ ...close, payload: { issue_id: "SYN-1", fields: { State: "Fixed" } } }] } as Binding)).not.toBe(confirmToken(KEY, b));
  });

  it("decodeActionId now accepts kind close (O3 settled)", () => {
    const id = encodeActionId({ intentId: "int-c", taskId: "t1", kind: "close", planRev: 2 });
    expect(decodeActionId(id)).toEqual({ intentId: "int-c", taskId: "t1", kind: "close", planRev: 2 });
  });

  it("tokensEqual accepts equal tokens and rejects different ones, including different lengths", () => {
    expect(tokensEqual(EXPECTED, EXPECTED)).toBe(true);
    const flipped = EXPECTED.slice(0, -1) + (EXPECTED.endsWith("A") ? "B" : "A");
    expect(tokensEqual(EXPECTED, flipped)).toBe(false);
    expect(tokensEqual(EXPECTED, EXPECTED.slice(0, -1))).toBe(false);
    expect(tokensEqual(EXPECTED, `${EXPECTED}x`)).toBe(false);
    expect(tokensEqual(EXPECTED, "")).toBe(false);
  });
});

describe("action ids", () => {
  const fields = { intentId: "01JABCDEFGHJKMNPQRSTVWXYZ0", taskId: "t1", kind: "create" as const, planRev: 2 };
  const raw = (obj: unknown) => Buffer.from(JSON.stringify(obj), "utf8").toString("base64url");

  it("encodes base64url(canonicalJson({ v, intentId, taskId, kind, planRev })) and round-trips", () => {
    const literal = '{"intentId":"01JABCDEFGHJKMNPQRSTVWXYZ0","kind":"create","planRev":2,"taskId":"t1","v":1}';
    const id = encodeActionId(fields);
    expect(id).toBe(Buffer.from(literal, "utf8").toString("base64url"));
    expect(decodeActionId(id)).toEqual(fields);
  });

  it("decoding rejects malformed ids with invalid_input", () => {
    const valid = { v: 1, ...fields };
    const bad: Array<[string, string]> = [
      ["bad base64 / not JSON", "!!!not-base64!!!"],
      ["empty", ""],
      ["unknown v", raw({ ...valid, v: 2 })],
      ["extra key", raw({ ...valid, extra: true })],
      ["missing key", raw({ v: 1, intentId: fields.intentId, taskId: "t1", kind: "create" })],
      ["id with slash", raw({ ...valid, taskId: "t/1" })],
      ["intent id with dots", raw({ ...valid, intentId: "../x" })],
      ["skip kind", raw({ ...valid, kind: "skip" })],
      ["non-integer planRev", raw({ ...valid, planRev: 1.5 })],
      ["JSON array", raw([1, 2])],
    ];
    for (const [name, id] of bad) {
      let caught: unknown;
      try {
        decodeActionId(id);
      } catch (e) {
        caught = e;
      }
      expect(caught, name).toBeInstanceOf(DomainError);
      expect(caught instanceof DomainError ? caught.code : caught, name).toBe("invalid_input");
    }
  });
});

describe("tracker key store", () => {
  let env: Awaited<ReturnType<typeof makeApprovalEnv>> | undefined;
  afterEach(async () => {
    await env?.cleanup();
    env = undefined;
  });

  it("publishes one 32-byte key at <stateDir>/tracker-key.json (0600, dir 0700) and reuses it after a restart", async () => {
    env = await makeApprovalEnv();
    const key = await createTrackerKeyStore({ stateDir: env.stateDir }).key();
    expect(Buffer.isBuffer(key)).toBe(true);
    expect(key.length).toBe(32);
    const file = join(env.stateDir, "tracker-key.json");
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await stat(env.stateDir)).mode & 0o777).toBe(0o700);
    expect((await readdir(env.stateDir)).filter((n) => n.includes("tracker-key") && n !== "tracker-key.json"), "no temp left").toEqual([]);
    const again = await createTrackerKeyStore({ stateDir: env.stateDir }).key();
    expect(again.equals(key)).toBe(true);
  });

  it("a corrupt key file fails closed with store_invalid and is neither rewritten nor regenerated", async () => {
    env = await makeApprovalEnv();
    await mkdir(env.stateDir, { recursive: true, mode: 0o700 });
    const file = join(env.stateDir, "tracker-key.json");
    for (const bytes of ["{ not json", JSON.stringify({ key: "c2hvcnQ" }), JSON.stringify({ unexpected: true })]) {
      await writeFile(file, bytes, { mode: 0o600 });
      let caught: unknown;
      try {
        await createTrackerKeyStore({ stateDir: env.stateDir }).key();
      } catch (e) {
        caught = e;
      }
      expect(caught, bytes).toBeInstanceOf(DomainError);
      expect(caught instanceof DomainError ? caught.code : caught, bytes).toBe("store_invalid");
      expect(await readFile(file, "utf8"), "bytes unchanged").toBe(bytes);
      expect((await readdir(env.stateDir)).filter((n) => n.includes("tracker-key")), "no replacement or temp").toEqual(["tracker-key.json"]);
    }
  });

  it("a key file readable by others fails closed with store_invalid and is not rewritten", async () => {
    env = await makeApprovalEnv();
    const key = await createTrackerKeyStore({ stateDir: env.stateDir }).key();
    const file = join(env.stateDir, "tracker-key.json");
    const bytes = await readFile(file, "utf8");
    await chmod(file, 0o644);
    let caught: unknown;
    try {
      await createTrackerKeyStore({ stateDir: env.stateDir }).key();
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(DomainError);
    expect(caught instanceof DomainError ? caught.code : caught).toBe("store_invalid");
    expect(await readFile(file, "utf8")).toBe(bytes);
    expect((await stat(file)).mode & 0o777, "mode left for the owner to fix").toBe(0o644);
    await chmod(file, 0o600);
    expect((await createTrackerKeyStore({ stateDir: env.stateDir }).key()).equals(key), "same key once fixed").toBe(true);
  });

  it("two concurrent stores on one stateDir agree on the key", async () => {
    env = await makeApprovalEnv();
    const [a, b] = await Promise.all([createTrackerKeyStore({ stateDir: env.stateDir }).key(), createTrackerKeyStore({ stateDir: env.stateDir }).key()]);
    expect(a.equals(b)).toBe(true);
    expect((await createTrackerKeyStore({ stateDir: env.stateDir }).key()).equals(a)).toBe(true);
  });
});
