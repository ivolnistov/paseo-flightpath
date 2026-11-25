Decision Roadmap adds a workspace panel where you collect open project questions, choose answers from
prepared options and see how decisions depend on each other.

Each question has numbered options, an optional recommendation and, when allowed, a free-text
answer. Questions can be shown only after a particular answer to another question, including one in a
different session, and can depend on other questions. When an answer changes or a question is marked
out of scope, every answered question that depends on it is marked stale with the reason, so it can be
confirmed or re-answered; a dependent you skipped or marked out of scope keeps that outcome and is
flagged for review instead.
Hidden branches keep their answers and history and reappear when the branch becomes active again. They
are not in the session's main question list: **Show hidden questions** (closed by default) lists them
read-only with the condition that would show them.

Every question has a stable number in its session (Q1, Q2, …) that never changes, and every answer is
kept as a revision with its time and note. A recommended option is preselected on an unanswered
question; submitting it unchanged records it as your accepted default. **Skip** and **Out of scope**
are separate, explicit outcomes: a skipped or out-of-scope question shows no current answer, and an
earlier answer stays only in its history. You can edit question text, options and relations,
except for questions of an accepted block (its definitions stay frozen) or a cancelled decision.
Answers, Skip and Out of scope remain available on an accepted block; a cancelled decision stays
read-only. A question card names its relations with their direction (Depends on, Needed by, Informs,
Informed by, Supersedes, Superseded by). The session's **Map** draws its questions as a branching
graph, one lane per block (see "Map").

The roadmap is stored in a `.decisions` folder at the root of the registered Paseo project, so the
main checkout and its worktrees share one history. The panel offers to initialise it on first use.
If the stored data cannot be read, the panel shows the problem and changes nothing. The plugin writes
only that folder and its own plugin data. When tracker sync is set up for SnailOrbit, it also reads
the SnailOrbit entry of the local Codex config each time it is needed. Tracker writes happen only
for a live batch you have explicitly confirmed. Linking a manually found ticket also makes a
read-only verification request to SnailOrbit when you choose that action.

Questions are related in three ways: an activation condition (show a question only after a given
answer elsewhere), an invalidation dependency (an answer change, or the question going out of scope,
marks the dependent answer stale) and
a link between sessions or questions ("informs" or "supersedes").

Open it from the workspace panel list, the Command Center ("Open decision roadmap") or by typing
`/roadmap` in a workspace or agent composer. `/roadmap features` and `/roadmap runs` open the
roadmap screen, and `/roadmap feature <id or title>` opens that feature. A title must match exactly
one feature, ignoring case; otherwise the roadmap opens with a short notice. `/roadmap question
<link>` opens a question link (see "Feature discussion"), and `/roadmap question Q<n>` a question of
the session open in the panel. The command only
navigates and changes nothing. It applies to the panel of the same workspace and project, and is
dropped if the panel does not pick it up within 30 seconds.

Where the host keeps per-tab state for the panel (observed on Paseo 0.15.3; the plugin SDK it is
built against does not define it), the panel keeps the screen you had open when the host switches
between its phone and desktop layouts; without it, the panel opens on its first screen again.

Install with `paseo plugin install <path>` and pick up changes with `paseo plugin reload`; the Paseo
daemon never needs a restart.

## Agent tools (MCP)

New Claude, Codex, OpenCode and Copilot agents started in a project with an initialised, enabled
roadmap get a "decision-roadmap" MCP server bound to that project only. It offers:
roadmap_overview, roadmap_get_session, roadmap_create_session, roadmap_ask, roadmap_answer,
roadmap_confirm, roadmap_discuss, roadmap_relate, roadmap_update_question, roadmap_link,
roadmap_pause_instructions, roadmap_grill_complete, roadmap_resolve_link, roadmap_out_of_scope,
roadmap_cancel_question, roadmap_block_accept, roadmap_grill_propose_finish, roadmap_plan_draft,
roadmap_plan_status, roadmap_task_update and roadmap_dod_template; for
features roadmap_feature_create, roadmap_feature_list and roadmap_feature_update; and for runs
roadmap_run_next, roadmap_task_claim, roadmap_task_progress, roadmap_run_ack, roadmap_start and
roadmap_feature_bind. Chat and
the panel share one history and the same revision checks, so a stale write is rejected and must be
retried after re-reading.

- Agents may record only what you said: answers, confirmations, out-of-scope marks and block
  acceptance must include your exact words, and are shown as given in chat by an agent (the bound
  chat's agent id is recorded when known). The quoted words are the agent's report of what you said,
  not a signature.
- An agent may cancel, on its own, a question that has no answer or a question that depends on a
  decision you cancelled; any other answered decision needs your quoted words.
- Approval happens only in the Paseo UI. No tool can approve a plan, delete, skip, finish a session or
  initialise anything.
- Existing agents cannot be attached in Paseo 0.12.0. Initialise the roadmap first, then create the
  agent.
- If the plugin logs "MCP port changed", recreate agents created before that time.
- Right after a plugin reload a tool may answer "not_ready: … retry". The next agent turn or opening
  the roadmap panel makes it ready.
- Access grants of archived agents are not removed one by one. They are dropped by a 1000-grant cap
  or invalidated by a port change.
- The endpoint listens on 127.0.0.1 only. Its secret and the grants live in
  `$PASEO_HOME/plugin-data/decision-roadmap/`; never commit or share that folder.
- Maintenance: this relies on the installed Paseo 0.12.0 host keeping one Paseo connection per plugin
  process. Re-verify after a Paseo upgrade.

## Automatic grilling

A grilling session with blocks can continue its planner chat automatically, one batch at a time:

- The planner chat is the first bound chat that posts a batch into the session (or the chat that
  drafted the plan that created it). The header shows `Planner: <chat> · <status>`; **Bind chat…** /
  **Change chat…** in the Chat menu chooses a planner chat of this project. Choosing the current chat again is a rebind:
  it supersedes that chat's pending operation, which then needs manual recovery. Other chats keep
  writing questions but are told not to pause.
- After posting a batch, the planner shows one native question card ("Decision Roadmap: waiting for
  block acceptance …"). You do not answer it. Answer the batch in the panel and press **Accept block
  and continue**: the plugin answers that card with a plain-text summary of the accepted block, and the
  same chat continues with the next batch. The summary appears as the resolved card, not as your
  message. Answers, edits and notes alone never wake the chat.
- Supported chats: Claude in every mode; Codex only with Plan mode on. Other providers are not
  supported: the header says so and you continue in the chat yourself.
- When the card is missing, mismatched, answered in the chat or lost (for example after a host
  restart), the header shows the reason and "Continue the conversation in the chat, or bind another
  chat." Nothing is sent into the chat on its own, except the one automatic continuation of a chat
  created by Discuss (see "Feature discussion"); **Retry** sends the accepted summary when you press
  it.
- A block can also be accepted when you tell the planner to accept it: the agent calls
  `roadmap_block_accept` with your words, which are recorded with the acceptance.
- The planner ends grilling with `roadmap_grill_complete`; **Reopen** in the Chat menu reopens a
  completed session, and the chat's next batch starts again. Completing grilling does not approve a
  plan. A feature discussion, or a session where the chat proposed to finish, is finished only by you:
  **Accept finish proposal** or **Finish discussion…** (see "Feature discussion").
- A session created by a plan draft has no block yet: the planner's first `roadmap_ask` must pass a new
  `blockId`.

## Feature discussion

Press **Discuss** on a feature card (not on bugs, nor on done or cancelled features) to talk through
the feature with one bound chat. The chat is created in the panel's workspace with the profile from
Settings → Decision roadmap → "Discussion profile"; **Discuss with…** chooses another saved profile,
and without a default Discuss asks you to choose. The chat is created without a prompt, becomes the
planner of the feature's question session, and only then receives its instructions. A feature whose
chat exists shows **Open discussion** instead; a feature whose chat is being created cannot be
deleted until that finishes.

- The session screen has **‹ Back**, the title, a **Chat** menu and **Open chat** (when the host can
  open chats and a planner is bound). The Chat menu holds Grilling or Map, **Finish discussion…**,
  **Bind chat…** / **Change chat…**, **Retry** (disabled with the reason when there is nothing to
  send), **Reopen** for a closed session, and what the roadmap tools state means. The planner status,
  the tools state, Retry's outcome with its controls and the closed or reopened line stay visible
  under the header, in the Grilling view and on the Map (on a phone's Map in a short area of its own
  that scrolls; when they take much of the screen, the page scrolls down to the full map). On a phone the menu and Open chat sit on a row below the title. With a keyboard on
  the web, the Chat menu and the Finish confirmation take focus when they open, and so do the Map's
  Find question and detail on a phone, where they are sheets (Find question on its first question);
  on the desktop the Map shows those two beside the map and leaves focus where it is. Escape closes
  each of them and focus returns to the control that opened it (for the Finish confirmation, whose
  menu item is gone by then, to the Chat menu button); in the phone sheets Tab also stays
  inside. The desktop menu closes when focus moves out of it.
- Beside the canvas (above it on a phone, as a sideways row) a navigator lists the blocks, each with
  its state and its questions ("2 questions · Q3–Q4"). The canvas shows every active question of the
  selected block as a card: the recorded answer only (the chosen option with "✓ Chosen" and
  "Recommended" when it is the recommended one, a free-text answer tagged "free text", or "No answer
  yet."), **Edit** to change the answer (it reads **Cancel** while the answer panel is open, on an
  accepted block too), **Description** for the question's context, **Why recommended** for the
  recommended option's explanation when it has one, the relation links, and **More** for Copy link,
  Copy answer link, History, Edit question and Relations (not on an accepted block), Clarify in chat
  and Cancel decision. A relation link to a question of another block selects that block and scrolls
  to the outlined card; one to another session opens it.
- Under the open block, **Add question to Block n** opens a form: the question (at least 5
  characters, not the title of another active question of the block) and an optional free-text
  answer, written together. A form whose request was refused because the roadmap changed, or whose
  request got no response (so whether it was saved is unknown), keeps the draft and is never resent on its own: it says what changed (for example
  that the block was accepted and the question will go to the next one) or, after a lost response,
  whether a question with that title now exists, with **Discard draft** and **Add anyway**. Switching
  to the Map and back keeps the chosen block and the form as it was (the draft, that message, and a
  request still under way); the draft is never saved anywhere else.
  **Accept block and continue** follows, with a line that says it accepts the block as it is. An
  accepted block says so instead; an empty open block says what the chat is doing (for example that
  the summary is being sent and not confirmed yet) and promises no questions.
- If creating the chat had an unclear outcome, the card says so and asks you to check the
  workspace's chats. The plugin looks for the chat by its reservation, but not finding it does not
  prove none exists: a new chat is created only after you press "I checked: no chat was created.
  Create it again", and then in the workspace the chat was first reserved in.
- The chat created by Discuss may read the roadmap (`roadmap_overview`, `roadmap_get_session`,
  `roadmap_feature_list`, `roadmap_resolve_link`, `roadmap_pause_instructions`) and ask questions
  (`roadmap_ask`) without a per-call approval prompt, where its provider supports exact tool
  preapproval (Claude, Codex, OpenCode). Every other roadmap tool, such as recording answers,
  accepting, cancelling, finishing or plans, keeps the provider's normal approval; the profile's mode
  and other agents are not changed.
- The discussion header shows "Roadmap tools: attached", "pending", "not attached" or "unknown",
  read again each time the session is shown. Discuss passes the chat's reservation to the plugin's
  own tool injection, which marks the grant it issues for that creation; only that mark, or a grant
  bound to the chat itself, identifies the chat's tools. Attached: a grant is bound to the chat.
  Pending: the chat's own grant was issued and waits for its session to start. Not attached: the
  chat holds no current grant (for example, a provider without MCP support, or a grant invalidated
  when the tool endpoint moved to another port). Unknown: the grant state or the chat's workspace
  could not be read; a live, unbound, unmarked grant in the chat's workspace (another chat's, or one
  from an older plugin version) could be the chat's; the chat's feature was deleted, so any live
  unbound grant in its workspace, marked or not, could be the chat's; or the chat was
  created again after "I checked: no chat was created", so a grant from the earlier attempt cannot
  be told apart from the chat's own until the chat's session binds it. Unknown does not mean the
  tools are missing. After Discuss a note states the same four states. Grants in the workspace count
  only when issued since the chat's creation began: its reservation for a new chat; for a chat
  already bound, its session's creation or a minute before the binding, whichever is earlier. An
  unreadable reservation marks file makes only the checks that read it unknown; a grant bound to the
  chat still shows attached.
- The chat asks in rounds. Answer in the panel or tell the chat; **Clarify in chat** sends your
  question about a question, as `Clarify Q<n> "<title>": <text>`, to the chat without answering
  anything, and **Open chat** opens it where the host allows.
- The chat does not ask which language to use: the discussion is in English unless you choose
  another language next to **Discuss**. That choice appears only when Settings → Decision roadmap →
  "Additional discussion languages" lists at least one; the language is kept with the session and
  given to the chat in its instructions. Sessions started earlier keep the language answered in
  their first question. The first question card of the block shown has a "Language: …" chip with the session's
  effective language, English included (only a legacy session without blocks, with no stored
  language and no question about the language, shows none). For any language other than English a notice under the header
  recommends English, because the questions are ultimately needed in English, and says that no
  translation is performed in this version: questions are shown as the agent wrote them. **Got it**
  hides the notice for that session and language (stored with the session, so it stays hidden after
  a reload or on another client); the info button beside the chip shows the text again, and another
  language shows the notice again. The "Translation profile" setting is reserved and not used.
- When a block is accepted, the summary the chat was given is kept with the block. The **Summary**
  button opens it in a window, with a Copy button: the open block's preview, or for an accepted block
  the summary at acceptance and, if answers changed later, which numbers changed, that the chat was
  told the earlier values, and the current answers. A changed block also keeps a short "Answers
  changed after acceptance: Q…" line beside the button.
- A feature's session and the feature screen show the feature's four stages, Questions, Plan, Tasks
  and Execution, as one row of cells. Each cell shows a small square mark, the stage name and a state
  word (Done, In progress, Not started, Loading, Read failed or Unknown); the stage being viewed has a
  green bar (the theme's success colour, as in the approved mock) under it. The current stage is the furthest one with stored evidence (a bound plan, a
  current approval, a live run or an executing feature); a done feature is past Execution and has no
  current stage. Each stage is marked done only by its own evidence, whatever the feature's status:
  Questions by a closed session ("finished by the owner manually", "… on the chat's proposal", or
  "closed (basis not recorded)" for a close the session did not record), Plan by a current approval,
  Tasks by a live run of the current plan revision or one of that revision that finished (one
  cancelled for rework or with the feature does not count, and an ended run without a recorded end
  reason shows Tasks as unknown), Execution by a done feature. A read still loading or failed shows
  the stage as unknown. Stages after the current one are disabled, and a line under the row names
  them; a cell opens that stage's screen and never approves or starts anything. On a phone the cells
  share the row and their words wrap.
- Small controls (Edit, More, Description, Why recommended, relation links) are drawn small but keep a
  44 px touch area; every other control is at least 44 px. Icon buttons have a tooltip on hover,
  keyboard focus or long press and the same text for screen readers.
- When the chat proposes to finish, the navigator lists a **Finish proposal** item ("Not accepted
  yet", or "Proposed again …" after a replacement). It shows the chat's full summary, the skipped
  and out-of-scope question numbers and **Accept finish proposal**, which closes the session on the
  basis of that proposal. **Finish discussion…** in the Chat menu closes an active session with
  blocks on your own decision, after a confirmation; a proposal standing then is kept as not
  accepted. Only one of the two can be in flight at a time, and neither approves a plan or starts
  anything. The session keeps every close you make (Finish or Accept finish proposal) with its basis,
  and a line under the header says how the session was last closed or reopened. A close by the
  chat's grilling completion (outside feature discussions) is kept only as the time the chat
  completed: while that close stands the line says "Closed (basis not recorded)"; once the session
  is reopened it names that completion time and says the reopen time is not recorded. Earlier proposals stay in the session's history. The chat
  cannot close a feature discussion, or a session where it proposed to finish, itself: there
  `roadmap_grill_complete` is refused, and only your Finish closes it.
- A chat created by Discuss that cannot wait on a question card (Codex in default mode), or whose
  turn ended without one, is continued by the plugin after you accept a block: it sends the accepted
  block summary once, when the chat is idle with no pending permission or question; until then the
  header says that the continuation waits. The plugin never answers a prompt, and it sends only right
  after reading the chat idle with nothing pending. Paseo cannot make that check and the message one
  step, and any message interrupts a responding chat and dismisses its pending prompts: if a turn or
  a prompt starts in the moment between the check and the message, for example because you write in
  the chat at that instant, it is interrupted or dismissed. Only one such message is sent per accepted
  block: if its delivery is unknown, the header asks you to check the chat as for Retry, and nothing
  is resent on its own; your marks stay as you set them. Chats bound in other ways keep the manual
  Retry.
- When the chat could not continue automatically, **Retry** (in the Chat menu) sends the current
  operation's accepted block summary to the chat once, for that operation and chat binding; a sent
  retry shows its time and cannot be sent again. Before you press it, Retry says that it interrupts
  the chat's current answer if the chat is responding (definitely when Paseo reports it running, as a
  possibility when its state is unknown). If the outcome is unknown, **Check chat** looks for the
  retry in the chat, or you mark it **delivered** or **not delivered**; nothing is resent on its own.
  Delivery is at most once per press, not guaranteed.

Links: `roadmap://<project>/s/<session>/q/<n>` names a question; `…/q/<n>/answer` always opens the
current answer (or says there is none), and `…/q/<n>/answer/r<k>` opens revision k in the history,
marked "not current" unless it is the current answer. Agents read the links from `roadmap_get_session`
and `roadmap_ask` and resolve them with `roadmap_resolve_link`. **Copy link** and **Copy answer link**
copy them from a question. In the session screen, links and Q<n> in answer notes open in place; a
link of another session of the project opens that session, a hidden question opens the hidden list,
and a link of another project is refused with a notice on whatever screen the panel shows.
In agent timelines, a question row has **Open in roadmap** and **Open current answer**, and at the
end of an agent's turn that mentioned roadmap links, a separate "Decision references" row lists up
to 20 of them with **Open**; a revision-pinned answer link is named as that revision from history,
with whether it is still the current one. The link text inside the chat message itself is not clickable: Paseo
renders that text, and plugins cannot make it a link.

## Map

**Map** in a session's Chat menu draws the session from its stored data only: no relation is
guessed.

- Each block is a lane (a session without blocks has one lane, "All questions"), and its questions sit
  in columns by their dependency depth across the roadmap. A question of another session that this
  session's relations or links name appears once, as an external node in an "Other sessions" lane: a
  question that no longer exists says so, and a session without questions has its title unavailable.
  A link between this whole session and a question or another session is a note on a lane; a link
  from this session to itself is a note above the map.
- Each stored activation, invalidation, informs or supersedes link is one edge (identical copies of
  one link, with the same kind, ends and condition, are drawn once), drawn in its own line
  style with an arrowhead; an edge between lanes also carries a small sign for its kind (▸ activates,
  ⊘ invalidates, ⓘ informs, ⇢ supersedes). A link that points back, or two links that point at each
  other, are drawn as such, and a link from a question to itself is a loop at the question's right
  side, listed once in the question's relations as "Informs Q<n> (itself)" (or "Supersedes").
  Relations between two questions of other sessions are not part of this session and are not shown.
- **Zoom out** and **Zoom in** (icon buttons with a tooltip) step through 50, 75, 100 and 125 %, and
  **Fit** fits the map to the view, down to 30 % (a larger map then scrolls), and returns to its
  top-left corner. On a large map, which may open with the current block out
  of view (on a phone it opens at Fit), **Go to open Block n** brings that block's first question into
  view at the current zoom, opening its lane if it was collapsed. At 75 % and above each question is a
  button labelled with its number, title, status, block and its incoming and outgoing relations; a
  question of another session that no longer exists is shown but cannot be pressed or found. At
  50 % and at Fit the map is an overview: pressing it zooms to 100 % at that point. **List** writes
  every question with its relations instead, **Find question** picks any question by number or title,
  and **Show inactive** shows or hides questions that are not active; these work at any zoom.
- Selecting a question dims the questions that are not its neighbours, shows the conditions of its
  activations on the map, and opens a detail beside the map (a sheet on a phone) listing what it comes
  after ("Comes after") and what it leads to ("Leads to"), each with its condition; a row selects that
  question, a question of another session opens there, and **Open Q<n> in Grilling** returns to its
  card. Closing the detail returns focus to the question, or to **Find question** when the map is an
  overview or the question cannot take focus. The selected question (or the place Go to
  or an overview press brought into view) stays centred when the map changes around it, until you
  pan the map yourself; from then on the map stays where you put it.
- Above 120 nodes (this session's questions plus the other sessions' questions and sessions it
  names) the lanes start collapsed except the open block's and the selected question's (a session
  without blocks keeps its single lane open); an edge into
  a collapsed lane ends at a "→ Block n (k edges)" marker that expands it, and edges between two
  collapsed lanes are not drawn until one is expanded. Above 400 nodes the Map opens on the List.
  These thresholds are estimates, not measured limits.

## Decision rows in agent timelines

When a Claude or Codex agent of an opted-in project asks, answers or confirms a question through the
MCP tools, a "decision-question" row appears in that agent's timeline, usually during the turn. The
row shows the question with its options, recommendation, free text and status, and you can answer,
confirm or skip it in place; "Details" opens the full question with its history and editing; **Open
in roadmap** and **Open current answer** open it in the panel of the agent's workspace.

- A row holds only a reference (project, session and question). It always shows the current state
  from the project data, so an answer given in the panel or in chat appears in existing rows without
  a new row. If the question or project is gone, the row says "Decision no longer available".
- Rows are added only to agents that Paseo reports through its turn events, and only after the
  agent's working directory resolves again to a registered project with an initialised, enabled
  roadmap. A question is shown only if it exists in the project data; tool output alone never
  creates a row. Turn ends and reconnects re-scan the agent's timeline and update the same row in
  place. At most 32 agents are followed live at once; others get their rows at the end of the turn.
- "Decision references" rows: at the end of a turn of an agent in an opted-in project, the plugin
  collects this project's links to known sessions from the turn's assistant messages and completed
  tool results, at most 20, and adds one row per turn holding the references only. A rescan replaces
  the row; a turn the host reports without an id gets none, and after a daemon restart the rows
  return only at the agent's next turn end.
- Only Claude and Codex agents get automatic question rows. Other agents, such as OpenCode, Copilot or Pi,
  get the panel and `/roadmap`; their exact tool names in timelines are not confirmed yet.
- Host gap: in Paseo 0.12.0 a plugin may observe and add rows to any agent's timeline; the host does
  not limit this to the plugin's own agents. This plugin limits itself as described above.
- Maintenance: tool names and output shapes were read from the installed Paseo 0.12.0 providers
  (Claude `mcp__decision-roadmap__<tool>`, Codex `decision-roadmap.<tool>`). Re-verify after a Paseo
  upgrade.

## Plans

A plan turns decided questions into Markdown text and a task list. Each change is a new numbered
revision; earlier revisions stay readable in the plan view.

- Drafting: agents draft plans with roadmap_plan_draft. In the panel, the plan view of a plan bound
  to a feature has "Edit DoD": per task you edit the Definition of Done and the grill checkbox, and
  saving drafts a new, unapproved revision (the shown revision stays as it is). Plans not bound to
  a feature cannot be edited in the panel (they are still approved there). A draft is accepted
  only when every active question of the chosen sessions is answered (or explicitly skipped) and
  none is stale. Questions on a branch that is not active, and decisions you explicitly cancelled,
  are left out.
- A revision of a plan bound to a feature can be approved only when every task has a DoD and the
  required grilling is complete: the feature's grilling session (not for bugs), the plan's, and
  each task marked "grill". Those sessions are created automatically on the first draft. The plan
  view lists what still blocks approval next to the Approve button. Approval moves a created
  feature to planned.
- An approved revision can be sent back for rework from the feature screen ("Stop and rework…",
  then "Send for rework" with a reason). Its unfinished tasks are cancelled, verified tasks are
  listed in the plan view as "Completed in revision N", and the feature returns to created with
  "plan in rework" until a new revision is approved. A run on that revision ends.
- Approval happens only in the plan view of the Paseo panel. You approve the exact latest revision
  you are looking at, bound to its content hash; selecting an older revision does not approve
  anything. Agents have no way to approve.
- An approval stops being current when an answer the revision relied on changes, a question in it
  goes stale, its wording changes, a decision it relied on is cancelled, a question joins or leaves
  the active branch, a new active question appears, or a newer revision is drafted. Edits to
  questions on an inactive branch do not affect it. A skipped question blocks approval until it is
  answered and a new revision is drafted. The plan view lists the reasons.
- Tasks belong to one revision. Starting work needs a current approval. Agents can move tasks to
  in progress or done; only the panel can mark a task verified, with a note. For a revision
  executed by a run, tasks are verified by the run's checks and review (followed by "Accept" in the
  UI when completion is human), and a manual verify is refused. An action shown for
  an older revision is rejected rather than applied to the newer one.
- Each plan's latest revision is also written to `.decisions/plans/<plan id>.md`. That file is
  generated, is never read back and is rewritten if edited; change the plan through a new revision.
- Approval receipts are stored outside the project, in
  `$PASEO_HOME/plugin-data/decision-roadmap/approvals/`, and are the only record that counts. A copy
  in the project data without a matching receipt is shown as unverified.
- Limitation: the plugin records that an approval came through the Paseo UI, but it cannot prove
  which person or which client pressed the button. Anything able to call the plugin from this
  machine, or to write its plugin data, is outside this protection.

## Roadmap and features

The roadmap screen lists features in roadmap order with their status. Each feature shows a progress
line from its run: "Not started", or "Running", "Paused (reason)" or "Ended (reason)" with
verified/total tasks for the revision that run executes. When the plan has a newer revision, the
line says so ("run rev N · plan now rev M").

Features can depend on other features. When a prerequisite is cancelled, done and cancelled
dependents are left alone. For the others:
- a directly dependent feature's run ends. If its approved plan revision has a matching approval
  record, the plan goes back to rework ("plan in rework"); otherwise the plan is not reworked and
  the feature returns to created with "prerequisite cancelled". A deferred feature stays deferred
  and returns to created when resumed;
- that feature shows "Replacement plan requested — <prerequisite> was cancelled" when a
  coordinator is bound, or "Replacement queued until a coordinator is bound" when none is;
- features further down the chain pause with "prerequisite cancelled" (a pause you or a deferral
  started is kept), or get a "waiting" note when they have no run;
- approving a newer plan revision clears the request and passes it on to the unfinished features
  that depend on it.

## Feature screen

The feature screen shows the feature with its run. On wide layouts the tasks are on the left and
the coordinator chat on the right; a "Changes" entry in the header switches the left side to the
plan comparison. On phones, "Tasks", "Chat", "Plan" and "Changes" switch the content. The header,
the run controls and the chat input stay in place while the content scrolls.

- Run controls: "Start…" (choose a coordinator profile when none is bound), "Pause run",
  "Resume run", "Replace coordinator…", "Stop and rework…", plus "Accept" for a task that needs
  human acceptance once its checks and review have passed, and "Grant extra cycles" for a task at
  its repair limit. Every control acts on the run
  shown, so an action for a run that has ended or changed is refused rather than applied to
  another one.
- Chat: the coordinator's chat only. You can send messages, answer that coordinator's permission
  requests ("Allow"/"Deny"), pause or resume its run and reload the chat. Features without a
  coordinator show "No coordinator chat yet".
- Changes: compares revisions of the feature's plan with the existing plan comparison. The latest
  revision is shown, and nothing is compared until you choose an earlier revision. It never shows
  code changes.
- Replacing a coordinator works when the feature has no live run, or when its run is paused and
  every active worker has acknowledged the pause. The run keeps its identity and the old chat is
  kept.

## Execution runs

A run executes the approved, current revision of a feature's plan through a coordinator chat.

- Starting: "Start…" in the feature screen, or a start you delegated in chat by quoting your own
  words. Without a bound coordinator, the plugin creates a worktree and a coordinator agent from a
  host profile, records the run, then sends the coordinator its run instructions. A chat can bind
  itself as a feature's coordinator with roadmap_feature_bind.
- Delegations: the roadmap screen lists active start delegations with "Revoke". A revoked
  delegation stops new starts under it, and stops new work being handed out in the runs it
  started while no other unrevoked delegation covers the feature; tasks already in progress
  finish. A new delegation covering the feature lets that work continue.
- Working: the bound coordinator asks for ready tasks and claims or dispatches them; workers in
  the same workspace claim only for themselves; other chats are refused. Reporting a task done
  starts the server checks and review; only the plugin decides completion. When the last task is
  verified, the run ends and the feature is done.
- Pausing: "Pause run" stops running checks and asks the coordinator to have every worker
  acknowledge. Deferring a feature pauses its run; cancelling it or sending its plan for rework
  ends the run. Only "Resume run" resumes a paused run, except that a run paused for a prerequisite
  resumes automatically once every prerequisite is done and the run is otherwise ready (current
  approval, feature executing).
- Agent timelines show a read-only run row with the run's state and counts.
- Limitation: runs and screens are verified with automated tests, with synthetic plugin calls
  in an isolated Paseo 0.12.0 container, and in a desktop browser at phone and desktop widths in
  light and dark themes. They are not verified on a native mobile app. No live coordinator, model
  turn, live chat stream or live permission request is claimed: streaming and permission answers
  are tested against SDK-shaped mocks, and the container check used an idle agent. With the
  verified Paseo 0.12.0 server, the chat shows the server's merged chronological view of the
  coordinator's timeline: the plugin asks for the canonical view, but that server version returns
  its projected one.

## Settings

"Decision roadmap" in the plugin settings holds the run settings:
- the repair limit;
- the check and review timeouts and the output limit;
- the review command, which runs locally, so do not put credentials in it;
- the base branch;
- the coordinator profile used for delegated starts;
- the discussion profile that **Discuss** creates feature chats with;
- additional discussion languages offered next to **Discuss** (English is always offered and is the
  default);
- a reserved translation profile, stored only: no translation is performed;
- the global Definition of Done template.

Changes are saved against the version you opened. If the settings changed in the meantime, Save is
disabled and "Reload" fetches the current ones. If stored settings cannot be read, the defaults are
used until you reset them. "Decision roadmap tracker" holds the tracker settings (below).

## Tracker

Approved plan tasks can be mirrored to an issue tracker, starting with SnailOrbit. Local project
data stays the record; the tracker only mirrors it.

- Off by default: the provider is none and the mode is dry run. Change both in the plugin settings
  ("Decision roadmap tracker"), together with the tracker project key. Settings hold no credentials.
- Tracker actions are available only for the latest plan revision while its approval is current.
  "Preview tracker actions" in the plan view shows every action with the exact request that would be
  sent, the destination and the mode. Tasks that will not be sent are listed with the reason.
- Apply confirms the whole previewed batch at once; there is no picking of single actions. If the
  plan, its approval, the settings or the connection changed since the preview, nothing is sent and you are asked to
  preview again. In dry run, Apply checks the batch and sends nothing.
- In live mode each action is recorded locally before it is sent. When an outcome is unclear, for
  example after a timeout, it is marked unknown and never retried automatically, so no duplicate
  issue is created; "Check status" shows what is recorded.
- The plan view lists mapped tickets and intents that need attention, even when approval is not
  current or the tracker is off. "Check status" there only reads what is recorded.
- Live mode uses a plugin-owned connection to SnailOrbit: the `[mcp_servers.snailorbit]` entry in the
  Codex config on this machine (`$CODEX_HOME/config.toml`, or `~/.codex/config.toml` when
  `CODEX_HOME` is unset or empty; a `url` only; entries with headers,
  env, command or tokens are refused). The URL is never shown, stored or logged; only a keyed
  fingerprint is kept, so actions created through one connection are never closed through another.
  The preview reads this config locally and shows whether a live connection is configured; it does
  not contact SnailOrbit, so reachability and access are checked only when you apply.
- Previews show the exact SnailOrbit request (project, subject and text for a new issue; issue and
  close field for a close) in every mode, and that same request is what Apply sends. A new issue's
  text contains the task description, then its Definition of Done when it has one.
- Issues are closed for verified tasks only in projects where you set a close field and value in the
  settings, always in the project where the issue was created.
- Any outcome SnailOrbit does not clearly confirm is recorded as unknown, listed in the plan view and
  never resent automatically. For an unknown or interrupted action you can link the ticket you found
  (it is checked read-only in SnailOrbit through the same connection and must be in the same
  project; a close can only be confirmed for its original, closed ticket), or confirm that nothing
  was created or closed. Only a fresh preview then offers the action again. The plugin also attempts
  to record each resolution outside the project in its plugin data. If that audit write fails, the
  local resolution remains committed and the RPC reports `auditRecorded: false`; the current
  dialog does not display that flag. The audit records that confirmation came through the Paseo UI
  but cannot prove who confirmed it.
- Agents have no tracker tools; tracker actions are confirmed only in the Paseo UI.

Requires Paseo 0.12.0 or later.
