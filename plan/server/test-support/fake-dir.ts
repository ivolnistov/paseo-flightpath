// In-memory ProjectDirectory standing in for the daemon project/workspace registry.
import type { ProjectDirectory } from "../store-root";

type Project = { projectId: string; projectRootPath: string; projectKind: string };
type Workspace = { id: string; projectId: string; directory?: string };

export function fakeDirectory(init: {
  projects: Project[];
  workspaces?: Workspace[];
}): ProjectDirectory {
  return {
    listProjects: async () => init.projects.map((p) => ({ ...p })),
    listWorkspaces: async () => (init.workspaces ?? []).map((w) => ({ ...w })),
  };
}
