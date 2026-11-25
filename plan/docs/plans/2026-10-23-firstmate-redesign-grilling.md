# Firstmate-replacement redesign: grilling record

Status: planning record. Round 1 (Q1, Q2) answered by the owner 2026-10-23; Round 2 (Q4, Q5,
Q6) issued 2026-10-23. Stage 5 is shipped, a real store exists, accepted blocks are immutable,
Q3 is deferred by coordinator scope choice. Owner-requested grilling (owner's words, in Russian: "let's start the
grilling"). Fable planner owns the rounds and the consolidation; the coordinator relays questions
and answers in Russian. Nothing here authorises implementation, mock promotion, publication or
any runtime, store, settings, auth or git change. The mockups under `.sdd/ui-mockups/` are
illustrative only, not a production or approved execution contract.

## Accepted prior design (kept unless an owner answer changes it)

From `docs/SPEC.md`, `docs/plans/2026-10-20-decision-roadmap.md` and owner choices 2026-10-20/21,
implemented and accepted through Stage 5 at the exact final feature revision
`feb69056433685b89b7ebc18fedd8c8095d5970b` (installed plugin accepted, actual UI verified):
- Local canonical store `<storeRoot>/.decisions/` per registered Paseo project, shared by all
  worktrees; optional tracker (SnailOrbit) mirrors approved execution tasks.
- Session → questions (options, recommendation, free text) → answers with revisions, explicit
  conditions and dependencies; dependent decisions marked stale after relevant answer changes.
- Plan with revisions `{ markdown, tasks[], basedOn, decisionSnapshotHash }`; approval refers to
  one exact plan revision (`planRev` + `contentHash`) and only through the UI; task states
  `todo | in_progress | done | verified`; MCP tools for chat answering and task status (never
  `verified`); no tracker tools in MCP.
- Both chat and UI answering share one durable history.
- Stage 5 shipped and reviewed: `/roadmap` slash command (`client/slash.ts`) and agent timeline
  rows (`server/timeline-rows.ts`).
- A real store exists in the main root (`.decisions/manifest.json`, synthetic data from the last
  UI acceptance; its current revision is not assumed and its contents are not read here).
  Any redesign must say what happens to existing data.

## New owner requirements (verified in the current conversation, reused, not re-asked)

- The plugin replaces the Firstmate workflow, not only the questionnaires.
- Project-level grilling first; accepted answers form roadmap FEATURE cards; work proceeds
  through those cards. Each feature card launches its own Firstmate-like work cycle and holds its
  decisions, plans and work results. The roadmap shows built versus not built. Roadmap is optional
  for a small feature; grilling is optional for a bug.
- Grilling runs in sequential, adaptive BLOCKS. Answers of the current block are editable;
  an explicit "Accept block and continue" control freezes the previous block after advancement; prior answers are
  read-only; cancelled decisions are red strikethrough with a reason; only a Note per answer; no
  Discussion (free-chat discussion is a future version).
- Wide layout: question body left, navigator right; recommendation spine left; choice
  explanation accordion; chosen check mark, no "Answered" pill, no test ids. Phone: compact
  header, separate question navigation, persistent CTA, 44 px touch targets.
- Plan view: two top revision selects; 2→2 shows the normal plan or MD; 1→2 shows a diff with MD
  disabled. An approved plan revision is required for execution.
- Execution mock (illustrative): inside a feature, stages left and chat right on wide; phone has
  separate stages and diff views with a persistent composer; statuses working / stopped / needs
  answer / review pending; a stage is not done before its checks; stop does not roll back.

## Unsettled: the ambiguity that triggered the grilling

The coordinator's mock split a feature into stages, each with its own plan, with tasks inside a
stage (four levels). The owner asked, in Russian, "stages are tasks, right?". The hierarchy is
UNSETTLED. Neither the four-level mock nor a flattening is assumed.

## Branch map (design tree)

Q1 and Q2 are independent roots and form Round 1. Q3 is a root deferred until Q1 and Q2 are
settled (coordinator scope choice). Children wait for their parent's answer.

- Q1 Execution hierarchy inside a feature card
  - Q1.1 Unit of one agent work cycle (one conversation per feature, per stage, or per task) and
    where the chat transcript attaches
  - Q1.2 Status model per unit (working / stopped / needs answer / review pending / done) and
    what "not done before checks" gates: automated checks, independent review, owner acceptance
  - Q1.3 Plan revisions and approval per unit; whether a re-approval is needed when a unit's
    task list changes mid-execution
  - Q1.4 Left list content on wide and on phone (stages, tasks, or grouped tasks)
  - Q1.5 Tracker mirroring unit (what becomes a ticket) and MCP task-status tool mapping
- Q2 How feature cards are formed (answered: agent work result from a separate chat, not from
  grilling; the children below are superseded by the "Tree changes after Round 1" section)
  - Q2.1 Whether the card list is a revisioned, acceptable artifact (a roadmap revision) or free
    editing
  - Q2.2 Built / not built derivation: from execution state only, or with a manual override
  - Q2.3 Dependencies and ordering between cards; how a superseding or cancelling decision
    affects cards based on the earlier decision (staleness policy)
  - Q2.4 Small-feature and bug entry points that skip roadmap or grilling
  - Q2.5 Per-feature grilling: same block UI, scope of questions, link to project-level answers
- Q3 Relation to the accepted implementation (Stage 0–5 code) and existing store data
  - Q3.1 Store schema versioning and the migration of the existing v1 data
  - Q3.2 Which MCP tools gain feature/cycle scope; chat answering of blocks
  - Q3.3 How the shipped `/roadmap` command and timeline rows surface feature cards and cycles
  - Q3.4 Delivery staging and what remains acceptable as a UI shell before execution exists
- Cross-cutting, later: cancellation semantics for cards and units; compact clients; themes;
  where Firstmate-specific concepts (if any) are intentionally not replicated.

## Round 1 (issued 2026-10-23)

See the question text in §"Round 1 questions". Answers and defaults are recorded in §"Answers".

### Round 1 questions

❓ **Q1 — Execution hierarchy inside a feature card**

Verified today: the accepted model is plan revisions with a flat task list, approval per exact
plan revision, task status todo / in_progress / done / verified, and tracker tickets per task.
The illustrative execution mock added a fourth level: feature → stages, each stage with its own
approved plan → tasks inside the stage, and "Stage 2 of 4" in the header. The owner asked whether
stages are tasks. Each option below changes what the left list shows, how many plan approvals a
feature needs, and what the tracker mirrors.

1. Four levels as mocked: feature → stages, each with its own plan and approval → tasks. More
   approvals per feature; a long feature can be approved piecewise; two task-like levels to
   explain in the UI, tracker and MCP.
2. Three levels: feature → one plan with revisions and one approval → tasks. The left list is the
   task list; "stage" disappears. Reuses the accepted plan/task model unchanged. (recommended)
3. Three levels with grouping: feature → one plan → tasks, where the plan may group tasks under
   ordered stage headings for display and ordering only, with no separate plan or approval per
   group. Left list shows tasks under headings.
4. Two levels: feature → tasks, no plan document; the approved task list is the plan. Simplest
   screen, but drops the Markdown plan, revision diff and content-hash approval that are already
   built and accepted.

➡️ Option 2. The accepted model already gives a feature exactly what the cycle needs: a plan with
revisions and a diff, one exact approval, and tasks with states that the tracker and MCP tools
understand. A stage level adds a second approval loop and a second status vocabulary without a
behaviour the owner has asked for. The planner's trade-off proposal, not an accepted rule: a
feature too large for one plan would be split into two feature cards rather than given a stage
level; this is unsettled and is decided by this answer or a later round. Option 3 is the
fallback if ordered grouping is wanted for readability; it costs only a heading field.

---

❓ **Q2 — How feature cards come out of the project grilling**

Verified today: project grilling runs in sequential blocks; an accepted block is immutable, and
any later change is a new decision or an explicit cancellation that supersedes an earlier one,
never an edit of a frozen answer. Accepted answers form the roadmap feature cards, and the
roadmap shows built versus not built. Not settled: who writes the cards, when they appear, and
whether the owner accepts the card list as such. This decides whether the roadmap is a
trustworthy scope boundary. How superseding decisions affect existing cards is a later child
question (Q2.3), not asked here.

1. One proposal after all blocks: once the last block is accepted, the agent proposes the card
   list from the accepted decisions; the owner edits it and accepts it as a roadmap revision.
   Later new or cancelling decisions lead to a new proposed roadmap revision. (recommended)
2. Per-block proposals, confirmed at the end: each accepted block adds proposed cards; the
   owner sees the roadmap grow but confirms the whole list once after the last block.
3. Manual cards: the owner writes and orders cards by hand; accepted decisions are attached as
   references only; nothing is proposed or derived.
4. Automatically derived read-only cards: cards are computed from accepted decisions and change
   only when a new decision is accepted; no editing of the list and no acceptance step.

➡️ Option 1. It mirrors the accepted plan-approval pattern (a proposal the owner edits and
accepts as an exact revision), keeps accepted blocks untouched, and gives a superseding decision
a defined target. Option 2 shows the roadmap earlier but defers the same confirmation; option 3
loses the point of grilling first; option 4 removes the owner from scope control.

---

### Deferred root: Q3 (not in Round 1)

Coordinator scope choice: Q3 (compatibility and implementation form, including migration of the
existing store data) depends on the product hierarchy and card model and is asked only after Q1
and Q2 are settled. No technical migration choice is put to the owner before the model exists.
Draft kept for that later round, to be re-checked against the answers:

❓ **Q3 — Relation to the accepted implementation and its data**

Verified today: Stages 0–5 are implemented, reviewed and accepted at the exact final feature
revision `feb6905` (store, decisions, plans, approval receipts, tracker dry-run and gated live
mirror, MCP tools, settings, `/roadmap` slash command, timeline rows); the installed plugin was
accepted with actual UI verification. A real store exists in the main root with synthetic data
from the last UI acceptance. The redesign adds blocks, feature cards and per-feature cycles. This
answer sets the delivery frame for everything under Q1 and Q2 and says what happens to existing
data. No option cancels accepted Stage 5 behaviour silently; any removal would be its own
explicit decision.

1. Evolve in place: keep the accepted store, approval, tracker, MCP tools, slash command and
   timeline rows; add blocks, feature cards and cycles as versioned model extensions with a
   migration of existing store data; accepted screens are reshaped to the new layout. (recommended)
2. Parallel new model: a v2 store layout and UI for the redesign; existing v1 data is imported
   once by an explicit migration, after which v1 screens are retired; accepted behaviours are
   re-implemented against v2 before the old ones are removed.
3. UI-first over the unchanged model: new screens map blocks, cards and cycles onto the existing
   sessions and plans without schema changes; no migration; model changes come later only where
   the mapping proves insufficient.
4. Separate second plugin: the accepted plugin stays installed and untouched; the redesign ships
   as a new plugin with its own store; existing data is imported by an explicit migration when
   the owner switches.

➡️ Option 1. The accepted pieces (exact-revision approval, durable history, tracker intents with
recovery, MCP self-scope, timeline rows) are the hard parts and the redesign does not contradict
them; one migration keeps one history and the existing store. Option 2 rebuilds reviewed code
before it can be removed; option 3 risks forcing cards and cycles into structures not designed
for them; option 4 doubles maintenance and splits history.

### Answers (Round 1, owner, 2026-10-23; Russian originals are in the canonical ledger
`.sdd/ui-mockups/grilling-coordination.md`, English paraphrase here)

> Q1: option 2. Feature, then an agreed plan (showing which tasks will be created), then tasks in
> execution order. An agent takes a task and executes it. Importantly, some tasks can be done in
> parallel; agents must know whether a task may run in parallel; parallelism is decided at the
> planning stage.

> Q2: roadmap cards do not come out of grilling. An agent can create them from a separate chat as
> the result of its work, for example on the request "I have project ABC, let's plan it and after
> everything create the roadmap in Paseo".

Faithful reading (no defaults applied; explicit free-form answers taken as given):

- **Q1 = option 2, with clarification.** Feature → agreed exact plan (the UI shows which tasks
  WILL be created) → execution tasks in execution order. An agent takes a task and executes it.
  Some tasks may run in parallel; agents must explicitly know whether a task may run in parallel;
  parallel permission is decided at PLANNING time, never guessed at runtime. No separate stage
  entity. The representation of order and parallelism is not chosen yet (Round 2). The planner's
  "too large, split into two cards" proposal is NOT an accepted rule and is dropped.
- **Q2 = free-form answer that REPLACES the earlier requirement** "accepted answers form roadmap
  feature cards". Roadmap cards do not come out of grilling. An agent may create them as the
  result of its work from a separate chat, for example after "I have project ABC, let's plan it
  and after everything create the roadmap in Paseo". Grilling is not a required card
  generator. Whether a card keeps a link to its originating chat is a planner proposal to put to
  the owner, not an inferred requirement.

Unchanged requirements: roadmap optional for a small feature, grilling optional for a bug,
per-feature Firstmate-like cycle, immutable accepted question blocks, plan-revision approval in
the UI, narrow mobile UI. Q3 (implementation relation and data migration) stays deferred.

## Tree changes after Round 1

- Q1 branch: stage level removed. New children: Q4 (how the plan declares order and parallel
  permission), Q5 (who executes tasks and how a run starts). Still later: status model and what
  "not done before checks" gates, tracker mapping of parallel tasks, re-approval when the task
  list changes mid-execution, left list on phone.
- Q2 branch replaced: cards are an agent work result from a separate chat, through plugin MCP
  tools. New child asked now: Q6 (what an agent may create and where the execution gate stays).
  Later: card fields and link to the originating chat, built / not built derivation,
  dependencies and ordering between cards, small-feature and bug entry points, how a feature
  cycle is started from a card.
- Q3 remains deferred until the model from Q4–Q6 is settled.

## Round 2 (issued 2026-10-23)

Q4, Q5 and Q6 are independent of each other given the Round 1 answers.

❓ **Q4 — How the agreed plan declares execution order and parallel permission**

Settled: the plan lists the tasks that will be created, in execution order; some may run in
parallel; agents must know, and the permission is fixed at planning time. Open: in what form the
plan states it, because that is what the owner reads before approving and what an executing
agent is handed. Verified today: a plan revision holds Markdown plus a task list with id, title
and description, and approval hashes that content; adding a structured field changes what the
diff and the approval hash cover.

1. Each task names the tasks it must wait for ("after: T1, T3"). A task with no unfinished
   prerequisites is ready; tasks with no relation between them may run in parallel. The plan view
   shows the ordered list with its "after" line and derives a readable wave view. (recommended)
2. Ordered steps: the plan groups tasks into numbered steps; steps run one after another and the
   tasks inside one step may run in parallel. Simple to read, but a task that could start earlier
   waits for its whole step.
3. Ordered list with a per-task flag "may run in parallel with the previous task". Minimal UI,
   but it cannot express "after T1 and T3 but not T2".
4. Order and parallelism are written only in the plan Markdown; the agent reads the prose and
   decides. No structured field, no readiness shown in the UI, no guarantee the agent reads it
   the same way twice.

➡️ Option 1. Explicit prerequisites are exactly the information an agent needs ("may I start
this now, and in parallel with what"), they survive re-ordering, and a wave view can be derived
for reading while steps cannot express a dependency that crosses them. Option 2 is the fallback
if the owner prefers to approve waves rather than per-task lines. Option 4 contradicts
"agents must know".

---

❓ **Q5 — Who executes a task and how a run starts**

Settled: an agent takes a task and executes it; the feature cycle holds the results; an approved
plan revision is required before execution; stop does not roll back. Open: whether each task gets
its own agent, whether the owner starts runs by hand, and how parallel-permitted tasks are
actually run side by side. Verified today: Paseo can create agents per workspace and the plugin
can attach timeline rows and MCP grants to an agent; the number of agents that can run at once on
this host is not verified and is not assumed here.

1. Owner starts each ready task from the feature screen; each start creates a fresh agent for
   that task, with the task and its plan context; two parallel-permitted tasks run side by side
   only when the owner starts both. Transcript, status and results attach to the task. (recommended)
2. Automatic runner per feature: after approval, the plugin starts every ready task itself, up to
   a parallel limit set in the plan, each in a fresh agent; the owner only stops, answers or
   pauses the feature.
3. One long-lived feature agent works through the tasks in one conversation and delegates
   parallel-permitted tasks to its own sub-agents; the feature transcript is the only transcript.
4. Owner starts; one agent per feature is reused across tasks, continuing with the next task on
   "Continue" and keeping context between tasks; parallel-permitted tasks get an extra agent
   started by the owner.

➡️ Option 1. It keeps every start an explicit owner action, so an approved plan never turns into
unattended agent creation, while still allowing real parallelism when the plan permits it; a
fresh agent per task gives each task its own clean transcript inside the feature cycle. Option 2
is the most automatic and is a separate decision about unattended execution; options 3 and 4
mix task histories into one conversation.

---

❓ **Q6 — What an agent may create from a separate chat, and where the execution gate stays**

Settled: roadmap cards are created by an agent as a work result from a separate chat, through
the plugin's MCP tools; an approved plan revision, approved in the UI, is required for execution;
the roadmap shows built versus not built. Open: how far the agent's creation rights go (cards
only, or also draft plans and tasks) and whether the owner accepts cards. Verified today: the MCP
tool set has no approval tool and cannot mark a task verified; today's tools draft plans and move
task status. Creating a roadmap in Paseo is a local store write, not an external publication.

1. The agent may create and update roadmap cards and draft feature plans; nothing executes and no
   execution tasks materialise until the owner approves the exact plan revision in the UI;
   approval creates the tasks the plan shows. Cards record the creating agent and chat as
   attribution. (recommended)
2. The agent may create cards, draft plans and also materialise tasks immediately as "todo";
   only starting a task needs the UI approval of the plan.
3. The agent may only propose cards into an inbox; the owner accepts each card into the roadmap
   by hand; plans are drafted later from the accepted card.
4. The agent may create cards only; plans are written in the UI or by a later agent started from
   the card; no draft plan through MCP.

➡️ Option 1. It matches the owner's example ("plan the project, then create the roadmap"),
keeps the one gate the owner already settled (exact plan approval in the UI) as the only point
where execution tasks exist, and keeps the chat-side workflow useful. Option 2 shows tasks before
anyone approved them; option 3 adds a second acceptance step; option 4 forces the agent to stop
halfway through its work.

### Answers (Round 2)

Pending. Defaults are applied only when the owner skips a question or asks for defaults, and are
labelled as such here.
