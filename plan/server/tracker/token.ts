// Tracker confirmation tokens, stateless action ids and the per-install HMAC key (Stage 4 ruling 5).
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import { canonicalJson } from "../../shared/canonical";
import { DomainError } from "../../shared/errors";
import { nodeApprovalFs, type ApprovalFs } from "../approval-fs";
import { defaultStateDir } from "../mcp-state";

export type Binding = {
  v: 1;
  projectId: string;
  planId: string;
  planRev: number;
  contentHash: string;
  receiptId: string;
  destination: unknown;
  settingsDigest: string;
  mode: string;
  storeRevision: number;
  /** Keyed fingerprint of the live connection snapshot; null in dry-run or without a snapshot. */
  connectionFp?: string | null;
  actions: Array<{ actionId: string; kind: string; taskId: string; intentId: string; idempotencyKey: string; payload: unknown }>;
};

const byActionId = (a: { actionId: string }, b: { actionId: string }) => (a.actionId < b.actionId ? -1 : a.actionId > b.actionId ? 1 : 0);

/** base64url(HMAC-SHA256(key, canonicalJson(binding))), with actions sorted by actionId. */
export function confirmToken(key: Buffer, binding: Binding): string {
  const canonical = canonicalJson({ ...binding, actions: [...binding.actions].sort(byActionId) });
  return createHmac("sha256", key).update(canonical, "utf8").digest("base64url");
}

/** Constant-time comparison; unequal lengths are simply unequal. */
export function tokensEqual(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const x = Buffer.from(a, "utf8");
  const y = Buffer.from(b, "utf8");
  return x.length === y.length && timingSafeEqual(x, y);
}

const SafeId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const ActionIdFields = z
  .object({ v: z.literal(1), intentId: SafeId, taskId: SafeId, kind: z.enum(["create", "close"]), planRev: z.number().int().min(1) })
  .strict();
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;

export function encodeActionId(t: { intentId: string; taskId: string; kind: "create" | "close"; planRev: number }): string {
  const fields = { v: 1, intentId: t.intentId, taskId: t.taskId, kind: t.kind, planRev: t.planRev };
  return Buffer.from(canonicalJson(fields), "utf8").toString("base64url");
}

export function decodeActionId(id: string): { intentId: string; taskId: string; kind: "create" | "close"; planRev: number } {
  const invalid = () => new DomainError("invalid_input", "invalid tracker action id");
  if (typeof id !== "string" || id.length === 0 || id.length > 1024 || !BASE64URL_RE.test(id)) throw invalid();
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(id, "base64url").toString("utf8"));
  } catch {
    throw invalid();
  }
  const parsed = ActionIdFields.safeParse(raw);
  if (!parsed.success) throw invalid();
  const { intentId, taskId, kind, planRev } = parsed.data;
  // Only the canonical encoding is accepted, so one action has exactly one id.
  if (encodeActionId({ intentId, taskId, kind, planRev }) !== id) throw invalid();
  return { intentId, taskId, kind, planRev };
}

const KEY_FILE = "tracker-key.json";
const KeyFile = z.object({ version: z.literal(1), key: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict();

/**
 * The tracker HMAC key: 32 random bytes published once, no-clobber, at `<stateDir>/tracker-key.json`
 * as `{"version":1,"key":"<base64url>"}` (file 0600, directory 0700, directory fsync). An existing
 * file that is invalid or readable by others fails closed; it is never silently regenerated.
 */
export function createTrackerKeyStore(opts: { stateDir?: string; fs?: ApprovalFs }): { key(): Promise<Buffer> } {
  const fs = opts.fs ?? nodeApprovalFs;
  let cached: Promise<Buffer> | null = null;

  async function readExisting(path: string): Promise<Buffer | null> {
    const text = await fs.readFile(path);
    if (text === null) return null;
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      raw = undefined;
    }
    const parsed = KeyFile.safeParse(raw);
    const key = parsed.success ? Buffer.from(parsed.data.key, "base64url") : null;
    if (!key || key.length !== 32) throw new DomainError("store_invalid", "the tracker key file is invalid; it was not replaced");
    if (((await fs.mode(path)) & 0o077) !== 0) throw new DomainError("store_invalid", "the tracker key file is readable by others");
    return key;
  }

  async function load(): Promise<Buffer> {
    const stateDir = opts.stateDir ?? defaultStateDir();
    const path = join(stateDir, KEY_FILE);
    const existing = await readExisting(path);
    if (existing) return existing;
    await fs.ensureDir(stateDir);
    const fresh = randomBytes(32);
    const outcome = await fs.publishNoClobber(path, JSON.stringify({ version: 1, key: fresh.toString("base64url") }));
    if (outcome === "created") return fresh;
    const winner = await readExisting(path); // a concurrent store published first
    if (!winner) throw new DomainError("store_invalid", "the tracker key file disappeared");
    return winner;
  }

  return {
    key() {
      cached ??= load().catch((e) => {
        cached = null; // allow a later retry after a transient failure; nothing was overwritten
        throw e;
      });
      return cached;
    },
  };
}
