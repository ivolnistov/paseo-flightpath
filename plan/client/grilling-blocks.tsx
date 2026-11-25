// Grilling screen: the selected block's questions as cards on a canvas with a blocks-only navigator
// beside it (wide) or above it (compact), the chat's finish proposal as its own item and canvas, the
// add-question form and Accept under the open block, and the notices that stay visible outside the
// Chat menu. Helpers are function declarations: the card and answer panel modules import them, and
// this module imports the card back; nothing calls across the cycle while the modules load.
import type { PluginTheme } from "@getpaseo/plugin";
import { useAgent } from "@getpaseo/plugin/client";
import { Icon, Modal, ScrollView, copyText, useToast } from "@getpaseo/plugin/client/react-native";
import { createRef, useEffect, useRef, useState, type RefObject } from "react";
import { Pressable, Text, View, type ScrollView as NativeScrollView } from "react-native";
import type { Cancellation, Ref } from "../shared/model";
import type { SessionView } from "../shared/rpc";
import { currentAnswer } from "../shared/status";
import { BlockAccept } from "../shared/rpc-blocks";
import { SessionLanguageNoticeAck } from "../shared/rpc-grilling";
import { DiscussionRetryCheck, DiscussionRetryResolve, SessionFinish } from "../shared/rpc-discussion";
import { AddQuestionForm, useAddQuestion, type AddQuestion } from "./add-question-form";
import { Chip, webAria } from "./discussion-ui";
import { TOOLS_STATE, closureLine, emptyBlockLine, grillingActions, grillingHeader, sessionLanguage } from "./grilling-header";
import { useRoadmapMutation, type FinishMutation } from "./hooks";
import { HiddenQuestions } from "./hidden-questions";
import type { Focus } from "./link-target";
import type { ParsedLink } from "../shared/links";
import { QuestionCanvasCard } from "./question-canvas-card";
import { qLabel } from "./question-number";
import { ActionButton, lucideName } from "./roadmap-screen";
import { TARGET_SIZE } from "./theme";
import { registerTooltipBoundary, TooltipLayer } from "./tooltip";
import { Muted } from "./ui";

// The session header's Chat menu belongs to this screen's controls.
export { ChatMenu, type ViewMode } from "./chat-menu";

export type BlockGroup = {
  key: string;
  legacy: boolean;
  state: "open" | "accepted" | "legacy-active" | "legacy-closed";
  blockId?: string;
  order: number;
  acceptedAt?: string;
  questionIds: string[];
};

export type Selection = { groupKey: string; questionId: string | null };

export type Replacement = { ref: Ref; title: string; sessionTitle: string; sameSession: boolean };

/**
 * Stored blocks in order with their active questions; a legacy session is one derived, never-frozen
 * group. Hidden (inactive) questions are listed apart, in the hidden section.
 */
export function blockGroups(view: SessionView): BlockGroup[] {
  const blocks = view.session.blocks;
  if (blocks === undefined) {
    return [
      {
        key: "legacy",
        legacy: true,
        state: view.session.status === "active" ? "legacy-active" : "legacy-closed",
        order: 0,
        questionIds: view.questions.filter((qv) => qv.visibility === "active").map((qv) => qv.question.id),
      },
    ];
  }
  return [...blocks]
    .sort((a, b) => a.order - b.order)
    .map((b) => ({
      key: `block:${b.id}`,
      legacy: false,
      state: b.state,
      blockId: b.id,
      order: b.order,
      ...(b.state === "accepted" ? { acceptedAt: b.acceptedAt } : {}),
      questionIds: view.questions.filter((qv) => qv.question.blockId === b.id && qv.visibility === "active").map((qv) => qv.question.id),
    }));
}

export function openBlockId(view: SessionView): string | undefined {
  return view.session.blocks?.find((b) => b.state === "open")?.id;
}

export function groupLabel(group: BlockGroup): string {
  return group.legacy ? "All questions" : `Block ${group.order + 1} (${group.state === "open" ? "open" : "accepted"})`;
}

/** True when the question belongs to an accepted stored block; never for a legacy session. */
export function isFrozen(view: SessionView, questionId: string): boolean {
  const blockId = view.questions.find((qv) => qv.question.id === questionId)?.question.blockId;
  return blockId !== undefined && view.session.blocks?.find((b) => b.id === blockId)?.state === "accepted";
}

export function cancellationOf(view: SessionView, questionId: string): Cancellation | undefined {
  return (view.cancellations ?? []).find((c) => c.ref.sessionId === view.session.id && c.ref.questionId === questionId);
}

/** Why ordinary mutations are hidden; frozen wins over cancelled, matching the server's check order. */
export function readOnlyReason(view: SessionView, questionId: string): "frozen" | "cancelled" | null {
  if (isFrozen(view, questionId)) return "frozen";
  if (cancellationOf(view, questionId)) return "cancelled";
  return null;
}

/** The decision that replaces this one through a question-to-question `supersedes` link. */
export function replacementOf(view: SessionView, questionId: string): Replacement | undefined {
  const link = view.links.find(
    (l) => l.kind === "supersedes" && "questionId" in l.to && l.to.sessionId === view.session.id && l.to.questionId === questionId && "questionId" in l.from,
  );
  if (!link || !("questionId" in link.from)) return undefined;
  const ref = { sessionId: link.from.sessionId, questionId: link.from.questionId };
  const entry = view.catalog.find((c) => c.ref.sessionId === ref.sessionId && c.ref.questionId === ref.questionId);
  return { ref, title: entry?.questionTitle ?? ref.questionId, sessionTitle: entry?.sessionTitle ?? ref.sessionId, sameSession: ref.sessionId === view.session.id };
}

export function decisionMarks(
  view: SessionView,
  questionId: string,
): { cancelled?: { reason: string }; replacedBy?: Replacement; frozen: boolean; chosen?: string } {
  const q = view.questions.find((qv) => qv.question.id === questionId)?.question;
  const cancellation = cancellationOf(view, questionId);
  const replacement = replacementOf(view, questionId);
  const answer = q !== undefined ? currentAnswer(q) : undefined;
  const chosen = answer ? (answer.text !== undefined ? `“${answer.text}”` : (q?.options.find((o) => o.id === answer.optionId)?.label ?? answer.optionId)) : undefined;
  return {
    ...(cancellation ? { cancelled: { reason: cancellation.reason } } : {}),
    ...(replacement ? { replacedBy: replacement } : {}),
    frozen: isFrozen(view, questionId),
    ...(chosen !== undefined ? { chosen } : {}),
  };
}

/** The current question: the first unanswered of the open block, else its first; else the last group's first. */
export function defaultSelection(view: SessionView): Selection {
  const groups = blockGroups(view);
  const open = groups.find((g) => !g.legacy && g.state === "open");
  if (open) {
    const unanswered = open.questionIds.find((id) => !view.questions.find((qv) => qv.question.id === id)?.question.answer);
    return { groupKey: open.key, questionId: unanswered ?? open.questionIds[0] ?? null };
  }
  const last = groups[groups.length - 1];
  return { groupKey: last?.key ?? "legacy", questionId: last?.questionIds[0] ?? null };
}

/** The selection still valid in this view, else the default. Pure and idempotent. */
export function resolveSelection(view: SessionView, current: Selection | null): Selection {
  if (current) {
    const group = blockGroups(view).find((g) => g.key === current.groupKey);
    if (group && (current.questionId === null ? group.questionIds.length === 0 : group.questionIds.includes(current.questionId))) return current;
  }
  return defaultSelection(view);
}

/** The previous or next question within the group; null past either end. */
export function stepQuestion(group: BlockGroup, questionId: string | null, delta: -1 | 1): string | null {
  if (questionId === null) return null;
  const index = group.questionIds.indexOf(questionId);
  if (index < 0) return null;
  return group.questionIds[index + delta] ?? null;
}

/**
 * The automatic-grilling status line (S3/G5): planner chat title (client state, else its agent id), the
 * status phrase and, when the owner must act, the manual recovery hint. The title hook runs on every
 * render (an empty id reads no agent), so the hook order never depends on the binding.
 */
export function GrillingHeaderBar(props: { view: SessionView; theme: PluginTheme }) {
  const { view, theme } = props;
  const title = useAgent(view.grilling?.plannerAgentId ?? "", (a) => a.title);
  const header = grillingHeader(view, title);
  if (header === null) return null;
  return (
    <View style={{ gap: 2, minWidth: 0, flexShrink: 0 }}>
      <Text style={{ color: theme.colors.foreground, fontWeight: "600", flexShrink: 1 }}>{header.text}</Text>
      {header.recovery !== null ? <Text style={{ color: theme.colors.foregroundMuted, flexShrink: 1 }}>{header.recovery}</Text> : null}
    </View>
  );
}

/** "2 questions · Q1–Q2", "2 questions · Q1, Q3", "No questions yet". */
export function rangeText(view: SessionView, questionIds: string[]): string {
  if (questionIds.length === 0) return "No questions yet";
  const numbers = questionIds
    .map((id) => view.questions.find((qv) => qv.question.id === id)?.number)
    .filter((n): n is number => n !== undefined)
    .sort((a, b) => a - b);
  const count = `${questionIds.length} ${questionIds.length === 1 ? "question" : "questions"}`;
  if (numbers.length === 0) return count;
  const contiguous = numbers.every((n, i) => i === 0 || n === numbers[i - 1] + 1);
  const range =
    numbers.length === 1
      ? qLabel(numbers[0])
      : contiguous
        ? `${qLabel(numbers[0])}–${qLabel(numbers.at(-1)!)}`
        : `${numbers.slice(0, 4).map(qLabel).join(", ")}${numbers.length > 4 ? ", …" : ""}`;
  return `${count} · ${range}`;
}

const PROPOSAL_KEY = "proposal";
const when = (iso: string) => iso.replace("T", " ").slice(0, 16);

/** The block (or the proposal) shown on the canvas: the owner's choice while it exists, else the open block, else the last. */
function shownKey(groups: BlockGroup[], chosen: string | null, proposalShown: boolean): string {
  if (chosen === PROPOSAL_KEY && proposalShown) return PROPOSAL_KEY;
  if (chosen !== null && groups.some((g) => g.key === chosen)) return chosen;
  return (groups.find((g) => !g.legacy && g.state === "open") ?? groups[groups.length - 1])?.key ?? "legacy";
}

/**
 * The notices that stay visible outside any menu, under the stage strip (plan r4 §2.1): the planner
 * status line and manual-recovery hint, the roadmap tools state, the retry line, an unknown delivery
 * with Check chat / Mark as delivered / Mark as not delivered, the interruption warning while Retry is
 * enabled with one, and the closure line. The Grilling view draws them above its canvas; the session
 * screen draws them above the Map. Each control acts on this view's session only.
 */
export function SessionNotices(props: { hostId: string; projectId: string; view: SessionView; theme: PluginTheme }) {
  const { hostId, projectId, view, theme } = props;
  const check = useRoadmapMutation(hostId, projectId, DiscussionRetryCheck);
  const resolve = useRoadmapMutation(hostId, projectId, DiscussionRetryResolve);
  // The planner's status from the host's client state; null (unknown) is never taken as idle.
  const plannerStatus = useAgent(view.session.planner?.agentId ?? "", (a) => a.status) ?? null;
  return sessionNotices(view, theme, grillingActions(view, { plannerStatus }), check, resolve);
}

/** The notice row itself, drawn by `SessionNotices` and inline by the Grilling view (one copy each). */
function sessionNotices(
  view: SessionView,
  theme: PluginTheme,
  actions: ReturnType<typeof grillingActions>,
  check: ReturnType<typeof useRoadmapMutation<typeof DiscussionRetryCheck>>,
  resolve: ReturnType<typeof useRoadmapMutation<typeof DiscussionRetryResolve>>,
) {
  const r = actions.retry;
  const closed = closureLine(view);
  const tools = view.grilling?.tools;
  return (
    <View style={{ gap: 4, minWidth: 0, flexShrink: 0 }}>
      {view.grilling !== undefined ? <GrillingHeaderBar view={view} theme={theme} /> : null}
      {tools !== undefined ? (
        <Text style={{ fontSize: 13, color: tools === "attached" ? theme.colors.foregroundMuted : theme.colors.statusWarning, flexShrink: 1 }}>{`Roadmap tools: ${TOOLS_STATE[tools]}`}</Text>
      ) : null}
      {r?.sentAt !== undefined ? <Text style={{ fontSize: 13, color: theme.colors.foregroundMuted }}>{`${r.automatic === true ? "Continuation sent automatically" : "Retry sent"} at ${when(r.sentAt)}`}</Text> : null}
      {r?.unknownSince !== undefined && r.retryId !== undefined ? (
        <>
          <Text style={{ color: theme.colors.statusWarning, flexShrink: 1 }}>
            {`Delivery outcome unknown since ${when(r.unknownSince)}: check the chat, then mark whether the ${r.automatic === true ? "continuation" : "retry"} arrived.`}
          </Text>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            <ActionButton label="Check chat" theme={theme} disabled={check.pending} onPress={() => void check.run({ sessionId: view.session.id, retryId: r.retryId! })} />
            <ActionButton
              label="Mark as delivered"
              theme={theme}
              disabled={resolve.pending}
              onPress={() => void resolve.run({ sessionId: view.session.id, retryId: r.retryId!, outcome: "delivered" }, { expectedRevision: view.revision })}
            />
            <ActionButton
              label="Mark as not delivered"
              theme={theme}
              disabled={resolve.pending}
              onPress={() => void resolve.run({ sessionId: view.session.id, retryId: r.retryId!, outcome: "not_delivered" }, { expectedRevision: view.revision })}
            />
          </View>
        </>
      ) : null}
      {r?.interruptWarning !== undefined && r.enabled ? <Text style={{ color: theme.colors.statusWarning, flexShrink: 1 }}>{r.interruptWarning}</Text> : null}
      {closed !== null ? <Text style={{ fontSize: 13, color: theme.colors.foregroundMuted, flexShrink: 1 }}>{closed}</Text> : null}
    </View>
  );
}

export function GrillingBlocks(props: {
  hostId: string;
  projectId: string;
  view: SessionView;
  theme: PluginTheme;
  compact: boolean;
  onOpenRef?(ref: Ref): void;
  /** Opens another session of this project (a link whose end is a whole session). */
  onOpenSession?(sessionId: string): void;
  /**
   * Explicit navigation: a new nonce selects the question's block once and outlines the card;
   * background rerenders never do. `focus` points at the current answer or a history revision;
   * `showHidden` opens the hidden list.
   */
  target?: { questionId: string; nonce: number; focus?: Focus; showHidden?: boolean };
  /** Opens a roadmap link or Q<n> mentioned in this session's text. */
  onOpenLink?(link: ParsedLink | number): void;
  /** The host's navigation to a chat; absent on hosts without it. */
  openAgent?(agentId: string): void;
  /** The screen's one session.finish request, shared with the Chat menu so only one finish is ever in flight. */
  finish?: FinishMutation;
  /**
   * What the session screen keeps across a switch to the Map and back (plan §12.7: the selection is
   * kept for the session): the add form (draft, outcome, notice, request in flight), and the chosen
   * block with the last link target applied, so a remount neither resets the choice nor applies an old
   * link again. Without it the canvas keeps its own.
   */
  kept?: { add: AddQuestion; selection: { current: { chosen: string | null; appliedNonce: number | null } } };
}) {
  const { hostId, projectId, view, theme, compact, onOpenRef, target, openAgent, onOpenLink } = props;
  const [focus, setFocus] = useState<{ questionId: string; focus: Focus; nonce: number } | null>(null);
  const [hiddenOpen, setHiddenOpen] = useState<number | null>(null);
  const accept = useRoadmapMutation(hostId, projectId, BlockAccept);
  const ownFinish = useRoadmapMutation(hostId, projectId, SessionFinish);
  const finish = props.finish ?? ownFinish;
  // The planner's status from the host's client state; null (unknown) is never taken as idle.
  const plannerStatus = useAgent(view.session.planner?.agentId ?? "", (a) => a.status) ?? null;
  const check = useRoadmapMutation(hostId, projectId, DiscussionRetryCheck);
  const resolve = useRoadmapMutation(hostId, projectId, DiscussionRetryResolve);
  const [chosen, setChosen] = useState<string | null>(() => props.kept?.selection.current.chosen ?? null);
  const [highlight, setHighlight] = useState<{ questionId: string; nonce: number } | null>(null);
  const [appliedNonce, setAppliedNonce] = useState<number | null>(() => props.kept?.selection.current.appliedNonce ?? null);
  // The screen's copy follows each commit (never written while rendering).
  const keptSelection = props.kept?.selection;
  useEffect(() => {
    if (keptSelection !== undefined) keptSelection.current = { chosen, appliedNonce };
  });
  const [localNonce, setLocalNonce] = useState(0);
  const ackNotice = useRoadmapMutation(hostId, projectId, SessionLanguageNoticeAck);
  // The label acknowledged by this screen's own Got it, until the refetched view carries it.
  const [ackedHere, setAckedHere] = useState<string | null>(null);
  const [summaryOpen, setSummaryOpen] = useState(false);
  const summaryRef = useRef<View | null>(null);
  const ownAdd = useAddQuestion(hostId, projectId, view);
  const add = props.kept?.add ?? ownAdd;
  // The scroll region clips the tooltips of the controls inside it, so their placement uses its frame.
  const bodyRegion = useRef<NativeScrollView | null>(null);
  useEffect(() => registerTooltipBoundary(bodyRegion), []);
  // A link's outline fades after 1.5 s.
  const fading = useRef<number | null>(null);
  useEffect(() => {
    if (highlight === null || fading.current === highlight.nonce) return;
    fading.current = highlight.nonce;
    const nonce = highlight.nonce;
    const timer = setTimeout(() => setHighlight((h) => (h?.nonce === nonce ? null : h)), 1500);
    return () => clearTimeout(timer);
  }, [highlight]);
  // A link scrolls the canvas to its card once the card is laid out: the card's offset in the list,
  // the list's in the canvas and the canvas's in the scroll content, each from onLayout.
  const offsets = useRef<{ canvas: number | null; list: number | null; cards: Map<string, number> }>({ canvas: null, list: null, cards: new Map() });
  const pendingScroll = useRef<string | null>(null);
  // Each card's view, so the scroll can measure the target against the scroll content directly: that
  // does not depend on the card list reporting its layout again, which React Native Web may skip.
  const cardRefs = useRef(new Map<string, RefObject<View | null>>());
  const cardRef = (id: string) => {
    let r = cardRefs.current.get(id);
    if (r === undefined) {
      r = createRef<View>();
      cardRefs.current.set(id, r);
    }
    return r;
  };
  // A card whose measurement failed for the current request is scrolled to by its reported offsets
  // from then on, instead of measuring again on every layout report.
  const measureFailed = useRef<string | null>(null);
  // Each scroll request's number: a measurement answers for the request that asked, and only the latest
  // request may scroll. React Native Web answers in request order (a timeout per measurement), so this
  // only drops a scroll toward an earlier target that a newer one replaces anyway; a host that answered
  // out of order could otherwise end on the earlier target.
  const scrollRequest = useRef(0);
  /** Scrolls to the card by the offsets reported in the shown block (reset when the block changes). */
  const scrollByOffsets = (id: string) => {
    const o = offsets.current;
    const y = o.cards.get(id);
    if (y === undefined || o.list === null || o.canvas === null) return;
    pendingScroll.current = null;
    bodyRegion.current?.scrollTo({ y: Math.max(0, o.canvas + o.list + y - 12), animated: true });
  };
  const tryScroll = () => {
    const id = pendingScroll.current;
    if (id === null) return;
    const card = cardRefs.current.get(id)?.current ?? null;
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- React Native types getInnerViewNode() as any; the node is only passed back to measureLayout
    const content: Parameters<View["measureLayout"]>[0] | null | undefined = bodyRegion.current?.getInnerViewNode?.();
    if (measureFailed.current !== id && card !== null && content !== undefined && content !== null && typeof card.measureLayout === "function") {
      pendingScroll.current = null;
      const request = scrollRequest.current;
      card.measureLayout(
        content,
        (_x, y) => {
          if (request === scrollRequest.current) bodyRegion.current?.scrollTo({ y: Math.max(0, y - 12), animated: true });
        },
        // Not measurable: use the reported offsets now if the shown block has them, else at the next
        // layout report.
        () => {
          if (request !== scrollRequest.current || (pendingScroll.current !== null && pendingScroll.current !== id)) return;
          measureFailed.current = id;
          pendingScroll.current = id;
          scrollByOffsets(id);
        },
      );
      return;
    }
    scrollByOffsets(id);
  };
  useEffect(() => tryScroll(), [highlight]);
  const toast = useToast();

  const actions = grillingActions(view, { plannerStatus });
  const proposal = view.session.status === "active" ? view.grilling?.finishProposal : undefined;
  const groups = blockGroups(view);

  function selectQuestion(questionId: string, nonce: number) {
    const owner = groups.find((g) => g.questionIds.includes(questionId));
    if (owner !== undefined) {
      setChosen(owner.key);
      setHighlight({ questionId, nonce });
      pendingScroll.current = questionId;
      measureFailed.current = null;
      scrollRequest.current += 1;
    } else {
      // A hidden question is not on the canvas: the hidden section opens with it.
      setHiddenOpen(nonce);
    }
  }
  // Adjust state while rendering: each target nonce is applied exactly once. An unknown question
  // consumes the nonce and keeps the current selection.
  if (target && target.nonce !== appliedNonce) {
    setAppliedNonce(target.nonce);
    selectQuestion(target.questionId, target.nonce);
    setFocus(target.focus !== undefined ? { questionId: target.questionId, focus: target.focus, nonce: target.nonce } : null);
    if (target.showHidden === true) setHiddenOpen(target.nonce);
  }
  const onSelectQuestion = (questionId: string) => {
    const nonce = -(localNonce + 1);
    setLocalNonce(localNonce + 1);
    selectQuestion(questionId, nonce);
  };

  const key = shownKey(groups, chosen, proposal !== undefined);
  // Offsets belong to the block they were measured in: another block's cards are measured afresh
  // before any scroll, never taken from an earlier visit (a card above may have changed size).
  // Compact: the navigator row scrolls so the shown block's card is fully in view, whatever selected it
  // (a press, a link, a successful Accept), once the row and that card have a layout.
  const navRow = useRef<NativeScrollView | null>(null);
  const nav = useRef<{ width: number | null; scrollX: number; items: Map<string, { x: number; width: number }>; shownFor: string | null }>({ width: null, scrollX: 0, items: new Map(), shownFor: null });
  const revealNavItem = () => {
    const n = nav.current;
    const item = n.items.get(key);
    if (!compact || n.shownFor === key || item === undefined || n.width === null) return;
    n.shownFor = key;
    const visible = item.x >= n.scrollX && item.x + item.width <= n.scrollX + n.width;
    if (visible) return;
    const x = item.x < n.scrollX ? item.x : Math.max(0, item.x + item.width - n.width);
    navRow.current?.scrollTo({ x, animated: true });
    n.scrollX = x;
  };
  useEffect(() => revealNavItem(), [key, compact]);
  const measuredKey = useRef(key);
  if (measuredKey.current !== key) {
    measuredKey.current = key;
    offsets.current = { canvas: null, list: null, cards: new Map() };
  }
  const group = key === PROPOSAL_KEY ? undefined : groups.find((g) => g.key === key);
  // A link's pin on a card (an opened History) ends when the shown block changes, by any path (the
  // navigator, a relation link, an accept), to one without the pinned question: coming back remounts
  // the card, which is not a new link. A link sets its pin with its block in the same pass.
  const pinShownFor = useRef(key);
  if (pinShownFor.current !== key) {
    pinShownFor.current = key;
    if (focus !== null && group?.questionIds.includes(focus.questionId) !== true) setFocus(null);
  }

  // Only our own successful accept clears the owner's choice, so the refetched view shows the next
  // open block; background refetches and a failed accept keep the current selection.
  async function acceptAndContinue(blockId: string) {
    const out = await accept.run({ sessionId: view.session.id, blockId }, { expectedRevision: view.revision });
    if (out) {
      setChosen(null);
      // Also when the canvas is no longer shown (the Map was chosen while the accept was in flight).
      if (keptSelection !== undefined) keptSelection.current = { ...keptSelection.current, chosen: null };
    }
  }

  // ---- Notices outside any menu (SessionNotices): drawn here above the canvas ----
  const notices = sessionNotices(view, theme, actions, check, resolve);

  // The no-translation notice: shown under the header until the owner's Got it for this label.
  const language = sessionLanguage(view);
  const noticeShown = language.known && language.notice !== null && !language.acknowledged && ackedHere !== language.label;
  const noticeView = noticeShown ? (
    <View style={{ gap: 6, minWidth: 0, borderWidth: 1, borderColor: theme.colors.statusWarning, borderRadius: 8, padding: 10, flexShrink: 0 }}>
      <Text style={{ color: theme.colors.statusWarning, flexShrink: 1 }}>{language.notice}</Text>
      <ActionButton
        label="Got it"
        theme={theme}
        disabled={ackNotice.pending}
        onPress={() =>
          void (async () => {
            const out = await ackNotice.run({ sessionId: view.session.id, language: language.label }, { expectedRevision: view.revision });
            if (out !== null) setAckedHere(language.label);
          })()
        }
      />
    </View>
  ) : null;

  // ---- The selected block's summary, in a modal: at acceptance (with current answers after changes), or the open block's preview ----
  const summary = group?.blockId !== undefined ? view.summaries?.find((s) => s.blockId === group.blockId) : undefined;
  const preview = group?.state === "open" ? view.openBlockPreview : undefined;
  const changedLine = summary?.changedSinceAcceptance === true ? `Answers changed after acceptance: ${summary.changed.map(qLabel).join(", ")}` : null;
  const summaryText = preview ?? (summary !== undefined && summary.noSnapshot !== true ? summary.acceptedSummary : undefined);
  const closeSummary = () => {
    setSummaryOpen(false);
    // Focus returns where the platform's view offers it (web); elsewhere the call is skipped.
    summaryRef.current?.focus?.();
  };
  const summaryModal = summaryOpen ? (
    <Modal title={preview !== undefined ? "Summary preview" : "Summary at acceptance"} open onOpenChange={(open) => !open && closeSummary()}>
      <Modal.Content>
        <Text style={{ color: theme.colors.foreground, fontWeight: "600" }}>{preview !== undefined ? "Summary preview (sent when the block is accepted)" : "Summary at acceptance (sent to the chat)"}</Text>
        {summaryText !== undefined ? (
          <Text style={{ color: theme.colors.foreground, fontFamily: "monospace", fontSize: 12, flexShrink: 1 }}>{summaryText}</Text>
        ) : (
          <Muted theme={theme}>No summary was recorded when this block was accepted.</Muted>
        )}
        {preview === undefined && summary?.changedSinceAcceptance === true ? (
          <>
            <Text style={{ color: theme.colors.statusWarning, flexShrink: 1 }}>{`${changedLine ?? ""}; the chat was told the earlier values.`}</Text>
            <Text style={{ color: theme.colors.foreground, fontWeight: "600" }}>Current answers</Text>
            <Text style={{ color: theme.colors.foreground, fontFamily: "monospace", fontSize: 12, flexShrink: 1 }}>{summary.currentSummary}</Text>
          </>
        ) : null}
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          {summaryText !== undefined ? (
            <ActionButton
              label="Copy"
              icon="copy"
              iconOnly
              hint="Copy the summary text"
              theme={theme}
              onPress={() =>
                void copyText(summaryText).then(
                  () => toast.show("Summary copied"),
                  () => toast.error("The summary could not be copied"),
                )
              }
            />
          ) : null}
          <ActionButton label="Close" theme={theme} onPress={closeSummary} />
        </View>
        {/* The host portals the modal above the panel: Copy's tooltip is drawn in the modal's own layer. */}
        <TooltipLayer />
      </Modal.Content>
    </Modal>
  ) : null;

  // ---- Navigator: one card per block, then the chat's finish proposal ----
  const navItem = (k: string, title: string, state: string, line2: string, opts: { open?: boolean; proposal?: boolean } = {}) => {
    const selected = key === k;
    return (
      <Pressable
        key={k}
        accessibilityRole="button"
        accessibilityLabel={`${title}, ${state}, ${line2}`}
        accessibilityState={{ selected }}
        {...webAria({ "aria-current": selected ? "true" : undefined })}
        onPress={() => setChosen(k)}
        {...(compact
          ? {
              onLayout: (e: { nativeEvent: { layout: { x: number; width: number } } }) => {
                nav.current.items.set(k, { x: e.nativeEvent.layout.x, width: e.nativeEvent.layout.width });
                revealNavItem();
              },
            }
          : {})}
        style={{
          minHeight: TARGET_SIZE,
          ...(compact ? { width: 168 } : {}),
          justifyContent: "center",
          paddingTop: 5,
          paddingBottom: 6,
          paddingLeft: 11,
          paddingRight: 10,
          borderRadius: 6,
          borderWidth: selected ? 2 : 1,
          borderColor: selected ? theme.colors.accent : theme.colors.border,
          borderLeftWidth: 3,
          borderLeftColor: opts.proposal === true ? theme.colors.accent : opts.open === true ? theme.colors.foregroundMuted : theme.colors.statusSuccess,
          backgroundColor: selected ? theme.colors.surface2 : theme.colors.surface1,
        }}
      >
        <View style={{ flexDirection: "row", alignItems: "baseline", gap: 6 }}>
          <Text style={{ fontWeight: "600", color: theme.colors.foreground, lineHeight: 17 }}>{title}</Text>
          <Text style={{ marginLeft: "auto", fontSize: 12, color: theme.colors.foregroundMuted }}>{state}</Text>
        </View>
        <Text style={{ marginTop: 1, fontSize: 12, lineHeight: 15, color: theme.colors.foregroundMuted }}>{line2}</Text>
      </Pressable>
    );
  };
  const lastHistory = view.session.finishHistory?.at(-1);
  const navItems = [
    ...groups.map((g) =>
      navItem(g.key, g.legacy ? "All questions" : `Block ${g.order + 1}`, g.legacy ? (g.state === "legacy-active" ? "active" : "closed") : g.state, rangeText(view, g.questionIds), { open: g.state === "open" }),
    ),
    ...(proposal !== undefined
      ? [
          <View key="proposal-sep" accessibilityRole="none" style={compact ? { width: 1, marginHorizontal: 2, backgroundColor: theme.colors.border } : { height: 1, marginVertical: 4, marginHorizontal: 2, backgroundColor: theme.colors.border }} />,
          navItem(PROPOSAL_KEY, "Finish proposal", "from the chat", lastHistory !== undefined && lastHistory.finishedAt === undefined ? `Proposed again ${when(proposal.at)}` : "Not accepted yet", { proposal: true }),
        ]
      : []),
  ];
  const navigator = compact ? (
    <ScrollView
      ref={navRow}
      horizontal
      showsHorizontalScrollIndicator={false}
      style={{ flexGrow: 0 }}
      contentContainerStyle={{ flexDirection: "row", gap: 6 }}
      scrollEventThrottle={64}
      onScroll={(e: { nativeEvent: { contentOffset: { x: number } } }) => {
        nav.current.scrollX = e.nativeEvent.contentOffset.x;
      }}
      onLayout={(e: { nativeEvent: { layout: { width: number } } }) => {
        nav.current.width = e.nativeEvent.layout.width;
        revealNavItem();
      }}
    >
      {navItems}
    </ScrollView>
  ) : (
    <View style={{ gap: 5, minWidth: 0 }}>
      <Text style={{ height: 32, lineHeight: 32, fontSize: 13, fontWeight: "600", color: theme.colors.foregroundMuted }}>Blocks</Text>
      {navItems}
    </View>
  );

  // ---- Canvas ----
  const nums = (ns: number[]) => (ns.length === 0 ? "none" : ns.map(qLabel).join(", "));
  const proposalCanvas =
    proposal !== undefined ? (
      <View style={{ gap: 10, minWidth: 0 }}>
        <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8, minHeight: 32 }}>
          <Text style={{ fontSize: 15, fontWeight: "600", color: theme.colors.foreground }}>Finish proposal</Text>
          <Chip theme={theme}>from the chat</Chip>
          <Text style={{ fontSize: 13, color: theme.colors.foregroundMuted }}>not accepted</Text>
        </View>
        <View style={{ gap: 8, paddingTop: 12, paddingBottom: 14, paddingHorizontal: 14, backgroundColor: theme.colors.surface1, borderWidth: 1, borderColor: theme.colors.accent, borderRadius: 8 }}>
          <Text style={{ fontSize: 14, fontWeight: "600", color: theme.colors.foreground }}>The chat proposes to finish</Text>
          <Text selectable style={{ lineHeight: 19, color: theme.colors.foreground, flexShrink: 1 }}>
            {proposal.summary}
          </Text>
          <Text style={{ color: theme.colors.foregroundMuted }}>{`Skipped: ${nums(proposal.skipped)} · Out of scope: ${nums(proposal.outOfScope)}`}</Text>
          <Text style={{ fontSize: 12, color: theme.colors.foregroundMuted }}>{`Proposed ${when(proposal.at)}`}</Text>
          <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 10, marginTop: 4 }}>
            <ActionButton
              label="Accept finish proposal"
              theme={theme}
              primary
              disabled={finish.pending}
              onPress={() => void finish.run({ sessionId: view.session.id, basis: "proposal", proposalAt: proposal.at }, { expectedRevision: view.revision })}
            />
            <Text style={{ fontSize: 12, color: theme.colors.foregroundMuted, flexShrink: 1 }}>Closes this discussion on the chat's proposal. It approves no plan and starts nothing.</Text>
          </View>
        </View>
      </View>
    ) : null;

  const acceptable = !!group && !group.legacy && group.state === "open" && group.blockId !== undefined && actions.accept;
  const blockNumber = group !== undefined && !group.legacy ? group.order + 1 : null;
  const addHere = group !== undefined && add.target !== null && (group.legacy ? add.target.blockId === undefined : group.blockId === add.target.blockId);
  const blockCanvas =
    group !== undefined ? (
      <View
        style={{ gap: 6, minWidth: 0 }}
        onLayout={(e) => {
          offsets.current.canvas = e.nativeEvent.layout.y;
          tryScroll();
        }}
      >
        <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8, minHeight: 32 }}>
          <Text style={{ fontSize: 15, fontWeight: "600", color: theme.colors.foreground }}>{group.legacy ? "All questions" : `Block ${blockNumber}`}</Text>
          {!group.legacy ? <Chip theme={theme} tone={group.state === "accepted" ? "ok" : "muted"}>{group.state}</Chip> : null}
          <Text style={{ fontSize: 13, color: theme.colors.foregroundMuted }}>
            {group.questionIds.length === 0 ? "no questions" : `${group.questionIds.length} ${group.questionIds.length === 1 ? "question" : "questions"}`}
          </Text>
          {group.blockId !== undefined ? (
            <ActionButton
              ref={summaryRef}
              label="Summary"
              icon="file-text"
              iconOnly
              hint={changedLine !== null ? `${changedLine}. Open the block summary` : "Open the block summary"}
              theme={theme}
              disabled={preview === undefined && summary === undefined}
              onPress={() => setSummaryOpen(true)}
            />
          ) : null}
          {changedLine !== null ? <Text style={{ color: theme.colors.statusWarning, flexShrink: 1 }}>{changedLine}</Text> : null}
        </View>
        {group.questionIds.length === 0 ? (
          <View style={{ gap: 4, paddingVertical: 18, paddingHorizontal: 14, borderWidth: 1, borderStyle: "dashed", borderColor: theme.colors.border, borderRadius: 8 }}>
            <Text style={{ color: theme.colors.foreground }}>{group.legacy ? "No questions in this session yet." : "No questions in this block yet."}</Text>
            <Text style={{ fontSize: 13, color: theme.colors.foregroundMuted }}>
              {group.state === "open" ? emptyBlockLine(view, blockNumber ?? 1) : group.legacy ? "Nothing has been added here yet." : "This block was accepted without questions."}
            </Text>
          </View>
        ) : (
          <View
            style={{ gap: 6, minWidth: 0 }}
            onLayout={(e) => {
              offsets.current.list = e.nativeEvent.layout.y;
              tryScroll();
            }}
          >
            {group.questionIds.map((id, i) => (
              <View
                key={id}
                ref={cardRef(id)}
                onLayout={(e) => {
                  offsets.current.cards.set(id, e.nativeEvent.layout.y);
                  tryScroll();
                }}
              >
              <QuestionCanvasCard
                hostId={hostId}
                projectId={projectId}
                view={view}
                questionId={id}
                theme={theme}
                compact={compact}
                first={i === 0}
                highlighted={highlight?.questionId === id}
                {...(focus !== null && focus.questionId === id ? { focus: focus.focus } : {})}
                plannerStatus={plannerStatus}
                onSelectQuestion={onSelectQuestion}
                {...(onOpenRef ? { onOpenRef } : {})}
                {...(props.onOpenSession ? { onOpenSession: props.onOpenSession } : {})}
                {...(openAgent ? { openAgent } : {})}
                {...(onOpenLink ? { onOpenLink } : {})}
              />
              </View>
            ))}
          </View>
        )}
        {addHere ? <AddQuestionForm add={add} view={view} theme={theme} /> : null}
        {group.state === "accepted" ? (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginTop: 10 }}>
            <Icon name={lucideName("check")} size={15} color={theme.colors.statusSuccess} />
            <Text style={{ fontSize: 13, color: theme.colors.foregroundMuted, flexShrink: 1 }}>{`Block ${blockNumber} is accepted. Questions are added to the open block.`}</Text>
          </View>
        ) : null}
        {acceptable ? (
          <View style={{ gap: 6, marginTop: 10 }}>
            <Text style={{ fontSize: 13, color: theme.colors.foregroundMuted }}>{`Accepts Block ${blockNumber} as it is (answered, unanswered or empty) and opens the next block.`}</Text>
            <ActionButton label="Accept block and continue" theme={theme} primary disabled={accept.pending} onPress={() => void acceptAndContinue(group.blockId!)} />
          </View>
        ) : null}
        <HiddenQuestions
          hostId={hostId}
          projectId={projectId}
          view={view}
          theme={theme}
          compact={compact}
          {...(hiddenOpen !== null ? { forceOpen: hiddenOpen } : {})}
          {...(focus !== null ? { focus } : {})}
          {...(onOpenLink ? { onOpenLink } : {})}
        />
      </View>
    ) : null;
  const canvas = key === PROPOSAL_KEY ? proposalCanvas : blockCanvas;

  // Bounded layout: the parent gives this screen a bounded height; canvas and navigator scroll inside
  // it. In compact the navigator is a sideways row above the canvas and everything scrolls together.
  if (compact) {
    return (
      <View style={{ flex: 1, minHeight: 0, gap: 10, minWidth: 0 }}>
        {summaryModal}
        {/* One scroll region for everything; on iOS it insets itself for the software keyboard so the
            add form stays reachable (Android resizes the window; the web has no software keyboard here). */}
        <ScrollView
          ref={bodyRegion}
          style={{ flex: 1, minHeight: 0 }}
          contentContainerStyle={{ gap: 10, paddingBottom: 24 }}
          automaticallyAdjustKeyboardInsets
          keyboardShouldPersistTaps="handled"
        >
          {notices}
          {noticeView}
          {navigator}
          {canvas}
        </ScrollView>
      </View>
    );
  }
  return (
    <View style={{ flex: 1, minHeight: 0, gap: 12, minWidth: 0 }}>
      {notices}
      {noticeView}
      {summaryModal}
      <View style={{ flex: 1, minHeight: 0, flexDirection: "row", gap: 24, minWidth: 0 }}>
        <ScrollView ref={bodyRegion} style={{ flex: 1, minHeight: 0 }} contentContainerStyle={{ paddingBottom: 24 }}>
          {canvas}
        </ScrollView>
        <ScrollView style={{ width: 240, flexGrow: 0, minHeight: 0 }} contentContainerStyle={{ paddingBottom: 24 }}>
          {navigator}
        </ScrollView>
      </View>
    </View>
  );
}
