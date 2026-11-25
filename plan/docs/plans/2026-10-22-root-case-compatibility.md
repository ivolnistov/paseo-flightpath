# Root case-alias compatibility correction (store-root guard)

Status: Fable bounded corrective plan, final after one Astra advisory (2026-10-22). Planning
document only: no source, test, config, registry or store change was made while writing it.
Coordinator retains the authority assessment and dispatch; this document grants no execution,
review, installation or publication authority by itself.

Baseline for comparison: the planner's first report to the coordinator (2026-10-22, before the
Astra advisory). Changes against that baseline are listed in §9.

## 1. Problem and evidence

Verified (read-only, 2026-10-22, probe report `.sdd/test-host-root-case-probe-report.md`, re-checked
by the planner with `fs.promises.realpath`, `realpathSync`, `realpathSync.native` and an `lstat`
chain on the actual path):

- Registered root (daemon `projectRootPath`, read through the supported CLI mapping because
  direct SDK auth failed): `/Users/example/work/paseo-decision-roadmap`.
- `fs.promises.realpath` of that path: `/Users/example/WORK/paseo-decision-roadmap`. The JS
  `fs.realpathSync` keeps the registered spelling; the native variant canonicalises case. The
  plugin port `nodeStoreFs.realpath` (`server/fs-port.ts:50`) uses the promise variant.
- Every component from the leaf up to `/` is a directory and not a symbolic link.
- `assertSafeRoot` (`server/store-root.ts:78`) compares the normalised realpath to the registered
  string and throws `unsafe_root` "project root must not be a symlink". `resolveProject` therefore
  fails for `prj_example` before any store access; every project-scoped RPC, grant and
  MCP tool path goes through it (`sessions.ts`, `plans.ts`, `tracker/sync.ts`, `mcp-grants.ts`,
  `injection.ts`).

Evidence correction (14:22Z): the Homebrew source inspected for project-registration APIs was
0.11.2, not active 0.12.0. The claim that 0.12.0 has no supported same-id root update is withdrawn
as unverified. Live registry rows and the real plugin root-guard reproduction are unaffected.
The correction restores the accepted nonsymlink-directory contract independently of any registry
editing API. Remove/re-add is not treated as permitted. No store existed during the initial probe.

## 2. Restored contract and authority

Accepted contract (Stage 0 card, plan Task 0.0, SPEC §4/§7): one registered canonical project
root per project, resolved by the server from the daemon registry; real directories are accepted;
a registered root that is a symlink, or lies behind a symlinked ancestor, is refused rather than
followed; `.decisions` must be a real directory; clients never supply a root.

Assessment: the correction below restores that contract on case-insensitive filesystems and
changes nothing on case-sensitive ones. Protection is not weakened: the only changed path adds
checks for paths that were previously rejected outright. No product behaviour, API, registry,
configuration, dependency, daemon setting or folder name changes. Existing implementation
authority applies; no settled product question is reopened and no new owner decision is
manufactured (grilling record in §6: frontier empty, every question settled by the accepted
contract or by evidence). The one accepted text that changes is the Stage 0 guard clause, amended
in `docs/plans/tasks/2026-10-20-stage0.md` to describe the restored algorithm (wording in §3).

## 3. Correction design (alternative A, refined)

File: `server/store-root.ts`, function `assertSafeRoot` only. Algorithm:

1. Unchanged: `root` must be absolute, normalised, without trailing separator (`unsafe_root`).
2. Unchanged: `real = normalize(await fs.realpath(root))`; failure is `unsafe_root`
   "project root does not exist".
3. Changed: when `real !== root`, inspect every component of the registered path from the leaf up
   to, but excluding, `/` (`for (cur = root; cur !== dirname(cur); cur = dirname(cur))`) with
   `fs.lstat`. A component that is missing (`null`), a symbolic link, or not a directory is
   `unsafe_root` "project root path must not contain a symlink", details
   `{ root, real, component }`. The `unsafe` helper gains an optional `details` parameter so the
   extra fields can be attached; the existing two-argument calls keep `{ root }`.
4. Changed: `storeRoot = real` (the normalised realpath result; equal to `root` on the unchanged
   fast path). The existing leaf `lstat` check and the `.decisions` check run on `storeRoot`.
5. Unchanged: `.decisions`, if present, must be a real directory; result
   `{ storeRoot, decisionsDir: join(storeRoot, ".decisions") }`.

Stage 0 clause wording (replaces the `realpath(projectRootPath) === projectRootPath` bullet):

> The registered root must resolve to a directory. If its normalised realpath differs from the
> registered path, every registered-path component is inspected with `lstat` and must be a real
> directory, not a symbolic link (`unsafe_root`; a registered root that is, or lies behind, a
> symlink is refused rather than followed). `storeRoot` is the normalised realpath result.

Claims kept narrow: the walk proves that each inspected component is a directory and is not
reported as a symlink at inspection time. It does not classify why the spellings differ, and
`storeRoot` is not claimed to be a globally unique directory identity across mounts. Race posture
(time of check versus time of use) is unchanged from Stage 0.

Invariants:
- Roots that resolve today return byte-identical results, with no additional syscalls.
- Newly accepted inputs are exactly those whose realpath differs while no registered-path
  component is a symlink or non-directory. On a case-sensitive filesystem such an input cannot
  exist as a case variant (`ENOENT` stays "does not exist"), and a symlink that merely differs in
  case is rejected by the walk.
- No case folding or Unicode normalisation enters the comparison logic.
- `fs-port.ts`, `StoreFs`, `projectForCwd`, `openStore`, the `.decisions` guard and
  `plan-export.ts` are untouched. Direct `openStore` callers remain responsible for their input.
- Consumers of `storeRoot` (`store.ts:93` lock key, `plan-export.ts:51` per-plan lock key,
  `mcp-grants.ts:27` grant comparison, `mcp-state.ts` persisted grants, `injection.ts`) all
  receive the realpath result from `resolveProject` on both sides, so they stay consistent.
  A persisted grant could only mismatch on a host where the registered root never resolved
  before, so no working installation regresses.

## 4. Alternatives considered

- B, case-insensitive string compare: trusts case folding, would pass a `WORK`→`work` symlink on
  a case-sensitive filesystem. Rejected.
- C, same walk but `storeRoot` keeps the registered spelling: safe, but lock keys and grant roots
  would carry a spelling that differs from the on-disk name, and two registrations of one directory
  with different case would get different lock keys. Rejected in favour of the realpath result.
- D, make the port's `realpath` non-canonicalising: changes `projectForCwd` for all callers and
  would break cwd matches whose shell spelling differs from registration. Rejected.
- E, re-register the project or rename the folder: daemon state mutation, identity loss or a
  duplicate registry row, owner-level and not a plugin fix. Out of scope by brief.

## 5. Dispositions of the Astra advisory

| # | Advice | Disposition |
|---|---|---|
| 1 | Narrow the proof and documentation claim; use "normalised realpath result"; suggested Stage 0 wording | Accepted. §3 uses Astra's wording with one addition (keeps the "refused rather than followed" phrase of the original clause). The plan no longer claims that only case or Unicode rewriting can occur. |
| 2 | Lock regression: same project id, two registry snapshots with alternate spellings, concurrent mutations | Accepted, T-RC.4. Serialisation is observed through revision progression, not only shared reads. |
| 3 | Grant boundary: grant issued through the alias stays valid when the registry later reports the realpath spelling; keep the negative test | Accepted, T-RC.5. Deterministic through a stub `StoreFs`, so it does not depend on the host filesystem. |
| Doubt 1 | No static counterexample for non-symlink remapping; avoid the universal claim | Accepted; §3 states the bounded guarantee. |
| Doubt 2 | Unicode: no separate treatment, add a normalisation-alias fixture, no normalisation in the compare | Accepted, T-RC.2 (stub fixture NFC/NFD). |
| Doubt 3 | Keep the mismatch-only walk; describe it as additional checks for newly accepted paths | Accepted; wording changed in §2/§3. |
| Doubt 4 | `plan-export.ts` lock key also benefits; direct `openStore` callers unchanged | Accepted and recorded in §3 invariants. |
| Doubt 5 | `{ root, real, component }` detail needs a helper change | Accepted; the `unsafe` helper change is part of P-RC.1. |
| Extra tests | alias with missing, real, symlinked and regular-file `.decisions`; fast path call set unchanged; ancestor symlink to a case-variant directory; fixtures under `await realpath(tmp)`; distinguish `null` from thrown `lstat` errors | Accepted, T-RC.2, T-RC.3, T-RC.6. Thrown non-`ENOENT` `lstat` errors keep propagating as-is (no new policy); T-RC.6 asserts that. |

## 6. Grilling record

Applied as a self-interview against the accepted requirements, as instructed; the owner was not
asked. Every question is settled by the accepted contract or by evidence, so the frontier is
empty and no owner question remains.

❓ **Q1 — What counts as the project root the store must use?**

Verified: SPEC §4 and plan Task 0.0 say the server resolves one registered canonical root and
clients never supply it. The guard today equates "canonical" with the registered string.

1. The registered string verbatim
2. The normalised realpath result of the registered path, when proven symlink-free (recommended)
3. A case-folded form of the registered string
4. Whatever `cwd` the caller presents

➡️ Choice 2, settled by the accepted contract and alternative analysis (§4): it keeps a single
lock key per directory, keeps grant comparison consistent and introduces no folding. Not asked.

❓ **Q2 — Which inputs may newly pass the guard?**

Verified: today any realpath difference is rejected. The accepted contract rejects symlinks, not
spelling differences.

1. Any path whose realpath differs
2. Paths whose realpath differs only by letter case
3. Paths whose realpath differs while an `lstat` walk finds no symlink or non-directory component (recommended)
4. Paths matching after Unicode normalisation and case folding

➡️ Choice 3, settled by the accepted symlink contract: it is the only option that neither trusts
folding nor follows a symlink. Not asked.

❓ **Q3 — Walk always or only on mismatch?**

1. Only when realpath differs from the registered path (recommended)
2. Always, for defence in depth
3. Never, rely on realpath string compare
4. Only for the leaf

➡️ Choice 1, settled by evidence and Astra doubt 3: no extra syscalls or new error surfaces on
roots that already resolve. Not asked.

❓ **Q4 — Where does the registry fix belong?**

At planning time the inspected source was believed to be 0.12.0; it was later identified as
Homebrew 0.11.2. Availability of a same-id update in active 0.12.0 is unverified. A registry
workaround remains outside this plugin correction; restoring the accepted guard is still needed.

1. Plugin-side correction in `assertSafeRoot` (recommended)
2. Re-register the project under the native spelling
3. Rename the folder
4. Change the port's realpath semantics

➡️ Choice 1, settled by the brief's prohibitions and §4. Not asked.

## 7. Task cards (one worktree, sequential turns, disjoint files)

Base: feature `1dbd424` (server code identical to `d245abc`). Commit boundary: one small commit
containing P-RC and T-RC, subject `fix(roadmap): accept case-alias roots proven symlink-free`,
then one ordinary exact-revision KensAI gate on that commit. It does not alter the revision under
the running docs gate.

### P-RC (production, Opus): `server/store-root.ts` only
- P-RC.1 `unsafe(message, root, details?)`; mismatch branch with the component walk; `storeRoot`
  set to the realpath result; leaf and `.decisions` checks on `storeRoot`. Import `dirname`.
- P-RC.2 No change to the fast path, to `projectForCwd`, to the port, or to any other file.
- Acceptance: typecheck on both tsconfigs green; full `vitest run` green; T-RC tests green.

### T-RC (tests, separate Opus): `server/store-root-alias.test.ts` (new); may add the
ancestor-symlink case to `server/store-root-cwd.test.ts`. No changes to `test-support/*`;
an inline stub `StoreFs` lives in the new file.
- T-RC.1 Stub-fs alias accepted: realpath returns a different spelling, every component reports a
  real directory; `storeRoot` equals the realpath result and `decisionsDir` lies under it.
- T-RC.2 Stub-fs rejections: an ancestor reports symlink; the leaf reports symlink; a component is
  missing; a component is a file; an ancestor symlink to a case-variant directory; plus an
  NFC/NFD alias accepted under the same rule. Alias with `.decisions` missing or a real directory
  accepted; with a symlink or regular file `.decisions` rejected (`unsafe_root`).
- T-RC.3 Fast path: with `recordingFs`, a root whose realpath equals itself issues the same calls
  and returns the same result as before the change.
- T-RC.4 Lock regression: one project id, two registry snapshots with alternate spellings,
  resolved roots equal; two store instances opened through them; concurrent `transact` calls are
  serialised (final revision equals start plus the number of successful transactions, conflicts
  surface as `revision_conflict`, the manifest is intact).
- T-RC.5 Grant boundary with the MCP harness: grant issued through the alias spelling; the
  registry then reports the realpath spelling; the tool call succeeds. Negative case where the
  root genuinely moves still gives `project_mismatch`.
- T-RC.6 Real filesystem, fixtures under `await realpath(tmp)`: ancestor symlink
  (`base/link -> base/real`, root `base/link/sub`) rejected; leaf symlink rejected; case-only alias
  of the leaf and of an ancestor directory. The test probes whether the temp volume is
  case-insensitive; on an insensitive volume it asserts acceptance with the native spelling, on a
  sensitive one it asserts `unsafe_root`. Both branches assert; nothing is skipped silently.
  A thrown non-`ENOENT` `lstat` error propagates unchanged (not converted to `unsafe_root`).

## 8. Validation, host confirmation and delivery states

1. Validation: typecheck both tsconfigs, full suite, logs under `.sdd/`.
2. Review: ordinary exact-revision KensAI on the correction commit; dispositions recorded.
3. Host confirmation (retained TEST worker, read-only beyond temp): rerun the probe harness
   against the corrected build; expect `resolveProject("prj_example")` to return
   `storeRoot /Users/example/WORK/paseo-decision-roadmap`. No store creation, no registry mutation.
4. Installation and UI acceptance remain separate states and are not claimed by this plan.

## 9. Changes against the first planner report

- Narrowed the filesystem claim and the Stage 0 wording (Astra 1, doubt 1).
- Added the `unsafe` helper detail parameter to the production card (doubt 5).
- Replaced the shared-read lock check with the same-id concurrent-transaction check (Astra 2).
- Added the grant-boundary test (Astra 3) and the extra fixtures (`.decisions` variants, fast-path
  call set, case-variant ancestor symlink, NFC/NFD alias, thrown `lstat` errors).
- Removed the conditional owner decision; §2 records that existing implementation authority
  applies, with the coordinator retaining the authority assessment.

## 10. Non-goals

No daemon, registry, credential or configuration change; no folder rename; no change to
`fs-port.ts`, `projectForCwd`, `openStore` or `.decisions` protections; no case folding; no new
dependencies; no Stage 5 or roadmap requirement changes.
