# Paseo Flightpath Pipeline

Pipeline owns workflow authoring and execution.

## Local checks

Run `npm ci`, `npm run typecheck`, `npm run lint` and `npm test` from `pipelines/`.
Lint covers type-aware TypeScript rules and HTML parse errors, duplicate IDs and inline JavaScript in the index and active mockups. The linter skips the source snapshots in `reference/`.
The lockfile uses the public npm registry.

## Working here

- Read the [design](docs/specs/2026-11-19-flightpath-pipeline-design.md) before changing the DSL or Planning UI. Check its decision table for the current approval scope. Use the [implementation plan](docs/plans/2026-11-19-flightpath-pipeline-implementation.md) for the proposed runtime work.
- Target the Paseo 0.17 API. Use the pinned 0.17.0-beta.1 release for host capability checks and an isolated test host for live verification.
- Open [index.html](index.html) to reach the HTML mockups. Keep source snapshots in `reference/` intact.
- Treat the saved YAML and its draft as the source for Diagram, Task list and YAML. Keep advanced workflow constructs editable in YAML.
- Use English for new repository documentation and product text. Keep user-authored content in its original language.
