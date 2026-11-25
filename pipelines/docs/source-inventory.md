# Source inventory

Prepared on 2026-11-19 from `/Users/example/WORK/paseo-decision-roadmap`.

## Task graph and execution

Source: `.sdd/ui-mockups/paseo-preview-20261105/reference/index.html`.

The preserved original is [reference/roadmap-combined.html](../reference/roadmap-combined.html), SHA-256 `b683dfc80190d6f915b856125e6f56569cdf187d8271a324e3cb1efbb3ff38b9`.

This standalone HTML source combines Roadmap, Questions, Plan, Tasks and Execution. The Tasks and Execution screens share the task graph, cards, task configuration and demo actions. The extracted [pipeline mock](../mockups/pipeline.html) separates those screens from Roadmap and plan authoring and labels its sections **Planning** and **Execution**, following the owner's correction. Planning here configures the process, steps and executors.

## Execution workspace

Sources:

- `.sdd/ui-mockups/execution-workspace.html`: an HTML fragment with inline styles and script.
- `.sdd/ui-mockups/preview/execution.html`: an existing standalone preview.
- `.sdd/ui-mockups/execution-report.md`: historical behavior and validation notes.

This mock explores a stage list, transcript, composer, plan and changes views, stop/resume and a question that requires an answer. Its source text is Russian. The report is historical evidence; its validation results have not been repeated for this project.

Imported files, unchanged:

| Destination | SHA-256 |
| --- | --- |
| `reference/execution-workspace.html` | `ca07d9b56df7de3204b9c58f447c0ccdaa5f2a557828499c8c0f1b26cc611c80` |
| `mockups/execution.html` | `0745d086fe137f8b50c6629c5d9f17eb266c7b1ded6b67090b896db87524be1c` |
| `reference/execution-report.md` | `59ab9262c705a6cc0ee6deaf4af1c7a5f1b55319334e60eee76d7b541415f423` |

## Extraction boundary

The owner requested a separate Pipeline project and explicitly selected both mocks. The owner then specified Planning and Execution as the Pipeline sections, replacing Tasks. Original source files remain unchanged in Decision Roadmap. Reference snapshots preserve their original content and do not define additional approved scope. Only the extracted graph and the preview index are newly adapted UI.

Paseo project: `prj_example`, path `/Users/example/WORK/paseo-pipeline`. This is a separate non-Git project, not a copied Decision Roadmap repository or an installed plugin.
