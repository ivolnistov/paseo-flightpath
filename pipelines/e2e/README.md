# Guarded acceptance sandbox

`journey.mjs` is an owner-authorized live harness, not a local test command. It drives Pipeline through the pinned Paseo 0.17.0-beta.1 daemon API and a pre-provisioned scripted provider. **It has not been executed in this delivery.**

## Authorization and target boundary

The only eligible target is a fresh, reviewed sandbox bootstrap directory created for this run. Before invoking the harness, the owner must approve that exact directory and authorize its target nonce. The harness refuses to run unless all of these hold:

- The sandbox is an existing mode-0700 directory owned by the invoking user, inside the system temporary directory, with a basename beginning `flightpath-pipeline-e2e-`.
- `ownership.json` has kind `flightpath-pipeline-e2e`, a 64-hex nonce, and the resolved absolute `home`, `project`, and `control` paths for this sandbox.
- The command supplies that exact nonce as `--authorize <nonce>`. Authorization for one sandbox does not authorize another.
- `home/`, `project/`, and `fixture/` resolve inside the sandbox. The home and project are real, owned mode-0700 directories; the project is a synthetic Git repository.
- `cli.mjs` is the reviewed sandbox's Paseo CLI entrypoint and reports exactly `0.17.0-beta.1` from `--version`.
- The reviewed bootstrap has already provisioned the scripted provider and fixture-control implementation described below. No personal provider account or credential is used.
- The sandbox is unused: it has no `harness-claim.json` and no output of an earlier run (`acceptance-results.json`, `fixture/events.jsonl`, `fixture/release/`, `tmp/`). Before its first change to the sandbox, the harness creates `harness-claim.json` exclusively, so the sandbox cannot be used again; earlier outputs and failure evidence are never removed.

Every CLI call passes `--home <sandbox>/home`. The harness removes inherited daemon selectors and credentials from the child environment, configures only loopback `127.0.0.1:6797`, disables relay, and selects the SDK connection from that same address. It never targets the user's default daemon, an existing preview, `~/.paseo`, a saved host, or an explicit `--host` endpoint. A port conflict or target mismatch fails the run; there is no fallback to another daemon.

After authorization, the harness may start, restart during the crash proofs, and stop **only that sandbox daemon**. It installs Pipeline from the current `pipelines/` working tree and checks the plugin roster with `listPlugins`. Pipeline must be the sole Flightpath plugin; Plan and Roadmap are refused. The bootstrap's synthetic provider fixture is not a Flightpath plugin. The harness never pushes, publishes, submits, merges, or modifies a remote.

## Pre-provisioned scripted fixture contract

The bootstrap supplies `fixture/control.json`, `fixture/check.mjs`, the scripted provider, and the CLI. The harness does not implement or install a production provider. The fixture must be reviewed and must implement this contract before the harness is run:

- The provider ID is `pipeline-scripted`, with models `primary`, `fallback`, and `reviewer`. It opens sessions without credentials, receives Pipeline's scoped MCP URL, calls `pipeline_job_context`, `pipeline_job_complete`, and `pipeline_review_submit` as appropriate, and emits turn outcomes.
- For the independent host probe, the provider records `session.open` with `agentId`, `creationKey` `pipeline-e2e-host-probe`, and the received `env` object. The harness requires the exact synthetic marker `PIPELINE_E2E_MARKER=synthetic-env-marker`. Repeated-key identity/label lookup and env delivery are separate probes; each records its own fallback when failed or unreachable, without changing production flags.
- The harness atomically replaces `control.json`. Its `runIds` map identifies Run A and Run B. The scenario declares the three module values, the invalid first Run B discovery output, the `implement.t1#1` creation crash, provider failures for `implement.t2#1`, `review#1`, and `review#2`, the failed check for `implement.t2#2`, changes requested for `review#3`, the first matrix holds, and the held rework turn.
- The provider writes workers' synthetic files under the current run worktree, including the attempt id in the content. Reviewer criteria are met. Run B review attempt 3 names `t2`; later reviews approve. Provider failures use a classified unavailable outcome.
- The first `implement.t1#1` open records `crash.ready` and holds before readiness. Its event includes `runId`, `attemptId`, `agentId`, and `creationKey`. A restart makes that agent idle so recovery records it as lost; the retry opens normally.
- `check.mjs` is invoked directly as argv, never through shell interpolation. Modes are `lint`, `matrix`, and `task`. Matrix receives the module value and canonical directory. It records `check.start` and `check.end` in `fixture/events.jsonl` with `runId`, `attemptId`, `module`, `cwd`, and `hasGit`, correlating scratch and canonical directories through the fixture control. The first `escape` attempt writes once to the canonical directory; its rerun does not.
- `fixture/release/core` and `fixture/release/quoted-module` release the first two held matrix processes. `fixture/release/rework` allows the old reviewer turn to end. The fixture holds those turns until the corresponding file exists.
- Events also include `tool.error` with code `outputs_invalid` for the rejected Run B discovery submission. All event and control files stay inside the sandbox and contain synthetic data only.

The harness uses `DaemonClient.invokePluginRpc(pluginId, method, input)` for Pipeline RPCs. The pinned public `@getpaseo/client` facade does not expose plugin RPC invocation, so this pinned transport method is an explicit SDK-surface limitation of the harness, not a production fallback.

## Running after explicit authorization

First run the ordinary local gates:

```sh
npm --prefix pipelines test -- server/journey.test.ts
npm --prefix pipelines test
npm --prefix pipelines run typecheck
npm --prefix pipelines run lint
node --check pipelines/e2e/journey.mjs
```

After the owner authorizes the exact provisioned sandbox, run:

```sh
node pipelines/e2e/journey.mjs \
  --sandbox /absolute/system-temp/flightpath-pipeline-e2e-unique \
  --authorize <nonce-from-that-sandbox-ownership.json>
```

The harness writes `acceptance-results.json` in that sandbox, with separate journey and section-9 capability results. A failed proof records the applicable fallback rather than claiming success. Process-group and gated-launch rows retain their real-child local evidence; navigation and live UI behavior remain separate. Copy the actual result into `docs/reports/acceptance-journey.md`; do not infer installation or UI verification from a local test pass.

## UI verification is separate

The harness does not drive a browser or native app. Planning views, the Start dialog, Execution details, Open chat navigation, and the 393 px layout require a separately authorized UI pass on the installed sandbox. Record that pass separately; it is not implied by this script.
