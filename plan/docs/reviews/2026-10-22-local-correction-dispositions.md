# Local correction review dispositions

Ordinary MiniMax-M3 review `<redacted-id>` completed on exact
`d245abca96e55c24b6934ee1b0dc145300ef915e` against `ea4b394`, 3 files +19/-11, exit 0,
submitted true, full coverage (`partial: false`), neutral score 0. No incorrect behavior or
production-code change found. This is recovered real project coverage, not the separate fixture
review and not the earlier HTTP402 failure. Raw result stays outside repository at
`/tmp/decision-roadmap-test-host-kensai-d245abc-recovery.json`.

| Comment | Disposition | Evidence / action |
| --- | --- | --- |
| c0001 | Declined optional test hardening; recorded | Current regression asserts enabled Save, exact save count, pinned revision/project and preservation of the SYN pair. Whole-map equality would additionally constrain unexpected keys but no such runtime defect was demonstrated. `client/tracker-settings.tsx` only publishes complete pairs or removes explicit blank pairs. Follow-up: consider whole-map oracle when next extending this suite; no extra correctness round or source churn solely for it. |
| c0002 | Fixed | SPEC section 7 still described obsolete client-supplied storeRoot, contradicting the actual ProjectInput/PlanRef schemas and new resolve row. Docs-only `1dbd424e2dee9db46a7cc6209cf7c77cb6b03fd4` updates the section introduction and table input scope to projectId, states server canonical-root resolution, and explicitly says resolve takes projectId, not storeRoot. Production/test blobs unchanged; prior validations remain applicable to code. Exact documentation correction gate pending. |
| c0003 | Granted and recorded optional documentation improvement | Audit-folder discoverability is useful; current OVERVIEW honestly states attempted external audit and false-flag/UI limitations. It makes no incorrect path or guarantee claim. Follow-up when revising usage docs: name `$PASEO_HOME/plugin-data/decision-roadmap/tracker-audit/`, confirmed against `server/tracker/audit.ts:33`. No blocking defect or new round solely for folder naming. |
| c0004 | Granted and recorded optional documentation improvement | Same folder-discoverability advice for SPEC auditRecorded semantics. Current field contract is accurate. Record the same audit folder in a future docs pass; this does not change failure semantics, approval or RPC behavior. |

These are the final bounded correctness dispositions. Original-host c0131-c0142 dispositions
and independent PASS are preserved separately. Every local thread must be replied/resolved with
supported CLI and read back before starting the exact successor; do not forge thread JSON.
No provider/model/tier, credential, billing or configuration changes. Installation/UI acceptance
and Stage 5 remain separate states.

Independent reviewer `<redacted-id>` verified the exact one-file
`d245abc..1dbd424` delta against all RPC ProjectInput/Mutation/PlanRef schemas and
`server/store-root.ts` project resolution. PASS; no misleading statement introduced. Full final
report received with finish notification and read through `get_agent_activity`; no tests,
commands or writes by the reviewer. Optional c0001/c0003/c0004 dispositions supported.

Local successor session `<redacted-id>` runs ordinary MiniMax on exact
`1dbd424`, base `d245abc`; deadline 2026-10-22T13:35Z, attended exec 29875, result/log/exit
`/tmp/decision-roadmap-test-host-kensai-1dbd424.{json,log,exit}`. No duplicate whole-feature gate.

## Final successor result and recorded follow-ups

The successor completed within its budget: exit 0, status complete, submitted true,
score 0, coverage partial false, exact `1dbd424e2dee9db46a7cc6209cf7c77cb6b03fd4`
against `d245abc`, one file +23/-23. No runtime bug established. The retained independent
reviewer verified all eight comments and their pre-existing scope, read back through the
supported activity tool. Coordinator checked the relevant RPC schemas and the parent SPEC.
No new false claim was introduced by the project-scope correction. The declared final round
ends here; no further documentation-only correction round is opened for these old inaccuracies.

| Comment | Final disposition / durable follow-up |
| --- | --- |
| c0009 | Granted, pre-existing SPEC table drift. In the next usage/API documentation pass, replace task.update verification? with required planRev/contentHash and optional note; shared/rpc.ts:266-277 is authoritative. |
| c0010 | Granted, pre-existing universal expectedRevision sentence. Qualify the plan.approve exception in SPEC sections 5/7 in the next documentation pass; its row already names rev/contentHash and plan_revision_mismatch, matching shared/rpc.ts:248-250. |
| c0011 | Granted, pre-existing shorthand. Split link.create flat kind/from/to/note and link.delete linkId in the next API documentation pass; shared/rpc.ts:180-189. |
| c0012 | Granted, pre-existing nesting omission. Document relation: RelationInput with activation/invalidation variants; shared/rpc.ts:57-60,170-179. |
| c0013 | Granted, pre-existing section 4 tree comment outside this delta. Rename documented useStoreRoot to implemented useProjectId when updating the tree; client/hooks.ts:53. |
| c0014 | Granted, pre-existing question.skip note? drift. Remove the unsupported optional note from its summary row; shared/rpc.ts:159-163. |
| c0015 | Declined local review-description style suggestion. Process sentences are invocation metadata, not a tracked file or Git commit message. Future invocations can be shorter; no code/documentation defect demonstrated. |
| c0016 | Declined local review-description opening suggestion. The actual Git commit message already reads `docs: align RPC project scope with implemented contracts`, exactly the requested wording. No amend or extra review solely for invocation style. |

These grants acknowledge documentation inaccuracies rather than treating them as false positives.
They are scoped follow-ups here, not approval to change behavior or omit the next production
correction's exact gate. Installation and Stage 4 UI acceptance remain pending.

All eight replies c0017-c0024 were sent with the supported local `threads reply --resolve`
command. A subsequent `threads list --format json` readback confirmed all 12 local threads
(including the four inherited threads) resolved. No reviewer state was edited directly.
