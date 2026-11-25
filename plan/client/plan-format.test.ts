// Pure plan display helpers (Stage 3 P3.5); node environment, no React Native import.
import { describe, expect, it } from "vitest";
import { allowedTaskTargets, approvalColorKey, approvalLabel, draftTasks, dodSourceLabel, hashPrefix, insertTemplate, markdownBlocks, revisionDiff, taskEditsChanged, taskSpec } from "./plan-format";

const STATUSES = ["current", "not_current", "unapproved", "unverified"] as const;

describe("plan-format", () => {
  it("hashPrefix keeps the first 12 characters", () => {
    expect(hashPrefix("0123456789abcdef".repeat(4))).toBe("0123456789ab");
  });

  it("labels and colour keys cover all four approval statuses", () => {
    expect(STATUSES.map((s) => [s, approvalLabel(s), approvalColorKey(s)])).toEqual([
      ["current", "Approved, current", "statusSuccess"],
      ["not_current", "Approval not current", "statusWarning"],
      ["unapproved", "Not approved", "foregroundMuted"],
      ["unverified", "Unverified approval copy", "statusDanger"],
    ]);
  });

  it("markdownBlocks splits on blank lines into heading, bullet and text blocks", () => {
    const md = "# Rollout plan\n\nShip behind a flag\nthen widen\n\n- first step\n\n* second step\n\n## Risks";
    expect(markdownBlocks(md)).toEqual([
      { kind: "heading", text: "Rollout plan" },
      { kind: "text", text: "Ship behind a flag\nthen widen" },
      { kind: "bullet", text: "first step" },
      { kind: "bullet", text: "second step" },
      { kind: "heading", text: "Risks" },
    ]);
  });

  it("markdownBlocks never produces HTML: markup stays literal text", () => {
    const blocks = markdownBlocks("<script>alert(1)</script>\n\n<b>bold</b> words");
    expect(blocks).toEqual([
      { kind: "text", text: "<script>alert(1)</script>" },
      { kind: "text", text: "<b>bold</b> words" },
    ]);
    for (const b of blocks) expect(Object.keys(b).sort()).toEqual(["kind", "text"]);
    expect(markdownBlocks("")).toEqual([]);
  });

  it("allowedTaskTargets follows the ruling 7 edges; in_progress needs a current approval", () => {
    const table = (current: boolean) =>
      Object.fromEntries((["todo", "in_progress", "done", "verified"] as const).map((s) => [s, [...allowedTaskTargets(s, current)].sort()]));
    expect(table(true)).toEqual({ todo: ["in_progress"], in_progress: ["done", "todo"], done: ["in_progress", "verified"], verified: [] });
    expect(table(false)).toEqual({ todo: [], in_progress: ["done", "todo"], done: ["verified"], verified: [] });
  });
});

// Stage R1.2 (task card §3.2, §7 C7/C8): pure helpers for the v2 task preview, the revision diff and
// the bound draft editor. grillSessionId is displayed but never sent.
describe("R1.2 plan-format helpers", () => {
  const AT = "2026-10-20T10:00:00.000Z";
  const H = "a".repeat(64);
  const legacyTask = { id: "t1", title: "Build", description: "do it" };
  const v2Task = (id: string, over: Record<string, unknown> = {}) => ({
    id, title: `Task ${id}`, description: `About ${id}`, dependsOn: [] as string[], parallel: false, completion: "auto" as const, grill: false, dod: "", ...over,
  });
  const legacyRev = (rev: number, tasks: unknown[], markdown = "# Plan"): any => ({ rev, createdAt: AT, contentHash: H, markdown, tasks, basedOn: [], decisionSnapshotHash: H });
  const v2Rev = (rev: number, tasks: unknown[], markdown = "# Plan"): any => ({ ...legacyRev(rev, tasks, markdown), schema: 2 });

  it("taskSpec: a legacy task has no v2 block; a v2 task carries its fields and parsed DoD items", () => {
    expect(taskSpec(legacyTask as any)).toEqual({ id: "t1", title: "Build", description: "do it" });
    const spec = taskSpec(v2Task("t2", { dependsOn: ["t1"], parallel: true, completion: "human", grill: true, grillSessionId: "s9", dod: "- [check] npm test\nDocs updated" }) as any);
    expect(spec.id).toBe("t2");
    expect(spec.v2).toMatchObject({ dependsOn: ["t1"], parallel: true, completion: "human", grill: true, grillSessionId: "s9", dod: "- [check] npm test\nDocs updated" });
    expect(spec.v2!.dodItems.length).toBe(2);
    expect(spec.v2!.dodItems.map((i: any) => i.kind)).toEqual(["check", "criterion"]);
    expect(taskSpec(v2Task("t3") as any).v2!.dodItems).toEqual([]);
  });

  it("revisionDiff: added and changed/moved in to-order, then removed in from-order; unchanged tasks are absent", () => {
    // No task here is both moved and changed (the card leaves that pairing open).
    const from = v2Rev(1, [v2Task("a"), v2Task("b"), v2Task("gone1"), v2Task("same"), v2Task("gone2")]);
    const to = v2Rev(2, [v2Task("a", { dod: "x" }), v2Task("new"), v2Task("b"), v2Task("same")]);
    const d = revisionDiff(from, to);
    expect(d.schemaChanged).toBe(false);
    expect(d.markdownChanged).toBe(false);
    expect(d.tasks.map((t: any) => [t.kind, t.taskId])).toEqual([
      ["changed", "a"],
      ["added", "new"],
      ["moved", "b"],
      ["removed", "gone1"],
      ["removed", "gone2"],
    ]);
    expect(d.tasks.find((t: any) => t.kind === "moved")).toMatchObject({ from: 1, to: 2 });
  });

  it("revisionDiff: moved carries 0-based from/to; an unchanged same-position task is not reported", () => {
    const from = v2Rev(1, [v2Task("a"), v2Task("b"), v2Task("c")]);
    const to = v2Rev(2, [v2Task("b"), v2Task("a"), v2Task("c")]);
    const d = revisionDiff(from, to);
    const moved = d.tasks.filter((t: any) => t.kind === "moved");
    expect(moved.map((t: any) => [t.taskId, t.from, t.to])).toEqual([["b", 1, 0], ["a", 0, 1]]);
    expect(d.tasks.some((t: any) => t.taskId === "c")).toBe(false);
    expect(revisionDiff(from, from).tasks).toEqual([]);
  });

  it("revisionDiff: changed lists every differing field with display strings", () => {
    const before = v2Task("a", { title: "Old", description: "d1", dependsOn: ["x", "y"], parallel: false, completion: "auto", grill: false, dod: "one", grillSessionId: "s1" });
    const after = v2Task("a", { title: "New", description: "d2", dependsOn: ["y"], parallel: true, completion: "human", grill: true, dod: "two" });
    const d = revisionDiff(v2Rev(1, [before]), v2Rev(2, [after]));
    expect(d.tasks.length).toBe(1);
    const t = d.tasks[0];
    expect(t).toMatchObject({ kind: "changed", taskId: "a", title: "New" });
    const byField = Object.fromEntries((t.changes ?? []).map((c: any) => [c.field, [c.before, c.after]]));
    expect(byField).toEqual({
      title: ["Old", "New"],
      description: ["d1", "d2"],
      dependsOn: ["x, y", "y"],
      parallel: ["no", "yes"],
      completion: ["auto", "human"],
      grill: ["no", "yes"],
      grillSessionId: ["s1", "—"],
      dod: ["one", "two"],
    });
  });

  it("revisionDiff: a legacy-to-v2 pair sets schemaChanged and reports the v2 fields as changed from —; markdownChanged", () => {
    const d = revisionDiff(legacyRev(1, [legacyTask], "# A"), v2Rev(2, [v2Task("t1", { title: "Build", description: "do it", dod: "ok" })], "# B"));
    expect(d.schemaChanged).toBe(true);
    expect(d.markdownChanged).toBe(true);
    expect(d.tasks.length).toBe(1);
    const fields = Object.fromEntries((d.tasks[0].changes ?? []).map((c: any) => [c.field, [c.before, c.after]]));
    expect(fields).toEqual({ dependsOn: ["—", ""], parallel: ["—", "no"], completion: ["—", "auto"], grill: ["—", "no"], dod: ["—", "ok"] });
    expect(revisionDiff(legacyRev(1, [legacyTask]), legacyRev(2, [legacyTask])).schemaChanged).toBe(false);
  });

  it("dodSourceLabel and insertTemplate", () => {
    expect(["file", "project", "global", "none"].map((s) => dodSourceLabel(s as any))).toEqual(["dod template.md", "Project settings", "Global settings", "No template"]);
    expect(insertTemplate("", "T")).toBe("T");
    expect(insertTemplate("  \n ", "T")).toBe("T");
    expect(insertTemplate("Mine  \n\n", "T")).toBe("Mine\nT");
  });

  it("taskEditsChanged is true only when an edited dod or grill differs from the revision", () => {
    const rev = v2Rev(1, [v2Task("a", { dod: "x", grill: false }), v2Task("b", { grill: true })]);
    expect(taskEditsChanged(rev, {})).toBe(false);
    expect(taskEditsChanged(rev, { a: { dod: "x" }, b: { grill: true } })).toBe(false);
    expect(taskEditsChanged(rev, { a: { dod: "y" } })).toBe(true);
    expect(taskEditsChanged(rev, { b: { grill: false } })).toBe(true);
    expect(taskEditsChanged(rev, { a: {} })).toBe(false);
  });

  it("draftTasks maps every task in order to exactly the TaskInput fields, applies dod and grill edits, and never sends grillSessionId", () => {
    const rev = v2Rev(3, [
      v2Task("b", { dependsOn: [], parallel: true, completion: "human", grill: true, grillSessionId: "s1", dod: "keep" }),
      v2Task("a", { dependsOn: ["b"], dod: "old" }),
    ]);
    const before = JSON.stringify(rev);
    const out = draftTasks(rev, { a: { dod: "new", grill: true }, b: { grill: false } });
    expect(out).toEqual([
      { id: "b", title: "Task b", description: "About b", dependsOn: [], parallel: true, completion: "human", grill: false, dod: "keep" },
      { id: "a", title: "Task a", description: "About a", dependsOn: ["b"], parallel: false, completion: "auto", grill: true, dod: "new" },
    ]);
    for (const t of out) expect(Object.keys(t).sort()).toEqual(["completion", "dependsOn", "description", "dod", "grill", "id", "parallel", "title"]);
    expect(JSON.stringify(rev)).toBe(before);
    expect(draftTasks(rev, {}).map((t: any) => [t.id, t.dod, t.grill])).toEqual([["b", "keep", true], ["a", "old", false]]);
  });
});

// Stage R2.3 (task card 2026-10-29 §4.1, §4.2): the exhaustive task-status maps gain cancelled. A
// cancelled task is terminal in the UI: no move is offered, current or not.
describe("R2.3 cancelled task status", () => {
  it("allowedTaskTargets offers no move from cancelled; the shipped edges are unchanged", () => {
    for (const current of [true, false]) {
      const targets = allowedTaskTargets("cancelled", current);
      expect(Array.isArray(targets), `current ${current}: an array`).toBe(true);
      expect([...targets]).toEqual([]);
    }
    expect([...allowedTaskTargets("todo", true)]).toEqual(["in_progress"]);
    expect([...allowedTaskTargets("verified", true)]).toEqual([]);
    for (const status of ["todo", "in_progress", "done", "verified"] as const) {
      for (const current of [true, false]) expect(allowedTaskTargets(status, current)).not.toContain("cancelled");
    }
  });
});

// Stage R4.2 (task card 2026-10-29 R4 §3 "Plan-view alignment"): a revision that a run manages (a
// run of the feature with the same planId and planRev, in ANY state) never offers `verified`,
// exactly the server's refusal rule. Non-run revisions keep today's edges. T's interface choice
// (reported): an optional third argument `runManaged` (default false), so every existing caller
// and assertion is unchanged.
describe("R4.2 allowedTaskTargets for run-managed revisions", () => {
  it("a run-managed revision never offers verified; the other edges are unchanged", () => {
    const table = (current: boolean, runManaged: boolean) =>
      Object.fromEntries(
        (["todo", "in_progress", "done", "verified", "cancelled"] as const).map((s) => [
          s,
          [...(allowedTaskTargets as (s: string, c: boolean, r?: boolean) => readonly string[])(s, current, runManaged)].sort(),
        ]),
      );
    expect(table(true, true)).toEqual({ todo: ["in_progress"], in_progress: ["done", "todo"], done: ["in_progress"], verified: [], cancelled: [] });
    expect(table(false, true)).toEqual({ todo: [], in_progress: ["done", "todo"], done: [], verified: [], cancelled: [] });
  });

  it("control: a non-run revision (explicit false or omitted) keeps verified exactly as before", () => {
    const f = allowedTaskTargets as (s: string, c: boolean, r?: boolean) => readonly string[];
    expect([...f("done", true, false)].sort()).toEqual(["in_progress", "verified"]);
    expect([...f("done", false, false)]).toEqual(["verified"]);
    expect([...allowedTaskTargets("done", true)].sort()).toEqual(["in_progress", "verified"]);
  });
});
