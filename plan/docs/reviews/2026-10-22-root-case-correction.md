# Root case-alias correction review

Exact commit `bb2c1c6a050f3de0d8016837df18cb67400bdc7c`, parent
`1dbd424e2dee9db46a7cc6209cf7c77cb6b03fd4`. Two files, +339/-9.
Fable owns the final plan in `docs/plans/2026-10-22-root-case-compatibility.md`, after
one bounded Astra consultation. The correction restores the accepted real-directory contract;
it does not authorize registry, daemon, credential or tracker changes.

Independent reviewer `<redacted-id>`, live default profile
`routine-review-kimi` (Gemini 4 Argon Medium), reviewed the exact diff and validation evidence.
PASS, no defect established. Read-only: no tests, edits, commands, network or memory writes.
Full report received through the finish callback and consumed through the activity tool.

Reviewed file SHA256:
- server/store-root.ts: `3ab3664deb6f503d6cbb974fa2aee609879651144cc27bad7b40ea9ba7979ad5`
- server/store-root-alias.test.ts: `7f9a5cd1cfb61be989fabf1534399fb97d8a9354c194bfdea82489de73d1cde6`

Verified: mismatch-only component walk rejects leaf/ancestor symlinks, missing paths and
non-directories; no case folding or Unicode normalization; normalized realpath returned;
canonical .decisions guard retained; unchanged fast-path calls. Tests exercise shared same-ID
locking, grant survival across registry spelling and rejection of genuine root movement.
Direct createGrantResolver testing replaces the MCP harness deliberately, avoiding forbidden
harness edits and filesystem-dependent coverage. No public API or dependency changes.

Validation evidence in `.sdd/2026-10-20-decision-roadmap/test-host-root-case-*`:
- Baseline RED: 11 failures, 2 passes, 13 tests; failures match the prior mismatch rejection.
- Focused GREEN: 13/13. Independent TEST full run: 38 files, 386 tests, exit 0, 15.34 seconds.
- Both TypeScript configurations: exit 0.
- Read-only host probe: supported CLI project rows and actual resolveProject/nodeStoreFs now
  accept registered `/Users/example/work/paseo-decision-roadmap`, returning
  `/Users/example/WORK/paseo-decision-roadmap`. No .decisions before or after; no registry mutation.

Error details for a resolved-path non-directory use its resolved root. On the unchanged fast
path this is byte-identical; no practical regression established. Existing filesystem race
posture is unchanged. Test and probe evidence does not prove installed UI behavior.

## Ordinary exact gate and dispositions

KensAI `<redacted-id>` completed at 13:51:56Z, exit 0,
score +1, submitted true, partial false, exact bb2c1c6 against 1dbd424, 2 files +339/-9.
No defect or unresolved concern established. Runtime result/log/exit remain outside Git at
`/tmp/decision-roadmap-test-host-kensai-bb2c1c6.{json,log,exit}`. No duplicate cumulative review.

| Comment | Verified disposition |
| --- | --- |
| c0025 | Granted optional test diagnostic specificity. On a case-sensitive volume a missing case variant correctly fails at realpath; that branch does not claim to exercise the mismatch walk. Stub tests and the actual case-insensitive host exercise the walk. Record exact-error assertion for a future test-maintenance pass; no uncovered safety defect demonstrated. |
| c0026 | Declined optional fixture-map pruning in this bounded correction. Some unused parent entries could be removed without changing outcomes; the explicit recordingFs assertion already checks the fast-path call set. Keep this as optional fixture maintenance, no correctness churn. |
| c0027 | Granted optional diagnostic clarity. A single normative message covers missing, symlinked and non-directory components; all fail closed. Endpoint drops details, so distinguishing causes would help users. Record clearer wording and matching oracle for a future diagnostic pass; no acceptance or security defect. |
| c0028 | Main-checkout traceability limitation acknowledged. The cited Fable plan exists in main commit dc5ddb5, intentionally following docs-in-main/code-in-worktree policy; independent review read it. Retain the reference and reconcile main planning docs into the eventual integrated delivery rather than deleting a real requirement source. |
| c0029 | Already addressed in main commit dc5ddb5: Stage 0 guard clause now describes component inspection and normalized realpath root, citing the final plan. Historical stage2/research reports remain historical evidence. Feature-only reviewer snapshot lacked the main docs amendment. Carry current card wording into final documentation reconciliation; no production change or new review round needed. |

The +1 result closes this correction round. Installation, synthetic Stage 4 UI acceptance and
native-device proof remain distinct pending states.

Toolchain evidence correction: the earlier registration-API inspection used Homebrew Paseo
0.11.2, misidentified as 0.12.0. The no-same-id-root-update claim for active 0.12.0 is withdrawn.
Live fnm0.12 registry rows, direct plugin guard reproduction and the exact tested correction
remain valid; the fix does not rely on a registry API being unavailable. See
.sdd/2026-10-20-decision-roadmap/test-host-settings-clear-host-hermes-report.md for verified paths.
