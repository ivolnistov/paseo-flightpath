The Stage 1 cards in `docs/plans/tasks/2026-10-20-stage1.md` now use the host's query cache instead of a plugin-owned one. I also read the complete card once and fixed the inconsistencies below. Only this file changed; no source, installs or scope changes.

**Host-owned query cache:**
- The paseo-plugin skill (SKILL.md:640) says "the selected host owns the bundle, SDK calls, RPCs, and query cache". The excalidraw panel follows that and mounts no provider of its own.
- Ruling 6 now says the plugin creates no `QueryClient` and mounts no `QueryClientProvider`. Hooks use the host's `useQueryClient()`.
- Query keys now include the host: `["decision-roadmap", hostId, projectId, …]`, with `hostId` taken from `props.host.id`. Two daemons with the same `projectId` never share cache entries.
- `client/query.ts` is removed from the file map, and the `clear()` call is gone from the client cleanup.
- Every hook signature, the question card, the question editor and the relations editor now take `hostId`.

**Fixed during the full read:**
- **`QuestionView`:** the card had `Question.extend(...)`, but the core `Question` schema has a `.superRefine`, and Zod 4 refuses `.extend` on refined objects. It is now a wrapper, `z.object({ question: Question, visibility, status, depth })`; client code reads `qv.question.title`. I added note N5 and adjusted the views test wording.
- **Query keys:** comments that used `roadmapKey` without arguments are now `roadmapKey(hostId, projectId)`. The version query is excluded from invalidation by key position: `q.queryKey[3] !== "version"`.
- **Init:** the init button now invalidates the queries afterwards.
- **Duplicate test:** a repeated test bullet ("`applyAnswer` on a cyclic input throws") is removed.
- **Icon:** the `git-fork` / `list-tree` fallback is removed; the card uses the Lucide name `git-fork` only.

**Remaining uncertainty:**
- **Host query cache:** the installed 0.12.0 type files don't type or export the host `QueryClientProvider`. The host-cache guarantee rests on the skill text and the working excalidraw plugin, not on a typed contract. If it were wrong, the panel would fail on first render with "No QueryClient set" rather than misbehave silently. Stage 1 UI verification is where that shows up.
- **Zod 4 assumption:** I'm stating from Zod 4 behaviour, not from a run, that `.extend` fails on a refined object. The wrapper is correct either way.
- **Icon name:** whether the host accepts the Lucide name `git-fork` is still unconfirmed. It is cosmetic.
