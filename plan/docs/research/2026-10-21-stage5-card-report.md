# Stage 5 card report (2026-10-21, revised after E5 evidence)

Cards: `docs/plans/tasks/2026-10-21-stage5.md`. They are documentation only. Inputs: SPEC §2, §8
and §10; plan Stage 5 and the acceptance list; the installed custom 0.12.0 SDK and daemon source
(read-only); the accepted feature base `a3647e74`; Kimi evidence
`.sdd/2026-10-20-decision-roadmap/stage5-e5-evidence.md`, `stage5-e5-followup-evidence.md` and
`stage5-e5-subscription-authorization.md`.

## Readiness

| Section | Status |
| --- | --- |
| P5.1 `/roadmap` (opens the panel only), P5.2 ref-only renderer, P5.5 docs | READY |
| P5.3 automatic agent rows for **Claude and Codex** (in-turn subscription, plus `turn_ended` catch-up), P5.4 rows reflect answers via the store | READY |
| T5.1–T5.5, final matrix | READY |
| P5.3 matching for **OpenCode and Pi** | **NOT READY**: E6, because their exact MCP tool-call names are unknown from host source |

## Corrections to the previous report

- The earlier claims "only a turn-end route" and "all rows lost on restart" were **false**:
  - Plugin sessions get owner permissions, so live `timeline.subscribe`, `refetch` and `append`
    are allowed (VERIFIED ALLOW).
  - Appended rows enter a durable queue and are restored on reload. Flush and kill semantics
    remain unverified.
- The O5 owner question is withdrawn. The evidence supports in-turn delivery, which matches
  the plan's "roadmap_ask appends a row", so no remaining owner tradeoff was identified.

## Security model (evidence-bound)

- **Host gap:** subscribe and append have **no workspace or agent ownership scoping**.
- The plugin self-scopes:
  - it observes and appends only to agent ids from host events (`turn_started`/`turn_ended`);
  - only after re-resolving `agent.cwd` to an opted-in project through the Stage 2 resolver;
  - only for tool calls with exact server-bound names (Claude `mcp__decision-roadmap__<tool>`,
    Codex `decision-roadmap.<tool>`; no bare or suffix matching);
  - only after confirming each candidate question exists in that project's canonical store.
- Tool output is candidate data, never authority. There is no identity inference from the
  grant or the cwd. Stage 2 actor semantics are unchanged.

## Design facts encoded

- `turn_ended.timeline` is the whole folded history with no `turnId`/`seq`. Replays are made
  harmless by a deterministic row id `q.<sessionId>.<questionId>` with identical ref-only data,
  which the host folds in place. No timestamp identity is used.
- `item.version` is the renderer schema version (1). It is never bumped as a refresh counter.
- UI and chat answers show in existing rows through the store-backed renderer query (polling
  plus invalidation), without re-append.
- Reconnect, epoch replacement and cleanup:
  - `subscription_restored` or `replacement` triggers one refetch scan;
  - subscriptions are removed on `turn_ended`, `archived`, `closed`, a subscription error and
    plugin cleanup;
  - at most 32 live subscriptions, with the `turn_ended` scan as fallback.

## Remaining technical gaps

1. **E6:** OpenCode and Pi exact tool-call names and `detail` shapes. Their support stays
   intended; they get panel and slash only until it is resolved.
2. Codex `detail.input` presence for these tools is not stated in the evidence. Extraction
   skips when it is absent, so no row is appended, and that is tested.
3. The exact `agent_stream` payload schema is read in the implementation turn from
   `@getpaseo/protocol`.
4. Durable-queue flush and kill semantics are unverified.

## Preserved

- The final matrix keeps item 6 (dry-run tracker preview) with an explicit Stage 4 dependency.
- The final gate is ordinary KensAI on the exact final branch revision.
- Native parse is not native UI proof.
- Stage 4 O1–O3 are pending and independent.

## Refresh against the provisional Stage 4 baseline (2026-10-21)

- **Baseline.** The runtime-accepted base is Stage 3 `a3647e74`. The provisional interface
  baseline is Stage 4 block B `1c8ded7` (exact tree of green `9a0eb7f`). Dispatch stays gated
  on the accepted Stage 4 (exact KensAI gates and live UI acceptance), and interfaces must be
  re-checked at that head.
- **Renderer correction (approved-plan compliance).** The plan requires in-place answering
  (`docs/plans/2026-10-20-decision-roadmap.md:348-351`). P5 therefore owns a narrow extraction
  of `client/question-card.tsx` into a new `client/question-answer-panel.tsx`.
  - `QuestionAnswerPanel` takes the options, recommendation, free text, note and
    Answer/Confirm/Skip, with the same `useRoadmapMutation` paths and `expectedRevision`
    fallback.
  - `QuestionCard` keeps its props, modal and other sections.
  - The timeline row renders the panel in place. An optional Details button opens the
    unchanged modal for discussion and history.
  - Regression: typecheck and the existing suite, the RN audit, the independent verifier's
    behaviour-identity review of the moved code, and a block 1 UI check answering through both
    the modal and a row.
  - Data comes from the existing `useRoadmapVersion`/`useSessionView` hooks.
- **Props verified.** `PluginTimelineItemProps` extends `PluginHostProps` (`theme`,
  `host { id, label }`, `layout { compact, platform }`) and adds `agentId`, `item`, `timestamp`
  (`client/contracts.d.ts:8-17,170-179`).
- **Review structure.** Two independently green blocks, each with T5 red, then P5 green, then
  independent verification and read-only diff review, then ordinary KensAI on its exact
  revision:
  1. slash command, renderer and pure model;
  2. host-event observer, plus docs.

  The final exact revision must be covered by an exact KensAI result, either the block 2 gate
  or a small gate for a later integration commit. There is no duplicate cumulative review.
- **Docs scope (P5.5).**
  - The `OVERVIEW.md:18` introduction ("…sends nothing beyond this machine") is corrected to
    cover the O1 Codex config read and explicitly confirmed tracker writes.
  - The `tracker_unavailable` copy "not available in this version"
    (`client/tracker-preview.tsx:25`) is recorded as a potential stale-copy follow-up for final
    reconciliation. It is not a blocking defect, and Stage 4 source is not edited.
- **Unchanged:**
  - E5 self-scoping, the strict Claude/Codex names, cap 32, cleanup, reconnect and refetch,
    and the ref-only store-backed rows;
  - E6: OpenCode/Pi automatic rows stay NOT READY, while panel, slash and renderer support is
    kept.

  Static raw-name evidence does not resolve their binding, and `turn_ended` does not avoid it.
- **No contract blocker.** No owner decision is reopened.
