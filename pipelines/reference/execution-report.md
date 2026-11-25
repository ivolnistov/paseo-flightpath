# Execution workspace mock — report

Visual exploration only. There are no real agents, sends, APIs or task execution. All UI text is Russian.

## Files

- `execution-workspace.html` — inline fragment (about 31 KB, root `#exm-root`).
- `preview/execution.html` — direct standalone document, no iframe (about 98 KB with the
  runtime). Open `/execution.html?layout=desktop` or `/execution.html?layout=phone`
  on the existing static server.
- The accepted roadmap mock and `preview/index.html` are untouched.

## Composition

One responsive app plus an external preview toggle `.exm-pv` (Широкий экран / Телефон). The
toggle sets `.exm-stage[data-layout="phone"]` to `max-width: 393px`, so the phone layout
comes from the container query. The toggle is hidden when the real width is ≤600px. The
`?layout=` query sets the initial value. The scenario utility `details.exm-util` «Сценарии
макета» sits below the app, collapsed, outside the product: Агент работает /
Нужен ответ / Результат этапа (`[data-scn]`).

- **Wide (>600px container):** fixed `--desk-h: 660px` app. Stages sidebar is 240px
  (`nav.exm-stages`). On the right: an agent strip, the transcript (scrolls, max 700px column)
  and the composer. Header: feature title, «Этап 2 из 4 · Синхронизация», 4-segment
  progress, status chip, «План», «Изменения».
- **Phone (≤600px container):** `--phone-h: 640px`. Header is about 52px: «Этапы» button,
  short title «Офлайн-режим», icon «Изменения». One screen at a time: transcript, the stages
  screen (`.exm-body.is-stages`), diff or plan. Picking a stage returns to the transcript.
  The composer and stop button are at the bottom, outside the scroll.
- Top-level standalone (`#exm-root[data-top]`) uses `min(--desk-h|--phone-h, 100dvh)`.
  Inside an auto-height iframe the px height is fixed, so there is no vh loop. No
  `position: fixed`.

## Key selectors and data-k

- Header: `[data-k="m-stages"]` (phone), `[data-k="h-plan"]`, `[data-k="h-diff"]`
  (disabled outside stage 2).
- Stages: `button.exm-st[data-n="1..4"]` (`aria-current` on the selected one),
  `[data-k="to-cur"]` «К текущему этапу».
- Transcript: `details.exm-tool[data-key]` (collapsed tool/log),
  `details.exm-steps` «Шаги плана», `[data-k="t-plan"]` «Открыть план».
- Composer: `#exm-input` (16px), `[data-k="send"]` (submit → local echo marked
  «демо · агенту не отправлено», draft cleared), `[data-k="stop"]` (stop ⇄ «Продолжить
  (демо)»).
- Needs-answer: `[data-k="b-showq"]` «Показать вопрос», `#exm-q`,
  `input[name="exm-q"]`, `[data-k="q-send"]` «Ответить и продолжить».
- Diff and plan: `[data-k="back"]` «К чату»; the draft is kept.
- Result: `[data-k="r-diff"]`.

## Status semantics shown

- Выполняется, Остановлен, Нужен ответ, Ждёт проверок, Сделан, Не начат.
- In the result scenario the agent has finished and code checks passed (✓). Independent
  review is «● ожидает», and stage 2 stays «Ждёт проверок», not «Сделан».
- Stages 3–4 are «Не начат». They show the dependency and a disabled «Запустить этап», and
  have no invented history.
- The plan is shown read-only as «ревизия 2 · утверждена», with no repeat approval.

## Checks

- `node --check`: fragment script OK; script inside `preview/execution.html` OK.
- Stubbed-DOM node simulation passes:
  - `?layout=phone`;
  - stop and resume;
  - diff, then back with the draft preserved;
  - local echo send;
  - phone stages screen, stage 3 locked with no composer, stage 1 built, return to stage 2;
  - plan view;
  - needs-answer show/pick/answer, then continue;
  - result keeps review pending;
  - no `undefined`/`NaN`.
- Not done: real browser/touch rendering at 320/360/393/416/1024 (coordinator).

## Export steps

1. `python3 -I <visualize>/scripts/render.py <abs>/execution-workspace.html <abs>/preview/_exec-shell-export.html --title "Выполнение этапа — макет" --force`
2. stdlib `HTMLParser` (`convert_charrefs=True`) reads `iframe#codex-visualization`
   `data-srcdoc`.
3. Replace `__CODEX_VISUALIZATION_WIDGET_STATE__` with
   `{"widgetState":null,"statePersistence":"none"}`.
4. Save as `preview/execution.html`, then delete the intermediate file.

## Limits

- The fragment is slightly over the 30 KB target (about 31 KB, Cyrillic is 2 bytes/char).
- Transcript content is static per scenario; only local echoes, stop/resume and the
  answer change it.
- In the standalone preview, host-only bridge features (state persistence, follow-ups) do nothing.
- Tool/log `details` open state persists; stage-1 transcript is intentionally not shown.
- Top-right 90×50 host area is not reserved on the phone layout.

## Follow-up corrections

- The stopped strip now reads «Остановлен вами. Уже внесённые изменения сохранены». There is no
  rollback implied.
- The needs-answer acknowledgement follows the chosen option: «Ответ принят (демо): <следствие
  выбранного варианта>. Продолжаю с выбранным вариантом.» Each of keep/drop/restore has its
  own consequence text. Still local-only.
- `preview/execution.html` was regenerated with the same 4 export steps. `node --check` passes on the
  fragment and the preview. The stub check confirms the stop wording and all three answer texts.

## Follow-up: 320px composer clipping

- On the phone layout the resume control is now an icon button: `.exm-resume`, 44×44,
  `aria-label="Продолжить (демо)"`. Its visible text shows only on wide. While stopped, the hint
  line says «Агент остановлен: ▶ — продолжить (демо).»
- `.exm-crow` has `min-width:0`, and its buttons are `flex:none`. The textarea stays `flex:1; min-width:0`
  with `min-height:44px` on phone. Send, stop and resume are 44×44 on phone.
  Expected at 320px (computed from CSS, not measured): about 194px textarea + 2×44px buttons
  + 2×8px gaps inside the 294px row.
- The needs-answer banner text is `flex:1 1 120px; min-width:0` and the button is `flex:none`, so the row
  wraps instead of overflowing.
- Preview regenerated; `node --check` passes on both. A real-browser geometry check is still needed.
- Phone: every `.exm-btn` has `min-width:44px`; this includes the header icon button `h-diff`, which was 40px.
  The textarea has `min-height:44px` (border-box) on phone. Preview regenerated; `node --check` passes.
