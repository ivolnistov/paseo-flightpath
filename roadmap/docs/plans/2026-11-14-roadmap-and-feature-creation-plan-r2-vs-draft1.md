# Roadmap home and feature creation plan: revision 2 against draft 1

Comparison baseline: draft 1, `docs/plans/2026-11-14-roadmap-and-feature-creation-plan.md`
(SHA-256 `d255d1d734bbc0075854aedfb489f753cf4b0da88abec9b0263a894d226d6064`, unchanged).
Current version: `docs/plans/2026-11-14-roadmap-and-feature-creation-plan-r2.md`.

Cause of every change: one bounded Astra advisory pass on draft 1, each point re-verified at
`636bd48` (revision 2 §13). Neither document is approved. This comparison grants no execution or
publication authority.

## Scope

| | Draft 1 | Revision 2 |
| --- | --- | --- |
| Server and contracts | No server change and no RPC contract change. | One optional input, `featureId`, on `feature.create`, and a repeat check in `server/features.ts`. Conditional on the owner's answer to the new Q6. Nothing stored changes. |
| `client/slash.ts` | Unchanged. | Changed: a new `unknown` route. |
| Discussion binding | Unchanged, with a claim that Discuss never silently replaces a chosen chat. | Unchanged, and the claim is withdrawn. |

## Behaviour

**Added**

- The client chooses the new feature's id; a repeated create for the same id returns the existing
  card (§3.7.1, §4).
- A form state machine with seven named states and one reducer (§3.7.2).
- An unresolved create operation is kept in the tab state; after a remount a panel banner offers
  `Retry` or shows that the card was created; the discussion step is never started automatically
  after a remount (§3.7.3).
- `stageDestination`: every strip opens the pressed stage's own surface. The session screen's Plan
  pill opens the plan; in draft 1, as today, it would have opened Tasks (§3.1).
- `stagePosition`: stage position computed from list-level facts on the card and on the screens;
  the screens take the plan's approval from `plan.list` (§3.5).
- The feature screen's current segment, not its entry segment, is restored after a remount (§3.6).
- A stage header on a plan opened directly from Sessions or restored from the tab state (§3.6).
- The discussion context and both create buttons on the feature screen's removal form, with a
  return stack per caller (§3.7).
- A replacement warning on the Discuss controls when the feature's session already has a chat, a
  status line without controls on the session screen, and a message instead of the planner picker
  while a discussion chat is being created (§3.6).
- Unknown `/roadmap` arguments show a notice and navigate nowhere (§3.9).
- Keyboard movement between tabs and between filter chips on the web; `aria-checked`; a mark for
  every lifecycle state besides its colour (§3.2, §3.3).
- Drag cancel rules, one coordinate system, and a scroll lock on a container the Roadmap view owns
  (§3.4).

**Removed**

- Fingerprint adoption: recognising the owner's card by title, description and kind.
- The "newer list read" gate before a retry.
- The rule that a replaced top entry is dropped when the entry beneath is the same screen.
- The claim that the card and the screens "cannot disagree" about the stage.
- The claim that Discuss never silently replaces a chosen chat.

**Changed**

- Stage hops: draft 1 replaced the top entry and then dropped a duplicate beneath. Revision 2
  replaces the top entry, except that a hop to the feature screen pops to that feature's own entry
  directly beneath, which takes the requested segment. Pushed entries are never merged.
- The Discuss notice on the session screen: from two conditions to five, including a loaded and
  active session; bounded in height.
- Drag: from "isolated in the handle" to shipped only where a real-gesture gate passes.
- `/roadmap feature` with no single match: a notice without navigation, instead of a reset to the
  roadmap with a notice.

## Constraints

- Every `feature.create` call must carry the feature list's own revision; the mutation hook's
  default revision is forbidden for creates.
- A client-chosen id must match `^[0-9A-HJKMNP-TV-Z]{26}$`, because it becomes a file name; it is
  honoured for a UI origin only.

## Acceptance criteria

- Count: 20 → 23. Each criterion now names its evidence level (unit, sandbox journey, real host).
- New: every strip opens its own stage and Plan never opens Tasks (14); pushed entries are never
  merged (15); a cancelled drag sends nothing and scrolling returns (19); unknown `/roadmap`
  arguments do not navigate (20); the Discuss notice's conditions and the phone viewport (21).
- Extended: the single-card criterion adds a lost answer followed by an edit of the card elsewhere,
  and a remount during any phase (8); persistence adds the selected segment (3); `Feature details`
  adds a plan opened from Sessions (16); accessibility adds keyboard use of tabs and radios (22).
- §7: a skipped journey satisfies no criterion; missing evidence is reported "not verified".

## Not claimed (§9)

Added: that a discussion chat never replaces a planner already bound to the session; that the card
and a screen show the same stage at every instant; recovery of an unresolved create after a
remount on a host without tab state; drag on any host where the gate was not run.

## Delivery boundaries and tasks

- Tasks: T0–T10 → T0–T11. New T2 (idempotent create, server and shared, conditional on Q6). The
  later tasks are renumbered.
- T0 no longer probes `PanResponder`; the proof moved to T6's gate on the real implementation,
  which now precedes the stage and form work.
- T1 adds the reducer, `stageDestination`, the hop rule, `stagePosition` and the `unknown` route.
- T7 and T8 add the race, cache-order and remount tests Astra listed.
- Review, installation and host verification boundaries are unchanged.

## Owner decisions

- Q1–Q5: unchanged in substance. Q4's note now says a mistyped argument no longer triggers the
  reset.
- **New Q6:** how "a retry never creates a second card" is guaranteed. Recommended: the
  client-chosen id honoured by `feature.create`. Choosing a client-only alternative would narrow
  A2's guarantee, which is the owner's call.
- New non-blocking note: Discuss replaces a chat bound to the session by hand; that is shipped
  behaviour, made visible but not changed.
- Planner decisions list: three added (current segment restored, removal form with both buttons,
  notice for unknown arguments); "replace semantics" renamed to the hop rule.
