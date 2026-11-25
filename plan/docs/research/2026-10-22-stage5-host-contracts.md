# Stage 5 host contracts (installed Paseo 0.12.0)

Read-only evidence for the Stage 5 slash command, timeline renderer and timeline observer, taken from
the installed custom Paseo 0.12.0 (CLI and bundled server `@getpaseo/server` 0.12.0, with
`@getpaseo/{client,plugin,protocol}` 0.12.0; the project's `node_modules` declarations are
byte-identical to that install). Paths are package-relative. Line numbers refer to that build and must
be re-verified after a Paseo upgrade. Items marked "re-checked" were confirmed again while writing
this note; the others come from the accepted Stage 5 evidence and reviews and match the
implementation and its tests.

## 1. Slash command: one workspace command serves both composers

- The client plugin runner keeps one registry per plugin. `addSlashCommand` keys commands by the
  trimmed name only, so a second contribution named `roadmap` in another context throws
  `Duplicate client slash command: roadmap`. The text occurs in the web UI bundle
  (`@getpaseo/server/dist/server/web-ui/_expo/static/js/web/index-07fb71ae403dd83a2c7484a3338718f8.js`)
  and in the desktop app bundle (`Paseo.app/.../app-dist/_expo/static/js/web/index-3d91adc9929fc38d33c6f16e7811ed52.js`),
  bundle module 3923 (re-checked: one occurrence in each). This was the actual failure after the
  first two-context registration.
- Composer matching (bundle module 4956) offers a command when a workspace is present, and for an
  `agent` command only when an agent is also hydrated. A `context: "workspace"` command is therefore
  offered in both the workspace draft composer and an existing agent composer, and is dispatched with
  a workspace action context that has `openPanel`.
- Implemented: `client/slash.ts` returns one workspace command; both composer invocations were
  checked in the actual UI after reload.

## 2. Protocol schemas, callbacks and runtime imports

- `@getpaseo/protocol/messages` exports `AgentTimelineItemPayloadSchema` (`dist/messages.js:500`) and
  `AgentStreamMessageSchema` (`:3575`) (re-checked). `AgentStreamMessageSchema.shape.payload` is
  `{ subscriptionId?, agentId, event, timestamp, seq?, epoch? }`; `event` is the
  `AgentStreamEventPayloadSchema` union with `timeline { provider, item, turnId? }`, and
  `provider` is a plain string. A tool call requires `callId`, `name`, a typed `detail`
  (`unknown` = `{ input, output }`), and `error: null` when `completed`.
- `paseo.agents.ref(id).timeline.subscribe(handler)` delivers the stream **payload** (not the outer
  `agent_stream` envelope), plus client-synthesised controls: `subscription_restored`,
  `replacement { epoch }` and `error { error }` (`@getpaseo/client/dist/index.d.ts`). `refetch()`
  returns `entries[].item`; `turn_ended` carries the agent's whole folded `timeline` array, whose
  items have no turn id or sequence number, so it cannot be filtered per turn. The observer uses it
  only as a catch-up scan (with the canonical-store check and same-id fold), next to the live
  in-turn subscription.
- Implemented: `server/timeline-match.ts` parses every item with `AgentTimelineItemPayloadSchema`
  (live, refetch and turn-end paths); `server/timeline-rows.ts` recognises the three controls first
  and parses every other live message with `AgentStreamMessageSchema.shape.payload`.
- Runtime import: `@getpaseo/protocol` is a devDependency. The accepted review traced the 0.12.0
  plugin compiler: it resolves the protocol from the project's `node_modules` and bundles it;
  host-provided zod and SDK imports remain external. Compilation confirmed no new external
  dependency compared with the accepted baseline, so no dependency change is needed.

## 3. Exact tool names and output envelopes (Claude, Codex)

- Claude names MCP tools `mcp__<server>__<tool>` (`@getpaseo/server/dist/server/server/agent/providers/claude/options.js:91`,
  re-checked); Codex names them `<server>.<tool>` (`.../providers/codex/tool-call-mapper.js:468`,
  re-checked). Codex's bare-name fallback for an empty server name is not used. The observer matches
  exactly `mcp__decision-roadmap__roadmap_{ask,answer,confirm}` and
  `decision-roadmap.roadmap_{ask,answer,confirm}`; no bare, foreign-server, alternate-separator or
  suffix matching.
- `roadmap_ask` output envelopes: Claude's `buildToolOutput` parses the MCP JSON and the generic detail
  keeps `detail.output = { output: payload }`; Codex's `mapMcpToolCallItem` keeps the MCP result
  `detail.output = { content: [{ type: "text", text: "<JSON>" }] }`. A raw JSON string and a single
  text block are also accepted. Error envelopes (`isError: true`), malformed JSON, nested wrappers,
  `structuredContent`, `result` wrappers and bare arrays are skipped.
- OpenCode and Pi pass provider-raw names whose exact form is not confirmed (E6): no automatic rows.

## 4. Broad host permissions and self-scoping

- Plugin sockets are admitted as owner sessions (`@getpaseo/server/dist/server/server/websocket-server.js:264`,
  re-checked). Timeline subscribe, refetch and append are allowed and are **not** scoped to the
  plugin's own workspaces or agents; append forces `pluginId` from the connection.
- The observer therefore scopes itself: it acts only on agent ids delivered by host lifecycle events
  (`agent.turn_started`, `agent.turn_ended`, `agent.archived`, `agent.closed`), re-resolves the
  agent's cwd to a registered project with an initialised, enabled store, and appends only refs whose
  question exists in the canonical store. Candidate refs from tool output are never authority.

## 5. Subscription handles: release and failed establishment

- A timeline subscription handle has `ready`, `subscriptionId` and `release()`. `release()` is
  memoised (a second call returns the same teardown) and rejects a pending `ready` with
  "Subscription released" (`@getpaseo/client/dist/connection/owned.js:114-128`, re-checked); a
  subscription error releases the observation on the host side.
- Implemented: the observer awaits `ready`; if establishment fails it attempts release of the assigned
  handle (errors swallowed, no retry) without removing a newer entry for the same agent. A repeated
  release is idempotent. Turn end,
  archive, close, error and plugin cleanup release handles the same way. At most 32 live
  subscriptions; agents over the cap are covered by the turn-end scan.

## 6. Durability of appended rows

- `appendTimelineItem` records the row through `recordTimeline`, which calls
  `enqueueDurableTimelineAppend` (`@getpaseo/server/dist/server/server/agent/agent-manager.js:1652-1667`,
  `:3503-3508`, re-checked); committed durable rows are restored when an agent is loaded (`:675-677`).
  A re-append with the same plugin row id folds in place (`${pluginId}/${id}` identity).
- Observed in the actual UI: rows appear during a Claude turn, update from inline and panel answers,
  and still render after a page reload and a plugin reload.
- Not verified: behaviour across a daemon restart, a crash, or a hard kill while rows are still
  queued (they may be lost). Native iOS/Android rendering is not verified.
