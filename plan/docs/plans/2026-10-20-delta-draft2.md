# Delta since draft 1 (owner-facing), 2026-10-20

Baselines: `docs/plans/baselines/2026-10-20-SPEC-draft1.md`,
`docs/plans/baselines/2026-10-20-decision-roadmap-draft1.md`.

What changed in draft 2 after the Astra consultation:

1. **Approval is now stored outside the project** as a daemon-owned receipt (plugin-data), with a
   readable copy in the plan file. A copy alone proves nothing. Approvals keep a history.
2. **Approval goes out of date on any meaningful change**: a stale upstream answer, a deactivated
   branch, an edited question or option, or an edited task, not only a new answer revision.
   Drafting a plan from unanswered, stale or inactive questions is refused.
3. **Storage became transactional**: each change writes a complete new snapshot generation and
   then swaps one manifest file atomically. Every change from the UI or chat states the revision
   it expects; a stale client gets a conflict instead of silently overwriting. Broken or
   half-merged files put the store into a visible read-only state instead of a reset.
4. **Branch activation and answer validity are separate**: an inactive question keeps its stored
   validity, staleness reaching it while inactive is recorded, and reactivation shows it. A
   stale or inactive parent cannot activate children. Cycles and dangling references are refused.
5. **Existing agents**: the creation hook only equips new agents. A bounded evidence task decides
   the supported attach path or documents the limitation before anything is promised. Agent ids
   and quoted human text are attribution, never authentication.
6. **Tracker writes** record an intent with the exact payload before any remote call; an unclear
   outcome stays "unknown" for a human decision and is never retried blindly. The confirm token
   is bound to the exact payloads, destination, mode and approval receipt. Tracker delivery
   remains part of overall completion.
7. **Editing**: questions and their activation/invalidation relations can be edited from the UI
   and from chat tools, so the acceptance scenario is fully supported.
8. New evidence steps: store root behaviour across worktrees (attached to Q1) and MCP attach path
   for existing agents (relevant to Q2). The two owner questions are unchanged and still pending.
