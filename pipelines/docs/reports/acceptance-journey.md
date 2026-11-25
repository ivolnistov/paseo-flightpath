# Acceptance journey delivery report

Base under test: `fb4d0e9294a8a2241d606564931f6264b8878d3d`, including the strict `WorkflowSchema.strategy` wire correction. Task 7 adds tests, the guarded harness, and documentation only.

## Validated

Validated locally on 2026-11-21 with Vitest 5.0.5 and Node 26. No daemon, plugin installation, real provider, existing preview, personal credential, push, or publication was used.

```text
npm --prefix pipelines test -- server/journey.test.ts
  1 test passed; repeated focused run also passed
npm --prefix pipelines test
  35 test files passed; 502 tests passed
npm --prefix pipelines test -- --sequence.shuffle
  35 test files passed; 502 tests passed; seed 1795285981854
npm --prefix pipelines run typecheck
  passed
npm --prefix pipelines run lint
  passed
node --check pipelines/e2e/journey.mjs
  passed
independent Vite SSR import of pipelines/index.server.ts
  passed; default server contribution is a function
pure sandbox guard import and refusal checks
  passed; wrong/missing nonces and unsafe roots were refused
forbidden Plan/Roadmap reference scan
  no matches
```

The in-process journey composes `index.server.ts` with the real stores, engine, driver, service, RPC handlers, loopback MCP endpoint, process runner, and scratch copies. The fake boundary is the host/provider. State and Git repositories are temporary.

Covered journey steps:

1. A valid section-4.1 draft without `lint`; matching Planning model/graph; a real workflow-chat MCP proposal; one added and one changed job; apply/save; conflicting and invalid saves refused without changing `workflow.yaml`; one saved workflow file.
2. Run A with `goal` only; no `implement.main` attempt before human `discover` acceptance; checks, review, final approval, and a finished run.
3. Run B with `t1`, dependent `t2`/`t3`; rejected then accepted typed `modules`; human `discover` acceptance; the first `t1` agent created without its binding, daemon composition restarted, the same agent rebound as `lost`, no duplicate, and Resume retry.
4. Task dependency order and a non-empty set of subscription-observed active-writer snapshots for each run, with at most one writer in every observation; failed-check retry stays on the fallback; passed `t2` check and reviewer criterion; human `t3` Accept does not approve the workflow.
5. Primary-to-fallback failover for `t2`; both `review` providers fail; Needs attention and both failures are exposed; no new review agent until Retry on primary.
6. Exclusive `lint`; three dynamic isolated matrix instances with cap two; a quote-and-space module value preserved as one argv element; plain copies without `.git`; a canonical absolute-path escape produces late evidence and an exclusive rerun; stale siblings reverify on the new identity.
7. Review changes requested for `t2`; no replacement before the old reviewer turn ends; `t2`, `lint`, every matrix instance, and review have pinned rework attempts; `t1`/`t3` retain results; matrix ids remain stable after restart.
8. Review approval; Approve refused as `evidence_stale` after a write; `lint`, every matrix instance, and review have pinned stale-recovery attempts without relaunching tasks; fresh Approve finishes Run B.
9. Execution graph, the exact five review attempts, rework/stale causes, specific criterion evidence, snapshot task title/description/prompt, changes, and distinct worker/reviewer Open chat bindings.
10. Repeated and racing `startKey` calls return Run B, including after restart. Compact pure view selection is list mode; this is not a rendered 393 px UI proof.

Host-capability evidence remains separated:

- Real-child local suites cover process-group termination, gated launch, and signal/exit behavior.
- Temporary-Git suites and the journey cover identity, plain scratch copies, modes, links, quoted argv, and canonical escape handling.
- Typed SDK checks and the in-process journey cover labels, explicit models, lookup-based recovery, scoped open/turn hooks, provider failure handling, interruption, and subscriptions.
- Sandbox-only repeated-key/env delivery, real host worktree/branch lookup, and provider/hook behavior require the authorized live run. No live capability fallback was activated because no live proof was attempted.
- `navigation.openAgent` has local client coverage only. Live navigation is not claimed.

The guarded harness and its pre-provisioned fixture contract are in `e2e/journey.mjs` and `e2e/README.md`. It includes independent repeated-key/label and synthetic-env probes through the actual pinned SDK. Each probe records its own fallback when failed or unreachable; production defaults and flags are not changed. Neither probe was executed locally.

The pinned public client facade does not expose plugin RPC invocation; the harness explicitly uses the pinned `DaemonClient.invokePluginRpc` transport. This is an SDK-surface limitation recorded for the live reviewer, not a silently substituted API.

## Reviewed

Review `<redacted-id>` of the original Task 7 commit produced four targeted corrections; all were applied in this revision. Independent test re-review `<redacted-id>` approved test spec compliance and quality at `b0975ebaf1cefa76527dcbf7509f604f908e94b3`. The re-review covered the four corrected findings.

## Installed in the sandbox

Not done. No live owner authorization or approved sandbox target was supplied. The harness was syntax-checked and its pure guards were exercised without executing the sandbox. No plugin was installed and no daemon was started, restarted, reloaded, or stopped.

The genuine proof gap therefore includes installation from the working tree, the real plugin roster, owner-only resolved data directory on the host, repeated agent idempotency key and env delivery, host worktree/label lookup after a real daemon crash, real provider MCP delivery and failures, and real turn interruption. The harness records supported results and row-specific fallbacks in `acceptance-results.json` when an authorized run is performed; unreached proofs must remain not done.

## UI verified

Partially done, as one synthetic browser run separate from the scripted sandbox journey above. Pipeline at exact revision `a87ba2e0be24f8af633d19ed353f8be1c3a75275` ran on Paseo 0.17.0-beta.1 in a dedicated local Docker container, reached only from disposable Chromium contexts. No model or provider was used. Evidence and screenshots are kept locally in `.sdd/2026-11-19-flightpath-pipeline-implementation/ui-39983/`.

- A YAML workflow with one 120-second command check and a dependent manual approval was saved and started from the browser.
- Execution showed run `rmwqsbpiu0d9047f74f` live: without refresh the check went from In progress to Done and Final approval from Waiting to Needs review. Approve gave finished and Accepted, and the journal ended with `run.finished`.
- At 393 px, Execution opened in Task list on re-entry; the check's full-width details showed its successful attempt and the exclusive check with exit 0. The long Acceptance criteria tab label wraps mid-word but stays operable.
- Host defect: after a hard browser reload the saved Pipeline tab showed "This plugin panel is unavailable" and the new-tab menu lacked Pipeline, while the daemon and plugin kept running. A fresh authenticated browser context rediscovered Pipeline and the finished run; a hard reload there reproduced the failure. The failure is at the host panel boundary, its root cause was not determined, and it is tracked separately from this repository.

Not covered: the Planning Diagram and Task list editing, Open chat navigation, and the scripted sandbox acceptance journey, which this browser run does not satisfy.
