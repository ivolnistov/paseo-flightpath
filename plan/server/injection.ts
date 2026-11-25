// agent.create injection of the project-scoped MCP server, plus hydration-only hooks that capture
// the PaseoApi. Fails open: any doubt means no injection, never a broken agent.
import type { PaseoApi } from "@getpaseo/client";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import type { AgentSessionConfig, ToolPolicy } from "@getpaseo/protocol/agent-types";
import { isDomainError } from "../shared/errors";
import type { McpEndpoint } from "./mcp-endpoint";
import { envFingerprint, fingerprint, GRANT_FP_ENV, isReservationId, PLUGIN_ID, RESERVATION_ENV, type McpState } from "./mcp-state";
import type { createPaseoHolder } from "./paseo-holder";
import { providerSupportsMcp } from "./providers";
import type { openStore as openStoreFn } from "./store";
import { projectForCwd, resolveProject, type ProjectDirectory } from "./store-root";

export interface InjectionDeps {
  endpoint: Promise<McpEndpoint>;
  state: McpState;
  holder: ReturnType<typeof createPaseoHolder>;
  directory: (p: PaseoApi) => ProjectDirectory;
  openStore: typeof openStoreFn;
  log: (m: string) => void;
}

/**
 * The roadmap tools the dedicated discussion chat may call without a per-call approval: the reads its
 * prompt relies on and question creation. Every other roadmap tool (answers, acceptance, cancellation,
 * out of scope, finishing, plans, cards, runs) keeps the provider's normal approval.
 */
export const DISCUSSION_PREAPPROVED_TOOLS = [
  "roadmap_overview",
  "roadmap_get_session",
  "roadmap_feature_list",
  "roadmap_resolve_link",
  "roadmap_pause_instructions",
  "roadmap_ask",
] as const;

/**
 * The second server entry a Codex discussion chat gets for its preapprovals: the same endpoint and
 * grant as the roadmap server. Codex turns the preapproved tools of a server into that server's whole
 * enabled tool list, so granting on the roadmap server itself would hide every other roadmap tool;
 * on this entry only the preapproved tools are listed, and the roadmap server stays complete, with
 * its normal approvals.
 */
export const DISCUSSION_SERVER = `${PLUGIN_ID}-discuss`;

/**
 * Where each provider that accepts exact MCP tool preapprovals takes the discussion chat's grants.
 * Claude and OpenCode add a grant as one more allowed tool, so the roadmap server itself is used;
 * other providers refuse a creation with preapprovals, so they get none.
 */
const PREAPPROVAL_SERVER: Readonly<Record<string, string>> = { claude: PLUGIN_ID, opencode: PLUGIN_ID, codex: DISCUSSION_SERVER };

/** The creation's own preapprovals, plus the discussion chat's roadmap tools on `server` not already granted. */
function withDiscussionGrants(toolPolicy: ToolPolicy | undefined, server: string): ToolPolicy {
  const preapproved = [...(toolPolicy?.preapproved ?? [])];
  for (const tool of DISCUSSION_PREAPPROVED_TOOLS) {
    if (!preapproved.some((g) => g.kind === "mcp" && g.server === server && g.tool === tool)) preapproved.push({ kind: "mcp", server, tool });
  }
  return { ...toolPolicy, preapproved };
}

/** The injected roadmap server, and for the discussion chat its preapprovals (and Codex's grant entry). */
function injected(config: AgentSessionConfig, url: string, discussionChat: boolean): AgentSessionConfig {
  const entry = { type: "http" as const, url };
  const mcpServers = { ...config.mcpServers, [PLUGIN_ID]: entry };
  const server = discussionChat ? PREAPPROVAL_SERVER[config.provider] : undefined;
  if (server === undefined || (server !== PLUGIN_ID && config.mcpServers?.[server] !== undefined)) return { ...config, mcpServers };
  return {
    ...config,
    mcpServers: server === PLUGIN_ID ? mcpServers : { ...mcpServers, [server]: entry },
    toolPolicy: withDiscussionGrants(config.toolPolicy, server),
  };
}

const reason = (e: unknown) => (isDomainError(e) ? e.code : e instanceof Error ? e.name : "error");

export function registerInjection(server: Pick<PluginServerContext, "before" | "on">, deps: InjectionDeps): () => void {
  const { state, holder, directory, openStore, log } = deps;

  const unregisterCreate = server.before("agent.create", async ({ request }, ctx) => {
    try {
      holder.set(ctx.paseo);
      const config = request.config;
      if (!providerSupportsMcp(config.provider)) return undefined;
      if (config.mcpServers?.[PLUGIN_ID] !== undefined) return undefined;
      if (typeof config.cwd !== "string") return undefined;
      const dir = directory(ctx.paseo);
      const projectId = await projectForCwd(dir, config.cwd);
      if (projectId === null) return undefined;
      const { storeRoot } = await resolveProject(dir, projectId);
      const store = openStore({ storeRoot, projectId });
      const read = await store.read();
      if (read.status !== "ok" || read.disabled) return undefined;
      let endpoint: McpEndpoint;
      try {
        endpoint = await deps.endpoint;
      } catch {
        return undefined;
      }
      // A discussion chat's creation carries its reservation in the env; the grant is marked with it, so
      // the chat's tools state is read from its own grant only, never from another chat's.
      const reservation = request.env?.[RESERVATION_ENV];
      // Only the creation Discuss reserved in this project's store is the dedicated discussion chat.
      const discussionChat =
        isReservationId(reservation) && read.data.features.some((f) => f.discussion?.state === "creating" && f.discussion.reservationId === reservation);
      const grant = await state.issueGrant({
        projectId,
        storeRoot,
        provider: config.provider,
        cwd: config.cwd,
        port: endpoint.port,
        ...(isReservationId(reservation) ? { reservationId: reservation } : {}),
      });
      log(`injected fp=${fingerprint(grant.grantId)} project=${projectId} provider=${config.provider}`);
      // The env fingerprint lets session_open bind this grant to the agent (Stage R3.2).
      return {
        ...request,
        config: injected(config, endpoint.urlFor(grant), discussionChat),
        env: { ...request.env, [GRANT_FP_ENV]: envFingerprint(grant.grantId) },
      };
    } catch (e) {
      log(`injection skipped: ${reason(e)}`);
      return undefined;
    }
  });

  // Existing agents cannot be given MCP servers here; config and env stay untouched. An interactive
  // session that carries a grant fingerprint binds that grant to its agent once (Stage R3.2).
  const unregisterOpen = server.before("agent.session_open", async ({ request }, ctx) => {
    holder.set(ctx.paseo);
    try {
      const fp = request.env?.[GRANT_FP_ENV];
      if (request.purpose === "interactive" && typeof fp === "string" && fp !== "") {
        await state.bindByFingerprint(fp, { agentId: request.agentId, workspaceId: request.workspaceId, at: new Date().toISOString() });
      }
    } catch (e) {
      log(`grant binding skipped: ${reason(e)}`);
    }
    return undefined;
  });
  const unregisterTurn = server.on("agent.turn_started", (_event, ctx) => {
    holder.set(ctx.paseo);
  });

  return () => {
    unregisterCreate();
    unregisterOpen();
    unregisterTurn();
  };
}
