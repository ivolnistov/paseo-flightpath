import { useRpc } from "@getpaseo/plugin/client";
import { useMemo, useState, type ReactNode } from "react";
import { Text, View } from "react-native";
import { workflowChatOpen, type WorkflowView } from "../shared/rpc";
import type { ExpandedGraph, Workflow } from "../shared/workflow";
import { GraphView } from "./graph-view";
import { canSave, useWorkflowSession, type WorkflowSessionState } from "./hooks";
import { AddBlock, JobEditor } from "./job-editor";
import { JobList } from "./job-list";
import { ProposalPreview } from "./proposal-preview";
import { StartDialog } from "./start-dialog";
import { Banner, Button, Muted, Segmented, type Colors } from "./ui";
import { defaultView, jobRows, sourceJob, type PlanningView } from "./view-model";
import { ConflictBanner, YamlView } from "./yaml-view";

export type PlanSource =
  | { kind: "none" }
  | { kind: "saved" | "draft"; graph: ExpandedGraph; model: Workflow }
  | { kind: "saved-fallback"; graph: ExpandedGraph; model: Workflow; errors: number }
  | { kind: "invalid"; errors: number };

/**
 * What Diagram and Task list draw: the editable text's graph when it validates, else the saved
 * workflow (with an explicit status) while an invalid draft exists.
 */
export function planSource(view: WorkflowView | null): PlanSource {
  if (view === null) return { kind: "none" };
  if (view.graph !== null && view.model !== null) return { kind: view.draft !== null ? "draft" : "saved", graph: view.graph, model: view.model };
  const errors = view.diagnostics.length;
  if (view.draft !== null && view.savedPlan !== null) return { kind: "saved-fallback", graph: view.savedPlan.graph, model: view.savedPlan.model, errors };
  return view.saved === null && view.draft === null ? { kind: "none" } : { kind: "invalid", errors };
}

/** The saved workflow's model, which Start uses; null when it does not validate. */
export function savedModel(view: WorkflowView | null): Workflow | null {
  if (view === null || view.saved === null) return null;
  if (view.draft === null) return view.diagnostics.length === 0 ? view.model : null;
  return view.savedPlan?.model ?? null;
}

export function yamlStatus(state: WorkflowSessionState): string {
  const view = state.view;
  if (state.unsent) return "Unsent edits…";
  if (view === null) return "";
  if (view.draft === null) return view.saved === null ? "No workflow saved yet" : "Matches the saved workflow";
  return view.diagnostics.length > 0 ? `Draft has ${view.diagnostics.length} problem${view.diagnostics.length === 1 ? "" : "s"}; Save is disabled` : "Unsaved draft";
}

const STARTER = `name: My workflow
jobs:
  build:
    uses: agent
    with: { prompt: Describe the change to make. }
    done: [{ criterion: The change is complete. }]
`;

type Overlay = { kind: "job"; id: string } | { kind: "add" } | { kind: "proposal"; id: string } | { kind: "start" } | null;

type PlanningScreenProps = {
  colors: Colors;
  compact: boolean;
  projectId: string;
  workspaceId: string;
  openAgent: ((agentId: string) => void) | null;
  onRunStarted: (runId: string) => void;
};

export function PlanningScreen({ colors, compact, projectId, workspaceId, openAgent, onRunStarted }: PlanningScreenProps) {
  const { session, state } = useWorkflowSession(projectId);
  const openChat = useRpc(workflowChatOpen);
  const [view, setView] = useState<PlanningView>(() => defaultView(compact));
  const [overlay, setOverlay] = useState<Overlay>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const source = useMemo(() => planSource(state.view), [state.view]);
  const rows = useMemo(() => (source.kind === "saved" || source.kind === "draft" || source.kind === "saved-fallback" ? jobRows(source.graph) : []), [source]);
  const editable = source.kind === "saved" || source.kind === "draft";

  if (state.view === null) {
    return <Centered colors={colors} text={state.loadError ? `Could not load the workflow: ${state.loadError}` : "Loading workflow…"} />;
  }
  const workflowView = state.view;
  const pendingProposals = workflowView.proposals.filter((proposal) => proposal.status === "pending" || proposal.status === "stale");

  const graphJob = overlay?.kind === "job" && "graph" in source ? source.graph.jobs.find((job) => job.id === overlay.id) : undefined;
  const editing = graphJob && "model" in source ? sourceJob(source.model, graphJob) : null;
  let details: ReactNode = null;
  if (overlay?.kind === "job" && editing) {
    details = <JobEditor key={editing.job.id} colors={colors} compact={compact} model={editing.model} job={editing.job} editable={editable} busy={state.busy} onApply={(op) => session.edit(op)} onClose={() => setOverlay(null)} />;
  } else if (overlay?.kind === "add" && "model" in source) {
    details = <AddBlock colors={colors} compact={compact} model={source.model} busy={state.busy} onApply={(op) => session.edit(op)} onClose={(id) => setOverlay(id ? { kind: "job", id } : null)} />;
  } else if (overlay?.kind === "proposal") {
    const proposal = workflowView.proposals.find((candidate) => candidate.id === overlay.id);
    if (proposal) {
      details = (
        <ProposalPreview
          colors={colors}
          compact={compact}
          proposal={proposal}
          baseText={(workflowView.draft ?? workflowView.saved)?.yaml ?? ""}
          baseModel={workflowView.model}
          busy={state.busy}
          onApply={() => void session.applyProposal(proposal.id).then((ok) => ok && setOverlay(null))}
          onDiscard={() => void session.discardProposal(proposal.id).then((ok) => ok && setOverlay(null))}
          onClose={() => setOverlay(null)}
        />
      );
    }
  } else if (overlay?.kind === "start") {
    details = (
      <StartDialog
        colors={colors}
        compact={compact}
        projectId={projectId}
        inputs={savedModel(workflowView)?.inputs ?? null}
        onStarted={(runId) => {
          setOverlay(null);
          onRunStarted(runId);
        }}
        onClose={() => setOverlay(null)}
      />
    );
  }

  if (compact && details) return <View style={{ flex: 1, backgroundColor: colors.surface0 }}>{details}</View>;

  const select = (id: string) => setOverlay({ kind: "job", id });
  const onAdd = editable ? () => setOverlay({ kind: "add" }) : null;
  const askAi = openAgent
    ? () => {
        setNotice(null);
        openChat({ projectId, workspaceId })
          .then((answer) => (answer.ok ? openAgent(answer.value.agentId) : setNotice(answer.error.message)))
          .catch((error: unknown) => setNotice(error instanceof Error ? error.message : "The workflow chat could not open."));
      }
    : null;

  return (
    <View style={{ flex: 1 }}>
      <View style={{ flexDirection: compact ? "column" : "row", gap: 8, padding: 8, alignItems: compact ? "stretch" : "center" }}>
        <Segmented<PlanningView>
          colors={colors}
          compact={compact}
          options={[
            { id: "diagram", label: "Diagram" },
            { id: "list", label: "Task list" },
            { id: "yaml", label: state.unsent || workflowView.draft !== null ? "YAML •" : "YAML" },
          ]}
          value={view}
          onChange={setView}
        />
        <View style={{ flexDirection: "row", gap: 6, flexWrap: "wrap", flex: compact ? undefined : 1, justifyContent: compact ? "flex-start" : "flex-end" }}>
          {askAi ? <Button colors={colors} compact label="Ask AI" onPress={askAi} testID="ask-ai" /> : null}
          <Button colors={colors} compact primary label="Start run" onPress={() => setOverlay({ kind: "start" })} testID="open-start" />
        </View>
      </View>
      <View style={{ paddingHorizontal: 8, gap: 6 }}>
        {state.conflict ? (
          <ConflictBanner
            colors={colors}
            message={state.conflict.message}
            unsentText={state.conflict.unsentText}
            onReload={() => void session.reload()}
            onUseKept={() => void session.useKeptText()}
            onDismiss={() => session.dismissConflict()}
          />
        ) : null}
        {state.error ? <Banner colors={colors} tone="danger" text={state.error.message} testID="workflow-error" /> : null}
        {notice ? <Banner colors={colors} tone="danger" text={notice} /> : null}
        {pendingProposals.map((proposal) => (
          <Banner key={proposal.id} colors={colors} tone="info" text={`AI proposal: ${proposal.summary}`}>
            <View style={{ flexDirection: "row" }}>
              <Button colors={colors} compact label="Preview" onPress={() => setOverlay({ kind: "proposal", id: proposal.id })} testID={`proposal-${proposal.id}`} />
            </View>
          </Banner>
        ))}
        {view !== "yaml" ? <SourceBanner colors={colors} source={source} /> : null}
      </View>
      <View style={{ flex: 1, flexDirection: "row" }}>
        <View style={{ flex: 1 }}>
          {view === "yaml" ? (
            <YamlView
              colors={colors}
              compact={compact}
              text={state.text}
              diagnostics={state.unsent ? [] : workflowView.diagnostics}
              status={yamlStatus(state)}
              canSave={canSave(state)}
              canDiscard={workflowView.draft !== null || state.unsent}
              busy={state.busy}
              onChange={(text) => session.setText(text)}
              onSave={() => void session.save()}
              onDiscard={() => void session.discard()}
            />
          ) : source.kind === "none" ? (
            <View style={{ padding: 16, gap: 8 }}>
              <Muted colors={colors} text="No workflow yet. Write one in YAML or start from an example." />
              <View style={{ flexDirection: "row" }}>
                <Button
                  colors={colors}
                  primary
                  label="Start from an example"
                  onPress={() => {
                    session.setText(STARTER);
                    setView("yaml");
                  }}
                />
              </View>
            </View>
          ) : source.kind === "invalid" ? (
            <Muted colors={colors} text="Fix the YAML to see the diagram." />
          ) : view === "diagram" ? (
            <GraphView graph={source.graph} rows={rows} colors={colors} selectedId={overlay?.kind === "job" ? overlay.id : null} onSelect={select} onAdd={onAdd} />
          ) : (
            <JobList rows={rows} colors={colors} selectedId={overlay?.kind === "job" ? overlay.id : null} onSelect={select} onAdd={onAdd} />
          )}
        </View>
        {details ? <View style={{ width: 360, borderLeftWidth: 1, borderColor: colors.border }}>{details}</View> : null}
      </View>
    </View>
  );
}

function SourceBanner({ colors, source }: { colors: Colors; source: PlanSource }) {
  switch (source.kind) {
    case "draft":
      return <Banner colors={colors} tone="warning" text="Draft, not saved. This view shows the valid YAML draft; Save or Discard it in YAML." testID="plan-source" />;
    case "saved-fallback":
      return <Banner colors={colors} tone="danger" text={`The YAML draft has ${source.errors} problem${source.errors === 1 ? "" : "s"}. This view shows the saved workflow.`} testID="plan-source" />;
    case "invalid":
      return <Banner colors={colors} tone="danger" text={`The workflow has ${source.errors} problem${source.errors === 1 ? "" : "s"} and no valid saved version to show.`} testID="plan-source" />;
    case "saved":
    case "none":
      return null;
  }
}

export function Centered({ colors, text }: { colors: Colors; text: string }) {
  return (
    <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 16 }}>
      <Text style={{ color: colors.foregroundMuted, textAlign: "center" }}>{text}</Text>
    </View>
  );
}
