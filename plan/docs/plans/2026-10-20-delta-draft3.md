# Delta since draft 2 (owner-facing), 2026-10-20

Baselines: `docs/plans/baselines/2026-10-20-SPEC-draft2.md`,
`docs/plans/baselines/2026-10-20-decision-roadmap-draft2.md`.

1. Q1 settled: one canonical roadmap per project, shared across all worktrees. The store root is
   resolved from the registered Paseo project identity, never from a worktree directory or a
   client-supplied path. Task 0.0 verifies the real SDK behaviour before this is coded.
2. Q2 settled: agent tools are injected only into new agents of projects with an enabled
   roadmap. The injection setting was removed; there is nothing to configure.
3. No other changes. Scope of draft 2 is unchanged and authorized.
