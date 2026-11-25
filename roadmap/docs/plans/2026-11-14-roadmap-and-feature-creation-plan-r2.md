# Roadmap home, feature creation and stage-aware opening: design and implementation plan (revision 2)

Status: REVISION 2, written 2026-11-14 by the planner after one bounded Astra advisory pass on
draft 1. Not approved. Nothing here authorises implementation, installation, reload, publication
or a daemon change. The owner approves an exact revision of this plan before any production code
is written. Recommended defaults in §11 are not owner decisions.

- Draft 1 (unchanged): `docs/plans/2026-11-14-roadmap-and-feature-creation-plan.md`, SHA-256
  `d255d1d734bbc0075854aedfb489f753cf4b0da88abec9b0263a894d226d6064`.
- Diff against draft 1: `docs/plans/2026-11-14-roadmap-and-feature-creation-plan-r2-vs-draft1.md`.
- Astra's points and their dispositions: §13.

Baseline for every code reference: worktree `.worktrees/paseo-016-chat-live`, commit
`636bd48256bab564dd9f1d9a376dfd8b2c1ed935`. All reads were read-only. UI reference: branch
`preview/html-mock-20261105` at `36dc836` (client-only mock; a visual reference, never a
production baseline).

## 0. Authority

**Owner decisions of 2026-11-14 (relayed by the coordinator, not owner quotes).**

- **A1.** The feature list (Roadmap) and Sessions are both reachable from the main panel screen. On
  compact layouts a switcher chooses between them; Roadmap is the default, primary view.
- **A2.** The New feature form offers `Create & discuss` (creates the feature, starts and binds its
  discussion chat with the default or a chosen profile and language, and opens the Questions
  screen) and `Create` (creates the card only). A retry after a partial failure never creates a
  second card.
- **A3.** Pressing a feature card opens the feature's current stage: Questions opens the
  discussion screen; Plan, Tasks and Execution open their stage surfaces. Card management stays
  reachable.

**Preserved, not reopened.** The approved redesign design
(`docs/plans/2026-10-23-firstmate-redesign-design.md`): six feature statuses and no built / not
built marker (§2), human-only reorder, delete and status changes (§6), bug grilling optional (§4),
approval tied to an exact plan revision. The discussion slice (`2026-11-07-…-spec-r2.md`): one
bound discussion chat per feature, the reservation protocol, binding through the planner rebind
path, unresolved creations retried only on the owner's explicit confirmation; its §9 kept the
top-level Sessions overview "until a navigation slice removes it" — A1 keeps Sessions reachable,
so nothing is removed here. The four-stage strip (`2026-11-09-discussion-template-r7-plan-r4.md`
§2.2). `AGENTS.md`: React Native primitives only, compact and themed layouts stay usable, no
daemon restart, synthetic fixtures only.

**What this plan decides.** Layout, navigation, persistence and recovery mechanics (§3). Product
and scope choices the relayed decisions do not settle are in §11 with a recommended default each.

## 1. Goal and scope

Make the Roadmap the panel's home, make creating a feature and starting its discussion one flow,
and make a card press land on the surface where the feature's work currently is.

In scope: the panel's root screen and screen stack; `client/host-tab.ts` persistence; `/roadmap`
routing; the roadmap list (cards, type filter, reorder by drag handle with accessible controls);
the New feature form with `Create` and `Create & discuss`; stage-aware opening; the changes the
Questions, Plan and Feature screens need so every stage surface is reachable and leads back; and,
subject to §11 Q6, one optional input field on `feature.create`.

Out of scope: a discussion chat for bugs (§11 Q2); any change to how Discuss binds a chat to a
session (§3.6, §11 note); tracker links on cards; a project picker; the preview's Running rail;
plan, task and execution screen redesign; translation.

## 2. Verified baseline (read-only, `636bd48`)

| Item | Evidence |
| --- | --- |
| Screen stack | `client/panel.tsx:60-65` `Screen = overview \| roadmap \| feature \| plan \| session`; initial stack `restoreStack(...) ?? [{ kind: "overview" }]` (`:449`); `push` / `back` (`:455-462`); only the top screen renders, keyed by `${stack.length}:${kind}` (`:558`). A session screen takes its target and link from props at mount (`:193-194`) and is keyed by the link nonce (`:566`). |
| Root screen | `OverviewScreen` (`panel.tsx:90-165`): the Sessions list, links, `PlansList`, a `Roadmap` button and `New session` (`:117-121`). The roadmap is one push away (`:667`). |
| Roadmap screen | `RoadmapScreen` (`client/roadmap-screen.tsx:517-644`): `Back`, heading, `New feature` (`:577-581`), `DelegationsStrip`, then a card per feature with every action button and `DiscussionControls` (`:594-640`). It reads `useProjectRuns` and `usePlanList` (`:534-535`). The scroll container belongs to the panel (`panel.tsx:606-623`). |
| Feature form | `FeatureForm` (`roadmap-screen.tsx:198-280`): component-local state (`:210-217`); the store revision is pinned when it opens (`:213`) and sent as `expectedRevision` (`:222-225`), so every retry after a `revision_conflict` repeats the stale revision. Two callers create with it: the roadmap list (`:537-572`) and the feature screen's removal form, which passes no discussion context (`client/feature-screen.tsx:246-266`). |
| Discuss | `DiscussionControls` (`client/discussion-controls.tsx:58-152`): `discussAvailability` looks only at kind, status and `feature.discussion?.state` (`:20-23`), never at the session's planner; one `feature.discussion.open` call per press (`:83-99`). |
| Discuss server | `openDiscussion` (`server/discussion.ts:137-276`): refuses a revision other than the store's (`:142`) and a bug (`:145`; `server/sessions.ts:555-560`); refuses while a reservation is younger than 60 s (`:179-181`); commits the reservation before the agent (`:228-246`); `discussionReserve` does not look at the session's planner (`sessions.ts:1085-1113`); `discussionBind` checks only the reservation and then calls `rebindPlanner` (`sessions.ts:1127-1151`, `:529-539`), retrying after a revision conflict (`discussion.ts:298-308`). `plannerSet` does not look at a reservation (`sessions.ts:1068-1084`). A rebind keeps the previous planner in `plannerHistory`. |
| Feature RPCs | `feature.create` returns `featureId, revision` and allocates a fresh id per successful call (`shared/rpc-features.ts:27-38`; `server/features.ts:185-207`). Title and description are mutable (`features.ts:209-224`); kind and `relatedTo` are set at creation only. The MCP create tool has its own strict input schema without an id (`server/feature-tools.ts:26-35`). `feature.reorder` takes a full permutation, UI only (`features.ts:226-239`). `feature.delete` is refused while the discussion is `creating` (`features.ts:257-259`). |
| Store | `transact(expectedRevision, fn)` commits at most one write per revision under a lock (`server/store.ts:408-446`). Features are stored as `features/<id>.json` (`store.ts:349`), and `Feature` is a strict schema (`shared/model.ts:775-818`). |
| Mutations | `useRoadmapMutation` (`client/hooks.ts:235-288`): without an explicit revision it sends the highest revision of any cached project query (`:213-222`, `:251`); on success it awaits a re-read whose failure is swallowed (`:268-270`); on a refusal it calls `onError` before the re-read (`:277-279`); on a thrown call it re-reads nothing (`:261-265`). |
| Stage model | `client/stage-strip.ts:45-138` `stageModel`: `current` is null for done, deferred and cancelled, else execution, tasks, plan, questions (`:59-68`). `StageInput.session` requires `finishedByOwner` (`:23`). `useFeatureStage` (`client/stage-strip-view.tsx:36-79`) uses `plan.list`, `plan.get`, the feature's `run.list` and `session.get`, each with its own cache key (`hooks.ts:194`, `:203`, `:318`). |
| Stage surfaces | The session screen's strip sends every stage but Questions to `onOpenFeature`, which opens the feature screen on its default Tasks segment (`panel.tsx:315-317`, `:584`; `feature-screen.tsx:218`), so Plan opens Tasks today. Feature screen strip: `feature-screen.tsx:465-483`; its segment is local state (`:218`, `:487-494`). `PlanView` has no strip and reads its own `plan.get`, including `featureId` (`client/plan-view.tsx:133-137`). The panel reads `feature.list` on roadmap, feature and session screens only (`panel.tsx:472`). |
| List-level data | `plan.list` and `plan.get` compute approval with the same `approvalOf` (`server/plans.ts:327-333`, `:365-380`, `:402`). Project and per-feature `run.list` are one implementation with a filter (`server/runs.ts:959-969`). `roadmap.overview` gives each session's status and counts, no closure basis (`server/views.ts:25-40`). |
| Chat actions | `grillingActions` offers no Bind on a closed session or one without blocks (`client/grilling-header.ts:118-132`). The planner picker scrolls inside a bounded region (`panel.tsx:320-322`). |
| Tab persistence | `client/host-tab.ts`: key `decisionRoadmap`, `VERSION = 1` (`:9-10`); `restoreStack` checks version, host and project and rejects a stack not starting with `overview` (`:57-65`); `saveStack` writes only this key beside the tab's others (`:68-76`). The host remounts the panel on a breakpoint change (`:1-8`). The `tab` prop is optional (`:17-26`). |
| Slash routing | `client/slash.ts:29-42`: `feature <q>`, `question <link \| Q<n>>`, and everything else, including mistyped arguments, becomes the roadmap route. Timeline and reference cards produce only `question` routes (`client/timeline-card.tsx:39`, `client/references-card.tsx:54`). Panel handling: `panel.tsx:474-518`. |
| Settings | `roadmapSettings.discussionProfile`, `discussionLanguages` (`shared/settings.ts:60`, `:67`); unread settings mean no default and English only (`panel.tsx:445-448`). |
| Preview reference | `client/preview/pages/dashboard.tsx` at `36dc836`: type filter chips (`:27-32`), `DragHandle` with `PanResponder` (`:49-121`), move controls (`:271-292`), card (`:230-308`); `dropIndex`, `reorderVisible` (`client/preview/store.ts:257-279`); `LifecycleStrip` (`client/preview/progress-view.tsx:8-31`). |
| Not verified | `PanResponder` has no production use. The local React Native sources (0.81.5, a development dependency; the host supplies its own runtime) say a scroll view "doesn't yet support other contained responders from blocking" it and refuses to give up the responder once it has scrolled (`ScrollView.js:704-705`, `:1394-1395`). The sandbox's saved agent profiles are unknown. |
| E2E coupling | `e2e/lib/ui.mjs:23` and `e2e/run.mjs:808` wait for `Sessions` or `‹ Back`; `openSession` (`ui.mjs:27-45`) and j1 (`run.mjs:307-308`) expect session rows and `New session` at the root. The sandbox safety check allows zero agents, or only its inert fixture (`e2e/lib/sandbox.mjs:67-74`). |

## 3. Design

### 3.1 Screen model and navigation rules

```ts
type RootView = "roadmap" | "sessions";
type TypeFilter = "all" | "feature" | "bug";
type FeatureSegment = "questions" | "tasks" | "chat" | "plan" | "changes";
type Screen =
  | { kind: "home"; view: RootView; filter: TypeFilter }
  | { kind: "feature"; featureId: string; segment?: FeatureSegment }
  | { kind: "plan"; planId: string }
  | { kind: "session"; sessionId: string; target?: Target; link?: PendingLink };
```

Invariant: exactly one `home` entry, at `stack[0]`. The `overview` and `roadmap` kinds are
removed. The initial stack is `[{ kind: "home", view: "roadmap", filter: "all" }]`.

Operations:

- `push(next)`, `back()` as today.
- `setRoot(patch)`: replaces `stack[0]` in place (switcher, filter).
- `setTopSegment(segment)`: records the feature screen's current segment on the top entry, in
  place and without a remount (the screen key does not include the segment).
- `hop(destination)`: stage navigation, below.
- `resetTo(view)`: the stack becomes `[home]` with that view, the filter kept.

**Destinations.** One pure function, `stageDestination(feature, stage, boundPlanIds)`, serves every
strip and the card press:

| Stage | Destination |
| --- | --- |
| Questions | the session of `grillSessionId`; without a session, the feature screen's Questions segment for kind `feature`, and none for a bug |
| Plan | the plan screen when exactly one plan is bound; otherwise the feature screen's Plan segment |
| Tasks, Execution | the feature screen's Tasks segment |
| `Feature details` | the feature screen, default segment |

This replaces today's single `onOpenFeature` on the session screen's strip, which sends Plan to
Tasks.

**Push.** Card press, session row, plan row, `/roadmap feature`, question links, cross-session
references, dependency and related links, a plan opened from a feature's Plans or Changes list. A
pushed entry is never merged with, or dropped in favour of, another entry: two entries for the
same session with different targets both stay, as today.

**Hop.** A strip pill or `Feature details`, pressed on a surface of feature F, which is by
construction the top entry:

1. If the destination is the feature screen of F and the entry directly beneath the top is a
   feature-screen entry of F, the top is popped and that entry takes the requested segment.
2. Otherwise the top entry is replaced by the destination. A session destination carries no
   target or link.

No other entry is touched. Consequences: stage hops never lengthen the stack; Back from a stage
surface returns to where the feature was opened from; a plan opened from a feature's Plans list
returns to that same feature entry when the owner hops to Tasks (rule 1), instead of leaving two
entries for it. A one-shot question target on a session entry is consumed by that session screen
and is not restored by hopping away and back.

**Reset.** Only the bare `/roadmap` (§3.9).

### 3.2 Home screen and the Roadmap | Sessions switcher (A1)

The switcher is the same control on wide and compact layouts (§11 Q1).

```
Wide                                                    Compact
[ Roadmap | Sessions ]            [+ New feature]       [   Roadmap   |   Sessions   ]
Show (All)(Features)(Bugs)              7 items         Show (All)(Features)(Bugs)
<cards>                                                 7 items          [+ New feature]
                                                        <cards>
```

- **Switcher.** A row with `accessibilityRole="tablist"` labelled "Roadmap views"; two `Pressable`
  segments with `accessibilityRole="tab"`, `accessibilityState={{ selected }}` and `aria-selected`
  for the web (`webAria`, `client/discussion-ui.tsx:39`). Each is at least 44 px high; on compact
  they share the full width; on wide each is at least 120 px wide, left-aligned. The selected
  segment has the `surface2` background, semibold text and a 2 px `accent` bottom bar.
  Keyboard: each segment is focusable and Enter or Space selects it; on the web Left and Right
  move focus between the two, through the key handling the Chat menu already uses
  (`client/chat-menu.tsx:131-134`).
- **Actions.** Roadmap view: `+ New feature` (primary). Sessions view: `New session` (primary).
- **No Back**: the home screen is the root.
- **Roadmap view** (§3.3) owns its scroll container (moved out of the panel), so it can lock
  scrolling during a drag and scroll to a new card.
- **Sessions view.** The body of today's `OverviewScreen` unchanged, without its heading row and
  `Roadmap` button. A feature's session stays listed.
- **Reads.** `feature.list`, `plan.list`, project `run.list` and `roadmap.overview`: four
  project-level reads whatever the number of cards. Each view shows its own loading or error
  state; a failed read of one never hides the switcher or the other view.

### 3.3 Roadmap view: filter, cards, card actions

**Type filter.** A `radiogroup` labelled "Show" with chips `All`, `Features`, `Bugs`
(`accessibilityRole="radio"`, `accessibilityState.checked`, `aria-checked` on the web), 44 px high;
on the web Left and Right move between chips. Client-side only. Beside it `7 items` or
`3 of 7 items`. An empty result shows "No items of this type." The filter lives in the home entry.
Creating an item whose kind the filter hides switches the filter to `All`.

**Card.**

```
┌──────────────────────────────────────────────────────────────┐
│ [Feature] [Planned]                                 [⋯] [⠿]  │
│ Title (semibold, wraps)                                       │
│ Description (muted, at most 2 lines)                          │
│ ▬▬▬▬ ▬▬▬▬ ▬▬▬▬ ╌╌╌╌                                            │
│ ✓ Questions  ● Plan  Tasks  Execution                         │
│ Running · 3/7 verified                (only when a run exists)│
│ Depends on: A, B        Discussion chat: outcome unknown      │
└──────────────────────────────────────────────────────────────┘
```

- **Open area.** Kind tag, status chip, title and description are one `Pressable`
  (`accessibilityRole="button"`, label `Open <title>. <stage sentence>`, at least 44 px high). The
  strip and progress lines sit in a second pressable hidden from accessibility, so a press
  anywhere on the body opens the feature while a screen reader meets one button. Both call
  `openFeature(id)` (§3.5).
- **Status chip.** The existing six-status chip. No built / not built marker.
- **Lifecycle strip.** Four equal segments. Each state has a mark as well as a colour: complete is
  a filled `statusSuccess` bar and `✓` before the name; current is a filled `accent` bar, `●` and
  a semibold name; open is an outlined bar and a plain name; unknown is a dashed outline and `?`.
  It is not interactive. Its accessibility sentence is "Stage: Plan, 2 of 4", "Stage: finished",
  "Stage: none (deferred)" or "Stage: unknown". It shows stage position only (§3.5), never the
  screens' detail text.
- **Progress.** The existing `progressText` line only when a run exists, with a 4 px bar of
  verified over total. The `delegated` line stays.
- **Secondary lines.** `Depends on: …`, the status reason, and a one-line discussion state for
  `creating`, `unresolved` and `failed`.
- **More (`⋯`).** A 44×44 button, label `More actions for <title>`, `expanded` state. It expands
  an inline section: `Details`, then `featureActionButtons` without `open` (Edit, Dependencies,
  Defer or Resume, Cancel and Delete with their confirming press, Create removal feature), then
  `DiscussionControls` when its availability is `discuss`. One card is expanded at a time. While a
  card with a session is expanded, its `session.get` is read (one query); if that session already
  has a planner, the controls carry the replacement warning of §3.6.
- **Reorder handle (`⠿`).** §3.4.
- **New card.** After `Create` the list scrolls to its end and the new card has an `accent` border
  until the next interaction.

### 3.4 Reorder: drag handle, accessible controls, filter

**Handle.** A 44×44 `Pressable` (`accessibilityRole="button"`, label
`Reorder <title>, position 2 of 5`, hint "Drag to move. Activate to show move controls.",
`expanded` state, native accessibility actions `moveUp` and `moveDown`), wrapped in a `View` that
carries the `PanResponder` handlers.

**Move controls (the guaranteed path).** Pressing the handle (tap, click, Enter, Space) shows a row
under the card: `Moving · position 2 of 5`, then `Move to top`, `Move up`, `Move down`,
`Move to bottom`, `Done`. Each is a 44 px button labelled with the title (`Move <title> up`),
disabled at its edge. This row works whether or not drag does, and is the keyboard and web
screen-reader path.

**Drag (shipped only if its gate passes, T6).**

- The responder claims the gesture in the capture phase once vertical travel exceeds 4 px and
  dominates horizontal travel, and refuses termination; on the web the wrapper has
  `touchAction: "none"`.
- While a drag is active the Roadmap view's own scroll container has `scrollEnabled={false}`. The
  lock is derived from the drag state, so every end of a drag, however it ends, restores
  scrolling.
- **One coordinate system.** Row bounds are the `onLayout` `y` and `height` of each visible card
  relative to their common parent; the displacement is the gesture's cumulative `dy`. The two are
  comparable because the scroll offset is frozen for the whole drag and no ancestor is scaled.
- **Release** computes the drop index over the measured rows. Nothing is sent when the index is
  unchanged or when any visible card is unmeasured.
- **Cancel** (no reorder sent, the card returns): `onPanResponderTerminate`; a change of the
  feature order, the store revision or the filter during the drag; a remount. Measurements are
  taken again on every layout change (an expanded More section, a wrapped title).
- A press within 400 ms of a drag's end is not a handle press. There is no auto-scroll at the
  list's edges; longer moves use `Move to top` and `Move to bottom`.
- If `PanResponder.create` is not a function, or the gate fails on a host, the handle has no drag
  there and everything else works.

**Filter.** `feature.reorder` needs the full order. A move in the visible list is mapped by
`reorderVisible(order, visibleIds, id, toIndex)`: the item is removed from the full order and
inserted immediately before the visible item it lands on when moving up, immediately after it when
moving down. Hidden items keep their relative order; the position text says
`position 2 of 3 shown`.

**Sending.** One `feature.reorder` per drop or control press with the rendered `revision`; handles
and move controls are disabled while any card mutation is pending. The list shows the new order
optimistically until the store revision changes or the call fails. Nothing is retried.

### 3.5 Opening a feature at its current stage (A3)

**Stage position.** `stage-strip.ts` gains `stagePosition(input)`, which returns the current stage
and each stage's state from position facts only: the feature's status; the session's status; the
bound plans; the bound plan's approval and latest revision; the run facts. `stageModel` keeps its
inputs, outputs and tests and is built on `stagePosition`, adding detail text from the completion
provenance (`finishedByOwner`, `basis`, `hasTasks`) that only the screens have.

- The card calls `stagePosition` with `plan.list` summaries, the project `run.list` and the
  overview's session statuses.
- The screens' strip (`useFeatureStage`) takes its position facts for the plan from the
  `plan.list` summary as well, and uses `plan.get` only for detail. The card's example of
  disagreement — the list says the approval is current while `plan.get` is still loading, so the
  screen shows Plan — is thereby removed.
- Run facts stay on two caches (project runs on the list, the feature's runs on the screens).
  They converge on every revision change; between two fetches they can differ.

The promise is therefore: **the same facts give the same stage**, on the card and on every screen.
It is not that the two can never differ for a moment.

**Read precedence**, the same in both adapters: data that is present is used, including data kept
after a failed refetch; otherwise a failed read is `failed`; otherwise `loading`.

**Target.** `featureOpenTarget(feature, reads)` is pure:

| Feature | Target |
| --- | --- |
| Status `done`, `deferred` or `cancelled` | feature screen, default segment. No read is needed. |
| Status `executing` | feature screen, Tasks segment. No read is needed. |
| `created` or `planned`, `plan.list` or project `run.list` loading | `wait` |
| `created` or `planned`, one of them failed with no data | feature screen, default segment; its strip shows the failed read |
| otherwise | `stageDestination` of the current stage (§3.1); a bug in Questions without a session opens the feature screen, default segment |

**Opening is navigation only.** `openFeature` never calls `feature.discussion.open`,
`session.create` or any other write.

**Waiting.** `openFeature(id)` records an open intent. An effect resolves it when the target is no
longer `wait` and pushes it; after 3 s it pushes the feature screen. While it waits the card shows
"Opening…" and reports `busy`. Another card press replaces the intent; a switcher press, a route
or an unmount clears it. `/roadmap feature` uses the same intent.

**With a session versus without.** A session exists once any Discuss press has reserved a chat, or
once a plan was drafted; the card then opens the session screen (§3.6). Without one the card opens
the start panel. A standalone session is never created or reused by a card press.

**Management stays reachable** from the card's More section, the feature screen's summary, and
`Feature details` on the session and plan screens of a feature.

### 3.6 Stage surfaces

- **Feature screen.** `initialSegment` from its stack entry, and `onSegment` reporting each change
  to `setTopSegment`, so a breakpoint remount reopens the segment the owner last selected, not the
  one the screen was entered on. New segment `questions`, for kind `feature` without a session:
  heading "Questions", the text "This feature has no discussion yet. Start a discussion chat to
  collect its questions.", and `DiscussionControls`, whose `onOpened` hops to the session. The
  strip's Questions pill then selects this segment; it stays unavailable for a bug without a
  session. Compact shows a `Questions` segment button only while that segment applies; wide shows
  the panel in the left column.
- **Session screen.** For a feature's session: a 44×44 `Feature details` button in the title row;
  the strip uses `stageDestination` and `hop`; the panel reads `plan.list` on these screens (the
  strip already reads the same cached query to enable the Plan pill).
  **Discuss notice**, shown only when all of these hold: the session view has loaded without
  error (an unread session is never taken as "no planner"); the session is active; the feature's
  `discussAvailability` is `discuss`; `feature.discussion?.state` is not `bound`; and the session
  has no planner. It holds `DiscussionControls` inside a scroll region bounded like the planner
  picker (220 px compact, 320 px wide), so profile and language chips cannot push the question
  canvas off a phone screen. When the discussion is `creating`, `unresolved` or `failed` but the
  session has a planner, the screen shows that state as one line of text with no control.
  While the feature's discussion is `creating`, `Bind` / `Change chat` does not open the planner
  picker and says "A discussion chat is being created for this feature."
- **Replacement warning.** `DiscussionControls` gains `replacesChat`. Where the caller knows the
  feature's session already has a planner (the expanded card, §3.3), the controls show "This
  feature's question session already has a chat. Discuss creates a new chat and binds it instead;
  the current one stays in the session's history."
- **What is not promised.** Binding a discussion chat goes through the planner rebind path; that
  is shipped, approved behaviour and this slice does not change it. The rules above are
  presentation: they make a replacement visible in this client, and they do not prevent one. A
  planner bound from another client, by an agent's first `roadmap_ask`, or in the moments between
  a reservation and its binding is still replaced when the discussion chat binds
  (`sessions.ts:1127-1151`). Draft 1's sentence that Discuss "never silently replaces a chosen
  chat" is withdrawn. A server guard would change the discussion slice and is noted for the owner
  in §11.
- **Plan screen.** `PlanView` gains `renderHeader(featureId)`, drawn under its title row once its
  own `plan.get` names a feature. The panel reads `feature.list` and `plan.list` on plan screens
  too, so a plan opened from Sessions or restored from the tab state gets its header: the strip
  (`viewed="plan"`) and `Feature details`. While `feature.list` is loading or has failed the
  header is absent and the plan is fully usable. A legacy plan has no header.

### 3.7 New feature form: `Create` and `Create & discuss` (A2)

The form replaces its caller's content while open, as today.

```
New feature
Type      (Feature) (Bug)
[ Title                              ]
[ Description                        ]
Discussion chat                         ← kind Feature only
  Profile: Planner (default)  [Change…]
  Language: (English) (Russian)         ← only with configured languages
[Create & discuss]  [Create]  [Discard]
```

**Discussion section** (kind `feature`):

| Situation | Shown | `Create & discuss` |
| --- | --- | --- |
| Default profile set and among the saved profiles | `Profile: <name> (default)` and `Change…` showing the saved profiles as chips; `Use default` returns | enabled |
| Default set, profiles unreadable | `Profile: default`; "The saved agent profiles could not be read." | enabled (the server resolves the default) |
| No default (unset, unread settings, or naming a profile that no longer exists), profiles exist | "No default discussion profile. Choose a profile for this chat, or set a default under Settings." with the chips open | disabled until one is chosen |
| No saved profiles | "No saved agent profiles. The feature can still be created without a discussion." | disabled |
| Languages besides English | chips, English selected | — |

Kind `bug`: no Discussion section and no `Create & discuss`; "Bugs are created without a
discussion chat."; `Create` is primary (§11 Q2).

**Both callers.** The roadmap list's form and the feature screen's removal form are the same
component with the same two buttons; the feature screen receives the discussion context
(workspace, default profile, languages) it lacks today.

| Caller | After `Create` | After `Create & discuss` succeeds |
| --- | --- | --- |
| `+ New feature` on the Roadmap | form closes; the list shows the new card: `[home]` | `[home, session]` |
| `Create removal feature` in a card's More section | the new feature opens, as today: `[home, <its stage target>]` | `[home, session]` |
| `Create removal feature` on the feature screen of D | as today, pushed over D: `[…, feature D, <its stage target>]` | `[…, feature D, session]` |

#### 3.7.1 Creation identity (drawn with the recommended answer to §11 Q6)

The client chooses the new feature's id. `feature.create` accepts an optional `featureId` and
answers a repeated call for an id that already exists with that card instead of creating another
(§4). Identity is then exact: "was my card created" is "is this id in the list", and a retry with
the same id is safe at any time. Fingerprint matching, which draft 1 relied on, is not used.

#### 3.7.2 State machine

One pure reducer owns every transition; the component only renders its state and dispatches
events. The operation record is minted at the first press:

```ts
type Operation = {
  featureId: string;                       // minted on the client
  payload: { title: string; description: string; kind: "feature" | "bug"; relatedTo: string[] };
  intent: "create" | "discuss";
  profileRef?: string; language?: string;  // discuss only
};
```

| State | Meaning | Inputs |
| --- | --- | --- |
| `editing` | Nothing sent, or the last call was refused and no call of this operation is unanswered | editable |
| `creating` | A `feature.create` call is in flight | locked |
| `unknown` | A call of this operation got no answer, so the card may or may not exist | locked |
| `created` | The card exists (confirmed id) | gone |
| `discussing` | `feature.discussion.open` is in flight | gone |
| `recovery` | The card exists; its discussion did not start | gone |
| `closed` | Finished, discarded or navigated away | — |

Transitions:

- `editing` → press → `creating`. The trimmed payload, the button and the profile and language are
  frozen into the operation. A synchronous ref latch drops a second press in the same frame.
  Every `feature.create` call carries the **feature list's own revision** explicitly; the hook's
  default, the highest revision of any cached query, is never used for a create.
- `creating` → answer ok → `created`, with the answer's `featureId` (authoritative even if it
  differs from the minted one, which only a server older than the client could cause).
- `creating` → refusal, with no unanswered call of this operation → `editing`, text kept, the
  server's message shown. After `revision_conflict` the next press uses the list's then-current
  revision. The next press mints a new operation, so edited text never rides on an old id.
- `creating` → the call throws → `unknown`.
- `unknown` → `Retry` → `creating`, same operation, same id. A refusal now returns to `unknown`,
  never to `editing`: an earlier call may still land, so the payload stays frozen.
- `creating` or `unknown` → the feature list contains the operation's id → `created`. The list
  observation and the call's answer are the same event to the reducer, and `created` accepts it
  once; whichever arrives second is ignored.
- `unknown` → `Discard` → `closed`, after the text "The request may still create this feature; it
  would then appear in the roadmap."
- `created`, intent `create` → `closed` (the caller's row in the table above).
- `created`, intent `discuss` → `discussing`. This transition is the only place step 2 starts, and
  the reducer leaves `created` in the same step, so it starts once.
- `discussing` → ok → `closed`, the session opens. → `revision_conflict` → one automatic retry at
  the re-read revision, its toast suppressed through a new `quiet` option of the hook; safe
  because the refusal precedes the reservation or the reservation already guards the creation
  (`discussion.ts:142`, `:179-181`). → anything else, including a thrown call → `recovery`.
- A late answer for an operation that is no longer current, or after an unmount, changes nothing
  and navigates nowhere; the card it may have created is simply in the list.

The three failures read differently: `editing` with a message ("Not created: <message>"),
`unknown` ("It is not known whether the feature was created." with `Retry` and `Discard`), and
`recovery` (below).

**Recovery panel.** No field and no create button remain, so nothing here can create a card:

```
Feature “<title>” was created.
Its discussion chat has not started: <the server's message>
<DiscussionControls for the created feature>
[Back to roadmap]            (or [Back to feature] in the feature screen's form)
```

`DiscussionControls` reads the live feature, so it shows the stored state (`creating`,
`unresolved` with its explicit confirmation, `failed`, or `bound` with `Open discussion`). New
optional props `initialLanguage` and `preferredProfile` carry the form's choices. The same
controls are on the card, the start panel and the session notice afterwards.

#### 3.7.3 What survives a remount

Losing half-typed text and losing the identity of a write that may have landed are different
losses. The text is not persisted (as today). The operation is: from its first send until
`closed` it is written to the tab state beside the stack (§3.8).

After a remount with a stored operation the form is not rebuilt. The panel shows one banner above
whatever screen is open:

- the list does not contain the id: "Creating “<title>”: it is not known whether the last request
  was applied." with `Retry` (the same id and payload) and `Dismiss`;
- the list contains the id: "“<title>” was created." with `Open` (its stage target) and `Dismiss`;
  for intent `discuss` it adds "Its discussion chat was not started from this screen." Step 2 is
  never run automatically after a remount; the owner starts it with Discuss.

On a host that passes no `tab` prop nothing is stored: after a remount in the `unknown` state the
form is closed and the operation's identity is lost. That gap is stated in §9.

**Cost boundary.** `Create & discuss` creates an agent and sends it one prompt, on that press
only. The single automatic `revision_conflict` retry cannot create a second agent.

### 3.8 Persistence in the host tab (`client/host-tab.ts`)

`VERSION` becomes 2. The kept value:

```ts
{ v: 2, hostId, projectId, stack: StoredScreen[], op?: Operation }

type StoredScreen =
  | { kind: "home"; view: "roadmap" | "sessions"; filter?: "all" | "feature" | "bug" }
  | { kind: "feature"; featureId: string; segment?: FeatureSegment }
  | { kind: "plan"; planId: string }
  | { kind: "session"; sessionId: string };
```

The host and project checks of `restoreStack` and the rule that `saveStack` writes only this
plugin's key beside the tab's other keys are kept exactly.

- **v2.** The first entry must be `home` with a valid `view`, and no other entry may be `home`;
  otherwise null. An unknown `filter` reads as `all`, an unknown `segment` as absent, a malformed
  `op` as absent.
- **v1, read-only migration.** A v1 value that the v1 rules accept is converted:

  | v1 stack | v2 stack |
  | --- | --- |
  | `[overview]` | `[home roadmap]` |
  | contains a `roadmap` entry | `[home roadmap, …]` without the `overview` and `roadmap` entries |
  | deeper, no `roadmap` entry (`[overview, session S]`, `[overview, plan P]`) | `[home sessions, …]` |

  `[overview]` becomes Roadmap because every tab opened before this change stores `[overview]` as
  its untouched default; keeping it would put every existing tab on Sessions. The next save
  writes v2.
- **Any other version or shape** → null, and the panel opens on the default home.

A plugin downgraded to v1 code reads a v2 value as "nothing kept". Stored: the root view, the
filter, the stack, a feature screen's current segment, an unresolved create operation. Not stored:
link targets, the open intent, the expanded card, move mode, form text.

### 3.9 `/roadmap` routing

`parseRoadmapArgs` gains one route, `{ kind: "unknown"; args }`. Today any argument it does not
recognise becomes the roadmap route; with a reset that would throw away the stack on a typing
mistake.

| Input | Route | Behaviour |
| --- | --- | --- |
| `/roadmap`, `features`, `runs` | roadmap | `resetTo("roadmap")`. The stack above the root is dropped on purpose (§11 Q4 note). |
| `feature <id or title>` | feature | Resolved as today, then `openFeature(id)`, pushed (§11 Q4). No single match → the notice, and no navigation. A failed `feature.list` → `resetTo("roadmap")`, whose view shows the error. |
| `question <link>` | question | Unchanged: pushes the session with the link. |
| `question Q<n>` | question-number | Unchanged. |
| anything else, including `feature` without a name and `question` with an unreadable argument | unknown | No navigation. Notice: "Unknown /roadmap arguments. Use: features, feature <id or title>, question <link or Q<n>>." |

Changed from today for well-formed input: the bare command resets instead of pushing, and
`feature` opens the stage. Changed for malformed input: a notice instead of the roadmap screen.
Question links from timeline and reference cards use the `question` route and are unaffected.

### 3.10 Layout, accessibility, themes, hosts

- Every pressable is at least 44×44 px on both layouts.
- Only `View`, `Text`, `Pressable`, `ScrollView`, `PanResponder`, `Platform` from `react-native`,
  and the host's `TextInput`, `Icon`, `Modal`, `FlatList`. No DOM, SVG or new dependency.
- Colours from `theme.colors` only; every state also has a word or a mark.
- Web states through `webAria`: `aria-selected`, `aria-checked`, `aria-pressed`, `aria-expanded`,
  `aria-busy`.
- Focus returns to the control that opened a form, a move row or a More section.
- Hosts: no new host API; `tab` stays optional; the manifest requirement and SDK pins are
  untouched.

## 4. Server and shared contracts

**One contract change, subject to §11 Q6.** `feature.create` gains an optional input:

```ts
featureId: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/).optional()
```

`server/features.ts` `create`, for a UI origin carrying `featureId`:

1. Reads the store. If a feature with that id exists and was created by a human with the same
   kind and the same `relatedTo`, the call answers `{ featureId, revision }` of the current store
   without writing. If one exists that does not match, the call is refused (`invalid_input`,
   "feature id already in use").
2. Otherwise it creates the card as today with that id, re-asserting inside the transaction that
   the id is unused.

Why it is needed: A2 requires that a retry never creates a second card. The server commits one
write per revision, not one card per attempt, and allocates a new id on every success
(`store.ts:408-446`, `features.ts:191`). Client-side matching on title, description and kind
cannot tell the owner's card from another person's identical one, breaks when the card's text is
edited before the retry, and has nothing to match against after a remount (§13, point 1).

Bounds of the change:

- No stored field and no migration: the id is the feature's ordinary id. Existing stores and
  older installed revisions read the result unchanged.
- The id becomes a file name (`store.ts:349`), so the pattern is a safety requirement, enforced by
  the contract and again in the command.
- Agents cannot use it: the MCP create tool's own strict schema has no such field
  (`feature-tools.ts:26-35`), and the command ignores it for a non-UI origin.
- Title and description are not compared on a repeat, because they are mutable. A card deleted
  between the first call and the retry is created again.
- The output is unchanged.

**Nothing else changes on the server.** In particular the discussion commands are untouched
(§3.6).

Considered and rejected: a stored request id on the feature (a new field in a strict stored
schema that older installed revisions would reject); one combined create-and-discuss RPC (the chat
is an external effect; the reservation protocol already makes step 2 recoverable); a stage field
in `feature.list` (the list-level reads already determine it).

Client-internal type changes: `stagePosition` and its input type; `MutationOptions.quiet`; the
`unknown` slash route; tab state v2.

## 5. Files

New: `client/roadmap-model.ts` (pure: filter, `reorderVisible`, `dropIndex`, list-level stage
adapter, `stageDestination`, `featureOpenTarget`, hop rule, the form reducer, `newFeatureId`),
`client/roadmap-card.tsx`, `client/home-screen.tsx`, and their tests.

Changed: `client/panel.tsx`, `client/host-tab.ts`, `client/slash.ts`, `client/roadmap-screen.tsx`,
`client/discussion-controls.tsx`, `client/feature-screen.tsx`, `client/plan-view.tsx`,
`client/stage-strip.ts`, `client/stage-strip-view.tsx`, `client/hooks.ts`,
`shared/rpc-features.ts`, `server/features.ts`, their tests, `e2e/lib/ui.mjs`, `e2e/lib/rpc.mjs`,
`e2e/run.mjs`, `OVERVIEW.md`, `docs/SPEC.md`, `docs/STATUS.md`.

Unchanged: the rest of `server/` and `shared/`, `index.client.tsx`, `paseo-plugin.json`,
`package.json`.

## 6. Tasks

One isolated worktree branched from `636bd48`. Production code and executable tests are written in
separate assigned roles; one commit per task after its checks pass; synthetic fixtures only; no
daemon restart, no credential or settings change. Each task ends with its focused tests, then
`npm run typecheck` and `npm run lint`.

**T0. Preflight (evidence, no commit).** The sandbox's saved agent profiles, and whether one uses
the inert provider within the safety check's agent limit. The E2E RPC allow-list rules for feature
writes and deletes. Whether the coordinator can stage a throwaway revision in the sandbox; if so,
T6's gate may be run on a minimal handle before T5 to learn the drag answer earlier.

**T1. Pure models.** `roadmap-model.ts`; `stagePosition` in `stage-strip.ts` with `stageModel`
built on it; the `unknown` route in `slash.ts`. Tests: `reorderVisible` and `dropIndex`;
`stageDestination` for every stage with zero, one and several plans, with and without a session,
feature and bug; every row of the §3.5 target table; the read-precedence rule; the hop rule
(replace; pop to the feature entry beneath; requested segment wins; entries with different
session targets never merged); the reducer's full transition table, including a list observation
before and after the call's answer, a refusal in `unknown`, and a late answer for a replaced
operation; `stageModel`'s existing tests unchanged and green; `parseRoadmapArgs` for each row of
§3.9.

**T2. Idempotent create (only if §11 Q6 is answered with choice 1).** `shared/rpc-features.ts`,
`server/features.ts`. Tests: a repeat with the same id returns the same card and writes nothing; a
repeat after the card's title was edited still returns it; an id of a card with another kind, an
agent creator or another `relatedTo` is refused; a malformed id is refused at the contract and in
the command; two concurrent calls with one id create one card; a non-UI origin ignores the field;
the MCP tool's schema still rejects it; a call without the field behaves as before.

**T3. Tab state v2.** `host-tab.ts`. Tests: v2 round trip with segment and operation; each row of
the migration table; rejected shapes; lenient optional fields; host and project mismatch; other
tab keys preserved; a v1 value rewritten as v2 on the next save; no write without a tab.

**T4. Home screen, stack and routes.** `home-screen.tsx`; `panel.tsx` operations, default stack,
read enabling (including plan screens), slash handling per §3.9, the operation banner. Tests:
default is Roadmap; the switcher replaces the root and keeps the filter; each view survives the
other's failed read; Back returns to the view a screen was opened from; the bare command resets;
an unknown argument navigates nowhere; repeated links into one session and cross-session return
behave as before; a plan opened with empty caches gets its header once the reads arrive.

**T5. Roadmap cards.** `roadmap-card.tsx`; `RoadmapScreen` owning its scroll container, with the
filter, card, More section, lifecycle strip with marks, new-card highlight, and the move controls.
Tests: filter and counts; `aria-checked`; one expanded card; every card action reachable from More
with unchanged calls and revisions; each strip state has its mark; reorder under a filter sends
the mapped full order; controls disabled while pending and at the edges.

**T6. Drag reorder, behind a gate.** The responder, scroll lock, cancel rules, optimistic order.
Tests with a recorded responder config: threshold and direction; release index; unmeasured rows
send nothing; terminate cancels; an order, revision or filter change cancels; scrolling is enabled
after every ending; a press right after a drag is ignored; no handlers without `PanResponder`.
**Gate**, in the sandbox on the real implementation: mouse and touch drags reorder correctly; on a
list already scrolled; a cancelled drag sends nothing; a breakpoint remount mid-drag leaves the
list scrollable; the list scrolls normally afterwards. A host where the gate fails ships without
the drag responder; the move controls remain and the gap is reported.

**T7. Stage-aware opening and stage surfaces.** Open intent, `hop` and `setTopSegment` in
`panel.tsx`; `stageDestination` on every strip; the Questions start panel and `onSegment` in
`feature-screen.tsx`; the session screen's notice, status line, picker message and
`Feature details`; `renderHeader` in `plan-view.tsx`; `useFeatureStage` taking plan position from
`plan.list`; `replacesChat` in `discussion-controls.tsx`. Tests: each target from a card press and
from `/roadmap feature`; the session strip's Plan pill opens the plan, not Tasks; waiting,
resolving and the 3 s fallback; no mutation is sent by opening; hops never lengthen the stack;
feature → plan from its Plans list → Tasks returns to the same feature entry; the segment last
selected is restored after a remount; the notice's five conditions, each negated in turn,
including an unread and a closed session; the status line when a planner exists; the picker
message while `creating`; **cache order**: the list has a current approval while `plan.get` is
loading, and the card and the screen agree; the two run caches at different revisions give
different results that are reported as a known transient, not asserted equal.

**T8. New feature form.** `FeatureForm` per §3.7 in both callers; `quiet` in `hooks.ts`;
`initialLanguage` and `preferredProfile`. Tests: the section and button matrix; one call per
press, at the list's revision even when another cached query is newer; a refusal keeps the text
and the next press is a new operation; a thrown call locks the form and `Retry` repeats the same
id; the card appearing in the list before the call answers starts step 2 once; a remount in
`creating`, `unknown`, `discussing` and `recovery` shows the right banner and never starts step 2;
a late answer after `Discard` navigates nowhere; step 2 at the returned revision with the chosen
profile and language; one quiet retry on conflict; every other failure reaches `recovery`, where
no create can be sent; the return stack of each caller; edit mode still pins its revision.

**T9. End-to-end.** Update `openPlugin` and `openSession`, then add journeys (fixtures titled
`[e2e] <run id> …`, deleted through the UI at the end):

- j10 wide: opens on Roadmap; switch to Sessions and back; a resize across the compact breakpoint
  keeps the view, the filter and a feature screen's selected segment; New session still works.
- j11 wide: `Create`; the card appears last; pressing it opens the Questions start panel; the
  safety check counts no new agent; More → Edit, Dependencies, Delete; keyboard-only reorder.
- j12 compact 390×844, touch: switcher; a bug has no `Create & discuss`; filter Bugs; handle tap →
  `Move up`; touch drag (T6 gate); the session notice open leaves at least 320 px of question
  canvas; the order is read back through `feature.list` and after a reload.
- j13 wide: mouse drag under the Features filter with a bug between two features (T6 gate).
- j14: `Create & discuss` with no usable profile is disabled with its message; its success path
  runs only if T0 found an inert-provider profile within the safety limits.
- Regression: j1–j9 on the new helpers.

**T10. Documentation.** `OVERVIEW.md` (opening and `/roadmap`, "Roadmap and features", "Feature
discussion", "Feature screen"), `docs/SPEC.md`, `docs/STATUS.md`.

**T11. Review and host verification (evidence, not a test task).** Routine independent review;
KensAI on the exact final commit; then, only under a separate owner authorisation to install or
reload that exact commit, the criteria of §8 in the real host.

Order: T0 → T1 → T2 → T3 → T4 → T5 → T6 → T7 → T8 → T9 with T10 → T11.

## 7. Validation gates

1. Per task: focused tests, `npm run typecheck`, `npm run lint`.
2. Before review: `npm test`, `npm run test:e2e-guards`.
3. E2E: `node e2e/run.mjs --rev <final 40-hex>` on a sandbox already running that revision.
4. Review, installation and live UI verification are three further, separate states.

A journey that is skipped, with whatever reason, satisfies no criterion. A criterion whose only
intended evidence was not produced is reported "not verified". The component tests run without a
reconciler, layout or native host; they prove calls, props and state, never rendering.

## 8. Acceptance criteria

Evidence: **U** unit or component test, **E** sandbox journey, **H** real-host check under T11.

1. A fresh panel opens on Roadmap; Sessions is one press away on wide and compact. (U, E j10)
2. Session rows, links, plans and New session work from the Sessions view as before. (U, E)
3. The root view, the filter, the stack and a feature screen's selected segment survive a compact
   ↔ wide remount. (U, E j10)
4. v1 tab states migrate per §3.8. (U)
5. `Create` adds exactly one card, last in the list, and opens nothing. (U, E j11)
6. `Create & discuss` with a usable profile adds one card, creates one chat and shows the session
   with Back to its caller. (U; E j14 only if T0 allows; otherwise H)
7. When step 2 fails, the recovery panel names the created feature and offers no control that
   creates a card; the same recovery is on the card afterwards. (U)
8. A double press, a refused call then a retry, a lost answer then a retry, a lost answer followed
   by an edit of the card's text elsewhere, and a remount during any phase each leave exactly one
   card. (U, server tests of T2)
9. A bug offers `Create` only and says why. (U, E j12)
10. Without a default profile `Create & discuss` waits for a choice; with no saved profiles it
    stays disabled and `Create` works. (U, E j14)
11. A card press opens the surface of §3.5 for each case. (U; Questions cases E j11; Plan, Tasks
    and Execution H)
12. Opening a feature sends no mutation and creates no chat or session. (U, E j11)
13. A pending stage read makes the press wait, then open the right surface; a failed read opens
    the feature screen. (U)
14. Every strip opens the pressed stage's own surface; Plan never opens Tasks. (U, H)
15. Stage hops never lengthen the stack; pushed entries are never merged or dropped. (U)
16. Card management is reachable from the card and the feature screen; `Feature details` is on the
    session and plan screens of a feature, including a plan opened from Sessions. (U, H)
17. Each move control and each drag sends one `feature.reorder` with a full permutation; hidden
    items keep their relative order. (U, E j12, j13)
18. Every reorder is possible by keyboard and screen reader without drag. (U, E j11)
19. A drag that is cancelled sends nothing and the list scrolls afterwards. (U, E T6 gate)
20. `/roadmap` behaves per §3.9, including no navigation for unknown arguments. (U)
21. The Discuss notice appears only under its five conditions and never hides the question canvas
    on a phone. (U, E j12)
22. Controls are at least 44×44 px; tabs and radios work by keyboard; no state is conveyed by
    colour alone; themes use theme colours only. (U, E, H)
23. The plugin loads and the above holds on a 0.15 and a 0.16 host; without a `tab` prop nothing
    persists and nothing fails. (H)

## 9. Delivery states and what is not claimed

Validation, review, installation and live UI verification are distinct and reported separately.
Not claimed:

- Drag on native devices, and drag on any host where the T6 gate was not run.
- The end-to-end success path of `Create & discuss`, unless T0 allows it in the sandbox.
- Plan, Tasks and Execution targets end to end (the harness cannot seed plans and runs).
- That a discussion chat never replaces a planner already bound to the session (§3.6).
- That the card and a screen show the same stage at every instant (§3.5).
- Recovery of an unresolved create after a remount on a host without tab state (§3.7.3).
- Persistence of form text across a remount.
- Any behaviour of a bug discussion.

## 10. Stress test: risks and corrections

Ranked by damage times likelihood. "Verified" refers to §2; the rest is hypothesis.

1. **A duplicate card.** Verified: a fresh id per successful create; a thrown call re-reads
   nothing; the default revision is the highest of any cached query. Correction: client-chosen id
   honoured by the server (§4), the explicit list revision on every create, the reducer (§3.7.2),
   the persisted operation (§3.7.3). Residual: a host without tab state after a remount.
2. **Wrong card adopted, and a chat started on it.** Verified possible with draft 1's fingerprint
   matching. Correction: identity by id only; no matching on text.
3. **Navigation that spends a model call.** Correction: opening is navigation only; step 2 never
   runs after a remount; the single automatic retry cannot create a second agent.
4. **A discussion chat replacing a chosen planner.** Verified: `discussionBind` rebinds without
   looking at an intervening choice, and the card's controls never look at the planner. This is
   shipped behaviour that this slice makes more prominent. Correction: presentation rules and the
   warning (§3.6); the claim withdrawn (§9); a server guard left to the owner (§11 note).
5. **Drag unproven.** Verified: no production use; the local React Native sources document that a
   contained responder cannot reliably block a scroll view. Correction: the T6 gate with real
   gestures, cancel rules, one coordinate system; the move controls are complete without drag.
6. **Wrong surface from stale or missing reads.** Verified: an unknown plan list reads as "no
   plan". Correction: `wait` and failed rows; position from list-level facts on both sides; the
   cache-order tests.
7. **The session strip's Plan pill opens Tasks.** Verified today. Correction: `stageDestination`
   on every strip.
8. **Navigation history lost or entries wrongly merged.** Correction: the two-rule hop; no merging
   of pushed entries; unknown arguments no longer navigate; the deliberate reset is in §11.
9. **Every E2E journey depends on the old root.** Verified. Correction: T9 updates the helpers
   first and reruns j1–j9.
10. **Conflicts between the two steps in a busy project.** Verified: the revision is project-wide.
    Correction: one quiet retry, then recovery.
11. **Existing tabs after the upgrade.** Correction: the migration table; downgrade behaviour
    stated.
12. **A plan opened directly has no feature context.** Verified: no `feature.list` on plan
    screens. Correction: the reads and `renderHeader` of §3.6.
13. **A client-chosen id used as a file name.** Correction: the strict pattern at the contract and
    in the command; UI origin only.
14. **A card stuck in `creating`.** Verified: delete is refused meanwhile. Correction: the card's
    discussion line and the server's message say so.
15. **Card density and the notice on a 390 px screen.** Correction: two-line description, actions
    behind More, the bounded notice; checked in j12.

## 11. Unresolved owner decisions

Each has a recommended default. None is approved by this document or by silence. The design is
drawn with the recommended choices; another answer changes the named sections only.

❓ **Q1 — The main screen on wide layouts**

A1 fixes a switcher on compact and leaves wide to the design. The plugin learns only whether the
layout is compact, not the panel's width, and a wide panel can be barely over 600 px.

1. The same Roadmap | Sessions switcher on wide and compact (recommended)
2. Wide shows two columns, the Roadmap list and a narrower Sessions column; compact uses the switcher
3. Wide shows the Roadmap with Sessions as a collapsible section beneath the list; compact uses the switcher
4. Wide shows the Roadmap with a right rail holding Sessions and the start delegations, as the preview's dashboard did

➡️ Choice 1. One control means one stored root view that maps to itself across a breakpoint
remount, and the cards keep their width on a narrow wide panel. Choices 2–4 show more at once on a
large window but need a second layout whose minimum width the plugin cannot measure.

---

❓ **Q2 — `Create & discuss` and bugs**

Verified: the server refuses a discussion chat for a bug and the card offers a bug no Discuss. The
approved design makes bug grilling optional, but no bug discussion flow has been designed.

1. A bug is created with `Create` only; no discussion in this slice (recommended)
2. Allow a discussion chat for bugs everywhere: the form's `Create & discuss` and the card's Discuss
3. Keep the form `Create`-only for bugs, but allow Discuss from a bug's card
4. For a bug, `Create & discuss` creates the bug and opens a plain question session without a chat

➡️ Choice 1. It matches what is shipped. Choices 2 and 3 change the discussion commands and need
a bug-specific prompt nobody has specified; choice 4 invents a session a bug does not otherwise
get.

---

❓ **Q3 — Pressing a Questions-stage feature that has no discussion yet**

Without a discussion there is no session to show. Starting a chat creates an agent and sends it a
prompt.

1. Open a Questions start panel with Discuss, Discuss with… and the language; nothing is created until the owner presses (recommended)
2. Start the discussion at once with the default profile and open the session
3. Open the feature's details, with Discuss among its actions
4. Expand the card in place with the Discuss controls, without leaving the list

➡️ Choice 1. The press lands on the Questions stage as A3 asks, and a chat is created only by a
button that says so. Choice 2 makes plain navigation spend a model call.

---

❓ **Q4 — What `/roadmap feature <id or title>` opens**

Today it opens the feature's detail screen. A3 covers a card press only.

1. The feature's current stage, the same as pressing its card (recommended)
2. Always the feature's detail screen, as today
3. The Roadmap list with that card highlighted, opening nothing
4. The current stage for a feature in Questions, the detail screen otherwise

➡️ Choice 1. One rule for "open this feature" is easier to predict and to test.

Related planner choice, stated so it can be vetoed here: the bare `/roadmap` resets the panel to
the Roadmap root, dropping the screens that were open above it, because the roadmap is now the
root and cannot be pushed. A mistyped argument no longer triggers this (§3.9).

---

❓ **Q5 — Which filters the Roadmap list has**

The brief asks for filter chips as in the preview, which filtered by type. The approved design
says no filtering of done features is inferred.

1. Type only: All, Features, Bugs (recommended)
2. Type chips plus a "Hide done and cancelled" toggle
3. No filter in this slice
4. Type chips plus status chips for the six statuses

➡️ Choice 1. It hides nothing by status, which stays inside the approved design.

---

❓ **Q6 — How "a retry never creates a second card" is guaranteed** (new in revision 2)

A2 requires it. Verified: the server creates a card with a new id on every successful call, so
after a lost answer nothing identifies the owner's card except its text, which another writer may
change and which another person's card may share. The brief preferred no server change unless a
concrete gap exists; this is one.

1. The client chooses the feature's id and `feature.create` returns the existing card for a repeated id: one optional input field, no stored-data change (recommended)
2. No server change: after an unanswered call the form lists new cards that might be the owner's, and a card is created again only when the owner confirms none of them is theirs
3. A stored request id on each feature, checked by the server on every create
4. No retry at all after an unanswered call: the form closes and the owner checks the roadmap

➡️ Choice 1. It makes identity exact with the smallest change: about one read and one branch on
the server, nothing stored, agents unaffected. Choice 2 keeps the server untouched but replaces
the guarantee with the owner's judgement at the worst moment, and cannot be honest about "never":
a mistaken confirmation still duplicates. Choice 3 gives the same guarantee as choice 1 but adds a
field to a strict stored schema that older installed revisions would reject. Choice 4 is the
cheapest and gives up recovery altogether. Choosing 2 or 4 replaces §3.7.1–§3.7.3 and removes T2;
the guarantee in §0 A2 would then be narrowed to "no automatic duplicate", which is itself the
owner's call.

**For the owner's information, not a blocking question.** Discuss binds its chat to the feature's
session through the planner rebind path, so it replaces a chat that was bound to that session by
hand (the earlier chat stays in the session's history). That is shipped behaviour from the
discussion slice; this slice only makes it visible (§3.6). A server rule that refuses Discuss when
the session already has a chat, or refuses a manual bind while a discussion chat is being created,
would be a change to that slice and is not planned here.

**Planner decisions inside the design remit** (settled by approving this plan, each cheap to
change): management behind an inline More section; `Move to top` and `Move to bottom`; the hop
rule; `[overview]` migrating to Roadmap; the form replacing its caller's content while open;
feature sessions staying listed under Sessions; the current segment, not the entry segment,
restored after a remount; the removal form offering both buttons; unknown `/roadmap` arguments
giving a notice.

## 12. Consultation

One bounded Astra advisory pass on draft 1 is complete (§13). No further pass is requested for
this revision; Astra holds no approval gate.

## 13. Astra consultation dispositions

Astra's report was advisory, on draft 1, baseline `636bd48`. Every cited line was re-read at that
commit before the disposition was written.

| # | Astra's point | Verified at `636bd48` | Disposition |
| --- | --- | --- | --- |
| 1 | The exactly-once argument is unsound: the server guarantees one write per revision, not one card per attempt. | True. `store.ts:408-446`; a fresh id per call, `features.ts:191`. | **Accepted.** Draft 1 §3.7's argument and §4's rejection of operation identity are withdrawn. |
| 1a | Mixed cache revisions: the hook's default revision is the maximum over all cached queries, so a retry can commit beside a late first request. | True. `hooks.ts:213-222`, `:251`. Draft 1's explicit list revision avoided this sequence but did not make it a rule. | **Accepted.** The list's own revision is mandatory on every create (§3.7.2, T8 test). |
| 1b | Edited card: a title or description change before reconciliation defeats the fingerprint. | True. `features.ts:209-224`. | **Accepted.** Text is no longer used for identity (§3.7.1). |
| 1c | Remount: the attempt is component-local and the host remounts on a breakpoint. | True. `roadmap-screen.tsx:210-217`, `host-tab.ts:1-8`. | **Accepted.** The operation is kept in the tab state (§3.7.3, §3.8). Residual on hosts without `tab`, stated in §9. |
| 1d | False adoption can start a chat on another person's card; `relatedTo` was missing from the fingerprint. | True; `relatedTo` is set at creation only (`rpc-features.ts:34-35`). | **Accepted.** No adoption by fingerprint. The server's repeat check compares kind, creator and `relatedTo` (§4). |
| 1e | Suggested: reopen durable identity, or keep attempts unresolved and forbid automatic recreation. | — | **Refined.** Durable identity through a client-chosen id, not a stored field (§4). Whether to change the server at all is a scope decision and goes to the owner as §11 Q6, with Astra's client-only alternative as choice 2. The plan is drawn with choice 1 and marks T2 conditional. |
| 2 | Define a state machine; `onError` runs before the re-read, a failed re-read is swallowed, and a list update can precede the call's answer. | True. `hooks.ts:268-270`, `:277-279`. | **Accepted.** §3.7.2: one reducer, the listed states, the operation record, convergence of list observation and answer, late answers. |
| 2a | Say what counts as a successful reconciliation read. | — | **Refined.** With an idempotent create a retry is safe without any read, so no read gates it; the list is a second way to learn the outcome. Under Q6 choice 2 this gate would be required and is named there. |
| 2b | Separate unresolved-operation state from draft text. | — | **Accepted.** §3.7.3. |
| 3 | The Discuss notice is presentation, not protection; `discussionBind` replaces a planner chosen after the reservation; the card's controls ignore the planner. | True. `sessions.ts:1068-1084`, `:1127-1151`, `:529-539`; `discussion.ts:298-308`; `discussion-controls.tsx:20-23`. | **Accepted.** The guarantee is withdrawn (§3.6, §9). |
| 3a | Use `feature.discussion?.state`. | True (`model.ts:755-774`). Draft 1 named no field. | **Accepted**; named in §3.6. |
| 3b | Require a loaded session; distinguish closed and block-less sessions. | True. `grilling-header.ts:118-132`. | **Accepted.** The five conditions of §3.6; a status line without controls otherwise. |
| 3c | Coordinate the picker and Discuss locally; either add a server guard or withdraw the claim. | — | **Refined.** Local coordination: the picker message while `creating`, the `replacesChat` warning, the status line. No server guard: rebinding is the discussion slice's approved behaviour, so changing it is the owner's decision; it is reported in the §11 note, not planned. |
| 4 | Changing push to replace would still make the session strip's Plan pill open Tasks. | True. `panel.tsx:315-317`, `feature-screen.tsx:218`. | **Accepted.** `stageDestination` on every strip (§3.1). |
| 4a | Deduplicating by kind and id can drop a session target or a requested segment. | True for draft 1's wording; session targets come from props at mount (`panel.tsx:193-194`, `:566`). | **Accepted.** The duplicate-dropping rule is replaced by the two-rule hop; pushed entries are never merged (§3.1). |
| 4b | The reset destroys Back history, and unknown arguments map to the roadmap route. | True. `slash.ts:29-42`. | **Accepted and extended.** An `unknown` route that does not navigate (§3.9); the deliberate reset stays and is stated under §11 Q4. Draft 1's "unchanged" is corrected. |
| 4c | Question routes remain compatible. | True. `panel.tsx:481-501`, `:570-574`; `timeline-card.tsx:39`. | **Noted**; kept unchanged. |
| 5 | List-level derivation is valid for equal snapshots; "cannot disagree" is too strong. | True: same `approvalOf` (`plans.ts:327-333`, `:370`, `:402`), one `run.list` (`runs.ts:959-969`), separate cache keys (`hooks.ts:194`, `:318`, `:328`). | **Accepted.** The promise is restated (§3.5, §9). |
| 5a | Separate position inputs from completion provenance; `finishedByOwner` stays required. | True. `stage-strip.ts:23`; `views.ts:25-40`. | **Accepted.** `stagePosition` (§3.5). |
| 5b | Define loading, stale and error precedence; add cache-order tests. | — | **Accepted and extended.** The precedence rule; the screens' strip takes plan position from `plan.list`, which removes Astra's concrete example; run caches stay separate and that transient is stated (§3.5, T7). |
| 6 | Capture-phase `PanResponder` with a scroll lock is a candidate, not proof; the lock must reach the real container. | True: the container is the panel's (`panel.tsx:606-623`); the cited React Native comments exist in the local 0.81.5 sources (`ScrollView.js:704-705`, `:1394-1395`; `PanResponder.js:540-548`), which are a development dependency, not the host's runtime. | **Accepted.** The Roadmap view owns its scroll container; cancel rules; one coordinate system (§3.4). |
| 6a | T0 should exercise a real gesture. | — | **Refined.** A gesture needs plugin code loaded in a host, so the proof is T6's gate on the real implementation, placed before the stage and form work; T0 records whether an earlier throwaway run is possible. The cases Astra lists are the gate's cases. |
| 7a | Preserve host, project and unrelated tab keys in the migration. | True. `host-tab.ts:57-76`. | **Accepted**; stated in §3.8, tested in T3. |
| 7b | Entry segment versus current segment. | True. `feature-screen.tsx:218`, `:487-494`. | **Accepted.** The current segment is restored (§3.1, §3.6). |
| 7c | The removal form has two callers; the feature screen's has no discussion context; return stacks undefined. | True. `roadmap-screen.tsx:537-555`, `feature-screen.tsx:246-266`. | **Accepted.** The caller table of §3.7. |
| 7d | A plan opened directly has no feature list. | True. `panel.tsx:472`, `plan-view.tsx:133-137`. | **Accepted.** `renderHeader` and the reads of §3.6. |
| 8a | Add the listed race and remount cases to the tests. | — | **Accepted.** T1, T2, T7, T8. |
| 8b | Keyboard navigation for tabs and radios; `aria-checked`. | — | **Accepted.** §3.2, §3.3. |
| 8c | Complete and open lifecycle bars differ mainly by colour. | True of draft 1. | **Accepted.** Marks per state (§3.3). |
| 8d | The notice must not consume the phone's question viewport. | The picker's bound: `panel.tsx:320-322`. | **Accepted.** Bounded region and a j12 check (§3.6, T9). |
| 8e | A skipped journey is not satisfied acceptance. | — | **Accepted.** §7; evidence level per criterion in §8; gaps in §9. |

Nothing in Astra's report was rejected outright. Three points were refined against its suggested
form (1e, 3c, 6a), each for the reason given.
