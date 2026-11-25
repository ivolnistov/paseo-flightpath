# Extraction implementation report: Task 1

Date: 2026-11-19. Role: implementer (general). Scope: `docs/extraction-scope.md`, Task 1.

## Outcome

The graph's Tasks and Execution screens were extracted into a standalone mock with two sections, **Planning** and **Execution**. The project has an English landing page that links to both sections and to the preserved execution workspace mock. A real-browser smoke check has not been run; the coordinator owns it.

## Files

| File | Status | SHA-256 | Bytes |
| --- | --- | --- | --- |
| `mockups/pipeline.html` | created | `023e7dc78466aa2c5cea50043c28f16664c955677a0efdc7be264233f69ea719` | 42782 |
| `index.html` | created | `a583281f0e0ff5b93c79ef40fc9b882ca5fb00cfc0eee3e1628ca144ad72fac8` | 1886 |
| `docs/reports/extraction-implementation.md` | created (this file) | n/a | n/a |

Unchanged files, with hashes identical before and after this work:

| File | SHA-256 |
| --- | --- |
| `reference/roadmap-combined.html` | `b683dfc80190d6f915b856125e6f56569cdf187d8271a324e3cb1efbb3ff38b9` |
| `reference/execution-workspace.html` | `ca07d9b56df7de3204b9c58f447c0ccdaa5f2a557828499c8c0f1b26cc611c80` |
| `reference/execution-report.md` | `59ab9262c705a6cc0ee6deaf4af1c7a5f1b55319334e60eee76d7b541415f423` |
| `mockups/execution.html` | `0745d086fe137f8b50c6629c5d9f17eb266c7b1ded6b67090b896db87524be1c` |

The Decision Roadmap sources were read only. Their current hashes match the snapshots: `.sdd/ui-mockups/paseo-preview-20261105/reference/index.html` matches `b683dfc8…`, `.sdd/ui-mockups/preview/execution.html` matches `0745d086…`, and `.sdd/ui-mockups/execution-workspace.html` matches `ca07d9b5…`.

## `mockups/pipeline.html`

### Retained from the source

- **Styles:** the source `<style>` block is copied verbatim; a script confirmed it is an exact substring. Two rules were added: `a.button`, so the back link looks like a button, and a pointer cursor on the section pills.
- **Graph content:** the same 21-step graph (layers, edges, coordinates), the rework arrow, the bottom legend and the type palette with S/R/D/C/T/V/A chips. Human-gate styling, the parallel-next note and the DoD disclosure are unchanged.
- **Views:** a Diagram/List switch for each section (the original button label is "List"). In Planning, the branch filter and "Show branch" are kept.
- **Planning:** each step offers Edit, Ask AI and Delete.
  - The edit dialog keeps title, description, a DoD list (add and remove criteria) and executor settings: model, reasoning, fallback model, fallback reasoning, mode and retry limit.
  - The datalists are still labelled as an example catalog.
  - The "Change the workflow" card keeps "Request change" and "Open workflow chat". Ask AI and workflow requests are logged as local "Draft…" entries.
- **Execution:**
  - Sample statuses and attempt counts, with "Needs attention" highlighting.
  - Stop and Accept are enabled under the same conditions as the source.
  - "Open chat" shows the demo chat preview, which still says no agent is connected.
  - Clicking a step opens a read-only "Step details" dialog.
  - The List view groups steps into Needs attention, In progress, Waiting and Done.
- **Shell:** the Paseo sample sidebar and header bar, with the "INTERACTIVE MOCK" tag.

### Removed

- Roadmap dashboard, project selector, item cards and drag reorder.
- Overview, Questions, Plan (revisions, diff, approval) and Done screens.
- The feature lifecycle strip with its prerequisites ("Complete the previous stage first"), the "Previous stage · read-only" lock and the "Generate tasks" button that depended on plan approval. Planning is now always editable.
- Dead state and handlers for those screens (`taskDetails`, `config-control`, question search, plan editing).

The source CSS rules for the removed screens are still in the copied style block; they no longer match anything. They were kept so the visual output matches the source exactly.

### New or renamed UI

- Section navigation is a two-pill strip, "Planning" and "Execution", built with the original `.stage-strip`/`.stage-pill` styles. It has no lifecycle markers, and both pills are always enabled.
- The page opens in Planning. `#execution` deep-links to Execution, `#planning` to Planning. Switching sections updates the hash with `history.replaceState`, and a `hashchange` listener keeps the page in sync.
- The sidebar entry "Decision roadmap" became "Pipeline", and it opens Planning.
- Header: the heading is "Sample pipeline", the context line is "SAMPLE PROJECT / PLANNING|EXECUTION", and the crumb reads "Pipeline / Sample pipeline". The header action "← Roadmap" became the link "← All mockups" (`../index.html`).
- Honesty notes under the section strip:
  - Planning: "Configure the process graph: steps, dependencies, executors and checks. Changes stay in this page."
  - Execution: "Demo run · sample statuses. Stop and Accept change only this page; no agents are running."
- Visible "task" wording became "step" where it named a graph node:
  - "Edit step"/"Step details" (dialog headings) and "Change step · …" (Ask AI dialog)
  - "Steps" (list group) and "N steps including parallel paths" (branch info)
  - "⑂ N parallel next steps" and "Delete step" (title attribute)
  - "Step type legend" (aria-label) and "Pipeline graph" (graph aria-label)
  - the footnote "Within each step: …"
- Sample step names and descriptions ("…for this feature.") are unchanged. Internal identifiers (`data-task`, `taskConfig`, CSS classes such as `.task-list`) are unchanged and not visible.

### Behavior differences from the source

- Switching sections closes any open step dialog. In the source the overlay covered the stage strip.
- Enter or Space opens the step dialog only when the step card itself has focus. In the source, Enter on a button inside a card, such as Stop or Accept, opened the dialog and blocked the button's action.
- In Execution, Stop and Accept act only when the Execution section is shown. This guard is defensive only, because those buttons appear only in Execution.

## `index.html`

A static English landing page in the same dark palette, with no script. It uses only relative links:

- `mockups/pipeline.html#planning` and `mockups/pipeline.html#execution`
- `mockups/execution.html` and `mockups/execution.html?layout=phone`. The source supports `?layout=` (it reads `URLSearchParams(location.search).get('layout')`).

The page says the execution workspace is preserved as copied with Russian interface text, and that names, statuses and approvals in these mocks are illustrative.

## Checks

Scratch artifacts are in `/private/tmp/pipeline-extract/`, outside the project.

1. **Inline script syntax:** the only `<script>` of `mockups/pipeline.html` was extracted to `pipeline-inline.js`. `node --check` (Node v24.22.0) exited 0. `index.html` has no script.
2. **External references:** a regex scan of both files for absolute or protocol-relative `src`/`href`, `@import` and remote `url(` found none.
   - `pipeline.html` links only to `../index.html`.
   - `index.html` links only to the four relative targets above.
3. **Leftover wording:** a scan of `pipeline.html` outside the `<style>` block for `roadmap`, `question`, `Task` and `task` found only internal identifiers.
4. **jsdom simulation:** `smoke.cjs` runs the real page script in jsdom with `runScripts: 'dangerously'` and exited 0 with `passes=55 failures=0`.
   - jsdom was loaded read-only from an existing install in another local project (`paseo-feature-discussion-test-app/profiling-paseo-src/node_modules/jsdom`). Nothing was installed.
   - `Element.prototype.scrollIntoView`, which jsdom lacks, was stubbed as a no-op.
   - A first run failed two assertions. Both were harness faults: the missing `scrollIntoView`, and a group expectation made after the test had already stopped the only in-progress step. The page was not changed between runs.
   - Covered:
     - initial Planning section and pill state;
     - 21 steps, with 20 Edit/Ask AI/Delete sets and no run actions;
     - no Roadmap/Questions/Approve/"Generate tasks" text;
     - edit dialog: focus, add a DoD criterion, save title/model/fallback None/retries, empty-title rejection, Escape to close;
     - Ask AI draft log and step deletion;
     - workflow request log and workflow chat note;
     - card click opens the editor;
     - Show branch switches to List with a branch subset and info; branch filter back to all; return to Diagram;
     - Enter on a card versus Enter on an inner button;
     - switching to Execution (context, hash, demo note, no planning controls, edits and deletions carried over);
     - Stop and Accept state changes, chat preview open and close;
     - read-only Step details with a disabled fieldset and focus on Close;
     - Execution List groups;
     - sidebar return to Planning;
     - `#execution` deep link and `hashchange` to Planning;
     - no `undefined`/`NaN`/`[object` in the rendered text and no script errors.

## Limitations

- No real-browser rendering, layout, touch or screenshot check was done; at the coordinator's instruction no browser MCP was used and no server was started. jsdom does not do layout, so the visual result and the responsive behavior (the `<700px` default to List, the `<600px` bottom-sheet dialogs) were not checked here.
- Inline scripts have no type-check, lint or formatter gate: the project has no `package.json`, `tsconfig` or lint config, and none was created.
- `mockups/execution.html` was not opened or re-validated. Its historical validation is in `reference/execution-report.md`.
- No git operations, commits, installs, services, daemon or plugin changes, or network actions were performed.
