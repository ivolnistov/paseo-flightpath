// The question.out_of_scope UI contract: a revision-checked mutation on one question with an
// optional reason, answering with the new revision and the questions whose visibility changed.
import { describe, expect, it } from "vitest";
import { z } from "zod";
import * as discussionContracts from "./rpc-discussion";
import { QuestionOutOfScope, SessionFinish as SessionFinishExport } from "./rpc-discussion";
import { need } from "../server/test-support/grilling";

const input = { projectId: "prj_test", expectedRevision: 3, sessionId: "s1", questionId: "q1" };

describe("question.out_of_scope", () => {
  it("is named question.out_of_scope", () => {
    expect(QuestionOutOfScope.name).toBe("question.out_of_scope");
  });

  it("takes the mutation and question fields, with an optional reason", () => {
    expect(QuestionOutOfScope.input.parse(input)).toEqual(input);
    expect(QuestionOutOfScope.input.parse({ ...input, reason: "not this release" })).toEqual({ ...input, reason: "not this release" });
    for (const key of Object.keys(input)) {
      const { [key]: _drop, ...missing } = input as Record<string, unknown>;
      expect(QuestionOutOfScope.input.safeParse(missing).success, key).toBe(false);
    }
    expect(QuestionOutOfScope.input.safeParse({ ...input, expectedRevision: 0 }).success).toBe(false);
  });

  it("returns the revision and the visibility changes, or an error", () => {
    const value = { revision: 4, visibilityChanged: [{ sessionId: "s1", questionId: "q2" }] };
    expect(QuestionOutOfScope.output.parse({ ok: true, value })).toEqual({ ok: true, value });
    expect(QuestionOutOfScope.output.safeParse({ ok: true, value: { revision: 4 } }).success).toBe(false);
    expect(QuestionOutOfScope.output.parse({ ok: false, error: { code: "decision_cancelled", message: "m" } }).ok).toBe(false);
  });
});

// session.finish: the owner's explicit Finish, a revision-checked mutation on one session, with the
// basis it is given on: accepting the chat's proposal shown at `proposalAt`, or a manual finish.
describe("session.finish", () => {
  const T = "2026-11-09T10:00:00.000Z";
  const mutation = { projectId: "prj_test", expectedRevision: 3, sessionId: "s1" };
  const manual = { ...mutation, basis: "manual" };
  const proposal = { ...mutation, basis: "proposal", proposalAt: T };

  it("is named session.finish, takes a manual or a proposal basis and returns the revision", () => {
    const SessionFinish = need(SessionFinishExport, "rpc-discussion.SessionFinish");
    expect(SessionFinish.name).toBe("session.finish");
    expect(SessionFinish.input.parse(manual)).toEqual(manual);
    expect(SessionFinish.input.parse(proposal)).toEqual(proposal);
    expect(SessionFinish.output.safeParse({ ok: true, value: { revision: 4 } }).success).toBe(true);
  });

  it("is a strict union: a missing or unknown basis, a proposal without proposalAt and a manual basis with proposalAt are rejected", () => {
    const SessionFinish = need(SessionFinishExport, "rpc-discussion.SessionFinish");
    const { proposalAt: _p, ...proposalWithoutAt } = proposal;
    for (const [label, bad] of [
      ["missing basis (the earlier request shape)", mutation],
      ["unknown basis", { ...mutation, basis: "automatic" }],
      ["proposal without proposalAt", proposalWithoutAt],
      ["proposalAt not an ISO time", { ...proposal, proposalAt: "yesterday" }],
      ["manual with proposalAt", { ...manual, proposalAt: T }],
      ["unknown sibling on manual", { ...manual, note: "x" }],
      ["unknown sibling on proposal", { ...proposal, hostClientId: "c1" }],
    ] as const) {
      expect(SessionFinish.input.safeParse(bad).success, label).toBe(false);
    }
  });

  it("each basis still needs the mutation fields", () => {
    const SessionFinish = need(SessionFinishExport, "rpc-discussion.SessionFinish");
    for (const input of [manual, proposal]) {
      for (const key of Object.keys(mutation)) {
        const missing = Object.fromEntries(Object.entries(input).filter(([k]) => k !== key));
        expect(SessionFinish.input.safeParse(missing).success, `${input.basis} without ${key}`).toBe(false);
      }
      expect(SessionFinish.input.safeParse({ ...input, expectedRevision: 0 }).success, `${input.basis} at revision 0`).toBe(false);
    }
  });
});

// feature.discussion.open: the one-click creation of a feature's discussion chat (UI only).
describe("feature.discussion.open", () => {
  type ContractLike = { name: string; input: z.ZodType; output: z.ZodType };
  const isContract = (x: unknown): x is ContractLike =>
    typeof x === "object" && x !== null && "name" in x && typeof x.name === "string" && "input" in x && x.input instanceof z.ZodType && "output" in x && x.output instanceof z.ZodType;
  const contract = (): ContractLike => {
    const found: unknown = Object.entries(discussionContracts).find(([k]) => k === "FeatureDiscussionOpen")?.[1];
    if (!isContract(found)) throw new Error("missing export: rpc-discussion.FeatureDiscussionOpen");
    return found;
  };
  const input = { projectId: "prj_test", expectedRevision: 3, featureId: "f1", workspaceId: "wks_1" };

  it("takes the mutation fields, the feature and the panel's workspace, with an optional non-empty profile", () => {
    const c = contract();
    expect(c.name).toBe("feature.discussion.open");
    expect(c.input.parse(input)).toEqual(input);
    expect(c.input.parse({ ...input, profileRef: "alt" })).toEqual({ ...input, profileRef: "alt" });
    expect(c.input.safeParse({ ...input, profileRef: "" }).success).toBe(false);
    // Owner decision: retrying an unresolved creation carries the owner's explicit confirmation
    // that no chat was created.
    expect(c.input.parse({ ...input, retryUnresolved: true, confirmedNoChat: true })).toMatchObject({ confirmedNoChat: true });
    expect(c.input.safeParse({ ...input, confirmedNoChat: false }).success).toBe(false);
    for (const key of Object.keys(input)) {
      const { [key]: _drop, ...missing } = input as Record<string, unknown>;
      expect(c.input.safeParse(missing).success, key).toBe(false);
    }
  });

  it("returns the session, agent and workspace, whether it created the chat, and one of four tools states", () => {
    const c = contract();
    const value = { revision: 4, sessionId: "s1", agentId: "a1", workspaceId: "wks_1", created: true, tools: "pending" };
    expect(c.output.safeParse({ ok: true, value }).success).toBe(true);
    for (const tools of ["attached", "pending", "not_attached", "unknown"]) expect(c.output.safeParse({ ok: true, value: { ...value, tools } }).success, tools).toBe(true);
    expect(c.output.safeParse({ ok: true, value: { ...value, tools: "maybe" } }).success).toBe(false);
    const { created: _c, ...noCreated } = value;
    expect(c.output.safeParse({ ok: true, value: noCreated }).success).toBe(false);
  });
});

// Manual continuation retry: the press, the owner's mark and the timeline check.
describe("discussion.retry contracts", () => {
  type ContractLike = { name: string; input: z.ZodType; output: z.ZodType };
  const isContract = (x: unknown): x is ContractLike =>
    typeof x === "object" && x !== null && "name" in x && typeof x.name === "string" && "input" in x && x.input instanceof z.ZodType && "output" in x && x.output instanceof z.ZodType;
  const contract = (exportName: string): ContractLike => {
    const found: unknown = Object.entries(discussionContracts).find(([k]) => k === exportName)?.[1];
    if (!isContract(found)) throw new Error(`missing export: rpc-discussion.${exportName}`);
    return found;
  };
  const base = { projectId: "prj_test", expectedRevision: 3, sessionId: "s1" };

  it("discussion.retry: a revision-checked press answering the retry id, the planner and sent or sending", () => {
    const c = contract("DiscussionRetry");
    expect(c.name).toBe("discussion.retry");
    expect(c.input.safeParse(base).success).toBe(true);
    const { expectedRevision: _e, ...noRevision } = base;
    expect(c.input.safeParse(noRevision).success).toBe(false);
    const value = { revision: 4, retryId: "r1", sentTo: "agent-1", state: "sent" };
    expect(c.output.safeParse({ ok: true, value }).success).toBe(true);
    expect(c.output.safeParse({ ok: true, value: { ...value, state: "sending" } }).success).toBe(true);
    expect(c.output.safeParse({ ok: true, value: { ...value, state: "unknown" } }).success).toBe(false);
  });

  it("discussion.retry.resolve: the owner marks a retry delivered or not delivered", () => {
    const c = contract("DiscussionRetryResolve");
    expect(c.name).toBe("discussion.retry.resolve");
    for (const outcome of ["delivered", "not_delivered"]) expect(c.input.safeParse({ ...base, retryId: "r1", outcome }).success, outcome).toBe(true);
    expect(c.input.safeParse({ ...base, retryId: "r1", outcome: "maybe" }).success).toBe(false);
    expect(c.input.safeParse({ ...base, outcome: "delivered" }).success).toBe(false);
  });

  it("discussion.retry.check: a read without a revision, answering the record's state", () => {
    const c = contract("DiscussionRetryCheck");
    expect(c.name).toBe("discussion.retry.check");
    expect(c.input.safeParse({ projectId: "prj_test", sessionId: "s1", retryId: "r1" }).success).toBe(true);
    for (const state of ["sending", "sent", "failed", "unknown"]) expect(c.output.safeParse({ ok: true, value: { state } }).success, state).toBe(true);
  });
});
