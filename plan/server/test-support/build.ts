// Synthetic fixture builders for Stage 0 tests. Every builder returns schema-valid data.
import { readFileSync } from "node:fs";
import { z } from "zod";
import {
  Session,
  type Activation,
  type Answer,
  type Invalidation,
  type Option,
  type Question,
  type Ref,
} from "../../shared/model";
import type { AnswerInput } from "../../shared/graph";

/** Narrows parsed JSON to an object; no schema, so every key is kept (no stripping, coercion or defaults). */
export const isJsonObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Parses JSON text that must be an object, keeping every key: corruption fixtures can spread and re-serialise it unchanged. */
export function readJsonObject(text: string): Record<string, unknown> {
  const value: unknown = JSON.parse(text);
  if (!isJsonObject(value)) throw new Error("expected a JSON object");
  return value;
}

/** A string field of a parsed JSON object; anything else throws instead of flowing on as a non-string. */
export function jsonString(o: Record<string, unknown>, key: string): string {
  const v = o[key];
  if (typeof v !== "string") throw new Error(`expected a string at "${key}"`);
  return v;
}

export const NOW = new Date("2026-10-20T10:00:00.000Z");
export const NOW_ISO = NOW.toISOString();
export const fixedClock = () => NOW;

/** Deterministic 26-char Crockford-valid ids (digits only), unique within one test run. */
let idSeq = 0;
export const nextId = (): string => String(++idSeq).padStart(26, "0");
export const counterIds = () => nextId;

export const r = (sessionId: string, questionId: string): Ref => ({ sessionId, questionId });

export const opt = (id: string): Option => ({ id, label: `Option ${id}` });

export const act = (parent: Ref, ...optionIds: string[]): Activation => ({ parent, optionIds });

export const inv = (upstream: Ref): Invalidation => ({ upstream });

export function q(id: string, partial: Partial<Question> = {}): Question {
  return {
    id,
    order: 0,
    title: `Question ${id}`,
    context: "",
    options: [],
    allowFreeText: false,
    definitionRev: 1,
    activatedBy: [],
    invalidatedBy: [],
    revisions: [],
    discussion: [],
    validity: "unanswered",
    ...partial,
  };
}

/** Returns `question` with `rev` revisions all choosing `optionId`; validity `valid`. */
export function answered(question: Question, optionId: string, rev = 1): Question {
  const revisions: Answer[] = Array.from({ length: rev }, (_, i) => ({
    rev: i + 1,
    optionId,
    source: "ui",
    actor: { kind: "human" },
    at: NOW_ISO,
  }));
  return {
    ...question,
    answer: revisions[revisions.length - 1],
    revisions,
    validity: "valid",
    stale: undefined,
  };
}

export function session(id: string, qs: Question[]): Session {
  return Session.parse({
    id,
    title: `Session ${id}`,
    createdAt: NOW_ISO,
    status: "active",
    questions: qs.map((question, i) => ({ ...question, order: question.order || i })),
  });
}

/** Answer input as the UI or chat would submit it. */
export const pick = (optionId: string, source: "ui" | "chat" = "ui"): AnswerInput => ({
  optionId,
  source,
  actor: source === "ui" ? { kind: "human" } : { kind: "agent", agentId: "agent-test" },
  at: NOW_ISO,
});

export const confirmBy = { source: "ui" as const, actor: { kind: "human" as const }, at: NOW_ISO };

/**
 * `server/fixtures/session-branching.json`:
 * s1: q1(a,b); q2(yes,no) activated by q1∈{b}; q3(c,d) invalidated by q1; q4(c,d) invalidated by q3.
 * s2: x1(y,n) activated by s1/q2∈{yes}, invalidated by s1/q1.
 */
export function loadBranching(): Session[] {
  const raw = z.object({ sessions: z.array(z.unknown()) }).parse(
    JSON.parse(readFileSync(new URL("../fixtures/session-branching.json", import.meta.url), "utf8")),
  );
  return raw.sessions.map((s) => Session.parse(s));
}
