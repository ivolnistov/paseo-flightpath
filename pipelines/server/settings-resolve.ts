import { z } from "zod";
import type { AgentRole, ResolvedAgent, ResolvedSettings } from "../shared/run";
import { REASONING_LEVELS, type AgentSettings, type Diagnostic, type ExpandedGraph, type Reasoning } from "../shared/workflow";

/** The host's agent profiles and providers as Start sees them. */
export type HostCatalog = {
  profiles: ReadonlyArray<{
    id: string;
    name: string;
    provider: string;
    model?: string | undefined;
    modeId?: string | undefined;
    thinkingOptionId?: string | undefined;
    /** Deprecated host field; folded into `options`, which wins on a shared key. */
    featureValues?: Readonly<Record<string, unknown>> | undefined;
    options?: Readonly<Record<string, unknown>> | undefined;
  }>;
  /** `models` is null when the provider's catalog is not known; `supportsMcp` false refuses the provider. */
  providers: ReadonlyArray<{ id: string; models: readonly string[] | null; defaultModel?: string | undefined; supportsMcp?: boolean | undefined }>;
};

export type ResolveSettingsResult =
  | { ok: true; settings: Record<string, Partial<Record<AgentRole, ResolvedSettings>>> }
  | { ok: false; issues: Diagnostic[] };

const JsonOptions = z.record(z.string(), z.json());

function isReasoning(value: string | undefined): value is Reasoning {
  return value !== undefined && (REASONING_LEVELS as readonly string[]).includes(value);
}

/**
 * Resolves every job's primary and fallback agent against the host catalog. A fallback appears
 * only when the workflow sets one. An unknown profile, provider or model, or a provider that
 * cannot take MCP servers, is an issue.
 */
export function resolveSettings(graph: ExpandedGraph, catalog: HostCatalog): ResolveSettingsResult {
  const issues: Diagnostic[] = [];
  const settings: Record<string, Partial<Record<AgentRole, ResolvedSettings>>> = {};
  const issue = (code: string, jobId: string, message: string): void => {
    issues.push({ code, message, line: 0, column: 0, range: null, jobId });
  };

  const checkProvider = (jobId: string, provider: string, model: string | undefined, label: string): string | null => {
    const entry = catalog.providers.find((candidate) => candidate.id === provider);
    if (!entry) {
      issue("provider_unknown", jobId, `${label}: provider \`${provider}\` is not available on this host.`);
      return null;
    }
    if (entry.supportsMcp === false) {
      issue("provider_no_mcp", jobId, `${label}: provider \`${provider}\` cannot take MCP servers.`);
      return null;
    }
    const chosen = model ?? entry.defaultModel;
    if (chosen === undefined || chosen === "") {
      issue("model_unknown", jobId, `${label}: provider \`${provider}\` has no default model; name one.`);
      return null;
    }
    if (entry.models !== null && !entry.models.includes(chosen)) {
      issue("model_unknown", jobId, `${label}: model \`${provider}/${chosen}\` is not available on this host.`);
      return null;
    }
    return chosen;
  };

  const fromModel = (jobId: string, spec: string, reasoning: Reasoning | undefined, label: string): ResolvedAgent | null => {
    const slash = spec.indexOf("/");
    if (slash <= 0 || slash === spec.length - 1) {
      issue("model_invalid", jobId, `${label}: model \`${spec}\` must be written as \`<provider>/<model>\`.`);
      return null;
    }
    const provider = spec.slice(0, slash);
    const model = checkProvider(jobId, provider, spec.slice(slash + 1), label);
    if (model === null) return null;
    return { provider, model, ...(reasoning === undefined ? {} : { reasoning }) };
  };

  const primaryOf = (jobId: string, decl: AgentSettings, label: string): ResolvedAgent | null => {
    if (decl.profile !== undefined) {
      const profile = catalog.profiles.find((candidate) => candidate.id === decl.profile) ?? catalog.profiles.find((candidate) => candidate.name === decl.profile);
      if (!profile) {
        issue("profile_unknown", jobId, `${label}: profile \`${decl.profile}\` does not exist on this host.`);
        return null;
      }
      const model = checkProvider(jobId, profile.provider, profile.model, label);
      if (model === null) return null;
      const merged = { ...(profile.featureValues ?? {}), ...(profile.options ?? {}) };
      const options = JsonOptions.safeParse(merged);
      if (!options.success) {
        issue("profile_options_invalid", jobId, `${label}: profile \`${profile.id}\` has provider options that are not plain JSON.`);
        return null;
      }
      const reasoning = decl.reasoning ?? (isReasoning(profile.thinkingOptionId) ? profile.thinkingOptionId : undefined);
      const thinkingOptionId = decl.reasoning ?? profile.thinkingOptionId;
      return {
        provider: profile.provider,
        model,
        profile: profile.id,
        ...(reasoning === undefined ? {} : { reasoning }),
        ...(profile.modeId ? { modeId: profile.modeId } : {}),
        ...(thinkingOptionId ? { thinkingOptionId } : {}),
        ...(Object.keys(options.data).length > 0 ? { options: options.data } : {}),
      };
    }
    if (decl.model !== undefined) return fromModel(jobId, decl.model, decl.reasoning, label);
    issue("model_unknown", jobId, `${label}: set a \`profile\` or a \`model\`.`);
    return null;
  };

  const resolve = (jobId: string, decl: AgentSettings, label: string): ResolvedSettings | null => {
    const primary = primaryOf(jobId, decl, label);
    const fallback = decl.fallback === undefined ? undefined : fromModel(jobId, decl.fallback.model, decl.fallback.reasoning, `${label} fallback`);
    if (primary === null || fallback === null) return null;
    return { primary, ...(fallback === undefined ? {} : { fallback }), retries: decl.retries };
  };

  for (const job of graph.jobs) {
    const entry: Partial<Record<AgentRole, ResolvedSettings>> = {};
    if (job.agent && (job.uses === "agent" || job.uses === "run-task")) {
      const worker = resolve(job.id, job.agent, `Job \`${job.id}\` worker`);
      if (worker) entry.worker = worker;
    }
    if (job.agent && job.uses === "review") {
      const reviewer = resolve(job.id, job.agent, `Job \`${job.id}\` reviewer`);
      if (reviewer) entry.reviewer = reviewer;
    }
    if (job.reviewer) {
      const reviewer = resolve(job.id, job.reviewer, `Job \`${job.id}\` reviewer`);
      if (reviewer) entry.reviewer = reviewer;
    }
    settings[job.id] = entry;
  }
  return issues.length > 0 ? { ok: false, issues } : { ok: true, settings };
}
