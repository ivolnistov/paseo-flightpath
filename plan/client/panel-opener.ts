// Opens the roadmap panel of a workspace from a timeline card. The client entry captures the SDK's
// `client.openPanel` once at contribute time; cards set the pending route first, then open.
import { setPendingRoute, type RoadmapRoute } from "./slash";

type Opener = (workspaceId: string, agentId?: string) => void;
let opener: Opener | null = null;

export function setPanelOpener(next: Opener | null): void {
  opener = next;
}

/**
 * Leaves `route` for the panel of this workspace and project, then opens it when the host allows.
 * Returns false when no opener is available; the route then waits for the panel to be opened by hand.
 */
export function openInRoadmap(scope: { workspaceId: string; projectId: string }, route: RoadmapRoute, agentId?: string): boolean {
  setPendingRoute(scope, route);
  if (opener === null) return false;
  opener(scope.workspaceId, agentId);
  return true;
}
