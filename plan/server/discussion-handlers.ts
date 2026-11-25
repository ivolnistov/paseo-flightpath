// RPC registration for one-click Discuss (feature.discussion.open). Each call builds its store
// opener and directory from the calling host context; unexpected errors become a sanitised `internal`.
import type { PaseoApi } from "@getpaseo/client";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { isDomainError } from "../shared/errors";
import type { Result } from "../shared/rpc";
import { DiscussionRetry, DiscussionRetryCheck, DiscussionRetryResolve, FeatureDiscussionOpen } from "../shared/rpc-discussion";
import {
  checkRetry,
  openDiscussion,
  resolveRetry,
  retryContinuation,
  sweepStaleRetries,
  type DiscussionDeps,
  type OpenDiscussionInput,
  type OpenDiscussionValue,
} from "./discussion";
import type { createPaseoHolder } from "./paseo-holder";

export function openDiscussionSafely(deps: DiscussionDeps, paseo: PaseoApi, input: OpenDiscussionInput): Promise<Result<OpenDiscussionValue>> {
  return safely(deps, () => openDiscussion(deps, paseo, input));
}

/** The Result boundary: a DomainError keeps its code; anything else is logged by name and becomes `internal`. */
async function safely<T>(deps: Pick<DiscussionDeps, "log">, run: () => Promise<Result<T>>): Promise<Result<T>> {
  try {
    return await run();
  } catch (e) {
    if (isDomainError(e)) return { ok: false, error: { code: e.code, message: e.message, ...(e.details !== undefined ? { details: e.details } : {}) } };
    deps.log(`discussion: unexpected error: ${e instanceof Error ? e.name : "error"}`);
    return { ok: false, error: { code: "internal", message: "Unexpected error; see plugin logs." } };
  }
}

export function registerDiscussionHandlers(
  server: Pick<PluginServerContext, "handle">,
  depsFor: (paseo: PaseoApi) => DiscussionDeps,
  holder?: ReturnType<typeof createPaseoHolder>,
): void {
  server.handle(FeatureDiscussionOpen, (input, context: { paseo: PaseoApi }) => {
    holder?.set(context.paseo);
    return openDiscussionSafely(depsFor(context.paseo), context.paseo, input);
  });
  server.handle(DiscussionRetry, (input, context: { paseo: PaseoApi }) => {
    holder?.set(context.paseo);
    const deps = depsFor(context.paseo);
    return safely(deps, () => retryContinuation(deps, context.paseo, input));
  });
  server.handle(DiscussionRetryResolve, (input, context: { paseo: PaseoApi }) => {
    holder?.set(context.paseo);
    const deps = depsFor(context.paseo);
    return safely(deps, () => resolveRetry(deps, input));
  });
  server.handle(DiscussionRetryCheck, (input, context: { paseo: PaseoApi }) => {
    holder?.set(context.paseo);
    const deps = depsFor(context.paseo);
    return safely(deps, () => checkRetry(deps, context.paseo, input));
  });
}

/**
 * Once per process, with the first host context: every registered project's stale `sending` retry
 * records become `unknown`. Fail-open per project; nothing is sent.
 */
export async function sweepAllProjects(deps: DiscussionDeps, paseo: PaseoApi): Promise<void> {
  let projects: Array<{ projectId: string }>;
  try {
    projects = await deps.directory(paseo).listProjects();
  } catch (e) {
    deps.log(`discussion: retry sweep skipped, projects unreadable: ${e instanceof Error ? e.name : "error"}`);
    return;
  }
  for (const { projectId } of projects) {
    try {
      const swept = await sweepStaleRetries(deps, projectId);
      if (swept > 0) deps.log(`discussion: ${swept} stale retry record(s) marked unknown in ${projectId}`);
    } catch (e) {
      deps.log(`discussion: retry sweep failed for ${projectId}: ${e instanceof Error ? e.name : "error"}`);
    }
  }
}
