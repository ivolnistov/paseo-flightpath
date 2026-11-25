# Stage 4 card report (2026-10-21)

Cards: `docs/plans/tasks/2026-10-21-stage4.md`. They are documentation only. Based on SPEC §6–§9
and §11, plan Stage 4, platform evidence Contract 3, the accepted feature source `a3647e74` (originally authored against `743022f`; READY T4 commit 1 interfaces re-verified unchanged)
(read-only), the SDK `settings.d.ts` and SnailOrbit MCP tool **schemas**. The schemas were
loaded as metadata only. No tool was invoked, and nothing was sent or written to any tracker.

## Readiness

| Section | Status |
| --- | --- |
| P4.1 contracts/settings/errors, P4.2 adapter interface, payload and token, P4.3 preview/apply/reconcile, P4.4 wiring, P4.5 UI/docs; T4.1–T4.6 | READY |
| P4.6 / T4.7 SnailOrbit live adapter | **NOT READY** (O1, O3) |
| P4.7 / T4.8 resolution of `unknown` intents | **NOT READY** (O2) |

The READY scope delivers the full dry-run product, and live mode answers `tracker_unavailable`.
No live write is authorised.

## Unresolved owner decisions

- **O1, live transport and credential supply.**
  - Contract 3 shows SnailOrbit is reachable on this host through an MCP server, but its
    endpoint and auth are owner configuration, and the plugin server cannot reuse an agent's
    MCP session. Host settings are "not a credential vault" (SPEC §2, §9).
  - Choices requiring the owner:
    - (a) a plugin-side MCP client to an owner-supplied endpoint, with a credential supplied by
      an owner-defined mechanism outside settings;
    - (b) REST via a token (the public client exists, but its contract is unverified for this
      instance);
    - (c) keep the tracker dry-run only for now.
- **O2, human resolution of `unknown` intents.** The SPEC and plan require a human decision but
  define no action. Candidates are: relink the intent to an existing remote key after the owner
  inspects it; mark it not-created to allow a fresh create; or leave it blocked. Each changes
  product behaviour.
- **O3, close semantics.** Closing is an `update_issue` custom-field change (for example
  `State`). The value is project-specific (`get_field_options`), and no setting for it is
  approved.

## Technical notes and gaps (not owner decisions)

- There is no verified idempotency or at-most-once guarantee (Contract 3), so `reconcile`
  never searches remotely. A marker is embedded in the issue body for later human or O2
  inspection only.
- Dry-run apply persists no intents or mappings. This keeps "no mapping without a remote
  write", and a later live create is not blocked by dry-run artefacts.
- The confirm token key lives in plugin-data (0600) and is published no-clobber with the
  Stage 3 `ApprovalFs`.
- As in Stage 3, the server cannot prove which human confirmed a batch. The channel is the UI
  RPC plus the refusal of non-UI origins, and there are no MCP tracker tools.
- The SnailOrbit field mapping in P4.6 comes from tool metadata visible to the coordinator
  session. It is evidence, not a verified plugin-side contract.

## Preserved scope

Stage 4 stays required. Stage 5 (timeline cards, `/roadmap`) is unchanged. Owner approval
semantics (Stage 3) are unchanged.

## Technical corrections after coordinator review (2026-10-21)

1. **No subset selection.** Apply confirms the entire displayed actionable batch (create, and
   close after O3). Skips stay visible, and Apply is disabled for an empty batch.
2. **Stateless action ids.**
   - `actionId = base64url(canonicalJson({ v: 1, intentId, taskId, kind, planRev }))`, decoded
     with a strict schema.
   - Apply rebuilds the exact actionable batch from the fresh plan and settings with those
     `intentId`s, and rejects duplicates, unknown, swapped or incompatible tuples, and subsets.
   - The HMAC binding covers `projectId`, `planId`, `planRev`, `contentHash`, `receiptId`,
     `destination`, `settingsDigest`, `mode`, `storeRevision` and every action's
     `{ actionId, kind, taskId, intentId, idempotencyKey, payload }`.
   - A known-answer test computes the HMAC independently.
3. **Signed payloads are wire payloads.**
   - A live adapter's `render()` output is what the preview shows, the token signs and `send`
     transmits unchanged.
   - Close actions are skipped with "close mapping not configured (O3)" until O3, so no neutral
     close payload is ever signed.
   - Future close config enters the settings and therefore `settingsDigest`.
4. **Per-action recheck in live batches.**
   - Before each remote call, under the `pending` transaction at the batch's own revision, the
     server rechecks the plan revision and hash, the verified current approval, settings and
     destination.
   - A foreign write or a changed basis stops the remaining actions (`not_attempted`), while an
     outcome already received is still recorded through bounded retries.
   - A two-action barrier test covers this.
5. **Corrected crash tests.**
   - A failure injected between `pending` and `sent` (wrapping store) gives zero adapter calls,
     and after restart the task is interrupted and not re-sent.
   - Remote confirmed but local commit failed gives `unknown` "outcome not recorded" with no
     mapping claimed, and after restart there is no blind duplicate.

O1, O2 and O3 remain pending with the owner. P4.6/P4.7 and T4.7/T4.8 stay NOT READY.
Remaining technical gap: the live wire mapping depends on O1/O3, so the evidence is still the
coordinator-visible tool metadata only.

## P4.5 list gap and error precedence (2026-10-21, evidence `af46559` on `2f1ec4c`)

- **Gap.** `PlanView` omits intents and tickets, preview requires a current approval, and
  reconcile needs a known id. So the approved persistent plan-view list could not be supplied.
- **Added P4.8 `tracker.list`.** It is read-only, plugin RPC only, takes `{ projectId, planId }`
  through canonical resolution, and makes one `store.read`. It does not use currency,
  settings, the adapter, the token key, a transaction or the export.
  - It returns tickets (with `taskId`/`planRev` joined via `intentId`, plus `remoteKey`, `url`,
    `state`, `lastSyncAt`) and non-confirmed intents (`intentId`, `taskId`, `planRev`, `kind`,
    `state`, `errorClass`, a derived `interrupted`, and timestamps).
  - It never returns payloads, destination, keys, tokens, settings or receipts.
  - `STAGE4_CONTRACTS` goes from 3 to 4 deliberately. The MCP tools stay at 13, with no tracker
    power.
  - The plan view lists tickets and attention items for every plan, regardless of approval or
    provider, with read-only Check status. There is no O2 resolve and no O3 close.
  - Turns: T4.9 red, then P4.8, then independent green.
- **Error precedence reconciled with ruling 2.** The order is: stale `expectedRevision` →
  `revision_conflict`; fresh revision but not current → `tracker_not_current`; current but
  batch, token or settings drift → `tracker_token_mismatch`. The earlier blanket T4.5 drift
  wording is corrected.
- No owner decision is needed. This completes a technical gap inside the approved list
  requirement. O1, O2 and O3 remain pending.
- **P4.8 also carries four narrow UI lifecycle corrections** (coordinator source notes, no
  runtime reproduction):
  1. Apply is guarded during a preview load;
  2. stale request generations are ignored after close or reopen;
  3. captions are pinned with the preview;
  4. Save uses the settings revision captured with the draft.

  These are checked by producer self-check and independent source review. Stage 3 pinning is
  unchanged, and there are no new product choices.

## Successor after owner rulings O1–O3 (2026-10-21; base `19a33ef`, review range `19a33ef..HEAD`)

All P4.6, P4.7, T4.7 and T4.8 sections are **READY**. No live write is authorised.
Implementation and tests use loopback fakes only, and never read the real connection.

- **O1, P4.6.** The connection source is the verified Codex-native `[mcp_servers.snailorbit]`
  entry (`CODEX_HOME` or `~/.codex/config.toml`), parsed with `smol-toml@1.9.1`. The accepted
  shape is url-only; missing, invalid or unsupported config fails closed. There is no fallback
  precedence and no hook capture. The URL is secret-bearing and lives only in per-call memory:
  never logged, persisted, displayed or put in errors.
  - The client is plugin-owned, using `@modelcontextprotocol/sdk@1.32.1` `Client` +
    `StreamableHTTPClientTransport`. The SDK moves to runtime dependencies; the host's 1.29 is
    not used.
  - Tool contract check: `listTools` must offer `create_issue`/`update_issue`/`get_issue` with
    the catalog-required keys. The adapter's `render` output is previewed, signed and sent
    unchanged.
  - Error classes: `isError` → definitive; failure after send → ambiguous; failure before send
    → definitive.
  - `url: ""`, because the response has no web URL and none is invented.
- **O3, P4.6.** Settings v2 `closeByProject[projectKey] = { field, value }` (migration from v1)
  enters `settingsDigest`. The close wire is `update_issue { issue_id, fields: { field: value } }`
  and is shown and signed. Close is only for verified, mapped tasks of a current approved plan,
  with the same durable intent and unknown recovery as create. `is_closed: false` after an
  update gives `close_not_effective`.
- **O2, P4.7.** `tracker.resolve` is UI-only, guarded by intent, `planRev` and store revision.
  It resolves only `unknown` or interrupted `pending`/`sent` intents.
  - `link`: one read-only `get_issue` plus a project check (and `is_closed` for close intents)
    before the local mapping.
  - `not_created`: an explicit confirmation that marks the intent `failed`
    (`human_not_created`), which releases the key for a fresh preview and token.
  - A durable plugin-data audit is written (no-clobber, 0600). There is no search, no send and
    no idempotency assumption.
  - `STAGE4_CONTRACTS` goes from 4 to 5 deliberately. The MCP tools stay at 13.

**Limits:**
- endpoint reachability and auth are unverified until the owner's live use;
- schema drift is caught by the `listTools` check;
- only the Codex-native source is supported, so other connection sources fail closed;
- tickets have no web URL.

**Owner decisions:** none remain open for Stage 4. Live writes still require the
mode/confirmation/publication gate.

## Pre-dispatch technical corrections (2026-10-21; no new owner decision)

**Baseline gate.** The coordinator reports ordinary KensAI on frozen `19a33ef` was complete:
score 0, no BUG findings. C15 confirmed that the timeout did not cancel the underlying request,
and concerns C2, C13, C16–C19, C22 and C23 are folded into this successor. Review docs are not
edited here.

1. **Error classification (evidence-bound).** No authoritative pre-write rejection is
   documented for SnailOrbit or MCP. So `isError`, transport failures, aborts and unparsable
   results after a write call are **ambiguous**, the intent goes to `unknown`, and nothing is
   re-sent. Only snapshot, connect, `listTools` or contract failures before a write call are
   definitive. A close returning `is_closed: false` gives ambiguous `close_unconfirmed`. No
   idempotency is assumed.
2. **Connection identity.**
   - `ConnectionSnapshot` keeps the URL in a private field, and `toJSON` exposes only the
     fingerprint.
   - The fingerprint is `base64url(HMAC-SHA256(trackerKey, "snailorbit-conn:v1\n" + url))`,
     taken from a local-only read.
   - It is bound into `Binding.connectionFp` and into the persisted intent `destination`
     (`canonicalJson({ provider, projectKey, connectionFp })`, with no schema change).
   - Apply uses one snapshot for the whole batch, and the per-action recheck stops on a
     fingerprint change. Resolve `link` requires the intent's fingerprint.
   - The raw URL never appears in outputs, logs, the store, receipts or audit records.
3. **Lenient response parsing.** Required fields are type-validated with `passthrough`, and a
   rich catalog fixture is tested. The request wire stays exact.
4. **Abort.** `send` and `get` take an `AbortSignal`, and the SDK request options carry
   `{ signal, timeout }`. A timeout aborts the request and closes the session in `finally`. A
   test observes the abort and the cleanup.
5. **UI and copy (P4.10):**
   - C16: loading or error settings never show "choose a provider";
   - C23: Save is disabled with a Reload when settings changed elsewhere;
   - C18: `revision_conflict` → Preview again, and the held Apply is disabled;
   - C2/C19: the banner and hint use the preview's `liveAvailable`/`unavailableReason`;
   - an audit of the footer and stopped-batch copy.
6. **Tests (T4.10):**
   - C13: a full dry-run oracle;
   - C17: the exact `not_attempted`/`intent_not_sent` result with zero sends;
   - C22: a positive fingerprint log oracle.

   No timeout values are increased.

**Readiness:** all sections READY. The frozen `19a33ef`, the 13 MCP tools and the Stage 3
contracts are preserved. The adapter interface change (`connect`/session) is a deliberate
successor edit in P4-owned `adapter.ts`.

## Final consistency refinement (2026-10-21)

- **(a) C-WIRE.** Create and close previews show the actual would-be wire from the pure
  `renderSnailOrbit` in every mode: `{ project_id, subject, text }` and
  `{ issue_id, fields }`. That exact object is signed and sent. Preview makes no network call.
- **(b) C-DEST.** Close takes the provider, `projectKey` and `connectionFp` from the mapping's
  original create-intent destination. `closeByProject` is looked up by the original key. If
  the provenance is missing or the current connection differs, the close is skipped with no
  remote call. There are regressions for settings A→B and for connection drift.
- **(c) `liveAvailable`.** It reports local config and adapter capability only, with no
  reachability or auth guarantee. The banner wording is honest and never says "connected".
- **(d) O2 for close.** `not_created` on a close intent records `human_close_not_applied`: the
  close was not applied, the mapping stays `created`, and a fresh close preview is allowed.
  Create keeps `human_not_created`, and the UI wording depends on the intent kind.
- **(e)** The connection-read paragraph now matches the snapshot lifecycle (preview local,
  apply per batch, resolve per call). `get` null or an error gives "could not verify" with no
  write.

All sections are READY, and no owner decision is needed.
