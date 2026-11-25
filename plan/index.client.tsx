import type { PluginClientContext } from "@getpaseo/plugin/client";
import { RoadmapPanel } from "./client/panel";
import { roadmapSlashCommands } from "./client/slash";
import { RunTimelineCard } from "./client/run-timeline-card";
import { DecisionTimelineCard } from "./client/timeline-card";
import { REF_ROW_KIND, REF_ROW_VERSION, RefRowData, ROW_KIND, ROW_VERSION, RowData, RUN_ROW_KIND, RUN_ROW_VERSION, RunRowData } from "./client/timeline-data";
import { ReferencesCard } from "./client/references-card";
import { setPanelOpener } from "./client/panel-opener";
import { RoadmapSettingsScreen } from "./client/roadmap-settings";
import { TrackerSettingsScreen } from "./client/tracker-settings";

const PANEL_ID = "roadmap";

export default function contribute(client: PluginClientContext) {
  // Timeline cards open the panel of the agent's workspace with a pending route.
  setPanelOpener((workspaceId, agentId) => client.openPanel(PANEL_ID, { workspaceId, ...(agentId !== undefined ? { agentId } : {}) }));
  const cleanups = [
    client.addWorkspacePanel({
      id: PANEL_ID,
      title: "Decision roadmap",
      icon: "PanelsTopLeft",
      context: "workspace",
      locations: ["workspace", "explorer"],
      Component: RoadmapPanel,
    }),
    client.addCommandCenterItem({
      id: "open-roadmap",
      title: "Open decision roadmap",
      icon: "PanelsTopLeft",
      keywords: ["decision", "roadmap", "grill"],
      context: "workspace",
      onSelect: (ctx) => ctx.openPanel(PANEL_ID),
    }),
    client.addSettingsScreen({ id: "tracker", title: "Decision roadmap tracker", icon: "PanelsTopLeft", Component: TrackerSettingsScreen }),
    client.addSettingsScreen({ id: "roadmap", title: "Decision roadmap", icon: "PanelsTopLeft", Component: RoadmapSettingsScreen }),
    ...roadmapSlashCommands(PANEL_ID).map((command) => client.addSlashCommand(command)),
    client.addTimelineRenderer({ kind: ROW_KIND, version: ROW_VERSION, schema: RowData, Component: DecisionTimelineCard }),
    client.addTimelineRenderer({ kind: RUN_ROW_KIND, version: RUN_ROW_VERSION, schema: RunRowData, Component: RunTimelineCard }),
    client.addTimelineRenderer({ kind: REF_ROW_KIND, version: REF_ROW_VERSION, schema: RefRowData, Component: ReferencesCard }),
    () => setPanelOpener(null),
  ];
  return () => cleanups.forEach((c) => void c());
}
