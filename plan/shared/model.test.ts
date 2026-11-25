// Schema v2 model contract (redesign Stage R0.1, task card §2.1/§2.5). The legacy store fixture is a
// verbatim synthetic copy of `.handoff/synthetic-home-decisions`; expected digests are computed here
// with node:crypto over canonical JSON, not through the production hash helpers.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { canonicalJson, deepClone } from "./canonical";
import {
  Block,
  Cancellation,
  cancellationRefIssues,
  Feature,
  FinishProposal,
  isLegacyPlan,
  isV2Revision,
  Plan,
  PlanRevision,
  PlanRevisionV1,
  PlanRevisionV2,
  PlanV1,
  ProjectSettings,
  Question,
  QuestionV1,
  RoadmapDataV1,
  RoadmapDataV2,
  RoadmapMeta,
  RoadmapMetaV1,
  RoadmapMetaV2,
  Session,
  SessionV1,
  StartDelegation,
  TaskDefinitionV2,
  taskGraphIssues,
} from "./model";

const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

// ---------------------------------------------------------------------------------------------
// Fixture: current generation of the synthetic v1 store, assembled exactly as the store loads it.

const STORE = fileURLToPath(new URL("../server/fixtures/v1-store/", import.meta.url));
const CURRENT_GEN = "g-0000000026-01M5FQB4DD1W73S39XF2DVX7V5";
const CHANGE_TOKEN = "3bdc6330cd6a760a243085879621d6f97e02bcb5d4abf455da97929a6b0908e3";
const PROJECT_ID = "prj_2d93f94da090e78c";

type Json = any; // raw fixture JSON; deliberately untyped so tests can mutate it freely

const readJson = (rel: string): Json => JSON.parse(readFileSync(`${STORE}${rel}`, "utf8"));

/** Fresh `{ meta, sessions, plans }` of the current generation, in meta id order. */
function fixtureData(): Json {
  const gen = `generations/${CURRENT_GEN}`;
  const meta = readJson(`${gen}/roadmap.json`);
  return {
    meta,
    sessions: meta.sessionIds.map((id: string) => readJson(`${gen}/sessions/${id}.json`)),
    plans: meta.planIds.map((id: string) => readJson(`${gen}/plans/${id}.json`)),
  };
}

/** Parse must succeed and return data whose canonical form equals the input's (invariant I1). */
function expectVerbatim(schema: { parse: (x: unknown) => unknown }, input: unknown): void {
  const before = canonicalJson(input);
  const parsed = schema.parse(input);
  expect(canonicalJson(parsed)).toBe(before);
  expect(parsed).toEqual(input);
  expect(canonicalJson(input), "parse must not mutate its input").toBe(before);
}

const rejects = (schema: { safeParse: (x: unknown) => { success: boolean } }, input: unknown) =>
  expect(schema.safeParse(input).success).toBe(false);
const accepts = (schema: { safeParse: (x: unknown) => { success: boolean } }, input: unknown) =>
  expect(schema.safeParse(input).success).toBe(true);

// ---------------------------------------------------------------------------------------------
// Synthetic v2 builders (plain JSON; never produced by production code).

const T0 = "2026-10-26T10:00:00.000Z";
const T1 = "2026-10-26T11:00:00.000Z";

function v2Task(id: string, partial: Record<string, unknown> = {}): Json {
  return {
    id,
    title: `Task ${id}`,
    description: `Description ${id}`,
    dependsOn: [],
    parallel: false,
    completion: "auto",
    grill: false,
    dod: "",
    ...partial,
  };
}

/** A fixture v1 revision rewritten as schema 2 with the given v2 tasks. */
function v2Revision(tasks: Json[] = [v2Task("t1")]): Json {
  const base = fixtureData().plans[0].revisions[0];
  return { ...base, schema: 2, tasks };
}

function block(id: string, order: number, accepted = false): Json {
  return accepted
    ? { id, order, state: "accepted", openedAt: T0, acceptedAt: T1, acceptedBy: { kind: "human", hostClientId: "client-1" } }
    : { id, order, state: "open", openedAt: T0 };
}

/** A fixture session converted to blocks: first question in accepted b1, the rest in open b2. */
function blockSession(): Json {
  const s = fixtureData().sessions[0];
  return {
    ...s,
    blocks: [block("b1", 0, true), block("b2", 1)],
    questions: s.questions.map((q: Json, i: number) => ({ ...q, blockId: i === 0 ? "b1" : "b2" })),
  };
}

function feature(partial: Record<string, unknown> = {}): Json {
  return {
    id: "f1",
    title: "Feature one",
    description: "Synthetic feature",
    kind: "feature",
    status: "created",
    dependsOn: [],
    relatedTo: [],
    everStarted: false,
    createdAt: T0,
    createdBy: { kind: "human", hostClientId: "client-1" },
    coordinatorHistory: [],
    events: [{ at: T0, actor: { kind: "human" }, kind: "created" }],
    ...partial,
  };
}

function v2Meta(partial: Record<string, unknown> = {}): Json {
  return { ...fixtureData().meta, version: 2, featureIds: [], runIds: [], settings: {}, ...partial };
}

function v2Data(): Json {
  const d = fixtureData();
  return { meta: v2Meta(), sessions: d.sessions, plans: d.plans, features: [], runs: [], delegations: [] };
}

function delegation(partial: Record<string, unknown> = {}): Json {
  return {
    id: "d1",
    scope: "feature",
    featureId: "f1",
    provenance: { agentId: "agent-1", messageId: "m1", seqStart: 4, turnId: "turn-1", timestamp: T0, quoted: "start it" },
    grantedAt: T0,
    ...partial,
  };
}

// ---------------------------------------------------------------------------------------------

describe("synthetic v1 fixture", () => {
  it("is the expected synthetic store: one project, 3 sessions, 1 plan, 3 revisions, 2 approvals, no intents or tickets", () => {
    const manifest = readJson("manifest.json");
    expect(manifest).toMatchObject({ version: 1, projectId: PROJECT_ID, generation: CURRENT_GEN, changeToken: CHANGE_TOKEN });
    const d = fixtureData();
    expect(d.meta.projectId).toBe(PROJECT_ID);
    expect(d.sessions).toHaveLength(3);
    expect(d.plans).toHaveLength(1);
    expect(d.plans[0].revisions).toHaveLength(3);
    expect(d.plans[0].approvals).toHaveLength(2);
    expect(d.plans[0].intents).toEqual([]);
    expect(d.plans[0].tickets).toEqual([]);
  });
});

describe("RoadmapDataV1: strict legacy round trip (I1, I2)", () => {
  it("parses the fixture generation verbatim and its canonical sha256 equals the manifest changeToken", () => {
    const input = fixtureData();
    expectVerbatim(RoadmapDataV1, input);
    expect(sha(canonicalJson(RoadmapDataV1.parse(input)))).toBe(CHANGE_TOKEN);
  });

  it("every legacy component schema parses its fixture objects verbatim", () => {
    const d = fixtureData();
    expectVerbatim(RoadmapMetaV1, d.meta);
    for (const s of d.sessions) {
      expectVerbatim(SessionV1, s);
      for (const q of s.questions) expectVerbatim(QuestionV1, q);
    }
    for (const p of d.plans) {
      expectVerbatim(PlanV1, p);
      for (const rev of p.revisions) expectVerbatim(PlanRevisionV1, rev);
    }
  });

  const v2Only: Array<[string, (d: Json) => void]> = [
    ["a revision with schema: 2", (d) => (d.plans[0].revisions[2].schema = 2)],
    ["a plan with featureId", (d) => (d.plans[0].featureId = "f1")],
    ["a session with blocks: []", (d) => (d.sessions[1].blocks = [])],
    ["a question with blockId", (d) => (d.sessions[0].questions[0].blockId = "b1")],
    ["meta with featureIds", (d) => (d.meta.featureIds = [])],
    ["meta with runIds", (d) => (d.meta.runIds = [])],
    ["meta with settings", (d) => (d.meta.settings = {})],
    ["meta with version: 2", (d) => (d.meta.version = 2)],
    ["a top-level features array", (d) => (d.features = [])],
    ["a top-level runs array", (d) => (d.runs = [])],
    ["a top-level delegations array", (d) => (d.delegations = [])],
    ["a v1 task carrying a v2 field", (d) => (d.plans[0].revisions[0].tasks[0].dependsOn = [])],
  ];
  for (const [name, edit] of v2Only) {
    it(`rejects the fixture with ${name}`, () => {
      const d = fixtureData();
      edit(d);
      rejects(RoadmapDataV1, d);
    });
  }

  it("each legacy component schema rejects its own v2-only field", () => {
    const d = fixtureData();
    rejects(PlanRevisionV1, { ...d.plans[0].revisions[0], schema: 2 });
    rejects(PlanV1, { ...d.plans[0], featureId: "f1" });
    rejects(SessionV1, { ...d.sessions[0], blocks: [] });
    rejects(QuestionV1, { ...d.sessions[0].questions[0], blockId: "b1" });
    rejects(RoadmapMetaV1, { ...d.meta, featureIds: [] });
  });
});

describe("v2 schemas are additive over v1 objects (I3)", () => {
  it("every fixture session, question, plan and revision parses with the v2 schema deep-equal to its input", () => {
    const d = fixtureData();
    for (const s of d.sessions) {
      expectVerbatim(Session, s);
      for (const q of s.questions) expectVerbatim(Question, q);
    }
    for (const p of d.plans) {
      expectVerbatim(Plan, p);
      for (const rev of p.revisions) expectVerbatim(PlanRevision, rev);
    }
  });

  it("legacy markers are derived from absent fields: fixture plans are legacy, fixture revisions are not v2", () => {
    const d = fixtureData();
    for (const p of d.plans) {
      expect(isLegacyPlan(Plan.parse(p))).toBe(true);
      for (const rev of p.revisions) expect(isV2Revision(PlanRevision.parse(rev))).toBe(false);
    }
    expect(isLegacyPlan(Plan.parse({ ...d.plans[0], featureId: "f1" }))).toBe(false);
    expect(isV2Revision(PlanRevision.parse(v2Revision()))).toBe(true);
  });

  it("v2 parsing adds no default or derived field to a legacy object", () => {
    const d = fixtureData();
    const session = Session.parse(d.sessions[0]) as Json;
    const plan = Plan.parse(d.plans[0]) as Json;
    expect(Object.keys(session).sort()).toEqual(Object.keys(d.sessions[0]).sort());
    expect(Object.keys(plan).sort()).toEqual(Object.keys(d.plans[0]).sort());
    for (const key of ["blocks", "legacyBlocks", "legacy"]) expect(session).not.toHaveProperty(key);
    for (const key of ["featureId", "legacy"]) expect(plan).not.toHaveProperty(key);
    for (const rev of plan.revisions) expect(rev).not.toHaveProperty("schema");
  });
});

describe("PlanRevision union", () => {
  it("accepts a v2 revision verbatim, including dod: \"\"", () => {
    const rev = v2Revision([v2Task("t1", { dod: "" })]);
    expectVerbatim(PlanRevision, rev);
    expectVerbatim(PlanRevisionV2, rev);
  });

  it("rejects schema: 2 with legacy three-field tasks", () => {
    accepts(PlanRevision, v2Revision());
    rejects(PlanRevision, { ...fixtureData().plans[0].revisions[0], schema: 2 });
  });

  it("rejects schema: 2 when any one task is a legacy three-field task", () => {
    accepts(PlanRevision, v2Revision([v2Task("t1"), v2Task("t2")]));
    const legacy = { id: "t2", title: "Legacy", description: "" };
    rejects(PlanRevision, v2Revision([v2Task("t1"), legacy]));
  });

  it("rejects v2 tasks without schema", () => {
    const { schema: _drop, ...rev } = v2Revision();
    rejects(PlanRevision, rev);
    rejects(PlanRevisionV2, rev);
  });

  it("rejects schema: 1 and schema: 3 with either task shape", () => {
    const v1 = fixtureData().plans[0].revisions[0];
    accepts(PlanRevision, v2Revision());
    for (const schema of [1, 3, "2"]) {
      rejects(PlanRevision, { ...v2Revision(), schema });
      rejects(PlanRevision, { ...v1, schema });
    }
  });

  it("a plan may mix legacy and v2 revisions; a v2 plan field is optional featureId", () => {
    const p = fixtureData().plans[0];
    expectVerbatim(Plan, { ...p, featureId: "f1", revisions: [...p.revisions, { ...v2Revision(), rev: 4 }] });
    rejects(Plan, { ...p, featureId: "" });
  });
});

describe("TaskDefinitionV2", () => {
  it("parses a complete task verbatim, with and without grillSessionId", () => {
    expectVerbatim(TaskDefinitionV2, v2Task("t1"));
    expectVerbatim(TaskDefinitionV2, v2Task("t1", { grill: true, grillSessionId: "s9", completion: "human", parallel: true, dod: "- [check] npm test" }));
  });

  for (const field of ["id", "title", "description", "dependsOn", "parallel", "completion", "grill", "dod"]) {
    it(`requires ${field} (no default)`, () => {
      const t = v2Task("t1");
      delete t[field];
      rejects(TaskDefinitionV2, t);
    });
  }

  it("is strict and does not coerce", () => {
    rejects(TaskDefinitionV2, { ...v2Task("t1"), extra: true });
    rejects(TaskDefinitionV2, v2Task("t1", { completion: "manual" }));
    rejects(TaskDefinitionV2, v2Task("t1", { parallel: "false" }));
    rejects(TaskDefinitionV2, v2Task("t1", { grill: 0 }));
    rejects(TaskDefinitionV2, v2Task("t1", { dependsOn: "t0" }));
    rejects(TaskDefinitionV2, v2Task("t1", { dependsOn: [""] }));
    rejects(TaskDefinitionV2, v2Task("t1", { dod: null }));
    rejects(TaskDefinitionV2, v2Task("t1", { grillSessionId: "" }));
    rejects(TaskDefinitionV2, v2Task(""));
  });
});

describe("taskGraphIssues", () => {
  const codes = (tasks: Json[]) => taskGraphIssues(tasks).map((i: Json) => i.code);

  it("is empty for a DAG, and PlanRevisionV2 accepts it", () => {
    const dag = [v2Task("a"), v2Task("b", { dependsOn: ["a"] }), v2Task("c", { dependsOn: ["a", "b"] })];
    expect(taskGraphIssues(dag)).toEqual([]);
    expectVerbatim(PlanRevisionV2, v2Revision(dag));
    expect(taskGraphIssues([])).toEqual([]);
  });

  it("does not mutate its input", () => {
    const tasks = [v2Task("a", { dependsOn: ["b"] }), v2Task("b", { dependsOn: ["a"] })];
    const before = canonicalJson(tasks);
    taskGraphIssues(tasks);
    expect(canonicalJson(tasks)).toBe(before);
  });

  it("duplicate_task_id", () => {
    const tasks = [v2Task("a"), v2Task("a")];
    const issues = taskGraphIssues(tasks);
    expect(issues.length).toBeGreaterThan(0);
    for (const i of issues) expect(i).toMatchObject({ code: "duplicate_task_id", taskId: "a" });
  });

  it("unknown_dependency", () => {
    expect(taskGraphIssues([v2Task("a", { dependsOn: ["x"] })])).toEqual([{ code: "unknown_dependency", taskId: "a", dependsOn: "x" }]);
  });

  it("self_dependency", () => {
    const issues = taskGraphIssues([v2Task("a", { dependsOn: ["a"] })]);
    expect(issues).toContainEqual({ code: "self_dependency", taskId: "a", dependsOn: "a" });
    expect(codes([v2Task("a", { dependsOn: ["a"] })])).not.toContain("unknown_dependency");
  });

  it("duplicate_dependency", () => {
    expect(taskGraphIssues([v2Task("a"), v2Task("b", { dependsOn: ["a", "a"] })])).toEqual([
      { code: "duplicate_dependency", taskId: "b", dependsOn: "a" },
    ]);
  });

  it("dependency_cycle over two tasks: one issue at the first task in task order", () => {
    const issues = taskGraphIssues([v2Task("a", { dependsOn: ["b"] }), v2Task("b", { dependsOn: ["a"] })]);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ code: "dependency_cycle", taskId: "a" });
    expect(new Set(issues[0].cycle)).toEqual(new Set(["a", "b"]));
  });

  it("dependency_cycle over three tasks: exactly one issue, at the cycle's first task in task order", () => {
    // Task order x, b, c, a; cycle a → b → c → a. The cycle's first task in task order is b.
    const tasks = [v2Task("x"), v2Task("b", { dependsOn: ["c"] }), v2Task("c", { dependsOn: ["a"] }), v2Task("a", { dependsOn: ["b"] })];
    const issues = taskGraphIssues(tasks);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ code: "dependency_cycle", taskId: "b" });
    expect(new Set(issues[0].cycle)).toEqual(new Set(["a", "b", "c"]));
  });

  it("reports one dependency_cycle per disjoint cycle", () => {
    const tasks = [
      v2Task("a", { dependsOn: ["b"] }),
      v2Task("b", { dependsOn: ["a"] }),
      v2Task("c", { dependsOn: ["d"] }),
      v2Task("d", { dependsOn: ["c"] }),
    ];
    const issues = taskGraphIssues(tasks);
    expect(issues.map((i: Json) => [i.code, i.taskId])).toEqual([
      ["dependency_cycle", "a"],
      ["dependency_cycle", "c"],
    ]);
  });

  it("orders issues by task order, then dependency order", () => {
    const tasks = [v2Task("a", { dependsOn: ["z", "y"] }), v2Task("b", { dependsOn: ["q"] })];
    expect(taskGraphIssues(tasks)).toEqual([
      { code: "unknown_dependency", taskId: "a", dependsOn: "z" },
      { code: "unknown_dependency", taskId: "a", dependsOn: "y" },
      { code: "unknown_dependency", taskId: "b", dependsOn: "q" },
    ]);
  });

  const invalid: Array<[string, Json[]]> = [
    ["duplicate id", [v2Task("a"), v2Task("a")]],
    ["unknown id", [v2Task("a", { dependsOn: ["x"] })]],
    ["self", [v2Task("a", { dependsOn: ["a"] })]],
    ["duplicate dependency", [v2Task("a"), v2Task("b", { dependsOn: ["a", "a"] })]],
    ["two-task cycle", [v2Task("a", { dependsOn: ["b"] }), v2Task("b", { dependsOn: ["a"] })]],
    ["three-task cycle", [v2Task("a", { dependsOn: ["c"] }), v2Task("b", { dependsOn: ["a"] }), v2Task("c", { dependsOn: ["b"] })]],
  ];
  for (const [name, tasks] of invalid) {
    it(`PlanRevisionV2 and PlanRevision reject a ${name}`, () => {
      expect(taskGraphIssues(tasks).length).toBeGreaterThan(0);
      rejects(PlanRevisionV2, v2Revision(tasks));
      rejects(PlanRevision, v2Revision(tasks));
    });
  }
});

describe("Block", () => {
  it("accepts open and accepted blocks verbatim", () => {
    expectVerbatim(Block, block("b1", 0));
    expectVerbatim(Block, block("b1", 0, true));
    expectVerbatim(Block, { ...block("b1", 0, true), acceptedBy: { kind: "human" } });
  });

  it("acceptedAt and acceptedBy are present iff the block is accepted", () => {
    const { acceptedAt: _a, ...noAt } = block("b1", 0, true);
    const { acceptedBy: _b, ...noBy } = block("b1", 0, true);
    rejects(Block, noAt);
    rejects(Block, noBy);
    rejects(Block, { ...block("b1", 0), acceptedAt: T1 });
    rejects(Block, { ...block("b1", 0), acceptedBy: { kind: "human" } });
  });

  it("is strict: human acceptor only, known states, integer order", () => {
    rejects(Block, { ...block("b1", 0, true), acceptedBy: { kind: "agent", agentId: "a1" } });
    rejects(Block, { ...block("b1", 0), state: "frozen" });
    rejects(Block, { ...block("b1", 0), order: 0.5 });
    rejects(Block, { ...block("b1", 0), extra: 1 });
    rejects(Block, { ...block("b1", 0), openedAt: "yesterday" });
  });
});

describe("Session blocks", () => {
  it("accepts a session whose every question names one of its blocks", () => {
    expectVerbatim(Session, blockSession());
  });

  it("rejects a question whose blockId is unknown", () => {
    const s = blockSession();
    accepts(Session, s);
    s.questions[1].blockId = "b9";
    rejects(Session, s);
  });

  it("rejects a question without blockId when blocks are present", () => {
    const s = blockSession();
    accepts(Session, s);
    delete s.questions[1].blockId;
    rejects(Session, s);
  });

  it("rejects an accepted block without acceptedAt", () => {
    const s = blockSession();
    accepts(Session, s);
    delete s.blocks[0].acceptedAt;
    rejects(Session, s);
  });

  it("rejects duplicate block ids", () => {
    const s = blockSession();
    accepts(Session, s);
    s.blocks[1].id = "b1";
    s.questions[1].blockId = "b1";
    rejects(Session, s);
  });

  it("rejects any blockId on a session without blocks", () => {
    const s = fixtureData().sessions[0];
    s.questions[0].blockId = "b1";
    accepts(Question, s.questions[0]);
    rejects(Session, s);
  });

  it("a question may carry blockId; the legacy question schema may not", () => {
    const q = { ...fixtureData().sessions[0].questions[0], blockId: "b1" };
    expectVerbatim(Question, q);
    rejects(QuestionV1, q);
  });
});

describe("Feature", () => {
  it("parses a complete feature verbatim", () => {
    expectVerbatim(Feature, feature());
    expectVerbatim(
      Feature,
      feature({
        kind: "bug",
        status: "executing",
        statusReason: "running",
        dependsOn: ["f0"],
        relatedTo: ["f2"],
        everStarted: true,
        createdBy: { kind: "agent", agentId: "unknown" },
        coordinator: { agentId: "a1", workspaceId: "w1", boundAt: T1, profileRef: "team-implementer" },
        coordinatorHistory: [{ agentId: "a0", workspaceId: "w0", boundAt: T0, profileRef: "p0" }],
        events: [
          { at: T0, actor: { kind: "agent", agentId: "unknown" }, kind: "created" },
          { at: T1, actor: { kind: "human", hostClientId: "c1" }, kind: "status", from: "planned", to: "executing", reason: "start" },
        ],
      }),
    );
  });

  it("allows exactly six statuses", () => {
    for (const status of ["created", "planned", "executing", "done", "cancelled"]) accepts(Feature, feature({ status }));
    accepts(Feature, feature({ status: "deferred", statusBeforeDefer: "planned" }));
    for (const status of ["built", "approved", "paused", "todo", "verified"]) rejects(Feature, feature({ status }));
  });

  it("statusBeforeDefer is present iff the feature is deferred, and names an active status", () => {
    rejects(Feature, feature({ status: "deferred" }));
    for (const s of ["created", "planned", "executing"]) accepts(Feature, feature({ status: "deferred", statusBeforeDefer: s }));
    for (const s of ["deferred", "done", "cancelled"]) rejects(Feature, feature({ status: "deferred", statusBeforeDefer: s }));
    for (const status of ["created", "planned", "executing", "done", "cancelled"]) {
      rejects(Feature, feature({ status, statusBeforeDefer: "created" }));
    }
  });

  it("rejects a self dependency and duplicate dependency ids", () => {
    rejects(Feature, feature({ dependsOn: ["f1"] }));
    rejects(Feature, feature({ dependsOn: ["f0", "f0"] }));
    accepts(Feature, feature({ dependsOn: ["f0", "f2"] }));
  });

  for (const field of ["kind", "status", "dependsOn", "relatedTo", "everStarted", "createdAt", "createdBy", "coordinatorHistory", "events"]) {
    it(`requires ${field} (no default)`, () => {
      const f = feature();
      delete f[field];
      rejects(Feature, f);
    });
  }

  it("is strict, including nested creator, coordinator and events", () => {
    rejects(Feature, feature({ extra: 1 }));
    rejects(Feature, feature({ kind: "epic" }));
    rejects(Feature, feature({ legacy: true }));
    rejects(Feature, feature({ createdBy: { kind: "agent" } }));
    rejects(Feature, feature({ createdBy: { kind: "human", agentId: "a1" } }));
    rejects(Feature, feature({ createdBy: { kind: "system" } }));
    rejects(Feature, feature({ coordinator: { agentId: "a1", workspaceId: "w1", boundAt: T1 } }));
    rejects(Feature, feature({ coordinator: { agentId: "a1", workspaceId: "w1", boundAt: T1, profileRef: "p", model: "m" } }));
    rejects(Feature, feature({ events: [{ at: T0, actor: { kind: "human" }, kind: "deleted" }] }));
    rejects(Feature, feature({ events: [{ at: T0, actor: { kind: "human" }, kind: "created", extra: 1 }] }));
  });
});

describe("RoadmapMeta, ProjectSettings and RoadmapDataV2", () => {
  it("RoadmapMeta accepts both the v1 fixture meta and a v2 meta verbatim", () => {
    expectVerbatim(RoadmapMeta, fixtureData().meta);
    expectVerbatim(RoadmapMeta, v2Meta());
    expectVerbatim(RoadmapMetaV2, v2Meta({ featureIds: ["f1"], runIds: ["r1"], settings: { dodTemplate: "- [check] npm test" } }));
  });

  it("RoadmapMeta rejects unknown versions and cross-version shapes", () => {
    accepts(RoadmapMeta, v2Meta());
    rejects(RoadmapMeta, { ...fixtureData().meta, version: 3 });
    rejects(RoadmapMeta, { ...v2Meta(), version: 1 });
    const { featureIds: _f, ...noFeatures } = v2Meta();
    rejects(RoadmapMeta, noFeatures);
  });

  for (const field of ["featureIds", "runIds", "settings", "links", "sessionIds", "planIds"]) {
    it(`RoadmapMetaV2 requires ${field}`, () => {
      const m = v2Meta();
      delete m[field];
      rejects(RoadmapMetaV2, m);
    });
  }

  it("RoadmapMetaV2 and ProjectSettings are strict", () => {
    rejects(RoadmapMetaV2, v2Meta({ extra: 1 }));
    rejects(RoadmapMetaV2, v2Meta({ settings: { repairCeiling: 30 } }));
    expectVerbatim(ProjectSettings, {});
    expectVerbatim(ProjectSettings, { dodTemplate: "" });
    rejects(ProjectSettings, { dodTemplate: 1 });
    rejects(ProjectSettings, { other: "x" });
  });

  it("RoadmapDataV2 parses a projected fixture verbatim, legacy sessions and plans unchanged", () => {
    expectVerbatim(RoadmapDataV2, v2Data());
    expectVerbatim(RoadmapDataV2, { ...v2Data(), features: [feature()], delegations: [delegation()] });
  });

  it("RoadmapDataV2 rejects unknown top-level keys, missing collections and a v1 meta", () => {
    rejects(RoadmapDataV2, { ...v2Data(), extra: [] });
    rejects(RoadmapDataV2, { ...v2Data(), legacy: true });
    for (const key of ["features", "runs", "delegations", "sessions", "plans", "meta"]) {
      const d = v2Data();
      delete d[key];
      rejects(RoadmapDataV2, d);
    }
    rejects(RoadmapDataV2, { ...v2Data(), meta: fixtureData().meta });
  });
});

describe("StartDelegation", () => {
  it("featureId is present iff scope is feature", () => {
    expectVerbatim(StartDelegation, delegation());
    expectVerbatim(StartDelegation, delegation({ revokedAt: T1 }));
    const { featureId: _f, ...roadmap } = delegation({ scope: "roadmap" });
    expectVerbatim(StartDelegation, roadmap);
    rejects(StartDelegation, { ...roadmap, scope: "feature" });
    rejects(StartDelegation, delegation({ scope: "roadmap" }));
    rejects(StartDelegation, delegation({ scope: "project" }));
  });

  it("requires provenance with agentId, seqStart, timestamp and quoted", () => {
    for (const field of ["agentId", "seqStart", "timestamp", "quoted"]) {
      const d = delegation();
      delete d.provenance[field];
      rejects(StartDelegation, d);
    }
    const minimal = delegation();
    delete minimal.provenance.messageId;
    delete minimal.provenance.turnId;
    expectVerbatim(StartDelegation, minimal);
  });
});

describe("legacy fixture parsing is pure", () => {
  it("parsing v1 and v2 views does not mutate the shared input objects", () => {
    const input = fixtureData();
    const snapshot = deepClone(input);
    RoadmapDataV1.parse(input);
    for (const s of input.sessions) Session.parse(s);
    for (const p of input.plans) Plan.parse(p);
    expect(input).toEqual(snapshot);
  });
});

// R0 review c0045 (card §5: "a session with blocks always has exactly one open block, the
// highest order"): the Session schema owns the invariant, so the store and validateDraft reject
// a blocked session that breaks it. Order ties are not specified and are not asserted.
describe("Session blocks: exactly one open block, the highest order", () => {
  const withBlocks = (blocks: Json[], blockIdOf: (i: number) => string = () => blocks[blocks.length - 1].id) => {
    const s = fixtureData().sessions[0];
    return { ...s, blocks, questions: s.questions.map((q: Json, i: number) => ({ ...q, blockId: blockIdOf(i) })) };
  };

  it("accepts one open block alone, and an open block above accepted ones", () => {
    expectVerbatim(Session, withBlocks([block("b1", 0)]));
    expectVerbatim(Session, withBlocks([block("b1", 0, true), block("b2", 1, true), block("b3", 2)], (i) => (i === 0 ? "b1" : "b3")));
    expectVerbatim(Session, blockSession());
  });

  it("rejects two open blocks", () => {
    rejects(Session, withBlocks([block("b1", 0), block("b2", 1)]));
  });

  it("rejects a session whose blocks are all accepted", () => {
    rejects(Session, withBlocks([block("b1", 0, true), block("b2", 1, true)]));
  });

  it("rejects an empty blocks array", () => {
    const s = { ...fixtureData().sessions[0], questions: [], blocks: [] };
    rejects(Session, s);
    // Positive control: the same question-less session with one open block is valid.
    accepts(Session, { ...s, blocks: [block("b1", 0)] });
  });

  it("rejects an open block whose order is below an accepted block", () => {
    rejects(Session, withBlocks([block("b1", 1, true), block("b2", 0)], () => "b2"));
    // Positive control: the same blocks with the open one highest are valid.
    accepts(Session, withBlocks([block("b1", 0, true), block("b2", 1)], () => "b2"));
  });

  it("legacy sessions without blocks are unaffected", () => {
    for (const s of fixtureData().sessions) expectVerbatim(Session, s);
  });
});

// Stage R1.3a (task card §4.1.2, §4.1.3, encoding B): an optional, append-only cancellation list in
// v2 meta only. Strict v1 stays unchanged; the key is absent until the first cancel (no default).
describe("R1.3a Cancellation and meta.cancellations", () => {
  const ref = () => {
    const d = fixtureData();
    return { sessionId: d.sessions[0].id, questionId: d.sessions[0].questions[0].id };
  };
  const record = (partial: Record<string, unknown> = {}): Json => ({ id: "c1", ref: ref(), reason: "Dropped from scope", at: T0, actor: { kind: "human" }, ...partial });

  it("RoadmapMetaV1 and RoadmapDataV1 reject cancellations; the fixture v1 data still parses (control)", () => {
    const d = fixtureData();
    accepts(RoadmapDataV1, d);
    rejects(RoadmapMetaV1, { ...d.meta, cancellations: [] });
    rejects(RoadmapMetaV1, { ...d.meta, cancellations: [record()] });
    rejects(RoadmapDataV1, { ...d, meta: { ...d.meta, cancellations: [record()] } });
  });

  it("a v2 meta without the key parses verbatim, with no default added; with records it parses verbatim", () => {
    expectVerbatim(RoadmapMetaV2, v2Meta());
    expect("cancellations" in (RoadmapMetaV2.parse(v2Meta()) as Json)).toBe(false);
    expectVerbatim(RoadmapMetaV2, v2Meta({ cancellations: [record(), record({ id: "c2", ref: { ...ref(), questionId: "other" }, actor: { kind: "human", hostClientId: "client-1" } })] }));
    expectVerbatim(RoadmapMetaV2, v2Meta({ cancellations: [] }));
  });

  // Agent cancellation (roadmap_cancel_question): an agent actor needs its id; quoted consent is
  // recorded for agent cancellations only.
  it("Cancellation is strict: trimmed non-empty reason, a human or identified agent actor, no extra keys (control: a valid record)", () => {
    accepts(Cancellation, record());
    for (const reason of ["", "   ", " padded", "padded ", "\tTab"]) rejects(Cancellation, record({ reason }));
    accepts(Cancellation, record({ actor: { kind: "agent", agentId: "a1" } }));
    accepts(Cancellation, record({ actor: { kind: "agent", agentId: "a1" }, quoted: "drop it" }));
    rejects(Cancellation, record({ actor: { kind: "agent" } }));
    rejects(Cancellation, record({ actor: { kind: "agent", agentId: "" } }));
    rejects(Cancellation, record({ actor: { kind: "agent", agentId: "a1", extra: 1 } }));
    rejects(Cancellation, record({ quoted: "drop it" }));
    rejects(Cancellation, record({ actor: { kind: "human", extra: 1 } }));
    rejects(Cancellation, record({ extra: 1 }));
    rejects(Cancellation, record({ at: "yesterday" }));
    const { reason: _r, ...noReason } = record();
    rejects(Cancellation, noReason);
  });

  it("the cancellation array rejects duplicate ids and duplicate refs", () => {
    const other = { ...ref(), questionId: "other" };
    accepts(RoadmapMetaV2, v2Meta({ cancellations: [record(), record({ id: "c2", ref: other })] }));
    rejects(RoadmapMetaV2, v2Meta({ cancellations: [record(), record({ ref: other })] }));
    rejects(RoadmapMetaV2, v2Meta({ cancellations: [record(), record({ id: "c2" })] }));
    rejects(RoadmapMetaV2, v2Meta({ cancellations: [record({ reason: " x" })] }));
  });

  it("cancellationRefIssues returns the refs naming no question; RoadmapDataV2 rejects a dangling ref (control: an existing ref)", () => {
    const data = v2Data();
    const dangling = { ...ref(), questionId: "no-such-question" };
    const missingSession = { sessionId: "no-such-session", questionId: ref().questionId };
    expect(cancellationRefIssues({ ...data, meta: { ...data.meta, cancellations: [record()] } })).toEqual([]);
    expect(cancellationRefIssues({ ...data, meta: { ...data.meta, cancellations: [record(), record({ id: "c2", ref: dangling }), record({ id: "c3", ref: missingSession })] } })).toEqual([dangling, missingSession]);
    expect(cancellationRefIssues(data)).toEqual([]);
    accepts(RoadmapDataV2, { ...data, meta: { ...data.meta, cancellations: [record()] } });
    rejects(RoadmapDataV2, { ...data, meta: { ...data.meta, cancellations: [record({ ref: dangling })] } });
  });
});

// Stage R2.1 (task card 2026-10-29 §1.1, §2.1): Feature.grillSessionId and Plan.grillSessionId are
// optional and additive; the schemas stay strict, and legacy objects gain no derived field.
describe("R2.1 grilling links on Feature and Plan", () => {
  it("Feature: grillSessionId is optional and parses verbatim; an empty id and an unknown key are rejected", () => {
    expectVerbatim(Feature, feature());
    expectVerbatim(Feature, feature({ grillSessionId: "s-feature" }));
    expectVerbatim(Feature, feature({ kind: "bug", status: "deferred", statusBeforeDefer: "planned", grillSessionId: "s-bug" }));
    rejects(Feature, feature({ grillSessionId: "" }));
    rejects(Feature, feature({ grillSessionId: 7 }));
    rejects(Feature, feature({ grillSessionIds: ["s-feature"] }));
    rejects(Feature, feature({ grillSessionId: "s-feature", grilling: true }));
  });

  it("Plan: grillSessionId is optional on legacy and bound plans; an empty id and an unknown key are rejected", () => {
    const base = fixtureData().plans[0];
    expectVerbatim(Plan, base);
    expectVerbatim(Plan, { ...base, grillSessionId: "s-plan" });
    expectVerbatim(Plan, { ...base, featureId: "f1", grillSessionId: "s-plan" });
    const parsed = Plan.parse(base);
    expect(parsed).not.toHaveProperty("grillSessionId");
    rejects(Plan, { ...base, grillSessionId: "" });
    rejects(Plan, { ...base, grillSessionId: null });
    rejects(Plan, { ...base, grillSessions: ["s-plan"] });
    rejects(Plan, { ...base, featureId: "f1", grillSessionId: "s-plan", grilling: true });
  });

  it("PlanV1 stays exactly the shipped legacy shape: grillSessionId is not a v1 field", () => {
    const base = fixtureData().plans[0];
    accepts(PlanV1, base);
    rejects(PlanV1, { ...base, grillSessionId: "s-plan" });
  });
});

// R2 corrective c0010 (task card 2026-10-29 §8.7): PlanV1 keeps the shipped four-state task status
// (TaskStateV1); a v1 plan with a cancelled task state is rejected, while v2 Plan accepts it.
describe("R2 corrective c0010: PlanV1 task states stay four-valued", () => {
  it("PlanV1 rejects a cancelled task state; the four shipped statuses parse; v2 Plan accepts cancelled", () => {
    const base = fixtureData().plans[0];
    const state = (status: string) => ({ taskId: "t1", planRev: 1, status });
    for (const status of ["todo", "in_progress", "done"]) accepts(PlanV1, { ...base, taskStates: [state(status)] });
    accepts(PlanV1, { ...base, taskStates: [{ ...state("verified"), verification: { at: T0, note: "checked" } }] });
    rejects(PlanV1, { ...base, taskStates: [state("cancelled")] });
    rejects(PlanV1, { ...base, taskStates: [state("todo"), state("cancelled")] });
    accepts(Plan, { ...base, taskStates: [state("cancelled")] });
  });
});

// Stage R3.4 (task card 2026-10-29 R3 §5.1): FeatureEvent.kind gains "note" (additive); unknown kinds
// are still rejected.
describe("R3.4 feature note events", () => {
  it("a note event with a reason parses verbatim; unknown kinds are still rejected", () => {
    const note = { at: T1, actor: { kind: "human" }, kind: "note", reason: "delegated start skipped: no coordinator profile configured" };
    expectVerbatim(Feature, feature({ events: [{ at: T0, actor: { kind: "human" }, kind: "created" }, note] }));
    rejects(Feature, feature({ events: [{ ...note, kind: "remark" }] }));
    rejects(Feature, feature({ events: [{ ...note, kind: "" }] }));
  });
});

// Stage R4.3 (task card 2026-10-29 R4 §4): Feature.replacementRequested is additive and optional
// (old stores stay valid) and strict: { at, becauseOf, state: "queued" | "requested", reworkedRev? }.
describe("R4.3 Feature.replacementRequested", () => {
  const REQ = { at: T0, becauseOf: "fA", state: "requested" };
  it("is optional; requested and queued parse, with or without reworkedRev", () => {
    expect(Feature.safeParse(feature()).success, "absent").toBe(true);
    for (const r of [REQ, { ...REQ, state: "queued" }, { ...REQ, reworkedRev: 2 }]) {
      const out = Feature.safeParse(feature({ replacementRequested: r }));
      expect(out.success, JSON.stringify(r)).toBe(true);
      if (out.success) expect((out.data as Record<string, unknown>).replacementRequested, "the field is kept, not stripped").toEqual(r);
    }
  });
  it("rejects unknown states, missing fields, extra keys and a non-integer reworkedRev", () => {
    for (const bad of [
      { ...REQ, state: "pending" },
      { at: T0, state: "requested" },
      { becauseOf: "fA", state: "requested" },
      { ...REQ, trigger: "bind" },
      { ...REQ, reworkedRev: 1.5 },
      { ...REQ, reworkedRev: 0 },
    ]) {
      expect(Feature.safeParse(feature({ replacementRequested: bad })).success, JSON.stringify(bad)).toBe(false);
    }
  });
});

// Finish basis: a finished proposal may record whether it was accepted or stood when the owner
// closed the session manually; a session may carry its closures, one per close, oldest first.
// Both fields are additive and optional, so earlier stores stay valid and are not reinterpreted.
describe("finish basis: FinishProposal.finishedBy and Session.closures", () => {
  const T2 = "2026-10-26T12:00:00.000Z";
  const proposal = { at: T0, agentId: "agent-1", summary: "Done", skipped: [1], outOfScope: [] };
  const base = { id: "s1", title: "S", createdAt: T0, status: "closed", questions: [] };
  const manualClosure = { at: T1, basis: "manual", source: "ui", actor: { kind: "human" } };
  const proposalClosure = { at: T1, basis: "proposal", proposalAt: T0, source: "ui", actor: { kind: "human" } };

  it("FinishProposal keeps finishedBy proposal or manual together with finishedAt", () => {
    expectVerbatim(FinishProposal, { ...proposal, finishedAt: T1, finishedBy: "proposal" });
    expectVerbatim(FinishProposal, { ...proposal, finishedAt: T1, finishedBy: "manual" });
  });

  it("FinishProposal rejects an unknown finishedBy and a finishedBy without finishedAt", () => {
    rejects(FinishProposal, { ...proposal, finishedAt: T1, finishedBy: "chat" });
    rejects(FinishProposal, { ...proposal, finishedBy: "proposal" });
    rejects(FinishProposal, { ...proposal, finishedBy: "manual" });
  });

  it("a proposal without finishedBy, finished or not, round-trips unchanged and gains no finishedBy", () => {
    for (const p of [proposal, { ...proposal, finishedAt: T1 }]) {
      expectVerbatim(FinishProposal, p);
      expect("finishedBy" in FinishProposal.parse(p)).toBe(false);
      expectVerbatim(Session, { ...base, finishProposal: p, finishHistory: [p] });
    }
  });

  it("Session keeps closures verbatim: a manual one, a proposal one with proposalAt, a reopened one", () => {
    expectVerbatim(Session, { ...base, closures: [manualClosure] });
    expectVerbatim(Session, { ...base, closures: [proposalClosure] });
    expectVerbatim(Session, { ...base, status: "active", closures: [{ ...proposalClosure, reopenedAt: T2 }] });
    expectVerbatim(Session, {
      ...base,
      finishProposal: { ...proposal, finishedAt: T1, finishedBy: "manual" },
      finishHistory: [{ ...proposal, finishedAt: T1, finishedBy: "proposal" }],
      closures: [{ ...proposalClosure, reopenedAt: T2 }, { ...manualClosure, at: T2 }],
    });
  });

  it("a session without closures parses as before, with no closures key added", () => {
    const parsed = Session.parse(base);
    expect("closures" in parsed).toBe(false);
  });

  it("a closure is strict: unknown basis, proposal without proposalAt, manual with proposalAt, non-ui source, missing fields, bad times and extra keys are rejected", () => {
    const { actor: _actor, ...noActor } = manualClosure;
    const { at: _at, ...noAt } = manualClosure;
    const { proposalAt: _p, ...proposalWithoutAt } = proposalClosure;
    for (const bad of [
      { ...manualClosure, basis: "automatic" },
      proposalWithoutAt,
      { ...manualClosure, proposalAt: T0 },
      { ...manualClosure, source: "chat" },
      noActor,
      noAt,
      { ...manualClosure, at: "yesterday" },
      { ...manualClosure, reopenedAt: "later" },
      { ...proposalClosure, proposalAt: "earlier" },
      { ...manualClosure, note: "x" },
    ]) {
      accepts(Session, { ...base, closures: [manualClosure] });
      expect(Session.safeParse({ ...base, closures: [bad] }).success, JSON.stringify(bad)).toBe(false);
    }
  });

  // docs/SPEC.md (finish basis): a closure's `actor` is the human; a close is the owner's Finish in the
  // Paseo UI. A stored closure naming an agent (with or without its id) is not a valid close.
  it("a closure's actor is the human: an agent actor is rejected, in a proposal close and a manual one", () => {
    for (const good of [manualClosure, proposalClosure]) {
      accepts(Session, { ...base, closures: [good] });
      for (const actor of [{ kind: "agent" }, { kind: "agent", agentId: "agent-1" }]) {
        expect(Session.safeParse({ ...base, closures: [{ ...good, actor }] }).success, `${good.basis} closure with ${JSON.stringify(actor)}`).toBe(false);
      }
    }
  });

  it("Session rejects an unknown sibling next to closures and a closures value that is not a list", () => {
    rejects(Session, { ...base, closures: [manualClosure], closure: manualClosure });
    rejects(Session, { ...base, closures: manualClosure });
  });

  it("the strict legacy session schema still rejects closures", () => {
    const legacy = fixtureData().sessions[0];
    accepts(SessionV1, legacy);
    rejects(SessionV1, { ...legacy, closures: [manualClosure] });
  });
});
