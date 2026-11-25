# Roadmap home, feature creation and stage-aware opening: design and implementation plan (draft 1)

Status: DRAFT 1, written 2026-11-14 by the planner. Not approved. Nothing here authorises
implementation, installation, reload, publication or a daemon change. The owner approves an exact
revision of this plan before any production code is written. One bounded Astra consultation on
this draft is pending (§12); its dispositions go into revision 2 together with a diff against this
draft.

Baseline for every code reference: worktree `.worktrees/paseo-016-chat-live`, commit `636bd48`
(branch `feature/paseo-016-chat-live`, which contains `feature/feature-discussion-questions` at
`d3dffde`). All reads were read-only. UI reference: branch `preview/html-mock-20261105` at
`36dc836` (client-only mock; a visual reference, never a production baseline).

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
bound discussion chat per feature, reservation protocol, unresolved creations retried only on the
owner's explicit confirmation; its §9 kept the top-level Sessions overview "until a navigation
slice removes it" — A1 keeps Sessions reachable, so nothing is removed here. The four-stage strip
(`2026-11-09-discussion-template-r7-plan-r4.md` §2.2). `AGENTS.md`: React Native primitives only
(no DOM, SVG or new client dependencies), compact and themed layouts stay usable, no daemon
restart, synthetic fixtures only.

**What this plan decides.** Layout, navigation, persistence and recovery mechanics (§3). Product
choices the relayed decisions do not settle are listed in §11 with a recommended default each;
none is treated as approved.

## 1. Goal and scope

Make the Roadmap the panel's home, make creating a feature and starting its discussion one flow,
and make a card press land on the surface where the feature's work currently is.

In scope: the panel's root screen and screen stack; `client/host-tab.ts` persistence; `/roadmap`
routing; the roadmap list (cards, type filter, reorder by drag handle with accessible controls);
the New feature form with `Create` and `Create & discuss`; stage-aware opening; the small changes
the Questions, Plan and Feature screens need so every stage surface is reachable and leads back.

Out of scope: any server or RPC contract change (§4); a discussion chat for bugs (§11 Q2); tracker
links on cards; a project picker; the preview's Running rail; plan, task and execution screen
redesign; translation.

## 2. Verified baseline (read-only, `636bd48`)

| Item | Evidence |
| --- | --- |
| Screen stack | `client/panel.tsx:60-65` `Screen = overview \| roadmap \| feature \| plan \| session`; initial stack `restoreStack(...) ?? [{ kind: "overview" }]` (`:449`); `push` / `back` (`:455-462`); only the top screen renders, keyed by `${stack.length}:${kind}` (`:558`). |
| Root screen | `OverviewScreen` (`panel.tsx:90-165`): the Sessions list, links, `PlansList`, a `Roadmap` button and `New session` (`:117-121`). The roadmap is one push away (`:667`). |
| Roadmap screen | `RoadmapScreen` (`client/roadmap-screen.tsx:517-644`): a `Back` button, heading, `New feature` (`:577-581`), `DelegationsStrip`, then one card per feature with title, status chip, kind, progress text, `Move up` / `Move down` buttons (`:614-619`), every action button (`featureActionButtons`, `:336-418`) and `DiscussionControls` (`:626-638`). It reads `useProjectRuns` and `usePlanList` (`:534-535`). The panel wraps it in a `ScrollView` (`panel.tsx:606-623`). |
| Feature form | `FeatureForm` (`roadmap-screen.tsx:198-280`): title, description, Feature / Bug choice at creation (`:260-264`), one `Create feature` button. It pins the store revision when it opens (`:213`) and sends it as `expectedRevision` (`:222-225`), so after a `revision_conflict` every retry repeats the stale revision. It replaces the whole roadmap screen while open (`:557-572`). |
| Discuss | `DiscussionControls` (`client/discussion-controls.tsx:58-152`): `discussAvailability` is null for bugs and for done or cancelled features, `open` once bound, else `discuss` (`:20-23`); one `feature.discussion.open` call per press (`:83-99`); language row only with configured languages (`:117-124`); without a default profile the profile choice opens (`:131`, `:135-149`); an unresolved creation is retried only through the explicit confirmation button (`:109-116`). |
| Discuss server | `openDiscussion` (`server/discussion.ts:137-276`): refuses a revision other than the store's (`:142`) and a bug (`:145`; also `server/sessions.ts:555-560`); returns the bound chat without creating (`:149-157`); refuses while a reservation is younger than 60 s (`:179-181`); commits the reservation, creating the feature's session when absent, before the agent (`:228-246`, `sessions.ts:1085-1113`); creates the agent with `idempotencyKey = reservationId` (`:252-259`); binds with its own conflict retries (`:298-308`); then sends the prompt (`:317-327`). |
| Feature RPCs | `feature.create` takes `title, description, kind, dependsOn?, relatedTo?` plus `expectedRevision` and returns `featureId, revision` (`shared/rpc-features.ts:27-38`; `server/features.ts:185-207`); it has no idempotency key. `feature.reorder` takes a full permutation and is UI only (`rpc-features.ts:44-48`; `features.ts:226-239`). `feature.delete` is refused while the discussion is `creating` (`features.ts:257-259`). |
| Feature model | `shared/model.ts:728` six statuses; `:755-774` `DiscussionBinding` = creating \| failed \| unresolved \| bound; `:775-818` `Feature` with `grillSessionId?`, `discussion?`. A feature's session is also created by the first plan draft (`server/plans.ts:215`), never for a bug. |
| Stage model | `client/stage-strip.ts:45-138` `stageModel`: `current` is null for done, deferred and cancelled, else execution (status executing or a live run), tasks (single bound plan with current approval), plan (any bound plan), questions (`:59-68`). `useFeatureStage` (`client/stage-strip-view.tsx:36-79`) feeds it from `plan.list`, `plan.get`, the feature's `run.list` and `session.get`. |
| Stage surfaces | Session screen shows the strip for a feature's session and sends every other stage to the feature screen (`panel.tsx:307-319`, `:562`, `:584`). Feature screen strip (`client/feature-screen.tsx:465-483`): Questions is unavailable without a session (`:472`); Plan opens the single bound plan, else the Plan segment; Tasks and Execution select the Tasks segment. `PlanView` has no strip (`client/plan-view.tsx:133`). |
| List-level data | `plan.list` summaries carry `featureId`, `latestRev` and `approval` computed by the same `approvalOf` as `plan.get` (`shared/rpc.ts:320-328`; `server/plans.ts:365-380`). `roadmap.overview` lists every session with its status (`shared/rpc.ts:180-185`). |
| Tab persistence | `client/host-tab.ts`: key `decisionRoadmap`, `VERSION = 1` (`:9-10`); `StoredScreen` (`:29`); `restoreStack` rejects a stack whose first entry is not `overview` (`:63`); `saveStack` writes only this key (`:68-76`). The host's `tab` prop is read defensively and is optional (`:17-26`). The panel saves on every stack change (`panel.tsx:452`). |
| Slash routing | `client/slash.ts:29-42`: `""`, `features`, `runs` → roadmap; `feature <id or title>`; `question <link \| Q<n>>`. The route is a one-shot pending value per workspace with a 30 s lifetime (`:45-66`). The panel pushes `roadmap` for the bare route (`panel.tsx:476-480`), pushes the feature screen for a resolved query (`:511-513`) and falls back to the roadmap with a notice (`:514-517`). |
| Mutations | `useRoadmapMutation` (`client/hooks.ts:235-288`): toasts every refusal, re-reads on `revision_conflict` and on every refusal of `feature.discussion.open` (`:305-312`), and re-reads nothing when the call itself throws (`onCallError`). |
| Settings | `roadmapSettings.discussionProfile`, `discussionLanguages` (`shared/settings.ts:60`, `:67`); the panel treats unread settings as no default profile and English only (`panel.tsx:445-448`). Profiles come from the host config (`hooks.ts:360-370`). |
| Preview reference | `client/preview/pages/dashboard.tsx` at `36dc836`: `ChoiceChips` type filter (`:27-32`, `:403-410`), `DragHandle` with `PanResponder`, accessibility actions and a press that shows `Move up` / `Move down` (`:49-121`, `:271-292`), card with a labelled open button and progress strips (`:230-308`), `dropIndex` and `reorderVisible` (`client/preview/store.ts:257-279`), `LifecycleStrip` (`client/preview/progress-view.tsx:8-31`). |
| Not verified | `PanResponder` is not used anywhere in production code; the preview used it, and no record shows it exercised on a native device or on both hosts. The sandbox's saved agent profiles are unknown. Both are settled in task T0. |
| E2E coupling | `e2e/lib/ui.mjs:23` and `e2e/run.mjs:808` wait for `Sessions` or `‹ Back`; `openSession` (`ui.mjs:27-45`) and j1 (`run.mjs:307-308`) press Back to the root and expect session rows and `New session` there. The sandbox safety check allows zero agents, or only its inert fixture (`e2e/lib/sandbox.mjs:67-74`). |

## 3. Design

### 3.1 Screen model

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

Invariant: the stack has exactly one `home` entry and it is `stack[0]`. The `overview` and
`roadmap` kinds are removed. The initial stack is `[{ kind: "home", view: "roadmap", filter: "all" }]`.

Stack operations in `ProjectRoadmap`:

- `push(next)`, `back()` as today.
- `setRoot(patch)`: replaces `stack[0]` in place (switcher, filter). Only the home screen calls it.
- `replaceTop(next)`: replaces the top entry; if the entry beneath is then the same screen (same
  kind and id), the duplicate is dropped. Never applied to `stack[0]`.
- `resetTo(view)`: the stack becomes `[home]` with that view, the filter kept.

Push versus replace:

| Navigation | Operation |
| --- | --- |
| Card press, session row, plan row, `/roadmap feature`, question links, cross-session references, dependency and related links, a plan from the feature's Plans or Changes lists | push |
| Stage strip pill, and `Feature details`, between surfaces of the same feature | replaceTop |
| Discussion started from the Questions start panel (§3.6) | replaceTop with the session |
| Bare `/roadmap` | resetTo("roadmap") |

Reason for replace: with A3 a card press lands on a stage surface, and stage hops would otherwise
grow the stack (session → feature → session …, which today's push does). With replace, Back from
any stage surface of a feature returns to where the feature was opened from.

### 3.2 Home screen and the Roadmap | Sessions switcher (A1)

The home screen has a header and one of two views. The switcher is the same control on wide and
compact layouts (see §11 Q1 for the alternative).

```
Wide                                                    Compact
[ Roadmap | Sessions ]            [+ New feature]       [   Roadmap   |   Sessions   ]
Show (All)(Features)(Bugs)              7 items         Show (All)(Features)(Bugs)
<cards>                                                 7 items          [+ New feature]
                                                        <cards>
```

- **Switcher.** A row with `accessibilityRole="tablist"` and label "Roadmap views"; two
  `Pressable` segments with `accessibilityRole="tab"`, `accessibilityState={{ selected }}` and, for
  the web, `aria-selected` through the existing `webAria` helper (`client/discussion-ui.tsx:39`).
  Each segment is at least 44 px high; on compact the two share the full width equally; on wide
  each is at least 120 px wide and the row is left-aligned. The selected segment has the
  `surface2` background, semibold text and a 2 px bottom bar in `accent`; the state is never shown
  by colour alone. Pressing a segment calls `setRoot({ view })`.
- **Actions.** Roadmap view: `+ New feature` (primary). Sessions view: `New session` (primary).
  Wide: on the switcher's row, right-aligned. Compact: on the row under the filter, right-aligned.
- **No Back** on the home screen: it is the root.
- **Roadmap view** (§3.3). Reads `feature.list`, `plan.list`, project `run.list` and
  `roadmap.overview`: four project-level reads whatever the number of cards.
- **Sessions view.** The body of today's `OverviewScreen` unchanged (session rows with counts,
  links, `PlansList`, the New session dialog), without its heading row and without the `Roadmap`
  button. A feature's session keeps its `[feature] <title>` title and stays listed.
- **Loading and failure.** Each view shows its own read state: `Loading…`, or the error text. A
  failed `feature.list` never hides the switcher, so Sessions stays reachable, and the reverse.
- The store states `missing` and `invalid` render as today, above any home screen.

### 3.3 Roadmap view: filter, cards, card actions

**Type filter.** A `radiogroup` labelled "Show" with chips `All`, `Features`, `Bugs`
(`accessibilityRole="radio"`, `checked`), 44 px high. It filters by `feature.kind` on the client
only. Beside it: `7 items`, or `3 of 7 items` under a filter. An empty result shows "No items of
this type." The filter is part of the home entry, so it survives a remount. Creating an item whose
kind the filter hides switches the filter to `All`.

**Card.** One bordered card per visible feature, in roadmap order:

```
┌──────────────────────────────────────────────────────────────┐
│ [Feature] [Planned]                                 [⋯] [⠿]  │
│ Title (semibold, wraps)                                       │
│ Description (muted, at most 2 lines)                          │
│ ▬▬▬▬ ▬▬▬▬ ▬▬▬▬ ▬▬▬▬                                            │
│ Questions  Plan  Tasks  Execution                             │
│ Running · 3/7 verified                (only when a run exists)│
│ Depends on: A, B        Discussion chat: outcome unknown      │
└──────────────────────────────────────────────────────────────┘
```

- **Open area.** The kind tag, status chip, title and description are one `Pressable`
  (`accessibilityRole="button"`, label `Open <title>. <stage sentence>`, minimum height 44 px).
  The strip and progress lines sit in a second pressable hidden from accessibility, as in the
  preview (`dashboard.tsx:250-264`), so a press anywhere on the body opens the feature while a
  screen reader meets one button. Both call `openFeature(id)` (§3.5).
- **Status chip.** The existing six-status chip (`featureStatusChip`). No built / not built
  marker, no seventh status.
- **Lifecycle strip.** Four equal segments with their names below: a 4 px bar in `statusSuccess`
  when complete, `accent` when current, `border` when open, and a dashed outline when unknown; the
  current name is semibold. It is not interactive. Its accessibility sentence is
  "Stage: Plan, 2 of 4", "Stage: finished", "Stage: none (deferred)" or "Stage: unknown". It
  renders the same `stageModel` as the screens' strip, fed from list-level reads (§3.5), so the
  card and the screens cannot disagree about the current stage. Stage detail text is not shown on
  the card.
- **Progress.** The existing `progressText` line (`roadmap-screen.tsx:482-487`) only when a run
  exists, with a 4 px two-tone bar of verified over total. "Not started" is no longer printed:
  the strip says it. The `delegated` / `delegated · unauthorised` line stays.
- **Secondary lines.** `Depends on: …`, the status reason, and a one-line discussion state for
  `creating`, `unresolved` and `failed` (short forms of `discussionStatusText`).
- **More (`⋯`).** A 44×44 icon button, label `More actions for <title>`, `expanded` state. It
  expands an inline section under the body (no floating menu, so nothing depends on overlay
  layering inside a scroll view): `Details` (opens the feature screen whatever the stage), then
  `featureActionButtons` without `open` (Edit, Dependencies with its picker, Defer or Resume,
  Cancel and Delete with their confirming press, Create removal feature), then
  `DiscussionControls` when its availability is `discuss`. One card is expanded at a time.
- **Reorder handle (`⠿`).** §3.4.
- **New card.** After `Create` the list scrolls to its end and the new card has an `accent`
  border until the next interaction.

`DelegationsStrip` stays above the list. Card actions keep sending `expectedRevision` of the
rendered snapshot (`useFeatureActions`, unchanged).

### 3.4 Reorder: drag handle, accessible controls, filter

**Handle.** A 44×44 `Pressable` (`accessibilityRole="button"`, label
`Reorder <title>, position 2 of 5`, hint "Drag to move. Activate to show move controls.",
`expanded` state, accessibility actions `moveUp` and `moveDown` for native screen readers),
wrapped in a `View` that carries the `PanResponder` handlers, as in `dashboard.tsx:49-121`.

**Drag.** The responder claims the gesture in the capture phase once vertical travel exceeds 4 px
and dominates horizontal travel, refuses termination, and on the web the wrapper has
`touchAction: "none"`. While dragging: the card follows with `translateY`, raised `zIndex` and an
`accent` border; the list's `ScrollView` has `scrollEnabled={false}`; card presses are ignored; a
press within 400 ms of release is not a handle press. On release the drop index is `dropIndex`
over the measured `onLayout` rows of the visible cards; nothing is sent until every visible card
has been measured or when the index is unchanged. There is no auto-scroll at the list's edges:
longer moves use the controls below.

**Move controls.** Pressing the handle (tap, click, Enter, Space) shows a row under the card:
`Moving · position 2 of 5`, then `Move to top`, `Move up`, `Move down`, `Move to bottom`, `Done`.
Each is a 44 px button labelled with the feature's title (`Move <title> up`), disabled at its
edge. This row is the keyboard, web screen-reader and no-drag path and exists whether or not drag
works. If `PanResponder.create` is not a function on the host, the handle has no drag and
everything else works.

**Filter.** `feature.reorder` needs the full order. Under a filter a move is expressed in the
visible list and mapped by `reorderVisible(order, visibleIds, id, toIndex)`: the item is removed
from the full order and inserted immediately before the visible item it lands on when moving up,
immediately after it when moving down. Hidden items keep their relative order; a one-place move
may therefore pass several hidden items, and the position text says `position 2 of 3 shown`.

**Sending.** One `feature.reorder` per drop or control press with the rendered `revision`; the
handles and move controls are disabled while any card mutation is pending. The list shows the new
order optimistically until the store revision changes or the call fails; on failure it returns to
the stored order with the usual toast. Nothing is retried.

### 3.5 Opening a feature at its current stage (A3)

**One model.** `cardStage(feature, reads)` adapts the list-level reads to `StageInput` and calls
`stageModel`:

- `session`: `null` without `grillSessionId`, else the status from `roadmap.overview`.
- `plans`, `plan`: from the `plan.list` summaries bound to the feature (`approval === "current"`,
  `latestRev`). `StageInput.plan.hasTasks` becomes optional: "no tasks" is said only when it is
  known to be false; nothing else in the model changes.
- `run`: from the project `run.list`, through one helper shared with `useFeatureStage` (the
  derivation of `stage-strip-view.tsx:60-68` moved into `stage-strip.ts` unchanged).

A read that is pending is `loading`, a failed one `failed`, exactly as on the screens.

**Target.** `featureOpenTarget(feature, reads)` is pure:

| Feature | Target |
| --- | --- |
| Status `done`, `deferred` or `cancelled` (no current stage) | feature screen, default segment. No read is needed. |
| Status `executing` | feature screen, Tasks segment (the Execution surface). No read is needed. |
| `created` or `planned`, and `plan.list` or `run.list` is still loading | `wait` |
| `created` or `planned`, and one of them failed | feature screen, default segment; its strip shows the failed read |
| Current stage `execution` (a live run) or `tasks` | feature screen, Tasks segment |
| Current stage `plan`, one bound plan | plan screen of that plan |
| Current stage `plan`, several bound plans | feature screen, Plan segment |
| Current stage `questions`, the feature has a session | session screen of `grillSessionId` |
| Current stage `questions`, kind `feature`, no session | feature screen, Questions segment: the start panel (§3.6) |
| Current stage `questions`, kind `bug`, no session | feature screen, default segment |

**Opening is navigation only.** `openFeature` never calls `feature.discussion.open`,
`session.create` or any other write. A discussion chat is created only by a `Discuss`,
`Discuss with…`, confirmation-retry or `Create & discuss` press.

**Waiting.** `openFeature(id)` records an open intent. An effect resolves it as soon as the target
is not `wait` and pushes the target; after 3 s still waiting it pushes the feature screen. While
it waits, the card shows "Opening…" and reports `busy`. A second card press replaces the intent; a
switcher press, a route or an unmount clears it. `/roadmap feature` uses the same intent.

**With a session versus without.** A session exists once any Discuss press has reserved a chat
(even when the creation then failed or is unresolved) or once a plan was drafted. The card then
opens the session screen, which shows the discussion state and the Discuss controls itself
(§3.6). Without a session there is nothing to open, so the card opens the start panel. A
standalone session (`session.create`, Sessions view) is unrelated to any feature and is never
created or reused by a card press.

**Management stays reachable** in three places: the card's More section (§3.3), the feature
screen's summary (unchanged `featureActionButtons`), and a `Feature details` button on the session
and plan screens of a feature (§3.6).

### 3.6 Stage surfaces: the changes they need

- **Feature screen.** New optional `initialSegment`. New segment `questions`, offered only for
  kind `feature` without a session: heading "Questions", the text "This feature has no discussion
  yet. Start a discussion chat to collect its questions.", and `DiscussionControls`; `onOpened`
  replaces the screen with the session. The strip's Questions pill is then enabled and selects
  this segment; it stays unavailable for a bug without a session. Compact shows a `Questions`
  segment button only while that segment applies; wide shows the panel in the left column, as it
  does for Changes. Strip navigation to a session or plan uses `replaceTop`.
- **Session screen.** For a feature's session: a 44×44 `Feature details` icon button in the title
  row (replaceTop with the feature screen); and, when the feature's discussion is not bound and
  the session has no planner, a bordered notice under the strip holding `DiscussionControls`
  (status text, the confirmation retry, language, `Discuss`, `Discuss with…`). `onOpened` stays on
  the screen. A session whose planner was bound by hand shows no notice, so Discuss never silently
  replaces a chosen chat.
- **Plan screen.** `PlanView` gains an optional `header` slot under its title row, in its loading
  and loaded states. For a plan bound to a feature the panel fills it with the `StageStrip`
  (`viewed="plan"`) and `Feature details`. Questions goes to the session, or to the start panel
  when there is none; Tasks and Execution go to the feature screen; all by `replaceTop`. A legacy
  plan has no header.
- **Stage hops elsewhere.** The session screen's strip (`panel.tsx:315-317`) moves from push to
  `replaceTop`.

### 3.7 New feature form: `Create` and `Create & discuss` (A2)

The form replaces the home screen's content while open, as today; the switcher and filter are
hidden behind it and `Discard` returns. Layout:

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
| Default profile set and among the saved profiles | `Profile: <name> (default)` and `Change…`, which shows the saved profiles as chips; a chosen one is marked; `Use default` returns | enabled |
| Default set, profiles unreadable | `Profile: default`; "The saved agent profiles could not be read." | enabled (the server resolves the default) |
| No default (unset, unread settings, or naming a profile that no longer exists), profiles exist | "No default discussion profile. Choose a profile for this chat, or set a default under Settings." with the chips open | disabled until one is chosen |
| No saved profiles | "No saved agent profiles. The feature can still be created without a discussion." | disabled |
| Languages besides English | chips, English selected | — |

Kind `bug`: no Discussion section and no `Create & discuss`; a line says "Bugs are created without
a discussion chat." and `Create` is the primary button (§11 Q2). `Create & discuss` is primary for
a feature. `Create` needs only a title.

**Step 1, create (both buttons).** `feature.create` with the list's current revision at the moment
of the press (creation no longer pins the revision of the form's opening; editing still does). A
ref latch set synchronously in the press handler ignores a second press before the first has
answered.

**Exactly-once creation without a server key.** The first press records
`attempt = { knownIds, title, description, kind }`, where `knownIds` are the feature ids listed at
that moment. The attempt is kept until the form closes; the inputs are locked while its outcome is
unknown.

- The server answers ok → created.
- The server answers a refusal → not created by this call. After `revision_conflict` the hook has
  re-read the list; the adoption check below runs before the buttons are enabled again.
- The call throws (no answer) → outcome unknown. The form says so, asks the panel to refetch
  `feature.list`, and keeps both buttons disabled until a list read newer than the failure has
  arrived.
- **Adoption check**, on every list update while an attempt is kept: a feature whose id is not in
  `knownIds`, created by a human, with exactly the attempt's title, description and kind, is the
  card this form created; the form continues from "created" and never sends `feature.create`
  again.
- Why this is sufficient: every create carries `expectedRevision`, and the store commits at most
  one write per revision. A lost request either committed before the fresh list read (then the
  adoption check finds its card) or has not committed yet; in the second case it and the retry
  either carry the same revision (one of the two fails with `revision_conflict`, which leads back
  to the adoption check) or the lost one carries an older revision and can no longer commit.

**Step 2, discuss (`Create & discuss` only).** `feature.discussion.open` with the created
feature's id, the panel's workspace, the chosen profile (omitted for the default) and language
(omitted for English), at the revision `feature.create` returned.

- ok → the form closes and the session screen is pushed: `[home, session]`. The tools note is
  toasted as today.
- `revision_conflict` → one automatic retry at the re-read revision. The store revision is
  project-wide, so another chat's write between the two steps is ordinary. The retry is safe: the
  refusal precedes the reservation, or the reservation already guards the creation
  (`discussion.ts:142`, `:179-181`). Its toast is suppressed through a new `quiet` option of
  `useRoadmapMutation`.
- anything else — a second conflict, no or unknown profile, unknown language, a creation in
  progress, an unknown creation outcome, a host refusal, a workspace outside the project, or a
  thrown call — → the **recovery panel**.

**Recovery panel.** The form's fields and both create buttons are gone, so no path can call
`feature.create` again:

```
Feature “<title>” was created.
Its discussion chat has not started: <the server's message>
<DiscussionControls for the created feature>
[Back to roadmap]
```

`DiscussionControls` reads the live feature from the list, so it shows the stored state
(`creating`, `unresolved` with its explicit confirmation, `failed`, or `bound` with
`Open discussion`) and offers `Discuss` and `Discuss with…`. It gets two new optional props,
`initialLanguage` and `preferredProfile`, so a retry keeps the form's choices. If the created card
is not in the list yet the panel says so and offers only `Back to roadmap`. Nothing about the
recovery lives only in the form: after a remount, a reload or `Back to roadmap`, the same controls
are on the card's More section, on the session screen's notice and on the start panel.

**`Create` only.** The form closes, the list shows the new card (§3.3). A removal feature
(`Create removal feature`) uses the same form with both buttons; after `Create` it opens the new
feature, as today.

**Cost boundary.** `Create & discuss` creates an agent and sends it one prompt, on that press
only. The only automatic repeat is the single `revision_conflict` retry, which cannot create a
second agent.

### 3.8 Persistence in the host tab (`client/host-tab.ts`)

`VERSION` becomes 2. Stored screens:

```ts
type StoredScreen =
  | { kind: "home"; view: "roadmap" | "sessions"; filter?: "all" | "feature" | "bug" }
  | { kind: "feature"; featureId: string; segment?: FeatureSegment }
  | { kind: "plan"; planId: string }
  | { kind: "session"; sessionId: string };
```

`restoreStack`:

- **v2.** The first entry must be `home` with a valid `view`, and no other entry may be `home`;
  otherwise null. An unknown `filter` reads as `all`, an unknown `segment` as absent.
- **v1, read-only migration.** A v1 value that the v1 rules accept is converted:

  | v1 stack | v2 stack |
  | --- | --- |
  | `[overview]` | `[home roadmap]` |
  | contains a `roadmap` entry | `[home roadmap, …]` without the `overview` and `roadmap` entries |
  | deeper, no `roadmap` entry (`[overview, session S]`, `[overview, plan P]`) | `[home sessions, …]` |

  `[overview]` becomes Roadmap, not Sessions, because every tab opened before this change stores
  `[overview]` as its untouched default; keeping it would put every existing tab on Sessions and
  defeat A1. The next save writes v2.
- **Any other version or shape** → null, and the panel opens on the default home.

A plugin downgraded to v1 code reads a v2 value as "nothing kept" and opens on its overview.
`saveStack` and `hostTabOf` are unchanged. One-shot values (link targets, the open intent, the
expanded card, move mode, form text, the recovery panel) are not stored. A breakpoint remount
therefore restores the root view, the filter, the stack and a feature screen's entry segment; a
half-typed form is lost, as it is today.

### 3.9 `/roadmap` routing

| Route | Behaviour |
| --- | --- |
| `/roadmap`, `features`, `runs`, unknown arguments | `resetTo("roadmap")`. On a fresh panel nothing changes. |
| `feature <id or title>` | Resolved against the list as today, then `openFeature(id)`: the same stage-aware intent as a card press, pushed onto the current stack (§11 Q4). No single match → `resetTo("roadmap")` with the existing notice. A failed `feature.list` → `resetTo("roadmap")`, whose view shows the error. |
| `question <link>` | Unchanged: pushes the session with the link. |
| `question Q<n>` | Unchanged: retargets the open session; outside a session the existing notice shows on the current screen. |

The pending-route mechanism, its scope and lifetime, and `parseRoadmapArgs` are unchanged.

### 3.10 Layout, accessibility, themes, hosts

- Every pressable is at least 44×44 px on both layouts (`TARGET_SIZE`).
- Only `View`, `Text`, `Pressable`, `ScrollView`, `PanResponder`, `Platform` from `react-native`,
  and the host's `TextInput`, `Icon`, `Modal`, `FlatList`. No DOM, SVG or new dependency.
- Colours come from `theme.colors` only (`surface0-2`, `border`, `foreground`,
  `foregroundMuted`, `accent`, `accentForeground`, `statusSuccess`, `statusWarning`,
  `statusDanger`); every state also has a word, a mark or a border.
- The web gets `aria-selected`, `aria-pressed`, `aria-expanded` and `aria-busy` through
  `webAria`, because React Native Web drops parts of `accessibilityState`
  (`roadmap-screen.tsx:165-167`). Accessibility actions are a native convenience only; the
  visible move controls are the guaranteed path.
- Focus: closing the form returns focus to `+ New feature`; `Done` returns it to the handle;
  collapsing More returns it to `⋯` (existing `moveFocus`).
- Hosts: no new host API. `tab` stays optional (without it nothing persists and the panel opens
  on Roadmap); the settings, profiles and navigation contracts are those already used on 0.15 and
  0.16. The manifest requirement and SDK pins are untouched.

## 4. Server and shared contracts

**No server change and no RPC contract change.** Every behaviour uses existing contracts:
`feature.list`, `feature.create`, `feature.reorder`, `feature.discussion.open`, `plan.list`,
`run.list`, `roadmap.overview`, `session.create`.

Considered and rejected for this slice:

- *An idempotency key on `feature.create`.* The revision check plus the adoption check (§3.7)
  already give exactly-once creation. A stored key would add a field to the strict `Feature`
  schema, which older installed revisions reading the same store would reject. Raised with Astra
  (§12).
- *One combined create-and-discuss RPC.* Creating the chat is an external effect that cannot be
  atomic with the card; the reservation protocol already makes the second step recoverable, and a
  combined call would duplicate it.
- *A per-feature stage field in `feature.list`.* The list-level reads already determine the
  current stage through the same `stageModel` (§3.5).

Client-internal type changes: `StageInput.plan.hasTasks` optional; `MutationOptions.quiet`;
`StoredScreen` v2.

## 5. Files

New: `client/roadmap-model.ts` (pure: `TypeFilter`, `matchesFilter`, `reorderVisible`,
`dropIndex`, `cardStage`, `featureOpenTarget`, `adoptCreated`, v1 stack conversion helpers),
`client/roadmap-card.tsx` (card, More section, lifecycle strip, drag handle),
`client/home-screen.tsx` (switcher, header, Sessions view), and their tests.

Changed: `client/panel.tsx`, `client/host-tab.ts`, `client/roadmap-screen.tsx`,
`client/discussion-controls.tsx`, `client/feature-screen.tsx`, `client/plan-view.tsx`,
`client/stage-strip.ts`, `client/stage-strip-view.tsx`, `client/hooks.ts`, their tests,
`e2e/lib/ui.mjs`, `e2e/lib/rpc.mjs`, `e2e/run.mjs`, `OVERVIEW.md`, `docs/SPEC.md`,
`docs/STATUS.md`.

Unchanged: everything under `server/` and `shared/`, `client/slash.ts`, `index.client.tsx`,
`paseo-plugin.json`, `package.json`.

## 6. Tasks

One isolated worktree branched from `636bd48`. Production code and executable tests are written
in separate assigned roles; one commit per task after its checks pass; synthetic fixtures only; no
daemon restart, no credential or settings change. Each task ends with its focused tests, then
`npm run typecheck` and `npm run lint`.

**T0. Preflight (evidence, no commit).** In the sandbox host: confirm `PanResponder.create` is a
function inside a plugin panel on the 0.16 host and on a 0.15 host, or record which is
unavailable. List the sandbox's saved agent profiles and whether one uses the inert provider
within the safety check's agent limit. Confirm the E2E RPC allow-list rules for feature writes.
Outcome recorded in the task ledger; a missing `PanResponder` on a host makes T5's drag optional
there, nothing else.

**T1. Pure models.** `roadmap-model.ts`; `hasTasks` optional and the shared run-evidence helper in
`stage-strip.ts`, with `useFeatureStage` using it. Tests: `reorderVisible` (up, down, top, bottom,
hidden items between, unknown id, single item), `dropIndex`, `cardStage` equal to `stageModel` on
the same facts, every row of the §3.5 table, `adoptCreated` (match, known id, agent-created,
changed text), existing `stage-strip.test.ts` unchanged and green.

**T2. Tab state v2.** `host-tab.ts`. Tests: v2 round trip; each row of the migration table;
rejected shapes (two home entries, home not first, bad view, other version); lenient optional
fields; a v1 value is rewritten as v2 on the next save; no write without a tab.

**T3. Home screen and stack.** `home-screen.tsx`; `panel.tsx` stack operations, default stack,
read enabling, removal of the `overview` and `roadmap` kinds, slash routing per §3.9. Tests:
default is Roadmap; the switcher replaces the root and keeps the filter; Sessions stays reachable
when `feature.list` fails and the reverse; Back from session, plan and feature returns to the
view they were opened from; bare `/roadmap` resets from a deep stack; the route tests of
`panel.test.ts:784-859` re-expressed on the new stack; question-link and other-project cases
unchanged.

**T4. Roadmap cards.** `roadmap-card.tsx`; `RoadmapScreen` without Back, with the filter, count,
card, More section, lifecycle strip, progress bar, new-card highlight; move controls on a handle
press (no drag yet). Tests: filter and counts; one expanded card; every existing card action
reachable from More with unchanged calls and revisions; strip states for complete, current, open
and unknown; accessibility labels and 44 px sizes; reorder under a filter sends the mapped full
order; controls disabled while a mutation is pending and at the edges.

**T5. Drag reorder.** `PanResponder` handle, scroll lock, optimistic order, absent-API fallback.
Tests with a recorded responder config: threshold and direction, release index, unmeasured rows
send nothing, a press right after a drag is ignored, the optimistic order clears on a revision
change and on failure, no drag handlers without `PanResponder`.

**T6. Stage-aware opening and stage surfaces.** Open intent and `replaceTop` in `panel.tsx`;
`initialSegment` and the Questions start panel in `feature-screen.tsx`; the notice and
`Feature details` on the session screen; the `header` slot in `plan-view.tsx`. Tests: each target
of §3.5 from a card press and from `/roadmap feature`; waiting then resolving, and the 3 s
fallback; no mutation is ever sent by opening; strip hops replace and never duplicate; the notice
appears only for an unbound feature session without a planner; a bug gets no start panel.

**T7. New feature form.** `FeatureForm` per §3.7; `quiet` in `hooks.ts`; `initialLanguage` and
`preferredProfile` in `discussion-controls.tsx`. Tests: the button and section matrix for feature
and bug and each profile situation; `Create` sends one `feature.create` at the current revision
and closes; a double press sends one call; a refusal keeps the text and allows a retry at the new
revision; a thrown call locks the form until a newer list read, then adopts or re-enables; a
conflict after a lost call adopts; `Create & discuss` sends create then open with the returned
revision, profile and language; one quiet retry on conflict; every other failure shows the
recovery panel, in which no `feature.create` can be sent; the recovery controls show each stored
discussion state; edit mode still pins its revision.

**T8. End-to-end.** Update `openPlugin` and `openSession` for the new home, then add journeys
(fixtures titled `[e2e] <run id> …`, deleted through the UI at the end):

- j10 wide: the panel opens on Roadmap; switch to Sessions and back; resize across the compact
  breakpoint keeps the view and the filter; j1's New session path still works from Sessions.
- j11 wide: New feature → `Create`; the card appears last and highlighted; pressing it opens the
  Questions start panel; the safety check still counts no new agent; Back; More → Edit,
  Dependencies, Delete.
- j12 compact 390×844, touch: switcher by tap; create a bug (no `Create & discuss`); filter Bugs;
  handle tap → `Move up`; touch-drag a handle; the order is read back through `feature.list` and
  after a reload.
- j13 wide: mouse drag under the Features filter with a bug between two features; the bug's
  position relative to the unmoved items is unchanged.
- j14: `Create & discuss` with no usable profile is disabled with its message. Its success path
  runs only if T0 found an inert-provider profile within the safety limits; otherwise it is
  reported as not exercised end to end.
- Regression: j1–j9 on the new helpers.

Plan, Tasks and Execution targets need plan and run fixtures the harness cannot seed; they are
covered by T1 and T6 tests and by T10, and reported as such.

**T9. Documentation.** `OVERVIEW.md` (opening and `/roadmap`, "Roadmap and features", "Feature
discussion", "Feature screen"), `docs/SPEC.md` navigation and persistence, `docs/STATUS.md`.

**T10. Review and host verification (evidence, not a test task).** Routine independent review of
the diff; KensAI on the exact final commit; then, only under a separate owner authorisation to
install or reload that exact commit, the checklist of §8 in the real host.

Order: T0 → T1 → T2 → T3 → T4 → T5; T6 after T4; T7 after T6; T8 after T7; T9 with T8; T10 last.

## 7. Validation gates

1. Per task: focused tests, `npm run typecheck`, `npm run lint`.
2. Before review: `npm test`, `npm run test:e2e-guards`.
3. E2E: `node e2e/run.mjs --rev <final 40-hex>` on a sandbox already running that revision;
   j1–j14 pass, or each skipped journey is named with its reason.
4. Review, installation and live UI verification are three further, separate states (§9).

The component tests run without a reconciler, layout or native host (the harness of
`client/roadmap-screen.test.ts:1-7`); they prove calls, props and state, never rendering.

## 8. Acceptance criteria

1. A fresh panel opens on the Roadmap view; the switcher shows Roadmap selected and Sessions is
   one press away on wide and compact.
2. Session rows, links, plans and New session work from the Sessions view as before.
3. The root view, the filter and the stack survive a compact ↔ wide remount; Back from any screen
   leads where it led before the remount.
4. A v1 tab state `[overview]` opens on Roadmap; `[overview, session S]` opens session S with
   Back to Sessions; `[overview, roadmap, feature F]` opens F with Back to Roadmap.
5. `Create` with a title adds exactly one card, last in the list, and opens nothing.
6. `Create & discuss` on a feature with a usable profile adds exactly one card, creates exactly
   one chat, and shows the session screen with Back to Roadmap.
7. When step 2 fails for any reason, the recovery panel names the created feature, offers no
   control that creates a card, and the same recovery is available from the card afterwards.
8. A double press, a refused call followed by a retry, and a lost answer followed by a retry each
   leave exactly one card.
9. For a bug the form offers `Create` only and says why.
10. Without a default profile `Create & discuss` is disabled until a profile is chosen; with no
    saved profiles it stays disabled and `Create` works.
11. A card press opens: the session for Questions with a session; the start panel for Questions
    without one; the plan for Plan with one bound plan; the feature screen's Plan segment with
    several; the Tasks segment for Tasks and Execution; the feature screen for done, deferred and
    cancelled.
12. Opening a feature sends no mutation and creates no chat or session.
13. With a stage read pending the press waits, then opens the right surface; with a failed read
    it opens the feature screen, whose strip shows the failure.
14. Edit, Dependencies, Defer or Resume, Cancel, Delete, Create removal feature and Details are
    reachable from the card and from the feature screen; `Feature details` is on the session and
    plan screens of a feature.
15. Stage strip hops never lengthen the stack; one Back leaves the feature.
16. Dragging a handle, and each move control, sends one `feature.reorder` with a full
    permutation; under a filter hidden items keep their relative order.
17. Every reorder is possible without drag, by keyboard and by screen reader.
18. Bare `/roadmap` shows the Roadmap root; `/roadmap feature <x>` opens the same surface as
    pressing that card; question routes behave as before.
19. Every control is at least 44×44 px; no state is conveyed by colour alone; light and dark
    themes use theme colours only.
20. The plugin loads and the above holds on a 0.15 and a 0.16 host; without a `tab` prop nothing
    persists and nothing fails.

## 9. Delivery states and what is not claimed

Validation, review, installation and live UI verification are distinct and reported separately.
Not claimed by this plan: native device behaviour of drag; the end-to-end success path of
`Create & discuss` unless T0 allows it in the sandbox; Plan, Tasks and Execution targets end to
end; any behaviour of a bug discussion; persistence of form text across a remount.

## 10. Stress test: risks and corrections

Ranked by damage times likelihood. "Verified" refers to §2; the rest is hypothesis.

1. **A duplicate card from a lost answer or a double press.** Verified: `feature.create` has no
   idempotency key and the hook re-reads nothing after a thrown call. Correction: the press latch,
   the kept attempt, the newer-list gate and the adoption check (§3.7); criteria 8. Residual: the
   adoption check matches on title, description and kind; a different person creating an
   identical card in the same seconds would be adopted instead of duplicated, which is harmless.
2. **Navigation that spends a model call.** Hypothetical failure: a card press that starts a chat.
   Correction: opening is navigation only (§3.5); the single automatic retry cannot create a
   second agent (§3.7); criterion 12. E2E must not create real agents (T0, j14).
3. **Drag unproven in the production plugin.** Verified: no production use of `PanResponder`.
   Unverified: its behaviour inside the host's scroll containers, on native devices and on both
   hosts. Correction: T0 before T5; drag isolated in the handle; the move controls are complete
   on their own (criterion 17); no native claim (§9).
4. **Wrong surface from stale or missing reads.** Verified: `stageModel` treats an unknown plan
   list as "no plan", which alone would send a planned feature to Questions. Correction: the
   `wait` and failed-read rows of §3.5; one model for card and screen; criterion 13.
5. **Every E2E journey depends on the old root.** Verified (`ui.mjs:23`, `:27-45`,
   `run.mjs:307-308`, `:808`). Correction: T8 updates the helpers first and reruns j1–j9.
6. **Conflicts between the two steps in a busy project.** Verified: the revision is project-wide
   and `openDiscussion` demands an exact match. Correction: one quiet retry, then the recovery
   panel.
7. **Existing tabs after the upgrade.** Verified: the panel saves `[overview]` for an untouched
   tab. Correction: the migration table (§3.8); criterion 4. A downgrade opens on the old
   overview, stated.
8. **Back behaviour changes.** Stage hops replace instead of push; bare `/roadmap` resets instead
   of pushing. Both remove a way back that exists today. Correction: the rule is one table
   (§3.1), tested (T3, T6), and listed for the owner (§11 Q4 and the note under it).
9. **Reorder under a filter surprises.** A one-place move can pass hidden items. Correction: the
   position text names the shown count; hidden items provably keep their order (T1, j13).
10. **A card stuck in `creating`.** Verified: delete is refused while the discussion is
    `creating`, and a reservation younger than 60 s refuses Discuss. A card made by a failed
    `Create & discuss` can therefore refuse Delete for up to a minute, then needs one Discuss
    press to settle as unresolved. Correction: the card's discussion line and the server's
    message say so; no client workaround.
11. **Web accessibility state dropped.** Verified for `accessibilityState` on buttons.
    Correction: `webAria` on the tab, radio, expanded and busy states; visible words for each.
12. **Card density on a 390 px screen.** Hypothesis. Correction: description capped at two lines,
    actions behind More; checked in j12 and T10 screenshots.
13. **Form text lost on a breakpoint remount.** Existing behaviour, kept and stated (§3.8).

## 11. Unresolved owner decisions

Each has a recommended default. None is approved by this document or by silence. The design above
is drawn with the recommended choices; another answer changes the named sections only.

❓ **Q1 — The main screen on wide layouts**

A1 fixes a switcher on compact and leaves wide to the design. The plugin learns only whether the
layout is compact, not the panel's width, and a wide panel can be barely over 600 px. A card needs
room for its strip, More button and handle.

1. The same Roadmap | Sessions switcher on wide and compact (recommended)
2. Wide shows two columns, the Roadmap list and a narrower Sessions column; compact uses the switcher
3. Wide shows the Roadmap with Sessions as a collapsible section beneath the list; compact uses the switcher
4. Wide shows the Roadmap with a right rail holding Sessions and the start delegations, as the preview's dashboard did

➡️ Choice 1. One control means one stored root view that maps to itself across a breakpoint
remount, and the cards keep their width on a narrow wide panel. Choices 2–4 show more at once on a
large window but need a second layout whose minimum width the plugin cannot measure, and a rule
for what compact shows after shrinking.

---

❓ **Q2 — `Create & discuss` and bugs**

Verified: the server refuses a discussion chat for a bug (`discussion.ts:145`, `sessions.ts:558`)
and the card offers a bug no Discuss. The approved design makes bug grilling optional and allows
grilling on demand, but no bug discussion flow has been designed (prompt, reproduction steps).

1. A bug is created with `Create` only; no discussion in this slice (recommended)
2. Allow a discussion chat for bugs everywhere: the form's `Create & discuss` and the card's Discuss
3. Keep the form `Create`-only for bugs, but allow Discuss from a bug's card
4. For a bug, `Create & discuss` creates the bug and opens a plain question session without a chat

➡️ Choice 1. It needs no server change and matches what is shipped. Choices 2 and 3 open the
server contract and need a bug-specific prompt that nobody has specified; choice 4 invents a
session a bug does not otherwise get. A bug discussion is better designed as its own small slice.

---

❓ **Q3 — Pressing a Questions-stage feature that has no discussion yet**

A3 says the press opens the Questions screen, but without a discussion there is no session to
show. Starting a chat creates an agent and sends it a prompt.

1. Open a Questions start panel with Discuss, Discuss with… and the language; nothing is created until the owner presses (recommended)
2. Start the discussion at once with the default profile and open the session
3. Open the feature's details, with Discuss among its actions
4. Expand the card in place with the Discuss controls, without leaving the list

➡️ Choice 1. The press lands on the Questions stage as A3 asks, and a chat is created only by a
button that says so. Choice 2 is one press fewer but makes plain navigation spend a model call and
leaves a chat behind after a mistaken press. Choices 3 and 4 do not land on the stage.

---

❓ **Q4 — What `/roadmap feature <id or title>` opens**

Today it opens the feature's detail screen. A3 covers a card press only.

1. The feature's current stage, the same as pressing its card (recommended)
2. Always the feature's detail screen, as today
3. The Roadmap list with that card highlighted, opening nothing
4. The current stage for a feature in Questions, the detail screen otherwise

➡️ Choice 1. One rule for "open this feature" is easier to predict and to test. Choice 2 keeps
today's behaviour at the price of two meanings of opening a feature.

Related planner choice, stated so it can be vetoed with Q4: the bare `/roadmap` resets the panel
to the Roadmap root instead of pushing a roadmap screen, because the roadmap is now the root. The
way back to a screen that was open before the command is lost.

---

❓ **Q5 — Which filters the Roadmap list has**

The brief asks for filter chips as in the preview, which filtered by type (it also had a Tasks
type that the product does not have). The approved design says no filtering of done features is
inferred.

1. Type only: All, Features, Bugs (recommended)
2. Type chips plus a "Hide done and cancelled" toggle
3. No filter in this slice
4. Type chips plus status chips for the six statuses

➡️ Choice 1. It is the preview's filter reduced to the kinds that exist and hides nothing by
status, which stays inside the approved design. Choices 2 and 4 add status filtering the design
explicitly did not infer; choice 3 drops what the brief asks for.

**Planner decisions inside the design remit** (settled by approving this plan, each cheap to
change): management behind an inline More section rather than always-visible buttons (§3.3);
`Move to top` and `Move to bottom` beside `Move up` and `Move down` (§3.4); replace semantics for
stage hops (§3.1); `[overview]` migrating to Roadmap (§3.8); the form replacing the list while
open (§3.7); feature sessions staying listed under Sessions (§3.2).

## 12. Consultation request (Astra, one bounded advisory pass on this draft)

1. **Exactly-once creation (§3.7).** Is the argument sound that the revision check plus the
   adoption check prevents a duplicate without a server idempotency key? Look for a sequence the
   argument misses, including `expectedRevision` taken from the cached revision
   (`hooks.ts:213-222`, `:251`).
2. **Replace semantics and the `/roadmap` reset (§3.1, §3.9).** Do they break any deep-link flow:
   question links, cross-session references, timeline rows that open the panel with a route?
3. **List-level stage (§3.5).** Can `plan.list` approval, the project run list and the overview
   session status ever give a different current stage than the per-feature reads
   (`unverified` approvals, several plans, runs of older revisions)?
4. **Drag (§3.4).** Is a capture-phase `PanResponder` with a scroll lock sufficient inside the
   host's scroll containers on web and native, and is there a known host constraint that defeats
   it?
5. **Session-screen Discuss notice (§3.6).** Is the condition (discussion not bound and no
   planner) right, or does it collide with a manually bound planner or the planner picker?
6. **Omissions.** Anything A1–A3 imply that this draft does not cover.
