# Stage 3 card report (2026-10-21)

Cards: `docs/plans/tasks/2026-10-21-stage3.md`. They are documentation only. Based on the
frozen Stage 2 source `1566ffd` (read-only), SPEC §5–§8 and §10, and Stage 3 of
`docs/plans/2026-10-20-decision-roadmap.md`.

## Readiness

All card sections are **READY**. The owner recorded R1 and R2 on 2026-10-21, and the cards now
encode them exactly; the NOT READY gates and the separate ruling turn are removed.

## Owner rulings encoded

- **R1:** a draft may include explicitly skipped (active) questions, recorded in `basedOn` with
  `validity: "skipped"`. Approval is prohibited until they have valid answers: `basisCurrent`
  fails with `"<ref> is skipped; answer it and draft a new revision"`, and `currency` can be
  `current` only when every basis entry is `valid`. The resulting path is answer, then draft a
  new revision, then approve.
- **R2:** the basis and the decision snapshot cover the **active branch** of `plan.sessionIds`.
  Inactive questions are excluded without error. A branch change, or any new active question,
  changes the active set: `basisCurrent` reports "became active" or "is no longer active" and
  the approval is not current. Edits confined to inactive questions do not affect currency.

Neither ruling required any further product choice.

## Original contradictions (now resolved)

- SPEC §6 eligibility allowed skipped questions while currency required `valid`. Resolved by R1.
- SPEC §6 rejected inactive questions in named sessions. Resolved by R2: exclusion, plus
  currency through the active-set snapshot.

## Security claims and their limits

- **Approval channel.** Approval is accepted only through the plugin RPC `plan.approve`, and
  `PlanCommands.approve` additionally refuses non-UI origins. There is no MCP approve tool, and
  tests assert that.
- **What the server cannot prove.** `PluginHandlerContext` 0.12.0 is `{ paseo }` only
  (`server/contracts.d.ts:8-10`), so the server cannot prove a human pressed the button, or which
  client did. `hostClientId` is therefore omitted, and `actor.kind: "human"` means "UI RPC
  channel". A local process able to invoke plugin RPC or write
  `$PASEO_HOME/plugin-data/decision-roadmap/` is outside this threat model. Receipts are not
  signed.
- **Forged-receipt defence (exactly what is claimed).** Authority comes only from a
  schema-valid plugin-data receipt whose path and fields match the project, plan, revision and
  both hashes. Copies in project JSON never count (`unverified`). A receipt filed for another
  `projectId` is ignored. Ids are validated before any path join.

## Design decisions grounded in existing evidence (not new owner choices)

- No schema migration: the Stage 0 `Plan` fields already exist and stores hold `plans: []`.
- Hashes are computed on the server (Stage 0 ruling D1). `contentHash` uses the exact SPEC §6 key
  set.
- The Markdown export is derived. It is written after commit, repaired by `plan.get`, and never
  parsed back.
- Approve uses the `(rev, contentHash)` pair as its optimistic check. The receipt is written
  first and the project copy is cosmetic, retried at most 3 times.
- Task states are per approved revision; `in_progress` rechecks currency (SPEC §6, "execution
  start"); `verified` is UI-only with a note (SPEC §8).
- Plan RPCs and tools are registered separately (`STAGE3_CONTRACTS`, `registerPlanHandlers`,
  `buildTools(commands, buildPlanTools(...))`), so no frozen Stage 1/2 contract or test changes.
- Four new error codes go through the existing `RPC_ERROR_CODES` sync check.

## Remaining unknowns

- The live acceptance of approval on a compact viewport is a coordinator gate. No agent can
  substitute for it.

## Corrections after coordinator source check (2026-10-21)

1. **Receipts are published atomically without clobbering**, through a dedicated
   `server/approval-fs.ts` port: temp file `wx` `0600`, `fsync`, `link` (which gives `EEXIST`
   when a receipt exists), `unlink`, then directory `fsync`, with `0700` directories. The frozen
   `StoreFs` is unchanged; it lacks mode, `chmod` and `link`, and `rename` would replace the
   destination. Tests cover two concurrent writers, restart, partial writes and a missing
   `link` (no rename fallback).
2. **`task.update` and `roadmap_task_update` carry `planRev` and `contentHash`**, and the server
   requires both to match the latest revision, plus `expectedRevision`. The UI pins all three
   from the displayed view and verification modal, using `useRpc` directly rather than the
   cache-reading mutation helper. A regression test covers a stale task action when the new
   revision reuses the task id and the cache is fresh.
3. **The export always renders the latest revision**: `syncExport` takes no revision argument,
   runs under a per-plan mutex, compares the full bytes, and re-reads at most 3 rounds. Tests
   cover body tampering under an intact header and an ordered race where a delayed sync for the
   older draft still yields the rev 2 content.
4. **The approve precondition is `basisCurrent`** (hashes plus an intact basis), independent of
   any receipt. `currency === "current"` is not used, because it would block the first
   approval. The skipped and inactive parts remain R1/R2.
5. **T3 gets one authorised narrow support edit**: an optional `extraTools` option on
   `startTestEndpoint` in `server/test-support/mcp.ts`. Existing callers are unchanged.

R1 and R2 were later resolved by the owner and encoded (see Readiness).
