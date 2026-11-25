import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { AgentRoleSchema } from "../shared/run";

const Id = z.string().min(1).max(512);

/** Authority of one agent: an attempt and role of a run, or the workflow chat of one project. */
export const GrantSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("attempt"), runId: Id, attemptId: Id, role: AgentRoleSchema, agentId: Id }).strict(),
  z.object({ kind: z.literal("workflow"), projectId: Id, agentId: Id }).strict(),
]);
export type Grant = z.output<typeof GrantSchema>;

const MAX_TOKEN_CHARS = 4_096;

function mac(secret: string, text: string): Buffer {
  return createHmac("sha256", secret).update(text).digest();
}

export function signGrant(secret: string, grant: Grant): string {
  const payload = Buffer.from(JSON.stringify(GrantSchema.parse(grant))).toString("base64url");
  return `${payload}.${mac(secret, `grant:${payload}`).toString("base64url")}`;
}

/** The grant a token carries, or null for a malformed token or a wrong signature. */
export function verifyGrant(secret: string, token: string): Grant | null {
  if (token.length > MAX_TOKEN_CHARS) return null;
  const parts = token.split(".");
  const [payload, signature] = parts;
  if (parts.length !== 2 || !payload || !signature) return null;
  const expected = mac(secret, `grant:${payload}`);
  const given = Buffer.from(signature, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  const parsed = GrantSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** An unforgeable reservation id for a subject such as a creation key. */
export function reservationId(secret: string, subject: string): string {
  return `rsv_${mac(secret, `reservation:${subject}`).toString("base64url").slice(0, 32)}`;
}

export function sameReservation(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
