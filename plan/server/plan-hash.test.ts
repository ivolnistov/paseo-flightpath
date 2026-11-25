// Plan hashing (Stage 3 ruling 2). Expected digests are computed here from hand-written canonical
// JSON (sorted keys, no whitespace) with node:crypto, not through the production helpers.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { PlanRevisionV1, Question, Session } from "../shared/model";
import { activeBasis, basedOnSnapshot, cancelledRefs, contentHash, contentHashFor, contentHashV2, decisionSnapshotHash } from "./plan-hash";
import { act, answered, opt, q, r, session } from "./test-support/build";

const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

const ab = [opt("a"), opt("b")];
const yn = [opt("yes"), opt("no")];
const cd = [opt("c"), opt("d")];

/** s1: q1(b) → q2 activated by q1∈{b} (yes), q3(c), q4 activated by q1∈{a} (inactive, answered c). s2: z1(a), outside the plan. */
function sessions(edit: Partial<Record<"q1" | "q2" | "q3" | "q4", Question>> = {}): Session[] {
  const s1 = session("s1", [
    edit.q1 ?? answered(q("q1", { options: ab }), "b"),
    edit.q2 ?? answered(q("q2", { options: yn, activatedBy: [act(r("s1", "q1"), "b")] }), "yes"),
    edit.q3 ?? answered(q("q3", { options: cd }), "c"),
    edit.q4 ?? answered(q("q4", { options: cd, activatedBy: [act(r("s1", "q1"), "a")] }), "c"),
  ]);
  const s2 = session("s2", [answered(q("z1", { options: ab }), "a")]);
  return [s1, s2];
}

const SNAPSHOT_JSON =
  '[{"answerRev":1,"definitionRev":1,"questionId":"q1","sessionId":"s1","validity":"valid","value":{"optionId":"b"}},' +
  '{"answerRev":1,"definitionRev":1,"questionId":"q2","sessionId":"s1","validity":"valid","value":{"optionId":"yes"}},' +
  '{"answerRev":1,"definitionRev":1,"questionId":"q3","sessionId":"s1","validity":"valid","value":{"optionId":"c"}}]';

describe("basis snapshot", () => {
  it("covers exactly the active questions of the named sessions, sorted by ref", () => {
    expect(activeBasis(sessions(), ["s1"])).toEqual([r("s1", "q1"), r("s1", "q2"), r("s1", "q3")]);
    expect(basedOnSnapshot(sessions(), ["s1"])).toEqual(JSON.parse(SNAPSHOT_JSON));
  });

  it("decisionSnapshotHash is sha256 of the canonical active snapshot (known answer)", () => {
    expect(decisionSnapshotHash(sessions(), ["s1"])).toBe(sha(SNAPSHOT_JSON));
  });

  it("is stable across question and session ordering", () => {
    const [s1, s2] = sessions();
    const shuffled = [s2, { ...s1, questions: [...s1.questions].reverse() }];
    expect(decisionSnapshotHash(shuffled, ["s1"])).toBe(decisionSnapshotHash(sessions(), ["s1"]));
  });

  it("changes with a basis answer value, answerRev, definitionRev or validity", () => {
    const base = decisionSnapshotHash(sessions(), ["s1"]);
    const variants: Array<[string, Partial<Record<"q1" | "q2" | "q3" | "q4", Question>>]> = [
      ["value", { q3: answered(q("q3", { options: cd }), "d") }],
      ["answerRev", { q3: answered(q("q3", { options: cd }), "c", 2) }],
      ["definitionRev", { q3: answered(q("q3", { options: cd, definitionRev: 2 }), "c") }],
      ["validity", { q3: { ...answered(q("q3", { options: cd }), "c"), validity: "skipped" } }],
    ];
    const seen = new Set([base]);
    for (const [name, edit] of variants) {
      const h = decisionSnapshotHash(sessions(edit), ["s1"]);
      expect(h, name).not.toBe(base);
      seen.add(h);
    }
    expect(seen.size).toBe(variants.length + 1);
  });

  it("ignores edits confined to inactive questions and sessions outside the plan (R2)", () => {
    const base = decisionSnapshotHash(sessions(), ["s1"]);
    expect(decisionSnapshotHash(sessions({ q4: answered(q("q4", { options: cd, activatedBy: [act(r("s1", "q1"), "a")] }), "d", 3) }), ["s1"])).toBe(base);
    const [s1, s2] = sessions();
    const otherEdited = [s1, { ...s2, questions: [answered(q("z1", { options: ab }), "b", 2)] }];
    expect(decisionSnapshotHash(otherEdited, ["s1"])).toBe(base);
  });

  it("changes when the active set changes: a branch switch or a new active question (R2)", () => {
    const base = decisionSnapshotHash(sessions(), ["s1"]);
    // q1 → a deactivates q2 and activates q4.
    const switched = sessions({ q1: answered(q("q1", { options: ab }), "a", 2) });
    expect(activeBasis(switched, ["s1"])).toEqual([r("s1", "q1"), r("s1", "q3"), r("s1", "q4")]);
    expect(decisionSnapshotHash(switched, ["s1"])).not.toBe(base);
    const [s1, s2] = sessions();
    const added = [{ ...s1, questions: [...s1.questions, { ...q("q5", { options: ab }), order: 9 }] }, s2];
    expect(activeBasis(added, ["s1"])).toContainEqual(r("s1", "q5"));
    expect(decisionSnapshotHash(added, ["s1"])).not.toBe(base);
  });
});

describe("contentHash", () => {
  const rev = (): Pick<PlanRevisionV1, "markdown" | "tasks" | "basedOn" | "decisionSnapshotHash"> => ({
    markdown: "# Plan\n\nDo it",
    tasks: [{ id: "t1", title: "First", description: "desc" }],
    basedOn: [{ sessionId: "s1", questionId: "q1", answerRev: 1, definitionRev: 1, validity: "valid" }],
    decisionSnapshotHash: "d".repeat(64),
  });
  const CONTENT_JSON =
    '{"basedOn":[{"answerRev":1,"definitionRev":1,"questionId":"q1","sessionId":"s1","validity":"valid"}],' +
    `"decisionSnapshotHash":"${"d".repeat(64)}",` +
    '"markdown":"# Plan\\n\\nDo it",' +
    '"tasks":[{"description":"desc","id":"t1","title":"First"}]}';

  it("is sha256 of the canonical { markdown, tasks, basedOn, decisionSnapshotHash } (known answer)", () => {
    expect(contentHash(rev())).toBe(sha(CONTENT_JSON));
  });

  it("is stable across object key order", () => {
    const r1 = rev();
    const reordered = {
      decisionSnapshotHash: r1.decisionSnapshotHash,
      tasks: [{ description: "desc", title: "First", id: "t1" }],
      basedOn: [{ validity: "valid" as const, definitionRev: 1, answerRev: 1, questionId: "q1", sessionId: "s1" }],
      markdown: r1.markdown,
    };
    expect(contentHash(reordered)).toBe(contentHash(r1));
  });

  it("covers only the four hashed fields", () => {
    const withExtra = { ...rev(), rev: 7, createdAt: "2026-10-21T00:00:00.000Z", contentHash: "x" } as unknown as Parameters<typeof contentHash>[0];
    expect(contentHash(withExtra)).toBe(sha(CONTENT_JSON));
  });

  it("changes when markdown, any task field, any basedOn field or decisionSnapshotHash changes", () => {
    const base = contentHash(rev());
    const edits: Array<[string, (x: ReturnType<typeof rev>) => void]> = [
      ["markdown", (x) => (x.markdown += " now")],
      ["task id", (x) => (x.tasks[0].id = "t2")],
      ["task title", (x) => (x.tasks[0].title = "Other")],
      ["task description", (x) => (x.tasks[0].description = "")],
      ["task added", (x) => x.tasks.push({ id: "t2", title: "Second", description: "" })],
      ["basedOn answerRev", (x) => (x.basedOn[0].answerRev = 2)],
      ["basedOn definitionRev", (x) => (x.basedOn[0].definitionRev = 2)],
      ["basedOn validity", (x) => (x.basedOn[0].validity = "skipped")],
      ["basedOn ref", (x) => (x.basedOn[0].questionId = "q9")],
      ["decisionSnapshotHash", (x) => (x.decisionSnapshotHash = "e".repeat(64))],
    ];
    for (const [name, edit] of edits) {
      const x = rev();
      edit(x);
      expect(contentHash(x), name).not.toBe(base);
    }
  });
});

// Redesign Stage R0.1 (task card §2.3, §2.5 items 11–13): legacy hashes frozen, versioned v2 hash.

const FIXTURE = fileURLToPath(new URL("./fixtures/v1-store/generations/", import.meta.url));
const GEN_25 = "g-0000000025-01M5FQAGMZEKFQWBB2H0HA3WR7";
const GEN_26 = "g-0000000026-01M5FQB4DD1W73S39XF2DVX7V5";
const PLAN_ID = "01M5FQ20Z7N3GGWZZP76ZEFV79";
// Raw fixture JSON, untyped on purpose: these tests must hold for the bytes on disk.
const fixtureJson = (gen: string, rel: string): any => JSON.parse(readFileSync(`${FIXTURE}${gen}/${rel}`, "utf8"));
const fixturePlan = (gen = GEN_26): any => fixtureJson(gen, `plans/${PLAN_ID}.json`);
const fixtureSessions = (gen: string): Session[] =>
  fixtureJson(gen, "roadmap.json").sessionIds.map((id: string) => fixtureJson(gen, `sessions/${id}.json`));

describe("legacy fixture hashes (I4)", () => {
  it("contentHash and contentHashFor reproduce every fixture revision's stored contentHash", () => {
    const plan = fixturePlan();
    expect(plan.revisions.map((rev: any) => rev.rev)).toEqual([1, 2, 3]);
    for (const rev of plan.revisions) {
      expect(rev).not.toHaveProperty("schema");
      expect(contentHash(rev), `rev ${rev.rev}`).toBe(rev.contentHash);
      expect(contentHashFor(rev), `rev ${rev.rev}`).toBe(rev.contentHash);
    }
    expect(new Set(plan.revisions.map((rev: any) => rev.contentHash)).size).toBe(3);
  });

  it("both approval receipts bind their revision's contentHash and decisionSnapshotHash", () => {
    const plan = fixturePlan();
    expect(plan.approvals.map((a: any) => a.planRev)).toEqual([2, 3]);
    for (const receipt of plan.approvals) {
      const rev = plan.revisions.find((x: any) => x.rev === receipt.planRev);
      expect(receipt.planId).toBe(PLAN_ID);
      expect(receipt.contentHash).toBe(rev.contentHash);
      expect(contentHashFor(rev)).toBe(receipt.contentHash);
      expect(receipt.decisionSnapshotHash).toBe(rev.decisionSnapshotHash);
    }
  });

  it("decisionSnapshotHash reproduces the receipts' snapshot from the generation the plan was drafted on", () => {
    const plan = fixturePlan();
    const recorded = plan.approvals[0].decisionSnapshotHash;
    expect(decisionSnapshotHash(fixtureSessions(GEN_25), plan.sessionIds)).toBe(recorded);
    // The current generation re-answered the basis question (answerRev 2), so the snapshot moved on.
    expect(decisionSnapshotHash(fixtureSessions(GEN_26), plan.sessionIds)).not.toBe(recorded);
  });

  it("the previous generation's plan file is byte-identical to the current one", () => {
    const read = (gen: string) => readFileSync(`${FIXTURE}${gen}/plans/${PLAN_ID}.json`, "utf8");
    expect(read(GEN_25)).toBe(read(GEN_26));
  });
});

type V2Fields = {
  markdown: string;
  tasks: Array<Record<string, unknown>>;
  basedOn: Array<Record<string, unknown>>;
  decisionSnapshotHash: string;
};

describe("contentHashV2", () => {
  const v2 = (): V2Fields => ({
    markdown: "# Plan\n\nDo it",
    tasks: [
      {
        id: "t1",
        title: "First",
        description: "desc",
        dependsOn: [],
        parallel: false,
        completion: "auto",
        grill: false,
        dod: "- [check] npm test",
      },
    ],
    basedOn: [{ sessionId: "s1", questionId: "q1", answerRev: 1, definitionRev: 1, validity: "valid" }],
    decisionSnapshotHash: "d".repeat(64),
  });
  const CONTENT_V2_JSON =
    '{"basedOn":[{"answerRev":1,"definitionRev":1,"questionId":"q1","sessionId":"s1","validity":"valid"}],' +
    `"decisionSnapshotHash":"${"d".repeat(64)}",` +
    '"markdown":"# Plan\\n\\nDo it",' +
    '"schema":2,' +
    '"tasks":[{"completion":"auto","dependsOn":[],"description":"desc","dod":"- [check] npm test","grill":false,"id":"t1","parallel":false,"title":"First"}]}';

  const two = (): V2Fields => ({
    ...v2(),
    tasks: [
      v2().tasks[0],
      {
        id: "t2",
        title: "Second",
        description: "",
        dependsOn: ["t1"],
        parallel: true,
        completion: "human",
        grill: true,
        grillSessionId: "s9",
        dod: "",
      },
    ],
  });
  const TWO_TASKS_JSON =
    '{"basedOn":[{"answerRev":1,"definitionRev":1,"questionId":"q1","sessionId":"s1","validity":"valid"}],' +
    `"decisionSnapshotHash":"${"d".repeat(64)}",` +
    '"markdown":"# Plan\\n\\nDo it",' +
    '"schema":2,' +
    '"tasks":[{"completion":"auto","dependsOn":[],"description":"desc","dod":"- [check] npm test","grill":false,"id":"t1","parallel":false,"title":"First"},' +
    '{"completion":"human","dependsOn":["t1"],"description":"","dod":"","grill":true,"grillSessionId":"s9","id":"t2","parallel":true,"title":"Second"}]}';

  const full = (fields: V2Fields, rev = 1): any => ({ ...fields, rev, createdAt: "2026-10-26T10:00:00.000Z", contentHash: "x", schema: 2 });
  const hashV2 = (fields: V2Fields) => contentHashV2(fields as any);

  it("is sha256 of the canonical { schema: 2, markdown, tasks, basedOn, decisionSnapshotHash } (known answer)", () => {
    expect(hashV2(v2())).toBe(sha(CONTENT_V2_JSON));
  });

  it("hashes grillSessionId and dependsOn when present (second known answer)", () => {
    expect(hashV2(two())).toBe(sha(TWO_TASKS_JSON));
  });

  it("covers only the hashed fields of a full revision", () => {
    expect(contentHashV2(full(v2(), 7))).toBe(sha(CONTENT_V2_JSON));
  });

  it("is stable across object key order", () => {
    const x = v2();
    const reordered: V2Fields = {
      decisionSnapshotHash: x.decisionSnapshotHash,
      tasks: [{ dod: "- [check] npm test", grill: false, completion: "auto", parallel: false, dependsOn: [], description: "desc", title: "First", id: "t1" }],
      basedOn: [{ validity: "valid", definitionRev: 1, answerRev: 1, questionId: "q1", sessionId: "s1" }],
      markdown: x.markdown,
    };
    expect(hashV2(reordered)).toBe(hashV2(x));
  });

  it("is domain-separated from the v1 hash of the same four fields (I5)", () => {
    const x = v2();
    expect(hashV2(x)).not.toBe(contentHash(x as any));
    const v1Shaped = { ...x, tasks: [{ id: "t1", title: "First", description: "desc" }] };
    expect(hashV2(v1Shaped)).not.toBe(contentHash(v1Shaped as any));
  });

  it("changes with every hashed field, including task order and dependsOn order", () => {
    const base = hashV2(two());
    const edits: Array<[string, (x: V2Fields) => void]> = [
      ["markdown", (x) => (x.markdown += " now")],
      ["task id", (x) => (x.tasks[0].id = "t0")],
      ["task title", (x) => (x.tasks[0].title = "Other")],
      ["task description", (x) => (x.tasks[0].description = "")],
      ["dependsOn content", (x) => (x.tasks[1].dependsOn = ["t3"])],
      ["dependsOn added", (x) => (x.tasks[1].dependsOn = ["t1", "t3"])],
      ["dependsOn order", (x) => (x.tasks[1].dependsOn = ["t3", "t1"])],
      ["parallel", (x) => (x.tasks[0].parallel = true)],
      ["completion", (x) => (x.tasks[0].completion = "human")],
      ["grill", (x) => (x.tasks[0].grill = true)],
      ["grillSessionId added", (x) => (x.tasks[0].grillSessionId = "s8")],
      ["grillSessionId changed", (x) => (x.tasks[1].grillSessionId = "s8")],
      ["grillSessionId removed", (x) => delete x.tasks[1].grillSessionId],
      ["dod", (x) => (x.tasks[0].dod = "- [check] npm run typecheck")],
      ["dod emptied", (x) => (x.tasks[0].dod = "")],
      ["task order", (x) => x.tasks.reverse()],
      ["task added", (x) => x.tasks.push({ ...x.tasks[0], id: "t3" })],
      ["basedOn answerRev", (x) => (x.basedOn[0].answerRev = 2)],
      ["basedOn order", (x) => x.basedOn.unshift({ sessionId: "s0", questionId: "q0", answerRev: 1, definitionRev: 1, validity: "valid" })],
      ["decisionSnapshotHash", (x) => (x.decisionSnapshotHash = "e".repeat(64))],
    ];
    const seen = new Set([base]);
    for (const [name, edit] of edits) {
      const x = two();
      edit(x);
      const h = hashV2(x);
      expect(h, name).not.toBe(base);
      seen.add(h);
    }
    // The dependsOn order edit differs from the dependsOn added edit only by order.
    expect(seen.size).toBe(edits.length + 1);
  });

  it("does not mutate its input", () => {
    const x = two();
    const before = JSON.stringify(x);
    hashV2(x);
    expect(JSON.stringify(x)).toBe(before);
  });

  describe("contentHashFor", () => {
    it("uses the v2 hash iff schema is 2, and the frozen v1 hash iff schema is absent", () => {
      const rev2 = full(v2());
      expect(contentHashFor(rev2)).toBe(sha(CONTENT_V2_JSON));
      expect(contentHashFor(rev2)).toBe(contentHashV2(rev2));
      expect(contentHashFor(rev2)).not.toBe(contentHash(rev2));

      const { schema: _drop, ...rev1 } = { ...full(v2()), tasks: [{ id: "t1", title: "First", description: "desc" }] };
      const CONTENT_JSON =
        '{"basedOn":[{"answerRev":1,"definitionRev":1,"questionId":"q1","sessionId":"s1","validity":"valid"}],' +
        `"decisionSnapshotHash":"${"d".repeat(64)}",` +
        '"markdown":"# Plan\\n\\nDo it",' +
        '"tasks":[{"description":"desc","id":"t1","title":"First"}]}';
      expect(contentHashFor(rev1)).toBe(sha(CONTENT_JSON));
      expect(contentHashFor(rev1)).toBe(contentHash(rev1));
    });

    it("ignores the stored contentHash field when dispatching", () => {
      const rev2 = full(v2());
      expect(contentHashFor({ ...rev2, contentHash: "y" })).toBe(contentHashFor(rev2));
    });
  });
});

// Stage R1.5 (task card §8.2, §8.4 item 1; owner Q33=1): a cancelled decision leaves the basis.
// Visibility over the full graph is unchanged; only basis membership changes. The hash functions and
// their fixtures are unchanged, and an omitted context equals an explicit empty set.
describe("R1.5 cancelledRefs and basis exclusion", () => {
  const AT = "2026-10-26T10:00:00.000Z";
  const rec = (sessionId: string, questionId: string) => ({ id: `c-${questionId}`, ref: { sessionId, questionId }, reason: "Dropped", at: AT, actor: { kind: "human" as const } });

  it("cancelledRefs of a v2 meta with two records is the set of their exact RefKeys", () => {
    const set = cancelledRefs({ meta: { cancellations: [rec("s1", "q2"), rec("s2", "z1")] } });
    expect([...set].sort()).toEqual(["s1/q2", "s2/z1"]);
  });

  it("cancelledRefs is empty for a v1-shaped meta and for an empty list (control)", () => {
    expect(cancelledRefs({ meta: {} }).size).toBe(0);
    expect(cancelledRefs({ meta: { cancellations: [] } }).size).toBe(0);
  });

  it("a cancelled active ref leaves activeBasis, basedOnSnapshot and decisionSnapshotHash", () => {
    const s = sessions();
    const cancelled = new Set(["s1/q2" as const]);
    expect(activeBasis(s, ["s1"], cancelled)).toEqual([r("s1", "q1"), r("s1", "q3")]);
    expect(basedOnSnapshot(s, ["s1"], cancelled).map((e) => e.questionId)).toEqual(["q1", "q3"]);
    expect(decisionSnapshotHash(s, ["s1"], cancelled)).not.toBe(decisionSnapshotHash(s, ["s1"]));
    // Cancelling an inactive or out-of-plan question changes nothing.
    expect(activeBasis(s, ["s1"], new Set(["s1/q4" as const, "s2/z1" as const]))).toEqual(activeBasis(s, ["s1"]));
  });

  it("an omitted context and an explicit empty set give identical outputs; the known snapshot hash is unchanged (control)", () => {
    const s = sessions();
    const empty = new Set<`${string}/${string}`>();
    expect(activeBasis(s, ["s1"], empty)).toEqual(activeBasis(s, ["s1"]));
    expect(basedOnSnapshot(s, ["s1"], empty)).toEqual(basedOnSnapshot(s, ["s1"]));
    expect(decisionSnapshotHash(s, ["s1"], empty)).toBe(decisionSnapshotHash(s, ["s1"]));
    expect(decisionSnapshotHash(s, ["s1"])).toBe(sha(SNAPSHOT_JSON));
    expect(basedOnSnapshot(s, ["s1"])).toEqual(JSON.parse(SNAPSHOT_JSON));
  });
});
