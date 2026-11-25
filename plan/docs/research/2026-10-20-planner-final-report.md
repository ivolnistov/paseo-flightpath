Draft 3 is final. The remaining "Q1/Q2/Q3" hits are acceptance-scenario question labels, not owner choices.

**Exact paths**
- `docs/SPEC.md` (draft 3)
- `docs/plans/2026-10-20-decision-roadmap.md` (draft 3)
- `docs/plans/2026-10-20-delta-draft3.md` (owner-facing delta since draft 2)
- `docs/plans/baselines/2026-10-20-SPEC-draft2.md`, `docs/plans/baselines/2026-10-20-decision-roadmap-draft2.md` (draft 2 copies saved before editing)
- `docs/plans/2026-10-20-advisor-disposition.md`, `docs/plans/2026-10-20-delta-draft2.md` (unchanged from draft 2)
- `README.md` status line updated to point at the approved draft 3 and the settled choices. `docs/STATUS.md` left untouched since the coordinator owns it.

**Material changes versus draft 2**
1. Q1 recorded in SPEC §5 and §12: one canonical roadmap per Paseo project shared across all worktrees. The store root is resolved by the server from the registered Paseo project identity (`projectId` and the project's registered root), never from worktree `cwd`, a client-supplied path or the `projectRootPath` snapshot field alone. Task 0.0 now requires observing actual SDK and CLI values for a main checkout, a linked worktree and an agent in that worktree before `resolveStoreRoot` is implemented. Client RPC inputs carry `projectId` instead of a path (Task 1.2); the `resolveStoreRoot` signature takes workspace, agent or project identity.
2. Q2 recorded in SPEC §8, §9 and §12: MCP injection only into new agents of projects with an enabled roadmap. The `injectMcp` setting was removed, so settings now hold only the tracker block. Task 2.1 gains a test that an agent in a project without a store gets no injection.
3. SPEC §12 now says no owner choices remain open. The plan's reapproval note records draft 3 and the baseline and delta paths.

No new requirements, no production code, tests, installations or agents. Opus can author executable task cards from draft 3.
