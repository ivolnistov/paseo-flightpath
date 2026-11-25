// UI feedback plan (2026-11-09, revision 2) Task U3 (§2.3): the stage strip's pure model. The
// workflow current stage, per-stage completion evidence and the viewed surface are kept apart;
// nothing is complete without its own evidence; loading and failed reads are unknown, never complete;
// an ended run never counts as execution; the plan's approval and the run's revision are separate
// inputs. The input is the plan's `stageModel(input)` shape plus `viewed`, which the plan names as a
// concept without an input field; the output is read by the plan's vocabulary only (the five stage
// labels, the states complete/current/open/unknown, the details it names), not by field layout.
// Pure module; no React, host or model.
import { describe, expect, it } from "vitest";

const STAGES = ["Questions", "Plan", "Tasks", "Execution"] as const;
const STATES = ["complete", "current", "open", "unknown"] as const;
type Stage = { label: string; state: string; detail: string; disabled: boolean };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isStageLabel = (v: unknown): v is (typeof STAGES)[number] => typeof v === "string" && (STAGES as readonly string[]).includes(v);
const isState = (v: unknown): v is (typeof STATES)[number] => typeof v === "string" && (STATES as readonly string[]).includes(v);

const stripPath = "./stage-strip";
/** The model read by the plan's vocabulary: the four stages in order, each with its state and detail. */
async function stages(input: Record<string, unknown>): Promise<{ list: Stage[]; text: string }> {
  const mod: unknown = await import(/* @vite-ignore */ stripPath);
  const fn: unknown = isRecord(mod) ? mod.stageModel : undefined;
  if (typeof fn !== "function") throw new Error("missing export: stage-strip.stageModel");
  const model: unknown = Reflect.apply(fn, undefined, [input]);
  const arrays: unknown[][] = Array.isArray(model) ? [model] : isRecord(model) ? Object.values(model).filter((v): v is unknown[] => Array.isArray(v)) : [];
  const raw = arrays.find((a) => a.length === STAGES.length && a.every((s) => isRecord(s) && Object.values(s).some(isStageLabel)));
  if (raw === undefined) throw new Error(`no list of the four stages in ${JSON.stringify(model)}`);
  const list = raw.filter(isRecord).map((s) => {
    const values = Object.values(s);
    return {
      label: String(values.find(isStageLabel)),
      state: String(values.find(isState) ?? ""),
      detail: typeof s.detail === "string" ? s.detail : "",
      disabled: s.disabled === true || s.enabled === false,
    };
  });
  expect(list.map((s) => s.label)).toEqual([...STAGES]);
  return { list, text: JSON.stringify(model) };
}
const stage = (list: Stage[], label: (typeof STAGES)[number]): Stage => {
  const found = list.find((s) => s.label === label);
  if (found === undefined) throw new Error(`no stage ${label}`);
  return found;
};
const current = (list: Stage[]) => list.filter((s) => s.state === "current").map((s) => s.label);

const feature = (status = "created") => ({ id: "f1", title: "Login", status, grillSessionId: "S" });
const base = (over: Record<string, unknown> = {}) => ({
  feature: feature(),
  session: { status: "active", finishedByOwner: false },
  plans: { severalPlans: false, boundPlanId: null },
  plan: null,
  run: { live: false, liveForLatestRev: false },
  ...over,
});
const onePlan = { severalPlans: false, boundPlanId: "p1" };

describe("four stages", () => {
  it("STAGE_KEYS is questions, plan, tasks, execution: there is no Done stage", async () => {
    const mod: unknown = await import(/* @vite-ignore */ stripPath);
    expect(isRecord(mod) ? mod.STAGE_KEYS : undefined).toEqual(["questions", "plan", "tasks", "execution"]);
  });
});

describe("U3 workflow current stage", () => {
  it("is the furthest stage with entry evidence", async () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{}, "Questions"],
      [{ plans: onePlan, plan: { approvalCurrent: false, latestRev: 1, hasTasks: true } }, "Plan"],
      [{ plans: onePlan, plan: { approvalCurrent: true, latestRev: 1, hasTasks: true } }, "Tasks"],
      [{ plans: onePlan, plan: { approvalCurrent: true, latestRev: 1, hasTasks: true }, run: { live: true, liveForLatestRev: true } }, "Execution"],
      [{ feature: feature("executing"), plans: onePlan, plan: { approvalCurrent: true, latestRev: 1, hasTasks: true } }, "Execution"],
    ];
    for (const [over, expected] of cases) expect(current((await stages(base(over))).list), JSON.stringify(over)).toEqual([expected]);
    const done = (await stages(base({ feature: feature("done"), session: { status: "closed", finishedByOwner: true }, plans: onePlan, plan: { approvalCurrent: true, latestRev: 1, hasTasks: true } }))).list;
    expect(current(done), "a done feature is beyond Execution: no stage is current").toEqual([]);
    expect(stage(done, "Questions").state, "the closed session completes Questions").toBe("complete");
    expect(stage(done, "Plan").state, "the current approval completes Plan").toBe("complete");
    expect(stage(done, "Execution").state, "done is Execution's own completion").toBe("complete");
  });

  it("deferred and cancelled features have no current stage", async () => {
    for (const status of ["deferred", "cancelled"]) expect(current((await stages(base({ feature: feature(status) }))).list), status).toEqual([]);
  });
});

describe("U3 per-stage completion evidence", () => {
  it("an open session under a later current stage shows Questions still open, never complete", async () => {
    const { list } = await stages(base({ plans: onePlan, plan: { approvalCurrent: true, latestRev: 2, hasTasks: true } }));
    expect(stage(list, "Questions").state).not.toBe("complete");
    expect(stage(list, "Questions").detail).toMatch(/still open/i);
  });

  // KensAI 9126580 c0025: the screen passes a basis for every closed session (stage-strip-view's
  // closeBasis), so these three details are what the strip shows; the case below pins the older
  // fallback wordings only.
  it("a closed session's Questions detail names the recorded basis", async () => {
    for (const [basis, detail] of [
      ["manual", /^finished by the owner manually$/],
      ["proposal", /^finished by the owner on the chat's proposal$/],
      ["unrecorded", /^closed \(basis not recorded\)$/],
    ] as const) {
      const q = stage((await stages(base({ session: { status: "closed", finishedByOwner: basis !== "unrecorded", basis } }))).list, "Questions");
      expect(q.state, basis).toBe("complete");
      expect(q.detail, basis).toMatch(detail);
    }
  });

  // KensAI 9126580 c0027: both cancellation end reasons of the latest revision's run reach the Tasks
  // detail; only the rework one had a case (in the feature screen).
  it("a cancelled run of the latest revision names its end reason in the Tasks detail", async () => {
    for (const [end, detail] of [
      ["cancelled_for_rework", /cancelled for rework/],
      ["cancelled_with_feature", /cancelled with the feature/],
    ] as const) {
      const tasks = stage((await stages(base({ plans: onePlan, plan: { approvalCurrent: true, latestRev: 1, hasTasks: true }, run: { live: false, liveForLatestRev: false, latestRevEnd: end } }))).list, "Tasks");
      expect(tasks.state, end).not.toBe("complete");
      expect(tasks.detail, end).toMatch(detail);
    }
  });

  it("a closed session names the owner's Finish only with it, else the chat's completion", async () => {
    const byOwner = stage((await stages(base({ session: { status: "closed", finishedByOwner: true } }))).list, "Questions");
    expect(byOwner.state).toBe("complete");
    expect(byOwner.detail).toMatch(/finished by the owner/i);
    const byChat = stage((await stages(base({ session: { status: "closed", finishedByOwner: false } }))).list, "Questions");
    expect(byChat.state).toBe("complete");
    expect(byChat.detail).toMatch(/completed by the chat/i);
  });

  it("Plan is complete only for a current approval of the single bound plan; several plans never complete it", async () => {
    expect(stage((await stages(base({ plans: onePlan, plan: { approvalCurrent: true, latestRev: 1, hasTasks: true } }))).list, "Plan").state).toBe("complete");
    expect(stage((await stages(base({ plans: onePlan, plan: { approvalCurrent: false, latestRev: 1, hasTasks: true } }))).list, "Plan").state).not.toBe("complete");
    const several = stage((await stages(base({ plans: { severalPlans: true, boundPlanId: null }, plan: null }))).list, "Plan");
    expect(several.state).not.toBe("complete");
    expect(several.detail).toMatch(/several plans bound/i);
  });

  it("an ended run never counts: Execution is not current and Tasks not complete without a live run", async () => {
    const { list } = await stages(base({ plans: onePlan, plan: { approvalCurrent: true, latestRev: 2, hasTasks: true }, run: { live: false, liveForLatestRev: false } }));
    expect(current(list)).toEqual(["Tasks"]);
    expect(stage(list, "Tasks").state).not.toBe("complete");
    expect(stage(list, "Execution").state).not.toBe("complete");
  });

  it("a live run for an older revision makes Execution current but does not complete Tasks", async () => {
    const { list } = await stages(base({ plans: onePlan, plan: { approvalCurrent: true, latestRev: 2, hasTasks: true }, run: { live: true, liveForLatestRev: false } }));
    expect(current(list)).toEqual(["Execution"]);
    expect(stage(list, "Tasks").state).not.toBe("complete");
    const latest = (await stages(base({ plans: onePlan, plan: { approvalCurrent: true, latestRev: 2, hasTasks: true }, run: { live: true, liveForLatestRev: true } }))).list;
    expect(stage(latest, "Tasks").state).toBe("complete");
  });

  it("done completes Execution but not an open session's Questions", async () => {
    const { list } = await stages(base({ feature: feature("done"), plans: onePlan, plan: { approvalCurrent: true, latestRev: 1, hasTasks: true } }));
    expect(stage(list, "Execution").state).toBe("complete");
    expect(stage(list, "Questions").state).not.toBe("complete");
  });
});

describe("U3 loading and failed reads", () => {
  it("a loading input is unknown with 'loading'; a failed read is unknown with 'read failed'; neither is complete", async () => {
    const loading = (await stages(base({ plans: "loading", plan: "loading", run: "loading" }))).list;
    for (const label of ["Plan", "Tasks"] as const) {
      expect(stage(loading, label).state, label).toBe("unknown");
      expect(stage(loading, label).detail, label).toMatch(/loading/i);
    }
    const failed = (await stages(base({ plans: onePlan, plan: "failed", run: "failed" }))).list;
    expect(stage(failed, "Plan").state).toBe("unknown");
    expect(stage(failed, "Plan").detail).toMatch(/read failed/i);
    const session = (await stages(base({ session: "failed" }))).list;
    expect(stage(session, "Questions").state).toBe("unknown");
    expect(stage(session, "Questions").detail).toMatch(/read failed/i);
  });
});

describe("U3 viewed surface and upcoming stages", () => {
  it("viewing Questions under a later current stage notes an earlier stage and disables nothing earlier", async () => {
    const { list, text } = await stages(base({ plans: onePlan, plan: { approvalCurrent: true, latestRev: 1, hasTasks: true }, viewed: "questions" }));
    expect(text).toMatch(/Viewing an earlier stage/);
    expect(stage(list, "Questions").disabled).toBe(false);
    expect(stage(list, "Plan").disabled).toBe(false);
  });

  it("stages after the current one are disabled", async () => {
    const { list } = await stages(base());
    for (const label of ["Plan", "Tasks", "Execution"] as const) expect(stage(list, label).disabled, label).toBe(true);
    expect(stage(list, "Questions").disabled).toBe(false);
  });
});

// c294f12: while the run list cannot be read nothing tells whether a run is live, so Execution is
// unknown ("loading" or "read failed"), never "not started"; the feature's own status still decides
// when it is executing or done.
describe("Execution with an unreadable run list", () => {
  const approved = { plans: onePlan, plan: { approvalCurrent: true, latestRev: 1, hasTasks: true } };
  it("a failed run read is unknown with 'read failed'; a loading one unknown with 'loading'", async () => {
    const failed = stage((await stages(base({ ...approved, run: "failed" }))).list, "Execution");
    expect(failed.state).toBe("unknown");
    expect(failed.detail).toMatch(/read failed/i);
    expect(failed.detail).not.toMatch(/not started/i);
    const loading = stage((await stages(base({ ...approved, run: "loading" }))).list, "Execution");
    expect(loading.state).toBe("unknown");
    expect(loading.detail).toMatch(/loading/i);
  });

  it("an executing or done feature is not made unknown by a failed run read", async () => {
    const executing = (await stages(base({ ...approved, feature: feature("executing"), run: "failed" }))).list;
    expect(current(executing)).toEqual(["Execution"]);
    const done = stage((await stages(base({ ...approved, feature: feature("done"), run: "failed" }))).list, "Execution");
    expect(done.state).toBe("complete");
  });
});

// Owner decision: every stage shows its own evidence, also on a done or executing feature. The
// feature's status completes Execution only; it never completes Questions, Plan or Tasks when their
// own evidence is missing, unreadable or says otherwise.
describe("each stage follows its own evidence on a done or executing feature", () => {
  const approvedWith = (hasTasks: boolean) => ({ plans: onePlan, plan: { approvalCurrent: true, latestRev: 2, hasTasks } });

  it("done does not complete an open session's Questions or an unapproved Plan", async () => {
    const { list } = await stages(base({ feature: feature("done"), plans: onePlan, plan: { approvalCurrent: false, latestRev: 2, hasTasks: true, approval: "unapproved" } }));
    expect(stage(list, "Questions").state).not.toBe("complete");
    expect(stage(list, "Plan").state).not.toBe("complete");
    expect(stage(list, "Execution").state).toBe("complete");
  });

  for (const status of ["done", "executing"]) {
    it(`${status}: the current plan revision without tasks leaves Tasks incomplete`, async () => {
      const tasks = stage((await stages(base({ feature: feature(status), ...approvedWith(false), run: { live: false, liveForLatestRev: false } }))).list, "Tasks");
      expect(tasks.state).not.toBe("complete");
      expect(tasks.detail).toMatch(/no tasks/i);
    });

    it(`${status}: a live run of an older revision only leaves Tasks incomplete`, async () => {
      const tasks = stage((await stages(base({ feature: feature(status), ...approvedWith(true), run: { live: true, liveForLatestRev: false } }))).list, "Tasks");
      expect(tasks.state).not.toBe("complete");
    });

    it(`${status}: an unreadable run list leaves Tasks unknown, never complete`, async () => {
      for (const run of ["failed", "loading"]) {
        const tasks = stage((await stages(base({ feature: feature(status), ...approvedWith(true), run }))).list, "Tasks");
        expect(tasks.state, run).toBe("unknown");
      }
    });

    it(`${status}: the current plan revision with tasks and a run of that revision completes Tasks (positive control)`, async () => {
      const tasks = stage((await stages(base({ feature: feature(status), ...approvedWith(true), run: { live: true, liveForLatestRev: true } }))).list, "Tasks");
      expect(tasks.state).toBe("complete");
    });
  }
});
