// Automatic grilling S3/G5 (S3-TASKS §3.1–§3.3, §4 H1–H3; PLAN §3.8): the pure grilling header text,
// the manual-recovery line and the action gates of the grilling screen. No React, RN or mocks; the
// module is loaded per case, so a missing module fails each case by name instead of collection.
import { describe, expect, it } from "vitest";
import type { GrillingView, SessionView } from "../shared/rpc";

const load = () =>
  import("./grilling-header").catch((e: unknown) => {
    throw new Error(`missing module client/grilling-header.ts: ${String(e)}`);
  });

const AT = "2026-10-20T10:00:00.000Z";
const MANUAL = "Continue the conversation in the chat, or bind another chat.";
const g = (status: GrillingView["status"], reason?: string, manualRecovery = false): GrillingView => ({
  status,
  manualRecovery,
  ...(reason !== undefined ? { reason } : {}),
  plannerAgentId: "agent-planner-1",
  epoch: 1,
});

/** A hand-built session view; `blocks` omitted for a legacy session. */
function view(o: { grilling?: GrillingView; planner?: boolean; status?: "active" | "closed"; legacy?: boolean } = {}): SessionView {
  return {
    revision: 7,
    session: {
      id: "S",
      title: "Session S",
      createdAt: AT,
      status: o.status ?? "active",
      ...(o.legacy === true
        ? {}
        : {
            blocks: [
              { id: "b1", order: 0, state: "accepted", openedAt: AT, acceptedAt: AT, acceptedBy: { kind: "human" } },
              { id: "b2", order: 1, state: "open", openedAt: AT },
            ],
          }),
      ...(o.planner === true ? { planner: { agentId: "agent-planner-1", workspaceId: "ws-1", boundAt: AT, boundBy: "ask", epoch: 1 } } : {}),
    },
    cancellations: [],
    questions: [],
    links: [],
    catalog: [],
    ...(o.grilling !== undefined ? { grilling: o.grilling } : {}),
  };
}

/** S3-TASKS §3.2, pinned phrases. */
const ROWS: Array<[GrillingView["status"], string | undefined, string]> = [
  ["idle", undefined, "waiting for the chat's next batch"],
  ["waiting_for_answers", undefined, "waiting for answers"],
  ["waiting_for_accept", undefined, "waiting for Accept (card shown in chat)"],
  ["accepted_waiting_for_pause", undefined, "accepted; answering when the chat pauses"],
  ["answering", undefined, "answering…"],
  ["continued", undefined, "continued"],
  ["outcome_unknown", undefined, "outcome unknown: check the chat"],
  ["outcome_unknown", "pending_state_unknown", "outcome unknown: check the chat"],
  ["chat_moved_on", undefined, "the chat moved on; continue there"],
  ["pause_lost", "archived", "unavailable: archived"],
  ["pause_lost", "closed", "unavailable: closed"],
  ["pause_lost", "unavailable", "unavailable: chat not found"],
  ["pause_lost", "no_pause", "the chat did not pause"],
  ["pause_lost", "restart", "pause lost after host restart"],
  ["pause_lost", "turn_ended:canceled", "pause lost: turn ended (canceled)"],
  ["pause_lost", "something else", "pause lost"],
  ["pause_lost", undefined, "pause lost"],
  ["card_mismatch", "2 questions instead of one", "card mismatch"],
  ["unsupported", "codex default mode", "unsupported: codex default mode"],
  ["unsupported", undefined, "unsupported"],
  ["planner_changed", "block_advanced", "superseded by the chat's next batch"],
  ["planner_changed", "rebind", "planner changed"],
  ["planner_changed", undefined, "planner changed"],
  ["needs_manual", "answer_failed", "answer not delivered: answer the card in the chat"],
  ["needs_manual", "no_pause", "the chat did not pause"],
  ["needs_manual", "pause_mismatch: options differ from the template", "card mismatch"],
  ["needs_manual", "unsupported: codex default mode", "unsupported"],
  ["needs_manual", "pause_lost: no_pause", "pause lost"],
  ["needs_manual", "pause_answered_externally", "the chat moved on; continue there"],
  ["needs_manual", "something else", "needs manual recovery"],
  ["needs_manual", undefined, "needs manual recovery"],
  ["complete", undefined, "grilling complete"],
  ["no_planner", undefined, "No planner bound"],
];

describe("H1 grillingStatusText", () => {
  it.each(ROWS)("%s (reason %s) → %s", async (status, reason, phrase) => {
    const { grillingStatusText } = await load();
    expect(grillingStatusText(g(status, reason))).toBe(phrase);
  });

  it("block_advanced is worded distinctly from a rebind's planner changed, and no phrase is empty", async () => {
    const { grillingStatusText } = await load();
    expect(grillingStatusText(g("planner_changed", "block_advanced"))).not.toBe(grillingStatusText(g("planner_changed", "rebind")));
    for (const [status, reason] of ROWS) expect(grillingStatusText(g(status, reason)).length, status).toBeGreaterThan(0);
  });
});

describe("H2 grillingHeader", () => {
  it("is null for a legacy view (no grilling value)", async () => {
    const { grillingHeader } = await load();
    expect(grillingHeader(view({ legacy: true }), "Any title")).toBeNull();
  });

  it("no_planner: exactly 'No planner bound' with the manual recovery line", async () => {
    const { grillingHeader, MANUAL_RECOVERY_TEXT } = await load();
    expect(MANUAL_RECOVERY_TEXT).toBe(MANUAL);
    const unbound: GrillingView = { status: "no_planner", manualRecovery: true };
    expect(grillingHeader(view({ grilling: unbound }), null)).toEqual({ text: "No planner bound", recovery: MANUAL });
  });

  it("names the planner by its chat title, falling back to its agent id for a null or empty title", async () => {
    const { grillingHeader } = await load();
    const v = view({ grilling: g("waiting_for_answers"), planner: true });
    expect(grillingHeader(v, "Claude planner")).toEqual({ text: "Planner: Claude planner · waiting for answers", recovery: null });
    expect(grillingHeader(v, null)?.text).toBe("Planner: agent-planner-1 · waiting for answers");
    expect(grillingHeader(v, "")?.text).toBe("Planner: agent-planner-1 · waiting for answers");
  });

  it("the recovery line is present exactly when manualRecovery is true", async () => {
    const { grillingHeader } = await load();
    expect(grillingHeader(view({ grilling: g("pause_lost", "restart", true), planner: true }), "P")).toEqual({
      text: "Planner: P · pause lost after host restart",
      recovery: MANUAL,
    });
    expect(grillingHeader(view({ grilling: g("continued", undefined, false), planner: true }), "P")?.recovery).toBeNull();
  });
});

// Retry and Finish join the action gates; these cases check the accept, bind and reopen gates.
describe("H3 grillingActions", () => {
  it("legacy session: no accept, no bind, no reopen", async () => {
    const { grillingActions } = await load();
    expect(grillingActions(view({ legacy: true }))).toMatchObject({ accept: false, bind: null, reopen: false });
    // KensAI c9: a closed legacy session offers no Reopen either (the legacy guard precedes the closed one).
    expect(grillingActions(view({ legacy: true, status: "closed" }))).toMatchObject({ accept: false, bind: null, reopen: false });
  });

  it("active with blocks: accept, and Bind without a planner or Change with one", async () => {
    const { grillingActions } = await load();
    expect(grillingActions(view({ grilling: { status: "no_planner", manualRecovery: true } }))).toMatchObject({ accept: true, bind: "bind", reopen: false });
    expect(grillingActions(view({ grilling: g("waiting_for_answers"), planner: true }))).toMatchObject({ accept: true, bind: "change", reopen: false });
  });

  it("active but complete (defensive): no accept; closed: reopen only", async () => {
    const { grillingActions } = await load();
    expect(grillingActions(view({ grilling: g("complete"), planner: true }))).toMatchObject({ accept: false, bind: "change", reopen: false });
    expect(grillingActions(view({ grilling: g("complete"), planner: true, status: "closed" }))).toEqual({ accept: false, bind: null, reopen: true, retry: null, finish: false });
  });
});

// Owner decision: while the planner chat is responding, Retry stays available but carries an
// explicit warning that it will interrupt the current answer. The host interrupts an active turn
// when a message arrives (no queue mode exists), so the warning is the honest description.
describe("Retry while the planner is responding", () => {
  const manual = (lastRetry?: { id: string; at: string; state: "sending" | "sent" | "failed" | "unknown" }) =>
    view({ grilling: { ...g("needs_manual", undefined, true), ...(lastRetry !== undefined ? { lastRetry, retryCount: 1 } : {}) }, planner: true });
  const retryOf = async (v: SessionView, plannerStatus?: string) => {
    const { grillingActions } = await load();
    const actions: unknown = Reflect.apply(grillingActions, undefined, [v, ...(plannerStatus !== undefined ? [{ plannerStatus }] : [])]);
    const retry: unknown = typeof actions === "object" && actions !== null && "retry" in actions ? actions.retry : undefined;
    return typeof retry === "object" && retry !== null ? Object.fromEntries(Object.entries(retry)) : null;
  };

  it("stays available while the chat is running, with a warning that names the interruption", async () => {
    const retry = await retryOf(manual(), "running");
    expect(retry).not.toBeNull();
    expect(retry?.enabled).toBe(true);
    expect(String(retry?.interruptWarning ?? "")).toMatch(/interrupt/i);
  });

  it("carries no interruption warning while the chat is idle", async () => {
    const retry = await retryOf(manual(), "idle");
    expect(retry?.enabled).toBe(true);
    expect(retry?.interruptWarning).toBeUndefined();
  });

  it("a running chat does not re-enable a retry that is blocked by an earlier one", async () => {
    const retry = await retryOf(manual({ id: "r1", at: AT, state: "unknown" }), "running");
    expect(retry?.enabled).toBe(false);
  });
});

// Retry and Finish in the header: Retry only under manual recovery with a bound planner, blocked
// once a retry was sent or its outcome is unknown, available again after a failed one; Finish on an
// active session with blocks (the owner's decision: Finish needs no proposal or manual recovery).
describe("grillingActions retry and finish", () => {
  type Retry = { id: string; at: string; state: "sending" | "sent" | "failed" | "unknown" };
  const manual = (lastRetry?: Retry) => view({ grilling: { ...g("needs_manual", undefined, true), ...(lastRetry !== undefined ? { lastRetry, retryCount: 1 } : {}) }, planner: true });
  const actions = async (v: SessionView): Promise<Record<string, unknown>> => {
    const { grillingActions } = await load();
    return Object.fromEntries(Object.entries(grillingActions(v)));
  };

  it("no Retry while the chat continues on its own, but the owner's Finish is offered in any active session with blocks", async () => {
    const a = await actions(view({ grilling: g("waiting_for_answers"), planner: true }));
    expect(a.retry).toBeNull();
    expect(a.finish).toBe(true);
    expect((await actions(view({ grilling: { status: "no_planner", manualRecovery: true } }))).finish, "without a planner too").toBe(true);
    expect((await actions(view({ legacy: true }))).finish, "a legacy session has no Finish").toBe(false);
  });

  it("under manual recovery with a planner: Retry and Finish", async () => {
    const a = await actions(manual());
    expect(a.retry).toMatchObject({ enabled: true });
    expect(a.finish).toBe(true);
  });

  it("no Retry without a bound planner", async () => {
    expect((await actions(view({ grilling: { status: "no_planner", manualRecovery: true } }))).retry).toBeNull();
  });

  it("a sent retry is shown with its time and blocks another; sending or unknown asks the owner to check, naming the retry", async () => {
    expect((await actions(manual({ id: "r1", at: AT, state: "sent" }))).retry).toMatchObject({ enabled: false, sentAt: AT });
    for (const state of ["sending", "unknown"] as const) {
      expect((await actions(manual({ id: "r1", at: AT, state }))).retry, state).toMatchObject({ enabled: false, unknownSince: AT, retryId: "r1" });
    }
    expect((await actions(manual({ id: "r1", at: AT, state: "failed" }))).retry).toMatchObject({ enabled: true });
  });

  it("the agent's finish proposal offers Finish; a closed session offers none", async () => {
    const proposal = { at: AT, summary: "Done", skipped: [1], outOfScope: [] };
    expect((await actions(view({ grilling: { ...g("idle"), finishProposal: proposal }, planner: true }))).finish).toBe(true);
    expect((await actions(view({ grilling: { ...g("complete"), finishProposal: proposal }, planner: true, status: "closed" }))).finish).toBe(false);
  });
});

// Owner requirement: when the session's language is not English, the warning recommends English for
// the questions (they are ultimately needed in English) and says plainly that nothing is translated
// in this version; it never suggests that questions are translated automatically.
describe("the session language warning", () => {
  const options = [{ id: "en", label: "English" }, { id: "ru", label: "Russian" }];
  const withLanguage = (answer: { optionId?: string; text?: string } | undefined): SessionView => {
    const v = view({ grilling: g("idle"), planner: true });
    const a = answer !== undefined ? { rev: 1, ...answer, source: "ui" as const, actor: { kind: "human" as const }, at: AT } : undefined;
    const question = {
      id: "lang", order: 0, number: 1, title: "Session language", context: "", options, recommendedOptionId: "en", allowFreeText: true, definitionRev: 1,
      activatedBy: [], invalidatedBy: [], discussion: [], tag: "language" as const,
      revisions: a !== undefined ? [a] : [], validity: a !== undefined ? ("valid" as const) : ("unanswered" as const), ...(a !== undefined ? { answer: a } : {}),
    };
    return { ...v, questions: [{ question, visibility: "active", status: a !== undefined ? "answered" : "open", depth: 0, number: 1, links: { question: "roadmap://p/s/S/q/1", answer: "roadmap://p/s/S/q/1/answer" } }] };
  };
  const languageOf = async (v: SessionView) => {
    const mod: unknown = await load();
    const fn: unknown = typeof mod === "object" && mod !== null ? Object.entries(mod).find(([k]) => k === "sessionLanguage")?.[1] : undefined;
    if (typeof fn !== "function") throw new Error("missing export: grilling-header.sessionLanguage");
    const out: unknown = Reflect.apply(fn, undefined, [v]);
    return Object.fromEntries(Object.entries(typeof out === "object" && out !== null ? out : {}));
  };

  it("a non-English language recommends English for the questions and says nothing is translated", async () => {
    for (const answer of [{ optionId: "ru" }, { text: "Deutsch" }]) {
      const warning = String((await languageOf(withLanguage(answer))).warning ?? "");
      expect(warning, JSON.stringify(answer)).toMatch(/recommend/i);
      expect(warning, JSON.stringify(answer)).toMatch(/English/);
      expect(warning, JSON.stringify(answer)).toMatch(/no translation|not translated/i);
      expect(warning, JSON.stringify(answer)).not.toMatch(/will be translated|automatically translated|are translated/i);
      // The rationale, and that the missing translation is a limit of this version.
      expect(warning, JSON.stringify(answer)).toMatch(/ultimately/i);
      expect(warning, JSON.stringify(answer)).toMatch(/needed in English|need(s)? English/i);
      expect(warning, JSON.stringify(answer)).toMatch(/this version/i);
    }
  });

  it("English, chosen or typed, and an unanswered language question carry no warning", async () => {
    for (const answer of [undefined, { optionId: "en" }, { text: "English" }, { text: " en " }]) {
      const lang = await languageOf(withLanguage(answer));
      expect(lang.label, JSON.stringify(answer)).toMatch(/^(English|en)$/i);
      expect(lang.warning, JSON.stringify(answer)).toBeNull();
    }
  });
});

// UI feedback plan U2 (2026-11-09): the effective language is always named (English included); the
// no-translation notice applies to a non-English label until the owner acknowledged that label on
// the session (`session.languageNoticeAck`); a different label needs a new acknowledgement. The
// notice text keeps the wording pinned above.
describe("the session language acknowledgement", () => {
  const withStored = (language: string | undefined, ack?: string): SessionView => {
    const v = view({ grilling: g("idle"), planner: true });
    return { ...v, session: { ...v.session, ...(language !== undefined ? { language } : {}), ...(ack !== undefined ? { languageNoticeAck: { language: ack, at: AT } } : {}) } } as SessionView;
  };
  const languageOf = async (v: SessionView) => {
    const mod: unknown = await load();
    const fn: unknown = typeof mod === "object" && mod !== null ? Object.entries(mod).find(([k]) => k === "sessionLanguage")?.[1] : undefined;
    if (typeof fn !== "function") throw new Error("missing export: grilling-header.sessionLanguage");
    const out: unknown = Reflect.apply(fn, undefined, [v]);
    const o = new Map<string, unknown>(Object.entries(typeof out === "object" && out !== null ? out : {}));
    const notice: unknown = o.get("notice") ?? o.get("warning");
    return { label: o.get("label"), notice: typeof notice === "string" ? notice : null, acknowledged: o.get("acknowledged") };
  };

  it("English is named and carries no notice", async () => {
    for (const language of [undefined, "English"]) {
      const lang = await languageOf(withStored(language));
      expect(lang.label, String(language)).toBe("English");
      expect(lang.notice, String(language)).toBeNull();
    }
  });

  it("a non-English label carries the notice until that label is acknowledged", async () => {
    const open = await languageOf(withStored("Русский"));
    expect(open.label).toBe("Русский");
    expect(open.notice).toMatch(/no translation/i);
    expect(open.acknowledged).toBe(false);
    const done = await languageOf(withStored("Русский", "Русский"));
    expect(done.label).toBe("Русский");
    expect(done.acknowledged).toBe(true);
  });

  it("a different label than the acknowledged one is not acknowledged", async () => {
    const lang = await languageOf(withStored("Deutsch", "Русский"));
    expect(lang.label).toBe("Deutsch");
    expect(lang.notice).toMatch(/no translation/i);
    expect(lang.acknowledged).toBe(false);
  });
});


// c294f12: a legacy session's language is the answer of its tagged question; a long free-text answer
// is its label (notice until acknowledged with exactly that label); an empty or blank free-text answer
// names no language and reads as English with no notice.
describe("legacy free-text language labels", () => {
  const LONG = "Русский, с примерами на английском для технических терминов и названий компонентов";
  const legacy = (text: string, ack?: string): SessionView => {
    const v = view({ grilling: g("idle"), planner: true });
    const a = { rev: 1, text, source: "ui" as const, actor: { kind: "human" as const }, at: AT };
    const question = {
      id: "lang", order: 0, number: 1, title: "Session language", context: "", options: [{ id: "en", label: "English" }], recommendedOptionId: "en", allowFreeText: true, definitionRev: 1,
      activatedBy: [], invalidatedBy: [], discussion: [], tag: "language" as const, revisions: [a], validity: "valid" as const, answer: a,
    };
    return {
      ...v,
      session: { ...v.session, ...(ack !== undefined ? { languageNoticeAck: { language: ack, at: AT } } : {}) },
      questions: [{ question, visibility: "active", status: "answered", depth: 0, number: 1, links: { question: "roadmap://p/s/S/q/1", answer: "roadmap://p/s/S/q/1/answer" } }],
    } as SessionView;
  };
  const languageOf = async (v: SessionView) => {
    const mod: unknown = await load();
    const fn: unknown = typeof mod === "object" && mod !== null ? Object.entries(mod).find(([k]) => k === "sessionLanguage")?.[1] : undefined;
    if (typeof fn !== "function") throw new Error("missing export: grilling-header.sessionLanguage");
    const out: unknown = Reflect.apply(fn, undefined, [v]);
    const o = new Map<string, unknown>(Object.entries(typeof out === "object" && out !== null ? out : {}));
    const notice: unknown = o.get("notice") ?? o.get("warning");
    return { label: o.get("label"), notice: typeof notice === "string" ? notice : null, acknowledged: o.get("acknowledged") };
  };

  it("a long free-text answer is the label, with the notice until exactly that label is acknowledged", async () => {
    const open = await languageOf(legacy(LONG));
    expect(open.label).toBe(LONG);
    expect(open.notice).toMatch(/no translation/i);
    expect(open.acknowledged).toBe(false);
    expect((await languageOf(legacy(LONG, LONG))).acknowledged).toBe(true);
    expect((await languageOf(legacy(LONG, LONG.slice(0, 40)))).acknowledged).toBe(false);
  });

  it("an empty or blank free-text answer reads as English with no notice", async () => {
    for (const text of ["", "   "]) {
      const lang = await languageOf(legacy(text));
      expect(lang.label, JSON.stringify(text)).toBe("English");
      expect(lang.notice, JSON.stringify(text)).toBeNull();
      expect(lang.acknowledged, JSON.stringify(text)).not.toBe(true);
    }
  });
});
