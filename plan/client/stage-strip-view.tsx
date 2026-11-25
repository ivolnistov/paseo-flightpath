// The feature stage strip (Questions, Plan, Tasks, Execution) on the feature and session screens.
// It reads the same queries as the feature screen's run bar (plan list, plan.get of the single bound
// plan, the feature's run list) and the feature's session; it contains no approval or start control
// and changes no gate. A pill is a position and a way to that stage's surface.
import type { PluginTheme } from "@getpaseo/plugin";
import { Pressable, ScrollView, Text, View } from "react-native";
import { isV2Revision, type EndReason, type Feature } from "../shared/model";
import type { SessionView } from "../shared/rpc";
import { usePlan, usePlanList, useRunList, useSessionView } from "./hooks";
import { stageAccessibilityLabel, stageModel, stageStateWord, type LatestRevEnd, type StageInput, type StageKey, type StageState } from "./stage-strip";
import { webAria } from "./discussion-ui";
import { TARGET_SIZE } from "./theme";

export const UPCOMING_HINT = "Complete the previous stage first";

/**
 * How a closed session was last closed, from its last closure only: a closure already reopened, or
 * none, means it was closed some other way, whose basis is not recorded.
 */
function closeBasis(s: SessionView["session"]): { finishedByOwner: boolean; basis?: "manual" | "proposal" | "unrecorded" } {
  if (s.status !== "closed") return { finishedByOwner: false };
  const last = s.closures?.at(-1);
  if (last === undefined || last.reopenedAt !== undefined) return { finishedByOwner: false, basis: "unrecorded" };
  return { finishedByOwner: true, basis: last.basis };
}

/** How the ended runs of the current revision ended: finished wins, then an unrecorded reason, then a cancellation. */
function latestEnd(reasons: Array<EndReason | undefined>): { latestRevEnd?: LatestRevEnd } {
  if (reasons.length === 0) return {};
  if (reasons.includes("finished")) return { latestRevEnd: "finished" };
  if (reasons.includes(undefined)) return { latestRevEnd: "unrecorded" };
  return { latestRevEnd: reasons.includes("cancelled_with_feature") ? "cancelled_with_feature" : "cancelled_for_rework" };
}

/** The strip's inputs from stored state; a read still pending is "loading", a failed one "failed". */
export function useFeatureStage(hostId: string, projectId: string, feature: Feature): Omit<StageInput, "viewed"> {
  const planList = usePlanList(hostId, projectId);
  const bound = planList.data?.plans.filter((p) => p.featureId === feature.id);
  const boundPlanId = bound?.length === 1 ? bound[0].id : null;
  const planQuery = usePlan(hostId, projectId, boundPlanId);
  const runList = useRunList(hostId, projectId, feature.id);
  const sessionQuery = useSessionView(hostId, projectId, feature.grillSessionId ?? null);

  const plans: StageInput["plans"] = bound !== undefined ? { severalPlans: bound.length > 1, boundPlanId } : planList.isError ? "failed" : "loading";
  const planView = planQuery.data;
  const latest = planView?.plan.revisions.at(-1);
  const plan: StageInput["plan"] =
    boundPlanId === null
      ? null
      : planView !== undefined && latest !== undefined
        ? {
            approvalCurrent: planView.approval === "current",
            approval: planView.approval,
            latestRev: latest.rev,
            hasTasks: isV2Revision(latest) && latest.tasks.length > 0,
          }
        : planQuery.isError
          ? "failed"
          : "loading";
  const listed = runList.data?.runs.filter((v) => v.run.featureId === feature.id);
  const liveRuns = (listed ?? []).filter((v) => v.run.state !== "ended");
  const ofLatest = (v: NonNullable<typeof listed>[number]) => latest !== undefined && v.run.planId === boundPlanId && v.run.planRev === latest.rev;
  const run: StageInput["run"] =
    listed !== undefined
      ? { live: liveRuns.length > 0, liveForLatestRev: liveRuns.some(ofLatest), ...latestEnd(listed.filter((v) => v.run.state === "ended" && ofLatest(v)).map((v) => v.run.endReason)) }
      : runList.isError
        ? "failed"
        : "loading";
  const s = sessionQuery.data?.session;
  const session: StageInput["session"] =
    feature.grillSessionId === undefined
      ? null
      : s !== undefined
        ? { status: s.status, ...closeBasis(s) }
        : sessionQuery.isError
          ? "failed"
          : "loading";
  return { feature, session, plans, plan, run };
}

const MARK = 10;

/**
 * The stage's 10 px square mark: filled when complete, outlined in the success colour when current,
 * a muted outline when open and a dashed one when unknown. The state word beside it carries the meaning.
 */
function StageMark(props: { state: StageState; theme: PluginTheme }) {
  const { state, theme } = props;
  const on = state === "complete" || state === "current";
  return (
    <View
      style={{
        width: MARK,
        height: MARK,
        borderRadius: 2,
        borderWidth: 1.5,
        borderColor: on ? theme.colors.statusSuccess : theme.colors.foregroundMuted,
        ...(state === "unknown" ? { borderStyle: "dashed" as const } : {}),
        ...(state === "complete" ? { backgroundColor: theme.colors.statusSuccess } : {}),
      }}
    />
  );
}

/** "Plan, Tasks and Execution" */
const joinNames = (names: string[]): string => (names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)!}`);

export function StageStrip(props: {
  hostId: string;
  projectId: string;
  feature: Feature;
  /** The stage whose surface is shown; null when the screen shows none. */
  viewed: StageKey | null;
  theme: PluginTheme;
  onNavigate(stage: StageKey): void;
  /** Stages with no surface to open from here. */
  unavailable?: readonly StageKey[];
  /** Compact: the cells share the row; wide: fixed-width cells. Either way the row scrolls sideways when needed. */
  compact?: boolean;
}) {
  const { theme } = props;
  const model = stageModel({ ...useFeatureStage(props.hostId, props.projectId, props.feature), viewed: props.viewed });
  const upcoming = model.stages.filter((s) => s.disabled).map((s) => s.label);
  // The host's React Native Web drops accessibilityHint and aria-description; a disabled cell is
  // described by the visible hint line instead, through its nativeID (the DOM id on the web).
  const hintId = `stage-hint-${props.feature.id}`;
  return (
    <View style={{ gap: 6, minWidth: 0 }}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flexGrow: 0 }} contentContainerStyle={{ flexGrow: props.compact === true ? 1 : 0 }}>
        <View
          style={{
            flexDirection: "row",
            flexGrow: 1,
            borderWidth: 1,
            borderColor: theme.colors.border,
            borderRadius: 8,
            overflow: "hidden",
          }}
        >
          {model.stages.map((s, i) => {
            const disabled = s.disabled || (props.unavailable ?? []).includes(s.key);
            const strong = s.state === "current" || s.viewing;
            return (
              <Pressable
                key={s.key}
                accessibilityRole="button"
                accessibilityLabel={stageAccessibilityLabel(s)}
                accessibilityState={{ disabled, selected: s.viewing }}
                aria-disabled={disabled}
                {...(s.disabled ? { accessibilityHint: UPCOMING_HINT } : {})}
                {...webAria({ "aria-current": s.viewing ? "page" : undefined, "aria-describedby": s.disabled ? hintId : undefined })}
                disabled={disabled}
                onPress={() => props.onNavigate(s.key)}
                style={{
                  ...(props.compact === true ? { flex: 1 } : { width: 136 }),
                  minWidth: TARGET_SIZE,
                  minHeight: TARGET_SIZE,
                  // Compact: the mark above the name and state word, which wrap rather than clip in a
                  // quarter of a narrow row; wide: one line beside the mark.
                  flexDirection: props.compact === true ? "column" : "row",
                  alignItems: props.compact === true ? "flex-start" : "center",
                  gap: props.compact === true ? 3 : 10,
                  paddingHorizontal: props.compact === true ? 6 : 12,
                  paddingVertical: props.compact === true ? 4 : 0,
                  backgroundColor: s.viewing ? theme.colors.surface2 : "transparent",
                  // The viewed stage has a bottom bar in the success colour (the mock's green accent bar); the
                  // others keep a transparent one of the same width.
                  borderBottomWidth: 2,
                  borderBottomColor: s.viewing ? theme.colors.statusSuccess : "transparent",
                  ...(i > 0 ? { borderLeftWidth: 1, borderLeftColor: theme.colors.border } : {}),
                  opacity: disabled ? 0.45 : 1,
                }}
              >
                <StageMark state={s.state} theme={theme} />
                <View style={{ minWidth: 0, flexShrink: 1 }}>
                  <Text {...(props.compact === true ? {} : { numberOfLines: 1 })} style={{ fontSize: props.compact === true ? 12 : 13, lineHeight: 16, color: strong ? theme.colors.foreground : theme.colors.foregroundMuted, fontWeight: s.state === "current" ? "600" : "400" }}>
                    {s.label}
                  </Text>
                  <Text {...(props.compact === true ? {} : { numberOfLines: 1 })} style={{ fontSize: 11, lineHeight: 14, color: s.state === "current" ? theme.colors.statusSuccess : theme.colors.foregroundMuted }}>
                    {stageStateWord(s)}
                  </Text>
                </View>
              </Pressable>
            );
          })}
        </View>
      </ScrollView>
      {upcoming.length > 0 ? (
        <Text nativeID={hintId} style={{ fontSize: 12, lineHeight: 16, color: theme.colors.foregroundMuted }}>{`${joinNames(upcoming)}: complete the previous stage first.`}</Text>
      ) : null}
      {model.note !== null ? <Text style={{ fontSize: 12, color: theme.colors.foregroundMuted }}>{model.note}</Text> : null}
    </View>
  );
}
