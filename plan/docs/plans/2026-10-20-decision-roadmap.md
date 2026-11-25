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
| 5 | Timeline cards, `/roadmap` slash command, OVERVIEW.md | tsc, RN audit, UI check | Kimi; KensAI on final revision |

Each stage ends installable and usable on its own. Stages 0–3 are the smallest coherent product
(interview + roadmap + chat convergence + approval). Stage 4 and 5 are additive.

Reporting rule: validation, review, installation and UI verification are reported as four
separate states with evidence (test output, review link or report, `paseo plugin logs`, screenshots
on desktop and compact viewport). The coordinator performs installation and UI verification; the
owner is asked only for decisions, `mode: "live"` and tracker batch confirmations.

---

## Stage 0: scaffold, shared model, store core

### Task 0.0: Evidence: store root across worktrees (read-only, bounded)

Owner decision: one canonical roadmap per Paseo project shared by all worktrees. Verify with the
installed daemon, read-only via the `paseo` CLI or SDK, how a project's registered identity and
root directory are exposed (`projectId`, project record, `projectRootPath`, `directory`) for a
main checkout workspace and a linked worktree workspace of the same project, and for an agent
created in the worktree. Record actual observed values in
`docs/research/2026-10-20-store-root-evidence.md`. `resolveStoreRoot` (Task 0.3) must derive the
root from the registered project identity as observed, not from the worktree `cwd` or an
assumption about `projectRootPath`.

### Task 0.1: Plugin scaffold in a worktree

**Files:** create `paseo-plugin.json`, `package.json`, `tsconfig.json`, `index.client.tsx`,
`index.server.ts`, `OVERVIEW.md` stub, `vitest.config.mts`.

- [ ] Create worktree `feature/plugin-scaffold`; run `paseo plugin init <abs path>` into a temp
      dir and copy the generated layout, adjusting `id: "decision-roadmap"` and
      `requirements.paseo: ">=0.12.0"`.
- [ ] `npm install` with `@getpaseo/plugin@0.12.0`, `zod`, `@tanstack/react-query`, `react`,
      `react-native`, `typescript`, `vitest`, `@types/node` at the versions the installed SDK
      expects (check `/opt/homebrew/lib/node_modules/@getpaseo/cli/node_modules/@getpaseo/plugin/package.json` peer ranges). Use the existing configured npm registry without changing global or project registry settings.
      Report a missing package/version; do not automatically publish or reconfigure infrastructure.
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

- [ ] Tests first, from the fixture: activation on/off when the parent option changes
      (A→B→A branch switching restores stored validity, not a cached status); answers of an
      inactive question are preserved; invalidation that reaches an inactive question is
      recorded and visible on reactivation; a stale or inactive activation parent deactivates
      its children; stale propagates only along `invalidatedBy`; cross-session invalidation;
      unresolved refs rejected; mixed activation/invalidation cycles rejected; confirm clears
      stale; removing the answered option marks the question stale; `layoutDepth` is the
      longest path on the combined DAG; `planHash` is stable across key order and changes when
      tasks, `basedOn` or the decision snapshot change.
- [ ] Implement; tests green; commit.

### Task 0.3: Store core

**Files:** create `server/store.ts`, `server/store-root.ts`, `server/store.test.ts`.

Interface:

```ts
openStore(storeRoot): Store
Store.read(): Promise<RoadmapSnapshot | { status: "invalid", error }>   // validates on reload
Store.transact(expectedRevision, fn: (draft) => T): Promise<T>  // mutex; writes a full new generation, then atomically replaces manifest.json; revision++
Store.revision: number                                           // durable change token from the manifest
resolveStoreRoot(paseo, { workspaceId } | { agentId } | { projectId }): Promise<string>   // registered project identity, per SPEC §5 and Task 0.0
assertKnownStoreRoot(paseo, storeRoot): Promise<void>         // rejects paths outside Paseo workspaces
```

- [ ] Tests: init creates manifest, `projectId` and generation 1; concurrent `transact` calls
      serialize; `expectedRevision` behind the store yields `revision_conflict` and no write;
      interruption after writing generation files but before the manifest rename leaves the
      previous generation current (injected fs); interruption mid-generation never produces a
      half-read; external valid change is reloaded; a malformed generation yields `invalid`
      without reset; old generations are pruned keeping two; unknown storeRoot is rejected;
      simultaneous chat and UI answers to the same question produce exactly one winner and one
      conflict.
- [ ] Implement; commit.

**Stage 0 acceptance:** `npm test` and `tsc --noEmit` green; no client code yet; Kimi review of
the diff; no installation.

---

## Stage 1: Roadmap panel

### Task 1.1: RPC contracts and handlers for sessions

**Files:** create `shared/rpc.ts`, `server/sessions.ts`, `server/handlers.ts`, `server/sessions.test.ts`;
modify `index.server.ts`.

- [ ] Contracts from SPEC §7 for `roadmap.*`, `session.*`, `question.*` (including
      `question.update`), `relation.*`, `link.*`, each mutation with `expectedRevision`.
- [ ] Handler tests through the store on a temp dir: answering from `source: "ui"` creates
      revision 1, re-answering creates revision 2 and reports `staleMarked`; `question.confirm`
      on a non-stale question is a no-op error; `relation.add` reports `staleMarked` and
      `visibilityChanged` and rejects cycles; `question.update` bumps `definitionRev`;
      `link.create` never changes any status; a stale `expectedRevision` is rejected.
- [ ] Wire `server.handle` for each contract; commit.

### Task 1.2: Panel shell, overview and polling

**Files:** create `client/panel.tsx`, `client/hooks.ts`; modify `index.client.tsx`.

- [ ] `addWorkspacePanel({ id: "roadmap", context: "workspace", locations: ["workspace","explorer"] })`
      and a Command Center item that opens it.
- [ ] `useStoreRoot(workspaceId)` selects `{ projectId }` via `useWorkspace`; RPC inputs
      carry `projectId` and the server resolves and validates the canonical root (Task 0.0).
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
      revision history (rev, value, source, actor, time), an "Edit" section for title, context
      and options, and a "Relations" section to add or remove activation and invalidation edges
      (picker over questions of this and linked sessions). Mutations send `expectedRevision`,
      invalidate queries, show a toast with the number of newly stale questions, and show a
      "changed elsewhere, reloaded" toast on `revision_conflict`.
- [ ] Commit.

**Stage 1 acceptance:** tsc, RN audit grep clean, vitest green; Kimi review; coordinator installs
the worktree with `paseo plugin install`, confirms `paseo plugin logs decision-roadmap` is clean,
and verifies on desktop and a compact viewport: create session, add two questions where the
second is activated by option B of the first, answer A (second inactive), change to B (second
active), add an invalidation edge, change again (second stale), confirm (clear). Screenshots
attached to the report.

---

## Stage 2: MCP bridge

### Task 2.0: Evidence: onboarding existing agents (read-only, bounded)

Verify against the installed daemon and the plugin reference which supported path, if any,
attaches an MCP server to an already-created agent (candidates: `agent.session_open` hook scope,
`update_agent`/SDK configuration update, provider reload). Record the result and the exact
supported workflow or documented limitation in `docs/research/2026-10-20-mcp-attach-evidence.md`.
Task 2.1 implements whichever path is supported; the OVERVIEW documents the limitation otherwise.

### Task 2.1: In-process MCP endpoint and injection hook

**Files:** create `server/mcp.ts`, `server/providers.ts`, `server/mcp.test.ts`; modify `index.server.ts`.

- [ ] Endpoint on `127.0.0.1`, persisted `{port, secret}` under
      `$PASEO_HOME/plugin-data/decision-roadmap/mcp.json`, signed per-storeRoot path. Tests: a
      forged key is rejected; the same storeRoot yields the same URL across endpoint restarts
      when the state file exists; `EADDRINUSE` on the persisted port falls back to a fresh port,
      persists it and logs the agents that hold stale URLs; a URL for project A cannot write
      project B.
- [ ] `server.before("agent.create")`: skip when provider lacks MCP support, when
      `mcpServers["decision-roadmap"]` already exists, or when the project resolved from the
      request has no enabled roadmap (owner decision Q2). Return the request with the added
      `http` MCP server. Test: an agent in a project without a store gets no injection.
- [ ] Commit.

### Task 2.2: Tools

**Files:** create `server/mcp-tools.ts`, `server/mcp-tools.test.ts`.

- [ ] Tools from SPEC §8, each delegating to the same `sessions.ts`/`plans.ts` commands the RPCs
      use, plus `roadmap_create_session`, `roadmap_relate`, `roadmap_update_question`.
      `roadmap_answer` requires `quoted` text and records `source: "chat"`,
      `actor: { kind: "agent", agentId }` where `agentId` is attribution only, taken from the
      hook's URL-to-agent registry when the URL is per-agent, otherwise from the tool argument.
      No identity header is assumed. Every tool carries `expectedRevision`.
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

- [ ] `plan.draft` creates revision N with `contentHash` over markdown, task definitions,
      `basedOn` (answerRev, definitionRev, validity) and `decisionSnapshotHash`; rejects
      unanswered, stale or inactive inputs with their ids; writes `plans/<id>.md` (header has
      plan id, rev, hash).
- [ ] `plan.approve` succeeds only when `rev` is the latest and `contentHash` matches; writes
      the receipt under plugin-data keyed by `projectId`/`planId`/`rev` and appends a copy to
      `plan.approvals`. `approvalCurrent` recomputes hashes from the current store and requires
      every `basedOn` question active, valid and unchanged in answerRev and definitionRev.
- [ ] Tests: mismatch error; approval survives later answer change but `approvalCurrent` flips;
      stale upstream without a new answer revision flips it; a definition edit flips it; a task
      edit produces a new revision needing new approval; a receipt copied into project JSON
      without a plugin-data receipt is `unverified`; a receipt for another `projectId` is
      ignored; receipts survive a simulated plugin restart; approvals history keeps successive
      receipts; MCP has no approve tool (test asserts the tool list).
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

- [ ] `tracker.preview` builds actions only when `approvalCurrent` is true: `create` for
      approved task definitions without a mapping or pending/unknown intent, `close` for tasks
      `verified` with an open ticket, `skip` with reason otherwise. Returns action ids and a
      `confirmToken` bound to payloads, destination, mode, receipt id and store revision.
- [ ] `tracker.apply`: persists a `TrackerIntent` (`pending`, exact payload, destination,
      receiptId) in a store transaction before any remote call; marks `sent`; on confirmed
      response writes the `TicketMapping` and `confirmed`. On timeout or ambiguous result the
      intent becomes `unknown` and is never retried automatically; `tracker.reconcile` looks up
      by idempotency key only if Task 4.0 verified an idempotency guarantee, otherwise it
      reports `unknown` for a human decision. Close and comment intents follow the same states.
- [ ] Tests with a fake adapter: timeout leaves `unknown` and a second apply creates nothing;
      reconcile confirms when a verified lookup finds the issue; stale or drifted
      `confirmToken` rejected; `approvalCurrent` false blocks preview; dry-run performs no
      adapter writes; a restart with a `pending` intent surfaces it instead of re-sending.
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
- [ ] `/roadmap` slash command opens the panel; `OVERVIEW.md` documents install, tools,
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

## Reapproval note

Draft 3 records the owner's answers to Q1 and Q2 (one canonical project roadmap resolved through
registered Paseo project identity; MCP injection only for projects with an enabled roadmap). No
new scope. Baselines of draft 2 are under `docs/plans/baselines/`; the delta is
`docs/plans/2026-10-20-delta-draft3.md`.

Draft 2 incorporated the advisor disposition in
`docs/plans/2026-10-20-advisor-disposition.md`; the previous draft is kept under
`docs/plans/baselines/` and the owner-facing delta is `docs/plans/2026-10-20-delta-draft2.md`.
Tracker delivery (Stage 4) remains inside overall completion; the plan is not complete without it.

## Out of scope for this plan

Multiple trackers, cross-daemon synchronisation, editing the Markdown plan by hand, importing
Firstmate data, automatic execution of approved tasks, any daemon restart.
