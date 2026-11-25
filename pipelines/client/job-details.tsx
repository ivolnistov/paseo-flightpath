import { useRpc } from "@getpaseo/plugin/client";
import { useEffect, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { jobChanges, type JobChangesSchema, type RunDetail, type RunError } from "../shared/rpc";
import type { GraphJob } from "../shared/workflow";
import { Banner, Button, MONOSPACE, Muted, Segmented, SectionTitle, StatusChip, WaitMarker, type Colors } from "./ui";
import { agentText, attentionDetails, CRITERIA_TITLE, criteriaRows, jobActions, jobTitle, openChats, providerChoices, statusLabel, taskText, type JobAction, type RunJob } from "./view-model";
import type { z } from "zod";

type Changes = z.output<typeof JobChangesSchema>;
type Section = "attempts" | "criteria" | "task" | "changes";

/** True once every required criterion is marked; Accept stays disabled until then. */
export function acceptReady(required: readonly number[], marked: ReadonlySet<number>): boolean {
  return required.every((index) => marked.has(index));
}

export type JobCommand =
  | { kind: "stop" }
  | { kind: "retry"; target?: "primary" | "fallback" }
  | { kind: "accept"; cycleId: string; criteria: number[] }
  | { kind: "approve"; cycleId: string }
  | { kind: "request-changes"; note: string; taskIds?: string[] }
  | { kind: "grant-return" };

type JobDetailsProps = {
  colors: Colors;
  compact: boolean;
  detail: RunDetail;
  job: GraphJob;
  busy: boolean;
  openAgent: ((agentId: string) => void) | null;
  onCommand: (command: JobCommand) => Promise<RunError | null>;
  onClose: () => void;
};

/** One job of a run: attempts, acceptance criteria with evidence, task text, changes, and its actions. */
export function JobDetails({ colors, compact, detail, job, busy, openAgent, onCommand, onClose }: JobDetailsProps) {
  const live = detail.view.jobs.find((candidate) => candidate.id === job.id);
  const [section, setSection] = useState<Section>(live?.status === "awaiting_human" ? "criteria" : "attempts");
  const [notice, setNotice] = useState<string | null>(null);
  const actions = jobActions(job, live, detail);
  const settings = providerChoices(detail.settings[job.id] ?? detail.settings[job.sourceJobId]);
  const chats = openAgent ? openChats(live) : [];
  const run = (command: JobCommand) => {
    setNotice(null);
    void onCommand(command).then((error) => error && setNotice(`${error.message} (${error.code})`));
  };

  return (
    <ScrollView style={{ flex: 1, backgroundColor: colors.surface0 }} contentContainerStyle={{ padding: compact ? 12 : 16, gap: 8 }} testID="job-details">
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Text style={{ flex: 1, color: colors.foreground, fontSize: 16, fontWeight: "600" }}>{jobTitle(job)}</Text>
        <Button colors={colors} compact label="Close" onPress={onClose} testID="details-close" />
      </View>
      <Muted colors={colors} mono text={`${job.id} · ${job.uses} · ${job.kind}`} />
      <View style={{ flexDirection: "row", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        {live ? <StatusChip colors={colors} label={statusLabel(live)} /> : null}
        {live?.status === "awaiting_human" ? <WaitMarker colors={colors} marker="needs-review" /> : null}
        {live?.status === "needs_human" ? <WaitMarker colors={colors} marker="needs-attention" /> : null}
        {live?.reason ? <Muted colors={colors} text={live.reason} /> : null}
        {live?.retired ? <Muted colors={colors} text="Retired matrix instance (history only)" /> : null}
      </View>
      {live?.status === "needs_human" ? (
        <Banner colors={colors} tone="warning" text="Needs attention: both providers failed. Choose how to continue." testID="needs-attention">
          {attentionDetails(live).map((line, index) => (
            <Text key={index} style={{ color: colors.foreground, fontSize: 12, fontFamily: MONOSPACE }}>
              {line}
            </Text>
          ))}
        </Banner>
      ) : null}
      <JobActions colors={colors} job={job} live={live} actions={actions} busy={busy} run={run} />
      {chats.length > 0 ? (
        <View style={{ flexDirection: "row", gap: 6, flexWrap: "wrap" }}>
          {chats.map((chat) => (
            <Button key={chat.agentId} colors={colors} compact label={chat.label} onPress={() => openAgent?.(chat.agentId)} testID={`open-chat-${chat.agentId}`} />
          ))}
        </View>
      ) : null}
      {notice ? <Banner colors={colors} tone="danger" text={notice} testID="details-error" /> : null}
      {settings.length > 0 ? (
        <View style={{ gap: 2 }}>
          <SectionTitle colors={colors} text="Settings (read-only)" />
          {settings.map((choice) => (
            <Muted key={`${choice.role}-${choice.target}`} colors={colors} mono text={`${choice.role} ${choice.target}: ${choice.label}`} />
          ))}
        </View>
      ) : null}
      <Segmented<Section>
        colors={colors}
        compact={compact}
        options={[
          { id: "attempts", label: "Attempts" },
          { id: "criteria", label: CRITERIA_TITLE },
          { id: "task", label: "Task" },
          { id: "changes", label: "Changes" },
        ]}
        value={section}
        onChange={setSection}
      />
      {section === "attempts" ? <Attempts colors={colors} live={live} /> : null}
      {section === "criteria" ? <Criteria colors={colors} job={job} detail={detail} /> : null}
      {section === "task" ? <Task colors={colors} job={job} /> : null}
      {section === "changes" ? <ChangesView colors={colors} runId={detail.view.runId} jobId={job.id} /> : null}
    </ScrollView>
  );
}

function JobActions({ colors, job, live, actions, busy, run }: { colors: Colors; job: GraphJob; live: RunJob | undefined; actions: JobAction[]; busy: boolean; run: (command: JobCommand) => void }) {
  const accept = actions.find((action): action is Extract<JobAction, { kind: "accept" }> => action.kind === "accept");
  const changes = actions.find((action): action is Extract<JobAction, { kind: "request-changes" }> => action.kind === "request-changes");
  const [marked, setMarked] = useState<Set<number>>(new Set());
  const [note, setNote] = useState("");
  const [taskIds, setTaskIds] = useState("");
  const cycle = accept?.cycleId ?? null;
  useEffect(() => setMarked(new Set()), [cycle]);
  if (actions.length === 0) return null;
  const criteria = job.done;
  return (
    <View style={{ gap: 6, padding: 8, borderRadius: 8, borderWidth: 1, borderColor: colors.border }} testID="job-actions">
      {accept && accept.criteria.length > 0 ? (
        <View style={{ gap: 4 }}>
          <Text style={{ color: colors.foreground, fontSize: 12 }}>Mark every acceptance criterion you checked:</Text>
          {accept.criteria.map((index) => {
            const item = criteria[index];
            const checked = marked.has(index);
            return (
              <Pressable
                key={index}
                testID={`criterion-check-${index}`}
                accessibilityRole="checkbox"
                accessibilityState={{ checked }}
                onPress={() => {
                  const next = new Set(marked);
                  if (checked) next.delete(index);
                  else next.add(index);
                  setMarked(next);
                }}
                style={{ flexDirection: "row", gap: 6, alignItems: "flex-start" }}
              >
                <View style={{ width: 16, height: 16, marginTop: 1, borderRadius: 3, borderWidth: 1, borderColor: colors.border, backgroundColor: checked ? colors.accent : colors.surface0 }} />
                <Text style={{ flex: 1, color: colors.foreground, fontSize: 12 }}>{item && "criterion" in item ? item.criterion : `Criterion ${index + 1}`}</Text>
              </Pressable>
            );
          })}
        </View>
      ) : null}
      <View style={{ flexDirection: "row", gap: 6, flexWrap: "wrap" }}>
        {actions.map((action, index) => {
          switch (action.kind) {
            case "stop":
              return <Button key={index} colors={colors} compact danger label="Stop" disabled={busy} onPress={() => run({ kind: "stop" })} testID="action-stop" />;
            case "retry":
              return (
                <Button
                  key={index}
                  colors={colors}
                  compact
                  label={action.label}
                  disabled={busy}
                  onPress={() => run(action.target ? { kind: "retry", target: action.target } : { kind: "retry" })}
                  testID={`action-retry${action.target ? `-${action.target}` : ""}`}
                />
              );
            case "accept":
              return (
                <Button
                  key={index}
                  colors={colors}
                  compact
                  primary
                  label="Accept"
                  disabled={busy || !acceptReady(action.criteria, marked)}
                  onPress={() => run({ kind: "accept", cycleId: action.cycleId, criteria: action.criteria.filter((criterion) => marked.has(criterion)) })}
                  testID="action-accept"
                />
              );
            case "approve":
              return <Button key={index} colors={colors} compact primary label="Approve" disabled={busy} onPress={() => run({ kind: "approve", cycleId: action.cycleId })} testID="action-approve" />;
            case "grant-return":
              return <Button key={index} colors={colors} compact label="Grant return" disabled={busy} onPress={() => run({ kind: "grant-return" })} testID="action-grant" />;
            case "request-changes":
              return null;
          }
        })}
      </View>
      {changes ? (
        <View style={{ gap: 4 }}>
          <TextInput
            testID="request-note"
            accessibilityLabel="What should change"
            value={note}
            onChangeText={setNote}
            multiline
            placeholder="What should change"
            placeholderTextColor={colors.foregroundMuted}
            style={{ borderWidth: 1, borderColor: colors.border, borderRadius: 6, padding: 6, minHeight: 48, color: colors.foreground, fontSize: 12, textAlignVertical: "top" }}
          />
          {changes.taskIds ? (
            <TextInput
              accessibilityLabel="Task ids to return to"
              value={taskIds}
              onChangeText={setTaskIds}
              placeholder="Task ids to return to, comma separated"
              placeholderTextColor={colors.foregroundMuted}
              autoCapitalize="none"
              style={{ borderWidth: 1, borderColor: colors.border, borderRadius: 6, padding: 6, color: colors.foreground, fontSize: 12 }}
            />
          ) : null}
          <View style={{ flexDirection: "row" }}>
            <Button
              colors={colors}
              compact
              label="Request changes"
              disabled={busy || note.trim() === ""}
              onPress={() => {
                const ids = taskIds.split(",").map((id) => id.trim()).filter((id) => id !== "");
                run({ kind: "request-changes", note: note.trim(), ...(ids.length > 0 ? { taskIds: ids } : {}) });
              }}
              testID="action-request-changes"
            />
          </View>
        </View>
      ) : null}
      {live?.status === "awaiting_human" && job.uses === "approval" ? <Muted colors={colors} text="Approve records the final workflow approval; it is separate from accepting a task." /> : null}
    </View>
  );
}

function Attempts({ colors, live }: { colors: Colors; live: RunJob | undefined }) {
  if (!live || live.attempts.length === 0) return <Muted colors={colors} text="No attempt yet." />;
  return (
    <View style={{ gap: 6 }}>
      {[...live.attempts].reverse().map((attempt) => (
        <View key={attempt.attemptId} style={{ padding: 8, borderRadius: 6, borderWidth: 1, borderColor: colors.border, gap: 2 }}>
          <Text style={{ color: colors.foreground, fontSize: 13, fontWeight: "600" }}>
            #{attempt.n} · {attempt.cause} · {attempt.outcome ?? (attempt.endedAt ? "ended" : "running")}
          </Text>
          <Muted colors={colors} text={`target ${attempt.target}${attempt.reason ? ` · ${attempt.reason}` : ""}${attempt.matrixValue !== undefined ? ` · value ${String(attempt.matrixValue)}` : ""}`} />
          <Muted colors={colors} text={`${attempt.startedAt}${attempt.endedAt ? ` → ${attempt.endedAt}` : ""}`} />
          {attempt.agents.map((agent) => (
            <Muted key={agent.creationKey} colors={colors} mono text={`${agent.role}: ${agentText(agent.settings)} · ${agent.agentId ?? "binding…"} · ${agent.target}`} />
          ))}
        </View>
      ))}
    </View>
  );
}

const STATUS_TEXT = { met: "Met", not_met: "Not met", pending: "Pending", stale: "Stale" } as const;

function Criteria({ colors, job, detail }: { colors: Colors; job: GraphJob; detail: RunDetail }) {
  const rows = criteriaRows(job, detail.view);
  if (rows.length === 0) return <Muted colors={colors} text={job.uses === "approval" ? "A person approves the workflow result." : "No acceptance criteria."} />;
  return (
    <View style={{ gap: 6 }} testID="criteria">
      <SectionTitle colors={colors} text={CRITERIA_TITLE} />
      {rows.map((row) => (
        <View key={`${row.kind}-${row.index}`} style={{ padding: 8, borderRadius: 6, borderWidth: 1, borderColor: colors.border, gap: 3 }}>
          <View style={{ flexDirection: "row", gap: 6, alignItems: "center" }}>
            <Text style={{ color: row.status === "met" ? colors.statusSuccess : row.status === "not_met" ? colors.statusDanger : row.status === "stale" ? colors.statusWarning : colors.foregroundMuted, fontSize: 12, fontWeight: "600" }}>
              {STATUS_TEXT[row.status]}
            </Text>
            <Text style={{ flex: 1, color: colors.foreground, fontSize: 12, fontFamily: row.kind === "check" ? MONOSPACE : undefined }}>{row.text}</Text>
          </View>
          {row.cycles.map((cycle, index) => (
            <View key={`${cycle.cycleId}-${index}`} style={{ gap: 1, opacity: cycle.invalidated ? 0.6 : 1 }}>
              <Muted
                colors={colors}
                mono
                text={`${cycle.cycleId} · ${cycle.result}${cycle.mode ? ` · ${cycle.mode}` : ""}${cycle.exitCode !== null ? ` · exit ${cycle.exitCode}` : ""}${cycle.invalidated ? " · invalidated" : ""}`}
              />
              {cycle.outputTail ? (
                <Text numberOfLines={8} style={{ color: colors.foregroundMuted, fontFamily: MONOSPACE, fontSize: 11 }}>
                  {cycle.outputTail}
                </Text>
              ) : null}
            </View>
          ))}
        </View>
      ))}
    </View>
  );
}

function Task({ colors, job }: { colors: Colors; job: GraphJob }) {
  const parts = taskText(job);
  if (parts.length === 0) return <Muted colors={colors} text="This job has no task text." />;
  return (
    <View style={{ gap: 6 }}>
      {parts.map((part) => (
        <View key={part.label} style={{ gap: 2 }}>
          <SectionTitle colors={colors} text={part.label} />
          <Text selectable style={{ color: colors.foreground, fontSize: 13 }}>
            {part.text}
          </Text>
        </View>
      ))}
    </View>
  );
}

function ChangesView({ colors, runId, jobId }: { colors: Colors; runId: string; jobId: string }) {
  const load = useRpc(jobChanges);
  const [state, setState] = useState<{ changes: Changes | null; error: string | null; loading: boolean }>({ changes: null, error: null, loading: true });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    setState({ changes: null, error: null, loading: true });
    load({ runId, jobId }).then(
      (answer) => live && setState(answer.ok ? { changes: answer.value, error: null, loading: false } : { changes: null, error: answer.error.message, loading: false }),
      (error: unknown) => live && setState({ changes: null, error: error instanceof Error ? error.message : "The host did not answer.", loading: false }),
    );
    return () => {
      live = false;
    };
  }, [load, runId, jobId, attempt]);
  if (state.loading) return <Muted colors={colors} text="Loading changes…" />;
  if (state.error !== null || state.changes === null) {
    return (
      <View style={{ gap: 6 }}>
        <Muted colors={colors} text={state.error ?? "No changes."} />
        <View style={{ flexDirection: "row" }}>
          <Button colors={colors} compact label="Reload" onPress={() => setAttempt(attempt + 1)} />
        </View>
      </View>
    );
  }
  const { changes } = state;
  return (
    <View style={{ gap: 6 }}>
      <Muted colors={colors} mono text={changes.stat || "No changes against the base commit."} />
      {changes.attempts.map((entry) => (
        <Muted key={entry.attemptId} colors={colors} mono text={`${entry.attemptId}: ${entry.files === null ? "files unknown" : entry.files.length === 0 ? "no files" : entry.files.join(", ")}`} />
      ))}
      {changes.diff ? (
        <ScrollView horizontal style={{ borderWidth: 1, borderColor: colors.border, borderRadius: 6 }}>
          <Text selectable style={{ padding: 6, color: colors.foreground, fontFamily: MONOSPACE, fontSize: 11 }}>
            {changes.diff}
          </Text>
        </ScrollView>
      ) : null}
      {changes.truncated ? <Muted colors={colors} text="The diff is truncated." /> : null}
      <View style={{ flexDirection: "row" }}>
        <Button colors={colors} compact label="Reload" onPress={() => setAttempt(attempt + 1)} />
      </View>
    </View>
  );
}
