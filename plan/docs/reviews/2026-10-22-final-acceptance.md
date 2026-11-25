# Decision Roadmap final integration acceptance on test-host

## Delivery identity

Runtime code: `8bbcce65405d6cd4028559e3715ad8e9753e4b65`, accepted independent review and
ordinary exact KensAI +1/full; all63 review threads resolved/read back. Final docs-only
revision `f111145de69e519c1c7a068ef18b3703b0795e35` has independent PASS, ordinary exact
gate pending. No code/test/package blob changed in that docs revision. Feature worktree clean.
Accepted code is pushed to the authorized private GitHub feature branch; docs await gate.
Actual GitHub CI run list is empty, not a CI success claim.

## Validation matrix

| Requirement | Evidence and result |
| --- | --- |
| Preserve accepted Stages0–3 | Accepted history retained; no redesign or restart. |
| Fresh local canonical store | Stage4 host initialization started at revision1; synthetic writes validated schema/revisions. Current store revision34. |
| Stage4 tracker | Existing test-host Stage4 synthetic matrix passed; no Stage5 tracker code changed. Dry-run Apply sent nothing, exact payload/old-project close pairing and stale-preview/settings guards checked. No real Link/check-status or tracker write submitted. |
| Tests/types | Separate TEST full44 files/446 tests exit0; focused34/34 and both typechecks exit0 at matching source hashes. |
| RN/compiler/Hermes | Client source unchanged from accepted RN audit; active fnm0.12 compiled both entries. Client hash2a2e159c90d07035ba0520c95c0b0ce52907d1fb7bf731c5b91f8136cd7e42cf reuses exact Hermes pass. Server hash2a14ded77d729062f0d54f1bbd34a94d504241b55b16faa014aa35e10544a1fa, protocol bundled, no new external dependency. Compile is not execution. |
| Slash command | Actual workspace draft with no model selected and existing-agent composer each opened the panel only; duplicate-name runtime failure fixed. |
| Modal extraction | New synthetic question answered through panel modal; saved answer/history verified. |
| Claude rows | New Claude actor completed roadmap_ask and actual reference rows rendered. A later dedicated probe row was observed with active Stop agent before turn finish, proving in-turn delivery. |
| Inline answer and cross-surface state | RootA and dependentD1 answered in rows; panel reflected both. Panel rootB change updated existing rows, conditional became inactive and dependent stale with causeRev2. UI confirmed stale dependent. |
| Details/inactive display | Actual Details removed inline inputs from that card, one modal appeared, close restored inline controls. Inactive card opacity0.5; active1. Desktop padding/gap14, compact10. |
| Codex rows | New Codex actor's own question rendered. During its later running turn a new row for the chat-changed dependent answer rendered; completed exact Codex tools therefore work live. Own question answered C1 inline. Initial ask-row timing itself was not observed before its first turn ended. |
| Plan revision approval | Codex drafted rev1, actual UI approval current; chat D1→D2 made it not_current. Same plan rev2 drafted/new hash, actual UI approval current. Old rev1 view exposes no approval action and says only latest can be approved. Exact stale revision/hash RPC rejection is covered by existing passing plans tests; no direct UI API bypass was used. |
| Reload persistence | Five existing Claude rows still rendered after full page refresh and plugin-only reload with no new turn. No daemon restart or crash experiment. |
| Compact/themes | Actual390×844 timeline screenshots in Light and System-dark, scrollWidth390. Compact plan rev2/current approval and old-revision guard checked/screenshot. System theme and1280×900 restored. |
| OpenCode/Pi | Automatic rows remain unsupported pending exact-name E6 evidence; panel/slash implementation retained. No unsafe suffix matching. No live provider experiment claimed. |

## Synthetic records and completed QA roles

Claude actor `<redacted-id>` created session
`01M5JE6AXRYTQEZP1K4QN5HC4S`, root `01M5JE6JGNZMZ2P7Z54NYK81EC`, conditional
`01M5JE6JGP073108KYHXQCK7C1`, dependent `01M5JE6JGP85A6S7RMY0PB8W2T`, plus timing
probes `01M5JEEXQETT6VY5KD4P7BZQ45` and `01M5JEH03YEAWB1Z83ZX8X3D11`.
The optional shell waiter was denied by Claude auto mode and never executed. No permission
change or retry occurred. Coordinator independently saw the row and active Stop agent before
finish; temporary marker was removed. Initial create+ask16→18; later probes21→23.

Codex actor `<redacted-id>` created session
`01M5JEZN8H8XT8GZY45G7HMEXS`, question `01M5JEZVSMSWKPX997MFS4SC63`; its scoped
read/write reports were consumed. Initial policy-read capability gap was solved by allowing
only read-only cat of required policy, with no credential/settings change.

Plan `01M5JF07EXQCF2JHD8RFFZQH5G`, title QA Stage5 exact revision approval, sources only
the Claude QA session and has tasks `qa_stage5_plan_t1`, `qa_stage5_plan_t2` (both to do).
Rev1 hash `42b3cd61471d709bc326ccae68b8bba1e35692332e4d18b6c168a20c3724e484` was approved
at store30, then became not_current after dependent answer revision2→3 at store31. Rev2 draft
at store32 hash `fce5ffa79815d17ffe8c5e92c81a5c16c0aa0820c416f3faf87368ff5414e165` was approved
in actual UI at store34; current state was read back in desktop and compact UI. No real task
execution, tracker action or real-project approval is represented by this synthetic plan.
The old Stage4 synthetic plan is intentionally approval-not-current after earlier QA additions.

## Explicit limits and remaining closeout

Native iOS/Android runtime, daemon restart/crash/hard-kill queue flush, actual real tracker
Link/check-status/live batches, and OpenCode/Pi automatic rows are unverified or intentionally
not performed. Stage4 code, settings and adapter safety boundaries remain unchanged; tracker
is None/dry-run with blank project key and no close pair from completed Stage4 cleanup.

Docs exact gate/dispositions, final docs push/hash/actual CI inspection and completed-role
archival remain. No daemon restart, auth/approval-setting change, unrelated plugin/profile
modification, real tracker write, unattended schedule or public release occurred.
# Final docs review dispositions

Exactf111145 KensAI successor01a164ef-a700-7cd5-9450-084077c8c803 completed18:56:24Z,
exit0,+1,submitted/full3docs+540/-4. Eleven advisory comments, no implementation defect.
Host source outside reviewer index is an explicit verification boundary; separate independent
installed-source review and actual runtime evidence cover it without claiming reviewer access.
Concrete factual/reference corrections are committed as
feb69056433685b89b7ebc18fedd8c8095d5970b (four docs+23/-8); no code/test/package changes.

- **c0127:** Declined as optional commit-message enrichment. The subject truthfully describes contract reconciliation; the actual diff and self-contained note name folded history and restored rows explicitly. No history rewrite after +1. Recorded in docs/reviews/2026-10-22-final-acceptance.md.
- **c0128:** Granted as optional citation deduplication, recorded in docs/reviews/2026-10-22-final-acceptance.md. The planning card is preserved approved history while the research note is self-contained current provenance. Both identify version0.12.0; no false citation or code defect requires relocating every historical reference.
- **c0129:** Declined as optional commit splitting. The approved docs reconciliation is an independently reviewable docs-only block with no code/test/package effects. Rewriting its accepted parent history does not improve correctness. Recorded in docs/reviews/2026-10-22-final-acceptance.md.
- **c0130:** Declined as optional subject expansion. 'Roadmap timeline contracts' truthfully covers SPEC, the accepted card and the new host-contract note. No missing-file or implementation claim is hidden by the title. Recorded in docs/reviews/2026-10-22-final-acceptance.md.
- **c0131:** Fixed in feb6905: the card now states useRoadmapVersion polls3000ms, version change/panel mutation invalidates session queries, and useSessionView has no interval. Verified actual client/hooks.ts. No implementation changed.
- **c0132:** Fixed in feb6905: the status header explicitly records that approved reference-only q.<sessionId>.<questionId> plus query-cache updates supersedes Task5.1's original questionId/answer-reappend sketch. This records settled design, not a new product decision.
- **c0133:** Fixed in feb6905: the SPEC durability bullet now points directly to host-contract note section6, preserving the explicit unverified daemon-restart/crash/hard-kill boundary.
- **c0134:** Fixed in feb6905: the research note section2 explicitly states full folded turn-end history lacks per-turn/sequence item identity and is scanned as catch-up beside live subscription, with canonical-store checks and same-ID folding. It now directly supports the SPEC pointer.
- **c0135:** Fixed in feb6905: docs/STATUS.md has a HISTORICAL header preserving the old operation/location/authority prose and pointing to current accepted Stage5 card/research note. It records accepted code and ongoing exact docs gate without claiming native/restart/real-tracker/public-release proof.
- **c0136:** Fixed in feb6905: the OVERVIEW introduction correction is marked applied, and the historical tracker-copy follow-up explicitly records the current resolved string from client/tracker-preview.tsx:25. No tracker code changed.
- **c0137:** Fixed in feb6905: the absent feature-branch review-note reference is replaced by present docs/research/2026-10-22-stage5-host-contracts.md section1. Main coordinator review history remains separate.

No optional commit restructure, citation consolidation or message rewriting is being pursued.
The small factual correction receives its own exact gate; no cumulative whole-project rerun.

# Last factual-doc correction independent review

Independent read-only reviewer returned PASS on exact
feb69056433685b89b7ebc18fedd8c8095d5970b, parentf111145, four docs+23/-8. Full report consumed:
no blockers, false factual claims or scope violations. Polling/invalidation matched hooks.ts;
legacy row-shape supersession, completed copy fixes, present research reference, direct
durability evidence and historical STATUS framing were verified. Code/test/package identity
to accepted8bbcce6 preserves446tests, both typechecks and compiler/Hermes evidence. Actual
final docs KensAI outcome remains pending; no new implementation or cumulative rerun.

# Final exact gate accepted

Ordinary KensAI successor01a164fb-69db-7d1f-a00c-5ec100be78f3 completed19:09:16Z on exact
feb69056433685b89b7ebc18fedd8c8095d5970b, basef111145, exit0,+1,submitted/full4docs+23/-8.
No defect stands; allfive comments are suggestions/nitpicks. The externalhostsource boundary
is covered by separate installed-source inspection and actual UI evidence; daemon restart
durability remains explicitly unverified rather than claimed from the reviewer escalation.

- **c0149:** Declined as optional wrapping style after +1. The long lines remain readable Markdown and state the verified 3000ms mechanism/resolved copy correctly. Recorded as cosmetic follow-up in docs/reviews/2026-10-22-final-acceptance.md; no new source round.
- **c0150:** Declined as optional stronger historical markers. The top HISTORICAL header already says the body below records the Stage0-2 period and current card/note supersede it wherever they differ. No current implementation claim is based on the old Next actions section. Record clearer whole-body wording as follow-up; no code or factual correction remains.
- **c0151:** Evidence supplied: Stage4 accepted exact44d638354564b03dda80d865f69dd088e765c2ae is an ancestor of finalfeb6905 (git merge-base --is-ancestor exits0). Canonical main coordinator record docs/reviews/2026-10-22-stage4-ui.md Current acceptance result records389tests/bothTS0/independentPASS/exactKensAI+1/full23resolved plus actualsyntheticUI. That acceptance ledger is deliberately outside the published feature snapshot; it exists, and 1c8ded7 is not the final Stage4 revision. Granted optional in-repo acceptance-citation follow-up, recorded in docs/reviews/2026-10-22-final-acceptance.md. No acceptance is inferred from a provisional card or fabricated from missing reviewer access.
- **c0152:** Declined as optional retention of superseded polling prose. Git parentf111145 preserves the5000ms text; current card explicitly marks the correction and states actualuseRoadmapVersion3000ms. History is retained in Git and the acceptedmaincard. No behavior or factual source change needed after full+1.
- **c0153:** Declined as optional historical-paragraph cleanup. The inserted sentence explicitly says Resolved and quotes the actualcurrenttracker_unavailable text; the cardheader frames preserveddesign/history. The item is closed in the coordinatorrecord and is not pendingimplementation. Recorded follow-up in docs/reviews/2026-10-22-final-acceptance.md; no further documentation churn.

Stop the correctness/documentation loop. No feature-source edits follow this exact +1 gate.
Stage4 final44d6383 ancestor check was independently executed and succeeded; its authoritative
synthetic UI acceptance ledger remains in main, not silently manufactured in the feature tree.

# Final closeout — 2026-10-22

Approved implementation and documented acceptance scope complete. Exact final feature
`feb69056433685b89b7ebc18fedd8c8095d5970b` is pushed to the authorized private
`example-org/decision-roadmap` branch `feature/decision-roadmap`; remote hash
verified equal. Ordinary exact KensAI +1/full and independent PASS; all79 inherited/current
threads resolved/read back after final replies c0154-c0158. No unresolved review thread.

Final feature worktree is clean. All production/test/package/manifest blobs equal accepted
runtime8bbcce6, verified with git diff --exit-code; 446-test/typecheck/compiler/Hermes evidence
therefore applies unchanged. Plugin decision-roadmap is enabled/running from the feature path.
Actual Claude/Codex/web/compact and revision-approval results are recorded below. CI list[];
no hosted CI workflow/pass is claimed. No public release or merge into a hosted main branch.

All task-owned retained PROD2a9b92c5, TESTdc41d745, reviewer07d817da and two synthetic QA actors
were archived through supported APIs after preserving reports. APIs returned success. No
coordinator/parent/workspace/history was archived; source, transferred refs and synthetic store
are preserved. All bounded task watchers ended; no heartbeat or unattended schedule exists.

Explicit accepted limitations remain: OpenCode/Pi automatic rows pending exact-name E6,
native iOS/Android runtime and daemon-restart/crash durability unverified, no real tracker write
or successful real-endpoint Link/check-status exercised. These are not hidden completion claims.
The historical pending-operation paragraphs below are superseded by this closeout.

