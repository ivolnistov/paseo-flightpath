# Stage 4 UI correction: clearing optional project key

Written corrective scope under the existing approved Stage 4 settings contract, not a new
product design. The optional projectKey must be removable through the real settings screen;
provider none keeps all tracker operations local. No new owner decision or authority inferred.
Base feature bb2c1c6a050f3de0d8016837df18cb67400bdc7c, independently green and exact-gated.

Observed actual-host trigger: saved SnailOrbit/Dry run/SYN/State+Done. Clear both close fields,
clear Project key, select Provider None, then Save. UI reports Invalid input and retains the old
saved values. Restoring a nonblank SYN key makes Save succeed. Current safe saved state is None,
Dry run, SYN, no close pair; exact blank-key restoration remains pending. No private settings
file or undocumented API may be used to work around this.

TEST (retained separate Opus) first verifies the cause against the installed settings/RPC input
contract, then adds a meaningful RED regression in client/tracker-settings.test.ts. Keep existing
SYN incomplete-pair and external-revision conflict tests. If the cause is undefined in a JSON
settings payload, exercise the real JSON schema/contract or a faithful boundary assertion;
do not claim a mock-only green proves host acceptance. Record detailed test breakdown/evidence
under main .sdd/2026-10-20-decision-roadmap/test-host-settings-clear-test-report.md. Production untouched.

PROD (retained separate Opus, after TEST finishes) owns only client/tracker-settings.tsx. Write
its detailed implementation card from this corrective scope before editing. Restore omission
of the optional key at the supported settings save boundary; preserve expected host revision,
external conflict protection and complete-pair retention. No new settings schema, API, dependency,
reset mechanism or configuration mutation. The self-save notice is recorded separately; avoid
expanding this correctness block unless the same fix necessarily needs to manage saved draft state.

One small production+test commit, relevant focused checks, both TS configs and full suite as
justified by client behavior, independent read-only diff verification, ordinary exact KensAI.
Then reload only the plugin and repeat the actual UI clear/save/readback and external conflict
checks where the second client is available. Do not restart daemon. Stage 5 stays behind Stage 4
acceptance. Preserve previous root-correction +1 and no duplicate cumulative review.

Exact1485d09 review c0036 follow-up: separate TEST reproduced key insertion order changing after
clear/retype of the same value, falsely enabling unchanged Save. Restore semantic dirty comparison
using existing client-safe shared canonicalJson. Preserve the optional-key omission and every
revision/conflict guard; general self-save notice redesign stays outside scope. One new small
production/test correction commit, RED-before/GREEN-after, focused/typecheck/full-suite evidence,
independent review and ordinary exact successor using --continue with the completed review.
