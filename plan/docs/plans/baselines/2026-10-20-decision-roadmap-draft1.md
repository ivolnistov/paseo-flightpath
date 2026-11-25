# Decision Roadmap Plugin Implementation Plan

> **For agentic workers:** implement this plan stage-by-stage, a fresh agent per task, reviewing
> between tasks. Steps use checkbox (`- [ ]`) syntax for tracking. Detailed per-task cards (exact
> code, test bodies) are authored by the Opus implementer role from this plan after design review.

**Goal:** A trusted local Paseo plugin that runs branching decision interviews with a visual
roadmap, lets UI and chat answer into one durable local history, binds approval to a plan
revision, and mirrors approved tasks to SnailOrbit behind an owner-confirmed gate.

**Architecture:** One plugin server process owns `<storeRoot>/.decisions/` and serves it to the
Paseo UI through plugin RPCs and to agents through an in-process HTTP MCP endpoint injected by the
`agent.create` hook. The client is a React Native workspace panel (overview, roadmap, question
card, plan). A tracker adapter interface with a dry-run default mirrors approved tasks.

**Tech Stack:** TypeScript, `@getpaseo/plugin` 0.12.0, Zod, TanStack Query, React Native
primitives, `@modelcontextprotocol/sdk` (server only), vitest, esbuild/tsc.

**Spec:** `docs/SPEC.md`

## Global Constraints

- `paseo-plugin.json` `requirements.paseo` is `">=0.12.0"`; verify against the installed daemon.
- Client code: React Native primitives only, colors from `theme.colors`, `layout.compact`
  handled, no DOM, no `className`, no React Flow, no client-only npm packages beyond
  `@tanstack/react-query` and `zod`. The audit grep from the paseo-plugin skill must return
  nothing outside `client/web.ts` (which should not exist in this plugin).
- Server code may use Node and plugin-local dependencies; shared code imports neither Node nor
  React Native.
- Local JSON store is canonical; the Markdown plan file is derived and never parsed back.
- Approval is written only by `plan.approve` from the UI with `{ planId, rev, contentHash }`.
  No MCP tool and no file content can approve.
- Tracker remote writes are off (`mode: "dry-run"`) by default and require preview confirmation.
- Never commit secrets, transcripts, real tracker records; fixtures are synthetic.
- Production code lives in an isolated worktree of this repository; docs stay in main.
- Never restart the daemon; install and reload with `paseo plugin install` / `paseo plugin reload`.
- Three relation kinds stay distinct: conditional activation, dependency invalidation, descriptive
  links (SPEC §6).

---

## Stage overview and delivery boundaries

| Stage | Deliverable | Validation gate | Review gate |
| --- | --- | --- | --- |
| 0 | Plugin scaffold, shared model, store core, graph rules | vitest green, tsc clean | Kimi diff review |
| 1 | Roadmap panel: overview, session roadmap, question card, answering, revisions, stale | tsc, RN audit, vitest | Kimi; install + UI check by coordinator |
| 2 | MCP bridge: endpoint, injection hook, tools | vitest incl. MCP in-process tests | Kimi; live agent check by coordinator |
| 3 | Plans: revisions, hash, Markdown export, approval, invalidation | vitest, UI check | Kimi |
| 4 | Tracker: evidence task, adapter, SnailOrbit impl, preview/apply, close after verified | vitest with fake adapter; dry-run UI check | Kimi; KensAI on final revision |
| 5 | Timeline cards, `/roadmap` slash command, docs/OVERVIEW.md | tsc, RN audit, UI check | Kimi; KensAI on final revision |

Each stage ends installable and usable on its own. Stages 0–3 are the smallest coherent product
(interview + roadmap + chat convergence + approval). Stage 4 and 5 are additive.

Reporting rule: validation, review, installation and UI verification are reported as four
separate states with evidence (test output, review link or report, `paseo plugin logs`, screenshots
on desktop and compact viewport). The coordinator performs installation and UI verification; the
owner is asked only for decisions, `mode: "live"` and tracker batch confirmations.

---

## Stage 0: scaffold, shared model, store core

### Task 0.1: Plugin scaffold in a worktree

**Files:** create `paseo-plugin.json`, `package.json`, `tsconfig.json`, `index.client.tsx`,
`index.server.ts`, `docs/OVERVIEW.md` stub, `vitest.config.mts`.

- [ ] Create worktree `feature/plugin-scaffold`; run `paseo plugin init <abs path>` into a temp
      dir and copy the generated layout, adjusting `id: "decision-roadmap"` and
      `requirements.paseo: ">=0.12.0"`.
- [ ] `npm install` with `@getpaseo/plugin@0.12.0`, `zod`, `@tanstack/react-query`, `react`,
      `react-native`, `typescript`, `vitest`, `@types/node` at the versions the installed SDK
      expects (check `/opt/homebrew/lib/node_modules/@getpaseo/cli/node_modules/@getpaseo/plugin/package.json` peer ranges). Resolve packages through the configured Nexus registry; a missing
      package goes through the npm-audit upload, never a registry change.
- [ ] Entries register nothing yet and return cleanup. `tsc --noEmit` passes; `vitest` runs an
      empty suite.
- [ ] Commit.

### Task 0.2: Shared model and graph rules

**Files:** create `shared/model.ts`, `shared/graph.ts`, `shared/plan-hash.ts`,
`server/graph.test.ts`, `server/plan-hash.test.ts`, `server/fixtures/session-branching.json`.

Interfaces: Zod schemas exactly as SPEC §6. `graph.ts` exports pure functions:

```ts
computeActivation(session, external: (ref) => Answer | undefined): Map<questionId, boolean>
invalidationClosure(sessions, start: Ref): Ref[]            // transitive downstream over invalidatedBy
applyAnswer(sessions, ref, answer): { sessions, staleMarked: Ref[], deactivated: Ref[], reactivated: Ref[] }
layoutDepth(session): Map<questionId, number>
```

- [ ] Tests first, from the fixture: activation on/off when the parent option changes; answers of
      an inactive question are preserved; stale propagates only along `invalidatedBy` (a child
      with activation only is not stale); cross-session invalidation; confirm clears stale;
      `layoutDepth` is the longest path from a root; `planHash` is stable across key order.
- [ ] Implement; tests green; commit.

### Task 0.3: Store core

**Files:** create `server/store.ts`, `server/store-root.ts`, `server/store.test.ts`.

Interface:

```ts
openStore(storeRoot): Store
Store.read(): Promise<RoadmapSnapshot>              // reloads when any file mtime changed
Store.transact(fn: (draft) => T): Promise<T>        // mutex, atomic temp+rename writes, revision++
Store.revision: number
resolveStoreRoot(paseo, workspaceId | cwd): Promise<string>   // per SPEC §5 and owner choice Q1
assertKnownStoreRoot(paseo, storeRoot): Promise<void>         // rejects paths outside Paseo workspaces
```

- [ ] Tests: init creates `roadmap.json`; concurrent `transact` calls serialize; crash between
      temp write and rename leaves the old file intact (simulate with injected fs); external
      modification is picked up on next read; unknown storeRoot is rejected.
- [ ] Implement; commit.

**Stage 0 acceptance:** `npm test` and `tsc --noEmit` green; no client code yet; Kimi review of
the diff; no installation.

---

## Stage 1: Roadmap panel

### Task 1.1: RPC contracts and handlers for sessions

**Files:** create `shared/rpc.ts`, `server/sessions.ts`, `server/handlers.ts`, `server/sessions.test.ts`;
modify `index.server.ts`.

- [ ] Contracts from SPEC §7 for `roadmap.*`, `session.*`, `question.*`, `link.*`.
- [ ] Handler tests through the store on a temp dir: answering from `source: "ui"` creates
      revision 1, re-answering creates revision 2 and reports `staleMarked`; `question.confirm`
      on a non-stale question is a no-op error; `link.create` never changes any status.
- [ ] Wire `server.handle` for each contract; commit.

### Task 1.2: Panel shell, overview and polling

**Files:** create `client/panel.tsx`, `client/hooks.ts`; modify `index.client.tsx`.

- [ ] `addWorkspacePanel({ id: "roadmap", context: "workspace", locations: ["workspace","explorer"] })`
      and a Command Center item that opens it.
- [ ] `useStoreRoot(workspaceId)` selects `{ directory, projectRootPath, kind }` via
      `useWorkspace` and applies the Q1 rule client-side for the request only; the server
      re-validates.
- [ ] `useQuery(["roadmap","version",storeRoot], refetchInterval: 3000)`; when `revision`
      changes, invalidate `["roadmap", storeRoot]`.
- [ ] Overview list, "Initialise roadmap" action, "New session" action. Compact layout verified
      by rendering with `layout.compact = true` in a smoke test (react-test-renderer is not
      assumed; the smoke check is manual in the UI verification state).
- [ ] Commit.

### Task 1.3: Roadmap view and question card

**Files:** create `client/roadmap-view.tsx`, `client/question-card.tsx`.

- [ ] Roadmap view: columns by `depth` on wide layouts, single indented column on compact.
      Activation connectors labelled with the triggering option, invalidation connectors muted,
      descriptive links as a footer line. Inactive cards dimmed; stale cards carry a warning chip
      and the cause question title.
- [ ] Question card `Modal`: options as `Pressable` rows, recommended highlighted with a badge,
      free-text `TextInput` when allowed, Answer / Confirm / Skip, discussion list and composer,
      revision history (rev, value, source, actor, time). Mutations invalidate queries and show a
      toast with the number of newly stale questions.
- [ ] Commit.

**Stage 1 acceptance:** tsc, RN audit grep clean, vitest green; Kimi review; coordinator installs
the worktree with `paseo plugin install`, confirms `paseo plugin logs decision-roadmap` is clean,
and verifies on desktop and a compact viewport: create session, add two questions where the
second is activated by option B of the first, answer A (second inactive), change to B (second
active), add an invalidation edge, change again (second stale), confirm (clear). Screenshots
attached to the report.

---

## Stage 2: MCP bridge

### Task 2.1: In-process MCP endpoint and injection hook

**Files:** create `server/mcp.ts`, `server/providers.ts`, `server/mcp.test.ts`; modify `index.server.ts`.

- [ ] Endpoint on `127.0.0.1`, persisted `{port, secret}` under
      `$PASEO_HOME/plugin-data/decision-roadmap/mcp.json`, signed per-storeRoot path. Tests: a
      forged key is rejected; the same storeRoot yields the same URL across restarts of the
      endpoint when the state file exists.
- [ ] `server.before("agent.create")`: skip when provider lacks MCP support, when
      `mcpServers["decision-roadmap"]` already exists, or when the injection setting excludes the
      project (owner choice Q2). Return the request with the added `http` MCP server.
- [ ] Commit.

### Task 2.2: Tools

**Files:** create `server/mcp-tools.ts`, `server/mcp-tools.test.ts`.

- [ ] Tools from SPEC §8, each delegating to the same `sessions.ts`/`plans.ts` commands the RPCs
      use. `roadmap_answer` requires `quoted` text and records `source: "chat"`,
      `actor: { kind: "agent", agentId }` (agent id taken from the request header the daemon
      sets, or from a tool argument if absent; the test covers both).
- [ ] Tests exercise tools through the MCP SDK client in-process: ask, answer, stale propagation
      visible to a subsequent UI `session.get`.
- [ ] Commit.

**Stage 2 acceptance:** tests green; Kimi review; coordinator reloads the plugin, creates a new
Claude agent in a project with `.decisions/`, asks it to list the roadmap and answer a question
quoting the owner, then confirms the answer appears in the panel with `source: chat` and the
revision history intact.

---

## Stage 3: Plans and approval

### Task 3.1: Plan commands

**Files:** create `server/plans.ts`, `server/plans.test.ts`; modify `shared/rpc.ts`, `server/handlers.ts`, `server/mcp-tools.ts`.

- [ ] `plan.draft` creates revision N with `contentHash`, `basedOn` answer revisions of the
      sessions it names, and writes `plans/<id>.md` (header includes plan id, rev, hash).
- [ ] `plan.approve` succeeds only when `rev` is the latest and `contentHash` matches; records
      `Approval`. `approvalCurrent` is false once any `basedOn` question gets a newer revision.
- [ ] Tests: mismatch error; approval survives later answer change but `approvalCurrent` flips;
      a new revision after approval requires a new approval; MCP has no approve tool (test asserts
      the tool list).
- [ ] Commit.

### Task 3.2: Plan view

**Files:** create `client/plan-view.tsx`; modify `client/panel.tsx`.

- [ ] Revision list, Markdown as `Text` blocks, Approve button bound to the displayed revision
      and hash, `approvalCurrent` warning, task list with status controls (`verified` requires a
      note).
- [ ] Commit.

**Stage 3 acceptance:** tests green; Kimi review; coordinator UI check: draft from chat, approve
in UI, change an upstream answer, see the approval marked not current.

---

## Stage 4: Tracker

### Task 4.0: Evidence task (read-only, bounded)

Delegated research card, not code: verify the SnailOrbit public API contract for create, search by
marker, update state/close and get issue, and how credentials are configured for it on this host
without reading secret values. Output: a short note in `docs/research/snailorbit-api.md` with
sources, the chosen transport, and the credential handling to add to settings. No REST client is
written before this note exists and is accepted by the coordinator.

### Task 4.1: Adapter interface, dry-run adapter, sync with idempotent recovery

**Files:** create `server/tracker/adapter.ts`, `server/tracker/sync.ts`, `server/tracker/sync.test.ts`.

```ts
interface TrackerAdapter {
  findByIdempotencyKey(key): Promise<RemoteIssue | null>
  create(payload: CreatePayload): Promise<RemoteIssue>
  close(remoteId, comment): Promise<void>
  get(remoteId): Promise<RemoteIssue | null>
}
```

- [ ] `tracker.preview` builds actions only when `approvalCurrent` is true: `create` for tasks
      without a mapping, `close` for tasks with `status: verified` and an open ticket, `skip`
      with reason otherwise. Returns a `confirmToken` bound to the action set hash.
- [ ] `tracker.apply`: writes `state: "pending"` to the mapping before the remote call; on
      success writes `created`; on timeout or unknown result, calls `findByIdempotencyKey` before
      any retry and records `unknown` with the error when still ambiguous. Never creates twice.
- [ ] Tests with a fake adapter: duplicate protection after a simulated timeout; stale
      `confirmToken` rejected; dry-run mode performs no adapter writes.
- [ ] Commit.

### Task 4.2: SnailOrbit adapter and UI

**Files:** create `server/tracker/snailorbit.ts`, `server/tracker/snailorbit.test.ts`; modify
`client/plan-view.tsx`, `shared/settings.ts`.

- [ ] Implement the transport chosen in Task 4.0 against recorded synthetic fixtures. Settings
      gain the fields that note specifies; secrets are never stored in settings.
- [ ] Preview modal shows the exact payloads, destination and mode before Apply.
- [ ] Commit.

**Stage 4 acceptance:** tests green with fake adapter; Kimi review; coordinator dry-run UI check.
A live write happens only after the owner sets `mode: "live"` and confirms a batch; the coordinator
reports the exact created keys and the mapping file diff.

---

## Stage 5: Timeline cards and slash command

### Task 5.1: Timeline rows and renderer

**Files:** create `client/timeline-card.tsx`; modify `server/mcp-tools.ts`, `index.client.tsx`.

- [ ] `roadmap_ask` from an agent appends a plugin timeline row per question
      (`kind: "decision-question"`, `id: questionId`); `roadmap_answer` and UI answers re-append
      the same id with the answer. Renderer shows options, lets the user answer in place via the
      same RPC, respects `theme` and compact layout.
- [ ] `/roadmap` slash command opens the panel; `docs/OVERVIEW.md` documents install, tools,
      the three relation kinds and the approval rule.
- [ ] Commit.

**Stage 5 acceptance:** tsc, RN audit, tests; Kimi review; KensAI gate on the final revision of
the whole branch; coordinator UI check of the timeline card on desktop and compact.

---

## Acceptance tests (end-to-end, run by the coordinator after Stage 3 and again after Stage 5)

1. Fresh project: initialise store from the panel; `.decisions/roadmap.json` exists and is valid.
2. Chat agent creates a session with three questions: Q2 activated by Q1 option B, Q3 invalidated
   by Q1. Panel shows Q2 inactive and Q3 open.
3. Answer Q1 = A in UI; Q2 stays inactive; answer Q3 in chat quoting the owner; history shows
   `source: chat`.
4. Change Q1 to B in chat: Q2 becomes active, Q3 becomes stale with cause Q1 rev 2; confirm Q3
   in UI clears stale with rev 2 of Q3.
5. Draft plan from chat; approve rev 1 in UI; change Q3 in chat; plan reports approval not
   current; draft rev 2; approve rev 2 with its hash; approving with rev 1 hash fails.
6. Tracker preview in dry-run lists creates with exact payloads; apply performs no remote write.
7. All of the above on a compact viewport renders without clipped controls.

## Out of scope for this plan

Multiple trackers, cross-daemon synchronisation, editing the Markdown plan by hand, importing
Firstmate data, automatic execution of approved tasks, any daemon restart.
