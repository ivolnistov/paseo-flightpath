# Paseo Flightpath Plan

Plan turns project work items into plans with tasks, dependencies, and acceptance criteria. This directory contains the integrated Decision Roadmap implementation, including its visual roadmaps, decision interviews, plan approvals, and SnailOrbit integration.

Status: Stages 0–5 are shipped at `feb6905`. The feature-roadmap redesign and its implementation plan are owner-approved; implementation starts with R0. See [the approved design](docs/plans/2026-10-23-firstmate-redesign-design.md) and [the implementation plan](docs/plans/2026-10-26-decision-roadmap-redesign-implementation.md). Validation, review, installation, and live UI acceptance remain separate delivery states.

## Repository language

All repository-authored documentation, README and OVERVIEW content, specifications, plans, reports, code comments, and product-supplied UI text must be in English. Owner-facing conversations may use the owner's preferred language; user-authored project data keeps its original language.

## Scope

- Interactive roadmap and question cards in Paseo, including compact clients.
- Local project data in portable JSON and readable Markdown plans.
- Question options, recommended choice, free-text answers and discussion.
- Conditional branches, links between interviews, revision history and stale dependent decisions.
- Explicit plan approval tied to a revision; answering a question does not authorize execution.
- Automatic grilling: after you accept a block in the panel, the session's bound planner chat continues through its own native question card (Claude; Codex in Plan mode), with manual recovery when that is not possible.
- Tracker adapter: create tickets after approval, retain mappings, close after completion and required verification.

A GitHub remote exists. Publication, installation, reload, and production deployment follow the owner approval rules in `AGENTS.md`.
