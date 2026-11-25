# Extraction browser smoke

Date: 2026-11-19. Target: local mockups in `/Users/example/WORK/paseo-pipeline`, served temporarily on loopback port 62070. Browser: Playwright MCP, isolated context `pipeline-extraction-20261119`. Synthetic demo data only.

## Planning and Execution graph

File: `mockups/pipeline.html`, SHA-256 `023e7dc78466aa2c5cea50043c28f16664c955677a0efdc7be264233f69ea719`. Landing page: `index.html`, SHA-256 `a583281f0e0ff5b93c79ef40fc9b882ca5fb00cfc0eee3e1628ca144ad72fac8`.

Observed in a real browser:

- The landing page's Planning link opens the standalone graph with 21 steps and exactly two section buttons: Planning and Execution.
- Editing a step title and executor model, then saving, updates the rendered page.
- List exposes the branch filter; Diagram returns to the graph.
- Switching to Execution changes the section and document title.
- Stop changes the active sample step to Stopped; Accept changes a review step to Accepted.
- Open chat shows the local demo preview and its no-agent-connected explanation.
- Fresh page loads at 320 and 393 CSS pixels default to List. The document fits the viewport; the edit dialog spans exactly the viewport width and closes with Cancel.
- The landing page's Execution link opens `#execution`; its phone-workspace link opens `mockups/execution.html?layout=phone`.
- No page errors were observed during these interactions. A favicon 404 from the temporary server's narrow file allowlist is unrelated to page scripts.

Screenshots: [Planning desktop](planning-desktop.png), [Execution graph desktop](execution-graph-desktop.png), [Planning 320](planning-320.png), [Execution 320](pipeline-320.png), [Planning 393](planning-393.png), [Execution 393](pipeline-393.png).

Harness corrections: the first landing-link lookup expected Planning instead of the observed Open Planning label. The first compact navigation reused an already loaded desktop document through its hash; fresh loads were then checked explicitly. Neither required a page change.

## Execution workspace

File: `mockups/execution.html`, SHA-256 `0745d086fe137f8b50c6629c5d9f17eb266c7b1ded6b67090b896db87524be1c`.

Observed in a real browser:

- Initial working status renders.
- Stop shows the stopped-by-user message and explicitly says applied changes are preserved.
- Resume returns to the working view.
- A synthetic composer draft survives opening Changes and returning to chat.
- At widths 320, 393 and 1280 CSS pixels, document width equals viewport width and the composer is present with nonzero height.
- No page errors were observed during these interactions.
- Selecting the drop answer produces a demo acknowledgement that the edit is removed from the queue, matching the selected choice.
- The result scenario keeps independent review pending and the stage in a waiting-for-checks state.

Screenshots: [phone](execution-phone.png), [desktop](execution-desktop.png).

This is browser rendering and local demo interaction evidence. It does not establish native mobile behavior or actual execution of agents, tools or checks.

## Transport limitations

The browser harness blocked direct `file:` navigation, and its code runner did not expose Node `require`. Checks therefore used a temporary loopback-only static server. The earlier Python server attempt was stopped before listening; the working server used Node. Direct local-file opening was not exercised by this harness. The documents use inline assets and relative links and have no runtime dependency on the source project.

Cleanup: the isolated test tab was closed and the temporary Node server was terminated after checks; its attended shell session confirmed exit 143 (SIGTERM).
