# Research report — Tasks 0.0, 2.0, 4.0 evidence (read-only)

## Contract 1 (Task 0.0): canonical registered project root across main/worktrees

**Verified SDK/protocol types (installed @getpaseo/cli 0.12.0):**

- `@getpaseo/protocol/dist/messages.d.ts:8744` — `WorkspaceDescriptorPayloadSchema`: every daemon-issued workspace descriptor carries `id`, `projectId`, `projectDisplayName`, **`projectRootPath`**, `workspaceDirectory?`, `worktreeSlug?`, `projectKind` (`git|directory|non_git`), `workspaceKind` (`directory|local_checkout|checkout|worktree`). Daemon-computed, not client input.
- `messages.d.ts:9979` — `WorkspaceProjectDescriptorPayloadSchema`: `{ projectId, projectKey?, projectDisplayName, projectRootPath, projectKind, syncSeq? }`.
- `@getpaseo/client/dist/index.d.ts:127-129,131-147` — `PaseoProjectActions { list(options?): Promise<PaseoProjectListResult>; subscribe(...) }`, `PaseoWorkspaceActions.list()`; `index.d.ts:53,56` — `PaseoWorkspace = WorkspaceDescriptorPayload`, `PaseoProject = WorkspaceProjectDescriptorPayload`.
- `@getpaseo/plugin/dist/server/lifecycle.d.ts:5-15` — `PluginHookContext { paseo: PaseoApi; signal }`; `PluginHookWorkspace { id, projectId, cwd, name, archivedAt }`. So a server hook gets `projectId` in the event and resolves the root via `context.paseo.projects.list()` → match `projectId` → `projectRootPath`. `PluginHookAgent` (same file) has `workspaceId` for agent-side entry.

**Observed daemon state (read-only `~/.paseo/projects/*.json`):**

- `projects.json`: `prj_example` → `rootPath: /Users/example/home/paseo-decision-roadmap`, `kind: git`.
- `workspaces.json`, same `projectId`, unarchived: main `wks_example` (`kind: local_checkout`, `cwd` = registered root, `mainRepoRoot: null`) and this worker's `wks_example` (`kind: worktree`, `cwd: .../worktrees/2hz4viw4/feature-decision-roadmap`, `isPaseoOwnedWorktree: true`, **`mainRepoRoot: /Users/example/home/paseo-decision-roadmap`**).

**Conclusion:** both workspace kinds share `projectId`, and `projectId → projectRootPath` is the *uniform* lookup; `mainRepoRoot` is null for local checkouts, so it cannot be the primary key. This matches SPEC §5 exactly. CLI: `paseo workspace ls --json`, `paseo inspect`, `paseo project` exist; my CLI JSON probe returned no parseable output in this context, so treat **CLI field names as unverified** — the protocol/SDK schemas above are the contract.

**Recommendation:** `resolveStoreRoot` = hook/workspace `projectId` → `paseo.projects.list()` → `projectRootPath`; assert `manifest.projectId === projectId`; never trust `cwd`, client paths, or snapshot `projectRootPath` alone (SPEC's distrust of the client-cached snapshot is compatible with querying the daemon live).

## Contract 2 (Task 2.0): agent.create injection and existing-agent attach

**Injection (verified, excalidraw installed source):** `~/.paseo/plugins/excalidraw/a4348508-…/checkout/index.server.ts:37-52` — `server.before("agent.create", …)` returns `{ ...request, config: { ...request.config, mcpServers: { ...request.config.mcpServers, excalidraw: { type: "http", url: endpoint.urlFor(cwd) } } } }`, guarded by `providerSupportsMcp(config.provider)` and a no-double-inject check. `AgentSessionConfig.mcpServers?: Record<string, McpServerConfig>` — `@getpaseo/protocol/dist/agent-types.d.ts:466`. Provider allowlist (excalidraw `server/providers.ts`): `claude, codex, opencode, copilot`; comment states the daemon **refuses** creation when MCP servers are set for a provider without MCP support, and hooks cannot see capabilities — hence the hardcoded allowlist is mandatory.

**Port/restart constraints (excalidraw `server/mcp.ts:12-17`, `stateDirectory`):** secret+port persisted under `$PASEO_HOME/plugin-data/<plugin>/`; URL `/mcp/<base64url(cwd)>.<HMAC-SHA256(secret,cwd)>` verified with `timingSafeEqual`. On reload/restart "the port is reclaimed when it is free; otherwise a new random one is used" — i.e. on `EADDRINUSE` a new port is persisted and previously issued URLs die; already-created agents hold stale URLs. SPEC §8's fallback-and-report design matches the reference behaviour.

**Existing agents — documented limitation (public docs + installed types agree):**

- Public plugin reference (paseo.sh/docs/plugins/reference, Lifecycle hooks → Before hooks table): `agent.session_open` request = `{ agentId, workspaceId, provider, cwd, reason: create|resume|refresh|import, purpose, env }`, **"Editable: Only `env`"**. Runs on create, resume, refresh, import — but cannot touch `mcpServers`. Installed `PluginSessionOpenRequest` (lifecycle.d.ts:27-35) confirms: no config field.
- `UpdateAgentRequestMessageSchema` (`messages.d.ts:567`): `{ agentId, name?, labels? }` only — no protocol path to mutate an existing agent's MCP configuration. The Paseo `update_agent` MCP tool likewise exposes name/labels/runtime settings only.
- Hook failure semantics (public docs): 30 s timeout; a throwing before-hook **fails the pending operation** — injection must fail-open (`return undefined`), exactly as excalidraw does.

**Conclusion (Q2 evidence):** in 0.12.0 there is **no supported attach/reconnect path** to add MCP servers to an existing agent; `agent.session_open` is env-only and "refresh" reopens the saved configuration. The documented workflow stands: initialise `.decisions/`, then create the agent. Record Task 2.0 as "limitation confirmed", keep injection scoped to `agent.create` on opted-in projects (provider allowlist), and report pre-existing agents as needing recreation.

## Contract 3 (Task 4.0): SnailOrbit transport

**Public official evidence:** PyPI `snail-orbit-client` 0.13.2 (Snail Orbit Team, dev@snorbit.app) — REST API at `base_url`, auth = API token **or** JWT service credentials `(key-id, secret, user-id)`. Operations: `auth.get_profile`; `issues.list(q='priority:high and status:open' | search='text')`, `issues.get`, `issues.get_by_readable_id('PRJ-123')`, `issues.create`, `issues.update`; comments/tags/attachments CRUD; `projects.list(filter='created_at___gte:…')`. Errors: `AuthenticationError`, `NotFoundError`, `ValidationError(validation_errors)`, `RateLimitError(retry_after)`. No public MCP documentation for Snail Orbit found.

**Coordinator-confirmed live MCP tools:** `create_issue`, `get_issue`, `list_issues` (query DSL/text), `update_issue` (subject/text/custom fields), `get_field_options`, `get_project`, `link_issues`, `get_search_syntax_guide`. This covers create / get / search / state-update (state via `update_issue` custom field; allowed values via `get_field_options`). **No idempotency-key or at-most-once semantics in tool schemas/descriptions** — unknown at the API level too (PyPI docs show none).

**Transport decision:** MCP integration *is* supported (a working SnailOrbit MCP server exists in the owner's environment). However, embedding it means the plugin server must run its own MCP *client* against the owner's endpoint with owner credentials — a new authentication path the plugin cannot self-provision, and the brief forbids performing auth. REST would be invention beyond the verified contract and needs the same token.

**Smallest implementation option:** ship the dry-run adapter (SPEC default `mode: "dry-run"`); add a thin streamable-HTTP MCP client in `server/tracker/snailorbit.ts` (same JSON-RPC shape as excalidraw's server, inverted — no new npm dependency needed) bound to an owner-supplied endpoint URL + token passed to the plugin at enable time (owner action; never stored in host-scope settings). Live remote writes stay behind the owner publication gate.

**Idempotency without server support:** rely on local `TrackerIntent` + `TicketMapping` exactly as SPEC §7 — persist the intent *before* the remote call; on `unknown` outcome, reconcile by `list_issues` query for the embedded local intent/ULID marker (plus `get_issue` on candidate) before any re-create. No blind duplicates using only confirmed tools.

## Concrete unknowns

1. Whether the SnailOrbit server natively serves MCP or the coordinator's tools come from a separate bridge; exact endpoint/auth shape is owner config (not read per brief).
2. Exact `create_issue`/`update_issue` payload field names — take from the coordinator's live tool schemas, not the PyPI client model names.
3. CLI (`paseo workspace ls --json`) output fields unverified here; protocol/SDK types are authoritative.
4. `projectRootPath` behaviour for `directory`-kind projects untested (our project is `git`).

## Recommendations (aligned with settled owner choices)

- **Task 0.0:** `projectId → paseo.projects.list() → projectRootPath` as sole storeRoot resolution; cache per projectId; reject on `manifest.projectId` mismatch.
- **Task 2.0:** record limitation confirmed; injection only in `agent.create` for roadmap-enabled projects with the provider allowlist; persist port+secret under `plugin-data/decision-roadmap/` with `EADDRINUSE` fallback; fail-open hooks.
- **Task 4.0:** dry-run first; MCP client transport when the owner supplies endpoint+credential; idempotency via durable intents + search-before-create reconcile.
