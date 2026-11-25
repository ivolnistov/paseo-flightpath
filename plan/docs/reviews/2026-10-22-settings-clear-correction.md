# Settings clear correction review

Exact commit 1485d091b9108c1bbb7008e5bca3fc2fb636221a, parent bb2c1c6,
two files +49/-1. Written corrective scope is docs/plans/2026-10-22-settings-clear-correction.md.

Actual-host failure: clearing the optional project key sent an explicit undefined property.
Installed desktop/web useSettings validates schema output with z.json() before sending the RPC;
the optional schema preserves explicit undefined, while JSON rejects it. Restoring SYN succeeds.
The production correction omits that property from the draft after update. It changes neither
schema/API/dependencies nor expected-revision, external-conflict or close-pair behavior.

Independent read-only reviewer <redacted-id>, live default
routine-review-kimi profile (Gemini 4 Argon Medium), PASS on exact commit and validation evidence.
No defect established. No commands/tests/edits/network/memory writes by reviewer. Final report
received by callback and consumed with supported activity tool.

Verified source SHA256:
- client/tracker-settings.tsx: ad31be751a19cb637877971adc9a61964ed1a30da0f688b0813e30a1c3a00dfc
- client/tracker-settings.test.ts: 60ce78b1394aff6e2df03799b5e6ab3ef82fc1228f85afe800a3d97299a591be

Regression uses the actual component handlers, real plugin schema and installed host's JSON
boundary expression. Baseline RED: 1 failed/5 passed. Corrected focused run: 6/6, exit0.
Both TS configs exit0; independent full suite: 38 files/388 tests, exit0, 14.96s. RN audit clean,
no new imports/dependencies, current file hashes match evidence. Logs/reports under main
.sdd/2026-10-20-decision-roadmap/test-host-settings-clear-*.

Limits: handler harness has no real React reconciler or host UI. Project Zod4.6.7 versus
host-bundled4.4.3: both semantics were source-checked, but the test executes project version.
Actual clear/save/readback on the installed host remains required after exact gate and reload.
Self-save cosmetic changed-elsewhere notice stays a recorded separate follow-up.

Ordinary exact KensAI completed at14:32:08Z: session01a163fc-7ea9-7651-a0e8-cb8ca1855c9e,
exit0, score0, submitted true, full coverage2files +49/-1. Exact commit/base match above.
Review cannot inspect external host source in its snapshot; the separate installed-host evidence
supports that boundary. No new cumulative full-stage review.

Findings dispositions in progress:
- c0035: optional commit narrative improvement; existing production comment and test doc block
  explain the JSON-only host boundary. No false claim established. Record rather than amend
  a prior commit solely for narrative.
- c0036: clearing then restoring the same key changes property insertion order. The current
  JSON.stringify dirty comparison can then enable Save for semantically unchanged settings.
  Retained TEST is reproducing through the real component handlers before a minimal production
  correction. General self-save notice redesign remains outside scope.
- c0037: a direct own-property absence assertion is optional additional precision; current
  z.json boundary already rejects explicit undefined. TEST may add it in the required regression
  follow-up, without a separate test-only churn round.

Runtime reload and push are held pending c0036 verification/correction and successor exact gate.

c0036 confirmed by separate TEST: initial saved SYN settings -> clear only key -> retype SYN;
the real-handler regression fails because Save is enabled. Focused RED1failed/6passed. New
test-only delta +10, hash0195f41c28c5a67357ec8a99086bc3ebcfd2a5ac5d664c050004da35e6495243.
c0037 direct enumerable own-key absence assertion added to the existing boundary regression;
it passes at1485d09, while the JSON boundary already rejects explicit undefined. Retained PROD
is assigned the existing canonicalJson comparison only; all save/revision/conflict guards stay.

Follow-up committed44d638354564b03dda80d865f69dd088e765c2ae, parent1485d09, 2files+13/-1.
Production SHA256d9fd2112908019a3ffe4788feaa26f17bd92a91ef8915ce75239ff237f23a26f;
test SHA2560195f41c28c5a67357ec8a99086bc3ebcfd2a5ac5d664c050004da35e6495243.
Focused7/7, bothTS0; separate TEST full389/38938files0. Actual activefnm0.12 compiler0,
bundle ca991bfdb41140adac718a626f8a0c021b5bcfbf7fa8b0c9993a1c1f396b25a7;
RN0.81.5Hermes0, hbc81b3ee6efceb7502f7b38815b280f51fab2ced910396f834ae74dfd83951f3a8.
No runtime/UI proof yet. Exact committed hashes match validated working-tree hashes.

All20 predecessor threads resolved/read back; c0036 replyc0040 cites fix/RED/GREEN and limits,
c0035 replyc0038 records optional narrative; c0037 replyc0039 records direct absence assertion.
Ordinary successor exact44d6383 launched14:37:19Z with --continue=<redacted-id>;
owned exec84544, finite deadline15:07:20Z. Independent bounded exact review also callback enabled.

Independent reviewer07d817da completed PASS on exact44d6383 and matching source hashes/evidence.
No defect or regression established. Final report consumed through supported activity tool.
Minor report symbol/citation slips corrected against actual source here: exported component is
TrackerSettingsScreen, changedElsewhere is settings.revision !== draft.revision, and update omits
the key when next.projectKey === undefined. These unchanged lines and the actual +3/-1 production
diff support the verdict; do not propagate the report's alternative names or invented code quotes.
The separate TEST validates the actual functions and compiled output; real UI remains pending.

Final exact KensAI: session01a1640b-8576-731c-882e-de010b4da6c0 COMPLETE14:46:59Z,
exit0, score+1, submittedtrue, partialfalse, exact44d6383/base1485d09, 2files+13/-1.
No defect or unresolved concern. Host observer completed and final report consumed.

Final dispositions (actual replies/readback, all23 inherited/current threads resolved):
- c0041 -> c0044: granted optional nested close-map reorder handler test for future maintenance.
  canonicalJson already recursively sorts every object; no current top-level-only bug exists.
- c0042 -> c0045: declined optional removal of redundant ||changedElsewhere. Preserve existing
  guards in this bounded fix; redundancy is harmless and no defect established.
- c0043 -> c0046: declined optional removal of secondary no-save assertion. Disabled assertion
  is the meaningful RED/GREEN oracle; the secondary assertion documents no save while editing.
  It is not presented as a disabled-button interaction test.
Stop this correctness loop at+1. Main-only review documents define the cited local comment IDs;
eventual documentation reconciliation remains required. Runtime reload/UI are the next states.

Actual installed fnm CLI/server0.12 compiler check completed on exact1485d09, clean feature:
compilePlugin exit0, client bundle139553bytes, SHA256
3adbfd35604b9273eb8af36765da8897a4a3a61c2f9215dda691af1d7e6c00e7. React Native0.81.5
hermesc parse/compile exit0. Report/log .sdd/2026-10-20-decision-roadmap/test-host-settings-clear-host-hermes*.
This is parse/compile evidence, not native runtime/UI proof.

Provenance correction: earlier Homebrew web-UI source was0.11.2, misidentified as0.12.0.
The same JSON save boundary was now verified in active fnm0.12.0 web bundle; original
Paseo.app0.12.0 source evidence was correct. Diagnosis and regression remain supported.
