**Status:** The Stage 0 task cards are written to `docs/plans/tasks/2026-10-20-stage0.md`. The file is not committed and nothing else was touched: no installs, no code and no commands beyond read-only inspection. I also did not run a self-review pass after a final cleanup edit, so the reviewer should read the file closely.

**How the work is split:**
- **Card P0 (production):** scaffold, `shared/{errors,model,canonical,graph}.ts`, `server/{hash,ids,fs-port,store,store-root}.ts`.
- **Card T0 (tests):** `server/fixtures/**`, `server/test-support/**`, `server/{graph,store,store-root}.test.ts`, `shared/{canonical,purity}.test.ts`. The only shared file is `vitest.config.mts`: T0 may edit its include globs or setup files and must report the diff.

**Interfaces:**
- **Graph (`shared/graph.ts`):** `validateGraph`, `computeVisibility(sessions) → Map<RefKey, Visibility>`, `invalidationClosure`, `layoutDepth(sessions, sessionId)`, `applyAnswer`, `confirmAnswer`, `updateDefinition` and `addRelation`/`removeRelation`. All are pure and work across sessions.
  - The answer and relation commands return `GraphChange {sessions, staleMarked, visibilityChanged}`.
  - Visibility is computed, never stored.
  - When an answer's value changes, every answered downstream question reached through invalidation edges is marked stale, including inactive ones.
  - Cycles are rejected on the combined activation + invalidation graph.
- **Store (`server/store.ts`):** `openStore({storeRoot, projectId, fs?, now?, newId?, keepGenerations?}) → Store {init, read, version, transact(expectedRevision, fn)}`.
  - `read()` returns `missing`, `ok` or `invalid`.
  - Generations are named `g-<rev10>-<ulid>`. A commit writes and fsyncs the generation, then renames a temp manifest over the old one, then prunes down to two generations.
  - One lock per root is shared across all `Store` instances for that root.
  - Reload checks the schema, file ids, the graph and `changeToken`. If any check fails the store is read-only and nothing is reset.
- **Project root (`server/store-root.ts`):** a `ProjectDirectory` port with `listProjects` and `listWorkspaces`, plus `projectDirectoryFromPaseo(paseo)`, `resolveProject(dir, projectId)`, `projectIdForWorkspace` and `openProjectStore`.
  - Callers pass only `projectId`, which resolves to `projectRootPath` as described in Contract 1 of the evidence.
  - Safety checks: the id format, a unique registration, an absolute and normalised root, no symlinked root or `.decisions` directory, and `manifest.projectId` must match.
- **Errors:** `DomainError` codes are `invalid_input`, `not_found`, `unresolved_ref`, `relation_cycle`, `question_inactive`, `not_stale`, `revision_conflict`, `store_missing`, `store_exists`, `store_invalid`, `unknown_project`, `project_mismatch` and `unsafe_root`.

**Commit order:**
1. P0 scaffold
2. T0 graph, canonical-JSON and purity tests
3. P0 model and graph
4. T0 store and root tests
5. P0 store and root

After commit 1 the two roles can run in parallel, since they own different files. The tests cover activation switching across sessions, keeping a hidden question's validity, mixed and cross-session cycles, a crash at every commit step, a chat-vs-UI race with exactly one winner, malformed generations, `changeToken` tampering, path traversal through the manifest's `generation` field, and the main checkout and a worktree resolving to the same store. Packages install through the existing registry config only; a 404 is reported to you for a nothingtodeclare upload.

**Decisions needing your ruling** (the cards already follow these proposals):
- **D1:** SPEC §4 puts sha256 in `shared/plan-hash.ts` with no Node imports, which can't be done without a hand-written hash or an extra dependency. I propose hashing only on the server (`server/hash.ts` using `node:crypto`), keeping `shared/canonical.ts` pure, and moving `planHash` to Stage 3.
- **D2:** `Stale` needs a `causeSessionId` field, because a question id alone is ambiguous across sessions. SPEC §6 needs amending.
- **D3:** The manifest needs an optional `disabled?` flag so SPEC §8's "manifest is not disabled" check has something to read. SPEC §5 needs amending.
- **D4:** SPEC §7's `storeRoot` RPC inputs are replaced by `projectId`. Amend §7 before writing the Stage 1 cards.
- **Rule I added:** answering an inactive question is rejected with `question_inactive`.
