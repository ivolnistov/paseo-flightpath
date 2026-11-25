// The feature stage strip's pure model. Three things are kept apart and never derived from one
// another: the workflow current stage (how far the feature has got, from stored state only), each
// stage's own completion evidence, and the surface the owner is viewing. Nothing is complete without
// its own evidence; a loading or failed read is unknown, never complete; an ended run is never live,
// and completes Tasks only when it is of the current revision and finished.
// A done feature is past Execution: no stage is current, and each stage still shows its own evidence.
import type { Feature } from "../shared/model";

export const STAGE_KEYS = ["questions", "plan", "tasks", "execution"] as const;
export type StageKey = (typeof STAGE_KEYS)[number];
export type StageState = "complete" | "current" | "open" | "unknown";

const LABEL: Record<StageKey, string> = { questions: "Questions", plan: "Plan", tasks: "Tasks", execution: "Execution" };

type Read<T> = T | "loading" | "failed";

export type StageInput = {
  feature: Pick<Feature, "status">;
  /**
   * The feature's question session; null when it has none. `basis` is how its last close was made,
   * from the session's closures: by the owner manually, on the chat's proposal, or not recorded.
   */
  session: Read<{ status: "active" | "closed"; finishedByOwner: boolean; basis?: "manual" | "proposal" | "unrecorded" } | null>;
  plans: Read<{ severalPlans: boolean; boundPlanId: string | null }>;
  /** `plan.get` of the single bound plan; null when there is none. `approval` names a non-current state. */
  plan: Read<{ approvalCurrent: boolean; latestRev: number; hasTasks: boolean; approval?: string } | null>;
  /**
   * `live`: a run whose state is not ended; `liveForLatestRev`: a live run of the bound plan's latest
   * revision; `latestRevEnd`: how an ended run of that revision ended, `unrecorded` when the run
   * carries no end reason (runs stored before end reasons existed). Absent: no such ended run.
   */
  run: Read<{ live: boolean; liveForLatestRev: boolean; latestRevEnd?: LatestRevEnd }>;
  viewed?: StageKey | null;
};

export type LatestRevEnd = "finished" | "cancelled_for_rework" | "cancelled_with_feature" | "unrecorded";

export type StageView = { label: string; key: StageKey; state: StageState; detail: string; disabled: boolean; viewing: boolean };
export type StageModel = { stages: StageView[]; current: StageKey | null; note: string | null };

const known = <T>(r: Read<T>): T | null => (r === "loading" || r === "failed" ? null : r);
const unknownDetail = (...reads: Array<Read<unknown>>): string | null =>
  reads.includes("failed") ? "read failed" : reads.includes("loading") ? "loading" : null;

export function stageModel(input: StageInput): StageModel {
  const status = input.feature.status;
  const session = known(input.session);
  const plans = known(input.plans);
  const plan = known(input.plan);
  const run = known(input.run);
  const done = status === "done";
  const executing = status === "executing";
  const live = run?.live === true;
  const boundPlan = plans !== null && (plans.severalPlans || plans.boundPlanId !== null);
  const singlePlan = plans !== null && !plans.severalPlans && plans.boundPlanId !== null;
  const approved = singlePlan && plan?.approvalCurrent === true;

  // The furthest stage with entry evidence; deferred and cancelled features have none.
  const current: StageKey | null =
    status === "deferred" || status === "cancelled" || done
      ? null
      : executing || live
          ? "execution"
          : approved
            ? "tasks"
            : boundPlan
              ? "plan"
              : "questions";
  const currentIndex = current === null ? -1 : STAGE_KEYS.indexOf(current);

  type Evidence = { complete: boolean; unknown: string | null; detail: string };
  const evidence: Record<StageKey, Evidence> = {
    questions: (() => {
      const u = unknownDetail(input.session);
      if (u !== null) return { complete: false, unknown: u, detail: u };
      if (session === null) return { complete: false, unknown: null, detail: "no question session" };
      if (session.status === "closed") {
        const detail =
          session.basis === "manual"
            ? "finished by the owner manually"
            : session.basis === "proposal"
              ? "finished by the owner on the chat's proposal"
              : session.basis === "unrecorded"
                ? "closed (basis not recorded)"
                : session.finishedByOwner
                  ? "finished by the owner"
                  : "completed by the chat";
        return { complete: true, unknown: null, detail };
      }
      return { complete: false, unknown: null, detail: currentIndex > 0 ? "still open" : "open" };
    })(),
    plan: (() => {
      const u = unknownDetail(input.plans);
      if (u !== null) return { complete: false, unknown: u, detail: u };
      if (plans?.severalPlans === true) return { complete: false, unknown: null, detail: "several plans bound" };
      if (!singlePlan) return { complete: false, unknown: null, detail: "no plan yet" };
      const p = unknownDetail(input.plan);
      if (p !== null) return { complete: false, unknown: p, detail: p };
      if (plan === null) return { complete: false, unknown: "loading", detail: "loading" };
      if (plan.approvalCurrent) return { complete: true, unknown: null, detail: `revision ${plan.latestRev} approved` };
      return { complete: false, unknown: null, detail: `revision ${plan.latestRev} ${(plan.approval ?? "not approved").replace(/_/g, " ")}` };
    })(),
    // Only a run of the current plan revision completes Tasks: a live one, or one that finished. The
    // feature's status never does; a cancelled run is not completion, and an ended run without a
    // recorded end reason is unknown, never complete.
    tasks: (() => {
      if (run !== null && run.liveForLatestRev) return { complete: true, unknown: null, detail: "run started" };
      if (run !== null && run.latestRevEnd === "finished") return { complete: true, unknown: null, detail: "a run of this revision finished" };
      const u = unknownDetail(input.run, input.plans, input.plan);
      if (u !== null) return { complete: false, unknown: u, detail: u };
      if (run?.latestRevEnd === "unrecorded") return { complete: false, unknown: "unrecorded", detail: "a run of this revision ended without a recorded end reason" };
      if (plan !== null && approved && !plan.hasTasks) return { complete: false, unknown: null, detail: "no tasks" };
      if (live) return { complete: false, unknown: null, detail: "the live run is of an earlier revision" };
      if (run?.latestRevEnd === "cancelled_for_rework") return { complete: false, unknown: null, detail: "the run of this revision was cancelled for rework" };
      if (run?.latestRevEnd === "cancelled_with_feature") return { complete: false, unknown: null, detail: "the run of this revision was cancelled with the feature" };
      return { complete: false, unknown: null, detail: "not started" };
    })(),
    execution: (() => {
      if (done) return { complete: true, unknown: null, detail: "done" };
      if (executing || live) return { complete: false, unknown: null, detail: "running" };
      // Without a readable run list nothing tells whether a run is live.
      const u = unknownDetail(input.run);
      if (u !== null) return { complete: false, unknown: u, detail: u };
      return { complete: false, unknown: null, detail: "not started" };
    })(),
  };

  const viewed = input.viewed ?? null;
  const stages = STAGE_KEYS.map((key, i): StageView => {
    const e = evidence[key];
    // Its own evidence first, then an unreadable input, then the workflow position.
    const state: StageState = e.complete ? "complete" : e.unknown !== null ? "unknown" : key === current ? "current" : "open";
    return { label: LABEL[key], key, state, detail: e.detail, disabled: current !== null && i > currentIndex, viewing: key === viewed };
  });
  const viewedIndex = viewed === null ? -1 : STAGE_KEYS.indexOf(viewed);
  const note = viewedIndex >= 0 && currentIndex >= 0 && viewedIndex < currentIndex ? "Viewing an earlier stage" : null;
  return { stages, current, note };
}

/** The pill's visible state word; the state is never shown by colour or a mark alone. */
export function stageStateWord(s: Pick<StageView, "state" | "detail">): string {
  if (s.state === "complete") return "Done";
  if (s.state === "current") return "In progress";
  if (s.state === "unknown") return s.detail === "read failed" ? "Read failed" : s.detail === "loading" ? "Loading" : "Unknown";
  return "Not started";
}

/** The pill's accessibility label: "<label>: <state>, <detail>". */
export const stageAccessibilityLabel = (s: StageView): string => `${s.label}: ${s.state}, ${s.detail}`;
