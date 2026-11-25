import type { PaseoApi } from "@getpaseo/client";
import { DomainError } from "../shared/errors";
import { NotReadyError, type GrantResolver } from "./mcp-endpoint";
import type { createPaseoHolder } from "./paseo-holder";
import { openStore, type StoreOptions } from "./store";
import { resolveProject, type ProjectDirectory } from "./store-root";

export interface GrantResolverDeps {
  holder: ReturnType<typeof createPaseoHolder>;
  directory: (p: PaseoApi) => ProjectDirectory;
  log: (m: string) => void;
  storeOptions?: Omit<StoreOptions, "storeRoot" | "projectId">;
}

/**
 * Per tool call: requires a captured PaseoApi (else NotReadyError, before any registry or store
 * access), re-resolves the registered root, checks it still equals the grant's, and returns an
 * opener bound to the grant's project. The store itself enforces manifest.projectId.
 */
export function createGrantResolver(deps: GrantResolverDeps): GrantResolver {
  const { holder, directory, storeOptions } = deps;
  const log = storeOptions?.log ?? ((m: string) => deps.log(m));
  return async (grant) => {
    const paseo = holder.get();
    if (!paseo) throw new NotReadyError();
    const { storeRoot } = await resolveProject(directory(paseo), grant.projectId, storeOptions?.fs);
    if (storeRoot !== grant.storeRoot) throw new DomainError("project_mismatch", "project root changed since injection");
    return (projectId) =>
      projectId === grant.projectId
        ? Promise.resolve(openStore({ ...storeOptions, log, storeRoot, projectId }))
        : Promise.reject(new DomainError("project_mismatch", "grant is bound to another project"));
  };
}
