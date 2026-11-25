import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  ApprovalBlocker,
  PlanDraft,
  PlanSummary,
  PlanView,
  QuestionAnswer,
  QuestionCreate,
  RoadmapInit,
  SessionView,
  STAGE1_CONTRACTS,
  STAGE3_CONTRACTS,
  STAGE4_CONTRACTS,
  STAGE_R0_CONTRACTS,
  STAGE_R1_CONTRACTS,
  TaskInput,
  TaskUpdate,
  result,
} from "./rpc";

const QUERIES = new Set(["roadmap.version", "roadmap.init", "roadmap.overview", "session.get"]);
const FORBIDDEN_KEYS = new Set(["storeRoot", "path", "root", "cwd"]);

type Def = { type: string; shape?: Record<string, z.ZodType>; options?: z.ZodType[]; innerType?: z.ZodType; element?: z.ZodType; in?: z.ZodType; out?: z.ZodType; left?: z.ZodType; right?: z.ZodType };
const isSchema = (v: unknown): v is z.ZodType => v instanceof z.ZodType;
/** A def field read as unknown (zod's def union has no common index signature). */
const field = (def: object, k: string): unknown => {
  const v: unknown = Reflect.get(def, k);
  return v;
};
/** The traversal-relevant parts of a zod v4 def, each checked to be a schema. */
const defOf = (s: z.ZodType): Def => {
  const def = s._zod.def;
  const out: Def = { type: def.type };
  const shape = field(def, "shape");
  if (typeof shape === "object" && shape !== null) out.shape = Object.fromEntries(Object.entries(shape).filter((e): e is [string, z.ZodType] => isSchema(e[1])));
  const options = field(def, "options");
  if (Array.isArray(options)) out.options = options.filter(isSchema);
  for (const k of ["innerType", "element", "in", "out", "left", "right"] as const) {
    const v = field(def, k);
    if (isSchema(v)) out[k] = v;
  }
  return out;
};

/** Every object key reachable through objects, unions, wrappers, arrays and pipes. */
function keysOf(schema: z.ZodType, seen = new Set<z.ZodType>()): string[] {
  if (seen.has(schema)) return [];
  seen.add(schema);
  const def = defOf(schema);
  const children: z.ZodType[] = [];
  const keys: string[] = [];
  if (def.shape) {
    keys.push(...Object.keys(def.shape));
    children.push(...Object.values(def.shape));
  }
  for (const k of ["options"] as const) if (def[k]) children.push(...def[k]);
  for (const k of ["innerType", "element", "in", "out", "left", "right"] as const) if (def[k]) children.push(def[k]);
  return [...keys, ...children.flatMap((c) => keysOf(c, seen))];
}

const issuePaths = (schema: z.ZodType, value: unknown) => {
  const parsed = schema.safeParse(value);
  return parsed.success ? [] : parsed.error.issues.map((i) => i.path.join("."));
};

describe("Stage 1 RPC contracts", () => {
  it("have unique names and every input requires projectId", () => {
    const names = STAGE1_CONTRACTS.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names.length).toBe(15);
    for (const c of STAGE1_CONTRACTS) {
      expect(issuePaths(c.input, {}), c.name).toContain("projectId");
    }
  });

  it("take no path-like input anywhere", () => {
    for (const c of STAGE1_CONTRACTS) {
      expect(keysOf(c.input).filter((k) => FORBIDDEN_KEYS.has(k)), c.name).toEqual([]);
    }
  });

  it("require an integer expectedRevision >= 1 on every mutation and on no query", () => {
    for (const c of STAGE1_CONTRACTS) {
      const shapeKeys = Object.keys(defOf(c.input).shape ?? {});
      if (QUERIES.has(c.name)) {
        expect(shapeKeys, c.name).not.toContain("expectedRevision");
        continue;
      }
      expect(shapeKeys, c.name).toContain("expectedRevision");
      for (const bad of [undefined, 0, 1.5, "1"]) {
        expect(issuePaths(c.input, { projectId: "prj_test", expectedRevision: bad }), `${c.name} ${String(bad)}`).toContain(
          "expectedRevision",
        );
      }
      expect(issuePaths(c.input, { projectId: "prj_test", expectedRevision: 1 }), c.name).not.toContain("expectedRevision");
    }
    expect(RoadmapInit.input.safeParse({ projectId: "prj_test" }).success).toBe(true);
  });

  it("question.answer input accepts optionId, text, or both (exclusivity is service-level)", () => {
    const base = { projectId: "prj_test", expectedRevision: 1, sessionId: "s1", questionId: "q1" };
    for (const extra of [{ optionId: "a" }, { text: "free" }, { optionId: "a", text: "free" }]) {
      expect(QuestionAnswer.input.safeParse({ ...base, ...extra }).success).toBe(true);
    }
  });

  it("result() parses an error envelope with a known code and rejects an unknown one", () => {
    const schema = result(z.object({ revision: z.number() }));
    expect(schema.safeParse({ ok: false, error: { code: "revision_conflict", message: "moved" } }).success).toBe(true);
    expect(schema.safeParse({ ok: false, error: { code: "internal", message: "boom" } }).success).toBe(true);
    expect(schema.safeParse({ ok: false, error: { code: "teapot", message: "no" } }).success).toBe(false);
    expect(schema.safeParse({ ok: true, value: { revision: 2 } }).success).toBe(true);
    expect(schema.safeParse({ ok: true, value: { revision: "2" } }).success).toBe(false);
  });
});

// Redesign Stage R0.6 (task card §7.2/§7.3, §9 items 10-11): contract modules aggregate without an
// initialisation cycle; question.create takes blockId; session views admit blocks; R0 contracts.
describe("R0.6 contract integration", () => {
  const loaders: Array<[string, () => Promise<Record<string, unknown>>]> = [
    ["rpc-blocks", () => import("./rpc-blocks")],
    ["rpc-dod", () => import("./rpc-dod")],
    ["rpc-features", () => import("./rpc-features")],
    ["rpc-decisions", () => import("./rpc-decisions")],
    ["rpc-base", () => import("./rpc-base")],
  ];

  for (const [name, load] of loaders) {
    it(`importing ${name} first, then ./rpc, leaves every contract defined (no initialisation cycle)`, async () => {
      vi.resetModules();
      const first = await load();
      for (const [key, value] of Object.entries(first)) expect(value, `${name}.${key}`).toBeDefined();
      const rpc = await import("./rpc");
      const base = await import("./rpc-base");
      expect(rpc.STAGE_R0_CONTRACTS).toHaveLength(9);
      for (const c of [...rpc.STAGE1_CONTRACTS, ...rpc.STAGE3_CONTRACTS, ...rpc.STAGE4_CONTRACTS, ...rpc.STAGE_R0_CONTRACTS]) {
        expect(c, name).toBeDefined();
        expect(typeof c.name).toBe("string");
        expect(c.input).toBeDefined();
        expect(c.output).toBeDefined();
      }
      expect(rpc.RPC_ERROR_CODES).toBe(base.RPC_ERROR_CODES);
      expect(rpc.result).toBe(base.result);
    });
  }

  it("the contract modules import ./rpc-base and never ./rpc; rpc-base imports only zod, ./model and a type-only ./errors", () => {
    const specifiers = (file: string) =>
      [...readFileSync(new URL(`./${file}`, import.meta.url), "utf8").matchAll(/^import\s+(type\s+)?[^;]*?from\s+"([^"]+)";/gms)].map((m) => ({
        typeOnly: m[1] !== undefined,
        from: m[2],
      }));
    for (const file of ["rpc-blocks.ts", "rpc-dod.ts", "rpc-features.ts", "rpc-decisions.ts"]) {
      const froms = specifiers(file).map((x) => x.from);
      expect(froms, file).not.toContain("./rpc");
      expect(froms, file).toContain("./rpc-base");
    }
    for (const { typeOnly, from } of specifiers("rpc-base.ts")) {
      if (from === "./errors") expect(typeOnly, "rpc-base imports ./errors as a type only").toBe(true);
      else expect(["zod", "./model"], from).toContain(from);
    }
  });

  it("question.create accepts the shipped input with or without blockId and rejects an empty blockId", () => {
    const shipped = {
      projectId: "prj_test",
      expectedRevision: 2,
      sessionId: "s1",
      title: "Q1",
      context: "",
      options: [{ id: "a", label: "A" }],
      allowFreeText: false,
      activatedBy: [],
      invalidatedBy: [],
    };
    expect(QuestionCreate.input.parse(shipped)).toEqual(shipped);
    expect(QuestionCreate.input.parse({ ...shipped, blockId: "b1" })).toEqual({ ...shipped, blockId: "b1" });
    expect(QuestionCreate.input.safeParse({ ...shipped, blockId: "" }).success).toBe(false);
  });

  const view = (session: Record<string, unknown>) => ({ revision: 3, session, questions: [], links: [], catalog: [], cancellations: [] });
  const legacySession = { id: "s1", title: "Legacy", createdAt: "2026-10-26T10:00:00.000Z", status: "active" };

  it("SessionView parses a legacy view exactly as today (no blocks key)", () => {
    const parsed = SessionView.parse(view(legacySession));
    expect(Object.keys(parsed.session).sort()).toEqual(["createdAt", "id", "status", "title"]);
    expect(parsed.session).toEqual(legacySession);
  });

  it("SessionView keeps the blocks of a blocked session and still rejects unknown session keys", () => {
    const blocks = [
      { id: "b1", order: 0, state: "accepted", openedAt: "2026-10-26T10:00:00.000Z", acceptedAt: "2026-10-26T11:00:00.000Z", acceptedBy: { kind: "human" } },
      { id: "b2", order: 1, state: "open", openedAt: "2026-10-26T11:00:00.000Z" },
    ];
    const parsed = SessionView.parse(view({ ...legacySession, blocks }));
    expect((parsed.session as { blocks?: unknown }).blocks).toEqual(blocks);
    expect(SessionView.safeParse(view({ ...legacySession, extra: 1 })).success).toBe(false);
    expect(SessionView.safeParse(view({ ...legacySession, blocks: [{ id: "b1", order: 0, state: "accepted", openedAt: "2026-10-26T10:00:00.000Z" }] })).success).toBe(false);
  });

  it("STAGE_R0_CONTRACTS holds exactly the nine R0 contracts, none shared with stages 1, 3 and 4", () => {
    const names = STAGE_R0_CONTRACTS.map((c) => c.name);
    expect([...names].sort()).toEqual(
      [
        "block.accept",
        "dod.template.get",
        "feature.create",
        "feature.delete",
        "feature.dependencies.set",
        "feature.list",
        "feature.reorder",
        "feature.status.set",
        "feature.update",
      ].sort(),
    );
    const earlier = new Set([...STAGE1_CONTRACTS, ...STAGE3_CONTRACTS, ...STAGE4_CONTRACTS].map((c) => c.name));
    for (const n of names) expect(earlier.has(n), n).toBe(false);
    const all = [...earlier, ...names];
    expect(new Set(all).size).toBe(all.length);
  });

  it("the R0 contracts take no path-like input", () => {
    for (const c of STAGE_R0_CONTRACTS) expect(keysOf(c.input).filter((k) => FORBIDDEN_KEYS.has(k)), c.name).toEqual([]);
  });
});

// question.create may carry the owner's first free-text answer; its output then reports the
// answer's revision. The session view carries the closures and a finished proposal's finishedBy.
describe("question.create answerText and the finish basis in the session view", () => {
  const shipped = {
    projectId: "prj_test",
    expectedRevision: 2,
    sessionId: "s1",
    title: "Where do sessions live?",
    context: "",
    options: [],
    allowFreeText: true,
    activatedBy: [],
    invalidatedBy: [],
    blockId: "b1",
  };
  const created = { revision: 3, questionId: "q1", visibilityChanged: [] };

  it("question.create keeps a non-empty answerText and rejects an empty or non-string one", () => {
    expect(QuestionCreate.input.parse({ ...shipped, answerText: "Postgres" })).toEqual({ ...shipped, answerText: "Postgres" });
    expect(QuestionCreate.input.parse(shipped)).toEqual(shipped);
    expect(QuestionCreate.input.safeParse({ ...shipped, answerText: "" }).success).toBe(false);
    expect(QuestionCreate.input.safeParse({ ...shipped, answerText: 1 }).success).toBe(false);
  });

  it("the question.create output keeps rev 1 when present, parses without it, and rejects any other rev", () => {
    expect(QuestionCreate.output.parse({ ok: true, value: { ...created, rev: 1 } })).toEqual({ ok: true, value: { ...created, rev: 1 } });
    expect(QuestionCreate.output.parse({ ok: true, value: created })).toEqual({ ok: true, value: created });
    expect(QuestionCreate.output.safeParse({ ok: true, value: { ...created, rev: 2 } }).success).toBe(false);
  });

  const T0 = "2026-11-09T10:00:00.000Z";
  const T1 = "2026-11-09T10:05:00.000Z";
  const T2 = "2026-11-09T10:10:00.000Z";
  const session = { id: "s1", title: "Discussion", createdAt: T0, status: "closed" };
  const view = (s: Record<string, unknown>) => ({ revision: 3, session: s, questions: [], links: [], catalog: [], cancellations: [] });
  const finished = { at: T0, agentId: "agent-1", summary: "Done", skipped: [], outOfScope: [], finishedAt: T1, finishedBy: "manual" };
  const closures = [
    { at: T1, basis: "proposal", proposalAt: T0, source: "ui", actor: { kind: "human" }, reopenedAt: T2 },
    { at: T2, basis: "manual", source: "ui", actor: { kind: "human" } },
  ];

  it("SessionView round-trips closures and finishedBy", () => {
    const v = view({ ...session, finishProposal: finished, finishHistory: [{ ...finished, finishedBy: "proposal" }], closures });
    expect(SessionView.parse(v)).toEqual(v);
  });

  it("SessionView without the new fields parses as before, and still rejects unknown session keys", () => {
    const v = view(session);
    const parsed = SessionView.parse(v);
    expect(parsed).toEqual(v);
    expect(Object.keys(parsed.session).sort()).toEqual(["createdAt", "id", "status", "title"]);
    expect(SessionView.safeParse(view({ ...session, closures, closure: closures[0] })).success).toBe(false);
    expect(SessionView.safeParse(view({ ...session, closures: [{ ...closures[1], basis: "automatic" }] })).success).toBe(false);
  });
});

// Stage R1.0 (card §1.2, §7 C1/C2): task inputs carry the optional v2 fields strictly and without
// schema defaults, so the server can tell a legacy request from a v2 request; plan views carry
// approval blockers; summaries carry the feature binding.
describe("R1.0 plan contracts", () => {
  const v2Task = { id: "t1", title: "Build", description: "do", dependsOn: ["t0"], parallel: true, completion: "human", grill: true, dod: "Tests pass" };

  it("TaskInput keeps every supplied v2 field exactly as given", () => {
    expect(TaskInput.parse(v2Task)).toEqual(v2Task);
  });

  it("TaskInput adds no defaults: an omitted v2 field stays absent", () => {
    const parsed = TaskInput.parse({ title: "Build", description: "do" });
    expect(Object.keys(parsed).sort()).toEqual(["description", "title"]);
    expect(Object.keys(TaskInput.parse({ title: "Build", description: "do", grill: false })).sort()).toEqual(["description", "grill", "title"]);
  });

  it("TaskInput stays strict: unknown keys, grillSessionId and bad values are rejected", () => {
    const base = { title: "Build", description: "do" };
    for (const extra of [{ grillSessionId: "s1" }, { status: "done" }, { x: 1 }, { completion: "agent" }, { parallel: "yes" }, { dependsOn: "t0" }, { dod: 1 }]) {
      expect(TaskInput.safeParse({ ...base, ...extra }).success, JSON.stringify(extra)).toBe(false);
    }
    expect(TaskInput.safeParse(base).success).toBe(true);
  });

  it("PlanDraft input accepts an optional featureId and v2 task fields, and keeps them", () => {
    const base = { projectId: "prj_test", expectedRevision: 1, title: "P", sessionIds: ["s1"], markdown: "# P", tasks: [v2Task] };
    const parsed = PlanDraft.input.parse({ ...base, featureId: "f1" }) as Record<string, unknown>;
    expect(parsed.featureId).toBe("f1");
    expect(z.array(z.unknown()).parse(parsed.tasks)[0]).toEqual(v2Task);
    expect(PlanDraft.input.safeParse(base).success).toBe(true);
    expect(PlanDraft.input.safeParse({ ...base, featureId: "" }).success).toBe(false);
  });

  it("ApprovalBlocker is strict with the four codes", () => {
    for (const code of ["gates_not_available", "dod_missing", "grilling_required", "legacy_revision"]) {
      expect(ApprovalBlocker.safeParse({ code }).success, code).toBe(true);
    }
    expect(ApprovalBlocker.safeParse({ code: "dod_missing", taskId: "t1" }).success).toBe(true);
    expect(ApprovalBlocker.safeParse({ code: "grilling_required", taskId: "t1", sessionId: "s1" }).success).toBe(true);
    expect(ApprovalBlocker.safeParse({ code: "other" }).success).toBe(false);
    expect(ApprovalBlocker.safeParse({ code: "dod_missing", reason: "x" }).success).toBe(false);
  });

  const view = {
    revision: 3,
    plan: { id: "p1", title: "P", sessionIds: ["s1"], revisions: [], taskStates: [] },
    approvals: [],
    approval: "unapproved",
    notCurrentReasons: [],
    exportWritten: true,
  };

  it("PlanView requires blockers and parses the shared blocker shape", () => {
    expect(PlanView.safeParse({ ...view, blockers: [{ code: "gates_not_available" }] }).success).toBe(true);
    expect(PlanView.safeParse({ ...view, blockers: [] }).success).toBe(true);
    expect(PlanView.safeParse(view).success).toBe(false);
    expect(PlanView.safeParse({ ...view, blockers: [{ code: "unknown" }] }).success).toBe(false);
  });

  it("PlanSummary carries an optional featureId", () => {
    const summary = { id: "p1", title: "P", latestRev: 1, approval: "unapproved" };
    expect(PlanSummary.parse({ ...summary, featureId: "f1" })).toEqual({ ...summary, featureId: "f1" });
    expect(PlanSummary.parse(summary)).toEqual(summary);
  });
});

// Stage R1.3a (task card §4.1.2): the UI-only decision.cancel contract in its own module, a new
// STAGE_R1_CONTRACTS aggregate (R0 unchanged), the decision_cancelled code, and a required
// SessionView.cancellations list.
describe("R1.3a decision contracts", () => {
  const loadDecisions = async () => await import("./rpc-decisions");
  const base = { projectId: "prj_test", expectedRevision: 2, sessionId: "s1", questionId: "q1" };
  const record = { id: "c1", ref: { sessionId: "s1", questionId: "q1" }, reason: "Dropped", at: "2026-10-26T10:00:00.000Z", actor: { kind: "human" } };
  const session = { id: "s1", title: "S", createdAt: "2026-10-26T10:00:00.000Z", status: "active" };
  const view = (extra: Record<string, unknown>) => ({ revision: 3, session, questions: [], links: [], catalog: [], ...extra });

  it("DecisionCancel is decision.cancel with sessionId, questionId and a non-empty reason, returning a cancellationId", async () => {
    const { DecisionCancel } = await loadDecisions();
    expect(DecisionCancel.name).toBe("decision.cancel");
    expect(DecisionCancel.input.parse({ ...base, reason: "Dropped" })).toEqual({ ...base, reason: "Dropped" });
    expect(DecisionCancel.input.safeParse({ ...base, reason: "" }).success).toBe(false);
    for (const missing of ["sessionId", "questionId", "reason", "expectedRevision", "projectId"]) {
      const input: Record<string, unknown> = { ...base, reason: "Dropped" };
      delete input[missing];
      expect(DecisionCancel.input.safeParse(input).success, missing).toBe(false);
    }
    const ok = DecisionCancel.output.parse({ ok: true, value: { revision: 3, cancellationId: "c1" } });
    expect(ok).toEqual({ ok: true, value: { revision: 3, cancellationId: "c1" } });
    expect(DecisionCancel.output.safeParse({ ok: true, value: { revision: 3 } }).success).toBe(false);
    expect(DecisionCancel.output.parse({ ok: false, error: { code: "decision_cancelled", message: "already cancelled" } })).toMatchObject({ ok: false });
  });

  it("the input carries no actor, id or timestamp authority: extra keys never reach the parsed input", async () => {
    const { DecisionCancel } = await loadDecisions();
    const parsed = DecisionCancel.input.safeParse({ ...base, reason: "Dropped", actor: { kind: "agent", agentId: "a1" }, id: "forged", at: "2026-01-01T00:00:00.000Z" });
    if (parsed.success) {
      for (const k of ["actor", "id", "at"]) expect(parsed.data, k).not.toHaveProperty(k);
    }
  });

  it("STAGE_R1_CONTRACTS is exactly [decision.cancel], disjoint from every earlier stage; STAGE_R0_CONTRACTS still holds nine", async () => {
    // Both modules from the same module generation (earlier tests reset the registry).
    const { DecisionCancel } = await loadDecisions();
    const current = await import("./rpc");
    expect(current.STAGE_R1_CONTRACTS.map((c: { name: string }) => c.name)).toEqual(["decision.cancel"]);
    expect(current.STAGE_R1_CONTRACTS[0]).toBe(DecisionCancel);
    expect(STAGE_R1_CONTRACTS.map((c: { name: string }) => c.name)).toEqual(["decision.cancel"]);
    expect(STAGE_R0_CONTRACTS).toHaveLength(9);
    const earlier = new Set([...STAGE1_CONTRACTS, ...STAGE3_CONTRACTS, ...STAGE4_CONTRACTS, ...STAGE_R0_CONTRACTS].map((c) => c.name));
    expect(earlier.has("decision.cancel")).toBe(false);
  });

  it("decision_cancelled is an RPC error code (envelope parses); an unknown code still does not", async () => {
    const { RPC_ERROR_CODES } = await import("./rpc-base");
    expect(RPC_ERROR_CODES).toContain("decision_cancelled");
    const envelope = result(z.object({ revision: z.number() }));
    expect(envelope.safeParse({ ok: false, error: { code: "decision_cancelled", message: "x" } }).success).toBe(true);
    expect(envelope.safeParse({ ok: false, error: { code: "not_a_code", message: "x" } }).success).toBe(false);
  });

  // Each cancellation in the view also lists its dependents to cancel or re-ask.
  it("SessionView requires cancellations with their dependents and parses the records; malformed records are rejected", () => {
    const shown = { ...record, dependents: [] };
    expect(SessionView.parse(view({ cancellations: [shown] }))).toMatchObject({ cancellations: [shown] });
    expect(SessionView.parse(view({ cancellations: [] }))).toMatchObject({ cancellations: [] });
    expect(SessionView.safeParse(view({})).success).toBe(false);
    expect(SessionView.safeParse(view({ cancellations: [record] })).success).toBe(false);
    expect(SessionView.safeParse(view({ cancellations: [{ ...shown, reason: " untrimmed" }] })).success).toBe(false);
    // Agent cancellations (roadmap_cancel_question) carry the agent id; an unidentified agent is rejected.
    expect(SessionView.safeParse(view({ cancellations: [{ ...shown, actor: { kind: "agent", agentId: "a1" } }] })).success).toBe(true);
    expect(SessionView.safeParse(view({ cancellations: [{ ...shown, actor: { kind: "agent" } }] })).success).toBe(false);
  });
});

// Stage R2.3 (task card 2026-10-29 §4.2): contract shapes only; registration lists change in R2.4.
// PlanRework is new in R2.3, so it is loaded from the module namespace and checked before use.
describe("R2.3 rework and cancellation contract shapes", () => {
  const planView = {
    revision: 3,
    plan: { id: "p1", title: "P", sessionIds: ["s1"], revisions: [], taskStates: [] },
    approvals: [],
    approval: "unapproved",
    notCurrentReasons: [],
    exportWritten: false,
    blockers: [],
  };
  const update = { projectId: "prj_test", expectedRevision: 1, planId: "p1", planRev: 1, contentHash: "a".repeat(64), taskId: "t1" };

  it("task.update input rejects cancelled; every other status, and UI verified with a note, still parse", () => {
    for (const status of ["todo", "in_progress", "done"]) expect(TaskUpdate.input.safeParse({ ...update, status }).success, status).toBe(true);
    expect(TaskUpdate.input.safeParse({ ...update, status: "verified", note: "Checked" }).success).toBe(true);
    expect(TaskUpdate.input.safeParse({ ...update, status: "cancelled" }).success).toBe(false);
    expect(TaskUpdate.input.safeParse({ ...update, status: "cancelled", note: "x" }).success).toBe(false);
  });

  it("PlanView.reuseCandidates is optional; entries carry planRev, taskId, title and an optional verifiedAt", () => {
    expect(PlanView.safeParse(planView).success, "absent (older servers and fixtures)").toBe(true);
    const dated = { planRev: 1, taskId: "t1", title: "Build", verifiedAt: "2026-10-28T10:00:00.000Z" };
    const undated = { planRev: 2, taskId: "t2", title: "Ship" };
    const parsed = PlanView.safeParse({ ...planView, reuseCandidates: [undated, dated] });
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    expect(parsed.data?.reuseCandidates).toEqual([undated, dated]);
    expect(parsed.data?.reuseCandidates?.[0] !== undefined && "verifiedAt" in parsed.data.reuseCandidates[0]).toBe(false);
    for (const bad of [{ ...undated, planRev: 0 }, { ...undated, taskId: "" }, { planRev: 1, taskId: "t1" }, { ...dated, verifiedAt: "yesterday" }]) {
      expect(PlanView.safeParse({ ...planView, reuseCandidates: [bad] }).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it("plan.rework (rpc-features): name, input planId, planRev and a trimmed non-empty reason of at most 2000 characters; output Written", async () => {
    const features = await import("./rpc-features");
    expect(typeof features.PlanRework, "rpc-features defines PlanRework").toBe("object");
    const c = features.PlanRework;
    expect(c.name).toBe("plan.rework");
    const base = { projectId: "prj_test", expectedRevision: 2, planId: "p1", planRev: 1 };
    const parsed = c.input.safeParse({ ...base, reason: "  Scope changed  " });
    expect(parsed.success).toBe(true);
    expect(parsed.data?.reason).toBe("Scope changed");
    expect(c.input.safeParse({ ...base, reason: "x".repeat(2000) }).success).toBe(true);
    for (const bad of [{ ...base, reason: "" }, { ...base, reason: "   " }, { ...base, reason: "x".repeat(2001) }, { ...base, planRev: 0, reason: "r" }, { projectId: "prj_test", expectedRevision: 2, planRev: 1, reason: "r" }]) {
      expect(c.input.safeParse(bad).success, JSON.stringify(bad).slice(0, 80)).toBe(false);
    }
    expect(c.output.safeParse({ ok: true, value: { revision: 3 } }).success).toBe(true);
    expect(c.output.safeParse({ ok: false, error: { code: "invalid_input", message: "rework only in the Paseo UI" } }).success).toBe(true);
  });
});

/** A contract list: an array whose every element carries a string name (runtime-checked type guard). */
const isContractList = (v: unknown): v is ReadonlyArray<{ name: string }> =>
  Array.isArray(v) && v.every((c: unknown) => typeof c === "object" && c !== null && "name" in c && typeof c.name === "string");

// Stage R2.4 (task card 2026-10-29 §5): PlanRework is registered: the rpc-features definition appears
// exactly once across the exported stage contract lists, and every registered contract name is unique.
describe("R2.4 plan.rework registration list", () => {
  it("the PlanRework definition is in exactly one STAGE*_CONTRACTS list; names stay unique across lists", async () => {
    const rpc = await import("./rpc");
    const { PlanRework } = await import("./rpc-features");
    const lists = Object.entries(rpc).flatMap(([k, v]): Array<[string, ReadonlyArray<{ name: string }>]> => (/^STAGE.*_CONTRACTS$/.test(k) && isContractList(v) ? [[k, v]] : []));
    expect(lists.map(([k]) => k).sort(), "every STAGE*_CONTRACTS export is a contract list").toEqual(Object.keys(rpc).filter((k) => /^STAGE.*_CONTRACTS$/.test(k)).sort());
    expect(lists.map(([k]) => k)).toEqual(expect.arrayContaining(["STAGE1_CONTRACTS", "STAGE3_CONTRACTS", "STAGE4_CONTRACTS", "STAGE_R0_CONTRACTS", "STAGE_R1_CONTRACTS"]));
    const holding = lists.filter(([, v]) => v.some((c) => c === PlanRework)).map(([k]) => k);
    expect(holding, "PlanRework is registered in exactly one stage list").toHaveLength(1);
    const names = lists.flatMap(([, v]) => v.map((c) => c.name));
    expect(names.filter((n) => n === "plan.rework")).toEqual(["plan.rework"]);
    expect(new Set(names).size, "contract names are unique across lists").toBe(names.length);
  });
});

// R2 corrective c0015 (task card 2026-10-29 §8.4, §8.6): PlanView.approvalEffectsPending is an
// optional strict output field; older payloads without it stay valid.
describe("R2 corrective c0015: PlanView.approvalEffectsPending shape", () => {
  const view = {
    revision: 3,
    plan: { id: "p1", title: "P", sessionIds: ["s1"], revisions: [], taskStates: [] },
    approvals: [],
    approval: "current",
    notCurrentReasons: [],
    exportWritten: true,
    blockers: [],
  };
  const copy = { effect: "project_copy", reason: "the project copy of approval r1 is not recorded" };
  const planned = { effect: "feature_planned", reason: "the feature is still created" };

  it("absent stays valid; both effects parse, with and without retryBlocked", () => {
    expect(PlanView.safeParse(view).success, "an older payload without the field").toBe(true);
    const parsed = PlanView.safeParse({ ...view, approvalEffectsPending: [copy, planned] });
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    expect(parsed.data?.approvalEffectsPending).toEqual([copy, planned]);
    const blocked = { ...copy, retryBlocked: "feature_has_multiple_plans" };
    const withBlocked = PlanView.safeParse({ ...view, approvalEffectsPending: [blocked] });
    expect(withBlocked.success, JSON.stringify(withBlocked.error?.issues)).toBe(true);
    expect(withBlocked.data?.approvalEffectsPending).toEqual([blocked]);
  });

  it("rejects unknown effects, unknown retryBlocked values, unknown keys and missing fields", () => {
    const parses = (entries: unknown[]) => PlanView.safeParse({ ...view, approvalEffectsPending: entries }).success;
    expect(parses([copy]), "control").toBe(true);
    for (const bad of [
      { effect: "receipt", reason: "x" },
      { ...copy, retryBlocked: "feature_has_plan" },
      { ...copy, retryBlocked: "other" },
      { ...copy, extra: 1 },
      { effect: "project_copy" },
      { reason: "x" },
    ]) {
      expect(parses([bad]), JSON.stringify(bad)).toBe(false);
    }
  });
});

// Stage R3.1 (task card 2026-10-29 R3 §1.2): run_stale and run_not_ready are RPC error codes; a
// refused start carries readiness data in details.blocked. Unknown codes still do not parse.
describe("R3.1 run error codes", () => {
  it("RPC_ERROR_CODES include run_stale and run_not_ready; the error envelope parses them with details", async () => {
    const { RPC_ERROR_CODES, RpcError } = await import("./rpc-base");
    expect(RPC_ERROR_CODES).toContain("run_stale");
    expect(RPC_ERROR_CODES).toContain("run_not_ready");
    expect(RpcError.safeParse({ code: "run_stale", message: "the run token is stale" }).success).toBe(true);
    expect(RpcError.safeParse({ code: "run_not_ready", message: "not ready", details: { blocked: [{ code: "approval_not_current" }] } }).success).toBe(true);
    expect(RpcError.safeParse({ code: "run_unknown", message: "x" }).success, "control: unknown codes are rejected").toBe(false);
  });
});

// R3.1 verification control (root-authorised): run contract shapes (defined in rpc-runs, registered in
// a stage list only in R3.5).
describe("R3.1 run contract shapes", () => {
  it("names, inputs and outputs; run.budget.grant cycles is an integer 1..1000", async () => {
    const r = await import("./rpc-runs");
    // R3.5 (card §6.2a): CoordinatorReplace is appended to RUN_CONTRACTS.
    expect(r.RUN_CONTRACTS.map((c) => c.name)).toEqual(["run.start", "run.pause", "run.resume", "run.budget.grant", "delegation.revoke", "run.get", "run.list", "coordinator.replace"]);
    const base = { projectId: "prj_test", expectedRevision: 3 };
    const runRef = { ...base, runId: "run-1", runToken: "tok-1" };
    expect(r.RunStart.input.safeParse({ ...base, featureId: "f1" }).success).toBe(true);
    expect(r.RunStart.input.safeParse({ ...base, featureId: "f1", profileRef: "team-coordinator" }).success).toBe(true);
    expect(r.RunStart.input.safeParse({ ...base, featureId: "f1", profileRef: "" }).success).toBe(false);
    expect(r.RunStart.input.safeParse({ ...base }).success).toBe(false);
    expect(r.RunStart.output.safeParse({ ok: true, value: { revision: 4, runId: "run-1", runToken: "tok-1", existing: false } }).success).toBe(true);
    for (const c of [r.RunPause, r.RunResume]) {
      expect(c.input.safeParse(runRef).success, c.name).toBe(true);
      expect(c.input.safeParse({ ...base, runId: "run-1" }).success, `${c.name} needs runToken`).toBe(false);
    }
    for (const cycles of [1, 1000]) expect(r.RunBudgetGrant.input.safeParse({ ...runRef, taskId: "t1", cycles }).success, String(cycles)).toBe(true);
    for (const cycles of [0, 1001, 1.5, -1]) expect(r.RunBudgetGrant.input.safeParse({ ...runRef, taskId: "t1", cycles }).success, String(cycles)).toBe(false);
    expect(r.DelegationRevoke.input.safeParse({ ...base, delegationId: "d1" }).success).toBe(true);
    expect(r.DelegationRevoke.input.safeParse(base).success).toBe(false);
    expect(r.RunGet.input.safeParse({ projectId: "prj_test", runId: "run-1" }).success).toBe(true);
    expect(r.RunList.input.safeParse({ projectId: "prj_test" }).success).toBe(true);
    expect(r.RunList.input.safeParse({ projectId: "prj_test", featureId: "f1" }).success).toBe(true);
    expect(r.RunList.output.safeParse({ ok: false, error: { code: "run_stale", message: "x" } }).success).toBe(true);
  });

  // R3.5 (card §6.2a "Tables"): EXPECTED FLIP of the R3.1 "not yet registered" assertion. The run and
  // evidence contracts are now registered, each in exactly one stage list (STAGE_R3_CONTRACTS); the
  // count and uniqueness controls are kept.
  it("the run and evidence contracts are registered exactly once (STAGE_R3_CONTRACTS)", async () => {
    const rpc: Record<string, unknown> = await import("./rpc");
    const { RUN_CONTRACTS, RUN_EVIDENCE_CONTRACTS } = await import("./rpc-runs");
    const lists = Object.entries(rpc).flatMap(([k, v]) => (/^STAGE.*_CONTRACTS$/.test(k) && isContractList(v) ? [v] : []));
    const names = lists.flat().map((c) => c.name);
    expect(names.length, "control: the registered lists are found").toBeGreaterThan(20);
    expect(new Set(names).size, "names stay unique across lists").toBe(names.length);
    for (const c of [...RUN_CONTRACTS, ...RUN_EVIDENCE_CONTRACTS]) expect(names.filter((n) => n === c.name), c.name).toEqual([c.name]);
    expect(isContractList(rpc.STAGE_R3_CONTRACTS), "STAGE_R3_CONTRACTS exists").toBe(true);
    const r3 = (await import("./rpc")).STAGE_R3_CONTRACTS.map((c) => c.name);
    expect(r3).toEqual([...RUN_CONTRACTS, ...RUN_EVIDENCE_CONTRACTS].map((c) => c.name));
    expect(r3).toContain("coordinator.replace");
  });
});

// Stage R3.4 (task card 2026-10-29 R3 §1.2, §5.1): delegation_unverified is an RPC error code; RunView
// gains an optional derived `unresolved: string[]` (absent for older payloads). Registration of the
// run contracts stays R3.5 (the R3.1 "not yet registered" assertion above is kept).
describe("R3.4 run contract additions", () => {
  it("delegation_unverified is an RPC error code", async () => {
    const { RPC_ERROR_CODES, RpcError } = await import("./rpc-base");
    expect(RPC_ERROR_CODES).toContain("delegation_unverified");
    expect(RpcError.safeParse({ code: "delegation_unverified", message: "no such message" }).success).toBe(true);
  });

  it("RunView.unresolved is optional and a list of strings", async () => {
    const { RunView } = await import("./rpc-runs");
    const run = {
      id: "run-1", featureId: "f1", planId: "p1", planRev: 1, runToken: "tok", state: "paused", pauseReason: "owner",
      startAuth: { kind: "ui", at: "2026-10-29T10:00:00.000Z" }, tasks: [], acks: [], events: [{ at: "2026-10-29T10:00:00.000Z", kind: "started" }], lateEvidence: [],
    };
    expect(RunView.safeParse({ run, ready: [], blocked: [] }).success, "older payload without unresolved").toBe(true);
    const withUnresolved = RunView.safeParse({ run, ready: [], blocked: [], unresolved: ["initial prompt not delivered: offline"] });
    expect(withUnresolved.success).toBe(true);
    expect(withUnresolved.data?.unresolved).toEqual(["initial prompt not delivered: offline"]);
    expect(RunView.safeParse({ run, ready: [], blocked: [], unresolved: [1] }).success).toBe(false);
  });
});

// Stage R3.5 (card §6.2a): CoordinatorReplace (UI only) and the NotReady member pause_unacknowledged.
describe("R3.5 replacement contract and pause_unacknowledged", () => {
  it("coordinator.replace input { projectId, expectedRevision, featureId, profileRef } and output { revision, agentId, workspaceId }", async () => {
    const r: Record<string, unknown> = await import("./rpc-runs");
    expect(typeof r.CoordinatorReplace, "rpc-runs defines CoordinatorReplace").toBe("object");
    const { CoordinatorReplace, RUN_CONTRACTS } = await import("./rpc-runs");
    expect(CoordinatorReplace.name).toBe("coordinator.replace");
    expect(RUN_CONTRACTS.map((c) => c.name)).toContain("coordinator.replace");
    const base = { projectId: "prj_test", expectedRevision: 3, featureId: "f1" };
    expect(CoordinatorReplace.input.safeParse({ ...base, profileRef: "team-coordinator" }).success).toBe(true);
    for (const bad of [base, { ...base, profileRef: "" }, { projectId: "prj_test", expectedRevision: 3, profileRef: "x" }]) {
      expect(CoordinatorReplace.input.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
    expect(CoordinatorReplace.output.safeParse({ ok: true, value: { revision: 4, agentId: "a2", workspaceId: "ws-1" } }).success).toBe(true);
    expect(CoordinatorReplace.output.safeParse({ ok: true, value: { revision: 4, agentId: "a2" } }).success).toBe(false);
  });

  it("pause_unacknowledged is a NotReady code", async () => {
    const { NotReady } = await import("./rpc-runs");
    expect(NotReady.safeParse({ code: "pause_unacknowledged", taskId: "t1" }).success).toBe(true);
  });
});

// Stage R4.4 (task card §5.2 G2): the feature.list output schema accepts `delegations`
// (StartDelegation[], revoked ones with revokedAt); revision and features are unchanged.
describe("R4.4 feature.list output schema", () => {
  it("accepts delegations (including a revoked one) and still requires revision and features", async () => {
    const { FeatureList } = await import("./rpc-features");
    const D = { id: "d1", scope: "roadmap", grantedAt: "2026-10-29T10:00:00.000Z", revokedAt: "2026-10-29T11:00:00.000Z", provenance: { agentId: "agent-1", seqStart: 1, timestamp: "2026-10-29T10:00:00.000Z", quoted: "go" } };
    const value = { revision: 3, features: [], delegations: [D] };
    const parsed = FeatureList.output.safeParse({ ok: true, value });
    expect(parsed.success).toBe(true);
    if (parsed.success && parsed.data.ok) expect((parsed.data.value as Record<string, unknown>).delegations, "delegations are kept, not stripped").toEqual([D]);
    expect(FeatureList.output.safeParse({ ok: true, value: { features: [], delegations: [] } }).success, "revision still required").toBe(false);
    expect(FeatureList.output.safeParse({ ok: true, value: { revision: 3, features: [], delegations: [{ id: "bad" }] } }).success, "entries are StartDelegation").toBe(false);
  });
});
