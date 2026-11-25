# Paseo Pipeline

A separate project for designing a Paseo plugin that defines execution pipelines and manages their runs.

## Scope

- Define reusable processes with stages, dependencies, roles, checks and review.
- Execute a configured workflow through Pipeline's own runtime.
- Inspect execution progress, task results and verification evidence.
- Preserve run history through pauses and recovery.

## Status

Pipeline targets Paseo 0.17. The implementation plan pins 0.17.0-beta.1 for development and host capability checks. The workflow DSL, runtime, and Planning/Execution implementation are present. The full in-process acceptance journey is locally validated; sandbox installation and live UI verification are separate and have not been performed.

Check commands and agents run as the Paseo host's OS user with that user's access; isolated checks protect evidence, not the host. Run only workflows whose commands you would run yourself.

The first-stage agreement covers the built-in workflow DSL and the Diagram, Task list and YAML views in Paseo. Reusable YAML templates have a separate design and approval. [Design](docs/specs/2026-11-19-flightpath-pipeline-design.md) · [Implementation plan](docs/plans/2026-11-19-flightpath-pipeline-implementation.md) · [Acceptance report](docs/reports/acceptance-journey.md)

## Acceptance checks

Run the local journey and all ordinary gates:

```sh
npm --prefix pipelines test -- server/journey.test.ts
npm --prefix pipelines test
npm --prefix pipelines run typecheck
npm --prefix pipelines run lint
node --check pipelines/e2e/journey.mjs
```

The journey composes the real server, RPC handlers, MCP endpoint, stores, engine, driver, and checks over a synthetic host, temporary state, and a temporary Git repository. It needs no daemon, provider, credentials, or host worktree.

The guarded [sandbox journey](e2e/README.md) requires explicit owner authorization for a specific pre-provisioned isolated target. It never targets the user's daemon and is not run by the local checks. Review, sandbox installation, and UI verification are recorded separately in the acceptance report.

## Mockups

Open [the preview index](index.html) directly in a browser. No build, dependency installation or server is required.

- [Pipeline](mockups/pipeline.html): **Planning** configures the process graph and executors; **Execution** shows its demo run. The source's Tasks section is now Planning.
- [Execution workspace](mockups/execution.html): the existing stage list, chat, plan and changes exploration. It retains its original Russian text and local-only demo behavior.

These are the original design explorations. The first-stage agreement in the design document governs the current Planning view and DSL.

Validation: inline-script syntax passed; the implementer's DOM simulation passed 55 checks; browser smoke covered the main interactions and 320/393/1280 px layouts. [Browser evidence](docs/reports/browser-smoke.md) and [independent static review](docs/reports/independent-review.md) are saved separately. The review passed with no material findings.

See [the source inventory](docs/source-inventory.md) for provenance and [the extraction scope](docs/extraction-scope.md) for the owner-authorized boundary. Current checks are recorded in [the implementation report](docs/reports/extraction-implementation.md); the copied report under `reference/` describes historical checks only.

## Working conventions

Repository-authored documentation and new product text are English. Existing source snapshots retain their original content for provenance.

Mock behavior is illustrative. Model names, approval displays and run states in a mock are not evidence of live agent execution or owner approval. Local project preparation does not authorize publication, plugin installation or daemon changes.
