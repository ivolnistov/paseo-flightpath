import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc, useSettings } from "@getpaseo/plugin/client";
import { Modal, ScrollView, TextInput, useToast } from "@getpaseo/plugin/client/react-native";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, type ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import { isV2Revision, type PlanRevision, type PlanRevisionV2, type TaskState } from "../shared/model";
import { PlanApprove, TaskUpdate, type ApprovalBlocker, type PlanView as PlanViewValue, type Result, type RpcError } from "../shared/rpc";
import { RpcFailure, roadmapKey, usePlan, useRunList } from "./hooks";
import { conflictMessage } from "./layout";
import { DodEditor } from "./dod-editor";
import { allowedTaskTargets, approvalColorKey, approvalLabel, hashPrefix, markdownBlocks, revisionDiff, taskSpec, type RevisionDiff } from "./plan-format";
import { ActionButton } from "./roadmap-screen";
import { TaskSpecRow } from "./task-spec-row";
import { trackerSettings } from "../shared/settings";
import { cardStyle } from "./theme";
import { TrackerListSection } from "./tracker-list";
import { TrackerPreviewModal } from "./tracker-preview";
import { Button, Heading, Muted, inputStyle } from "./ui";

type TaskStatus = TaskState["status"];

const TASK_LABEL: Record<TaskStatus, string> = { todo: "To do", in_progress: "In progress", done: "Done", verified: "Verified", cancelled: "Cancelled" };
const TARGET_LABEL: Record<TaskStatus, string> = { todo: "Back to to do", in_progress: "Start", done: "Mark done", verified: "Verify…", cancelled: "Cancelled" };

function planErrorMessage(e: RpcError): string {
  switch (e.code) {
    case "plan_revision_mismatch":
      return "This plan has a newer revision or different content. Review the latest revision and try again.";
    case "plan_not_current":
      return `The decisions behind this revision changed: ${e.message}`;
    default:
      return conflictMessage(e);
  }
}

/** Identity of the plan content an action refers to, captured from what is on screen. */
type Pinned = { planRev: number; contentHash: string; storeRevision: number };
type VerifyTarget = Pinned & { taskId: string; title: string };

/** Display text of a server approval blocker. */
function blockerText(b: ApprovalBlocker): string {
  switch (b.code) {
    case "gates_not_available":
      return "Approval becomes available once the DoD and grilling gates are in place";
    case "dod_missing":
      return `A task has no DoD${b.taskId ? ` (${b.taskId})` : ""}`;
    case "grilling_required":
      return `Required grilling is not complete${b.taskId ? ` (${b.taskId})` : ""}`;
    case "legacy_revision":
      return "This revision predates DoD and grilling gates";
  }
}

/** Task and text changes between two revisions of one plan (also used by the feature Changes section). */
export function DiffView({ diff, from, to, theme }: { diff: RevisionDiff; from: number; to: number; theme: PluginTheme }) {
  return (
    <View style={{ gap: 6 }}>
      <Heading theme={theme}>{`Changes from revision ${from} to ${to}`}</Heading>
      {diff.schemaChanged ? <Text style={{ color: theme.colors.foreground }}>Task fields changed format (DoD, grilling and dependencies added).</Text> : null}
      {diff.markdownChanged ? <Text style={{ color: theme.colors.foreground }}>The plan text changed.</Text> : null}
      {diff.tasks.length === 0 ? <Text style={{ color: theme.colors.foregroundMuted }}>No task changes.</Text> : null}
      {diff.tasks.map((t, i) => (
        <View key={`${t.kind}:${t.taskId}:${i}`} style={{ gap: 2 }}>
          <Text style={{ color: theme.colors.foreground, fontWeight: "600" }}>
            {t.kind === "added"
              ? `Added: ${t.title}`
              : t.kind === "removed"
                ? `Removed: ${t.title}`
                : t.kind === "moved"
                  ? `Moved: ${t.title} (position ${(t.from ?? 0) + 1} → ${(t.to ?? 0) + 1})`
                  : `Changed: ${t.title}`}
          </Text>
          {(t.changes ?? []).map((c) => (
            <Text key={c.field} style={{ color: theme.colors.foregroundMuted }}>{`${c.field}: ${c.before} → ${c.after}`}</Text>
          ))}
        </View>
      ))}
    </View>
  );
}

/**
 * The revision comparison shared by the plan view and the feature Changes section: "Compare with
 * revision N" choices (only when there is more than one revision), then the diff from the chosen
 * revision to `shown`, or `fallback` while none (or `shown` itself) is chosen. Stateless and
 * hook-free, so callers render it with a plain call and keep the selection in their own state.
 */
export function RevisionCompare(props: {
  revisions: PlanRevision[];
  shown: PlanRevision;
  compareRev: number | null;
  onCompare(rev: number): void;
  theme: PluginTheme;
  fallback: ReactNode;
}): ReactNode {
  const { revisions, shown, compareRev, onCompare, theme, fallback } = props;
  const compared = compareRev !== null && compareRev !== shown.rev ? revisions.find((r) => r.rev === compareRev) : undefined;
  return (
    <>
      {revisions.length > 1 ? (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          {revisions.map((r) => (
            <ActionButton key={r.rev} label={`Compare with revision ${r.rev}`} theme={theme} selected={compareRev === r.rev} onPress={() => onCompare(r.rev)} />
          ))}
        </View>
      ) : null}
      {compared ? <DiffView diff={revisionDiff(compared, shown)} from={compared.rev} to={shown.rev} theme={theme} /> : fallback}
    </>
  );
}

type Editing = { plan: PlanViewValue["plan"]; revision: PlanRevisionV2; storeRevision: number } | null;

function MarkdownText({ markdown, theme }: { markdown: string; theme: PluginTheme }) {
  return (
    <View style={{ gap: 8 }}>
      {markdownBlocks(markdown).map((b, i) =>
        b.kind === "heading" ? (
          <Heading key={i} theme={theme}>
            {b.text}
          </Heading>
        ) : (
          <Text key={i} style={{ color: theme.colors.foreground }}>
            {b.kind === "bullet" ? `• ${b.text}` : b.text}
          </Text>
        ),
      )}
    </View>
  );
}

export function PlanView(props: { hostId: string; projectId: string; planId: string; theme: PluginTheme; compact: boolean; onBack(): void }) {
  const { hostId, projectId, planId, theme, compact, onBack } = props;
  const query = usePlan(hostId, projectId, planId);
  // Stage R4.2: a revision executed by a run is verified by the run, never by a manual Verify.
  const featureRuns = useRunList(hostId, projectId, query.data?.plan.featureId ?? null);
  const approveRpc = useRpc(PlanApprove);
  const taskRpc = useRpc(TaskUpdate);
  const queryClient = useQueryClient();
  const toast = useToast();
  const [selectedRev, setSelectedRev] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [verify, setVerify] = useState<VerifyTarget | null>(null);
  const [note, setNote] = useState("");
  const [trackerOpen, setTrackerOpen] = useState(false);
  const [compareRev, setCompareRev] = useState<number | null>(null);
  const [editing, setEditing] = useState<Editing>(null);
  const tracker = useSettings(trackerSettings);
  // Action identity: the latest revision (and store revision) the user is reviewing. Set when the
  // plan first displays and re-set only by an explicit selection or review; a background refetch
  // never changes it, so actions never silently move to a revision the user has not reviewed.
  const [held, setHeld] = useState<Pinned | null>(null);
  // Store revision returned by our own task action; adopted only if the refetch shows exactly it.
  const [ownRevision, setOwnRevision] = useState<number | null>(null);

  const view = query.data;
  const latestRev = view?.plan.revisions.at(-1);

  useEffect(() => {
    if (!view || !latestRev || held) return;
    setHeld({ planRev: latestRev.rev, contentHash: latestRev.contentHash, storeRevision: view.revision });
    setSelectedRev(latestRev.rev);
  }, [view, latestRev, held]);

  useEffect(() => {
    if (!view || !held || ownRevision === null || view.revision !== ownRevision) return;
    // Nothing but our own action happened since the pin: same plan revision, exact next store revision.
    if (latestRev && latestRev.rev === held.planRev && latestRev.contentHash === held.contentHash) {
      setHeld({ ...held, storeRevision: ownRevision });
    }
    setOwnRevision(null);
  }, [view, held, ownRevision, latestRev]);
  const refresh = () => queryClient.invalidateQueries({ queryKey: roadmapKey(hostId, projectId) });

  async function send<T>(call: () => Promise<unknown>): Promise<T | null> {
    setBusy(true);
    try {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- heterogeneous SDK contract dispatch; the generic handler cannot type each method
      const out = (await call()) as Result<T>;
      if (out.ok) return out.value;
      toast.show(planErrorMessage(out.error), { variant: "error" });
      return null;
    } catch (e) {
      toast.show(e instanceof Error ? e.message : "Request failed", { variant: "error" });
      return null;
    } finally {
      setBusy(false);
      await refresh();
    }
  }

  if (query.isError) {
    const e = query.error;
    return (
      <View style={{ gap: 8 }}>
        <Button label="‹ Back" theme={theme} onPress={onBack} />
        <Text style={{ color: theme.colors.statusDanger }}>{e instanceof RpcFailure ? planErrorMessage(e.rpcError) : "The plan could not be loaded."}</Text>
      </View>
    );
  }
  if (!view) return <Muted theme={theme}>Loading…</Muted>;

  const revisions = view.plan.revisions;
  const latest = revisions.at(-1);
  const shown: PlanRevision | undefined = revisions.find((r) => r.rev === (selectedRev ?? held?.planRev)) ?? latest;
  const showingLatest = !!latest && shown?.rev === latest.rev;
  const current = view.approval === "current";
  const newerLoaded = !!held && !!latest && (latest.rev !== held.planRev || latest.contentHash !== held.contentHash);
  const storeMoved = !!held && view.revision !== held.storeRevision;
  // Actions use only the held identity, and only while the reviewed revision is shown and still latest.
  const displayed: Pinned | null = held && showingLatest && !newerLoaded && shown?.rev === held.planRev ? held : null;
  const runs = Array.isArray(featureRuns.data?.runs) ? featureRuns.data.runs : [];
  // A bound plan's run list that has not answered (pending or failed) is treated as run-managed, so
  // a manual Verify is offered only once the list proves there is no run of this revision.
  const runsUnresolved = view.plan.featureId !== undefined && !Array.isArray(featureRuns.data?.runs);
  const runManaged = (rev: number) => runsUnresolved || runs.some((v) => v.run.planId === planId && v.run.planRev === rev);

  /** Explicit review: pin the latest revision and the store state now on screen. */
  function reviewLatest() {
    if (!latest || !view) return;
    setSelectedRev(latest.rev);
    setHeld({ planRev: latest.rev, contentHash: latest.contentHash, storeRevision: view.revision });
    setOwnRevision(null);
  }

  const blockers = view.blockers;
  // Approval effects the server reports as not recorded. The retry is the same idempotent approval of
  // the displayed latest revision, offered only where the server would complete it; the reason text
  // never decides eligibility.
  const pending = view.approvalEffectsPending ?? [];
  const retryBlocked = pending.some((e) => e.retryBlocked !== undefined);
  const latestReworked = !!latest && (view.plan.reworks ?? []).some((r) => r.planRev === latest.rev);
  const canRetryEffects = pending.length > 0 && !!displayed && !latestReworked && blockers.length === 0 && current && !retryBlocked;

  async function approve() {
    // The server's blockers are authoritative; never send an approval they rule out.
    if (!displayed || blockers.length > 0) return;
    const pinned = displayed;
    const out = await send<{ alreadyApproved: boolean; revision: number | null }>(() =>
      approveRpc({ projectId, planId, rev: pinned.planRev, contentHash: pinned.contentHash }),
    );
    // Adopt only our own copy commit directly after the reviewed store state; the effect still
    // requires the refetch to show exactly that revision with the same plan identity.
    if (out && out.revision !== null && out.revision === pinned.storeRevision + 1) setOwnRevision(out.revision);
    if (out) toast.show(out.alreadyApproved ? "This revision was already approved" : `Revision ${displayed.planRev} approved`, { variant: "success" });
  }

  async function moveTask(pinned: Pinned, taskId: string, status: TaskStatus, taskNote?: string) {
    // No control offers cancelled (allowedTaskTargets); only a rework sets it.
    if (status === "cancelled") return undefined;
    const out = await send<{ revision: number }>(() =>
      taskRpc({
        projectId,
        expectedRevision: pinned.storeRevision,
        planId,
        planRev: pinned.planRev,
        contentHash: pinned.contentHash,
        taskId,
        status,
        ...(taskNote !== undefined ? { note: taskNote } : {}),
      }),
    );
    // Only when acting on the held identity: adopt our own result if the refetch shows nothing else.
    if (out && held && pinned.planRev === held.planRev && pinned.contentHash === held.contentHash && pinned.storeRevision === held.storeRevision) {
      setOwnRevision(out.revision);
    }
    return out;
  }

  async function confirmVerify() {
    if (!verify || !note.trim()) return;
    const out = await moveTask(verify, verify.taskId, "verified", note.trim());
    if (out) {
      setVerify(null);
      setNote("");
    }
  }

  const header = (
    <View style={{ gap: 6 }}>
      <View style={{ flexDirection: "row", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <Button label="‹ Back" theme={theme} onPress={onBack} />
        <View style={{ flex: 1 }}>
          <Heading theme={theme}>{view.plan.title}</Heading>
        </View>
      </View>
      {latest ? (
        <Muted theme={theme}>
          Latest rev {latest.rev} · {hashPrefix(latest.contentHash)}
        </Muted>
      ) : (
        <Muted theme={theme}>No revision yet</Muted>
      )}
      <Text style={{ color: theme.colors[approvalColorKey(view.approval)], fontWeight: "600" }}>{approvalLabel(view.approval)}</Text>
      {view.approval === "not_current"
        ? view.notCurrentReasons.map((r, i) => (
            <Text key={i} style={{ color: theme.colors.statusWarning, fontSize: 12 }}>
              • {r}
            </Text>
          ))
        : null}
      {!view.exportWritten ? <Muted theme={theme}>The exported Markdown file could not be updated.</Muted> : null}
    </View>
  );

  const revisionList = (
    <View style={{ gap: 6 }}>
      <Heading theme={theme}>Revisions</Heading>
      {[...revisions].reverse().map((r) => {
        const selected = shown?.rev === r.rev;
        return (
          <Pressable
            key={r.rev}
            accessibilityRole="button"
            accessibilityState={{ selected }}
            accessibilityLabel={`Show revision ${r.rev}`}
            onPress={() => (latest && r.rev === latest.rev ? reviewLatest() : setSelectedRev(r.rev))}
            style={{ ...cardStyle(theme, { dimmed: false }), borderColor: selected ? theme.colors.accent : theme.colors.border }}
          >
            <Text style={{ color: theme.colors.foreground }}>
              Rev {r.rev}
              {latest && r.rev === latest.rev ? " (latest)" : ""}
            </Text>
            <Muted theme={theme}>
              {r.createdAt.replace("T", " ").slice(0, 16)} · {hashPrefix(r.contentHash)}
            </Muted>
          </Pressable>
        );
      })}
      <Heading theme={theme}>Approvals</Heading>
      {view.approvals.length === 0 ? <Muted theme={theme}>None yet.</Muted> : null}
      {view.approvals.map((a, i) => (
        <Text key={`${a.verified ? "receipt" : "copy"}:${a.receipt.receiptId}:${i}`} style={{ color: a.verified ? theme.colors.foreground : theme.colors.statusDanger, fontSize: 12 }}>
          Rev {a.receipt.planRev} · {a.receipt.at.replace("T", " ").slice(0, 16)} · {a.verified ? "verified" : "unverified"}
        </Text>
      ))}
    </View>
  );

  const tasks = latest?.tasks ?? [];
  const stateOf = (taskId: string): TaskStatus =>
    view.plan.taskStates.find((s) => latest && s.planRev === latest.rev && s.taskId === taskId)?.status ?? "todo";

  // Plan-wide titles for the tracker list; the task preview resolves dependencies within the shown revision.
  const titles = Object.fromEntries(revisions.flatMap((r) => r.tasks.map((t) => [t.id, t.title] as const)));
  const shownTitles = Object.fromEntries((shown?.tasks ?? []).map((t) => [t.id, t.title] as const));
  const bound = view.plan.featureId !== undefined;
  // The editor opens only on the reviewed latest revision while the store is as reviewed.
  const canEdit = bound && !!displayed && !storeMoved && !!latest && isV2Revision(latest) && shown?.rev === latest.rev;

  if (editing) {
    return (
      <DodEditor
        key={`${editing.plan.id}:${editing.revision.rev}`}
        hostId={hostId}
        projectId={projectId}
        theme={theme}
        compact={compact}
        plan={editing.plan}
        revision={editing.revision}
        storeRevision={editing.storeRevision}
        onSaved={() => setEditing(null)}
        onCancel={() => setEditing(null)}
      />
    );
  }

  const content = shown ? (
    <View style={{ gap: 12 }}>
      <Heading theme={theme}>
        Revision {shown.rev} · {hashPrefix(shown.contentHash)}
      </Heading>
      {RevisionCompare({ revisions, shown, compareRev, onCompare: setCompareRev, theme, fallback: <MarkdownText markdown={shown.markdown} theme={theme} /> })}
      <View style={{ gap: 8 }}>
        <Heading theme={theme}>Task preview</Heading>
        {shown.tasks.length === 0 ? <Muted theme={theme}>This revision has no tasks.</Muted> : null}
        {(shown.tasks as Parameters<typeof taskSpec>[0][]).map((t) => (
          <TaskSpecRow key={t.id} spec={taskSpec(t)} titles={shownTitles} theme={theme} compact={compact} />
        ))}
        {(view.reuseCandidates ?? []).map((c) => (
          <Text key={`${c.planRev}:${c.taskId}`} style={{ color: theme.colors.foregroundMuted }}>
            {`Completed in revision ${c.planRev}: ${c.title}`}
            {c.verifiedAt !== undefined ? ` (verified ${c.verifiedAt.slice(0, 10)})` : ""}
          </Text>
        ))}
        {!bound ? <Text style={{ color: theme.colors.foregroundMuted }}>Bind this plan to a feature to edit its tasks</Text> : null}
        {canEdit && latest && isV2Revision(latest) && displayed ? (
          <ActionButton
            label="Edit DoD"
            theme={theme}
            onPress={() => setEditing({ plan: view.plan, revision: latest, storeRevision: displayed.storeRevision })}
          />
        ) : null}
      </View>
      {newerLoaded && latest ? (
        <View style={{ gap: 6, borderWidth: 1, borderColor: theme.colors.statusWarning, borderRadius: 8, padding: 10 }}>
          <Text style={{ color: theme.colors.statusWarning }}>
            Revision {latest.rev} is now the latest. Review it before approving or updating tasks.
          </Text>
          <Button label={`Review revision ${latest.rev}`} theme={theme} onPress={reviewLatest} />
        </View>
      ) : null}
      {/* Blockers describe the latest revision, so they show only next to its Approve button. */}
      {showingLatest
        ? blockers.map((b, i) => (
            <Text key={`${b.code}:${i}`} style={{ color: theme.colors.statusWarning }}>
              {blockerText(b)}
            </Text>
          ))
        : null}
      {showingLatest && pending.length > 0 ? (
        <View style={{ gap: 6 }}>
          {pending.map((e, i) => (
            <Text key={`${e.effect}:${i}`} style={{ color: theme.colors.statusWarning }}>
              {e.reason}
            </Text>
          ))}
          {canRetryEffects ? (
            <ActionButton label="Retry approval effects" theme={theme} disabled={busy} onPress={() => void approve()} />
          ) : !retryBlocked && blockers.length > 0 ? (
            <Muted theme={theme}>The approval gates now block this; resolve them first.</Muted>
          ) : null}
        </View>
      ) : null}
      {displayed ? (
        <Button
          label={`Approve revision ${displayed.planRev}`}
          theme={theme}
          primary
          disabled={busy || current || blockers.length > 0}
          onPress={() => void approve()}
        />
      ) : !showingLatest ? (
        <Muted theme={theme}>Only the latest revision can be approved. Select it to review and approve.</Muted>
      ) : null}
      <Muted theme={theme}>Approving records your approval of this exact revision; it stays valid only while its decisions are unchanged.</Muted>
      <View style={{ gap: 6 }}>
        <Heading theme={theme}>Tracker</Heading>
        <TrackerListSection
          hostId={hostId}
          projectId={projectId}
          planId={planId}
          titles={titles}
          theme={theme}
        />
      </View>
      {showingLatest ? (
        <View style={{ gap: 6 }}>
          {tracker.status === "ready" && tracker.values.provider !== "none" ? (
            <Button
              label="Preview tracker actions"
              theme={theme}
              disabled={!current}
              onPress={() => setTrackerOpen(true)}
            />
          ) : (
            <Muted theme={theme}>
              {tracker.status === "loading"
                ? "Loading tracker settings…"
                : tracker.status === "ready"
                  ? "Tracker sync is off. Choose a provider in the plugin settings to mirror approved tasks."
                  : "Tracker settings unavailable."}
            </Muted>
          )}
          {!current && tracker.status === "ready" && tracker.values.provider !== "none" ? (
            <Muted theme={theme}>Available once the latest revision is approved and current.</Muted>
          ) : null}
        </View>
      ) : null}
      {displayed ? (
        <View style={{ gap: 8 }}>
          <Heading theme={theme}>Tasks</Heading>
          {storeMoved ? (
            <View style={{ gap: 6 }}>
              <Muted theme={theme}>The roadmap changed since you reviewed this revision. Review it again to update tasks.</Muted>
              <Button label="Review again" theme={theme} onPress={reviewLatest} />
            </View>
          ) : null}
          {tasks.length === 0 ? <Muted theme={theme}>This revision has no tasks.</Muted> : null}
          {tasks.map((t) => {
            const status = stateOf(t.id);
            return (
              <View key={t.id} style={cardStyle(theme, { dimmed: false })}>
                <Text style={{ color: theme.colors.foreground, fontWeight: "600" }}>{t.title}</Text>
                {t.description ? <Muted theme={theme}>{t.description}</Muted> : null}
                <Text style={{ color: status === "verified" ? theme.colors.statusSuccess : theme.colors.accent, fontSize: 12 }}>{TASK_LABEL[status]}</Text>
                <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
                  {allowedTaskTargets(status, current, runManaged(displayed.planRev)).map((to) => (
                    <Button
                      key={to}
                      label={TARGET_LABEL[to]}
                      theme={theme}
                      disabled={busy || storeMoved}
                      onPress={() => {
                        if (to === "verified") {
                          setNote("");
                          setVerify({ ...displayed, taskId: t.id, title: t.title });
                        } else void moveTask(displayed, t.id, to);
                      }}
                    />
                  ))}
                </View>
              </View>
            );
          })}
        </View>
      ) : null}
    </View>
  ) : (
    <Muted theme={theme}>This plan has no revision yet.</Muted>
  );

  return (
    <View style={{ flex: 1, gap: 12 }}>
      {header}
      {compact ? (
        <ScrollView contentContainerStyle={{ gap: 16, paddingBottom: 24 }}>
          {content}
          {revisionList}
        </ScrollView>
      ) : (
        <View style={{ flex: 1, flexDirection: "row", gap: 16 }}>
          <ScrollView style={{ width: 260, flexGrow: 0 }} contentContainerStyle={{ paddingBottom: 24 }}>
            {revisionList}
          </ScrollView>
          <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: 24 }}>
            {content}
          </ScrollView>
        </View>
      )}
      <TrackerPreviewModal
        hostId={hostId}
        projectId={projectId}
        planId={planId}
        titles={Object.fromEntries((latest?.tasks ?? []).map((t) => [t.id, t.title]))}
        theme={theme}
        open={trackerOpen}
        onOpenChange={setTrackerOpen}
      />
      <Modal title="Verify task" open={verify !== null} onOpenChange={(open) => !open && setVerify(null)}>
        <Modal.Content>
          {verify ? (
            <View style={{ gap: 8 }}>
              <Text style={{ color: theme.colors.foreground }}>{verify.title}</Text>
              <Muted theme={theme}>
                Revision {verify.planRev} · {hashPrefix(verify.contentHash)}
              </Muted>
              <TextInput
                accessibilityLabel="Verification note"
                placeholder="How was it verified? (required)"
                placeholderTextColor={theme.colors.foregroundMuted}
                value={note}
                onChangeText={setNote}
                multiline
                style={[inputStyle(theme), { minHeight: 60 }]}
              />
              <Button label="Mark verified" theme={theme} primary disabled={busy || !note.trim()} onPress={() => void confirmVerify()} />
            </View>
          ) : null}
        </Modal.Content>
      </Modal>
    </View>
  );
}

