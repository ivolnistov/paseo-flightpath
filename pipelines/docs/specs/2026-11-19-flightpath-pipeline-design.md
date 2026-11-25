# Flightpath Pipeline design

Date: 2026-11-20. Status: first-stage DSL and Planning UI decisions are recorded in D9. The execution design is the implementation baseline. The Planning preview is tested in a separate local Paseo.

Plan: [implementation plan](../plans/2026-11-19-flightpath-pipeline-implementation.md).

## 1. Scope

Pipeline is a standalone Paseo plugin (`pipelines/`, id `flightpath-pipeline`). It owns the workflow definition, Start, agents, scheduling, checks, review, human acceptance, rework, typed outputs, recovery and run history.

Out of scope: integration and data exchange with other plugins; merging, pushing or publishing a run's changes (a run ends with them on its worktree branch); GitHub runners, downloaded actions and the keys `on`, `runs-on`, `steps`, `if`, `env`, `container`, `services`; a worktree per job; any other workflow engine or provider-specific wrapper.

## 2. Decisions

**Owner decisions** (not reopened here):

| Id | Decision |
| --- | --- |
| D1 | Pipeline is a separate plugin in this monorepo, the sole owner of execution, with its own runtime. |
| D2 | "Pipeline has no revisions, it exists as a single revision written in a file." One saved editable YAML per workflow in plugin project data, outside project Git. No numbered workflow revisions, no historical YAML copies, no visible schema version. Concurrent saves use a digest compare-and-swap with an atomic file replace. One transient draft serves the approved UI. Each run copies its effective input, settings and graph into its snapshot. AI proposal staleness uses a content token. A failed validation leaves the saved file intact. |
| D3 | A workflow runs from its saved configuration and inputs. Pipeline is installed and tested independently. |
| D4 | One Git worktree per run, one writer at a time. Independent read-only checks may run concurrently on one captured evidence identity, behind a quiescence barrier and with identity invalidation. Review and human approvals stay bound to that identity. |
| D5 | GitHub Actions vocabulary: `jobs`, `needs`, `uses`, `with`, typed `outputs`, bounded rework. A static matrix and a matrix from a typed JSON list output are both first-release scope: all-success join, bounded parallelism, deterministic child identity across resume, invalidation and re-expansion on rework. |
| D6 | Each job has an explicitly configured primary and at most one fallback. On confirmed provider unavailability the old attempt is stopped and drained and the configured fallback is used. If both are unavailable the job waits in a persisted needs-human state that names the failed providers. No blind substitution or loop; no fallback for a failed check, a failed review or a normal task error. Retry budgets are separate from failover. |
| D7 | UI choice Q2.1: Planning has Diagram, Task list and YAML views; Execution shows the same graph for a chosen run with attempts, evidence and changes in details and Open chat into the native Paseo chat; mobile is list first, details full screen. AI changes arrive as previewed proposals that the user applies. |
| D8 | A task's definition of done is called "Acceptance criteria" in the product UI. Criteria stay visible per task in Planning, and their evidence and status in Execution. Accepting one task is distinct from the final workflow approval. |
| D9 | First-stage agreement covers the built-in DSL and the three Planning views. YAML uses `jobs`, the UI calls them tasks, and `run-tasks` runs Pipeline task inputs. `acceptance: human` marks when a person must accept an agent job or a task item. `uses: approval` remains final workflow approval. Templates have a separate design and approval. |
| D10 | Pipeline targets the Paseo 0.17 API. Development and host capability checks use the exact 0.17.0-beta.1 release. |

**Draft proposals** (this design's, for owner confirmation; none is an owner approval):

- P1 (4.5), the interpretation of D3: an optional, manually supplied structured task list entered in Pipeline's own Start form and expanded by the `run-tasks` built-in. One generic workflow runs with or without it.
- P2 (6.3): concurrent checks run in a plain scratch copy of the captured content; every other check runs in exclusive mode.
- P3 (throughout): execution limits, defaults, state names, storage layout and the agent protocol beyond the first-stage agreement.

**Assumptions:** U1 one workflow per project in this release. U2 a project may have several live runs, each with its own worktree. U4 a workflow has at most one `run-tasks` job. U5 human authority is a Pipeline UI action: an agent can never start a run, save a workflow, apply a proposal, accept, approve, retry, choose a provider or grant a return.

## 3. Evidence

| Source | Used for |
| --- | --- |
| `pipelines/mockups/pipeline.html` (SHA-256 `023e7dc7…f69ea719`) | Sections Planning and Execution, Diagram/List toggle (194), compact List below 700 px, statuses (50, 70), Stop / Accept / Open chat (112), Edit / Ask AI / Delete (114), human-gate marker (118–120), rework arrow (197), workflow card (200), step editor with fallback model and reasoning (216–236). |
| `pipelines/mockups/execution.html`, `pipelines/docs/reports/browser-smoke.md` | Stage list, transcript, changes, stop and resume, layouts at 320, 393 and 1280 px. |
| GitHub Actions workflow syntax (fetched 2026-11-19) | Key names `jobs.<id>.needs`, `.uses`, `.with`, `.outputs`, `.strategy.matrix`, `.strategy.max-parallel`. Vocabulary only. |
| Existing implementation examples for host API calls. Section 9 covers verification on the target version. | Plugin data directory `<PASEO_HOME or ~/.paseo>/plugin-data/<plugin id>` (`plan/server/mcp-state.ts:12-13`); agent creation with `labels`, `idempotencyKey`, `env` (`plan/server/discussion.ts:252-259`); MCP injection in `before("agent.create")` (`plan/server/injection.ts:80-121`); loopback endpoint (`plan/server/mcp-endpoint.ts`); profiles, worktree workspace and agent creation (`plan/server/coordinator.ts:19`, `:39-49`); process groups (`plan/server/process-port.ts`); lifecycle events (`plan/server/pause.ts:979-983`); `navigation.openAgent` (`plan/client/panel.tsx:686`); pure diagram layout drawn with React Native views (`plan/client/map-layout.ts`). |
| [Paseo 0.17.0-beta.1 release](https://github.com/getpaseo/paseo/releases/tag/v0.17.0-beta.1) and [plugin hooks](https://github.com/getpaseo/paseo/blob/v0.17.0-beta.1/public-docs/plugins/hooks.md) | Pinned SDK and typed lifecycle hooks. The screen state-provider fix enables native host state hooks in plugin screens. Section 9 keeps live host capability checks separate from the documented API. |

## 4. Workflow DSL

### 4.1 Shape

One YAML document per project. Top-level keys: `name`, `inputs`, `defaults`, `jobs`. Unknown keys, duplicate keys and non-map documents are errors with a line and column. The YAML has no version key.

```yaml
name: Feature delivery
inputs: { goal: { type: string }, tasks: { type: tasks, required: false } }
defaults:
  max-parallel: 3
  agent: { profile: implementer, fallback: { model: provider-b/model-b, reasoning: medium }, retries: 2 }
jobs:
  discover:
    uses: agent
    acceptance: human
    with: { prompt: "List the modules affected by: ${{ inputs.goal }}" }
    outputs: { modules: { type: list, items: string } }
    done: [{ criterion: Every affected module is listed. }]
  implement:
    needs: [discover]
    uses: run-tasks
    with: { prompt: "${{ inputs.goal }}", tasks: "${{ inputs.tasks }}", context: "${{ needs.discover.outputs.modules }}", reviewer: { profile: reviewer } }
  lint: { needs: [implement], uses: checks, with: { run: [npm run lint] } }
  module-tests:
    needs: [discover, implement]
    uses: checks
    strategy: { matrix: { module: "${{ needs.discover.outputs.modules }}" }, max-parallel: 2 }
    with: { isolated: true, run: [npm ci, [npm, test, --, "${{ matrix.module }}"]] }
  review: { needs: [lint, module-tests], uses: review, with: { agent: { profile: reviewer } }, rework: { to: implement, max: 2 } }
  accept: { needs: [review], uses: approval }
```

### 4.2 Job keys

| Key | Meaning |
| --- | --- |
| job id | `^[a-z][a-z0-9_-]{0,47}$`. `.`, `[` and `#` are reserved for expanded ids. |
| `name`, `description`, `kind` | Display text. `kind` is a label (`research`, `design`, `coding`, `testing`, `review`, `acceptance`) defaulted from `uses`. |
| `needs` | A job id or a list. The job starts only after every listed job has succeeded. A failed, stopped or superseded result never satisfies `needs`. |
| `uses`, `with` | A built-in and its parameters. Unknown values of `uses` and unknown parameters are errors. |
| `outputs` | Declared typed outputs, `agent` jobs only. |
| `done` | The job's acceptance criteria, `agent` jobs only: items `{ run: <command> }` (4.4) or `{ criterion: <text> }`. Command items run in both modes. In `auto` a reviewer agent verifies each text criterion. In `human` a person inspects the result and marks each text criterion before Accept. Text criteria on other job types give `criterion_unverified`. |
| `acceptance` | On an `agent` job, `auto` (default) or `human`. With `human`, the job waits for the person after the agent result and automated checks are ready. |
| `rework` | On `review` and `approval` jobs only: `{ to: <job id>, max: <0..5> }`, default `max` 2. |
| `strategy` | `{ matrix, max-parallel }` on `agent` and `checks` jobs (4.7). |

`defaults.max-parallel` (1..8, default 3) caps active attempts in a run. A job inherits omitted settings from `defaults.agent`. An explicit `profile` or `model` replaces the inherited selection as a unit, and an explicit `fallback` replaces the whole inherited fallback block.

### 4.3 Built-ins and execution settings

| `uses` | `with` | Succeeds when |
| --- | --- | --- |
| `agent` | `prompt` (required), `agent` | The agent submits valid outputs, every `run` item passes and each text criterion is verified. Human mode also requires Accept. |
| `run-tasks` | `tasks`, `prompt`, `context`, `agent`, `reviewer`, `criteria` (`reviewer` default, or `human`) | Every task job has succeeded (4.5). |
| `checks` | `run` (non-empty list of commands, each a shell string or an argv list, 4.4), `isolated` (default `false`) | Every command exits 0 on an unchanged evidence identity (6.3). |
| `review` | `agent`, `prompt` | The reviewer submits `approved`. |
| `approval` | `prompt` | A human approves in the Pipeline UI. This is the final workflow approval, recorded separately from task acceptance. |

Execution settings (`agent` and `reviewer` blocks): `profile` (a Paseo agent profile) or `model` (`<provider>/<model>`) with `reasoning` (`low`, `medium`, `high`); `fallback: { model, reasoning }`, optional, never inferred; `retries` (0..10, default 2). Primary and fallback are resolved at Start, shown in the Start dialog and locked in the snapshot. An unknown profile or model, or a provider the host reports as unable to take MCP servers, refuses Start. The Paseo 0.17 provider catalog exposes no MCP capability before an agent exists, so Start and the workflow chat cannot check it on that host; a job on a provider without MCP support cannot complete and fails with `no_result` after its reminder (6.4), and a workflow chat on it cannot read or propose workflow changes.

An `agent` job with automatic acceptance and text criteria binds a separate reviewer session after the worker and command checks finish. The reviewer uses the job's resolved agent settings with a separate role grant and provider target.

### 4.4 Inputs, typed outputs and references

- Inputs: `<name>: { type, required, default, description }` with `type` `string`, `number`, `boolean` or `tasks`, `required` default `true`, at most one `tasks` input. Values come only from the Start form, are validated by the server and are copied into the snapshot.
- Outputs: `<name>: { type, items }` with `type` `string`, `number`, `boolean`, `list` (`items`: `string`, `number`, `boolean`, `object`) or `object`. The agent returns them as JSON through `pipeline_job_complete`. The server requires every declared output, no undeclared output, exact types, at most 256 KiB in total and 256 list items. Invalid outputs go back to the agent as errors; the third invalid submission fails the attempt with `outputs_invalid`.
- References: `${{ inputs.<name> }}`, `${{ needs.<job>.outputs.<name> }}` and `${{ matrix.<key> }}`, in `with` values and the matrix source only. A referenced job must be in the job's own `needs` and declare the output. A value that is exactly one reference keeps its type; inside a longer string it must be a scalar. Any other expression is an error. Only the outputs of a job's current successful attempt resolve.
- Commands (`checks` `run` entries and `done` `run` items) are never built by splicing a value into shell text. An entry is either a shell string, run as `/bin/sh -c <string>` and wholly literal: a `${{ … }}` anywhere in it, also inside quotes, is rejected with `command_shell_ref`. Or it is an argv list of scalar strings, executed directly without a shell: the first element, the executable, is literal (`command_exec_ref`), an empty list or a non-scalar element is `command_argv_invalid`, and a later element may contain references that resolve to scalars. Each element is passed as exactly one argument whatever characters it holds. A resolved element over 4 KiB or with a NUL byte fails the job with `ref_value_invalid`. `done` commands take no reference in either form.

### 4.5 Task input and `run-tasks` (P1)

The `tasks` input is Pipeline's own schema, typed into the Start form as a YAML or JSON list and validated by the server with positioned diagnostics. At most 64 tasks and 256 KiB.

- Task fields: `id` (`^[a-z][a-z0-9_-]{0,31}$`, unique); `title` (required) and `description`; `needs` (other task ids; no unknown id, self reference, duplicate or cycle); `done`, the task's acceptance criteria in the item grammar of 4.2 (`run` items are automated checks with literal commands, `criterion` items are judged by the reviewer or a human); `acceptance`, `auto` (default) or `human` (the task ends with a human Accept).
- Expansion at Start: one task job `<job>.<taskId>` per task, shown as a group. Edges are exactly the tasks' `needs`; nothing is invented or flattened. Each task job also waits for the `run-tasks` job's own `needs`; jobs that need the `run-tasks` job wait for every task job.
- With no task supplied the job expands to one task job `<job>.main` built from `with.prompt`, so the same workflow runs without a task list. With neither tasks nor `prompt`, Start is refused with `tasks_empty`.
- A task job runs its worker, then its `run` items, then its criteria (a reviewer agent from `with.reviewer`, required when a task has a criterion and `criteria` is `reviewer`; or a human with `criteria: human`), then the human Accept when `acceptance: human`. A failed check or an unmet criterion fails the attempt and the next attempt receives the findings.
- One task attempt can have two agents, a `worker` and a `reviewer`, each with its own creation key, binding, settings and grant (6.1, 7). The reviewer is created only when the cycle reaches `reviewing`.

### 4.6 Templates

Reusable YAML templates have a separate design and approval. A template example must show typed input and output contracts and how a call appears in Diagram, Task list and YAML before template support is added.

### 4.7 Matrix

- `strategy.matrix` has exactly one key. Its value is a fixed list of scalars (static) or exactly one reference to a `list` output with scalar `items` of a job in `needs` (dynamic). Items must be unique; 1 to 64 items. Violations fail the job with `matrix_empty`, `matrix_too_large` or `matrix_invalid`.
- A static matrix expands at Start. A dynamic matrix expands when its source job succeeds, as one journal event `matrix.expanded { jobId, sourceAttemptId, values }`. Instance ids are `<job>[<index>]` in list order; each attempt records its value. Replaying the journal therefore yields the same instances, attempt ids and agent creation keys after a restart, and an expansion interrupted before its event is repeated from the same pinned outputs.
- `strategy.max-parallel` (1..8, default 1) caps active instances, inside the run's cap and the worktree rules of 6.3: `agent` instances are writers and run one at a time; only isolated `checks` instances overlap.
- Join: jobs that need the matrix job start only when every instance has succeeded. An instance that fails after its retries fails the matrix job; instances not yet started stay waiting. A matrix job declares no outputs.
- A rework or an invalidation that supersedes the source attempt supersedes every instance and the source's outputs stop resolving. The instances are expanded again from the new attempt's list; an index beyond the new list is removed from the live graph and stays in history.

### 4.8 Validation

Save and Start run the full validation; every rule has a stable code and a position: `yaml_syntax`, `unknown_key`, `duplicate_key`, `job_id_invalid`, `needs_unknown`, `needs_cycle`, `needs_self`, `uses_unknown`, `with_unknown`, `with_type`, `input_type_invalid`, `output_type_invalid`, `ref_not_in_needs`, `ref_unknown_output`, `ref_unknown_input`, `ref_type`, `expression_unsupported`, `run_tasks_multiple`, `rework_target_not_ancestor`, `rework_on_wrong_job`, `criterion_unverified`, `acceptance_invalid`, `matrix_keys`, `matrix_ref_not_list`, `matrix_uses_unsupported`, `matrix_outputs_unsupported`, `command_shell_ref`, `command_exec_ref`, `command_argv_invalid`. Start-form values add `input_missing`, `input_type`, `tasks_schema`, `tasks_duplicate_id`, `tasks_unknown_need`, `tasks_cycle`, `tasks_empty`, `tasks_reviewer_missing`. A diagnostic includes the source range when the parser can locate it precisely. The range uses zero-based UTF-16 offsets with an exclusive end. Nothing ambiguous is repaired silently.

## 5. Storage and editing

```
<PASEO_HOME or ~/.paseo>/plugin-data/flightpath-pipeline/
  projects/<projectId>/workflow.yaml         the saved workflow: the only authored copy
  projects/<projectId>/workflow.draft.yaml   the single transient draft, absent when there is none
  projects/<projectId>/proposals/<id>.json   AI proposals
  runs/<projectId>/<runId>/snapshot.json     write-once
  runs/<projectId>/<runId>/journal.jsonl     append-only events
  runs/<projectId>/<runId>/copies/           scratch copies of isolated checks (6.3)
  endpoint.json                              MCP endpoint port and secret
```

Directories `0700`, files `0600`. The Pipeline server subprocess is the only writer. One lock per project covers `workflow.yaml`, the draft and the proposals: draft edits, Save, Discard, proposal Apply and the dropping of a redundant draft on read all run under it. The client never touches files; all YAML parsing, validation and editing happen on the server.

- Digest: the SHA-256 of a file's exact bytes, or `absent`. It is a content token, never a sequence number, and no copy of an earlier text is kept.
- Every mutation carries the digest the caller last read: a draft edit, Discard and Apply the editable digest (the draft's, else the saved workflow's), Save both the saved and the draft digest. Under the lock the server re-reads the files and refuses with `workflow_conflict` (returning the current digest) on a mismatch. Otherwise it writes a temp file in the same directory, syncs it, renames it over the target and syncs the directory. A crash leaves either the old or the new text whole.
- Save publishes the draft in one critical section: it checks both digests, requires zero diagnostics, replaces `workflow.yaml` and then removes the draft. An edit that arrives meanwhile waits; it then applies if its editable digest still matches (the saved text equals the draft it was based on) and is otherwise refused with `workflow_conflict`, the client keeping the unsent text. A failed validation or conflict leaves `workflow.yaml` byte-identical. A draft equal to the saved text (a crash between the two steps) is dropped on read. Discard removes the draft.
- A proposal records `baseToken`, the digest of the editable text (the draft, else the saved workflow) its author read. Apply writes the draft and is allowed only while `baseToken` equals the current editable digest and the proposal validates; otherwise the proposal is `stale`.
- At most 16 proposals are kept per project. A new one first removes the oldest applied, discarded or stale proposals; pending proposals are never removed, and while all 16 are pending a new proposal is refused with `proposal_limit` until one is applied or discarded. The draft and the saved workflow are never affected.
- Journal: one writer per run, one line per record, consecutive `seq`. Before the first append after opening, under the run's writer lock, a torn last record (no final newline, or a last line that does not parse) is truncated back to the last complete record and synced. A record that does not parse or a `seq` gap before the last record is never repaired: the run is `journal_corrupt`, is not scheduled and accepts no append.

## 6. Run model

### 6.1 Start and snapshot

Start is a UI action carrying `{ inputs, workflowDigest, startKey }`. It is refused unless the saved workflow validates, `workflowDigest` equals its current digest (`preview_stale`), the inputs validate and every execution setting, fallbacks included, resolves. A draft is never run. Starts of one project are serialised under one lock: the server first looks among the project's snapshots on disk for the same `startKey` and returns that run, so a racing duplicate and a repeat after a restart both return the original run. The server writes `snapshot.json` once, no-clobber: `runId`, `projectId`, `startKey`, `createdAt`, `startedBy` (`human`), `workflow { yaml, sha256 }`, `inputs` (validated values, tasks included), `graph` (expanded jobs, `needs` edges, groups, rework transitions, matrix declarations), `settings` (primary and fallback per job and role) and `snapshotHash`. A run uses its snapshot for the workflow and inputs throughout execution.

Only then does the server touch the host. Run state is always `fold(snapshot, journal)`. Every host creation is journalled as an intent before the call and as a binding after it:

- Workspace: `workspace.intent { branchName }`, then `workspace.bound { workspaceId, directory, baseCommit }`. The branch is `flightpath/run-<runId>`, so one run always names the same branch and worktree.
- Agent: `agent.intent { attemptId, role, creationKey, settings }`, then `attempt.agent_bound { attemptId, role, agentId }`. `attemptId` is `<jobId>#<n>`, local to its run, and the creation key is `<runId>:<attemptId>:<role>`, so identical jobs in simultaneous runs never share a key. The key is the host's idempotency key and is written to the agent's labels with the run id.

An intent without its binding is resolved only by 6.8. A new key is never minted for the same workspace or the same attempt and role.

### 6.2 States and scheduling

- Run: `running`, `paused`, `finished`, `cancelled`. Pause reasons: `human`, `recovery` and `binding_unknown` (6.8), `quiesce_unconfirmed` (6.6). A paused run starts nothing.
- Job: `waiting`, `running`, `checking`, `reviewing`, `awaiting_human`, `needs_human`, `succeeded`, `failed`, `stopped`, `cancelled`. UI labels: Waiting; In progress (`running`, `checking`, `reviewing`); Needs review (`awaiting_human`: acceptance criteria, acceptance or approval wait for a human); Needs attention (`needs_human`: providers exhausted, 6.5; the one label the mock does not have); Done, or Accepted after a human acceptance (`succeeded`); Failed; Stopped; Cancelled.
- A failed, stopped or `needs_human` job does not pause the run; independent branches continue. A run with no active job that is not finished is shown as needing attention, with the jobs that block it.
- An agent job or task item with `acceptance: human` enters `awaiting_human` when its result and required checks are ready. For a standalone agent job, Accept requires the person to mark every text criterion as met. Accept completes that job on the current evidence identity and releases its dependents.
- Ready jobs start in graph order (topological, then declaration order; tasks in list order; matrix instances by index) under `max-parallel` and the worktree rules below. The run finishes when every job has succeeded and every verification-only result is on the current identity (6.3).

### 6.3 Worktree, evidence identity and checks (P2)

A run has one Paseo workspace and one Git worktree, the canonical worktree. Its identity is `I = { headCommit, indexTree, contentTree }`, where `contentTree` is the Git tree of all tracked and untracked non-ignored files, computed with a temporary index. It is read only at quiescence: no agent turn or check process of the run is active, each confirmed ended.

- Writer slot. Anything that runs in the canonical worktree holds the run's single writer slot: a worker turn, a reviewer turn, and a check in exclusive mode. An `agent` or task attempt keeps the slot from its worker's start until its own checks and review end or it parks at `awaiting_human`. One holder per run; waiting for a human holds nothing. A ready verifier is served before a new writer.
- Verification cycle. An attempt's checks, review and human acceptance are bound to the identity captured when the cycle opens (`cycle.opened { attemptId, cycleId, identity }`). A reviewer turn is bracketed by identity readings before and after it. Accept and Approve succeed only if the identity read at that moment, inside the run's serialisation, still equals it; otherwise the call is refused with `evidence_stale`.
- Gated launch. A check never starts as its command. The server spawns a fixed shim in a new process group, blocked on a private pipe whose write end only the server holds; the command is the shim's argument list, never its program text. The server durably appends `check.launched { attemptId, cycleId, index, pid, pgid, startedAt }` (`startedAt` is the process start time reported by the OS) and only then writes the release; the shim then executes the command and the timeout begins. If the append fails the server closes the pipe, and if the server dies the pipe closes with it: on end-of-file without a release the shim exits without executing anything. No command runs unrecorded, and every recorded process is reconciled by Stop and recovery (6.6, 6.8).
- Exclusive check (default): the command runs in the canonical worktree, in its own process group, with a timeout and bounded output. It passes only with exit 0 and the identity equal to `I` before and after the command.
- Isolated check (`isolated: true`): no check is trusted to be read-only. The server materialises the exact `contentTree` as a plain scratch directory under the run's `copies/` directory, outside the canonical worktree, keeping file modes and symbolic links. It is not a Git worktree: nothing is registered with Git, and no ref, index or worktree file changes. The command runs there, so its writes land in the copy, which is removed when the job ends, is cancelled or is recovered. The copy has no `.git` and no ignored files: the job's own commands prepare what they need, and a check that needs Git metadata uses exclusive mode. Isolated checks of one captured identity overlap each other up to the caps and never overlap a slot holder.
- Trust boundary: check commands, like the agents, run as the Paseo host's OS user, with that user's files, credentials and network. Isolated mode and escape detection protect the integrity of evidence, not the host. A workflow's commands are trusted as much as code the user runs by hand; running them under a separate OS identity is outside this design.
- Escape detection: a command can still write through an absolute path. When an isolated group drains, the canonical identity is read again; if it differs, the group's results are `late`, the cycle is invalidated and the job reruns in exclusive mode for the rest of the run. A copy that cannot be created also falls back to exclusive mode. Evidence records `mode: isolated | exclusive`.
- Current evidence. The exact current identity is required in two places only: inside an attempt's open cycle (its checks, criteria, review and Accept), and for the result of a verification-only job (`checks`, `review`, `approval`) that a downstream verification-only job, Approve or the run's finish relies on. When needed, such a stale result is superseded with `evidence_stale` and that job reruns with cause `stale`, outside the retry and rework budgets. A reopened cycle or a refresh repeats verification phases only and never starts a worker turn.
- Pinned results. The succeeded result of a writer (an `agent` job, a task job, an `agent` matrix instance), with its outputs, criteria evidence and acceptance, is history pinned to its own cycle identity. A later writer changing the worktree neither reopens nor relaunches it; only a rework supersedes it. Verifiers do not change the identity, so a refresh converges, and a human approval always covers checks and a review of the exact content approved.
- Any mismatch invalidates the cycle (`cycle.invalidated`); its evidence stays in history as `late` and proves nothing. Drift while a verifier holds the slot or an isolated group runs is unexplained: three such cycles in a row fail the attempt with `worktree_unstable`. Drift while waiting for a human is expected and not counted.

Evidence: `{ id, attemptId, cycleId, kind, item, result, mode, exitCode, outputTail, identity, at }` with `kind` `check`, `criterion`, `review`, `acceptance` (one task or job) or `approval` (the `approval` job), and `result` `pass`, `fail` or `late`. Each acceptance criterion has a status derived from its latest evidence: `pending`, `met`, `not_met` or `stale`.

### 6.4 Attempts and retries

Every start of a job is an attempt `{ attemptId, n, cause, startedAt, endedAt, agents, target, outcome, reason, outputs, matrixValue }` with `cause` `first`, `retry`, `rework`, `manual`, `failover` or `stale`, `outcome` `succeeded`, `failed`, `stopped`, `superseded`, `lost` or `provider_failed`, `target` `primary` or `fallback`, and `agents` one binding per role `{ role, creationKey, agentId, settings, boundAt }`.

- A turn that ends without a completion gets one reminder; a second such turn fails the attempt with `no_result`. A cancelled turn stops the attempt.
- Task failures (`no_result`, `outputs_invalid`, a failed check, an unmet criterion, `worktree_unstable`, an unclassified turn failure, `lost`) retry automatically on the same provider until `retries` is used up; then the job is `failed`. A human Retry starts a `manual` attempt and is not counted.
- Only the server decides completion. Results of superseded, failed, stopped, lost or provider-failed attempts never satisfy `needs`.

### 6.5 Provider failover

- A provider failure is an agent creation or a turn that the host reports failed with an error the server's classification table recognises as provider unavailability: authentication, exhausted quota or rate limit, model or provider unavailable. It is confirmed once the attempt's turn is confirmed ended through the barrier of 6.6. Everything else is a task failure (6.4) and never causes failover.
- A confirmed provider failure ends the attempt as `provider_failed` and uses no retry. If the role has a fallback that has not failed for this job, the server records `job.provider_switched { jobId, role, to: "fallback" }` and starts one attempt with cause `failover`. The switch is sticky for that job and role for the rest of the run, and happens at most once automatically.
- With no fallback, or when the fallback attempt also ends in a confirmed provider failure, the job becomes `needs_human` with reason `providers_unavailable` and a journalled list `{ target, provider, model, class, message, at }`. Nothing follows automatically. The user chooses Retry on primary, Retry on fallback or Stop; each retry starts exactly one `manual` attempt on that target, and a new provider failure returns the job to `needs_human`.
- The next attempt works in the same worktree and is told that an earlier attempt was interrupted and may have left partial changes.

### 6.6 Human actions and the quiescence barrier

UI RPCs only: Start, Stop job, Stop run, Resume run, Cancel run, Retry job (optionally naming a provider target), Retry stop, Accept (one task or job, with the active verification cycle ID and the marked text criterion indices for a standalone agent job with human criteria), Approve (the `approval` job), Request changes, Grant return. Stop job keeps the chat and the applied changes. Request changes on a job awaiting human acceptance starts a `manual` attempt with the note; on an `approval` job it follows 6.7 when the job has `rework`, otherwise the job fails with the note.

Stop job, Stop run, Cancel run, a rework and a failover all end work that may still use the worktree. None releases it before the old turns and processes are confirmed ended:

1. `quiesce.started { attempts, cause }` is journalled first. From this event the named attempts are stopping and their tool calls are refused as `stale_attempt`.
2. The server interrupts every agent turn of those attempts and terminates the process group of their checks, isolated copies included.
3. `quiesce.confirmed` is recorded only when every turn is confirmed ended (an `agent.turn.after` event, or a `refresh()` that shows the agent not running, closed or archived) and every check process is confirmed exited.
4. Until then nothing that would replace the stopping work starts: no retry, failover or rework attempt, no descendant job, and a cancelled run is not yet `cancelled`.
5. A failed or unconfirmed interruption records `quiesce.unconfirmed` and pauses the run with `quiesce_unconfirmed`. Retry stop repeats step 2; archiving the agent in Paseo also confirms it. No path marks an attempt stopped without confirmation.

### 6.7 Rework return

`rework: { to, max }` on a `review` or `approval` job; `to` must be an ancestor through `needs`. The return is a transition of its own: it adds no `needs` edge, the graph stays acyclic, and the diagram draws the mock's dashed amber arrow. On `changes_requested` with fewer than `max` returns used by this job in this run, one `rework.started` event is recorded:

1. The affected set is the target and every job downstream of it, the reviewing job included. From the event their current attempts are `superseded`: kept in history, no longer satisfying `needs`, their tool calls stale, their outputs no longer resolving (matrix instances as in 4.7).
2. Attempts of the set that are still active are stopped through the barrier. Only after `quiesce.confirmed` does the target start an attempt with cause `rework` and the findings; the rest of the set waits for its `needs`. Jobs outside the set keep their results.
3. When the target is the `run-tasks` job, the outcome must name task ids. A missing or unknown id is rejected back to the reviewer. The affected set is then those tasks, the tasks that need them and every job downstream of the `run-tasks` job.
4. With `max` used, another `changes_requested` fails the job with `rework_exhausted`; a human Grant return allows exactly one more. Two reviews resolve in journal order, and an outcome from a superseded attempt is refused as `stale_attempt`.

### 6.8 Recovery

On server start every live run is rebuilt from its snapshot and journal, then reconciled before anything is scheduled:

- An attempt whose agent is still running stays. One whose agent is observed idle, closed or archived with no recorded completion becomes `lost`. An agent whose status cannot be read is not treated as gone, because a live writer cannot be ruled out: the run pauses with `binding_unknown`, nothing is replaced, and Resume repeats the reconciliation. A review acknowledged by `pipeline_review_submit` is journaled as `review.held` and survives a restart; it is submitted with the identity read once the reviewer's turn has ended, through `agent.turn.after` or because recovery observes the reviewer idle. An interrupted check batch is discarded: every process recorded by `check.launched` without recorded evidence is matched by pid and start time and is confirmed gone or terminated through the barrier (unconfirmed pauses the run with `quiesce_unconfirmed`), and its scratch copy is removed. A shim that was never recorded has exited by itself without running a command.
- An open `quiesce.started` is resumed first: the confirmations are collected again.
- Workspace intent without a binding: the server looks for the run's branch among the project's workspaces. Exactly one match is bound; no match repeats the creation with the same branch; several matches, a failed lookup or a failed repeat pause the run with `binding_unknown`.
- Agent intent without a binding: the server repeats the creation with the same key and lists the run workspace's agents carrying that attempt's and role's labels. Exactly one is bound; more than one are all stopped through the barrier and the run pauses with `binding_unknown`. If the host does not return the same agent for a repeated key (section 9), the creation is never repeated and lookup by labels is the only path.
- A run with any reconciled attempt is `paused` with `recovery`; nothing is relaunched until a human resumes. A run paused with `binding_unknown` only repeats the reconciliation on Resume, or can be cancelled; its worktree is never reused.

## 7. Agent protocol

Pipeline hosts its own authority-checked loopback MCP endpoint. An `agent.open.before` hook registered through `server.addHook` uses the reservation ID in agent metadata to look up the Pipeline record and verify the agent and role before supplying its MCP server. Interactive opens also get role instructions through `appendSystemPrompt` where the provider supports it. Per-attempt context remains available through `pipeline_job_context`. A signed grant is bound to one attempt and role, or to one project for the workflow chat. Instructions and metadata grant no authority.

| Tool | Caller | Effect |
| --- | --- | --- |
| `pipeline_job_context` | Worker or reviewer of the attempt | The prompt, resolved `with`, the task with its acceptance criteria and ids, declared outputs, attempt number, findings and any interrupted-attempt notice, for the caller's role. |
| `pipeline_job_complete` | Worker only | Submits `{ outputs, summary }`; returns `accepted` or validation errors. Checks then run on the server. |
| `pipeline_review_submit` | Reviewer only | Submits `{ outcome, findings, criteria }`: `outcome` `approved` or `changes_requested`, `findings` `[{ title, detail, tasks }]`, `criteria` `[{ index, met, note }]` for an agent job's or a task's text criteria. When text criteria are assigned to a reviewer, the submission includes exactly one result per criterion. An unmet criterion fails the attempt. |
| `pipeline_workflow_get` | Workflow chat agent | The editable YAML, its `token` and diagnostics. |
| `pipeline_workflow_propose` | Workflow chat agent | Stores a proposal `{ baseToken, yaml, summary }`. Never changes the draft or the saved workflow. |

Every job tool call is checked against the attempt's current state and the grant's role. A superseded, stopping, ended or foreign attempt gets `stale_attempt`; the wrong role gets `role_forbidden`. A worker can never review its own work and a reviewer can never complete the job.

## 8. User interface

One workspace panel, "Pipeline", with the mock's two sections.

- Planning has Diagram, Task list and YAML over one draft, with Task list as the default on a compact layout. The diagram shows jobs in dependency layers, `needs` arrows, the rework arrow, human gates and task and matrix groups. A pure layout module computes the positions and React Native views render them. The diagram has Fit to screen, Zoom in and Zoom out controls. YAML is an editable multiline text view with syntax colors and server diagnostics. A diagnostic marks its source range or line, and selecting it reveals that location. Diagram and Task list show the valid draft before Save and the saved workflow with an explicit status when the draft is invalid.
- Selecting a task in Diagram or Task list opens its editor, full screen on mobile. It shows the job's `done` items under "Acceptance criteria" and the relevant name, description, model or profile, reasoning, fallback, acceptance and retry settings. Applying an edit updates the shared YAML draft through a server operation that preserves comments. Save publishes the workflow.
- The model picker uses the selected Paseo host's provider catalog. The reasoning menu offers the selected model's supported DSL levels and the inherited or default setting.
- Draft and AI: every edit changes the draft; Save is enabled only with zero errors; Discard drops the draft; a conflict shows the other change and asks to reload. "Ask AI" and "Request change" go to the workflow chat. A proposal appears as a preview (line diff, added, removed and changed jobs, diagnostics) with Apply and Discard; a stale or invalid proposal cannot be applied.
- Start dialog: a form generated from `inputs` (the task list as a text field with diagnostics and a preview of each task's acceptance criteria), the expanded job count, the primary and fallback per job, and a note when unsaved draft changes exist. Start is enabled only with no blocker.
- Execution: a run picker, then the same Diagram or Task list drawn from the run's snapshot and journal, never from the current workflow; settings read-only. Job details (full screen on mobile): Attempts (cause, outcome, reason, provider target, worker and reviewer agents); Acceptance criteria (each with status and evidence by verification cycle, check mode, exit code and output tail; invalidated cycles marked); Task (the task text from the snapshot); Changes (the worktree diff against the base commit and the files changed per attempt).
- Actions: Stop, Retry, Accept, Request changes, Grant return, and Open chat for each bound agent through `navigation.openAgent`. When a standalone agent job waits for human acceptance, show one checkbox per text criterion and enable Accept when every criterion is marked. The server only accepts those marks on the current verification cycle. The `approval` job is titled "Final approval" and its action is Approve. A `needs_human` job is labelled "Needs attention", apart from acceptance criteria review: it lists both provider failures (provider, model, error class, time) and offers Retry on primary, Retry on fallback and Stop. Run actions: Stop run, Resume, Cancel, and Retry stop while a stop is unconfirmed; a paused run shows its reason. Updates arrive through a subscription, with polling of `run.get` when the host has none.

## 9. Host capabilities to prove

| Capability | Proof | Fallback |
| --- | --- | --- |
| Plugin data directory convention | Sandbox: the resolved directory is writable and owner-only | Host setting `dataDir` |
| `agents.create` with `labels`, `idempotencyKey`, `env`; profile or explicit model | Typecheck against 0.17.0-beta.1; sandbox: a repeated key returns the same agent | The creation is never repeated; lookup by labels only (6.8) |
| Listing workspaces by branch and a workspace's agents by labels | Typecheck; sandbox: both are found after a simulated crash | Pause with `binding_unknown`; cancel only |
| Terminating a process group and observing its exit | Unit test with a real child that ignores the first signal | Pause with `quiesce_unconfirmed` |
| Gated launch: a shim blocked on a private inherited pipe | Unit tests with real children: a kill between spawn and record, after record and after release (6.3) | None: the check is not started |
| Materialising a Git tree as a plain directory with modes and symbolic links, without a Git worktree | Unit test on a temporary repository: the copy equals the tree, an executable bit and a symbolic link survive, `git worktree list` is unchanged, and the canonical identity is unchanged by creation, a relative write and removal | Exclusive mode |
| `agent.open.before` for scoped MCP and instructions. `agent.turn.after` for outcomes. | Typecheck against the 0.17.0-beta.1 hooks. The sandbox checks create and resume with the same reservation, provider delivery, and trial turn outcomes. | Attempt reconciled by `refresh()` on a timer. Role context remains available through MCP on providers that support MCP alone. |
| A turn failure that identifies provider unavailability | Typecheck of the outcome fields; sandbox with a scripted provider failure | No automatic failover: every failure is a task failure, and the user may choose Retry on fallback |
| Interrupting a turn and seeing it end | Sandbox; unit tests with a delayed and a failed interruption | Pause with `quiesce_unconfirmed` |
| `navigation.openAgent`; subscriptions | Client tests of both paths | Button hidden; polling |

## 10. Acceptance journey

One journey on synthetic data, first in process against a scripted host, then in an isolated sandbox host as a separate, owner-authorised delivery state. The sandbox runs Pipeline as its sole Flightpath plugin.

1. In Planning the user pastes the workflow of 4.1 without `lint` and with `review.needs: [module-tests]`: zero errors, and Diagram and Task list agree. The AI proposes adding `lint` and widening `review.needs`; the preview shows one added and one changed job; the user applies and saves. A save with an outdated digest is refused with `workflow_conflict`, an invalid save leaves `workflow.yaml` byte-identical, and the project directory holds one workflow file and no earlier copy.
2. Run A starts from the Start form with `goal` only. A human accepts `discover` before `implement` starts. `implement` expands to `implement.main` and the run finishes.
3. Run B starts with three tasks: `t1`; `t2` and `t3` need `t1`; `t2` has a `run` item and a criterion; `t3` has `acceptance: human`. `discover` returns `modules` as a list of three after one rejected invalid submission. A human accepts `discover`.
4. `t2` and `t3` start only after `t1`, and no two writers are ever active together. The Acceptance criteria of `t2` show a passed check and a criterion met by the reviewer; `t3` waits for a human Accept, which does not approve the workflow.
5. The server restarts after an agent was created and before its binding was journalled. The run returns paused for recovery, the same agent is bound, no second agent exists, the attempt is `lost`, and after Resume the job retries.
6. The primary of `t2` reports provider unavailability: the turn is confirmed ended, one failover attempt runs on the fallback, and the retry count is unchanged. For `review` both providers fail: the job is `needs_human`, shown as "Needs attention" with both failures, nothing starts until the user chooses Retry on primary, and a failed check elsewhere never switches provider.
7. `lint` runs in exclusive mode. `module-tests` expands to three instances that run two at a time in plain scratch copies of one identity, with a module name containing a quote and a space passed as one argument; an instance that writes into the canonical worktree through an absolute path invalidates the group and reruns in exclusive mode.
8. `review` submits `changes_requested` naming `t2`. `t2`, `lint`, the `module-tests` instances and `review` are superseded and rerun; the new `t2` attempt starts only after the old work is confirmed stopped; `t1` and `t3` keep their results. After a restart the instances keep their ids.
9. `review` approves, the user approves `accept`, and the run finishes. A file changed before Approve gives `evidence_stale` and the checks and review rerun first; no task is relaunched.
10. Execution shows the run graph, both `review` attempts, criteria evidence, the task text and the changes, with separate Open chat for worker and reviewer. On a 393 px layout the run opens as a list and details open full screen. A repeated Start with the same `startKey` returns the same run, also when two Starts race and after a restart.

## 11. Trade-offs and rejected alternatives

- Numbered workflow revisions or a pointer file: the owner chose a single file; digest compare-and-swap with an atomic rename gives conflict detection and crash safety without history.
- Trusting a check declared read-only: an arbitrary command proves nothing by assertion. Isolation is by construction and escape is detected; otherwise the check is exclusive. An OS sandbox or a read-only canonical worktree is not portable, and tools write caches and build output next to the sources.
- A worktree per job or per agent: merge and evidence design beyond this release; agents therefore write one at a time.
- Automatic provider substitution or retry loops: the user configures at most one fallback, and anything beyond one failover is a human decision.
- Interpolating values into shell command text: quoting is fragile and context-dependent, so shell strings are literal and values travel only as argv elements.
- Client-side YAML parsing: client npm dependencies cannot be assumed.

Accepted costs: only isolated checks run concurrently, so agent matrix instances run in sequence; an isolated copy needs its own dependency setup; a write after a verifier's success makes it run again; results are visible only in Pipeline.
