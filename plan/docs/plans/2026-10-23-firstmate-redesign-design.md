# Decision Roadmap: Firstmate-replacement redesign (consolidated design)

Status: APPROVED by the owner on 2026-10-26 (owner's message, in Russian: "approved, go"). Approved content SHA-256
`e1dd6fb5e4a6a810cb23f10bde7fa96350b71f7c41c69b2b42eb3c49248cf3d3` is recorded in the canonical
ledger `.sdd/ui-mockups/grilling-coordination.md`. Changes since that approval: (1) this status block
was rewritten and Russian strings were paraphrased into English (editorial, 2026-10-26); (2) §4
gained the owner-approved clarification that frozen means accepted content while derived
validity/staleness is recorded separately (owner answer of 2026-10-26 in the ledger; dated entry
"Frozen content versus derived staleness" in the design delta), with a factual correction on
2026-10-26 limiting propagation to upstream re-answers. The whole current file is therefore
`e1dd6fb5…` plus those recorded changes, each carrying its own authority; no other content changed. Consolidated product DESIGN written 2026-10-25 and revised after one
bounded Astra advisory (dispositions in `.sdd/ui-mockups/fable-design-advisory-disposition.md`) by
the Fable planner from the canonical owner decision ledger (Q1–Q31, verbatim answers) and the
Firstmate inspection notes `.sdd/research/firstmate-0.4.0/inspection-notes.md`. The ledger
overrides the original grilling record `docs/plans/2026-10-23-firstmate-redesign-grilling.md`,
which is preserved as history.

All owner choices Q1–Q31 are answered and the whole design is approved. Design approval is not
implementation authority: code follows only after the separate written implementation plan
`docs/plans/2026-10-26-decision-roadmap-redesign-implementation.md` is approved by the owner and
passes the project's existing gates; this document authorises no install, reload, store change,
publication or model routing. The delta against the historical illustrative mocks and the
planner's Round 1 proposal is in `docs/plans/2026-10-23-firstmate-redesign-design-delta.md`.

## 1. Baseline that is preserved

- Shipped and accepted Stages 0–5 at feature `feb6905`: local canonical store
  `<storeRoot>/.decisions/`, decisions with revisions, conditions, dependencies and staleness,
  plans with revisions and exact-revision UI approval (`planRev` + `contentHash`, receipt),
  task states, tracker intents with recovery, MCP tools with self-scope, settings, `/roadmap`
  slash command, timeline rows, wide and compact layouts, themes.
- The existing `.decisions` data in the main root stays readable and is migrated additively if
  the model is extended. No reinitialisation, no destructive defaults. The technical form of
  that migration is the deferred Q3 and is decided in the implementation plan, not here.
- Approval stays a UI action on an exact plan revision. No MCP tool approves a plan revision or
  marks a task verified. Starting execution may be authorised by the human in the UI or by an
  explicit human delegation given in chat (owner correction 2026-10-25, §3.1, §6); approval alone
  never starts anything.
- This repository's own worker and reviewer routing (which models write code, which reviewer
  gates commits) is project workflow, not product configuration. The product does not hard-code
  any model or review provider.

## 2. Concepts

**Roadmap.** One per Paseo project. An ORDERED list of feature cards with their status and
dependencies. There is no separate built / not built field, status or badge on the roadmap: the
six feature statuses carry that information, and an empty or fully done list needs no extra
aggregate flag (owner correction 2026-10-25, superseding the earlier illustrative "built versus
not built" requirement). Done features and their history stay in the list; no deletion, archiving
or filtering mechanics are inferred. The human owns the feature set (owner clarification after Q2).

**Feature card = feature.** Created by the human in the UI, or by an agent through MCP as the
result of work the human asked for in a separate chat (for example "plan project ABC, then
create the roadmap in Paseo"). Either way the card is editable later by the human. Cards do not
come out of grilling (Q2). A card records who created it (human, or agent and originating chat)
as attribution. Card creation or editing never authorises execution (Q6).

**Feature status (six, Round 2 owner answer):** created, planned, executing, done, deferred,
cancelled. No seventh status. Operational execution state (running, paused and the pause reason)
is separate from status (Q17).

**Feature dependencies.** A feature may depend on other features (owner clarification before
Q10). Direction follows the owner's example: the email-channel plugin feature depends on the
plugin-system feature.

**Plan.** Belongs to a feature. A plan has revisions; a revision holds Markdown, the task list the
revision WILL create, each task's dependencies, explicit parallel grant, completion policy, grill
checkbox and human-owned Definition of Done (DoD), and the decision snapshot it is based on. A
revision cannot be approved while any task lacks a DoD or while required grilling (feature, plan,
checked tasks) is incomplete (Q26=1, Q27=1); a draft feature may exist without a DoD. Approval of one exact revision materialises exactly the
task set shown in that revision's preview (Q6). Once execution of a revision has started, that
revision is frozen; it is never patched in place (Q12).

**Tasks.** Ordered execution units inside an approved plan revision. Each task declares the tasks
it waits for and whether it is granted parallel execution at planning time (Q4). The absence of
a dependency is not a parallel grant. Each task carries its completion policy from the plan
(Q7=4): automatic after required checks and review, or human acceptance in addition. Mandatory
checks and review are never skipped by either policy. A task counts as complete only when the
completion predicate of §3.5 holds; an agent's own "done" report is progress, not completion.

**Feature coordinator (one per feature; "Firstmate" is only the owner's analogy, not a
dependency or a required behaviour).** When execution starts, the feature is
bound to exactly one coordinator agent with its own chat and crew (Q5, Q9, Q16, Q19). The
coordinator takes the whole feature, dispatches ready tasks to workers under the frozen plan's
order, dependencies and parallel grants, and reports status back to the store. Workers are not
mandatorily one fresh agent per task. Independent features run in parallel in separate feature
chats; the product imposes no global single-feature lock (Q9).

**Execution run.** The coordinator's work on one approved revision. States: running, paused
(reason: owner pause, deferred, prerequisite not done, prerequisite cancelled, repair ceiling),
ended (reason: finished, cancelled for rework, cancelled with feature). The full matrix is §3.6. Pause means stop as fast as is safe, preserving plan, tasks, code and
resumable context; no rollback, no kill of the group (Q9, pause clarification, Q17).

## 3. Lifecycles

### 3.1 Feature status

- created → planned: a plan revision for the feature is approved.
- planned → executing: a start authorisation by the human (Q5=2, Q16=4). Two equivalent forms:
  the Start control in the UI (feature screen or the same control rendered inside the bound
  chat), or an explicit human delegation given in chat and carried out by the agent through MCP
  (owner correction 2026-10-25). The delegation may cover one feature or roadmap traversal
  ("go through the roadmap until everything is done"): ready features then start without a
  per-feature click, each still waiting for its own approved plan revision, prerequisites and
  checks, and each still bound to one coordinator. A delegation is revocable and stop/pause
  always wins. Approval alone does not start execution; there is no conversational approval of
  a plan revision. The earlier "UI-only start" wording was a planner proposal, now superseded.
- executing → done: automatically when every task of the executing revision meets its approved
  completion rule (Q10=1). Waiting for a human acceptance is an activity reason inside executing,
  not a status.
- any of created / planned / executing → deferred: explicit human action; if a run is active it
  is safely paused (Q17=1).
- deferred → the status held before deferral (created, planned or executing): explicit human
  undefer (Q23=1). A preserved run stays paused until the human presses Resume and the §3.3
  readiness checks pass; the status change never resumes agents.
- any of created / planned / executing / deferred → cancelled: explicit human action; an active
  run is safely paused and then ended; work and history are preserved.
- Deletion: allowed only while the feature has never started execution (created, planned, or
  deferred before any start). After the first start the card is never deleted, including after
  deferral or cancellation (Q15=1).
- done is not cancelled in place (Q22 free-form): undoing or removing a done feature is a
  SEPARATE feature card with its own plan and tasks; the original feature's work, history and
  done status are preserved. Creating such a removal card does not by itself roll anything
  back or invalidate dependents; its effects on dependents, if any, are planned and approved
  inside that removal feature like any other work. Later changes to a done feature with a
  started dependent are likewise a new feature card (Q20=4).
- after stop-and-rework (or a direct prerequisite cancellation) the feature has no current
  approved plan: its status is created with the visible reason "plan in rework"; history and
  work are preserved and the old task set is cancelled (Q25=1). No seventh status.

### 3.2 Plan revisions

- Drafting: a human in the UI or an agent through MCP drafts revisions. The revision diff view
  exists to review corrections without rereading the whole plan (Q12).
- Approval: UI only, exact revision; materialises the task set; feature becomes planned.
- Frozen during execution: no mid-run edits. To change a running plan the human stops it and
  sends it for rework (Q12 refinement): the executing run ends as "cancelled for rework", its
  task set is cancelled, all code and artifacts and the record of what was completed are kept.
  The next planning pass decides, per old task and after rechecking, what to reuse. The newly
  approved revision materialises its own task set. Completed work is never carried over
  automatically because text or ids match.
- Plans stay with the same feature. Replanning never requires a new feature card.

### 3.3 Execution run

- Binding: the feature is bound to one coordinator (new chat created from the UI, or an existing
  suitable chat attached, Q16=4). Binding is not starting.
- Start: a start authorisation by the human, through the Start control or through an explicit
  chat delegation executed via MCP (§3.1); it is recorded for this run and this approved
  revision, and for a roadmap delegation it also records the delegation's scope so later ready
  features can start under it without a new click. A repeated start opens the existing coordinator
  chat; replacing the coordinator is a separate explicit action with safe handover and preserved
  history (Q19=1).
- Dispatch readiness (all required): feature status executing; run running; start authorisation
  recorded for this run and revision (UI control or an unrevoked chat delegation covering this
  feature); the revision is the current approved one; every
  prerequisite feature is done; every task dependency satisfies the §3.5 predicate; and, if other
  tasks are active, the task holds a parallel grant. A new approval alone never makes a task ready.
- Task failure: a failed check or review on one task does not stop independent tasks; the failed
  task is repaired within the agreed scope; dependents wait (Q8=1). A fix that needs a plan
  change is not applied silently; it goes through stop-and-rework.
- Repair ceiling: failed complete verification/review repair cycles are counted per task; the
  default ceiling is 30 and is configurable in plugin settings; reads and edits are not cycles;
  there is no separate oscillation detector (Q11=2, Q13=2, Q18=2). At the ceiling the
  affected task alone is paused and shown as "ceiling reached"; independent tasks continue and
  dependents wait (Q8=1, Q24=1). The human may grant an explicit additional budget of N cycles
  for that task, or stop the plan and send it for rework; the counter is never reset silently
  and the grant is recorded in the store. This is a finite
  autonomy guard, not a spend budget.
- Pause (owner clarification, Q17=1), minimum protocol: 1) the run leaves running and no new
  dispatch happens; 2) the coordinator asks every active worker to suspend at its nearest safe
  point and record a checkpoint and any in-flight external effect; 3) the run is acknowledged
  paused only when every active worker has acknowledged safe suspension; a worker that does not
  acknowledge, or an external effect whose outcome is unknown, stays visible as unresolved on
  the task and in the feature screen; 4) messages or results from workers that arrive for a run
  that is paused or ended are recorded as late evidence and never restart or complete work;
  5) resume and coordinator replacement re-evaluate the readiness conditions above before any
  dispatch. A raw interrupt alone is not a pause. The host mechanism is §9.
- Finish: when every task satisfies the §3.5 predicate the run ends finished and the feature
  becomes done (Q10=1).

### 3.4 Feature dependencies

- A dependent feature's execution waits until the whole prerequisite feature is done (Q14=1).
  Its coordinator may be bound and its plan approved, but dispatch does not start.
- Prerequisite cancelled while the dependent is planned or executing: the dependent's run is
  safely paused with reason "prerequisite cancelled", its task set is cancelled for rework, work is
  preserved, and an agent prepares a replacement plan draft for the human to review and approve
  (Q14=1). The replacement must be approved, a start authorisation (Start control or an unrevoked
  delegation covering the feature) must exist for the new run, and every prerequisite must be
  done before dispatch resumes; approval alone satisfies none of the others.
- Chain A → B → C with A cancelled (Q21=1): B follows the rule above. C is immediately safely
  paused with its tasks preserved; its replacement draft is prepared only after B's replacement
  plan is approved. Completed downstream features are not reopened.
- Completed prerequisite with a started dependent cannot be reopened (Q20=4); changes become a
  new feature card. Reopening a done prerequisite with no started dependents is not asked for and
  is not designed here (see §8).

### 3.5 Completion predicate (authoritative, one for dispatch and auto-done)

A task is complete when, for the executing revision and that task, all of the following are
recorded in the store by the plugin server from trusted sources:
1. every required check for the task has a passing result recorded by the server from the check
   runner's output, not from an agent's statement;
2. the required independent review has a passing result recorded from the configured review
   provider (deployment configuration, not a product constant);
3. where the approved completion policy says human acceptance, a UI acceptance by the human.

Agent reports through MCP move a task only between todo, in progress and done-claimed (the
existing `done` state); the server sets the existing `verified` state when the predicate holds, and
MCP can never set it. Dependent dispatch and feature auto-done (Q10=1) consume `verified` only. Which component records check and review results is implementation
design (§9); the rule that agent self-attestation never satisfies the predicate is product.

### 3.6 Transition matrix

| Event | Feature status | Run | Task set | Approval of current revision | Dispatch |
|---|---|---|---|---|---|
| Approve revision (feature created) | planned | none | materialised | current | no (needs a start authorisation; a covering unrevoked delegation may start it when ready) |
| Approve revision (feature deferred) | deferred | unchanged | materialised | current | no |
| Start (UI control or delegated via MCP) | executing | running, start authorisation recorded | kept | current | yes when §3.3 readiness holds |
| Pause by human | executing | paused (owner) | kept | current | no |
| Resume by human | executing | running after readiness re-check | kept | current | yes |
| Defer | deferred | paused (deferred) if active | kept | current | no |
| Undefer | status before deferral (Q23=1) | stays paused until human Resume and readiness re-check | kept | current | no |
| Cancel feature (not done) | cancelled | ended (cancelled with feature) after safe pause | cancelled, work kept | superseded | no |
| Undo or remove a done feature | done unchanged; a new removal feature card is created (Q22) | none on the done feature | kept | kept | n/a (the removal feature follows the normal lifecycle) |
| Stop and send for rework | created, reason "plan in rework" (Q25=1) | ended (cancelled for rework) after safe pause | cancelled, work and completion record kept | superseded | no |
| Replacement revision approved after rework | planned | none | new set materialised | current | no (needs a start authorisation; a covering unrevoked delegation may start it when ready) |
| Direct prerequisite cancelled (B) | created, reason "plan in rework" (Q25=1) | paused (prerequisite cancelled), then ended (cancelled for rework) | cancelled, work kept | superseded; replacement drafted automatically | no until approval, start authorisation and prerequisites done |
| Transitive prerequisite cancelled (C) | unchanged | paused (prerequisite cancelled) | kept | current until C's own replacement is approved | no; C replacement drafted only after B's approved |
| Prerequisite not yet done at start | executing | paused (prerequisite not done) | kept | current | no until prerequisite done |
| Prerequisite becomes done | unchanged | running if start authorisation exists, else unchanged | kept | current | yes when readiness holds |
| Task reaches repair ceiling | executing | running; that task paused "ceiling reached" (Q24=1) | kept | current | other ready tasks yes; the paused task only after an explicit N-cycle grant |
| All tasks verified | done | ended (finished) | kept | current | n/a |
| Delete card | removed | only if never started (Q15=1) | n/a | n/a | n/a |

## 4. Grilling (decision blocks)

Kept from the accepted requirements and the shipped decision model:

- Sequential, adaptive blocks of questions. The current block is editable; an explicit "Accept block and
  continue" control advances and freezes the previous block; frozen answers are read-only. A later
  change is a new decision or an explicit cancellation that supersedes the earlier one;
  cancelled decisions show red strikethrough with a reason.
- Frozen means the accepted content of a question: its answer and answer revisions, its
  definition (title, context, options, recommendation, free-text flag), its Note/discussion
  entries and its own relations. Derived validity is not content: when an open upstream
  question (in a later block or another session) is re-answered, a dependent
  question in an accepted block is marked stale with its cause, exactly as today, while its
  accepted answer stays unchanged and read-only. The upstream edit is allowed; the stale mark is
  shown on the frozen question; resolution is a new superseding decision in an open block, never
  an edit or re-confirmation of the frozen one (owner clarification 2026-10-26, recorded in the
  ledger; design-delta "Frozen content versus derived staleness").
- One Note per answer; no Discussion. Free-chat discussion of a question is a future version.
- Grilling rules (owner refinement 2026-10-25, superseding the earlier optional feature flag):
  a FEATURE and its PLAN are ALWAYS grilled; grilling a BUG is optional; a TASK has a
  "grill" checkbox, set by the human or by the MCP agent for a big or unclear task, and a checked
  task must be grilled. All required grilling completes before the exact plan revision is approved
  (Q27=1); the task checkbox is part of the draft/preview task specification and does not permit
  mutating an approved task. Grilling can also be started on demand. For a bug the agent may
  request a way to reproduce (WTR); it may be unavailable, it is not a mandatory field and
  requesting it is not grilling. Grilling does not generate feature cards. Plans still record the
  decisions they are based on, so staleness of a plan's basis stays visible as today.
- Chat answering through the existing MCP tools and UI answering share one durable history.

## 5. User interface

**Roadmap screen.** The ordered feature list: cards with status and dependencies; executing
shows progress. No separate built / not built marker. Human actions: create card, edit card, set dependencies, defer,
resume, cancel, delete (only before first start), open feature. Optional for a small feature:
a feature can be planned and executed without the roadmap being the entry point, but it is still
a card.

**Feature screen, wide (>600 px).** Tasks on the left in execution order, with dependency lines,
parallel grant marks, state and attempts; the bound coordinator chat on the right. Header: title,
status, execution state, Plan and Changes entries. Actions: start / open chat, pause, resume,
stop and send for rework, defer, cancel, replace coordinator (explicit, with handover).

**Feature screen, phone (≤600 px).** Separate screens for tasks, chat, plan and changes; a
persistent composer and action bar; 44 px targets; compact header.

**Plan screen.** Two revision selects at the top: same revision shows the plan or its Markdown;
different revisions show the diff with Markdown disabled. The task preview shows exactly the
tasks that approval will create, with dependencies, grants, completion policy, grill checkbox and
DoD. Approve is unavailable while a task lacks a DoD or required grilling is incomplete, and acts
on the exact selected revision. Approved and frozen revisions are marked; no re-approval prompts.

**Grilling screen.** Question body left, navigator right on wide; recommendation spine left;
explanation accordion per choice; chosen mark, no "Answered" pill. Phone: compact header,
separate question navigation, persistent CTA.

**Statuses shown.** Feature: created / planned / executing / done / deferred / cancelled.
Execution: running / paused (with reason) / ended (with reason). Task: todo / in progress / checks pending /
review pending / waiting for acceptance / done / verified / cancelled; "not done before checks"
holds.

## 6. Agent and MCP surface

Allowed through plugin MCP tools, within the project's self-scope rules:
- Create and update feature cards and their dependencies (as a work result the human asked for).
- Draft plan revisions with tasks, dependencies, parallel grants and completion policies.
- Report task progress and state transitions permitted today (never verified), repair attempts,
  and coordinator status.
- Answer decision questions, as today.
- Start execution of a feature, or traverse the roadmap starting ready features, when the human
  has explicitly delegated that in chat (owner correction 2026-10-25). The delegation is scoped
  (one feature or the roadmap), recorded as the start authorisation, revocable, and never
  overrides plan approval, prerequisites, checks, parallel grants, stop or pause. No other MCP
  authority is widened by it.

Only through explicit plugin UI controls operated by the human (on the feature screen or the same
controls rendered inside the bound chat): approve a revision, pause, resume, defer, cancel,
stop-and-rework, delete a never-started card, replace a coordinator, accept a task whose policy
is human acceptance, and every tracker publication gate that exists today. The earlier
"UI-only start" restriction in this list was a planner proposal, superseded by the owner
correction above.

The coordinator and its workers are Paseo agents created and controlled through Paseo's own
tools; which agents, models or review providers they use is deployment configuration, not a
product constant.

## 7. Settings

- Repair ceiling per task: default 30 failed verification/review cycles, configurable (Q18=2).
- DoD template: the file `dod template.md` if present, else project settings, else global
  settings; the first found replaces the others, no merge; the effective source is shown with
  the agent's proposal (Q31=1).
- Existing tracker and roadmap settings remain.

## 8. Owner choices Q22–Q25

Answered 2026-10-25 (canonical ledger), incorporated above:
- **Q22 (free-form):** cancelling a done feature is a separate feature with its own plan and
  tasks; original work and history preserved; no instant rollback or dependency invalidation is
  inferred from creating the removal card (§3.1, §3.6).
- **Q23=1:** undefer restores the prior status; an executing run stays paused until explicit
  Resume with readiness checks (§3.1, §3.6).
- **Q24=1:** only the affected task pauses at the repair ceiling; independent tasks continue;
  continuation needs an explicit additional N-cycle budget or rework; no silent reset (§3.3,
  §3.6).

- **Q25=1:** during rework the feature status is created with the visible reason "plan in
  rework"; history and work preserved; the old task set cancelled; no seventh status (§3.1, §3.6).

No product question remains pending. Whole design approved by the owner 2026-10-26.

## 8a. Owner corrections 2026-10-25/26 (grilling, DoD, template; Q26–Q31 answered)

Owner correction (canonical ledger holds the Russian original; English paraphrase): grilling is
mandatory when the "grill" checkbox is set on a feature or a task; a task can be grilled too;
Firstmate was taken only as an example to explain roughly what is wanted; a task is accepted by
its DoD, which the human defines; cards cannot be done without a DoD; there is an example
template for each DoD, settable in project settings; a DoD can also be grilled; grilling can be
started whenever it is needed.

Firm, incorporated as facts (with the owner's refined rule and the WTR clarification recorded in
the ledger with Q26/Q27):
- Feature and plan are always grilled; bug grilling is optional; a task has
  a "grill" checkbox that the human or the MCP agent may set for a big or unclear task, and a
  checked task must be grilled. Grilling can also be started on demand.
- The owner's abbreviation (transliterated "vtr", clarified by the owner) = way to reproduce (WTR), bug reproduction steps: the agent may request it, it may be
  unavailable, it is not an always-required field and requesting it is not mandatory grilling.
- A task is accepted by its task-specific, human-owned Definition of Done (DoD).
- A DoD template exists; a DoD can itself be grilled. Template sources named by the owner
  (2026-10-26): GLOBAL settings, PROJECT settings, or a file `dod template.md` (exact spelling).
  File location and discovery are technical detail for the implementation plan.
- **Q28=3:** when a plan is drafted, the agent proposes a tailored DoD per task using the
  template as guidance; the human reviews and edits it; the DoD stays human-owned and the
  approval gate (Q26=1) is unchanged. No naive pre-fill is required.
- **Q29=1:** every template item is fully editable and removable per task; the template is a
  convenience, not a rule. Required checks and review stay enforced by the completion predicate
  (§3.5) regardless of DoD text.
- **Q30=1:** a change of the template or of its source affects NEW tasks only; existing draft and
  approved DoDs are never rewritten.
- **Q26=1:** DoD per task, mandatory at plan approval; a draft feature may exist without one.
- **Q27=1:** all required grilling (feature, plan, checked tasks) completes before approval; the
  task checkbox belongs to the draft/preview specification; no live mutation of approved tasks.
- Firstmate is an analogy used to explain the intent; nothing in Firstmate's source mechanics is
  a mandatory product choice. The owner-selected per-feature coordinator, chat and crew stay.

- **Q31=1:** source precedence: the file `dod template.md`, then project settings, then global
  settings; the first source found replaces the others entirely (no merge); exactly one template
  is in effect and its source is shown next to the agent's proposal.

No product question remains open; design approved 2026-10-26. Numbering note: an earlier Q28 on DoD evidence in the
completion predicate was never relayed (technical, superseded); the final Q28 is the template
initialisation answer above. Edits to a DoD after approval go through stop-and-rework like any
plan change (Q12) and need no new choice. Not
relayed, no default: how the DoD is evidenced inside the completion predicate (§3.5) is
technical design under the owner-set acceptance basis, raised only if a genuine behaviour choice
appears. §§2, 4 and 5 are revised above.

## 9. Deferred technical decisions (implementation plan, not this design)

- Q3: model extension and additive migration of existing `.decisions` data (features, feature
  dependencies, per-task dependencies and grants, completion policy, blocks, execution runs,
  coordinator binding); which MCP tools gain feature scope; how `/roadmap` and timeline rows
  surface features and runs; delivery staging and gates. Existing data and capabilities are
  preserved in every option.
- Safe-pause protocol with Paseo agents: the Firstmate inspection shows interrupt preserves agent
  and worktree but is not proof of a safe pause; the implementation plan must define it.
- Per-feature scoping of coordinator and crew discovery and state (the Firstmate inspection is
  evidence of what a singleton design cannot do, not a requirement to mirror it).
- Representation, persistence, validation and revocation mechanics of a chat start delegation
  (one feature or roadmap traversal) and how the MCP start tool proves it. No budgets or expiry
  are owner policy; they are technical choices for the implementation plan.

## 10. Ledger mapping

| Decision | Where |
|---|---|
| Q1=2 (+clarification) feature → plan → ordered tasks, no stages | §2, §3.2 |
| Q2 free-form + clarification: cards are features, human owns the set, agent may create on request | §2, §5, §6 |
| Round 2 free-form: six feature statuses, delete before execution | §2, §3.1 |
| Q4=1 dependencies and explicit parallel grants | §2, §3.3 |
| Q5=2 human starts, coordinator dispatches | §3.1, §3.3 |
| Q6=1 approval materialises previewed tasks | §2, §3.2 |
| Q7=4 per-task completion policy | §2, §3.3 |
| Q8=1 independent tasks continue, dependents wait | §3.3 |
| Q9 free-form whole feature by a group, parallel features | §2, §3.3 |
| Q10=1 feature auto-done | §3.1 |
| Q11=2, Q13=2, Q18=2 finite generous ceiling, 30, configurable, no detector | §3.3, §7 |
| Q12 free-form + refinement: frozen plan, stop-and-rework, recheck before reuse | §3.2 |
| Pause clarification, Q17=1 | §2, §3.1, §3.3 |
| Q14=1 dependents wait for whole prerequisite; rework on cancellation | §3.4 |
| Q15=1 no deletion after first start | §3.1 |
| Q16=4 UI creation and existing-chat binding; one Firstmate per feature | §2, §3.3 |
| Q19=1 repeated start opens existing chat | §3.3 |
| Q20=4 no reopening after dependent started | §3.1, §3.4 |
| Q21=1 transitive safe pause, sequential replanning | §3.4, §3.6 |
| Q22 free-form, Q23=1, Q24=1 | §3.1, §3.3, §3.6, §8 |
| Q25=1 | §3.1, §3.6, §8 |
| Owner correction 2026-10-25: roadmap is an ordered feature list, no built / not built | §2, §3.5, §5 |
| Owner correction 2026-10-25: explicit chat delegation may start execution via MCP (one feature or roadmap traversal) | §1, §3.1, §3.3, §3.6, §6, §9 |
| Owner corrections 2026-10-25: grilling rules, DoD, WTR, Firstmate analogy only; Q26=1, Q27=1 | §2, §4, §5, §8a |
| Q28=3, Q29=1, Q30=1, Q31=1 (DoD template: agent proposal, fully editable, new tasks only, file > project > global, no merge) | §7, §8a |
