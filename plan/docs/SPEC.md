# Decision Roadmap plugin: architecture specification

Status: draft 3, 2026-10-20, owner choices Q1 and Q2 recorded (section 12); draft 2 scope is
authorized with no new scope. Owner-approved direction is in README.md and AGENTS.md; this
document turns it into interfaces and boundaries. Implementation cards are in
`docs/plans/2026-10-20-decision-roadmap.md`.

## 1. Goal

A trusted local Paseo plugin that lets the owner run branching decision interviews ("grilling
sessions") for a project, see them as a visual roadmap inside Paseo, answer questions either in
the UI or in agent chat, keep every answer revision, mark dependent decisions stale when an
upstream answer changes, approve a specific plan revision, and mirror approved execution tasks
to an optional tracker (SnailOrbit first).

## 2. Verified platform constraints (Paseo 0.12.0, SDK `@getpaseo/plugin` 0.12.0)

Verified on 2026-10-20 against https://paseo.sh/docs/plugins/reference.md, the installed CLI
(`paseo --version` = 0.12.0, SDK package at
`/opt/homebrew/lib/node_modules/@getpaseo/cli/node_modules/@getpaseo/plugin`) and the locally
installed `excalidraw` plugin, which is a working precedent on this daemon.

- A plugin has a client entry (`index.client.tsx`, React Native primitives only, runs in desktop,
  web, iOS and Android apps) and a server entry (`index.server.ts`, Node subprocess inside the
  daemon). `shared/` holds Zod contracts only.
- Client to daemon communication is typed RPC (`defineRpc` + `server.handle` + `useRpc`). There is
  no push channel from server to client; live updates use TanStack Query polling with
  invalidation after mutations (the excalidraw plugin polls every 5 s).
- Server hooks: `server.before("agent.create")` can add `mcpServers` to a new agent's config. The
  daemon rejects MCP config for providers without MCP support, so injection is gated to known
  providers (`claude`, `codex`, `opencode`, `copilot`). `McpServerConfig` supports `stdio`, `http`
  and `sse`. Hooks only apply to newly created agents, not already-running ones.
- `server.on("agent.turn_started" | "agent.turn_ended")` deliver the host agent; `turn_ended`
  carries the agent's whole folded timeline (items have no turn id or sequence). Stage 5 uses a live
  `timeline.subscribe` during the turn and the `turn_ended` history as a catch-up scan
  (`docs/research/2026-10-22-stage5-host-contracts.md`).
- A server handler can append a plugin-owned timeline row (`timeline.append`; a re-append with the
  same `id` folds in place; 64 KiB data cap). In the installed 0.12.0 daemon an appended row is
  recorded through the durable timeline queue and restored when the agent is reloaded. Behaviour
  across a daemon restart, crash or hard kill (rows still queued) is not verified (evidence:
  `docs/research/2026-10-22-stage5-host-contracts.md` §6). A client `addTimelineRenderer` draws it.
- Workspace panel props give `workspaceId`; `useWorkspace(id, selector)` exposes `directory`,
  `projectRootPath`, `kind` (`directory | local_checkout | checkout | worktree`). Do not use RPC
  to discover the current workspace.
- UI: `theme.colors.*` for every color, `layout.compact` for narrow layouts, `Modal` (bottom sheet
  on compact), `FlatList`/`ScrollView` from `@getpaseo/plugin/client/react-native`, Lucide icons,
  `useToast`. No DOM, no `className`, no React Flow, no arbitrary client npm dependencies.
- Persisted host-scoped settings via `defineSettings` + `registerSettings` + `useSettings`; the
  docs state these are plain JSON and "not a credential vault".
- Plugin install from a host directory: `paseo plugin install /abs/path`; `paseo plugin reload`
  reloads it. No daemon restart is needed or allowed.
- Node dependencies installed in the plugin directory are available to the server runtime only.

## 3. Architecture in one paragraph

One plugin, `decision-roadmap`, with one owner of project data: the plugin server process. It
reads and writes a canonical JSON store inside the project (`<storeRoot>/.decisions/`), exposes it
to the Paseo UI through plugin RPCs, and exposes the same store to agents through an in-process
HTTP MCP server injected into new MCP-capable agents via the `agent.create` hook (the pattern the
installed excalidraw plugin already uses on this daemon). Because UI and chat both write through
the same process, the same command module and the same transactional store (§5), they share one
history; the writer boundary and conflict rules are explicit in §5. The UI is a workspace panel built from React Native primitives: a roadmap view
(cards laid out by dependency depth), a question card modal (options, recommendation, free text,
discussion, revision history), and a plan view (revisions, approval bound to a revision hash,
tasks and ticket state). A tracker adapter behind an interface mirrors approved tasks to
SnailOrbit with local mappings and idempotent recovery; remote writes are off by default and each
batch is shown as exact payloads for owner confirmation before sending. The SnailOrbit transport
is a plugin-owned MCP client whose connection comes only from the explicit Codex-native
`[mcp_servers.snailorbit]` entry with a `url` and nothing else; SnailOrbit's public API contract,
authentication and reachability remain unverified until a confirmed live batch is applied.

```
Paseo app (desktop/mobile/web)            Paseo daemon
┌──────────────────────────────┐          ┌─────────────────────────────────────────┐
│ Roadmap workspace panel      │  RPC     │ plugin server subprocess                │
│  overview / session / plan   │─────────▶│  rpc handlers ─┐                        │
│ question card Modal          │◀─────────│                ├─▶ store (JSON, atomic) │
│ timeline renderer (stage 5)  │          │  MCP http srv ─┘      │                 │
└──────────────────────────────┘          │     ▲                 ▼                 │
                                          │     │           <project>/.decisions/   │
   agent (claude/codex/…) ── MCP tools ───┼─────┘                                   │
                                          │  agent.create hook injects MCP URL      │
                                          │  tracker adapter → SnailOrbit (gated)   │
                                          └─────────────────────────────────────────┘
```

## 4. File structure (plugin package)

```
decision-roadmap/
  paseo-plugin.json          id "decision-roadmap", requirements.paseo ">=0.12.0"
  package.json               deps: @getpaseo/plugin, zod, @tanstack/react-query, @modelcontextprotocol/sdk (server only)
  tsconfig.json              no "DOM" lib
  index.client.tsx           registers panel, command center item, slash command, timeline renderer
  index.server.ts            registers settings, rpc handlers, MCP server, agent.create hook
  shared/
    model.ts                 Zod schemas for Session, Question, Option, Answer, Dependency, Link, Plan, Task, TicketMapping
    rpc.ts                   defineRpc contracts (section 7)
    settings.ts              defineSettings (section 9)
    graph.ts                 pure functions: visibility, dependency closure, stale propagation, layout depth
    plan-hash.ts             canonical JSON + sha256 content hash (pure, no Node imports)
  server/
    store.ts                 load/save per storeRoot, atomic write, mutex, revision counter, mtime reload
    store-root.ts            resolve + validate storeRoot against Paseo workspaces (no arbitrary paths)
    sessions.ts              session/question/answer/discussion commands (uses shared/graph)
    plans.ts                 plan revisions, Markdown export, approval, invalidation
    tracker/adapter.ts       TrackerAdapter interface (render + connect to a session)
    tracker/snailorbit.ts    SnailOrbit adapter: plugin-owned MCP client on the Codex url-only connection
    tracker/sync.ts          intent records, idempotent create, close after verified
    mcp.ts                   in-process HTTP MCP endpoint, signed per-storeRoot URLs
    mcp-tools.ts             tool definitions mapping to sessions/plans commands
    providers.ts             providerSupportsMcp
    handlers.ts              RPC handler wiring
    *.test.ts                vitest, synthetic fixtures under server/fixtures/
  client/
    panel.tsx                workspace panel: a screen stack (overview, roadmap, feature, plan, session), polling
    grilling-blocks.tsx      session canvas: notices, blocks navigator, block canvas, proposal canvas
    question-canvas-card.tsx one question card: recorded answer, Edit, disclosures, relations, More
    add-question-form.tsx    add a question (optional first free-text answer) to the open block
    chat-menu.tsx            the session header's Chat menu and the Finish confirmation
    discussion-ui.tsx        small controls, focus helpers (moveFocus, FocusScope)
    relation-links.ts        a card's relation links with kind, direction and target (pure)
    grilling-header.ts       status line, actions, Retry wording, closure line, empty-block line (pure)
    stage-strip.ts           four-stage strip model (pure); stage-strip-view.tsx renders it
    map-layout.ts            the Map's lanes, nodes, columns and orthogonal edge routes (pure)
    map-view.tsx             the Map: scaled world, zoom, detail, List, Find question
    host-tab.ts              optional host per-tab state for the screen stack (host-version-specific)
    question-card.tsx        question body and modal (timeline card, hidden questions)
    plan-view.tsx            revisions, approval, tasks, ticket actions and confirmation modal
    timeline-card.tsx        renderer for plugin timeline rows (stage 5)
    hooks.ts                 useStoreRoot(workspaceId), useRoadmapQuery, mutations
  docs/OVERVIEW.md           user-facing usage
```

Firstmate is reference only; nothing is copied. Grillboard and better-grill inform the question
card behaviour (discussion, revisable answers, recommendation), not the code.

## 5. Store location and format

- Owner decision (Q1): one canonical roadmap per Paseo project, shared across all worktrees.
  `storeRoot` is resolved from the registered Paseo project identity: the server takes the
  workspace or agent, reads its `projectId` from the Paseo SDK, and uses that project's
  registered root directory as `storeRoot`. The worktree `cwd`, the client-supplied path and the
  `projectRootPath` snapshot field are never trusted as the root by themselves; Task 0.0 verifies
  what the SDK actually exposes for a project's root and fixes the exact lookup. The store
  directory is `<storeRoot>/.decisions/` and is meant to be committed in the main checkout;
  worktrees read and write the same directory through the plugin server.
- Layout (snapshot generations with one atomically replaced manifest):
  - `.decisions/manifest.json`: `{ version: 1, projectId, revision: number, generation: string, changeToken: string }`.
  - `.decisions/generations/<generation>/roadmap.json`, `sessions/<sessionId>.json`,
    `plans/<planId>.json`: immutable files of that generation. A transaction writes the new
    generation directory completely, fsyncs, then renames a temp manifest over
    `manifest.json`. Older generations are pruned after the manifest points past them (keep the
    last two). Interruption at any point leaves the previous manifest and generation intact.
  - `.decisions/plans/<planId>.md`: generated, read-only Markdown of the latest revision with the
    revision id and content hash in its header. Derived, never parsed back.
- Writer boundary: the plugin server process is the only supported writer. External edits
  (git checkout, editors) are detected by manifest `changeToken`/mtime and reloaded only after
  schema validation; a malformed or partially merged generation puts the store into a read-only
  `invalid` state surfaced in the UI and MCP with the validation error, never a silent reset.
- Every mutation carries `expectedRevision`; the server rejects it with
  `revision_conflict` when the store revision moved, so a stale UI or agent cannot overwrite a
  newer answer. Clients refetch and retry explicitly. One async mutex per storeRoot serializes
  transactions inside the process; the manifest `revision` is the durable change token the
  client polls.
- IDs are ULIDs. Timestamps are ISO-8601 UTC strings.

### Schema version 2 (redesign Stage R0)

- `roadmap.json` carries `version: 1` (legacy) or `version: 2`; `manifest.json` stays `version: 1`.
  A legacy generation is read with the strict v1 schemas, its `changeToken` is verified over the
  raw v1 objects, and it is then projected in memory into the v2 view (`server/legacy-projection.ts`)
  without any write. Reading never migrates.
- Every commit writes a v2 generation: `roadmap.json` with `featureIds`, `runIds` and
  `settings`, plus `features/<id>.json`, `runs/<id>.json` and a required `delegations.json`, next to
  `sessions/` and `plans/`. Legacy session and plan objects are written with the same canonical
  bytes, so their revision hashes and approval receipts stay valid. The v2 `changeToken` covers all
  collections. A plugin built before R0 rejects a v2 `roadmap.json` as invalid instead of misreading
  it.
- No run or delegation record is written by any R0 path (runs and delegations are written by the
  Stage R3–R4 paths in §7).

## 6. Domain model (shared/model.ts)

```ts
Option      { id, label, description? }
Answer      { rev: number, optionId?: string, text?: string, source: "ui" | "chat",
              actor: { kind: "human" | "agent", agentId?: string }, at, note?: string,
              quoted?: string /* human chat text an agent relayed */,
              defaulted?: true /* a UI answer that is the preselected recommended option, unchanged */ }
Ref         { sessionId: string, questionId: string }
Activation  { parent: Ref, optionIds: string[] }          // conditional branch: active only when parent's current answer is one of optionIds
Invalidation{ upstream: Ref }                              // dependency: a value change upstream, or the upstream going out of scope, marks this question stale
Question    { id, order, number? /* stable per session; absent on questions written before numbering,
              read as order + 1 and stored on the next write */, tag?: "language",
              title, context, options: Option[], recommendedOptionId?, allowFreeText: boolean,
              definitionRev: number /* bumps on title/context/options edits */,
              activatedBy: Activation[], invalidatedBy: Invalidation[],
              answer?: Answer /* current */, revisions: Answer[], discussion: Note[],
              validity: "unanswered" | "valid" | "stale" | "skipped" | "out_of_scope"   /* stored */,
              stale?: { causeSessionId, causeQuestionId, causeRev?, causeKind?: "out_of_scope", causeMarkId?, at }
                /* exactly one of causeRev (an upstream answer revision) and causeKind (the upstream went out of scope) */,
              review?: /* same shape as stale: on an answered skipped or out-of-scope question whose upstream changed */ }
              // visibility ("active" | "inactive") is computed, never stored; the UI status chip is
              // derived from (visibility, validity): inactive questions show their stored validity dimmed.
Note        { id, at, actor, text }
Session     { id, title, createdAt, status: "active" | "closed", questions: Question[] }
Link        { id, kind: "informs" | "supersedes", from: Ref | { sessionId }, to: Ref | { sessionId }, note? }  // descriptive only, no propagation
PlanRevision{ rev, createdAt, contentHash, markdown, tasks: TaskDefinition[],
              basedOn: { sessionId, questionId, answerRev, definitionRev, validity }[],
              decisionSnapshotHash }
              // contentHash = sha256(canonical JSON of { markdown, tasks, basedOn, decisionSnapshotHash })
TaskDefinition { id, title, description }                  // immutable inside its revision
TaskState   { taskId, planRev, status: "todo" | "in_progress" | "done" | "verified", verification?: { at, note } }
            // stored lazily: a task without a row is "todo" until its first task.update.
            // This four-value shape is TaskStateV1 (strict, used by the v1 PlanV1); the v2 TaskState
            // adds "cancelled" (Stage R2, §7).
ApprovalReceipt { receiptId, projectId, planId, planRev, contentHash, decisionSnapshotHash, at,
                  actor: { kind: "human", hostClientId? }, note? }   // stored outside the project, see below
TrackerIntent { intentId, planId, taskId, planRev, receiptId, kind: "create" | "close" | "comment",
                payload, destination, mode, state: "pending" | "sent" | "confirmed" | "unknown" | "failed",
                createdAt, lastAttemptAt, error? }
TicketMapping { provider: "snailorbit", remoteId, remoteKey, url, idempotencyKey, intentId, state: "created" | "closed", lastSyncAt }
Plan        { id, title, sessionIds: string[], revisions: PlanRevision[], approvals: ApprovalReceipt[] /* history, copies */,
              taskStates: TaskState[], intents: TrackerIntent[], tickets: TicketMapping[] }
```

Rules (implemented in `shared/graph.ts` and `server/sessions.ts`, all unit tested):

Three relation kinds are kept distinct in data, in propagation and in the UI:

- Conditional activation (`activatedBy`): a question is `inactive` unless every activation
  parent is itself active, has `validity: "valid"` and a current answer whose `optionId` is in
  `optionIds`. Visibility is recomputed on every read; it is never stored. A question that
  becomes inactive keeps its answers, revisions and stored validity; invalidation that reaches
  it while inactive is still recorded, so reactivation reveals accumulated staleness rather
  than an obsolete status. Inactive questions are excluded from open counts and drawn dimmed.
- Dependency invalidation (`invalidatedBy`): when a question's current answer changes value
  (different `optionId` or text), or the question is marked out of scope, every transitive
  downstream question reachable through `invalidatedBy` edges that has an answer becomes `stale`
  with the cause recorded; one that is skipped or out of scope keeps that outcome and gets a
  `review` marker with the same cause instead. Activation
  edges do not propagate stale marks by themselves; a parent whose change should also
  invalidate a child carries both edge kinds (the authoring commands accept both).
- Descriptive links (`Link`, `informs` / `supersedes`, question- or session-level, including
  cross-session): shown on cards and in the overview, never propagate anything.
- Graph rules: every `Ref` must resolve at write time (cross-session refs validated against the
  same store); unresolved refs are rejected. Adding an activation or invalidation edge that
  creates a cycle in the combined activation+invalidation DAG is rejected
  (`relation_cycle`). `layoutDepth` runs on that combined DAG. Editing a question's
  definition (title, context, options) bumps `definitionRev`; removing an option that the
  current answer uses (or turning off free text for a text answer) marks the question `stale`
  with itself as cause. Only a current answer (`valid` or `stale`) goes stale this way: a skipped or
  out-of-scope question keeps its outcome, history and review marker.

- Answering appends a new `Answer` revision; `answer` points at the latest. Revisions are never
  deleted. Changing an answer from the UI or chat is the same command.
- A `confirm` command on a stale question records a new revision with the same value and clears
  `stale`.
- Draft eligibility: a plan revision may be based only on questions that are active and
  `valid` (or explicitly `skipped`, listed as such in the Markdown). Unanswered, stale or
  inactive questions in the named sessions are rejected with their ids. Explicitly cancelled
  decisions are excluded from a new basis (they keep their visibility and validity).
- Approval currency (`approvalCurrent`) is true only when a receipt exists for the latest
  revision, its `contentHash` and `decisionSnapshotHash` match a recomputation from the current
  store, and every `basedOn` question is still active, `valid`, at the same `answerRev` and
  `definitionRev`, and no `basedOn` decision has been cancelled. Any stale mark, deactivation,
  re-answer, definition edit, task change or cancellation of a basis decision makes it false (the
  reason is `<ref> was cancelled`); a new revision and a new approval are then required. Task execution status and tracker actions reference `{ planRev, taskId }` of the
  approved revision, never a mutable description. Currency is rechecked at execution start and
  in `tracker.preview`/`tracker.apply`.
- Approval receipts are server-owned: `plan.approve` (UI only, `{ planId, rev, contentHash }`
  equal to the latest revision) writes the receipt under
  `$PASEO_HOME/plugin-data/decision-roadmap/approvals/<projectId>/<planId>/<rev>.json`, outside
  the editable project store, and appends a copy to `plan.approvals` for readability. Authority
  comes only from the plugin-data receipt; a copy in the project JSON with no matching receipt,
  or a receipt whose `projectId`/hashes do not match, is ignored and reported as `unverified`.
  `projectId` is a stable id stored in the manifest at init. There is no MCP tool for approval.

### Redesign Stage R0 model additions

- `PlanRevision` is a legacy revision (no `schema`, three-field tasks, hashed by `contentHash`)
  or a `schema: 2` revision whose tasks carry `dependsOn`, `parallel`, `completion`, `grill`,
  `grillSessionId?` and `dod`, hashed by `contentHashV2` over `{ schema: 2, markdown, tasks, basedOn,
  decisionSnapshotHash }`. `contentHashFor` picks the function by revision; approval and basis
  currency use it. `Plan.featureId?` binds a plan to a feature (not yet set by any R0 path).
- `Feature`: an ordered roadmap card with `kind` (feature or bug), six statuses (created, planned,
  executing, done, deferred, cancelled), `statusBeforeDefer` while deferred, `dependsOn`,
  `relatedTo`, `everStarted`, creator, coordinator binding fields and an append-only event history.
  `FeatureEvent.from`/`to` are status names on a `status` event and zero-based roadmap positions
  written as decimal strings (for example `"0"`, `"2"`) on a `reordered` event; other kinds carry
  neither.
- Grilling blocks: `Session.blocks?` and `Question.blockId?`. A session converts to blocks on its
  first block-scoped question; it always has exactly one open block. Accepting a block (in the UI, or
  through `roadmap_block_accept` with the human's quoted consent) freezes the accepted definition of
  its questions (`id`, `order`, `number`, `blockId`, `title`, `context`, `options`,
  `recommendedOptionId`, `allowFreeText`, `definitionRev`, `activatedBy`, `invalidatedBy`, `tag`) and
  the accepted block record, including its summary snapshot. Answers, revisions, notes, Skip and Out
  of scope stay editable on those questions, and derived `validity`/`stale`/`review` may change.
  Legacy sessions have no stored blocks and are never frozen by this rule.

### Redesign Stage R1 model additions

- Explicit cancellation of a decision: `RoadmapMetaV2.cancellations` (optional, absent until the
  first cancellation) holds append-only records `{ id, ref, reason, at, actor: { kind: "human",
  hostClientId? } | { kind: "agent", agentId }, quoted? }`; `quoted` (the human's words an agent
  reported) is recorded for agent cancellations only.
  The reason is required and stored trimmed; ids and refs are unique; every ref must name an
  existing question (checked on write, `invalid_input` otherwise, and on read, `store_invalid`
  otherwise; separately, `decision.cancel` for an unknown question returns `not_found` when resolving
  the question, before appending a cancellation). `RoadmapMetaV1`
  does not accept the key. A cancellation never changes the question record, its block or links.
- A cancelled decision is read-only history: update, answer, confirm, skip, out of scope, discuss and
  `relation.add`/`relation.remove` targeting it fail with `decision_cancelled` (a definition or
  relation write on a question of an accepted block reports `block_frozen` first). Relations from it
  to an open question, new
  questions depending on it, links to or from it, and derived `validity`/`stale` remain possible.
  There is no reversal command.
- Owner Q33=1 (2026-10-28, Task R1.5): cancelling a decision that a revision's `basedOn` records
  makes that approval `not_current`; a cancellation outside the recorded basis invalidates nothing.
  Stored revisions, hashes and receipts are never rewritten. A v2 revision without a receipt stays
  `unapproved`. R1.3a as committed had no basis effect; execution stop-and-rework is Task R3.5.

### Automatic grilling model additions

Additive optional fields on a v2 `Session` (absent fields add no bytes; existing stores round-trip
unchanged):
- `planner?: { agentId, workspaceId: string | null, boundAt, boundBy: "ask" | "draft" | "ui" | "discussion", epoch }`
  and `plannerHistory?` (earlier bindings, epochs strictly increasing and below the current one).
- `continuation?` (the current grilling operation) and `continuations?` (terminal earlier ones).
  An operation records `operationId`, `openBlockId`, `target: { agentId, epoch }`, `state`, `attempts`,
  `at`, and, depending on the state, the accepted refs (`acceptedBlockId`, `nextBlockId`), the
  accepted-block `summary`, the matched `pause` card snapshot, a `resolution` and a `reason`.
- States: `awaiting_pause`, `paused`, `accepted_awaiting_pause`, `resolving` (live) and `resumed`,
  `unknown`, `pause_answered_externally`, `pause_lost`, `pause_mismatch`, `unsupported`, `superseded`,
  `needs_manual`, `complete` (terminal). Schema rules tie each field to the states that require or
  forbid it; a live operation always targets the current planner and epoch; continuations need blocks
  and a planner.
- None of these fields enters `decisionSnapshotHash`, `basedOn` or the grilling-completion rule of plan
  approval: the approval gate is unchanged, and completing grilling is not plan approval.

### Feature discussion model additions

All additive and optional; stores written before keep reading unchanged, and nothing is rewritten on
read.
- Numbering: `Question.number` is stored on new questions as `max(effective number) + 1` per session
  and never reused. Every store write first stores `order + 1` on questions that lack a number. The
  store refuses a generation that changes an effective number, repeats one in a session, or deletes a
  session or question (`internal`).
- `Validity` adds `out_of_scope` (status `out_of_scope`, its own count). The mark records no answer
  revision, keeps the answer history and clears the question's own staleness. Each mark is appended
  to `RoadmapMetaV2.outOfScopeMarks` `{ id, ref, at, source, actor, quoted?, reason?, afterRev? }`
  (append-only). Session views expose `currentAnswer` only for `valid`/`stale` and `priorAnswer`
  for a skipped or out-of-scope question; the stored `answer` stays the latest revision.
- `stale` has exactly one cause: `causeRev` (an upstream answer revision) or `causeKind:
  "out_of_scope"` with `causeMarkId`. `review` (same shape) marks an answered skipped or
  out-of-scope question whose upstream changed; it keeps that outcome. A new answer, a repeated Skip
  or a repeated out-of-scope mark resolves it.
- `Block` (accepted) gains `summary?` (the summary built at acceptance) and `acceptedBy` becomes
  `{ kind: "human", hostClientId? } | { kind: "agent", agentId, quoted }`.
- `Session` gains `finishProposal?` `{ at, agentId, summary, skipped: number[], outOfScope: number[],
  finishedAt?, finishedBy? }`, `finishHistory?` (earlier proposals, append-only), `closures?` (below),
  `retries?` (continuation
  messages, the owner's Retry and the plugin's automatic continuation `{ id, at, operationId?,
  blockId, agentId, epoch, state: "sending" | "sent" | "failed" | "unknown", error?, resolvedAt?,
  resolvedBy?: "user" | "sweep" | "timeline", origin?: "automatic" }`; absent `origin` is the owner's)
  `language?` (the discussion language chosen at Discuss when not English; absent is English, or
  for an earlier session the answer of its question tagged `language`) and `languageNoticeAck?`
  (`{ language, at }`: the owner's Got it on the no-translation notice for the session's effective
  language, any non-empty text since for an earlier session it is the answer of its language
  question, the free-text answer or the chosen option's label; written only by
  `session.language_notice.ack`). A store containing `languageNoticeAck` is not
  readable by an older plugin version, as for every optional field added since schema 2; stores in
  which no notice was acknowledged stay readable.
- Finish basis (§7 `session.finish`): `FinishProposal.finishedBy?` is `"proposal"` (the owner accepted
  this proposal) or `"manual"` (the owner closed the session manually while it stood); it is set only
  together with `finishedAt`, on the proposal open at that close, and a proposal finished earlier is
  never touched again. `Session.closures?` lists every close by the owner's Finish, oldest first:
  `{ at, basis: "proposal", proposalAt, source: "ui", actor, reopenedAt? }` or `{ at, basis:
  "manual", source: "ui", actor, reopenedAt? }` (strict; `actor` is the human, `{ kind: "human" }`,
  and any other actor is invalid). The list is
  append-only for every command: only `session.reopen` may set the absent `reopenedAt` of the last
  entry, once, and the transaction guard refuses any other change (`invalid_input`, nothing written).
  Sessions and proposals finished before these fields existed carry neither; nothing infers a basis
  from `finishedAt` and no migration writes them. A close by the planner's `roadmap_grill_complete`
  appends no closure. Stores without the fields read unchanged; a store that contains them is not
  readable by an older plugin version, as for every optional field added since schema 2.
- `Feature` gains `discussion?`: `creating` (the reservation `{ reservationId, profileRef,
  workspaceId, at }`), `failed` (with `error`), `unresolved` (with `checkedAt`) or `bound` (`{
  reservationId, agentId, workspaceId, boundAt, profileRef }`), and `discussionHistory?`.

## 7. RPC contracts (shared/rpc.ts)

All inputs carry `projectId`, validated server-side against registered Paseo projects. The
server resolves the canonical project root; clients do not supply a `storeRoot` path. Every mutation also
carries `expectedRevision: number` and fails with `revision_conflict` when stale (§5).

| RPC | Input | Output |
| --- | --- | --- |
| `roadmap.version` | projectId | `{ revision, exists }` |
| `roadmap.init` | projectId | `{ created: boolean }` |
| `roadmap.overview` | projectId | sessions summary (counts open/answered/stale/inactive), plans summary (latest rev, approvalCurrent), links |
| `session.get` | projectId, sessionId | Session with computed `status` per question, `depth` for layout (longest activation/invalidation path from a root) and resolved link labels |
| `session.create` | projectId, title | `{ sessionId }` |
| `question.create` | projectId, sessionId, title, context, options, recommendedOptionId?, allowFreeText, activatedBy, invalidatedBy, blockId?, answerText? | `{ questionId, visibilityChanged, rev? }` |
| `question.update` | projectId, sessionId, questionId, patch (title/context/options/recommended/allowFreeText) | `{ definitionRev, staleMarked }` |
| `relation.add` / `relation.remove` | projectId, target Ref, kind: activation \| invalidation, Activation \| Invalidation | `{ staleMarked, visibilityChanged }` or `relation_cycle` / `unresolved_ref` |
| `question.answer` | projectId, sessionId, questionId, optionId? \| text?, note? | `{ rev, staleMarked: string[] }` |
| `question.confirm` | projectId, sessionId, questionId | `{ rev }` |
| `question.discuss` | projectId, sessionId, questionId, text | `{ noteId }` |
| `question.skip` | projectId, sessionId, questionId, note? | `{}` |
| `link.create` / `link.delete` | projectId, Link | `{}` |
| `plan.get` | projectId, planId | Plan + `approvalCurrent` + `blockers` |
| `plan.draft` | projectId, planId?, featureId?, title, sessionIds, markdown, tasks | `{ planId, rev, contentHash }` |
| `plan.approve` | projectId, planId, rev, contentHash, note? | `{ approvedAt }` or error `plan_revision_mismatch` |
| `task.update` | projectId, planId, taskId, status, verification? | `{}` |
| `tracker.preview` | projectId, planId | `{ actions: [{ actionId, taskId, kind: "create" \| "close" \| "skip", payload, destination, reason }], mode, receiptId, confirmToken, liveAvailable, unavailableReason }`; `liveAvailable` means only that a supported local connection config and an adapter exist (preview never connects), `unavailableReason` is the connection error code or null |
| `tracker.apply` | projectId, planId, actionIds: string[], confirmToken, expectedRevision | `{ results: [{ actionId, intentId, state: "confirmed" \| "unknown" \| "failed", remoteKey?, error? }] }` |
| `tracker.reconcile` | projectId, planId, intentId | `{ state, remoteKey? }` |
| `tracker.resolve` (UI only) | projectId, planId, intentId, planRev, expectedRevision, resolution: `{ kind: "link", remoteKey }` \| `{ kind: "not_created", confirm: true }` | `{ revision, state, remoteKey?, auditRecorded }`; `state` is `confirmed` for link, `failed` for not-created/not-applied |

`tracker.resolve` takes `projectId`, not `storeRoot`, and resolves the canonical registered project root. It only resolves
unknown or interrupted intents. Linking verifies the ticket read-only against the original
connection and project; a close must refer to its original, closed ticket. Explicit confirmation
that no create or close occurred permits a fresh preview, never an automatic resend. A failed
external audit write leaves the local resolution committed and returns `auditRecorded: false`.

`confirmToken` = HMAC over (actionIds, exact payloads, destination, settings digest, mode,
receiptId, store revision and, in live mode, the keyed connection fingerprint `connectionFp`)
with a server secret; `tracker.apply` recomputes it and rejects any drift. Each action
becomes a durable `TrackerIntent` (`pending`) persisted in the store before the remote call.

### Redesign Stage R0 contracts (`STAGE_R0_CONTRACTS`)

Contract modules `shared/rpc-features.ts`, `shared/rpc-blocks.ts` and `shared/rpc-dod.ts` build on
`shared/rpc-base.ts` and are aggregated by `shared/rpc.ts`.

| Contract | Purpose |
| --- | --- |
| `feature.list` | features in roadmap order with the store revision |
| `feature.create` | append a card (`title`, `description`, `kind`, `dependsOn?`, `relatedTo?`) |
| `feature.update` | edit `title`/`description` |
| `feature.reorder` | set the order (a permutation of all ids) |
| `feature.dependencies.set` | replace dependencies; unknown → `not_found`, self/cycle → `relation_cycle` |
| `feature.delete` | delete a never-started feature that nothing depends on, no plan binds and whose discussion chat is not being created (`feature_transition` otherwise, with `planIds` for bound plans) |
| `feature.status.set` | manual transitions only: defer, undefer, cancel (`feature_transition` otherwise) |
| `block.accept` | accept the open block of a session and open the next (UI; the MCP tool `roadmap_block_accept` does the same with the human's quoted consent) |
| `dod.template.get` | effective DoD template `{ source, text }` |

`question.create` and `roadmap_ask` take `blockId` as follows. On a session that uses blocks it is
required and must name the open block. On a session without blocks it is optional: omitted, the
question is a legacy question; given on a session with no questions yet, it starts that session's
first block; given on a session that already has legacy questions, it is rejected with
`invalid_input`. `session.get` returns `session.blocks` for a session that uses blocks.

`question.create` takes an optional `answerText` (non-empty): the owner's first free-text answer,
written with the question in the same transaction through the ordinary answer rules (revision 1,
source `ui`, the human actor), so a question that does not allow free text, or one created inactive,
is refused (`invalid_input`, `question_inactive`) and neither the question nor the answer is written.
Only the UI origin may send it; a chat origin is refused with `invalid_input`. The output then
carries `rev: 1`. Placement, `block_frozen`, the revision check and legacy sessions follow the rules
above unchanged. There is no idempotency key: the panel never resends a create on its own.

`block_frozen` is returned for a definition or relation write that targets a question of an accepted
block: `question.update`, `relation.add` and `relation.remove` whose `target` is such a question, and
`question.create` or `roadmap_ask` naming an accepted block. Answers, confirmations, skips,
out-of-scope marks and notes are allowed on such a question. A relation may name a frozen question as
its parent or upstream, because the relation is stored on the open target only. Any other write that
would change the accepted definition of a frozen question, or an accepted block record with its
summary snapshot, is also refused with `block_frozen`; answers, notes and derived staleness are not
accepted definition. `plan.approve` on a `schema: 2` revision with
approval blockers fails with `plan_ineligible { blockers }` before any receipt is written (Stage R2
gates, §7 "Redesign Stage R2"); legacy approval is unchanged. Reorder, delete and status changes
refuse a non-UI origin; block acceptance accepts a chat origin only with a bound agent and the
human's quoted consent (`roadmap_block_accept`).

### Redesign Stage R1 contracts (`STAGE_R1_CONTRACTS`)

| Contract | Purpose |
| --- | --- |
| `decision.cancel` | UI only: cancel a decision with a required reason; a second cancel fails with `decision_cancelled`; accepted decisions can be cancelled |

`session.get` returns the session's `cancellations`, each with its `dependents` (activation children
and invalidation downstream, transitively, across sessions, as `{ ref, number, status }`). Agents
cancel through `roadmap_cancel_question` (§8). The `link.create`/`roadmap_link` kinds are unchanged;
`link.delete` cannot remove a cancellation.

### Redesign Stage R2 contracts (`STAGE_R2_CONTRACTS`) and approval gates

| Contract | Purpose |
| --- | --- |
| `plan.rework` | UI only: send the approved latest revision of a bound plan back for rework, with a required reason (trimmed, at most 2000 characters) |

- Approval gates. `plan.get` reports, and `plan.approve` enforces, the same `blockers` for the
  latest revision: none for a legacy revision of an unbound plan; `legacy_revision` for a legacy
  revision of a bound plan; for a `schema: 2` revision, in order, `dod_missing { taskId }` for every
  task with an empty (or whitespace-only) DoD, then `grilling_required` for the feature (bound plan,
  not a bug), the plan, and every task with `grill: true`, each carrying `sessionId` when a link
  exists. A grilling session is complete when it has at least one active question that is not
  cancelled and every such question is answered and not stale (skipped is not complete; visibility
  is computed over all sessions). `gates_not_available` is no longer produced; the value stays in
  the blocker enum for older clients. Approving a bound `schema: 2` revision moves a `created`
  feature to `planned` (one status event, reason "plan approved") in the receipt-copy transaction,
  only while that revision is still the latest and not sent for rework.
- Grilling sessions. A bound `plan.draft` creates, inside its transaction, an ordinary empty session
  `[feature] <title>` for a feature-kind feature without one, `[plan] <title>` for a plan without
  one, and `[task:<id>] <title>` for every `grill: true` task without a carried link; a task keeps
  its link from the latest revision while `grill` stays true and loses it when `grill` is turned off
  (the session stays). Links are stored in `Feature.grillSessionId`, `Plan.grillSessionId` and the
  task's `grillSessionId` (part of the v2 content hash); grilling sessions are never added to
  `sessionIds` or `basedOn` automatically. Clients never send `grillSessionId`.
- Rework. `plan.rework` needs a bound plan, its latest revision, a matching approval receipt (the
  approval need not be current, so a cancelled basis can be reworked) and a `planned` or
  `executing` feature. It appends `Plan.reworks { planRev, at, reason, actor }`, sets every task of
  that revision that is not `verified` to `cancelled` (verified states stay as the completion
  record), and moves the feature to `created` with reason "plan in rework". Revisions, hashes,
  receipts and copies are unchanged. A reworked latest revision is `not_current` ("revision N was
  sent for rework") everywhere currency is read; approving it, or starting one of its tasks, is
  `plan_not_current`. `plan.get` lists `reuseCandidates` (verified tasks of reworked revisions,
  newest first, with `verifiedAt` only when recorded); they are never applied. New revision
  tasks start implicitly todo; a TaskState row is created only on the first task.update. A live run
  of the reworked revision ends in the same transaction (Stage R3).
- Task states: v1 plans keep `TaskStateV1` (`todo | in_progress | done | verified`); the v2
  `TaskState` adds `cancelled` (set only by rework); `task.update` cannot set it and no move leaves
  it (`task_transition`). Rows are lazy (`todo` until the first `task.update`). The UI still
  verifies with a note.
- One plan per feature (owner Q1). A draft that would bind a plan to a feature that already has
  another bound plan (a new plan, or a legacy plan given `featureId`) fails with `invalid_input
  { reason: "feature_has_plan", featureId, planId }`; redrafting the single bound plan is
  unchanged. Old data with more than one bound plan stays readable; redraft, `plan.approve`
  (before any receipt) and `plan.rework` of such a plan fail with `invalid_input { reason:
  "feature_has_multiple_plans", featureId, planIds }`. RPC and MCP share the rule.
- `statusReason` describes the current status only. `plan.rework` sets "plan in rework"; the
  approval copy clears it on `created → planned`; every manual `feature.status.set` change clears
  it, and undefer to `created` sets "plan in rework" again only when the feature's bound plan has
  its latest revision reworked. History stays in the status events and `Plan.reworks`.
- Approval effects pending. A durable receipt is written before the project copy, whose
  transaction (three attempts) can fail. `plan.get` then derives `approvalEffectsPending` (absent
  when none) from the latest revision's verified receipt: `project_copy` when no copy has that
  `receiptId`; `feature_planned` when the bound feature is still `created` and the revision is the
  latest and not reworked. With more than one bound plan, no `feature_planned` is reported and
  every entry has `retryBlocked: "feature_has_multiple_plans"`. The plan view lists the reasons
  and offers "Retry approval effects" (the same idempotent `plan.approve` of the displayed latest
  revision) only when the revision is not reworked, there are no blockers, the approval is current
  and no entry is `retryBlocked`; it never bypasses a gate.

### Redesign Stage R3 contracts (`STAGE_R3_CONTRACTS`), runs and coordinators

`STAGE_R3_CONTRACTS = [...RUN_CONTRACTS, ...RUN_EVIDENCE_CONTRACTS]` (`shared/rpc-runs.ts`),
registered by `server/run-handlers.ts`, each exactly once. Every write is UI only; run-scoped writes
carry the run token, and a stale token or an ended run is `run_stale`.

| Contract | Purpose |
| --- | --- |
| `run.start` | Start (or return) the feature's run on its approved, current, bound revision; a staged coordinator creation when `profileRef` is given and none is bound |
| `run.pause` / `run.resume` | Owner pause (retires open verification cycles) and resume (readiness re-checked; an undelivered prompt is re-sent once as a steer) |
| `run.budget.grant` | Extra repair cycles for a task at its ceiling |
| `delegation.revoke` | Revoke a delegation (R4.4): no new delegated starts under it; runs it authorised get no new task dispatch until another current delegation covers the feature |
| `run.get` / `run.list` | `RunView { run, ready, blocked, unresolved? }` |
| `coordinator.replace` | Replace the bound coordinator when the feature has no live run, or when its live run is paused and acknowledged (`{ featureId, profileRef }` → `{ revision, agentId, workspaceId }`) |
| `task.accept` | Human acceptance of a task whose completion is `human` |
| `run.evidence.list` | Current and late evidence of a run |

- Readiness (`shared/readiness.ts`). A task is ready only when the feature is executing, the run
  is running, the start is authorised (UI, or, since R4.4, any current unrevoked delegation
  covering the feature, whatever its id; `run.startAuth` stays the historical record), the
  approval is current, prerequisites are done, dependencies are verified, the task is todo and
  below its ceiling, and the parallel grant allows it. Approval alone never makes a task ready.
  `NotReady` codes travel as `run_not_ready { blocked }`.
- Coordinator start. With no binding, `run.start { profileRef }` creates a branch-off worktree
  `roadmap/<featureId>` and an agent from the host profile (no prompt), then one revalidating
  transaction writes the binding and the run, then the run prompt (with the run token) is sent.
  A start with an already bound coordinator also sends the prompt once after the commit. A failed
  send pauses the run (`owner`) with `prompt_failed` and a feature note; resume re-sends it once.
  A losing concurrent start archives its agent and returns the winning run.
- MCP run tools (`server/run-tools.ts`): `roadmap_run_next`, `roadmap_task_claim`,
  `roadmap_task_progress`, `roadmap_run_ack`, `roadmap_start` and `roadmap_feature_bind`. Authority
  comes only from the caller's bound grant (`agentId`, `workspaceId`, from the endpoint context),
  checked in the order unbound, run token, role, readiness. The coordinator is the bound agent;
  crew is a grant whose non-null workspace equals the coordinator's; anyone else is foreign. Only
  the coordinator asks for next tasks; the coordinator claims or dispatches, crew claims for itself
  only; progress belongs to the task's agent or the coordinator; an ack is self only. No tool
  approves, verifies, accepts, pauses, resumes, reworks, cancels or grants budget.
- Bound chats without a workspace. `roadmap_feature_bind` from a grant without a workspace stores
  `workspaceId: "no-workspace"` and `profileRef: "bound-chat"` (the schema needs a non-empty id).
  The sentinel has no crew and no worktree: `roadmap_task_progress done` for such a feature is
  refused (`invalid_input`, the worktree identity cannot be read) before any cycle opens, and the
  task keeps its state (claimed or in progress).
- Delegated starts. `roadmap_start { scope, featureId?, quoted }` (`featureId` required for scope
  `feature` and refused for scope `roadmap`, before any provenance check) records a delegation only
  when the quote appears in a user message of the calling chat (else `delegation_unverified`).
  This proves the words are in a user message of that chat, not that a human typed them: a local
  client sending an un-enveloped message is indistinguishable from human input. A
  candidate starts through its bound coordinator or `roadmap.coordinatorProfile`; otherwise it
  gets one note "delegated start skipped: no coordinator profile configured" and no run.
- Starts are preflighted before any SDK call: a stale `expectedRevision` is `revision_conflict`
  (an existing live run is still returned as `existing`), and a revision without tasks is
  `invalid_input`. The run prompt tells the coordinator to give each dispatched worker the run id
  and token.
- Verification. `roadmap_task_progress done` reads the worktree identity, opens a cycle bound to
  `{ taskId, planId, planRev, contentHash, runToken, worktree }` and starts the server runners: the
  task's `- [check]` commands, then the review command only after passing checks, with the
  `roadmap` timeouts and buffer, in the coordinator worktree (identity excludes `.decisions`). One
  `AbortController` per cycle. The record transaction decides from that cycle only; drift, an
  unreadable identity, a paused run, a changed binding or a runner error retires the open cycle
  (`cycle_retired`, task back to in progress, unresolved note, no failed count). A record that
  itself fails is logged and not retried; recovery is pause, ack, resume and a fresh `done`. A
  terminated runner process settles fail-closed within a bounded grace even when its descendants
  keep the pipes open.
- Pause, status and rework. `run.pause` retires open cycles in its transaction, then cancels the
  runners and steers the coordinator to have workers call `roadmap_run_ack`; while paused,
  `unresolved` lists `awaiting ack: <taskId> (<agentId>)` until the task's agent acks after
  `pausedAt`. Defer pauses the run (`deferred`); undefer keeps it paused (`owner`); cancelling the
  feature ends it (`cancelled_with_feature`); `plan.rework` ends it (`cancelled_for_rework`). Each
  effect is applied in the causing transaction; afterwards the runners are cancelled and the
  coordinator gets one steer (the pause request, or an accurate stop text for an ended run); a
  failed steer leaves a feature note.
- Auto-done and sweeps. The record or acceptance that verifies the last task ends the run
  (`finished`) and moves the feature to done in the same transaction; the status event's actor is
  the task's agent (else the coordinator) for a record and the human for an acceptance. A sweep
  then resumes runs paused for a prerequisite once every prerequisite is done (all receipt,
  readiness and revision checks first), and starts delegated candidates; it also runs after an
  approval and after a delegation is recorded. An undelivered run prompt is re-sent once as a steer
  before such a resume; a failed re-send ("run prompt re-send not delivered") leaves the run
  paused for the owner (no automatic retry). A re-send failure (from a sweep or an owner resume)
  that arrives after the run was resumed or its prompt delivered by the other path writes nothing.
- Replacement. `coordinator.replace` needs a binding; with a live run, that run must be paused and
  its active tasks must all have acked (`pause_unacknowledged` otherwise), with no SDK call on a refusal. The new agent is created
  in the existing workspace (branch-off only for the sentinel), one revalidating transaction
  appends the old binding to `coordinatorHistory` and keeps the run and token, and the handover
  prompt is sent once after the commit. The old chat is not archived. A feature with no live run is
  replaced the same way, without a handover prompt.
- Timeline run rows. A completed run-scoped tool call for a run that exists in the store appends
  one `decision-run` row per agent and run (`id: run.<runId>`, data `{ projectId, runId }` only).
  `RunTimelineCard` reads `run.get` and shows state, pause reason, task counts, ready and
  unresolved counts, without actions.
- Limitation. The coordinator and worktree flow uses the 0.12.0 SDK projection
  (`workspaces.create`, `agents.create`, `agents.ref().send`, `workspaces.ref().refresh()`). It is
  verified by local tests, compiles, and synthetic plugin-RPC journeys in an isolated 0.12.0
  container (run states modelled where a live run would need an agent). No live coordinator or
  model run and no native host feature is claimed.

### Redesign Stage R4 additions (client screens and contract changes)

- **`feature.list`** output gains `delegations: StartDelegation[]`: the stored array, revoked ones
  included with `revokedAt`, newest last. The roadmap screen lists the unrevoked ones with a
  UI-only Revoke (`delegation.revoke`, no retry).
- **Prerequisite cancelled** (R4.3). Cancelling a feature, in the same transaction, affects only
  unfinished dependents (not `done` or `cancelled`):
  - ends every live run of a direct dependent: a running run is first `paused
    (prerequisite_cancelled)`, then `ended (cancelled_for_rework)`; an already paused one ends
    directly. If rework does not happen, the end detail records its actual refusal cause;
    missing or mismatched receipt wording is reserved for that receipt refusal.
  - reworks the dependent's plan (`reworkedRev` = latest rev) when its single bound plan's latest
    revision has a matching `ApprovalStore` receipt and the feature is `planned`, `executing`, or
    deferred from either. A deferred dependent stays `deferred` with `statusBeforeDefer:
    "created"`.
  - when rework does not happen (for example, no matching receipt or an already-reworked
    revision), the cancellation sets no new `reworkedRev`; an earlier request's `reworkedRev` is
    kept, and without one the request is request-only:
    - a `planned`/`executing` dependent moves to `created` ("prerequisite cancelled"), or a deferred
      one gets `statusBeforeDefer: "created"`;
    - a feature note records why the plan was not reworked when a single bound plan exists.
  - sets `Feature.replacementRequested { state, becauseOf, at, reworkedRev? }`, with state
    `requested` when a coordinator is bound and `queued` when not. Both are valid; queued becomes
    requested on bind or on a staged start, with one steer.
  - on unfinished transitive dependents:
    - pauses running runs and relabels `prerequisite_not_done` pauses to `prerequisite_cancelled`;
    - keeps `owner` and `deferred` pauses;
    - appends "prerequisite <title> cancelled; execution waits" when no run is live.

  Approving a replacement clears the request (`planRev > reworkedRev`, or, for a request-only
  request, a receipt `at` later than the request's `at`) and requests every unfinished direct
  dependent that has no request yet. Undeferring never reworks.

  In the plugin server process, a UI cancel's receipt check and transaction, and a plan
  approval's checks, receipt publication and project copy, run one at a time per project
  (keyed by the store's normalised root and the project id); the export and after-commit hooks
  run after that section. A second process on the same store is not covered. A UI cancel whose
  store open or receipt read fails returns its failure `Result` with nothing committed.
- **Readiness and delegations** (R4.4): as in the readiness rule above. A revoke stops new
  feature starts under that delegation, and stops new task dispatch only while no unrevoked
  delegation still covers the feature; tasks in progress finish, and the run is neither paused
  nor ended. A new verified delegation restores dispatch and resume.
- **Tracker payload** (R4.5a): `createPayload` sends the description, then
  `"Definition of done:\n" + dod` when the task's DoD is not blank, then the intent marker (always
  last). An over-length body is refused, not truncated; idempotency keys are unchanged.
- **Chat timeline** (R4.1): the client subscribes first, waits for `ready`, refetches the tail with
  `projection: "canonical"`, merges by seq range and replays buffered events. The installed 0.12.0
  server ignores the requested projection and returns its projected chronological view
  (consecutive chunks merged), so the client never assumes canonical delivery. This was verified
  against the installed and containerised 0.12.0 server, with an idle container QA agent. Live
  turn streaming and live permission delivery are covered by mock-based unit tests only; no live
  model turn was run.

### Automatic grilling contracts (`STAGE_G_CONTRACTS`)

UI only (a chat origin is `invalid_input`):
- `session.planner.set` `{ projectId, expectedRevision, sessionId, agentId }` → `{ revision, epoch }`.
  Binds or rebinds the session's planner chat. The service reads the agent from the host
  (`not_found` when unknown, `invalid_input` when archived) and takes its workspace from that snapshot,
  never from the input. A rebind bumps the epoch, keeps the previous binding in `plannerHistory` and
  marks a live operation `superseded` (reason `rebind`); the previous chat's waiting card is never
  answered.
- `session.reopen` `{ projectId, expectedRevision, sessionId }` → `{ revision }`. A closed (completed)
  session becomes active again; `invalid_input` when it is not closed. When the session's last closure
  has no `reopenedAt`, it is stamped with the reopen time; a session closed otherwise (before closures
  existed, or by `roadmap_grill_complete`) reopens without writing a closure. The finished proposal
  keeps `finishedAt` and `finishedBy`, so it does not show again. Nothing is sent to any chat.
- `session.language_notice.ack` `{ projectId, expectedRevision, sessionId, language }` → `{ revision }`
  (`STAGE_U_CONTRACTS`, UI only, revision-checked): stores `languageNoticeAck { language, at }`; the
  same label again writes nothing; no chat tool writes it, and it is not part of any plan snapshot.

`session.get` (`SessionView`) additionally carries, for a session with blocks, the stored grilling fields
in `session` and a derived `grilling: GrillingView` `{ status, manualRecovery, reason?, operationId?,
plannerAgentId?, epoch?, finishProposal?, retryCount?, lastRetry?, automatic?, tools? }` for the panel
header (`finishProposal` only while not finished; `lastRetry { id, at, state, origin? }` of the current
operation and planner binding; `automatic: "waiting"` while the plugin's automatic continuation of a
chat bound by Discuss is due and nothing was sent yet; `session.get` always sets `retryCount`; `tools` only through the panel's
`session.get` of a session whose planner is a discussion chat, decided as for `feature.discussion.open`
below, with the reservation of the feature whose bound discussion names this session and planner
(none for a planner without such a record, such as one whose feature was deleted: its session and
history stay, but the reservation is gone, so its own grant may be a marked one and every live (not
stale) unbound grant in its directory, marked or not, makes it `unknown`; that count reads no marks,
so with no such grant it is `not_attached` even when the marks file is unreadable). Both directory
counts, the unmarked one for a planner with a reservation and the one over every live unbound grant
for a planner without, consider only grants issued at or after the earlier of the session's creation
and the binding less 60 s. `unknown` when the store, the grants file, the marks file where it is
read, or the workspace cannot be read; the workspaces are listed only when grants must be counted by
directory; read again on every such read, never from the MCP tools). Statuses: `no_planner`, `idle`, `waiting_for_answers`,
`waiting_for_accept`, `accepted_waiting_for_pause`, `answering`, `continued`, `outcome_unknown`,
`chat_moved_on`, `pause_lost`, `card_mismatch`, `unsupported`, `planner_changed`, `needs_manual`,
`complete`. Error codes `planner_bound` and `stale_operation` were added.

### Feature discussion contracts (`STAGE_D_CONTRACTS`)

`shared/rpc-discussion.ts`, aggregated by `shared/rpc.ts`; every write is revision-checked and UI only.

| Contract | Purpose |
| --- | --- |
| `question.out_of_scope` | `{ sessionId, questionId, reason? }` → `{ revision, visibilityChanged }`: mark an active question out of scope (also on an accepted block); refused for a cancelled one; a repeat is refused unless it resolves a review marker |
| `session.finish` | the owner's Finish, with its basis: `{ sessionId, basis: "proposal", proposalAt }` or `{ sessionId, basis: "manual" }` (a strict union: a missing or unknown basis, a proposal basis without `proposalAt` and a manual basis with it are refused at the RPC boundary and again by the command, so no malformed request becomes a manual close) → `{ revision }`. At the current revision a closed session (`invalid_input`, "already closed"), a proposal basis with no open proposal, or one whose `proposalAt` is not the open proposal's `at` ("the proposal changed; review the new one") is refused and nothing is written; a stale revision is `revision_conflict` before those checks. It closes the session, marks the open proposal, if any, `finishedAt` with `finishedBy` = the basis, and appends one closure (§6). Any chat origin is refused |
| `feature.discussion.open` | `{ featureId, workspaceId, profileRef?, retryUnresolved?, confirmedNoChat?, language? }` → `{ revision, sessionId, agentId, workspaceId, created, tools }` (below) |
| `discussion.retry` | `{ sessionId }` → `{ revision, retryId, sentTo, state: "sent" \| "sending" }` (below) |
| `discussion.retry.resolve` | `{ sessionId, retryId, outcome: "delivered" \| "not_delivered" }`: the owner's mark of an uncertain retry |
| `discussion.retry.check` | `{ sessionId, retryId }` → `{ state }`: marks the retry sent only when observed (below) |

`question.answer` takes an optional `defaulted` flag, stored only for a UI answer whose option is the
recommended one. `session.get` adds per question `number`, `links { question, answer }`,
`currentAnswer?`, `priorAnswer?`, `outOfScopeEvents?`, `outOfScopeUpstream?` and `review?`; per
session `outOfScope` (its out-of-scope questions with their dependents), `summaries` for accepted
blocks (`acceptedSummary` as given to the chat, `currentSummary`, `changedSinceAcceptance`, `changed`
numbers, or `noSnapshot` for a block accepted before snapshots existed) and `openBlockPreview`.

Block summaries number questions by their session number: `Q<n> <option number>`, `Q<n> text:` with
indented lines, `Q<n> skipped`, `Q<n> out of scope`, `Q<n> unanswered`, marks `(default)`, `(stale)`,
`(review)` and `(cancelled)`, then a `Cancelled: Q<k> (<reason>) -> dependents …: cancel or re-ask
them` line per cancelled decision of the session with uncancelled dependents, then the legend.

`feature.discussion.open` (one-click Discuss):
- Order: the reservation (and the feature's `[feature] <title>` session when absent) is committed
  first; the agent is created in the reserved workspace from the saved profile with no prompt,
  labelled `decision-roadmap.reservation=<id>` and with the reservation id as `idempotencyKey`; the
  binding and the session planner (the UI rebind path, `boundBy: "discussion"`) commit in one
  transaction; only then is the prompt sent. An undelivered prompt leaves the binding.
- `language`: English when absent (the panel omits it for English); otherwise it must be one of the
  `discussionLanguages` setting, checked before anything is reserved or created (`invalid_input`).
  The press that binds the chat (a new creation, a chat found by its reservation or the owner's
  confirmed retry) stores it as `Session.language` while no chat has used the session (no planner and
  no question yet); the prompt states the session language and asks no language question.
- The created chat's creation (identified by a reservation that is `creating` in the store) gets exact
  preapprovals, `toolPolicy.preapproved`, for `roadmap_overview`, `roadmap_get_session`,
  `roadmap_feature_list`, `roadmap_resolve_link`, `roadmap_pause_instructions` and `roadmap_ask`
  only, where the provider supports exact MCP preapproval: on the roadmap server for Claude and
  OpenCode (which add them as allowed tools); for Codex, which makes a server's grants its whole
  enabled tool list, on a second server entry `decision-roadmap-discuss` with the same URL and grant,
  so the roadmap server keeps every tool with its normal approvals. The prompt of a Codex chat asks it
  to prefer that entry for those six tools, falling back to the roadmap server when the entry is not
  available, and to use the roadmap server for every other tool; it can only direct the chat. The
  provider is the profile's for a new creation and, for a chat found by its reservation, the chat's
  own as the agent listing reports it (no entry is named when the listing gives none). A completed
  `decision-roadmap-discuss.roadmap_ask` gives the same decision-question timeline row as through the
  roadmap server; no answer, confirm or run tool is matched under that entry. Other providers get none
  of this; the profile's mode and other agents are unchanged.
- A bound feature returns its chat with `created: false`. A press within 60 s of a reservation is
  refused; two presses at one revision create one agent. Bugs, a workspace outside the project, no
  or an unknown profile and a stale revision are refused before anything is created.
- Only an authentication refusal (recognised by the error's name; the class is not exported from the
  public client entry) records `failed`. Any other rejection keeps the reservation. After 60 s the
  next press lists agents by the reservation label, archived ones included, across pages: a live one
  is bound with the reserved workspace; an archived one means the creation happened, so a new
  reservation may create. When none is found the reservation becomes `unresolved`: the host does not
  document a complete listing after an interrupted creation, so only `retryUnresolved` together with
  `confirmedNoChat` (the owner's explicit confirmation, recorded as a feature note) creates again,
  under the same reservation id and idempotency key, in the reserved workspace.
- `tools` comes from exact links only; a workspace directory or a time window never identifies a
  grant. `agents.create` passes `env.PASEO_ROADMAP_RESERVATION = <reservationId>` (an id, no secret);
  the plugin's `agent.create` injection reads it from the hook request (the hook has no agent id or
  labels) and marks the grant it issues with it, in `plugin-data/.../reservations.json` beside
  `grants.json` (whose schema is unchanged). `attached`: a grant bound to the agent. `pending`:
  exactly one live grant marked with the reservation, unbound, at any age (so a reconciliation long
  after the creation still sees it), on a reservation that was never retried. `unknown`: a
  reservation the owner retried (`confirmedNoChat`, detected by the feature note written in the
  retry's reservation transaction), since the earlier attempt may have issued a grant with the same
  mark; several marked grants or one bound to another agent; a live (not stale) unbound unmarked
  grant in the workspace directory issued at or after the start of the count (the reservation time
  for a new or reconciled creation; for an already bound chat the earlier of the session's creation
  and the binding less 60 s), which is another chat's
  or this chat's from an older plugin or a host that dropped the env; or an unreadable store, grants
  file or workspace, or an unreadable marks file (read for the reservation lookup and the unmarked
  count). Stale grants never count. `not_attached`: none of these, i.e. the chat holds no live grant: none was issued for
  the creation, or the one issued was made stale when the endpoint moved to another port. A grant
  bound to the agent (through the fingerprint in that agent's own env) is `attached` in every case; it
  is read from `grants.json` alone, so also when the marks file is unreadable.
  `reservations.json` (`{ version: 1, marks: [{ grantId, reservationId }] }`, mode 0600, written
  atomically after the grant) is left untouched when unreadable or of another version; then marking
  is skipped, and a read of it fails: the reservation lookup and the unmarked count, so a chat with a
  reservation and no grant bound to its agent is `unknown`. Neither the bound-grant read nor the
  count for a planner without a reservation reads it.

Automatic continuation (pause engine): for a session whose planner is bound by Discuss, still
active, with no open finish proposal, whose current operation is `needs_manual` for its accepted
block with the reason `unsupported…`, `no_pause` or `pause_lost: no_pause`, and which has no retry
record of that block, operation, agent and epoch, the plugin writes one record `sending` with
`origin: "automatic"` and sends once with the text `Decision Roadmap (continuation) [DR-RETRY-<id>]:`
and the same summary and pointer, the record id as `messageId` and no `activeTurnBehavior`. It
re-evaluates on Accept, `agent.turn_ended`, `agent.permission_resolved` and the start-up reconcile;
there is no timer, except that a trigger arriving during the third consecutive decision for one chat
is served after one second. A chat the host closed after idling (not archived) is first loaded through
a one-entry timeline read (never a reload), only while the continuation is still due on the latest
store and the plugin has not stopped, and is then read again; a failed or slow (30 s) load sends
nothing and is logged. That the read loads the agent from its stored session (`ensureAgentLoaded`, a
no-op for a loaded agent) without interrupting it was read in the installed host 0.15.3; the 0.12
typing packages do not document it and it is not verified on other host versions. A load already
issued cannot be withdrawn, and loading starts the chat's session again as opening it would. It claims only after a
read shows the chat idle with no pending permission or question, reads again after the claim (bounded at 2 s) and admits the send inside a store
transaction that re-checks the record and the session; otherwise the never-sent record is removed
(also after the plugin stopped) and the continuation waits. The host has no conditional send, so a
turn or prompt started between the last read and the send's arrival is interrupted or dismissed as
by any message. Any existing record stops it: an unknown outcome is never resent, and the owner's
marks, Check chat and Retry work on it as on a manual record.

`discussion.retry` (manual continuation):
- Offered only under manual recovery with a bound planner, for the current operation's own accepted
  block. In one transaction it refuses when a retry of that block, operation and planner agent and
  epoch was sent or is uncertain, and records a `sending` retry; then it sends once to the planner
  with the record id as `messageId`, the text `Decision Roadmap (manual continuation) [DR-RETRY-<id>]:`,
  the summary stored at acceptance and a pointer to `roadmap_ask` or `roadmap_grill_propose_finish`.
  No `activeTurnBehavior` is passed: the SDK offers only `interrupt` and `steer`, and the daemon
  interrupts an active turn when it is omitted.
- The outcome is written with at most 3 compare-and-set attempts: `sent` when the host accepted the
  message (not that the chat consumed it), `failed` only for the authentication refusal or the
  daemon's `Agent not found: <id>` (with that reason), `unknown` otherwise (only the error kind is
  stored). A result whose write keeps losing reports `sending`.
- The host documents no deduplication by message id; nothing relies on it and nothing is resent
  automatically. Once per process the first host context turns `sending` records older than 60 s into
  `unknown`. `discussion.retry.check` reads the planner's last 200 timeline entries and marks `sent`
  only for a user message carrying the token or the record id; `discussion.retry.resolve` (refused on
  a settled record) records `sent` or `failed` (Retry enabled again).

## 8. MCP tools (server/mcp-tools.ts)

Endpoint: in-process HTTP MCP server on `127.0.0.1`, random port and secret persisted under
`$PASEO_HOME/plugin-data/decision-roadmap/mcp.json`; the URL path embeds an HMAC-signed
`storeRoot`, so a tool call can only touch the project it was issued for (same scheme as the
excalidraw plugin). Injected by `server.before("agent.create")` only when the provider supports MCP and
the project resolved from the request has an enabled roadmap (owner decision Q2: a `.decisions/`
store exists and its manifest is not disabled). The dedicated discussion chat's creation also gets
the read and `roadmap_ask` preapprovals of §7 `feature.discussion.open` (for Codex on the second
entry `decision-roadmap-discuss`).

| Tool | Purpose |
| --- | --- |
| `roadmap_create_session` | create a session |
| `roadmap_overview` | sessions, open/stale questions, plans and approval state |
| `roadmap_get_session` | full session with statuses, numbers and links (current and prior answers, review markers, out-of-scope dependents, block summaries) |
| `roadmap_ask` | create one or more questions with options, recommendation, free-text flag, optional `tag: "language"`, activation conditions and invalidation dependencies; returns ids, `numbers`, `links` and, for a session with blocks, a `grilling` value (see "Automatic grilling" below) |
| `roadmap_answer` | record an answer with `source: "chat"`, `actor.kind: "agent"`, and the quoted human text; same validation as the UI |
| `roadmap_confirm` | clear a stale mark by re-confirming |
| `roadmap_discuss` | append a discussion note |
| `roadmap_relate` | add or remove an activation/invalidation edge (same validation as `relation.*`) |
| `roadmap_update_question` | edit a question definition |
| `roadmap_link` | create a descriptive `informs`/`supersedes` link |
| `roadmap_plan_draft` | create a new plan revision from answers |
| `roadmap_plan_status` | approval state, `approvalCurrent`, task and ticket states |
| `roadmap_task_update` | move a task to `in_progress`/`done` (never `verified`) |
| `roadmap_resolve_link` | read only: resolve a `roadmap://` question or answer link of the grant's project; an answer link returns the current answer (none, with `priorAnswer`, for a skipped or out-of-scope question); `/answer/r<k>` returns revision k with `current: false` unless it is current; other projects `project_mismatch`, malformed `invalid_input`, unknown `not_found` |
| `roadmap_out_of_scope` | mark a question out of scope with the human's `quoted` words (kept on the mark and as a note) |
| `roadmap_cancel_question` | cancel a decision with a reason, attributed to the bound agent: on its own for an unanswered question or any dependent of a cancelled decision; any other answered decision needs `quoted` |
| `roadmap_block_accept` | accept the open block with the human's `quoted` consent; only a chat bound to an agent; the same transaction and continuation as the panel's Accept |
| `roadmap_grill_propose_finish` | the session's planner only: record a finish proposal (summary, active skipped and out-of-scope numbers); closes nothing |

Every write tool takes `expectedRevision` and returns the new revision. Deliberately absent:
approve, finish a session, skip, ticket create, ticket close, delete anything. Tool descriptions tell the agent that
answers it records on the human's behalf must quote the human and that approval happens only in
the Paseo UI.

Authentication vs attribution: the only authentication is the signed URL, which binds the call
to one `storeRoot`/`projectId`. For answers, `agentId` and quoted human text are attribution labels
stored in `Answer.actor`/`Answer.quoted`; they grant nothing. Since R3.2 a bound grant supplies the
recorded `agentId`. Since automatic grilling, a bound grant's `agentId` also selects the session
planner: the first `roadmap_ask` by a bound chat into a session without a planner binds that chat,
and a bound `roadmap_plan_draft` binds the drafting chat as planner of every grilling session it
creates. Other chats keep their write access and never change the binding; only the UI rebinds. For the R3.4 run tools (§7), the server-bound
grant's `agentId` and `workspaceId` determine coordinator and crew authority. No undocumented identity header is
assumed; the hook records which agent ids received which URL in plugin-data for attribution.

Existing agents: the `agent.create` hook cannot attach tools to agents created before the plugin
was enabled or before `.decisions/` existed. Task 2.0 of the plan is a bounded evidence task on
the supported attach/reconnect path (e.g. `agent.session_open` scope, `update_agent`
configuration, or a documented limitation). Until then the documented workflow is: initialise
the roadmap, then create the agent. Endpoint port: on start, reuse the persisted port, fall back
to a fresh port on `EADDRINUSE`, persist the new state, and re-derive URLs; already-created
agents with the old URL are reported in `paseo plugin logs` as needing recreation.

### Redesign Stage R0 tools

| Tool | Purpose |
| --- | --- |
| `roadmap_feature_create` | append a feature card, attributed to the agent (`agentId` from the bound grant, or `"unknown"` when unbound) |
| `roadmap_feature_update` | edit card text and/or replace dependencies in one write |
| `roadmap_feature_list` | read only: every feature card in roadmap order, the start delegations and the current revision; the project comes from the grant |
| `roadmap_dod_template` | read only (Stage R2): the effective DoD template `{ source, text }` (file `dod template.md`, then project, then global settings), the same result as `dod.template.get`; guidance for the agent's tailored DoD proposal, never applied by itself |

`roadmap_ask` takes an optional `blockId`: a session that uses blocks requires the id of its open
block, and a `blockId` on an empty session starts its first block. A block is accepted from chat only
through `roadmap_block_accept`, with the human's quoted consent and a bound agent; a refusal is
checked after the revision, writes nothing and is never recorded as a human acceptance. No tool
deletes, reorders or sets a feature status. The feature tools list cards, and create and
edit them only as work the human asked for; they start nothing and run no work.

### Automatic grilling tools and pause contract

| Tool | Purpose |
| --- | --- |
| `roadmap_pause_instructions` | read only, mints nothing: the advice for the calling chat in the current operation's state; the exact pause instructions only while the card is awaited (`awaiting_pause`, `accepted_awaiting_pause`); a do-not-pause notice for any other chat and for a session without blocks |
| `roadmap_grill_complete` | `{ expectedRevision, sessionId, operationId }` (the raw `operationId`, not the `DR-OP-` token); only the session's planner (`planner_bound` otherwise); refused (`invalid_input`) for a planner bound by a discussion or a session with a finish proposal, which only the owner's Finish closes; accepted for the current operation while its card is not shown yet (`awaiting_pause`, `accepted_awaiting_pause`) or after the summary was delivered (`resumed`), else `stale_operation` (with `{ state }` when the session has a current operation); closes the session |

Two different result shapes share the name `grilling`:
- `SessionView.grilling` (`GrillingView`, from `session.get`): the panel status (`status`,
  `manualRecovery`, `reason?`, `operationId?`, `plannerAgentId?`, `epoch?`).
- The MCP `grilling` value of `roadmap_ask` and `roadmap_pause_instructions` (`AskGrilling`):
  `{ operationId?, state?, instructions }`, the text a chat should follow.

Flow:
- A batch into an active, planner-bound session with blocks keeps the operation that waits for the
  card of the current open block, or starts a new one (the planner's own batch into a newer block
  replaces a previous live operation as `superseded`, reason `block_advanced`).
- Only the bound planner receives the pause contract: show exactly one native question with the text
  `Decision Roadmap: waiting for block acceptance (DR-OP-<operationId>)`, header `Roadmap`, options
  `Continue` and `Stop` in that order, single-select. Any other chat gets a do-not-pause notice.
- **Accept block and continue** in the panel freezes the block and answers the planner's card once
  (immediately if it is shown, otherwise as soon as it appears) through the public `respondToPermission`
  with a plain-text summary of the accepted block (session numbers, §7 "Feature discussion contracts";
  block ids and titles are JSON-encoded). The planner continues in the same chat; the summary appears
  as the resolved question card, not as a user message. The same summary is stored on the block.
- Nothing else continues a chat automatically: ordinary answers, re-answers, confirmations, skips,
  notes, edits and relation changes never wake the planner. The plugin sends a message only on an
  explicit owner action (the discussion prompt after Discuss, **Retry** and **Clarify in chat**) and
  in one other case: the automatic continuation of a chat bound by Discuss after an Accept it cannot
  receive through a card (§7, at most one message per accepted block). It never runs or denies
  anything, and never answers a tool, plan, mode or other question.
- Sessions that `roadmap_plan_draft` creates have no block yet: the planner's first `roadmap_ask` must
  pass a new `blockId` to start the first block (without one the session stays legacy and no automatic
  pause starts).

Supported planner chats (decided from the host snapshot, never from a handler's existence):

| Provider | Native pause | Supported |
| --- | --- | --- |
| Claude | `AskUserQuestion` | in every mode Paseo exposes |
| Codex | synchronous `request_user_input` | only with the Plan toggle (`plan_mode`) on; Default mode is unsupported |
| OpenCode and others | — | not claimed (unsupported) |

Recovery and limits:
- When the pause is missing, unsupported, answered in the chat, mismatched or lost, the panel shows the
  reason with "Continue the conversation in the chat, or bind another chat.", except while the
  automatic continuation of a chat bound by Discuss waits or was sent. Such a chat is told, through the
  `grilling` instructions, that the plugin sends it the accepted block's summary as a message, never
  that the owner continues it manually. Reopen of a completed session is manual; the chat's next batch
  starts a new operation.
- A daemon restart ends a waiting card; the operation becomes `pause_lost`. A plugin reload keeps
  pending cards and reconciles them.
- A failed store or host read after a claim leaves the operation `resolving` until the next host event
  for that chat or the next plugin start reconciles it. The answer budget is 3 durable claims, not
  exactly 3 calls: a claim taken just before a shutdown may never be called, and a later reconcile at
  the cap records `needs_manual` (`answer_failed`). An answer call already issued cannot be revoked;
  shutdown waits for it at most 30 seconds and records nothing for it.
- Evidence: the hook, permission and agent-list contracts were checked statically against the
  installed Paseo 0.12.0 SDK and daemon and by typecheck. Runtime behaviour on an unpatched upstream
  0.15 host is not yet proven (acceptance step). No Paseo fork, daemon change or dependency change is
  involved; pinned dependencies are unchanged.

## 9. Settings (shared/settings.ts, host scope)

```ts
// settings id "tracker", version 2
{ provider: "none" | "snailorbit", mode: "dry-run" | "live", projectKey?: string,
  closeByProject: Record<projectKey, { field: string; value: string }> }
```
Defaults: `provider: "none"`, `mode: "dry-run"`, `closeByProject: {}`; a version 1 document is
migrated by adding `closeByProject: {}`. MCP injection has no setting: it is
on for projects with an enabled roadmap and off otherwise (Q2).
Transport-specific fields (endpoint, credential handling) are added by the stage 4 evidence task
once the SnailOrbit public API contract is verified; nothing secret is stored in settings.

```ts
// settings id "roadmap", version 2
{ dodTemplate?: string, repairCeiling: number /* 30 */, reviewCommand?: string,
  checkTimeoutMs: number /* 600000 */, reviewTimeoutMs: number /* 1800000 */,
  maxBuffer: number /* 10485760 */, baseRef?: string, coordinatorProfile?: string,
  discussionProfile?: string /* the profile Discuss creates feature chats with */,
  translationProfile?: string /* reserved: stored only, nothing translates */,
  discussionLanguages: string[] /* [] : languages Discuss offers besides English */ }
```
Version 2 only adds optional keys and the defaulted `discussionLanguages`; the migration keeps stored
version 1 and version 2 values unchanged.
Registered by the server in Stage R0; when the stored values are not valid the server uses the
defaults. Only `dodTemplate` is read in R0, as the global source of `dod.template.get` after
`<storeRoot>/dod template.md` (a regular non-symlink file) and the project text
`meta.settings.dodTemplate`; the first source found wins. Since R4.5a the "Decision roadmap"
settings screen edits every key:
- validation is `roadmapSettings.schema` itself;
- the draft is pinned to the revision it was read at, so a change made elsewhere disables Save and
  offers Reload (no overwrite, no retry);
- invalid stored settings show "defaults in use" with Reset;
- `coordinatorProfile` is chosen by profile id;
- there is no credential field. `reviewCommand` is an unrestricted local command string, and the
  screen warns not to embed credentials in it.
Since Stage R3 the runners read `repairCeiling`, `reviewCommand`, the timeouts and `maxBuffer`;
`baseRef` is the branch-off base and `coordinatorProfile` the profile for delegated starts.

## 10. Client UI

Workspace panel `roadmap` (`context: "workspace"`, `locations: ["workspace", "explorer"]`), a
Command Center item "Open decision roadmap", a client slash command `/roadmap`, and two settings
screens ("Decision roadmap tracker" and, since R4.5a, "Decision roadmap").

`/roadmap [features | runs | feature <id or title> | question <link or Q<n>>]`:
- it leaves a client-only pending route scoped to `{ workspaceId, projectId }` (one-shot, 30 s TTL),
  then calls `openPanel`, because the SDK's `openPanel` carries no route;
- the panel takes the route on mount and while open (through a subscription);
- `features` and `runs` open the roadmap screen; a feature resolves by id, else by a unique
  case-insensitive title, otherwise the roadmap opens with a notice;
- `question <link>` keeps the link's kind and pinned revision and opens its session, where the link
  is resolved once the view loads. A link whose project differs from the panel's is refused,
  whether it comes from the route or is pressed in a session, even when its session id matches the
  open session; the notice shows on whatever screen the panel is on and nothing navigates. An
  unknown number shows a notice in the session screen. `question Q<n>` resolves against the
  session open in the panel, else asks to open a session first;
- no RPC writes. Everything is built from `View`, `Text`, `Pressable`, `TextInput`,
`ScrollView`/`FlatList`, `Modal`, `Icon`, `useToast`.

The panel keeps a back stack: overview → roadmap → feature → plan, overview → plan, overview →
session (a link to another session's decision pushes that session), and feature → feature (the
dependency and related links on the feature detail). The roadmap and feature screens show a
back control also while their data loads or after it failed; the session header with its back
control stays above the session's loading and error states; the plan screen shows a back control
on a load error but only "Loading…" while it loads. This section describes the shipped code and
its tests; live UI acceptance (wide/compact, light/dark) is recorded separately and is not
claimed here.

- Overview: list of sessions with status counts and plans with approval state, "New session",
  and "Roadmap"; "Initialise roadmap" when the store does not exist.
- Roadmap: the feature list with status chips and per-feature actions ("New feature",
  "Move up"/"Move down", "Dependencies", "Resume", "Defer", "Delete" and the others the status
  allows). Since R4.4, each row has a progress line built from `run.list`:
  - the single live run, else the most recently ended one;
  - verified/total from that run's own `planRev`, with "run rev N · plan now rev M" on a mismatch;
  - "Not started" when the feature has no run;
  - "delegated" or "delegated · unauthorised" for a delegated live run.

  A "Start delegations" strip lists the active delegations with Revoke.
- Feature screen (R4.2), in five regions:
  - a fixed header: back, title, and on wide layouts "Changes";
  - the stage strip (Questions, Plan, Tasks, Execution; see the stage strip below);
  - a fixed run bar: run state and reason, and "Start…", "Pause run", "Resume run",
    "Replace coordinator…", "Stop and rework…";
  - the scrolled feature summary: status, status reason, the replacement line, card actions;
  - the task list: "Accept" for a task awaiting human acceptance after checks and review, and
    "Grant extra cycles".
  - Wide: tasks on the left, the coordinator chat on the right, and a "Changes" header entry that
    switches the left region.
  - Compact: "Tasks", "Chat", "Plan" and "Changes" segments.
  - Run-scoped writes carry the run token.
  - Unknown reads are not shown as facts: while the bound plan or the shown run has not been read,
    the task area shows a loading or read-error line. Plan-read availability gates Start and
    Stop and rework; run-read availability also gates Start. An unknown run alone does not disable
    Stop and rework. With several bound plans (a readable stored state on which redraft,
    `plan.approve`, `plan.rework` and run start fail closed) no plan is read: the task area says
    so, and Start
    and Stop and rework are disabled for that reason. Pause and Resume follow the live run only.
  - The chat (R4.1) is the bound coordinator's only, with send, that coordinator's permission
    answers, Pause/Resume and "Reload chat".
  - Changes is the plan revision comparison: the exported `DiffView` and `RevisionCompare` from
    the plan view, with the latest revision shown and no comparison preselected. It is never a code
    diff and uses no extra RPC.
- Session screen: a header (back, title, the Chat menu and "Open chat"; for a feature's question
  session the stage strip) above a body of bounded height (`flex: 1`, `minHeight: 0` down to the
  content). Wide: one title row; compact: back and the title on one row, the Chat menu and "Open chat"
  on the next, so the title is never squeezed. "Open chat" (an icon button) calls the host's
  `navigation.openAgent` for the bound planner and is absent without host navigation or a planner.
  The Chat menu trigger reads "Chat <Grilling|Map>"; its accessibility label is "Chat menu: " and the
  items it holds now, in order ("view mode", then "finish discussion", "bind chat" or "change chat",
  "retry", "reopen" and "roadmap tools" when shown), with the tools' state added when they are not
  attached (with a warning dot). Its items: "Grilling" and "Map" (radios, no RPC); for a
  session with blocks "Finish discussion…" (an active session; a confirmation, then `session.finish`
  with basis `manual`), "Bind chat…" / "Change chat…" (the planner picker, shown under the header in
  a scroll region of bounded height: 320 px, 220 px compact; focus moves from the menu to the trigger,
  then into the picker, to its first chat or, while chats load or with none, to "Cancel"; closing the
  picker returns focus to the trigger), "Retry" (below) and "Reopen" (a closed
  session); and the roadmap tools state with its explanation. Wide, the menu is a card under the
  trigger: Escape and a press outside close it (the outside layer is pointer only, `tabIndex -1`), it
  closes when focus moves out of it, focus moves to its first item on open and back to the trigger on
  dismissal. Compact, it is a host `Modal` sheet. The Retry item has one wording per state: disabled
  with "Nothing to retry", "Sent at …" or "Delivery unknown since …: check the chat"; enabled with the
  interruption warning, or "Resends the accepted summary to the chat".
- Grilling (the default body, `client/grilling-blocks.tsx`): notices under the header that stay
  visible with the menu closed (the planner status line, the manual recovery hint, "Roadmap tools:
  <state>", the retry line, the delivery-unknown warning with "Check chat", "Mark as delivered" and
  "Mark as not delivered", the interruption warning while Retry is enabled with one, and the closure
  line below) and the language notice with "Got it". The same notice row (`SessionNotices`, without
  the language notice) is drawn above the Map in the Map view, so it stays visible under the stage
  strip in both views (plan r4 §2.1), once per view, its controls acting on that session only. On the
  compact Map the row is in its own vertical scroll region ("Session notices"), at most a third of the
  window's height (kept current on a resize or rotation) and never more than 200 px, and the row and
  the Map share one outer vertical scroll region. The Map below the row has a measured height: the
  room left under the row, but never less than the region's height or 320 px, whichever is smaller.
  A short row leaves the Map exactly the rest; a long row (an unknown delivery with its three
  controls) makes the region scroll, and scrolled past the row the whole Map (toolbar and graph) is in
  view, so the graph never has zero height there. That outer region is a registered tooltip boundary,
  like the Grilling canvas: a tooltip of a toolbar control is placed against it and hides once its
  control has scrolled out of it. Go to open Block, a selection (a node, a List row, a Find pick, a
  detail row), an overview press and Fit also scroll that region to its end (`onReveal`), where the
  whole Map is in view, so the target the graph scrolls to is visible even when the region was
  scrolled part-way; only the owner's actions do, never a layout; then
  the canvas and a blocks-only navigator
  (wide: a 240 px column beside the canvas, each scrolling on its own; compact: a sideways row above
  the canvas in one scroll region with it, which scrolls to keep the shown block's item in view). A
  navigator item is "Block n", its state and "k questions · Qa–Qb" (non-contiguous numbers as
  "Q1, Q3", four at most, then "…"; "No questions yet" when empty); a legacy session has one "All
  questions" item. While an active session has an open proposal, a separator and the "Finish
  proposal" item ("Not accepted yet", or "Proposed again <time>" when `finishHistory` ends with an
  unfinished proposal) follow. The open block is shown by default and after a successful accept; a
  failed accept keeps the selection.
- Block canvas: the heading "Block n" (or "All questions"), the state chip, the question count and the
  "Summary" icon button; one card per active question of the block, in order; for an empty block "No
  questions in this block yet." and, for the open block, a line from the session state (closed,
  complete, a proposal, the automatic continuation waiting, a summary being sent and not confirmed,
  sent, unknown, failed, no chat, manual recovery, or "Nothing has been added here yet") that never
  promises more questions; the add row and form (below); for an accepted block "Block n is accepted.
  Questions are added to the open block."; under the open block a line that "Accept block and
  continue" accepts it as it is, and that button (hidden when the session is closed or grilling is
  complete); the hidden questions section. A link target (from `/roadmap`, a question link or a
  relation link) selects its block, outlines the card for 1.5 s and scrolls the canvas to it,
  measuring the card against the scroll content (`measureLayout`; only the latest request's answer
  may scroll, so an answer for an earlier target never ends the scroll there; React Native Web answers
  in request order and never calls the failure callback, native order is unverified); when that fails, the cards'
  reported offsets in the shown block are used at once if known, else at the next layout report, and
  the request does not measure again (offsets are reset whenever another block is shown); a hidden target opens the hidden section; an unknown one keeps the selection.
- Question card (`client/question-canvas-card.tsx`): the title row `Q<n> <title>`, on the first card
  of the block shown (the canvas shows one block, so once on screen) the "Language: …" chip and "About the language", the status word and "Edit"; the recorded answer
  only (the chosen option with "Recommended" when it is the recommendation and "✓ Chosen", a free-text
  answer tagged "free text", "No answer yet.", or for a skipped or out-of-scope question its status
  and, with an earlier answer, that it is kept as history), its note, the stale cause, "Cancelled:
  <reason>". "Edit" opens the answer panel (options with the recommended one first, preselected on an
  unanswered question, an unchanged submission sending `defaulted: true`; free text if allowed; a note
  stored as `Answer.note`; "Answer", "Confirm" for a stale answer, "Skip", "Out of scope") and reads
  "Cancel" while it is open; it stays available on an accepted block and is disabled for a cancelled
  decision. "Description" shows `question.context` (absent when empty); "Why recommended" shows the
  recommended option's `description` (absent when there is none). Relation links, one per kind,
  direction and target: "Depends on Q<m>" (activation and invalidation parents), "Needed by Q<m>"
  (dependents within this session only), "Informs" / "Informed by", "Supersedes" / "Superseded by".
  A parent that both activates and invalidates the question gives two entries on each side, "Depends
  on Q<m> (activation)" and "Depends on Q<m> (invalidation)", and "Needed by Q<k> (activation)" /
  "(invalidation)" on the parent;
  another session's question reads "<session> / <question>" and opens that session; a bare session
  end reads "session <title>"; a target that no longer exists is plain text. A stored link from the
  question to itself (the store accepts one) is one entry, "Informs Q<n> (itself)" or "Supersedes
  Q<n> (itself)", whose target is the question itself. "More" lists "Copy link",
  "Copy answer link" (with a current answer), "History" (a modal; a pinned revision opens it), "Edit
  question" and "Relations" (editable questions only), "Clarify in chat" (a bound planner, an active
  session, not cancelled) and "Cancel decision" (a required reason and a confirming press, at the
  revision pinned when it opens). Edit, More, the disclosures and the relation links draw 24 px and
  keep a transparent 44 px target (negative margins keep the drawn height in the layout).
- Add question: under the open block, the row "Add question to Block n" (in a legacy active session,
  "Add question") opens a form with "Question" (trimmed, at least 5 characters, not a case-insensitive duplicate of
  an active title of the block, or of the session in a legacy session; the error reads "Q<n> in this
  block already has this title." or "… in this session …") and "Answer (optional, free text)"; "Add" sends one `question.create`
  with `options: []`, `allowFreeText: true`, `context: ""`, no relations, the open block and
  `answerText` when given, at the rendered revision, and is disabled while pending. Cmd/Ctrl+Enter
  submits, Escape and "Cancel" close the form and return focus to the row. A `revision_conflict` keeps
  the draft with "The roadmap changed meanwhile" and, when the open block changed, "Block n was
  accepted; this question will be added to Block n+1" with the label "Add to Block n+1". A lost
  response keeps the draft, re-reads the roadmap once and says so; when an active question with the
  same title is then in the block, it names it with "Discard draft" and "Add anyway". Nothing is ever
  resent on its own. A create with an answer whose output has no `rev` says that the answer was not
  recorded. A reply belongs to the draft that was sent: Cancel and a new draft start a new generation,
  and a reply for an earlier one leaves the current draft alone (a success does not close it, a
  refusal or a lost response does not mark it; the lost response's re-read still happens). A late
  success whose answer was not recorded is told apart from the current draft: "The question
  "<title>" was added, but its answer was not recorded; answer it from its card.", an alert (live
  region) above the open form or under the add row, one line per question, kept through opening and
  sending other drafts until the owner presses "Dismiss"; it is held only by the screen, like the
  draft. Cancel stays enabled
  while a create is in flight (the plan does not settle it); that create is not withdrawn, and Add on
  a new draft waits for it. The session screen holds the form's state and its one `question.create` (keyed by host,
  project and session, never stored in the host tab or elsewhere), so Grilling → Map → Grilling keeps
  an unsent draft, a refusal or lost response with its notice, and a request in flight (Add stays
  disabled; its late answer lands); it also keeps the chosen block and the last link target applied
  (plan §12.7), so the return neither resets the choice nor applies an old link again.
- Finish: the "Finish proposal" item shows a canvas with "Finish proposal · from the chat · not
  accepted", "The chat proposes to finish", the full summary, "Skipped: … · Out of scope: …", the
  proposal time and "Accept finish proposal" (`session.finish` with basis `proposal` and the shown
  `proposalAt`). The menu's "Finish discussion…" opens a confirmation ("Closes this discussion on your
  own decision. The chat's open proposal, if any, is kept as not accepted.") with "Cancel" and
  "Finish discussion" (basis `manual`). The screen holds one `session.finish` request, so neither
  entry can send while the other is pending; neither approves a plan or starts anything. The closure
  line comes from the last closure only: "Closed <at> · by accepting the chat's proposal of <time>",
  "Closed <at> · manually" (with "; the chat's proposal of <time> was not accepted" when that close
  marked a proposal `finishedBy: "manual"`), "Closed (basis not recorded)" for a closed session whose
  last closure is absent or already reopened (except a legacy session with neither blocks nor
  closures, which shows no closure line; the feature's stage strip still says "closed (basis not
  recorded)" for it), and "Reopened <at> · previously closed <at> (<basis>)" for an active session
  whose last closure was reopened. The chat's `roadmap_grill_complete` closes a session without a
  closure record (by design); its completed continuation, current or archived in `continuations` by
  the chat's next batch, keeps the time. When that completion is later than the last recorded reopen
  (or there is no closure), the active session's line is "Reopened (time not recorded) · previously
  closed <at> by the chat completing grilling": the reopen that undid it is not stored, so no reopen
  time is claimed and the older owner closure is not named as the latest.
- Map (`client/map-layout.ts`, `client/map-view.tsx`): see "Map" below.
- Plan view: revision list with hash prefix, Markdown rendered as plain `Text` blocks, "Compare
  with revision N" showing a diff, a task preview (dependency titles from the shown revision),
  "Approve revision N" only for the latest revision with its approval blockers next to it,
  approval badge and not-current reasons, task list with status controls, "Preview tracker
  actions" opening a confirmation modal that shows exact payloads and the live/dry-run mode
  before "Apply". "Edit DoD" (a feature-bound plan's latest v2 revision) opens the DoD editor:
  per task the DoD text, an inserted template and the grill checkbox; saving drafts a new,
  unapproved revision.
- Freshness: `roadmap.version` polled every 3 s while the panel is mounted; data queries are
  invalidated when the revision changes or after any mutation (and after any refused Discuss or
  Retry, which may have recorded a failed or unresolved creation, or a failed, unknown or still
  sending retry).
- Discuss controls (feature cards still being shaped): "Discuss" (default profile, else a profile
  choice with "Set a default under Settings"), "Discuss with…" (the saved profiles), "Open
  discussion" for a bound chat. A creation in progress, unresolved or failed is stated; only "I
  checked: no chat was created. Create it again" sends `retryUnresolved` with `confirmedNoChat`.
  After Discuss a toast states a pending, not attached or unknown tools state in those terms (issued
  and waiting for the session; no current grant, without claiming none was ever issued; cannot be
  determined).
- Hidden questions: inactive questions get no card on the block canvas (the navigator lists blocks
  only), and every hidden question of the session is listed read-only below the shown block's cards
  in "Show hidden questions (n)", closed by default, with its activation condition ("Shown when Q3 is
  Option B"); a link to one opens the list.
- Plugin-rendered links: `roadmap://` links and `Q<n>` in answer notes are link-role controls in the
  session screen. A question timeline row offers "Open in roadmap" and "Open current answer"; a
  "decision-references" row (kind version 1, data `{ projectId, turnId, refs }`, at most 20) lists the
  references of an agent's turn with live titles and "Open", or "no longer available"; a pinned
  answer link is named as "answer rev k from history" with whether it is still the current one. These set the
  pending route for the agent's workspace and call `client.openPanel`, captured at contribute time.
  Host-rendered chat message text is never made clickable: the SDK offers no hook for it.

### Automatic grilling header and planner picker

For a session with blocks the notices under the header show a status line `Planner: <chat title or
agent id> · <status>` (or `No planner bound`) and, when the owner must act, the manual recovery hint.
Actions: **Accept block and continue** under the open block (hidden when the session is closed or
grilling is complete), and in the Chat menu **Bind chat…** / **Change chat…** (opens the planner
picker), **Retry** and, for a closed session, **Reopen**. The owner's **Finish discussion…** is offered
in any active session with blocks. The picker lists one page (up to 200) of this project's chats on
the panel's host, excluding archived and internal ones, marks the current planner and rebinds through
`session.planner.set` at the shown revision; a failure keeps it open. The picker also closes when the
session closes. Bind chat… / Change chat…, the picker and Reopen send, run or answer nothing in a chat;
Accept continues the chat through the plugin's single answer to the planner's pause card. Legacy
sessions show none of this.

The notices also show:
- for a discussion planner, "Roadmap tools: attached | pending | not attached | unknown" from
  `GrillingView.tools` (the explanation of the state is in the Chat menu);
- no language line: the first card of the shown block shows the chip "Language: <language>" from `Session.language`
  (English when absent), or for a session started before it was stored, from the answer of the
  question tagged `language` (a legacy session without blocks or such a question shows none). Any
  language other than English shows, under the header, the notice that recommends English for the
  questions and says that no translation is performed, with "Got it"
  (`session.language_notice.ack` at the shown revision) until `languageNoticeAck` names that label;
  "About the language" shows the text again in a modal;
- under manual recovery with a bound planner, the outcome of "Retry": one `discussion.retry` per
  press of the menu item, nothing on render. While Retry is enabled the interruption warning is shown:
  definitely when the host's client state reports the chat `running`, as a possibility when the state
  is unknown, and not at all for a known idle chat. A sent retry shows "Retry sent at …" (or
  "Continuation sent automatically at …"); an unknown outcome shows "Delivery outcome unknown since …"
  with "Check chat", "Mark as delivered" and "Mark as not delivered", and never resends;
- the closure line (above);
- per block, the "Summary" icon button in the canvas heading (disabled when the block has neither)
  opening a modal with the open block's preview, or the summary at acceptance and, after changes,
  "Answers changed after acceptance: Q…; the chat was told the earlier values" with "Current answers"
  (or the no-snapshot wording); Copy copies the shown text and closing returns focus to the button. A
  changed block keeps the short "Answers changed after acceptance: Q…" line beside the button.

The session screen of a feature's question session and the feature screen show the stage strip
(Questions, Plan, Tasks, Execution; `client/stage-strip.ts`). The workflow current stage is the
furthest with entry evidence (executing or a live run; the single bound plan's latest revision
approved and current from `plan.get`; a bound plan; else Questions); a done feature is past Execution
and, like a deferred or cancelled one, has no current stage. Each stage's completion is its own
evidence only, never the feature's status alone, except Execution, whose evidence is the feature's
`done` status itself: Questions, a closed session, with the detail from
its last closure ("finished by the owner manually", "finished by the owner on the chat's proposal",
or "closed (basis not recorded)" when the last closure is absent or already reopened); Plan, the
current approval of the single bound plan; Tasks, a live run of the bound plan's latest revision or
an ended run of that revision whose `endReason` is `finished` (a finished run wins over the other
ended runs of that revision; otherwise an ended run without an `endReason` makes Tasks unknown, and
one cancelled for rework or with the feature is not completion and says so; with both kinds of
cancellation and no finished or unrecorded end, it names the cancellation with the feature);
Execution, a done feature. A loading or failed read is unknown; later stages are disabled; the viewed
stage is marked and "Viewing an earlier stage" disables nothing. The strip has no approval or start
control. It is one row of four cells scrolling sideways when needed, each a 10 px square mark (filled
when complete, outlined in the success colour when current, muted when open, dashed when unknown),
the stage name and a state word (Done, In progress, Not started, Loading, Read failed, Unknown);
wide cells are 136 px on one line, compact cells share the row with the mark above wrapping words.
The viewed cell has a 2 px bottom bar in the theme's success colour (the approved mock's green
`--accent-bar`), `accessibilityState.selected` and `aria-current`; a disabled
cell keeps opacity 0.45; a later (upcoming) stage also has the hint "Complete the previous stage
first" and `aria-describedby` naming the line under the strip that lists those stages. Questions is
also disabled when it cannot be opened from the feature screen (no grilling session, or no session
navigation from the host); that cell has neither the hint nor the line, since completing a stage
would not enable it. The accessibility label stays "<stage>:
<state>, <detail>". Every control declares a 44 px target; icon buttons show their label as the
accessibility label and their hint as the accessibility hint and a plugin-owned tooltip (hover,
keyboard focus, long press; hidden on hover out, blur, release and Escape). The focus a tap or click
leaves on the web shows none: a focus whose target is not `:focus-visible`, or (where that cannot be
asked) one after a touch press, is a pointer's. The bubble is not interactive (`pointerEvents`
none) and wraps its text at up to 240 px, inside a transparent box of that width, shifted left to stay
in the clipping region or window. React Native Web makes every View a stacking context, so a bubble
beside its control would be painted under content drawn later; it is drawn in a tooltip layer
instead (`client/tooltip.tsx`, `TooltipLayer`): an absolutely positioned, full-size View rendered last
in the panel root, in each plugin sheet (`FocusScope`), and in the content of a host `Modal` holding
a control with a tooltip (the block Summary modal's Copy), since the host portals sheets and modals
above the panel, `pointerEvents` "box-none", holding at most the one shown bubble (`pointerEvents` "none"). It is
not a dialog, takes no focus and no presses. The bubble goes to the latest-registered layer whose
measured frame (`measureInWindow`) holds the control's centre, so a hidden panel or tab (measured
empty) is never used; its position is the control's window rectangle minus the layer's, kept inside
the layer. Above or below is decided against the clipping region (or window) and the layer's frame
together, so a layer that ends with its host modal flips the bubble above a control near the modal's
bottom; once drawn, the bubble's height (several lines for a long hint) is checked against the
layer: it moves to the other side of the control when it does not fit on its own and the other side
does, else it is clamped inside the layer (then it may cover the control). The height is kept for
later placements of the same tooltip. With no layer that fits (a control rendered outside the panel), it is drawn beside the
control as before, its wrapper raised over its row. On the web a scroll anywhere (a captured listener,
detected) and a window size change place it again, at most once a frame; a control that showed its
tooltip inside a registered clipping region and has since left that region (scrolled out of the
canvas) hides it instead, since the layer does not clip; a change of the layer's own size hides it; a press anywhere still hides it. The host `Modal` (a titled dialog) and React Native
Web's `Modal` (which traps focus) are not used for it.

### Map

`mapModel(view, { showInactive?, collapsed? })` (`client/map-layout.ts`, pure) builds the Map from
the session view only:
- Nodes: each question of the session (inactive ones only with `showInactive`, on by default), and
  one stub per distinct other-session end named by this session's relations or links: a catalog
  question as "<session> / <question>", a missing one as "a question that no longer exists" (not
  pressable), a bare session as "session <title>" or, when the catalog has no question of it,
  "session <id> (title unavailable)". A bare end naming this session, with a question or another
  session at the other end, is a note on that end's lane ("Informs this session: …", "Informed by
  this session: …", and the same with "Supersedes" / "Superseded by"), never a node. A link from
  this session to itself is a note above the map, "This session informs itself (a stored session
  link)." (or "supersedes"), never a node or a lane note.
- Lanes: the blocks in order ("Block n · <state> · k questions"), or "All questions" for a legacy
  session, and "Other sessions" for the stubs. No other grouping is used. A block's lane key is
  `lane:<block id>` for any stored id ("external" and "all" included); the legacy and Other sessions
  lanes have keys without that prefix (`all-questions`, `other-sessions`), so no block id names
  them.
- Columns: the server's `depth`, which counts parents across sessions (never shallower than a local
  parent's column + 1); a stub that is a source of a local node sits at `max(0, min(target columns) −
  1)`, a target-only stub at `max(source columns) + 1`. Rows: by the barycentre of placed
  predecessors, then by order. Nodes are 184×60 with 72 px rows, a 150 px lane header and 16 px
  between lanes; the gutter before each column is at least 78 px and the routing track under each lane
  at least 16 px, each widened to hold its runs (below).
- Edges: one per stored activation (with its option ids), invalidation, `informs` or `supersedes`
  link with an end in this session; only exact duplicates (kind, endpoints, condition) collapse.
  Relations between two other-session questions are not in the view, and the model says they are not
  shown. An edge whose target column is not after its source's is a back edge; links take no part in
  columns and may form cycles. Edges between lanes are flagged cross-lane. A stored link from a
  question to itself is one edge from its node to itself, a back edge drawn as a loop: it leaves the
  node's right side 10 px below its centre, runs down a slot of the gutter after it into its lane's
  track, back up a slot to the right, and enters the right side 10 px above its centre, where the
  arrowhead points into the node. The detail lists it once, under "Leads to" ("Q<n> · informs
  itself" / "supersedes itself"), and the node's label counts it once, as outgoing. A hidden inactive
  question's self-link is hidden with it, another session's self-link is not in the view, and inside
  a collapsed lane it is counted among the edges between collapsed lanes that are not drawn.
- Routes are orthogonal: vertical runs lie only in gutters, long horizontal runs only in the target
  lane's track, and the short horizontal stubs only inside a gutter, on the row of the node they
  leave or enter, so no segment crosses a node; forward edges enter the target from the left, back
  edges from the right. An edge to the next column runs in the gutter between the two columns (a
  straight line when both nodes share a row); any other edge runs down the gutter after its source,
  along the target lane's track, and up the gutter before its target (after it, for a back edge).
- Slots are assigned before coordinates. In a lane's track, runs that span a common gutter take
  distinct slots 3 px apart. In a gutter, vertical runs whose spans overlap or come within 4 px take
  distinct slots 4 px apart, so no two edges share a vertical run. A gutter or track is widened to hold
  its slots, and columns and lanes follow from those widths.
- Each gutter orders its vertical runs, so the stubs of two different nodes never form a line that
  no edge makes. On a row where both columns beside the gutter hold a node, a run whose stub meets the
  left node (an exit, or a back edge entering it from the right) lies left of every other edge's run
  whose stub enters the right node; slots are packed in that order. Only an edge to the next column
  has stubs on both sides: on each row the edges leaving it must lie left of the edges entering it,
  which is possible exactly when these edges, read as arcs between rows, form no cycle. One greedy
  feedback-arc-set pass (Eades, Lin and Smyth; deterministic) ranks the rows; the edges running
  against that rank (none when there is no cycle) are routed through the target lane's track
  instead, and the rest are ordered by their source row's rank. Rows are fixed before that choice.
  Dense crossings make wide gutters and tall tracks: a gutter grows with the edges that need slots in
  it.
- Edges that leave or enter the same node, or the same port of a collapsed lane, may share the stub
  at that node's side; no other two edges share a line.
- `collapsed` lanes keep one node row (with the lane header beside it and the lane's port in it when an
  edge reaches the lane) and their track; an edge between one of their nodes and a shown node ends
  at the lane's port ("→ Block n (k edges)"), and an edge between two collapsed nodes is not drawn
  (the model notes how many).

`MapView` (`client/map-view.tsx`) draws it with plain `View`s (no SVG, no DOM): lane bands, edge
segments in the kind's line style (activation solid accent, invalidation dashed, `informs` dotted,
`supersedes` solid warning) with a chevron pointing along the final segment, a kind glyph on
cross-lane edges (▸, ⊘, ⓘ, ⇢) so the kind does not rest on a dash style alone, and nodes (title,
"Q<n> · <status>", dashed for inactive and external, struck through for a cancelled decision). The
world is scaled by `transform: [{ scale }]` with `transformOrigin: "top left"` inside a wrapper of
the scaled size, in a vertical `ScrollView` holding a horizontal one, so native scrolling pans it.
- Toolbar: "Zoom out" / "Zoom in" (icon buttons, − and +, with hints shown as tooltips; 50, 75, 100,
  125 %), "Fit" (the world fitted to the measured view,
  between 30 % and 100 %, then scrolled to its origin once the fitted world is drawn; it keeps no node
  or pressed point centred, and a selection or overview press made after it takes over), "Graph" /
  "List", "Show inactive" and "Find question" (toggles expose `aria-pressed`). In Graph mode, when the
  open block has a question on the map, a 44 px "Go to open Block <n>" centres that block's first
  question (in reading order) at the current zoom, expanding its lane first if it is collapsed; Fit
  and the first view are unchanged, so at Fit's 30 % floor a world wider than the view (a large map on
  a phone) can still open with the open block out of view until this is pressed. At 75 % and above a
  node is a button labelled "Q<n> <title>, <status>, Block <k>, <in> incoming, <out> outgoing" (an
  other-session stub names its session instead), except a missing stub ("a question that no longer
  exists"), which is static at every zoom, takes no focus and is not offered by "Find question"; a
  collapsed lane's port is a button labelled "→ Block <k> (<n> edges)" that expands the lane; at
  50 % and at Fit the world is an overview whose nodes are not pressable, and a press zooms to 100 %
  centred on the pressed point (from `locationX/Y`, or on React Native Web from the page coordinates
  and the wrapper's measured position). Compact opens at Fit.
- Selection dims non-neighbours, says "Showing Q<n> and its neighbours" with "Clear", and draws the
  activation conditions of the selected node's edges in the target lane's track: side by side, and on
  further rows when a row is full, so no two labels share a place. A lane whose rows need more room
  than its track grows at its foot by that much, and everything below it (lanes, nodes, ports, route
  points) moves down by the same amount, so labels stay inside their lane, clear of every node, port
  and header, for any number of rows; routes keep their shape (only vertical runs lengthen), the world
  grows by the total, and centring, Fit and scroll clamps use the grown world. The
  detail (a 320 px panel; a host `Modal` on compact) shows the status, the current answer ("No
  answer yet." without one; for a skipped or out-of-scope question "The earlier answer is kept as
  history." or "No answer was given."), "Comes after" and "Leads to"
  rows with the kind and condition (a row selects that node and expands its lane; another session's
  question or a bare session opens there; a missing target is plain text), "Open Q<n> in Grilling"
  (selects the block and outlines the card) and "Close". Closing it (also Escape and "Clear") returns
  focus to the node, or to "Find question" in the overview. The selected node, the open block's first
  question after "Go to open Block <n>", or the point an overview press zoomed to, is kept centred
  after any layout that moves it (the detail narrowing the world, a zoom, a lane expanding), with
  scroll targets clamped to the world, until the user pans: a wheel or touch drag, or a scroll event
  (scroll bar, keyboard) that moves the position while none of the map's own scrolls is under way,
  ends the centring, and later layouts keep the user's position. Each axis notes where its own
  `scrollTo` is heading, and both scroll views report every scroll event (`scrollEventThrottle` 1)
  besides React Native Web's end report, 100 ms after a run's last event at the same position. While
  a run is in flight, a report at the target, or at the target clamped to that event's `contentSize −
  layoutMeasurement`, ends it as the map's own; a report repeating the position before it, once the
  position has moved since that `scrollTo`, is the end of a run the user cut into (a keyboard or
  scroll bar pan cancels the smooth scroll) and ends the centring; any other report is a step on the
  way. A repeated position before the run has moved is the late end report of the run before (due
  just before the new run's first frame) and is ignored. A run that reports nothing for 1.5 s stops
  counting. A user's pan that ends exactly at the target cannot be told from the map's own scroll.
  Not modelled: classic scroll bars (`layoutMeasurement` includes them, so the clamp could fall short
  by a bar's width), a tab hidden mid-run, and native platforms, which have no end report. A new
  selection, Go to or overview press centres again.
- List writes every question with its relations in the card wording (activation and invalidation
  parents share "Depends on"); "Find question" lists every node but a missing stub, with a filter;
  both ignore collapse. Only the shown view is rendered, but the full model (`mapModel`, routes
  included) is computed in either mode, since the List and Find read its nodes and lanes; the
  collapsed graph is computed only while the graph is shown. Measured in Node at a6b10d1 on the large
  fixture: the full model takes about 7 ms at 410 questions and 25 ms at 1000, less than the List's
  per-row relations (19 ms and 71 ms), so the routes are not deferred.
- Above 120 nodes every lane but the open block's and the selected node's starts collapsed (a legacy
  session's single lane never collapses); a header or a port expands a lane, a header press collapses
  it again, and a selection from the detail, the List or Find question expands its lane. A header is
  a button with `aria-expanded` (and `accessibilityState.expanded`), at least 44 px high on screen at
  75 % and above (its height in the world is 44 px divided by the scale below 100 %). Ports are
  described (`aria-describedby`) by the visible note "Collapsed lanes show a header and a port (→
  Block n); press either to expand the lane.", shown under the toolbar while a port is drawn and the
  graph is not an overview. A List row's pick also closes Find question if it is open (the detail
  takes its place). On a wide layout a pick from Find question or a List row moves focus
  (without scrolling) to the picked node, or to "Find question" when the node is not a button there
  (the overview, a missing stub); compact leaves it to the detail sheet. Above 400 nodes the Map opens on the List with a notice.
  These thresholds are heuristics, not measured limits.
- Not done: pinch zoom, sticky lane headers, edge-crossing reduction beyond barycentre ordering and
  tracks, and condition labels on edges other than the selected node's. Rendering cost has not been
  measured on the host or a device.

### Keyboard focus and host-specific state

On compact screens the Paseo host observed at 0.15.3 renders a plugin `Modal` as a bottom sheet that,
on the web, moves no focus, keeps no Tab order, handles no Escape and portals its content (keys
pressed inside reach only handlers inside). The plugin's sheets (the Chat menu, the Finish
confirmation, Find question and the question detail) therefore move focus in once their content is
laid out: to the first control, or for Find question to its first question rather than the filter.
That focus uses `focus({ preventScroll: true })` on the web, so the host's container does not scroll,
and never moves focus the user already moved inside. The sheets also wrap Tab and Shift+Tab at their
first and last controls, close on Escape and return focus to the control that opened them. React Native Web's `TextInput` stops key
events, so the Find question filter handles Escape and Shift+Tab itself; when no question matches
the filter, the compact sheet holds only the filter, and Tab and Shift+Tab there are cancelled so
focus stays on it. On wide screens the host's
dialog handles the Finish confirmation's focus; the Chat trigger takes focus before it opens and
again after it closes. React Native Web drops `accessibilityState` and `accessibilityHint`, so
controls also pass `aria-expanded`, `aria-checked`, `aria-selected`, `aria-current`, `aria-pressed`,
`aria-disabled` and `aria-describedby`; an `ActionButton` that is `selected` (the feature screen's
Changes / Tasks / Chat segments, the discussion language and profile choices) carries `aria-pressed`. Native receives the screen reader's focus event
(`AccessibilityInfo.sendAccessibilityEvent`) and no key handling.

The host renders its compact and wide layouts through different trees, so a breakpoint change
remounts the panel. The Paseo host observed at 0.15.3 passes workspace panels a `tab` prop (`{ state,
setState, setModified }`) that the pinned SDK (0.12) does not declare. When present, the panel keeps
its screen stack there (kinds and ids only, under its own `decisionRoadmap` key, scoped to the host
and project, merged into a record state and never written over another shape) and restores it on
mount; each tab has its own state. Without it the panel starts at the overview, as before.

## 11. Delivery boundaries

**Feature discussion slice (this branch).** Its behaviour is covered by unit and integration tests
over temporary stores, synthetic host stubs and the installed SDK declarations; no live model turn,
plugin reload, native device or live UI acceptance is claimed. Any refused Discuss or Retry
refetches the session, since either may have recorded a creation or retry state first.

**Current validation status (end of R4, this branch).**
- The standard Vitest configuration caps the pool at two workers (`maxWorkers: 2` in
  `vitest.config.mts`). A plain `vitest run` with no override passes the full suite (1569 tests,
  88 files).
  - Earlier, with the previous four-worker cap, two I/O-heavy integration tests repeatedly exceeded
    the 5 s test timeout on the development host (historical).
  - The worker-cap change did not raise the 5 s timeout or exclude tests.
  - The exact contended resource is not proven.
- Lint is adopted: the configuration (`eslint.config.js`, typescript-eslint, correctness rules),
  the exact devDependencies `eslint` 10.13.0 and `typescript-eslint` 8.58.1 in `package.json`
  and the lockfile, and the `lint` script (`eslint .`). `npm run lint` exits 0 with 0 findings
  across its configured TypeScript scope, including the project-section implementation and tests.
- `tsc --noEmit` (both tsconfigs), both entry compiles and the Hermes parse pass with the adopted
  dependencies.
- The initial ordinary KensAI review completed with findings and partial coverage (five
  surfacing passes did not complete). Its confirmed corrections and added regressions pass
  independent local verification. A continuation over candidate `ff66131` also requests changes
  and has partial coverage: software-design, documentation and conventions did not complete.
  Its five verified defects, two prompt corrections and two test gaps now pass independent
  verification, including the approval recovery retry, actor attribution and no-gap timeline
  recovery. The subsequent DeepSeek continuation completed with full coverage and requested corrections.
  Its verified loading-state, replacement-binding and cancel/approval race fixes pass independent
  checks; the corrected exact-final gate remains pending.
- The cancel/approval race is covered by a deterministic real-store regression and seven
  per-project critical-section contract tests. The latest-ended-run task-state loading cases
  are covered as well. After the full 1569-test run, a final test-harness await correction
  passed all seven module tests, node typecheck and scoped lint; executable production bytes
  and every other test file remained unchanged.
- Installed SDK declaration excerpts, package versions and file hashes are available in
  `docs/research/2026-10-31-paseo-012-contract-evidence.md`. They are type-contract evidence,
  not a substitute for native-device or live-agent behavior.
- Candidate `ff66131` was installed in the synthetic QA container: all 259 tracked files match,
  and store data, approval receipts and host configuration remain unchanged across one plugin
  reload. Browser checks on that revision cover the corrected chat header and blocked Resume
  at 320/390/1440 px in light and dark, plus plan revision comparison and invalid settings drafts.
  These are desktop browser and synthetic SDK results, not native-device or live-model proof.
- The isolated integration preview was refreshed to `ff66131` and independently passes all
  1534 tests, adopted lint and both typechecks. Its runtime source matches the verified build.
  Those results name that candidate; later source corrections require their own pinned runtime,
  browser and integration evidence. Main remains unchanged; approval requires the final gate.


Distinct states, reported separately and never merged: (1) validation = `tsc --noEmit`, vitest,
the RN audit grep from the paseo-plugin skill; (2) review = Kimi read-only review of the diff
and KensAI gate on the exact final revision; (3) installation = `paseo plugin install
<worktree path>` (no daemon restart), the plugin listed and enabled under Settings → Plugins and
`paseo plugin logs decision-roadmap` clean; (4) UI verification = the panel exercised on the
desktop layout and on a compact viewport (Paseo browser tools against the web UI, resized)
with screenshots as evidence. The coordinator owns (3) and (4) and reports them with evidence;
the owner is asked only for decisions, for `mode: "live"` and for confirming each tracker batch
in the preview modal. Installing the plugin on the live daemon is a coordinator action under
the AGENTS.md rules (no restart, no approval-setting change).

## 12. Owner choices (settled 2026-10-20)

Q1 Store location: settled. One canonical project roadmap shared across all worktrees, resolved
through the registered Paseo project identity (§5); `manifest.projectId` must match the Paseo
`projectId`. Task 0.0 verifies the actual SDK behaviour for project root lookup across a main
checkout and a linked worktree before `resolveStoreRoot` is implemented.

Q2 MCP injection scope: settled. Inject only into new agents of projects with an enabled roadmap.
Existing agents are covered only by the Task 2.0 result (attach path or documented limitation).

No owner choices remain open. Tracker transport and credential handling depend on the verified
SnailOrbit API contract gathered in the stage 4 evidence task and are not owner questions.
