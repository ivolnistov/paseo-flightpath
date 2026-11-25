import { useRpc } from "@getpaseo/plugin/client";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import {
  jobAccept,
  jobApprove,
  jobRequestChanges,
  jobRetry,
  jobStop,
  reworkGrant,
  runCancel,
  runList,
  runPause,
  runResume,
  runRetryStop,
  type RunDetailResult,
  type RunError,
  type RunSummaryView,
} from "../shared/rpc";
import { GraphView } from "./graph-view";
import { useRunFeed } from "./hooks";
import { JobDetails, type JobCommand } from "./job-details";
import { JobList } from "./job-list";
import { Centered } from "./planning-screen";
import { Banner, Button, Muted, Segmented, type Colors } from "./ui";
import { defaultView, jobRows, pauseText, RUN_ACTION_LABEL, runActions, runBlockers, type GraphView as GraphViewId, type RunAction } from "./view-model";

/** Newest first; the first is the default selection. */
export function sortRuns(runs: readonly RunSummaryView[]): RunSummaryView[] {
  return [...runs].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.runId.localeCompare(a.runId));
}

export function runSummaryText(run: RunSummaryView): string {
  const status = run.health !== "ok" ? run.health : (run.status ?? "unknown");
  return `${run.createdAt.replace("T", " ").slice(0, 16)} · ${status}${run.pauseReason ? ` (${run.pauseReason})` : ""}`;
}

type ExecutionScreenProps = {
  colors: Colors;
  compact: boolean;
  projectId: string;
  runId: string | null;
  onSelectRun: (runId: string | null) => void;
  openAgent: ((agentId: string) => void) | null;
};

/** A run picker over the project's stored runs, then the selected run drawn from its snapshot and journal. */
export function ExecutionScreen({ colors, compact, projectId, runId, onSelectRun, openAgent }: ExecutionScreenProps) {
  const list = useRpc(runList);
  const [runs, setRuns] = useState<RunSummaryView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const refresh = useCallback(() => {
    list({ projectId }).then(
      (answer) => {
        if (answer.ok) {
          setRuns(sortRuns(answer.value.runs));
          setError(null);
        } else setError(answer.error.message);
      },
      (failure: unknown) => setError(failure instanceof Error ? failure.message : "The host did not answer."),
    );
  }, [list, projectId]);
  useEffect(refresh, [refresh]);
  const selected = runId ?? runs?.[0]?.runId ?? null;
  const summary = runs?.find((run) => run.runId === selected) ?? null;

  if (runs === null && error === null) return <Centered colors={colors} text="Loading runs…" />;
  return (
    <View style={{ flex: 1 }}>
      <View style={{ padding: 8, gap: 6 }}>
        {error ? <Banner colors={colors} tone="danger" text={`Runs could not be listed: ${error}`} /> : null}
        <View style={{ flexDirection: "row", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
          <Pressable
            testID="run-picker"
            accessibilityRole="button"
            accessibilityLabel="Choose a run"
            onPress={() => setPicking(!picking)}
            style={{ flex: compact ? 1 : undefined, minWidth: 220, paddingHorizontal: 10, paddingVertical: 6, borderRadius: 6, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface1 }}
          >
            <Text numberOfLines={1} style={{ color: colors.foreground, fontSize: 13 }}>
              {summary ? `${summary.runId} · ${runSummaryText(summary)}` : selected ?? "No runs yet"} {picking ? "▴" : "▾"}
            </Text>
          </Pressable>
          <Button colors={colors} compact label="Refresh" onPress={refresh} testID="runs-refresh" />
        </View>
        {picking ? (
          <ScrollView style={{ maxHeight: 220, borderWidth: 1, borderColor: colors.border, borderRadius: 6 }}>
            {(runs ?? []).map((run) => (
              <Pressable
                key={run.runId}
                testID={`run-option-${run.runId}`}
                accessibilityRole="button"
                accessibilityState={{ selected: run.runId === selected }}
                onPress={() => {
                  onSelectRun(run.runId);
                  setPicking(false);
                }}
                style={{ padding: 8, backgroundColor: run.runId === selected ? colors.surface2 : undefined }}
              >
                <Text style={{ color: colors.foreground, fontSize: 13 }}>{run.runId}</Text>
                <Muted colors={colors} text={runSummaryText(run)} />
              </Pressable>
            ))}
            {runs?.length === 0 ? <Muted colors={colors} text="No runs yet. Start one from Planning." /> : null}
          </ScrollView>
        ) : null}
      </View>
      {selected ? <RunBody key={selected} colors={colors} compact={compact} runId={selected} openAgent={openAgent} onChanged={refresh} /> : <Centered colors={colors} text="No runs yet. Start one from Planning." />}
    </View>
  );
}

function RunBody({ colors, compact, runId, openAgent, onChanged }: { colors: Colors; compact: boolean; runId: string; openAgent: ((agentId: string) => void) | null; onChanged: () => void }) {
  const feed = useRunFeed(runId);
  const [view, setView] = useState<GraphViewId>(() => defaultView(compact));
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const pause = useRpc(runPause);
  const resume = useRpc(runResume);
  const cancel = useRpc(runCancel);
  const retryStop = useRpc(runRetryStop);
  const stop = useRpc(jobStop);
  const retry = useRpc(jobRetry);
  const accept = useRpc(jobAccept);
  const approve = useRpc(jobApprove);
  const requestChanges = useRpc(jobRequestChanges);
  const grant = useRpc(reworkGrant);
  const detail = feed.detail;
  const rows = useMemo(() => (detail ? jobRows(detail.graph, detail.view) : []), [detail]);

  const perform = async (work: () => Promise<RunDetailResult>): Promise<RunError | null> => {
    setBusy(true);
    try {
      const answer = await work();
      if (answer.ok) {
        feed.replace(answer.value);
        onChanged();
        return null;
      }
      return answer.error;
    } catch (failure) {
      return { code: "unavailable", message: failure instanceof Error ? failure.message : "The host did not answer." };
    } finally {
      setBusy(false);
    }
  };

  if (detail === null) {
    return feed.error ? <Centered colors={colors} text={`The run could not be read: ${feed.error.message}`} /> : <Centered colors={colors} text="Loading run…" />;
  }

  const runAction = (action: RunAction) => {
    setNotice(null);
    const work = { pause: () => pause({ runId }), resume: () => resume({ runId }), cancel: () => cancel({ runId }), "retry-stop": () => retryStop({ runId }) }[action];
    void perform(work).then((failure) => failure && setNotice(`${failure.message} (${failure.code})`));
  };
  const jobCommand = (jobId: string, command: JobCommand): Promise<RunError | null> => {
    switch (command.kind) {
      case "stop":
        return perform(() => stop({ runId, jobId }));
      case "retry":
        return perform(() => retry({ runId, jobId, ...(command.target ? { target: command.target } : {}) }));
      case "accept":
        return perform(() => accept({ runId, jobId, cycleId: command.cycleId, criteria: command.criteria }));
      case "approve":
        return perform(() => approve({ runId, jobId, cycleId: command.cycleId }));
      case "request-changes":
        return perform(() => requestChanges({ runId, jobId, note: command.note, ...(command.taskIds ? { taskIds: command.taskIds } : {}) }));
      case "grant-return":
        return perform(() => grant({ runId, jobId }));
    }
  };

  const blockers = runBlockers(detail);
  const paused = pauseText(detail.view.pauseReason);
  const job = selectedId ? detail.graph.jobs.find((candidate) => candidate.id === selectedId) : undefined;
  const details: ReactNode = job ? (
    <JobDetails key={job.id} colors={colors} compact={compact} detail={detail} job={job} busy={busy} openAgent={openAgent} onCommand={(command) => jobCommand(job.id, command)} onClose={() => setSelectedId(null)} />
  ) : null;
  if (compact && details) return <View style={{ flex: 1, backgroundColor: colors.surface0 }}>{details}</View>;

  const header = (
    <View style={{ gap: 6 }}>
      <View style={{ flexDirection: "row", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
        <Text style={{ color: colors.foreground, fontSize: 15, fontWeight: "600" }}>{detail.workflowName ?? "Workflow run"}</Text>
        <Muted colors={colors} text={`${detail.view.status} · ${feed.mode === "watch" ? "live" : feed.mode === "poll" ? "polling" : "connecting"}${detail.health !== "ok" ? ` · ${detail.health}` : ""}`} />
      </View>
      {detail.view.workspace ? <Muted colors={colors} mono text={`branch ${detail.view.workspace.branchName}`} /> : null}
      {paused ? <Banner colors={colors} tone="warning" text={paused} testID="pause-reason" /> : null}
      {detail.waits ? <Muted colors={colors} text={`Stopping: waiting for ${detail.waits.agents.length} agent(s) and ${detail.waits.processes} process(es).`} /> : null}
      {blockers.length > 0 ? (
        <Banner colors={colors} tone="warning" text="Nothing is running. These jobs hold the run:" testID="run-blockers">
          {blockers.map((blocker) => (
            <Pressable key={blocker.id} accessibilityRole="button" onPress={() => setSelectedId(blocker.id)}>
              <Text style={{ color: colors.foreground, fontSize: 12, textDecorationLine: "underline" }}>
                {blocker.title} · {blocker.label}
                {blocker.reason ? ` · ${blocker.reason}` : ""}
              </Text>
            </Pressable>
          ))}
        </Banner>
      ) : null}
      <View style={{ flexDirection: "row", gap: 6, flexWrap: "wrap" }}>
        {runActions(detail.view).map((action) => (
          <Button key={action} colors={colors} compact danger={action === "cancel"} label={RUN_ACTION_LABEL[action]} disabled={busy} onPress={() => runAction(action)} testID={`run-${action}`} />
        ))}
      </View>
      {notice ? <Banner colors={colors} tone="danger" text={notice} /> : null}
      {feed.error ? <Banner colors={colors} tone="warning" text={`Last update failed: ${feed.error.message}`} /> : null}
    </View>
  );

  return (
    <View style={{ flex: 1 }}>
      <View style={{ paddingHorizontal: 8, gap: 6 }}>
        {header}
        <Segmented<GraphViewId>
          colors={colors}
          compact={compact}
          options={[
            { id: "diagram", label: "Diagram" },
            { id: "list", label: "Task list" },
          ]}
          value={view}
          onChange={setView}
        />
      </View>
      <View style={{ flex: 1, flexDirection: "row" }}>
        <View style={{ flex: 1 }}>
          {view === "diagram" ? (
            <GraphView graph={detail.graph} rows={rows} colors={colors} selectedId={selectedId} onSelect={setSelectedId} />
          ) : (
            <JobList rows={rows} colors={colors} selectedId={selectedId} onSelect={setSelectedId} />
          )}
        </View>
        {details ? <View style={{ width: 380, borderLeftWidth: 1, borderColor: colors.border }}>{details}</View> : null}
      </View>
    </View>
  );
}
