import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { PipelineError } from "../shared/errors";
import { PROJECT_ID_PATTERN, PROPOSAL_ID_PATTERN } from "../shared/rpc";

export const PLUGIN_ID = "flightpath-pipeline";

/** `<PASEO_HOME or ~/.paseo>/plugin-data/flightpath-pipeline`, or the absolute override. */
export function pipelineStateDir(override?: string): string {
  if (override !== undefined && override !== "") {
    if (!isAbsolute(override)) throw new PipelineError("unsafe_path", "The data directory must be an absolute path.");
    return override;
  }
  const home = process.env.PASEO_HOME;
  return join(home !== undefined && home !== "" ? home : join(homedir(), ".paseo"), "plugin-data", PLUGIN_ID);
}

export type ProjectPaths = {
  dir: string;
  workflow: string;
  draft: string;
  proposals: string;
  proposal: (id: string) => string;
};

export function projectPaths(stateDir: string, projectId: string): ProjectPaths {
  if (!PROJECT_ID_PATTERN.test(projectId)) throw new PipelineError("unsafe_path", "Invalid project id.");
  const dir = join(stateDir, "projects", projectId);
  const proposals = join(dir, "proposals");
  return {
    dir,
    workflow: join(dir, "workflow.yaml"),
    draft: join(dir, "workflow.draft.yaml"),
    proposals,
    proposal: (id) => {
      if (!PROPOSAL_ID_PATTERN.test(id)) throw new PipelineError("unsafe_path", "Invalid proposal id.");
      return join(proposals, `${id}.json`);
    },
  };
}
