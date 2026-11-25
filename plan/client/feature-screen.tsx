// Feature detail (Stage R1.1 static subset; Stage R4.2 adds execution): the card, its dependencies
// and relations, its history, the plans bound to it, and the same card actions as the roadmap list.
import type { PluginTheme } from "@getpaseo/plugin";
import { TextInput } from "@getpaseo/plugin/client/react-native";
import { useState, type ReactNode } from "react";
import { ScrollView, Text, View } from "react-native";
import { isV2Revision, type Feature, type FeatureEvent, type PlanRevision } from "../shared/model";
import type { PlanSummary, PlanView as PlanViewValue } from "../shared/rpc";
import { PlanRework } from "../shared/rpc-features";
import { RunBudgetGrant, RunPause, RunResume, TaskAccept } from "../shared/rpc-runs";
import { FeatureChat } from "./feature-chat";
import { usePlan, useRoadmapMutation, useRun, useRunList } from "./hooks";
import { ActionButton, FeatureForm, featureActionButtons, featureStatusChip, useFeatureActions } from "./roadmap-screen";
import { RevisionCompare } from "./plan-view";
import { controlOf, runControls, type RunControlState } from "./run-controls";
import { StageStrip } from "./stage-strip-view";
import { StartDialog } from "./start-dialog";
import { parseCycles, STATE_LABEL, taskRows, type TaskRow } from "./task-list";
import { FEATURE_STATUS_LABEL } from "./theme";
import { Heading, Muted } from "./ui";

/** The plans bound to this feature, in list order. */
export function boundPlans(plans: PlanSummary[], featureId: string): PlanSummary[] {
  return plans.filter((p) => p.featureId === featureId);
}

const isStatusKey = (value: string): value is keyof typeof FEATURE_STATUS_LABEL => value in FEATURE_STATUS_LABEL;
const statusName = (value: string | undefined) =>
  value !== undefined && isStatusKey(value) ? FEATURE_STATUS_LABEL[value] : (value ?? "?");
const position = (value: string | undefined) => (value !== undefined && /^\d+$/.test(value) ? String(Number(value) + 1) : "?");

/** One read-only history line. Reorder events store zero-based positions; lines show them from 1. */
export function eventText(event: FeatureEvent, _features: Feature[]): string {
  const actor = event.actor.kind === "human" ? "you" : "agent";
  switch (event.kind) {
    case "status":
      return `Status: ${statusName(event.from)} → ${statusName(event.to)} (${actor})`;
    case "reordered":
      return `Moved from position ${position(event.from)} to ${position(event.to)} (${actor})`;
    case "created":
      return `Card created (${actor})`;
    case "updated":
      return `Card text edited (${actor})`;
    case "dependencies":
      return `Dependencies changed (${actor})`;
    case "coordinator":
      return `Coordinator changed (${actor})`;
    case "note":
      return `Note: ${event.reason ?? ""}`;
  }
}

type FormState = { mode: "edit" } | { mode: "removal" } | null;
type Segment = "tasks" | "chat" | "plan" | "changes";

/** What the Changes section (plan revision comparison, owner decision 2026-10-30) can show. */
export type ChangesState =
  | { kind: "no_plan" }
  | { kind: "several_plans"; plans: PlanSummary[] }
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "single"; rev: number }
  | { kind: "ready"; revisions: PlanRevision[]; latest: PlanRevision };

/** Pure: the Changes state from the feature's bound plans and the bound plan's `plan.get` query. */
export function changesState(
  bound: PlanSummary[],
  plan: { data?: PlanViewValue; isPending: boolean; isError: boolean; error?: unknown },
): ChangesState {
  if (bound.length === 0) return { kind: "no_plan" };
  if (bound.length > 1) return { kind: "several_plans", plans: bound };
  if (plan.isError) return { kind: "error", message: plan.error instanceof Error ? plan.error.message : "The plan could not be read." };
  if (plan.isPending || !plan.data) return { kind: "loading" };
  const revisions = plan.data.plan.revisions;
  const latest = revisions.at(-1);
  if (!latest) return { kind: "no_plan" };
  if (revisions.length === 1) return { kind: "single", rev: latest.rev };
  return { kind: "ready", revisions, latest };
}

export function TaskList(props: {
  theme: PluginTheme;
  compact: boolean;
  rows: TaskRow[];
  titles: Map<string, string>;
  controls: RunControlState[];
  busy: boolean;
  budgetDrafts: Record<string, string>;
  onBudgetDraft(taskId: string, text: string): void;
  onGrant(taskId: string, cycles: number): void;
  onAccept(taskId: string): void;
}) {
  const { theme, compact, rows, titles, controls, busy } = props;
  if (rows.length === 0) return <Muted theme={theme}>No approved tasks yet.</Muted>;
  return (
    <View style={{ gap: 8, minWidth: 0 }}>
      {rows.map((row) => {
        const grant = controlOf(controls, "grantBudget", row.taskId);
        const accept = controlOf(controls, "accept", row.taskId);
        const draft = props.budgetDrafts[row.taskId] ?? "";
        const cycles = parseCycles(draft);
        const after = row.dependsOn.map((id) => titles.get(id) ?? id);
        return (
          <View key={row.taskId} style={{ gap: 4, padding: compact ? 8 : 10, borderWidth: 1, borderRadius: 6, borderColor: theme.colors.border, minWidth: 0 }}>
            <Text style={{ color: theme.colors.foreground, fontWeight: "600", flexShrink: 1 }}>{row.title}</Text>
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, flexShrink: 1 }}>
              {[
                STATE_LABEL[row.state],
                row.ready ? "ready" : null,
                row.parallel ? "parallel" : null,
                after.length > 0 ? `after ${after.join(", ")}` : null,
                row.agentId ? `agent ${row.agentId}` : null,
              ]
                .filter((x) => x !== null)
                .join(" · ")}
            </Text>
            {row.failedCycles > 0 || row.extraBudget > 0 || row.unresolvedCount > 0 ? (
              <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
                {`Failed verification cycles: ${row.failedCycles} · Extra cycles granted: ${row.extraBudget} · Unresolved: ${row.unresolvedCount}`}
              </Text>
            ) : null}
            {accept?.enabled ? <ActionButton label="Accept" theme={theme} primary disabled={busy} onPress={() => props.onAccept(row.taskId)} /> : null}
            {grant?.enabled ? (
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
                <TextInput
                  value={draft}
                  onChangeText={(text: string) => props.onBudgetDraft(row.taskId, text)}
                  placeholder="Cycles (1-1000)"
                  keyboardType="number-pad"
                  style={{ fontSize: 16, minHeight: 44, minWidth: 96, paddingHorizontal: 10, borderWidth: 1, borderRadius: 6, borderColor: theme.colors.border, color: theme.colors.foreground }}
                />
                <ActionButton label="Grant extra cycles" theme={theme} disabled={busy || cycles === null} onPress={() => cycles !== null && props.onGrant(row.taskId, cycles)} />
              </View>
            ) : null}
          </View>
        );
      })}
    </View>
  );
}


export function FeatureScreen(props: {
  hostId: string;
  projectId: string;
  theme: PluginTheme;
  compact: boolean;
  feature: Feature;
  features: Feature[];
  plans: PlanSummary[];
  revision: number;
  onOpenFeature(featureId: string): void;
  onOpenPlan(planId: string): void;
  onBack(): void;
  /** Opens the feature's question session (the stage strip's Questions). */
  onOpenSession?(sessionId: string): void;
}) {
  const { hostId, projectId, theme, compact, feature, features, plans, revision, onOpenFeature, onOpenPlan, onBack } = props;
  const state = useFeatureActions({ hostId, projectId, revision, features });
  const [form, setForm] = useState<FormState>(null);
  const titles = new Map(features.map((f) => [f.id, f.title] as const));

  // Stage R4.2 execution truth: approval from plan.get of the single bound plan; the live run and
  // its current token from run.get (the run list only finds which run is live).
  const bound = boundPlans(plans, feature.id);
  // Several bound plans are a readable stored state with no unique plan: no plan is read, and the
  // screen says so instead of claiming empty tasks or an approval verdict.
  const severalPlans = bound.length > 1;
  const boundPlanId = bound.length === 1 ? bound[0].id : null;
  const planQuery = usePlan(hostId, projectId, boundPlanId);
  const runList = useRunList(hostId, projectId, feature.id);
  const planView = planQuery.data;
  const latest = planView?.plan.revisions.at(-1);
  const latestV2 = latest && isV2Revision(latest) ? latest : null;
  const listed = (runList.data?.runs ?? []).filter((v) => v.run.featureId === feature.id);
  const liveId = listed.find((v) => v.run.state !== "ended")?.run.id ?? null;
  // With no live run, the latest run of exactly the bound plan's latest revision is still shown
  // (its end reason and task outcomes), but it never carries action authority.
  const shownId =
    liveId ?? [...listed].reverse().find((v) => boundPlanId !== null && latestV2 !== null && v.run.planId === boundPlanId && v.run.planRev === latestV2.rev)?.run.id ?? null;
  const runQuery = useRun(hostId, projectId, shownId);
  const shown = shownId !== null && runQuery.data && runQuery.data.run.id === shownId ? runQuery.data : null;
  const run = shown && liveId !== null && shown.run.id === liveId && shown.run.state !== "ended" ? shown : null;
  // The run is known only once the list has answered and, for a live run, its run.get has too;
  // until then (pending or failed) the screen never claims there is no live run.
  const runKnown = runList.data !== undefined && (liveId === null || shown !== null);
  const runReadFailed = !runKnown && (runList.isError || runQuery.isError);
  // The bound plan is known once plan.get has data (a cached value stays usable during a failed
  // refetch); until then the approval and the approved tasks are unknown, not absent or not current.
  const planKnown = boundPlanId === null || planView !== undefined;
  const approvalCurrent = planView?.approval === "current";
  const approvedLatest = latest !== undefined && (planView?.approvals ?? []).some((a) => a.verified && a.receipt.planRev === latest.rev);
  const controls = runControls({ feature, run, approvalCurrent, approvedLatest, runKnown, planKnown, severalPlans });
  // Task outcomes come only from a run of this exact plan revision (never mapped across revisions).
  const forRevision = shown && latestV2 && shown.run.planId === boundPlanId && shown.run.planRev === latestV2.rev ? shown : null;
  const rows: TaskRow[] = latestV2 ? taskRows({ revision: latestV2, run: forRevision }) : [];
  // Task states are known once the run list has answered and the shown run (live or the latest ended
  // run of this revision) has its run.get; until then no task is claimed to be "To do".
  const taskStatesKnown = runList.data !== undefined && (shownId === null || shown !== null);
  const errorText = (e: unknown) => (e instanceof Error ? e.message : "read failed");
  const taskNotice = severalPlans
    ? "Several plans are bound to this feature, so its approved tasks cannot be shown."
    : !planKnown
    ? planQuery.isError
      ? `The plan could not be read: ${errorText(planQuery.error)}`
      : "Loading plan…"
    : !taskStatesKnown
      ? runList.isError || runQuery.isError
        ? `Task states are unavailable: ${errorText(runList.isError ? runList.error : runQuery.error)}`
        : "Loading task states…"
      : null;

  const pause = useRoadmapMutation(hostId, projectId, RunPause);
  const resume = useRoadmapMutation(hostId, projectId, RunResume);
  const accept = useRoadmapMutation(hostId, projectId, TaskAccept);
  const grant = useRoadmapMutation(hostId, projectId, RunBudgetGrant);
  const rework = useRoadmapMutation(hostId, projectId, PlanRework);
  const [segment, setSegment] = useState<Segment>("tasks");
  // Changes: the chosen earlier revision, kept per plan so a different bound plan never inherits it.
  const [compare, setCompare] = useState<{ planId: string; rev: number } | null>(null);
  const [dialog, setDialog] = useState<"start" | "replace" | null>(null);
  const [reworkReason, setReworkReason] = useState<string | null>(null);
  const [budgetDrafts, setBudgetDrafts] = useState<Record<string, string>>({});
  const runBusy = pause.pending || resume.pending || accept.pending || grant.pending || rework.pending;

  // The route gives this screen a bounded viewport (panel.tsx FILL); the screen owns its scrolling.
  const FILL = { flex: 1, minHeight: 0, minWidth: 0 } as const;
  if (form?.mode === "edit") {
    return (
      <ScrollView style={FILL} contentContainerStyle={{ paddingBottom: 24 }}>
        <FeatureForm
          key={`edit:${feature.id}`}
          mode="edit"
          hostId={hostId}
          projectId={projectId}
          theme={theme}
          compact={compact}
          revision={revision}
          feature={feature}
          onDone={() => setForm(null)}
          onCancel={() => setForm(null)}
        />
      </ScrollView>
    );
  }
  if (form?.mode === "removal") {
    // A normal create that records which done feature it removes; the done feature is not changed.
    return (
      <ScrollView style={FILL} contentContainerStyle={{ paddingBottom: 24 }}>
        <FeatureForm
          key={`removal:${feature.id}`}
          mode="create"
          hostId={hostId}
          projectId={projectId}
          theme={theme}
          compact={compact}
          revision={revision}
          initial={{ title: `Remove: ${feature.title}`, relatedTo: [feature.id] }}
          onDone={(id) => {
            setForm(null);
            if (id) onOpenFeature(id);
          }}
          onCancel={() => setForm(null)}
        />
      </ScrollView>
    );
  }

  const links = (ids: string[]) =>
    ids.map((id) => <ActionButton key={id} label={titles.get(id) ?? id} theme={theme} onPress={() => onOpenFeature(id)} />);
  const enabled = (control: RunControlState["control"]) => controlOf(controls, control)?.enabled === true;
  const reasonOf = (control: RunControlState["control"]) => controlOf(controls, control)?.reason;
  const reason = (r: string | undefined) => (r ? ` (${r.replace(/_/g, " ")})` : "");
  const runLine = run
    ? `Run ${run.run.state}${reason(run.run.pauseReason)}${(run.unresolved ?? []).length > 0 ? ` · ${(run.unresolved ?? []).length} unresolved` : ""}`
    : !runKnown
      ? runReadFailed
        ? "Run state unavailable"
        : "Loading run…"
      : shown && shown.run.state === "ended"
        ? `Run ended${reason(shown.run.endReason)}`
        : "No live run";

  const runBar = (
    <View style={{ gap: 6 }}>
      <Text style={{ color: theme.colors.foregroundMuted }}>{runLine}</Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        {!run ? <ActionButton label="Start…" theme={theme} primary disabled={!enabled("start")} onPress={() => setDialog("start")} /> : null}
        {enabled("pause") && run ? (
          <ActionButton label="Pause run" theme={theme} disabled={runBusy} onPress={() => void pause.run({ runId: run.run.id, runToken: run.run.runToken })} />
        ) : null}
        {enabled("resume") && run ? (
          <ActionButton label="Resume run" theme={theme} disabled={runBusy} onPress={() => void resume.run({ runId: run.run.id, runToken: run.run.runToken })} />
        ) : null}
        {enabled("stopAndRework") ? <ActionButton label="Stop and rework…" theme={theme} disabled={runBusy} onPress={() => setReworkReason("")} /> : null}
        {feature.coordinator ? (
          <ActionButton label="Replace coordinator…" theme={theme} disabled={!enabled("replaceCoordinator")} onPress={() => setDialog("replace")} />
        ) : null}
      </View>
      {!run && !enabled("start") && reasonOf("start") ? <Muted theme={theme}>{`Start: ${reasonOf("start")}`}</Muted> : null}
      {feature.coordinator && !enabled("replaceCoordinator") && reasonOf("replaceCoordinator") ? <Muted theme={theme}>{`Replace: ${reasonOf("replaceCoordinator")}`}</Muted> : null}
      {reworkReason !== null && boundPlanId !== null && latest ? (
        <View style={{ gap: 8 }}>
          <Muted theme={theme}>Why send this plan back for rework? The run ends; verified work is kept.</Muted>
          <TextInput
            value={reworkReason}
            onChangeText={setReworkReason}
            placeholder="Reason"
            multiline
            style={{ fontSize: 16, minHeight: 44, paddingHorizontal: 10, paddingVertical: 8, borderWidth: 1, borderRadius: 6, borderColor: theme.colors.border, color: theme.colors.foreground }}
          />
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            <ActionButton
              label="Send for rework"
              theme={theme}
              danger
              disabled={runBusy || reworkReason.trim() === ""}
              onPress={() =>
                void (async () => {
                  const out = await rework.run({ planId: boundPlanId, planRev: latest.rev, reason: reworkReason.trim() });
                  if (out !== null) setReworkReason(null);
                })()
              }
            />
            <ActionButton label="Keep working" theme={theme} onPress={() => setReworkReason(null)} />
          </View>
        </View>
      ) : null}
    </View>
  );
  const taskList = taskNotice ? (
    <Muted theme={theme}>{taskNotice}</Muted>
  ) : (
    <TaskList
      theme={theme}
      compact={compact}
      rows={rows}
      titles={new Map((latestV2?.tasks ?? []).map((t) => [t.id, t.title] as const))}
      controls={controls}
      busy={runBusy}
      budgetDrafts={budgetDrafts}
      onBudgetDraft={(taskId, text) => setBudgetDrafts((d) => ({ ...d, [taskId]: text }))}
      onAccept={(taskId) => run && void accept.run({ runId: run.run.id, runToken: run.run.runToken, taskId })}
      onGrant={(taskId, cycles) =>
        void (async () => {
          if (!run) return;
          const out = await grant.run({ runId: run.run.id, runToken: run.run.runToken, taskId, cycles });
          if (out !== null) setBudgetDrafts((d) => ({ ...d, [taskId]: "" }));
        })()
      }
    />
  );
  const chat = <FeatureChat hostId={hostId} projectId={projectId} feature={feature} theme={theme} compact={compact} />;
  // The R1 detail sections, unchanged in content: dependencies, relations and history, and the plans.
  const details = (
    <View style={{ gap: 12, minWidth: 0 }}>
      <Heading theme={theme}>Depends on</Heading>
      {feature.dependsOn.length === 0 ? <Muted theme={theme}>No dependencies.</Muted> : <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>{links(feature.dependsOn)}</View>}
      {feature.relatedTo.length > 0 ? (
        <>
          <Heading theme={theme}>Related</Heading>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>{links(feature.relatedTo)}</View>
        </>
      ) : null}
      <Heading theme={theme}>History</Heading>
      <View style={{ gap: 4 }}>
        {feature.events.map((e, i) => (
          <Text key={i} style={{ color: theme.colors.foregroundMuted }}>
            {eventText(e, features)}
          </Text>
        ))}
      </View>
    </View>
  );
  const changes = changesState(bound, planQuery);
  const compareRev = compare !== null && compare.planId === boundPlanId ? compare.rev : null;
  const changesSection = (
    <View style={{ gap: 8, minWidth: 0 }}>
      <Heading theme={theme}>Changes</Heading>
      {changes.kind === "no_plan" ? <Text style={{ color: theme.colors.foregroundMuted }}>No plan yet</Text> : null}
      {changes.kind === "several_plans" ? (
        <View style={{ gap: 8 }}>
          <Text style={{ color: theme.colors.foregroundMuted }}>This feature has several plans; open one to compare its revisions.</Text>
          {changes.plans.map((p) => (
            <ActionButton key={p.id} label={p.title} theme={theme} onPress={() => onOpenPlan(p.id)} />
          ))}
        </View>
      ) : null}
      {changes.kind === "loading" ? <Muted theme={theme}>Loading…</Muted> : null}
      {changes.kind === "error" ? <Text style={{ color: theme.colors.statusDanger }}>{changes.message}</Text> : null}
      {changes.kind === "single" ? (
        <Text style={{ color: theme.colors.foregroundMuted }}>{`Only revision ${changes.rev} exists; there is nothing to compare yet.`}</Text>
      ) : null}
      {changes.kind === "ready" && boundPlanId !== null
        ? RevisionCompare({
            revisions: changes.revisions,
            shown: changes.latest,
            compareRev,
            onCompare: (rev) => setCompare({ planId: boundPlanId, rev }),
            theme,
            fallback: <Muted theme={theme}>{`Choose a revision to compare with revision ${changes.latest.rev}.`}</Muted>,
          })
        : null}
    </View>
  );
  const plansSection = (
    <View style={{ gap: 8, minWidth: 0 }}>
      <Heading theme={theme}>Plans</Heading>
      {bound.length === 0 ? (
        <Text style={{ color: theme.colors.foregroundMuted }}>No plan yet</Text>
      ) : (
        <View style={{ gap: 8 }}>
          {bound.map((p) => (
            <ActionButton key={p.id} label={p.title} theme={theme} onPress={() => onOpenPlan(p.id)} />
          ))}
        </View>
      )}
    </View>
  );

  // The card summary and the R1 feature actions scroll with the content.
  const summary = (
    <View style={{ gap: 12, minWidth: 0 }}>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
        {featureStatusChip(feature.status, theme)}
        <Text style={{ color: theme.colors.foregroundMuted }}>{feature.kind === "bug" ? "Bug" : "Feature"}</Text>
      </View>
      {feature.statusReason ? <Text style={{ color: theme.colors.foregroundMuted }}>{feature.statusReason}</Text> : null}
      {feature.replacementRequested ? (
        <Text style={{ color: theme.colors.foregroundMuted }}>
          {feature.replacementRequested.state === "requested"
            ? `Replacement plan requested — ${titles.get(feature.replacementRequested.becauseOf) ?? feature.replacementRequested.becauseOf} was cancelled`
            : "Replacement queued until a coordinator is bound"}
        </Text>
      ) : null}
      {feature.description ? <Text style={{ color: theme.colors.foreground }}>{feature.description}</Text> : null}
      {featureActionButtons(feature, features, state, {
        theme,
        omit: ["open"],
        onOpen: () => undefined,
        onEdit: () => setForm({ mode: "edit" }),
        onCreateRemoval: () => setForm({ mode: "removal" }),
        onDeleted: onBack,
      })}
    </View>
  );
  const scroll = (children: ReactNode) => (
    <ScrollView style={FILL} contentContainerStyle={{ gap: 12, paddingBottom: 24 }}>
      {children}
    </ScrollView>
  );

  // Bounded layout: the header, the run action bar and (compact) the segments never scroll away;
  // the content scrolls in its own region, and the chat keeps its own list and composer.
  return (
    <View style={{ ...FILL, gap: 12 }}>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, alignItems: "center", flexShrink: 0 }}>
        <ActionButton label="Back" theme={theme} onPress={onBack} />
        <Text style={{ color: theme.colors.foreground, fontSize: compact ? 18 : 20, fontWeight: "600", flexShrink: 1 }}>{feature.title}</Text>
        {compact ? null : (
          <ActionButton label="Changes" theme={theme} selected={segment === "changes"} onPress={() => setSegment(segment === "changes" ? "tasks" : "changes")} />
        )}
      </View>
      <View style={{ flexShrink: 0 }}>
        <StageStrip
          hostId={hostId}
          projectId={projectId}
          feature={feature}
          viewed={segment === "plan" ? "plan" : segment === "tasks" ? (run ? "execution" : "tasks") : null}
          theme={theme}
          compact={compact}
          unavailable={feature.grillSessionId === undefined || props.onOpenSession === undefined ? ["questions"] : []}
          onNavigate={(stage) => {
            if (stage === "questions") {
              if (feature.grillSessionId !== undefined) props.onOpenSession?.(feature.grillSessionId);
            } else if (stage === "plan") {
              if (boundPlanId !== null) onOpenPlan(boundPlanId);
              else setSegment("plan");
            } else if (stage === "tasks" || stage === "execution") {
              setSegment("tasks");
            }
          }}
        />
      </View>
      <View style={{ flexShrink: 0 }}>{runBar}</View>
      {dialog ? <StartDialog hostId={hostId} projectId={projectId} feature={feature} theme={theme} compact={compact} mode={dialog} onClose={() => setDialog(null)} /> : null}
      {compact ? (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, flexShrink: 0 }}>
          <ActionButton label="Tasks" theme={theme} selected={segment === "tasks"} onPress={() => setSegment("tasks")} />
          <ActionButton label="Chat" theme={theme} selected={segment === "chat"} onPress={() => setSegment("chat")} />
          <ActionButton label="Plan" theme={theme} selected={segment === "plan"} onPress={() => setSegment("plan")} />
          <ActionButton label="Changes" theme={theme} selected={segment === "changes"} onPress={() => setSegment("changes")} />
        </View>
      ) : null}
      {compact ? (
        segment === "chat" ? (
          <View style={FILL}>{chat}</View>
        ) : segment === "plan" ? (
          scroll(
            <>
              {summary}
              {plansSection}
            </>,
          )
        ) : segment === "changes" ? (
          scroll(changesSection)
        ) : (
          scroll(
            <>
              {summary}
              <Heading theme={theme}>Tasks</Heading>
              {taskList}
              {details}
            </>,
          )
        )
      ) : (
        <View style={{ ...FILL, flexDirection: "row", gap: 16 }}>
          {segment === "changes"
            ? scroll(
                <>
                  {summary}
                  {changesSection}
                </>,
              )
            : scroll(
                <>
                  {summary}
                  <Heading theme={theme}>Tasks</Heading>
                  {taskList}
                  {details}
                  {plansSection}
                </>,
              )}
          <View style={FILL}>{chat}</View>
        </View>
      )}
    </View>
  );
}
