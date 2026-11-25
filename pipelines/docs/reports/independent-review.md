# Independent extraction review

Reviewer: `<redacted-id>`, default reviewer profile, 2026-11-19.

### Role Contract Verification
Verified: `Role: reviewer. Status: default. Bindings: delivery-and-review.md; none. Subscription-backed: yes.` matches the brief and policy in the local team policy and delivery-and-review.md. No mismatch.

---

### 1. Scope & Exact Hashes Reviewed

Reviewed the owner-authorized mock extraction defined in [extraction-scope.md](../../docs/extraction-scope.md) and the implementation report in [extraction-implementation.md](../../docs/reports/extraction-implementation.md) against the preserved source snapshot [roadmap-combined.html](../../reference/roadmap-combined.html).

| File | Verified SHA-256 | Matches Expected |
| --- | --- | --- |
| [mockups/pipeline.html](../../mockups/pipeline.html) | `023e7dc78466aa2c5cea50043c28f16664c955677a0efdc7be264233f69ea719` | Yes |
| [index.html](../../index.html) | `a583281f0e0ff5b93c79ef40fc9b882ca5fb00cfc0eee3e1628ca144ad72fac8` | Yes |
| [mockups/execution.html](../../mockups/execution.html) | `0745d086fe137f8b50c6629c5d9f17eb266c7b1ded6b67090b896db87524be1c` | Yes (unchanged copy) |
| [reference/roadmap-combined.html](../../reference/roadmap-combined.html) | `b683dfc80190d6f915b856125e6f56569cdf187d8271a324e3cb1efbb3ff38b9` | Yes (unchanged snapshot) |
| [reference/execution-workspace.html](../../reference/execution-workspace.html) | `ca07d9b56df7de3204b9c58f447c0ccdaa5f2a557828499c8c0f1b26cc611c80` | Yes (unchanged snapshot) |
| [reference/execution-report.md](../../reference/execution-report.md) | `59ab9262c705a6cc0ee6deaf4af1c7a5f1b55319334e60eee76d7b541415f423` | Yes (unchanged snapshot) |

---

### 2. Load-Bearing Extraction Checks

- **Planning / Execution switching & navigation:**
  - [mockups/pipeline.html](../../mockups/pipeline.html#L10-L11) and [mockups/pipeline.html](../../mockups/pipeline.html#L185-L187) replace the source lifecycle strip (`Questions`, `Plan`, `Tasks`, `Execution`, `Done`) with the two owner-specified sections **Planning** and **Execution**, with no lifecycle lock or `Tasks` label.
  - Deep-linking (`#planning`, `#execution`), `history.replaceState`, `hashchange` sync ([mockups/pipeline.html](../../mockups/pipeline.html#L277-L286), [L394](../../mockups/pipeline.html#L394)), and the sidebar `data-section="planning"` button ([L5](../../mockups/pipeline.html#L5), [L297-L298](../../mockups/pipeline.html#L297-L298)) all route cleanly.
  - Roadmap, Overview, Questions, Plan revision/diff/approval, and Done views are completely removed from rendered output and event handlers.
- **Graph, step edits, and run interactions:**
  - The 21-step 6-layer DAG, coordinates, SVG dependency paths, rework arrow, palette/initials, human-gate markers (`Confirm constraints`, `Finalize delivery`), and DoD disclosures match [reference/roadmap-combined.html](../../reference/roadmap-combined.html#L13) ([mockups/pipeline.html](../../mockups/pipeline.html#L31-L148)).
  - Planning interactions (Diagram/List toggle, branch filter and `⑂ Show branch`, step `Edit` modal with title/description/DoD add-remove/model/reasoning/fallback/mode/retries, `Ask AI` prompt log, step deletion with edge filtering and branchRoot reset, and `Change the workflow` draft log/chat toggle) are preserved ([mockups/pipeline.html](../../mockups/pipeline.html#L199-L244), [L295-L392](../../mockups/pipeline.html#L295-L392)).
  - Execution interactions (`Stop` for `In progress`, `Accept` for `Needs review`, `Open chat ↗` preview, read-only `Step details` modal with `<fieldset disabled>`, and List grouping into `Needs attention`, `In progress`, `Waiting`, `Done`) are preserved ([mockups/pipeline.html](../../mockups/pipeline.html#L100-L131), [L172-L183](../../mockups/pipeline.html#L172-L183), [L367-L377](../../mockups/pipeline.html#L367-L377)).
  - Fixes a keyboard interaction bug from the source: `e.target === step` on `Enter`/`Space` ([mockups/pipeline.html](../../mockups/pipeline.html#L391)) prevents inner card buttons from being hijacked by the card's dialog opener.
- **Relative links, standalone dependencies, and side effects:**
  - [index.html](../../index.html#L30-L35) links relatively to `mockups/pipeline.html#planning`, `mockups/pipeline.html#execution`, `mockups/execution.html`, and `mockups/execution.html?layout=phone`.
  - [mockups/pipeline.html](../../mockups/pipeline.html#L5) links relatively to `../index.html` (`← All mockups`).
  - Zero external assets, network requests, or source-project runtime dependencies exist; all interpolated values pass through `esc()` ([mockups/pipeline.html](../../mockups/pipeline.html#L8)).

---

### 3. Findings

**Material findings:** None (`0`).

**Advisory notes:**
1. [mockups/pipeline.html](../../mockups/pipeline.html#L271) and [L364](../../mockups/pipeline.html#L364): `state.taskRequests` stores `task: state.taskPrompt` (the immutable node key) and renders `Draft for ${esc(x.task)}: ${esc(x.text)}`. If a step's title was customized via the Edit dialog, the draft request log line displays the original step key rather than `stepTitle(x.task)` (inherited verbatim from [reference/roadmap-combined.html](../../reference/roadmap-combined.html#L13)).

---

### 4. Limitations

- Review was strictly static and read-only (`shasum -a 256` verification and direct source inspection). Per instructions, no browser/Playwright session, local server, test runner, or file modification was executed in this review session; live browser verification is covered independently by the coordinator.

### 5. Verdict

**PASS** — 0 material findings.

## Coordinator disposition

PASS accepted for the exact hashes above. The advisory about an edited step name in an AI request log is inherited source behavior and outside this extraction; recorded without changing the reviewed mock. Browser verification is recorded separately in `browser-smoke.md`.
