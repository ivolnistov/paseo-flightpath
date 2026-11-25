# Stage 2 card report (2026-10-20, revised)

Cards: `docs/plans/tasks/2026-10-20-stage2.md`. They are planning only and are dispatched after
the Stage 1 KensAI gate. Host evidence summary: `docs/research/2026-10-20-stage2-host-runtime.md`.

## Scope

- New-agent MCP injection for opted-in projects only. **No existing-agent attach**, because none
  is supported in 0.12.0 (Contract 2). `agent.session_open` and `agent.turn_started` are used
  for holder hydration only: they make no env or config change and issue no grant.
- Ten Stage 2 tools: overview, get_session, create_session, ask (batch), answer, confirm,
  discuss, relate, update_question, link.
- Plan tools (`roadmap_plan_draft`, `roadmap_plan_status`, `roadmap_task_update`) remain
  approved scope, **gated on Stage 3** through `buildTools(commands, extra)` and
  `STAGE3_TOOL_NAMES`. No approve tool exists in any stage.
- Two roles in sequential turns: P2 production, T2 tests, with disjoint files.

## Rulings in the cards

| Ruling | Basis |
| --- | --- |
| Hand-rolled streamable-HTTP server; official `@modelcontextprotocol/sdk@1.32.1` **dev** client for the protocol acceptance test | Excalidraw precedent; the version comes from a read-only `npm view` on `https://registry.npmjs.org/`; the approved plan requires SDK-client acceptance |
| URL `/mcp/<grantId>.<HMAC(grantId, projectId)>`, grant in plugin-data | Project-bound, with no path input |
| Every call resolves `projectId → registered root` through the daemon. The store binds `manifest.projectId`. The grant root is only a cross-check and never opened. | Approved canonical root contract |
| **E1 resolved (installed 0.12.0):** a captured `context.paseo` is plugin-lifetime | `plugin-process.js:220-231` (create), `:236-244` (no start-time API), `:443`/`:463` (same instance to handlers and hooks), `:270-289` (single dispose). Outside the public types: re-verify on upgrade. |
| Hydration from RPC, `before("agent.create")`, `before("agent.session_open")` (no-op return) and `on("agent.turn_started")` | `turn_started` fires for any turn source; fan-out goes to loaded plugins |
| **No happens-before claim:** an empty holder fails closed with a retryable `not_ready:` diagnostic, makes no directory or store access, and never opens the cached root | Fan-out is asynchronous; there is a residual cold or mid-turn window. Coordinator ruling: a bounded transient state, so no owner decision is needed. |
| **No agent attribution inference:** `actor: { kind: "agent" }` only | Provider+cwd FIFO correlation can misattribute simultaneous creations, and no verified public field exposes the injected URL |
| Grant cleanup by cap (1000, stale first) and port change only | Without binding, archive events cannot identify grants. This is documented as a limitation; no private API is used. |
| Port fallback marks old grants stale and logs the count and fingerprints | Old URLs cannot be repaired in 0.12.0 |
| Redaction: no secret, signature, URL path or human text in logs | Fingerprints only |

## Test corrections

- **Cold failure proven side-effect free:** zero directory calls and zero project-root reads.
  Then an `agent.turn_started` emit (or `session_open`), with no UI, enables canonical lookup.
- **Exact registrations asserted:** `before agent.create`, `before agent.session_open` and
  `on agent.turn_started`. A resumed agent gets no grant, and hydration hooks change nothing.
- **Impossible batch-cycle test removed.** Batch edges only point into new questions, so a
  batch cannot close a cycle. A reachable `unresolved_ref` case replaces it, and cycle
  rejection stays covered by `roadmap_relate`.

## Changes to frozen Stage 0/1 code

- `server/sessions.ts`: `WriteOrigin` and `StoreOpener`; `RoadmapService` is unchanged.
- `server/store-root.ts`: `assertSafeRoot` is extracted and `projectForCwd` is added. Workspaces
  gain an **optional** `directory`; the adapter omits it when `workspaceDirectory` is absent, so
  existing fakes stay valid.
- Existing-test compatibility: the Stage 1 adapter test stub already carries
  `workspaceDirectory`, so its strict `toEqual` changes. **T2 (not P2)** is authorised to update
  only that expectation, adding the mapped `directory` values plus one no-directory case, and
  to widen the `server/test-support/fake-dir.ts` `Workspace` type with an optional `directory`.
  These are the only existing-test edits.
  Pagination and other assertions stay identical. It is RED in T2 commit 1 and green after
  P2.2.
- `server/handlers.ts`: an optional holder.

## Remaining genuine unknowns

1. **E2:** interoperability of the hand-rolled transport with providers is proven only by the
   live new-agent acceptance.
2. The E1 behaviour is pinned to the installed 0.12.0 host and must be re-verified after an
   upgrade.
3. There is no replay of lifecycle events missed while the plugin is unloaded (bounded
   absence evidence). After a reload with zero activity, tools stay `not_ready` until the
   first RPC or agent turn.

No new owner decision.
