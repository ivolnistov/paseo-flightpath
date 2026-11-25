# Pipeline mockup extraction

Owner-authorized scope, 2026-11-19: move both the process graph and the execution workspace into the separate `paseo-pipeline` project. The process graph has two sections named **Planning** and **Execution**, replacing the source's Tasks label. Planning configures the process, steps and executors; Execution shows its demo run. Plan authoring remains a separate plugin direction.

## Task 1

Role: implementer (general).

Files: create `mockups/pipeline.html`, `index.html` and `docs/reports/extraction-implementation.md`. The coordinator owns README, source inventory and reference snapshots.

Interfaces: standalone local HTML documents, relative navigation within this project, no source-project runtime dependency. Preserve the existing graph, cards, step editing and execution interactions. Remove Roadmap, Questions and plan-authoring navigation from the extracted graph. Retain the execution workspace preview as copied; it is a second existing design exploration, not a new implementation.

Acceptance: both mocks are accessible from an English landing page; the graph offers Planning and Execution; existing graph/card/configuration/demo actions remain usable; inline scripts parse; no external assets or calls are required; source snapshots and Decision Roadmap source files remain unchanged. Report browser evidence separately from syntax/static checks. No dependency installs, git commits, publication, plugin installation or daemon actions.
