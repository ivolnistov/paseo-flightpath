# Implementation plan deltas

## Changes tab content settled by the owner (2026-10-30, docs only)

Baseline: plan prefix `983f3a2a0aadbc03`, delta prefix `a812ea9bf6353d51`. Owner answer to the
pending feature-screen Changes question: «Сравнение ревизий плана» (plan revision comparison), not
a worktree code diff. Task R4.2 now states the settled content: reuse the existing plan diff view
and revision selection; a `changes` segment on phone and the header entry on wide; no new server
RPC, no code-change surface, no authority change. All other gates and Q choices unchanged.
Implementation and UI evidence remain outstanding.

## Docs corrections c0059/c0068 after the final local R3 verification (2026-10-29)

Baseline: plan prefix `8e856446c4616d12`. c0059: the process-port bullet now states the
fail-closed bounded `TERMINATE_GRACE_MS` (1500 ms) settlement after a termination without
`close`, with timer and listener cleanup, bounding the result only (no descendant killing).
c0068: the superseded bracket names only the former R3.1 implementation claim as superseded,
not the owner's Q1 one-plan decision. Docs only; final local verification 1325 tests, both
compiles 0, untouched.

## Truth corrections from the R3 DeepSeek triage (2026-10-29, docs only)

Baseline: plan prefix `78dc5609b18f188c`, delta prefix `936196c50a7b2cdc`. No product or
technical ruling changes. c0004: the Stage R3 alignment sentence claiming R3.1 enforces the
one-plan guard is annotated as superseded; the guard shipped in R2 (`3743b7f`) and R3.1 adds the
mid-run draft guard and the exact-revision `verified` guard. c0011: Task R3.3 `worktreeIdentity`
now states the shipped `ProcessPort` `gitBytes` raw-Buffer path instead of `execCommand`.
History preserved by annotation; no other cleanup.

## R3.4 technical ruling: run tool authority matrix (2026-10-29) — R3.4 only

Baseline: plan prefix `7b67be7b5b05a45e`, delta prefix `966ea53a46ffcca6`; source `86d67c7`
unchanged; approval baseline and defaults unchanged; no new persisted schema, secret or crew
registry. Roles derive from existing facts only (bound grant agent and workspace, feature
coordinator binding, `runToken`, `TaskRun.agentId`, per-task acks): `run_next` coordinator only;
`task_claim` by the coordinator (self or named worker) or crew self-claim; `task_progress` by the
assigned agent or coordinator; `run_ack` self-ack only, idempotent, no run-level ack; foreign and
unbound callers refused; token proves the run, not the caller. Tests listed in the plan.

## R3.3 recovery ruling: verification cycle retirement (2026-10-29) — R3.4/R3.5 only

Baseline: plan prefix `62b989be711dbea7`, delta prefix `2db0bb9cef9fcdfb`; R3.3 independently
GREEN (62 focused, typecheck 0, full 1204) at dev `86d67c7`, untouched by this ruling; approval
baseline and defaults unchanged; technical restoration under the approved pause/late-evidence
and repair-ceiling rules.
- Gap: `recordVerification` with a late reason stores late evidence only and leaves the task in
  `checks_pending`, from which `beginVerification` is not allowed, so drift, unreadable identity
  or a pause during checks strands the task.
- Rule: explicit cycle retirement (`RunEvent` kind `cycle_retired`, additive): task back to
  `in_progress` for its worker, binding cleared, unresolved note until the next `cycle_started`;
  no failed-cycle increment for drift, unavailable identity, pause or stale records; `run_stale`
  unchanged (late only); pause retires open cycles in its own transaction and resume sweeps
  defensively; later records for retired cycles are late only and idempotent; a new cycle needs
  a freshly computed binding after resume/readiness; old results are never accepted.
- Maps: `server/runs.ts` and `shared/model.ts` in R3.4 (record path) and R3.5 (pause/resume
  sweep); tests in `server/runs.test.ts` as listed in the plan.

## Final R3 alignment before R3.1 RED (2026-10-29) — R3 only

Baseline: plan prefix `c0884f559254b48d`, delta prefix `6aa2abcdac773835`. R2 exact final gate
closed (`01a18630` on `3743b7f`, +1, full, all 32 threads resolved). Reconciled with the final R3
card (`bf6f66c5…`) and the committed R2 corrective; approval baseline and Q34/Q35 defaults
unchanged; no new policy.
- R3.1 map: `shared/readiness.ts`, `server/runs.ts`, `server/delegations.ts`,
  `server/run-handlers.ts`, `shared/rpc-runs.ts`, `shared/model.ts`, `shared/errors.ts`,
  `shared/rpc-base.ts` (`run_stale`, `run_not_ready`), `server/plans.ts` (mid-run draft guard,
  `verified` guard by addressed revision with a run); the one-plan guard is already shipped in R2
  (`3743b7f`); T adds `shared/rpc.test.ts` and the RPC/MCP guard tests.
- R3.4 map: adds `server/runs.ts` (staged start, claim, progress, resume re-send),
  `server/delegations.ts`, `shared/readiness.ts` (`coordinator_unavailable`), with the atomic
  note enum, settings key and client consumer; T adds settings, readiness and fault-store tests;
  R3 gate includes client compiles and Hermes.
- c0015 shape aligned with shipped R2 corrective (review c0036): pending entries carry optional
  `retryBlocked: "feature_has_multiple_plans"`; retry eligibility also requires no `retryBlocked`
  and the latest displayed revision; the generic gate advice line shows only for actual
  `blockers`; the earlier shape without the field is superseded.
- Historical delta entry naming the `server/mcp-tools.ts` pass-through annotated as superseded
  (history preserved).
- Representation of the post-commit send failure (R3.4 only): no new strict `ExecutionRun`
  field; durable storage is a `RunEvent { kind: "prompt_failed", detail }` plus the feature
  `note`; the consumer is a derived optional `RunView.unresolved?: string[]` from events after
  the latest `started`/`resumed`, cleared implicitly by a successful `run.resume`; event kind,
  view field, derivation and tests added atomically in R3.4.
No contradiction found between the final card and the canonical plan after these edits.

## R3 card rev2 preflight rulings (2026-10-29) — R3 only, not part of the R2 gate

Baseline: plan prefix `cde48da185bc2f05`, delta prefix `a9dcbf7ca1595ebd`; R2 corrective and the
earlier R3 alignment preserved; approval baseline, Q34/Q35 defaults, provider scope unchanged.
- Skipped delegated start surface: additive `FeatureEvent.kind: "note"` with reason, rendered by
  `eventText`; `shared/model.ts` and `client/feature-screen.tsx` plus tests added atomically to
  the R3.4 map; R3 gate now includes client compiles and Hermes (card claim of no client change
  withdrawn). Representation of an already-required visible skip, no new authority.
- Coordinator creation order: staged create-then-record (precheck, SDK creation, one
  re-validating transaction writing binding, run, status and events); no unbound run is ever
  written; the agent is created without the run prompt and the prompt is sent with `agent.send`
  only after the commit; SDK failure refuses with `run_not_ready { blocked: [{ code:
  "coordinator_unavailable" }] }` (`coordinator_unavailable` is an explicit `NotReady` member
  added atomically with its consumer); a failed post-commit send leaves binding and run durable,
  `paused (owner)` with an unresolved note, no duplicate creation, no automatic retry, resume or
  explicit replacement as the recovery; late state change
  archives the created agent best-effort and returns the existing run (Q19); archive failure
  leaves a `note`; executable fake-SDK and fault-fs tests for failure and concurrency listed.
- Worktree source fields corrected to `baseBranch`/`branchName` for `branch-off` as verified by
  root from the installed CLI; protocol `refName` noted; P confirms during RED without creating a
  worktree.

## R2 corrective after the exact R2 review (2026-10-29) — mirror this entry alone into the R2 gate

Baseline: plan prefix `9405cf202ed205db`, delta prefix `ef12f55960c30fe2`. Scope: Stage R2 text
only (the "R2 corrective" block, the R2.3/R2.4 file-map fixes, the §1 task-cancellation row);
the separately labelled "Stage R3 alignment" entry below is NOT part of this corrective and must
not be mirrored with it. Approval baseline, Q34/Q35 defaults and product decisions unchanged.
- c0011: one plan per feature (owner Q1 option 2) enforced now in the shared draft producer for
  every binding draft (new plan, or an existing unbound legacy plan given a `featureId`) when any
  other plan is bound to the feature (`feature_has_plan` naming the existing bound plan);
  duplicate data stays readable, and redrafting either of pre-existing duplicate bound plans
  fails closed with `feature_has_multiple_plans`; R2.4 map: `server/mcp-tools.ts` unchanged
  aggregation; R2.3 T wording: tasks start implicitly `todo`, rows on first `task.update`; `plan.approve` and `plan.rework` fail closed with
  `invalid_input { reason: "feature_has_multiple_plans", featureId, planIds }` and no receipt
  side effect; redrafts unchanged.
- c0004: `statusReason` describes the current status only: set by rework, cleared by every manual
  status write, re-derived on undefer to `created` while the plan is still in rework, cleared by
  approval; history stays in events and `Plan.reworks`.
- c0015: derived `PlanView.approvalEffectsPending?` (`project_copy`, `feature_planned`) with the
  exact eligibility for the same-revision idempotent `plan.approve` retry (latest, not reworked,
  no blockers, basis current); otherwise shown with reason and no action; no new endpoint, no
  persisted approval truth; deferred/cancelled/other statuses never reported as `feature_planned`.
- File-map and docs repairs: c0008 (`index.server.ts` pass-through), c0013 (`plan-view.tsx`
  formatting), c0003 lazy task states, c0005/c0007 v1 versus v2 task-state shapes, c0009 SPEC
  sections, c0010 V1 negative test, c0014 header, c0001 description.

## Stage R3 alignment after planner triage of the R3 card (2026-10-29)

Baseline: plan prefix `575a5565762e6d6d`, delta prefix `f7bd6b9802ea6a22`; approval baseline,
R2 reviewed snapshot and Q34/Q35 defaults unchanged; no product policy added. Changes, all
technical representation or coverage of approved rules:
- Error codes `run_stale`, `run_not_ready`, `delegation_unverified` with `shared/errors.ts` and
  `shared/rpc-base.ts` in the producing tasks' maps; `NotReady` is data, refusals carry it in
  `run_not_ready` details.
- Mid-run draft guard in the shared producer (`server/plans.ts`), inherited by RPC and MCP;
  ended runs do not block; tests mapped.
- One plan per feature enforced at the producer and used as the `run.start` selector, settled by
  the owner's Q1 option 2 ("one plan with revisions and one approval") and design §2; no
  first/last choice encoded.
- Budget grant accepted only at `ceiling`; adds N, never resets, reopens to `todo` only under the
  new ceiling.
- Process port result promise (`close`/`error`, Buffers, truncation, termination); git through
  the same spawn path because `ExecCommandOptions.encoding` is `BufferEncoding` and stdout is a
  string.
- Identity exclusion limited to the three path-based digests; `headCommit` always moves.
- UI `verified` refused only for the addressed `(planId, planRev)` that has a run (any state);
  run-less revisions and legacy plans keep the shipped flow (design §3.5).
- Start without a binding and without `profileRef` refused; delegated starts need a configured
  default coordinator profile (`roadmap.coordinatorProfile?`, deployment configuration), else
  skipped with a visible reason; never an unbound run.

## R2.3 candidate shape, file maps, final lint requirement (2026-10-29)

Baseline: plan prefix `fe12338820ebed17`, delta prefix `497c1db8b39eda58`; approval baseline and
product decisions unchanged; Q34/Q35 defaults unchanged. Context: R2.1 committed `51c3721`
(203 focused, typecheck 0, full 1038, revision-guard mutation proof); R2.2 RED 23/57/80.
- R2.3 `reuseCandidates`: `verifiedAt` becomes optional, populated only from an existing
  `TaskState.verification.at`; the shipped optional `verification` is not tightened and no date
  is fabricated, so historical verified states stay valid candidates. Serialisation and
  compatibility only; no owner decision. P card §4.2 must be updated to match.
- File maps: R2.3 adds `client/plan-format.ts` (+ test); R2.4 adds `index.server.ts` and the DoD
  resolver pass-through in `server/mcp-tools.ts`, matching the executable card. [Superseded
  2026-10-29 by the "R2 corrective after the exact R2 review" entry: the pass-through site is
  `index.server.ts` only and `server/mcp-tools.ts` is unchanged aggregation (review c0008); kept
  as history.]
- R4.5 gains the bounded final tooling requirement: P-authored `lint` script and TS/TSX config
  with meaningful correctness rules, lockfile updated through approved registry rules, tool
  contract verified by P's card, independent TEST run. E2E scope corrected the same day: temp-store/loopback/mock suites
  and compile/Hermes are necessary evidence but not browser/live/runtime E2E; final R2–R4
  acceptance also requires synthetic Docker (`roadmap-r1-qa`) real-SDK WebSocket journeys with
  reload persistence and attended Chrome flows (compact/wide, light/dark) against the exact
  final installed source with records and screenshots, as done for R1; native/device not
  claimed unless tested; container-only install/reload authority; final matrix lists lint and
  the kensai-local exact review.

## Stage R2 alignment with the corrected dev card (2026-10-29)

Baseline: plan prefix `d04c8c3513d60c07`, delta prefix `6e6bab29e00e40b1`; approval baseline
unchanged; technical file and timing corrections only. Source: dev card
`2026-10-29-redesign-r2.md` sha256 `4fc76879…` at `e33fab0`.
- Provenance of two labelled, revisable DEFAULTS recorded: Q34 (grilling completion: ≥1 active
  non-cancelled question, all `valid`, `skipped` incomplete, no acceptance requirement) and Q35
  (grilling sessions linked only, not automatic basis; caller may select one explicitly, then Q33
  applies). Basis: the owner's explicit move-on goal given after the questions were shown with
  option 1 recommended; not answers, not silence; the planner's later "skipped counts" suggestion
  is not applied.
- R2.1: files include `shared/model.ts` (`Feature.grillSessionId?`, `Plan.grillSessionId?`),
  `grillingComplete(sessions, sessionId, cancelled)`, `approvalBlockers(plan, ctx)`,
  `created → planned` on approval (design §3.1/§3.6), `gates_not_available` enum retained.
- R2.2: server-owned session creation with ids on feature, plan and task; carry-over rule
  restated; grilling sessions absent from `basedOn`.
- R2.3: exact rework contract (UI-only, approved latest revision, `reworks` record supersedes
  without editing revisions, non-`verified` task states → `cancelled`, `verified` states and
  notes preserved as the completion record, feature `created` "plan in rework", superseded
  currency reason, `reuseCandidates?` optional output, read-only list in `client/plan-view.tsx`,
  `TaskUpdate` excludes `cancelled` only with UI `verified` kept). §1 "Task cancellation" row
  corrected accordingly (earlier wording over-narrowed `task.update`).
- R2.4: `PlanRework` registration, `roadmap_dod_template` registration, SPEC, commit subjects.
Design consistency check: task cancellation and completion preservation match design §3.2 and
§3.6; no contradiction found.

## R1 review restorations c0040 and c0045 (2026-10-28, DeepSeek exact review `01a18182`, dev HEAD `1dd9fa5`)

Baseline: plan prefix `4100c66f9f0098f8`, delta prefix `8273842c9ba49757`; approval baseline
unchanged; routine restorations within approved intent, no product scope expansion.
- c0040: Task R0.5 delete rule gains the guard "no plan carries this `featureId`"
  (`feature_transition`, details `{ featureId, planIds }`), preventing a permanently undraftable
  bound plan; no unbind, rebind or new authority. Task R1.1 records delete truthfulness: control
  offered from feature data only, server refusal shown as the reason, no query widening.
- c0045: Task R1.3b cancel re-pin contract: never resend `view.revision` blindly; when the
  rendered revision differs from the pin, a "Review latest before cancelling" action re-pins to
  the rendered revision and resets reason and confirmation; no auto retry or overwrite; later
  foreign writes conflict again. T cases added.
P owns the executable card update; TEST RED follows.

## Q33 answered: Task R1.5 basis cancellation currency (2026-10-28)

Baseline: plan prefix `767ed50bcea0d090`, delta prefix `95391e61909041ff`; owner approval
baseline unchanged. Owner answer Q33=1 (2026-10-28): cancelling a basis decision makes approval
`not_current`; a new revision and approval are required; execution follows the approved
stop-and-rework rules. Changes:
- The "pending owner branch / no-effect is not a policy" text in R1.3a and R1.4 is replaced by
  the owner choice, keeping the historical note that R1.3a as committed has no basis effect.
- New Task R1.5 (server only, after R1.4, before the final R1 review): a cancelled-refs basis
  context threaded as an optional, empty-by-default parameter through `activeBasis`,
  `basedOnSnapshot`, `decisionSnapshotHash`, `eligibility`, `basisCurrent` and `currency`;
  cancelled refs are excluded from new bases while visibility and graph stay unchanged; a
  revision whose `basedOn` contains a cancelled ref is `not_current` with reason
  `<ref> was cancelled` and cannot be re-approved; all currency consumers (`plan.get`, `plan.list`,
  `plan.approve`, `task.update`, `roadmap_plan_status`, tracker) share the context; hash
  functions, receipts and old revisions untouched; legacy stores byte-identical; v2
  `gates_not_available` precedence preserved; no new UI, warning or MCP authority.
- R3.5 gains the tracked hook: a basis cancellation during execution follows stop-and-rework;
  not implemented in R1 and nothing is claimed about runs.
- Dependency table: R1.5 after R1.4, R2.1 after R1.5; scope map row for Q33=1.
- Technical alignment (2026-10-28, card §8.7 A1): the R1.5 test sentence for v2 revisions was
  overbroad; corrected to the shipped status contract (no verified receipt → `unapproved`/
  `unverified` with `[]` reasons; cancellation reason asserted on pure `basisCurrent`;
  `gates_not_available` first on approve; optional synthetic seeded v2 receipt labelled as not
  obtained through commands). R1.5 rule wording now says APPROVED plan; fixture rule added (raw
  v1 read-only, cancellation scenarios on a migrated v2 store). Plan prefix before this edit
  `d6becad9ff561331`.
- Editorial (same day): the Stage R2 heading moved below Task R1.5 so R1.5 belongs to Stage R1;
  the R1.4 evidence sentence now says the final review waits for R1.5 implementation and its
  independent verification (Q33 answered). Plan prefix before this edit `0999e4cb8bbfe82b`.
No source, card, tests, runs, review, commit or push by the planner.

## R1.4 integration map alignment (2026-10-27, before the integration commit)

Baseline: plan prefix `5c890d59f4daa9bf`, delta prefix `9c72fc50b62cdc44`; owner approval
baseline unchanged; no stage-complete, gate-pass or push claim. Changes:
- Task R1.4 rewritten to the actual map: P files `client/panel.tsx`, `client/hooks.ts`
  (`useFeatureList` only) and `client/grilling-blocks.tsx` (optional `target { questionId,
  nonce }`); `client/slash.ts` and `index.client.tsx` unchanged; the planned `useDodTemplate`
  hook withdrawn because `DodEditor` fetches the template only on the explicit press (Q28=3 and
  Q31=1 preserved); T files `client/panel.test.ts`, `client/hooks.test.ts`,
  `client/grilling-blocks.test.ts`. Integration contract recorded (stack and Back, loading and
  error states, map/grilling switch with shipped map preserved and Grilling default, bounded
  body height without outer ScrollView and CTA outside, full-`Ref` cross-session navigation,
  same-target nonce never overriding a later selection).
- Evidence recorded: independently GREEN at dev HEAD `f07ad16` with validated uncommitted
  changes (965 tests / 65 files, focused 46, typecheck 0, both entry compiles 0, Hermes full
  client 0); explicitly compiler and test proof only, no runtime, native or live UI acceptance.
- R1.2 clarified: editable fields are `dod` and the human-set `grill` checkbox; other task
  fields read-only in R1.2; `grillSessionId` never sent by the client. R2.2 records the
  server-owned `grillSessionId` carry-over by task id (C7 ruling). No new feature behaviour.
- Q33 remains a pending parallel owner branch; the current no-effect code is not an approved
  policy. Sequence: integration commit after root inspection and mirror, then Q33 to the owner,
  then the exact ordinary review.

## R1.3 split and validated cancellation contract (2026-10-27)

Baseline: plan prefix `6af8b41c1edcda9a`, delta prefix `1be4c5ac4765d8fc`; the owner approval
baseline is unchanged and no new approval gate is inferred. Changes:
- Task R1.3 is split into **R1.3a** (server contract for explicit cancellation, validated by the
  planner and independently GREEN at dev HEAD `0ea41b7` with uncommitted validated changes) and
  **R1.3b** (blocks, Note-only and decisions display UI, sequential after R1.3a).
- The earlier "encoding not settled / `cancels` link kind candidate" text is replaced by the
  validated contract: optional `RoadmapMetaV2.cancellations` strict records (human actor, ref,
  trimmed reason, time, id; ids and refs unique and resolving at read and write; v1 unchanged, no
  default); UI-only `decision.cancel`; error code `decision_cancelled`; no MCP tool and no link
  enum change; read-only commands on a cancelled target with the frozen check first; accepted
  decisions cancellable; append-only metadata with frozen content unchanged;
  `SessionView.cancellations`. Exact P map now includes `server/store.ts`, `shared/errors.ts`,
  `shared/rpc-base.ts`, `shared/rpc-decisions.ts`, `shared/rpc.ts`, `server/sessions.ts`,
  `server/handlers.ts`, `server/views.ts`, `docs/SPEC.md`; nine mapped T files including a
  minimal tracker handler expectation.
- R1.3b states the Q32=1 display: explicit cancellations struck through with reason and
  read-only; `supersedes` replacements rendered normally with a link.
- Q33 recorded as a pending separate owner branch; the current code has no plan-basis or
  currency effect and that is not an approved no-effect policy; no warning or execution
  behaviour invented.
- Dependency table and scope map updated for R1.3a/R1.3b. The implementation source of truth
  for R1.3a is dev card §4.1 (sha256 `75aa0593…`).

## Clarification: legacy re-draft compatibility and R1.0 file map (2026-10-27, editorial consistency)

Baseline: plan prefix `fb4a4daae58f9bc4`, delta prefix `d108d8aeea210ed2`. Not a new approval
loop. R1 card C3 reported a contradiction: §1 "Versioned revision hashing" said every new revision
of a legacy plan must be `schema: 2` with a feature binding, while the owner-acknowledged R1.0
preserves legacy drafts without `featureId` or v2 fields, including re-drafts of existing unbound
plans. Reconciled to the accepted R1.0 reading: unbound legacy plans keep the shipped legacy
re-draft flow; migration to v2 happens only by an explicit binding (`plan.draft` with
`featureId`); once bound, later drafts must keep the same `featureId` and are `schema: 2`, no
downgrade and no rebind (`invalid_input`). R1.0 map facts added: `PlanSummary.featureId?`
(needed by the R1.1 feature detail plan list; same `shared/rpc.ts`/`server/plans.ts` files) and
`shared/rpc.test.ts` as an essential client-side parse test. Gates, approval baseline and the
fail-closed v2 approval are unchanged.

## R1 sequence revision (2026-10-27)

Baseline: the plan as last presented, prefix `e43b90d3e0ed3cd4` (delta prefix `9ed3294598bd5f58`).
Authority: the owner acknowledged the proposed stage-boundary revision («делай что считаешь
нужным», in direct response) and settled Q32 as option 1; both are in the canonical ledger. No
new approval gate is inferred; approval baseline, gates and runtime authority unchanged.
Scope, behaviour and boundary changes:
- **New Task R1.0** (server prerequisites, sequential before R1.1–R1.3): versioned drafting
  (`plan.draft`/`roadmap_plan_draft` accept `featureId` and v2 task fields; feature binding
  required for any v2 revision; legacy path byte-identical; MCP and UI parity; v2 approval stays
  fail-closed), shared `approvalBlockers(plan)` behind `PlanView.blockers` used by both
  `plan.get` and `plan.approve`, and create-only `feature.create.relatedTo`.
- **R1.1**: adds the feature detail static subset in `client/feature-screen.tsx` as the target
  of "open" and the "create removal feature" action using `relatedTo`.
- **R1.2**: defines editor persistence through `plan.draft` (full task list, preserved ids,
  unapproved `rev + 1`), template insert fills the editor only, legacy plans read-only with hint,
  Approve disabled from server blockers.
- **R1.3**: Q32=1 recorded as settled observable behaviour (explicit cancellations struck
  through with required reason; replacements visible with a link; accepted content unchanged);
  cancellation storage is not settled: a bounded Opus technical contract proposal must be
  validated before the cancel action is implemented; a distinct `cancels` `Link.kind` is a
  candidate only; no deletion, MCP or reversal rule is adopted.
- **R2.1** now extends `approvalBlockers` from R1.0; **R2.2** reduced to grilling-session
  creation and `roadmap_dod_template`; **R4.2** extends the R1.1 file; **R4.3** keeps removal
  run semantics and reads `relatedTo`.
- Dependency table: R1.0 after R0.6; R1.1–R1.3 after R1.0; scope map rows updated.
Constraints and acceptance criteria otherwise unchanged. No owner approval of a particular
cancellation encoding or reversal policy is claimed.

## R0 final file-map and tool-map alignment (2026-10-27, after the whole-stage DeepSeek review)

Baseline: canonical plan prefix `c6df6686ed32dda1`. Technical record only; no design change, no
gate-pass or launch claim.
- c0094: Task R0.6 Files line now lists `client/question-editor.tsx` (production) and
  `client/question-editor.test.ts` (test), which the checklist item below it already assigned.
- c0090: Task R0.5 records the read-only MCP tool `roadmap_feature_list` (strict empty input,
  grant project scope, existing `feature.list` result with revision and ordered features, no
  write); no new mutation or start authority; delegated start remains Stage R3.
Context: dev HEAD `70ef25b` plus validated uncommitted final fixes (780 tests in 54 files,
typecheck 0, both compiles 0; raw client bundle identical `ea217118`, prior Hermes proof reused,
not rerun). The whole DeepSeek review `01a17c75` covered `70ef25b` with 16 findings; the
correction tree is not yet reviewed; the owner decides on an extra exact review after the
concrete patch. c0097 fixture wording stays verbatim as approved; c0099 is a hand-sealed graph
limit with no store change. Dev card §11 (hash prefix `4d863891`) carries the same scope.

## R0 client compatibility exception (2026-10-27, c0079)

Baseline: the plan after the R0 review alignment (file prefix `c4fbc2df182e8a34`). Technical
record only; approved behaviour unchanged, no new gate. Stage R0's deliverable "the shipped UI
works unchanged" was found broken by the server change (MCP `roadmap_ask` with `blockId` on an empty session converts it to blocks; the
shipped question editor omitted `blockId`). Restoration required one client source change,
`client/question-editor.tsx`, now recorded in the Stage R0 deliverable and as a Task R0.6 item
with its file and test map; the earlier blanket "no client source change in R0" reading is
replaced by "no other client source change". Owner authorised proceeding and the final ordinary
DeepSeek review; the dev worktree task card §10 (hash prefix `530c2618`) carries the same
correction.

## R0 review alignment: derived legacy markers and relation freeze scope (2026-10-27)

Baseline: the plan after the R0.4 frozen-content clarification (file prefix
`f95f11b4c141229c`). Technical clarification only; no new behaviour, no owner approval gate.
- c0002: §1 "Schema v2 and legacy projection", Task R0.2 T bullet and Task R0.4 no longer
  describe `legacyBlocks: true` or `legacy: true` as projected or stored fields. "Legacy" is a
  derived predicate (`featureId` absent, revision `schema` absent, `session.blocks` absent;
  `effectiveBlocks` computed on read); nothing is written, so v1 bytes, hashes and receipts stay
  exactly preserved as already required.
- c0001: Task R0.4 keeps the authoritative scope "relation add/remove with that question as
  target" and now states explicitly that a relation with an open target and a frozen parent or
  upstream is allowed and leaves the frozen question byte-identical; the T bullet gains that
  case. The card and code had widened the freeze to both relation ends; the plan was and remains
  authoritative.

## Task R0.4 frozen-content clarification (owner clarification 2026-10-26)

Baseline: approved revision 3 after the post-approval editorial note (plan file prefix
`33bb0e9be9e39542`). Owner answered the blocking R0.4 question: upstream edits are allowed,
accepted answers preserved, staleness recorded separately. Changed: Task R0.4 "Produces" now
defines frozen as content (answer, revisions, definition, notes, own relations) and lets the
existing graph propagation mark frozen dependents stale; the batch frozen-state comparison uses
a content projection that omits `validity` and `stale`; the T bullet gains the upstream-stale,
confirm-still-rejected and next-block-dependency cases. No schema, RPC or MCP change; no other
task changed. Evidence note: `.sdd/ui-mockups/r0-4-staleness-disposition.md`.

## Post-approval editorial note (2026-10-26)

Revision 3 was approved by the owner on 2026-10-26. After approval, only editorial changes were
made: the status block and §10 now record the approval and the R0 workspace, the Global
Constraints gained the owner's English-only repository rule, and the two Russian UI example
strings in Task R1.2 were replaced by English equivalents. No scope, behaviour, constraint,
acceptance criterion or delivery boundary changed.

## Revision 3 versus revision 2 (2026-10-26, coordinator spot-read)

Baseline: revision 2 (422 lines, SHA-256 prefix `0f247ecadc297174`), never owner-approved.
Changed in revision 3:
- **Review provider transport.** `execCommand` has no stdin option (verified in
  `process.d.ts`); the review runner now uses `spawnProcess(..., { stdio: "pipe" })`, writes the
  `ReviewRequest` to `child.stdin`, collects bounded stdout/stderr, and uses `terminateProcess`
  on timeout, pause, rework or cancel. Tests use a fake process factory; nothing is executed now.
- **Worktree identity.** `dirtyTreeHash` (status plus diff) replaced by `WorktreeIdentity {
  headCommit, indexTreeHash, worktreeTreeHash, untrackedHash }` covering HEAD, index (digest of
  `git ls-files --stage -z`; no index copy or object writes, valid in linked worktrees where
  `.git` is a file; unmerged stages → `evidence_not_ready`), tracked worktree diff, and untracked files by path, type and
  content including deletions; explicit exclusion scope is only `.decisions/` and the plugin's
  evidence directory; identity taken before and after each check or review, any drift invalidates
  the result. Tests enumerate each drift kind (R3.3).
- **Provenance wording.** "Prove a human instruction" replaced by "verify that a `user_message`
  containing the quoted words exists in the host timeline"; helper renamed
  `verifyUserMessage`; human origin is explicitly not authenticated (§0, R3.2).
- **Fail-closed v2 approval.** Revision 2's R1.2 let the server approve new `schema: 2`
  revisions "legacy-style" while the client computed gates. Revision 3 adds a server guard in
  Task R0.6 (`plan_ineligible` with `gates_not_available` for any `schema: 2` revision, legacy
  revisions unchanged), a test for it, truthful UI text in R1.2, and R2.1 replaces the guard with
  the real blockers. No stage can approve a v2 revision without server-side gates.
- **§8.** The forced interrupt is no longer presented as an owner tradeoff; it is an optional
  future feature out of scope, no UI planned; the approved safe pause with no forced stop ships as
  designed; no owner decision is needed to approve the plan.

## Revision 2 versus revision 1

Baseline: revision 1 of `docs/plans/2026-10-26-decision-roadmap-redesign-implementation.md`
(first 349-line version, 2026-10-26, SHA-256 prefix `49a252b4c505d8ee`), never owner-approved.
Target: revision 2 (422 lines). The approved product design is unchanged; this delta covers the
plan only. Triggered by `.sdd/ui-mockups/implementation-plan-coordinator-notes.md`,
`implementation-host-contract-audit.md` and `implementation-chat-provenance-audit.md`.

## Changed scope and behaviour

- **DoD evaluation.** Revision 1 treated plain DoD lines as informational for `auto` tasks and
  ran review only when a `- [review]` line existed. Revision 2: every non-check line is a review
  criterion; the configured independent review runs always and must return a structured verdict
  per criterion; checks and review are bound to `ResultBinding { taskId, planId, planRev,
  contentHash, runToken, worktree: { headCommit, dirtyTreeHash } }`; exit 0 alone passes nothing;
  no human gate is added to `auto` tasks (§1 rows "DoD evaluation", "Result binding", "Review
  provider contract"; Task R3.3).
- **Delegated start.** Revision 1 let `roadmap_start { delegationNote }` record a delegation.
  Revision 2 requires a grant→agent binding (env fingerprint on `agent.create`, `agentId` on
  `agent.session_open`) and a real `user_message` in that chat's host timeline containing the
  quoted words, records `DelegationProvenance`, and states the residual risk that the host
  timeline carries no sender origin (§0, §1, Tasks R3.2, R3.4, §7).
- **Legacy data.** Revision 1 added defaults and `blocks` into v1 objects. Revision 2 verifies
  the raw v1 `changeToken` first, projects v1 into a v2 view in memory, stores legacy sessions
  and plans verbatim, versions `contentHash` by `PlanRevision.schema`, and applies DoD/grilling
  gates only to `schema: 2` revisions (§1 rows "Schema v2 and legacy projection", "Versioned
  revision hashing"; Tasks R0.1, R0.2, R2.1). The v1 fixture source is
  `.handoff/synthetic-home-decisions`, not an invented path.
- **Pause and interrupt.** Revision 1 called the host interrupt unknown. Revision 2 records the
  verified facts (`send` without `activeTurnBehavior` interrupts; `"steer"` injects; CLI `paseo
  stop` via `execCommand`), uses steer plus acknowledgement for pause, and listed a forced
  interrupt control as an owner tradeoff (§0, §1, §8; reclassified in revision 3 as an optional
  future feature, see above).
- **Coordinator isolation.** Revision 1 created the coordinator in the current workspace with a
  placeholder config. Revision 2 creates an isolated worktree workspace through
  `paseo.workspaces.create({ source: { kind: "worktree", … , refName } , agent })`, maps a saved
  profile from `paseo.config.get()` to `PaseoAgentConfig` (`"provider/model"`), and stores only
  the profile reference (§1 row "Coordinator binding and isolation"; Task R3.4).
- **In-panel chat.** Revision 1 allowed an "open chat" fallback via `navigation.openAgent` and
  claimed it satisfied the layout. Revision 2 removes that claim and adds `client/feature-chat.tsx`
  and `client/use-agent-timeline.ts` built on `usePaseo()` timeline and `send` (Task R4.1, §7).
- **Task cancellation.** `cancelled` is server-only: `task.update` and `roadmap_task_update`
  narrowed; `taskTransition` rejects manual moves (§1 row "Task cancellation"; Task R2.3).
- **`StoreFs`.** `lstat` result gains `isFile()` with fakes updated explicitly (§1; Task R0.3).
- **History.** The "events capped" compaction of revision 1 is removed; run records are
  append-only; `keepGenerations` is described as snapshot retention only (Global Constraints, §7).

## Changed delivery structure

- Write ownership: aggregating tables are edited only by a sequential integration task per
  stage (R0.6, R1.4, R2.4, R3.5, R4.5); per-stage contract modules `shared/rpc-features.ts`,
  `rpc-runs.ts`, `rpc-dod.ts`, `rpc-blocks.ts` and `server/feature-tools.ts`, `run-tools.ts` keep
  parallel tasks on disjoint files. The dependency table was recomputed; former conflicting
  pairs (R0.4/R0.5 on `rpc.ts`, R3.2/R3.3 and R4.2/R4.3 on `runs.ts`) are now disjoint or
  sequential.
- Placeholder removal: the roadmap screen shows no progress column until runs exist (added in
  R4.4); the interim client-side approval blocker rule in R1.2 is documented as interim.
- Research section closed with source-backed facts; no `<from research>` placeholders remain.
- Git remote corrected: a `github` remote exists; no push is part of the plan.
- Process bounds (`checkTimeoutMs`, `reviewTimeoutMs`, `maxBuffer`) added as technical runner
  defaults, explicitly not owner spend policy; `terminateProcess` on pause/rework/cancel.
- Stage count unchanged (R0–R4); tasks renumbered to add the integration tasks and the chat task.

## Unchanged

Goal, architecture outline, five vertical stages, separate production/test ownership,
exact-revision KensAI per stage, validation commands, scope map coverage of design §1–§9, and the
rule that nothing in the plan is executed before owner approval.
