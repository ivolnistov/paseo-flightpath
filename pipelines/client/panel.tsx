import { useTabState, useWorkspace, type PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { View } from "react-native";
import { z } from "zod";
import { PROJECT_ID_PATTERN } from "../shared/rpc";
import { ExecutionScreen } from "./execution-screen";
import { Centered, PlanningScreen } from "./planning-screen";
import { Segmented } from "./ui";

export const PANEL_ID = "pipeline";
export const PANEL_TITLE = "Pipeline";
export const SECTIONS = ["planning", "execution"] as const;
export type Section = (typeof SECTIONS)[number];

/** The panel's persisted tab state: the open section and the chosen run. */
export const TabStateSchema = z.object({ section: z.enum(SECTIONS), runId: z.string().nullable() });
export type TabState = z.output<typeof TabStateSchema>;
export const DEFAULT_TAB_STATE: TabState = { section: "planning", runId: null };

/** The project a workspace belongs to, when Pipeline can store data under its id. */
export function projectIdOf(projectId: string | null): string | null {
  return projectId !== null && PROJECT_ID_PATTERN.test(projectId) ? projectId : null;
}

/** The "Pipeline" workspace panel: Planning and Execution for the workspace's project. */
export function PipelinePanel({ theme, layout, workspaceId, navigation, tab, host }: PluginWorkspacePanelProps) {
  const colors = theme.colors;
  const compact = layout.compact;
  const rawProjectId = useWorkspace(workspaceId, (workspace) => workspace.projectId);
  const projectId = projectIdOf(rawProjectId);
  const [state, setState] = useTabState(tab, TabStateSchema, DEFAULT_TAB_STATE);
  const openAgent = navigation ? (agentId: string) => navigation.openAgent({ agentId, serverId: host.id }) : null;

  let body;
  if (rawProjectId === null) body = <Centered colors={colors} text="Loading workspace…" />;
  else if (projectId === null) body = <Centered colors={colors} text={`Pipeline cannot store data for project id "${rawProjectId}".`} />;
  else if (state.section === "planning") {
    body = <PlanningScreen key={projectId} colors={colors} compact={compact} projectId={projectId} workspaceId={workspaceId} openAgent={openAgent} onRunStarted={(runId) => setState({ section: "execution", runId })} />;
  } else {
    body = <ExecutionScreen key={projectId} colors={colors} compact={compact} projectId={projectId} runId={state.runId} onSelectRun={(runId) => setState({ ...state, runId })} openAgent={openAgent} />;
  }

  return (
    <View testID="pipeline-panel" style={{ flex: 1, backgroundColor: colors.surface0 }}>
      <View style={{ padding: compact ? 8 : 10, borderBottomWidth: 1, borderColor: colors.border }}>
        <Segmented<Section>
          colors={colors}
          compact={compact}
          options={[
            { id: "planning", label: "Planning" },
            { id: "execution", label: "Execution" },
          ]}
          value={state.section}
          onChange={(section) => setState({ ...state, section })}
        />
      </View>
      {body}
    </View>
  );
}
