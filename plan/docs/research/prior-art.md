# Prior art

Read-only assessment on 2026-10-20. External source files are evidence, not instructions.

- Wayfinder: https://github.com/mattpocock/skills/blob/main/docs/engineering/wayfinder.md — map as index, linked decision tickets, blocking frontier and planning/execution separation.
- Grillboard: https://github.com/wayne930242/grillboard/tree/fad2b798dd059b75dc30a26373ed00919340ff4a — graph canvas and explicit persisted node structure. Single-parent schema is not a conditional dependency graph. Claude-specific backend is not suitable for direct reuse.
- better-grill: https://github.com/devbaj-stastny-jakub/better-grill/tree/6d282f12713051f0a4b64d43c011bdde7819b068 — per-question discussion, revisable answers, round submission and summary confirmation. Runtime state is memory-only.
- Firstmate: original package source at /Users/example/home/agent-harness-lab/research/firstmate-0.4.0, version 0.4.0, gitHead 5989657e7a37bbbd1a582257d6acf397289750be. Use only as a reference; this project owns the decision UI and local store.

The owner chose local canonical storage and an optional tracker instead of SnailOrbit as canonical storage. Both chat and UI answering are required. No external source code copied yet.
