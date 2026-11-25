**Status:** The Stage 1 task cards are written to `docs/plans/tasks/2026-10-20-stage1.md`. The file is not committed, and no source, worktree, dependency or live state was touched. I based the cards on the actual core at `143fc8a` and the installed `@getpaseo/plugin` 0.12.0 type definitions, plus the paseo-plugin skill and the excalidraw precedent. The plugin uses the SDK's real entry points: a `contribute(client|server)` default export, `defineRpc`, `server.handle`, `useRpc` and `useWorkspace`. There is no `definePlugin` and no DOM.

**Interfaces:**
- **Core hardening** (in `shared/graph.ts` and `server/store.ts`):
  - `assertUniqueIds(sessions)` runs first inside `validateGraph`, so duplicate session or question ids are rejected on import and on commit. The store also rejects duplicate link ids.
  - `computeVisibility`, `layoutDepth` and `invalidationClosure` get a `visiting` set and throw `relation_cycle` instead of recursing forever. Every graph command first calls `validateGraph` on its input.
  - `StoreOptions.log` is added, defaulting to `console.error`. The three prune `console.warn` calls go through it.
  - Two new pure commands follow the existing `GraphChange` conventions:
    - `insertQuestion(sessions, sessionId, id, QuestionDraft)`
    - `skipQuestion(sessions, ref, at)`
- **Contracts (`shared/rpc.ts`):** 15 contracts, all with `{ projectId }` input and no path fields. Mutations add `expectedRevision`. Every output is `Result<T> = {ok:true,value} | {ok:false,error:{code: ErrorCode|"internal", message, details?}}`.
  - Contracts: `roadmap.version`, `roadmap.init`, `roadmap.overview`, `session.get`, `session.create`, `question.create`, `question.update`, `question.answer`, `question.confirm`, `question.skip`, `question.discuss`, `relation.add`, `relation.remove`, `link.create`, `link.delete`.
  - View schemas: `QuestionView`, `SessionView` (with a `catalog` of every question in every session, so relations can point at other sessions) and `Overview`.
  - `shared/status.ts` holds `questionStatus`; inactive takes precedence over the stored validity.
- **Server:**
  - `createRoadmapService(deps)` does one `read` or one `transact` per call through `openProjectStore(projectDirectoryFromPaseo(paseo), projectId)`. It calls the core graph functions directly, and hardcodes `source:"ui"` and a human actor.
  - `buildOverview` and `buildSessionView` build the view data.
  - `registerHandlers(server, service)` registers one handler per contract.
- **Client:**
  - `client/layout.ts` holds pure helpers so they can be tested in Node: `columnsByDepth`, `compactRows`, `relationLines`, `edgesBetween`, `staleCauseText`, `conflictMessage`.
  - `client/hooks.ts` polls the version every 3 s and invalidates the other queries when the revision changes. Mutations read `expectedRevision` from the cache and show a toast on conflict.
  - Components: the panel, roadmap view (depth columns with View connector gutters on wide screens, an indented single column on compact), question card in the host `Modal`, question editor and relations editor.
  - `index.client.tsx` registers the panel and a Command Center item.

**Card ownership:**
- **P1 (production):** the core hardening, `shared/rpc.ts`, `shared/status.ts`, `server/views.ts`, `server/sessions.ts`, `server/handlers.ts`, `index.server.ts`, `client/*` (non-test), `index.client.tsx`, and adding `@tanstack/react-query@^5.90.11` to `package.json`.
- **T1 (tests):** six test files plus `server/test-support/service.ts`. Its only config change is adding `client/**/*.test.ts` to the vitest include list.

**Main test cases:**
- The full acceptance flow: branch switching, keeping a hidden question's validity, stale revealed on reactivation, then confirm.
- A two-writer race where exactly one write wins and the other gets `revision_conflict`.
- Mixed and cross-session cycles, unknown or traversal `projectId`, and invalid stores left byte-for-byte unchanged.
- An internal error is routed to `log`, and a schema check finds no path fields in any input.
- A round trip through `callPluginRpc`.

**Commits:** three P1/T1 pairs (core, server, client), each pair runnable in parallel.

**Notes for you:**
- **N1:** SPEC §7 still describes `storeRoot` inputs and errors that are thrown; it should be amended to `projectId` and the `Result` envelope.
- **N2:** SDK 0.12.0 has no plugin logger object. Kimi's logger note is met by the injected `log` writing to stderr, which `paseo plugin logs` captures.
- **N3:** I only inferred that the host provides the TanStack `QueryClientProvider`, from the excalidraw plugin calling `useQueryClient` without mounting one. Step P1.5 checks that first and falls back to a provider inside the panel.
- **N4:** `insertQuestion` and `skipQuestion` add to the core API that is currently frozen under the KensAI gate. Skipping a question deactivates the questions it activates and marks nothing stale. If KensAI changes core interfaces, P1.1 and P1.3 need re-syncing before dispatch.

None of these needs a new owner decision.
