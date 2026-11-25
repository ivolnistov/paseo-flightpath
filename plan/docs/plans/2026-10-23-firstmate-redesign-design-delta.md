# Redesign delta: consolidated design versus the historical baseline

Status: part of the design APPROVED by the owner on 2026-10-26 (approved content SHA-256
`29aaf8fb533b4d1707256b01c68a22e639ff40b30c1a482a1897b2b1f0ff4de7` in the canonical ledger; this
status line was added afterwards).

Written 2026-10-25. Baseline for comparison: the illustrative mocks
`.sdd/ui-mockups/roadmap-redesign.html` and `.sdd/ui-mockups/execution-workspace.html`
(2026-10-22) plus the planner's Round 1 proposal in
`docs/plans/2026-10-23-firstmate-redesign-grilling.md`. That baseline was never an approved
design; it was exploration and a question set. The target is
`docs/plans/2026-10-23-firstmate-redesign-design.md`.

## Removed

- Stage level (feature → stages with own plans → tasks). Now feature → one approved plan →
  ordered tasks (Q1=2). The mock's "Stage 2 of 4" header, per-stage plan and "Start stage" control go away.
- Feature cards derived from grilling (Round 1 Q2 proposal, all four options). Cards are
  features defined by the human, created manually or by an agent on request (Q2 + clarification).
- Planner's "feature too large must split into two cards" rule: never accepted, dropped.
- Fresh agent per task as a rule: superseded by one coordinator and crew per feature (Q9).
- Mandatory oscillation or loop detector: not requested (Q13=2).
- Discussion per question: Note only (accepted requirement, carried).

## Added

- Six feature statuses and the deletion boundary (Round 2 free-form, Q15=1). The roadmap is an
  ordered feature list without a separate built / not built marker (owner correction, see below).
- Per-task dependencies, explicit planning-time parallel grants and completion policy inside the
  plan revision; approval materialises the previewed task set (Q4=1, Q6=1, Q7=4). This is new
  behaviour: the shipped Plan schema has a flat ordered task list with no such fields.
- Feature-to-feature dependencies with wait, rework-on-cancellation, transitive safe pause and
  the no-reopen rule (owner clarification, Q14=1, Q20=4, Q21=1).
- Per-feature Firstmate-like coordinator with its own chat and crew; UI creation or
  existing-chat binding; repeated start opens the existing chat; explicit replacement with
  handover (Q5=2, Q16=4, Q19=1).
- Execution run states separate from feature status: running, paused with reason, ended; pause
  as fast as safely possible; defer also pauses (pause clarification, Q17=1).
- Frozen executing plan; stop-and-rework cancels the task set, preserves work, rechecks before
  reuse; revision diff is for correction review (Q12 and refinement).
- Failure handling: independent tasks continue, dependents wait; per-task repair ceiling default
  30, configurable, counting failed verification/review cycles (Q8=1, Q11=2, Q18=2).
- Feature auto-done when all tasks meet their rules (Q10=1).

## Kept from the mocks and accepted requirements

- Wide feature screen: tasks (formerly stages) left, chat right; phone: separate screens,
  persistent composer, 44 px targets; statuses working / stopped / needs answer / review pending
  map onto the run and task states; "not done before checks"; stop does not roll back.
- Plan screen with two revision selects, diff with Markdown disabled.
- Grilling blocks with explicit acceptance and freezing, Note only, red strikethrough with reason
  for cancelled decisions, body left and navigator right on wide, compact phone layout.
- All shipped Stage 0–5 capabilities and existing `.decisions` data (additive migration, Q3
  deferred to the implementation plan).

## Added after the Astra advisory (2026-10-25)

- One authoritative completion predicate (checks, review, optional human acceptance, recorded by
  the server; agent reports never satisfy it) consumed by dispatch and auto-done (design §3.5).
- Explicit Start as a plugin UI control, also when rendered inside the bound chat. The
  accompanying "no conversational start authority" was a planner proposal and is superseded by
  the owner correction below (design §3.1, §3.3, §6).
- Full readiness conditions and a transition matrix with run end reasons, task-set disposition,
  approval validity and dispatch eligibility (design §3.3, §3.6).
- Minimum safe-pause protocol: stop dispatch, coordinated suspension acknowledgement, visible
  unresolved effects, stale-event rejection, readiness re-check on resume (design §3.3).

## Owner answers 2026-10-25 (design §8)

- Q22 free-form: removing or undoing a done feature is a separate feature card with its own plan
  and tasks; the original work, history and done status stay; creating the card rolls nothing back.
- Q23=1: undefer restores the prior status; a run stays paused until explicit Resume.
- Q24=1: only the affected task pauses at the repair ceiling; explicit extra N-cycle budget or
  rework; no silent reset.

- Q25=1: during rework the feature shows status created with the visible reason "plan in
  rework"; history and work preserved; old task set cancelled; no seventh status.

## Correction after the first presented version (2026-10-25)

Baseline: the design and delta as first presented to the owner on 2026-10-25 (version with the
revised Q22–Q25 answers). While reading the Russian draft the owner corrected: the roadmap has
no built / not built; it stores an ORDERED list of features; zero features, all done, or some
not done need no separate marker. Changed: design §2 (Roadmap), §3.5 (predicate consumers), §5
(Roadmap screen) and the §10 mapping. The six feature statuses are unchanged; done features and
history remain in the list; no deletion, archiving or filtering mechanics and no migration are
inferred. This also supersedes the illustrative "built versus not built" requirement that the
mocks and the historical baseline above carried.

## Correction after the ordered-roadmap version (2026-10-25)

Baseline: the design and delta in the ordered-roadmap correction version presented on
2026-10-25. During the Russian review the owner rejected "no MCP starts execution / natural
language only opens the button" and said that if explicitly allowed, MCP may start, including
"go through the roadmap until everything is done". Changed: design §1 (approval gate wording),
§3.1 (planned → executing: start authorisation by UI control or by explicit chat delegation
executed via MCP, scoped to one feature or roadmap traversal, revocable, stop/pause wins), §3.3
(Start and readiness wording), §3.6 (Start row and the two "needs Start" rows), §6 (new MCP
ability; start removed from the UI-only list; the earlier UI-only start marked as a superseded
planner proposal), §9 (delegation representation, persistence, validation and revocation as
technical items; no budget or expiry owner policy) and the §10 mapping. Unchanged: exact plan
revision approval stays a separate UI gate and never starts anything; no conversational plan
approval; one coordinator per feature; order, dependencies and parallel grants; no other MCP
authority (deletion, cancellation, approval, verified) is widened. This is a product rule, not an
execution order for this repository.

## Owner corrections 2026-10-25: grilling rules, DoD, WTR, Firstmate as analogy; Q26=1, Q27=1

Baseline: the start-delegation correction version presented on 2026-10-25. Changed: design §2
(Plan revision now carries per-task grill checkbox and human-owned DoD; approval blocked without
DoD or with incomplete required grilling), §4 (grilling rules: feature and plan always grilled,
bug grilling optional, task checkbox settable by human or MCP agent, all before approval, no live
mutation of approved tasks; WTR = way to reproduce, requestable, optional, not grilling;
supersedes "grilling optional" and the earlier optional feature flag), §5 (plan preview shows DoD
and checkbox; Approve unavailable until both gates pass), §8a (verbatim correction, firm facts,
Q26=1, Q27=1, WTR), §9 and the §2 coordinator paragraph (Firstmate analogy only), §10 mapping.
Preserved: explicit MCP start delegation, ordered roadmap, every Q1–Q25 choice. Not relayed,
technical: DoD evidence inside the completion predicate. DoD template behaviour answered 2026-10-26:
Q28=3 (agent proposes a tailored DoD per task from the template, human reviews; no naive
pre-fill), Q29=1 (every template item fully editable and removable per task), Q30=1 (template or
source changes affect new tasks only). Owner-named template sources: global settings, project
settings, or the file `dod template.md` (design §7, §8a). 
## Template-sources answer (2026-10-26)

Baseline: the version presented with Q31 pending. Changed: design header (ready for whole-design
approval), §7 (effective template rule), §8a (Q31=1 and numbering note), §10 mapping. Q31=1: the
file `dod template.md`, then project settings, then global settings; the first source found
replaces the others entirely, no merge; one effective template with its source shown beside the
agent's proposal. Q28=3, Q29=1 and Q30=1 are unchanged. Preserved: ordered roadmap without a
separate done flag, explicit MCP start delegation, mandatory grilling of feature and plan with
the task checkbox settable via MCP, optional bug grilling with requestable WTR, human-owned DoD,
Firstmate as analogy only, and every Q1–Q25 choice.

## Frozen content versus derived staleness (owner clarification 2026-10-26)

Baseline: the approved design of 2026-10-26 (content SHA-256 `e1dd6fb5…` plus the post-approval
editorial edits; design file prefix `9109d9e8c6542921` before this change). Owner answer to the
blocking R0.4 question: when an outside upstream answer changes and a dependent question sits in
an accepted block, allow the upstream edit, preserve the accepted answer, record staleness
separately. Changed: design §4 gains the bullet defining frozen content (answer, revisions,
definition, notes, own relations) versus derived validity/stale metadata, which continues to be
recorded on frozen questions by the existing graph semantics. No other behaviour changes; no new
entity or status; resolution stays a superseding decision in an open block.

## Provenance note (2026-10-27, editorial)

The design status block had claimed that the status rewrite was the only change since approval.
That was inaccurate once the owner-approved §4 clarification above was added; the status block
now names both the editorial changes and the §4 clarification with their dates and authority.
No product behaviour or approval gate changed (R0 review round 2, c0049).

## Status

All product questions Q1–Q31 answered. Design and delta approved by the owner 2026-10-26.
Implementation requires the separately approved implementation plan.
