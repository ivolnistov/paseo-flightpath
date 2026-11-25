// Add a question to the open block (or a legacy session): the question text and an optional first
// free-text answer, written together in one question.create. Nothing is ever resent on its own: a
// refusal or a lost response keeps the draft and the owner decides again. The draft lives in the
// screen, so it survives the open block changing under it.
import type { PluginTheme } from "@getpaseo/plugin";
import { Icon, TextInput } from "@getpaseo/plugin/client/react-native";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { QuestionCreate, type SessionView } from "../shared/rpc";
import { moveFocus } from "./discussion-ui";
import { roadmapKey, useRoadmapMutation } from "./hooks";
import { qLabel } from "./question-number";
import { ActionButton, lucideName } from "./roadmap-screen";
import { TARGET_SIZE } from "./theme";
import { inputStyle } from "./ui";

const MIN_TITLE = 5;
const norm = (s: string) => s.trim().toLowerCase();

type Outcome = "conflict" | "lost" | null;
type Draft = { title: string; answer: string; blockId: string | undefined; outcome: Outcome; forceDuplicate: boolean };

/** Where a new question goes now: the open block, or a legacy session's single list; null when nothing can be added. */
export function addTarget(view: SessionView): { blockId: string | undefined; number: number | null } | null {
  if (view.session.status !== "active") return null;
  const blocks = view.session.blocks;
  if (blocks === undefined) return { blockId: undefined, number: null };
  const open = blocks.find((b) => b.state === "open");
  return open === undefined ? null : { blockId: open.id, number: open.order + 1 };
}

const blockNumber = (view: SessionView, blockId: string | undefined) => {
  const b = view.session.blocks?.find((x) => x.id === blockId);
  return b === undefined ? null : b.order + 1;
};

/** The active question of the target with this title, compared trimmed and case-insensitively. */
function sameTitle(view: SessionView, blockId: string | undefined, title: string) {
  const wanted = norm(title);
  return view.questions.find((qv) => qv.visibility === "active" && qv.question.blockId === blockId && norm(qv.question.title) === wanted);
}

/**
 * The add form's draft, outcome and notice, and its one question.create request. The session screen
 * holds it, so switching to the Map and back keeps an unsent draft, a refusal or a lost response with
 * its notice, and a request still in flight (Add stays disabled; its late answer still lands). It is
 * never stored outside the screen. `view` is undefined until the session has loaded.
 */
export function useAddQuestion(hostId: string, projectId: string, view: SessionView | undefined) {
  const create = useRoadmapMutation(hostId, projectId, QuestionCreate);
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // Told about an earlier draft's question while another draft may be open: kept apart from `notice`
  // (which belongs to the current draft and is cleared when a draft opens or is sent), shown with the
  // form open or closed, and cleared only when the owner dismisses it.
  const [lateNotices, setLateNotices] = useState<string[]>([]);
  const dismissLate = () => setLateNotices([]);
  const target = view === undefined ? null : addTarget(view);
  // Closing the form by Escape or Cancel returns focus to the add row once it is shown again.
  const rowRef = useRef<View | null>(null);
  const refocus = useRef(false);
  useEffect(() => {
    if (!refocus.current || draft !== null) return;
    refocus.current = false;
    moveFocus(rowRef);
  });

  // Each draft has a generation: opening or closing the form starts a new one. A reply belongs to the
  // generation that sent it; one that answers after Cancel (and a new draft) leaves the current draft
  // alone: it neither closes it nor marks it refused or lost.
  const generation = useRef(0);
  const open = () => {
    generation.current += 1;
    setNotice(null);
    setDraft({ title: "", answer: "", blockId: target?.blockId, outcome: null, forceDuplicate: false });
  };
  const close = () => {
    generation.current += 1;
    refocus.current = true;
    setDraft(null);
  };
  const edit = (patch: Partial<Pick<Draft, "title" | "answer">>) => setDraft((d) => (d === null ? d : { ...d, ...patch, forceDuplicate: false }));

  async function submit(opts: { forceDuplicate?: boolean } = {}) {
    if (view === undefined || draft === null || target === null || create.pending) return;
    const title = draft.title.trim();
    const answerText = draft.answer.trim();
    const duplicate = sameTitle(view, target.blockId, title);
    if (title.length < MIN_TITLE || (duplicate !== undefined && opts.forceDuplicate !== true)) return;
    setNotice(null);
    const sent = generation.current;
    let outcome: Outcome = null;
    const out = await create.run(
      {
        sessionId: view.session.id,
        ...(target.blockId !== undefined ? { blockId: target.blockId } : {}),
        title,
        context: "",
        options: [],
        allowFreeText: true,
        activatedBy: [],
        invalidatedBy: [],
        ...(answerText !== "" ? { answerText } : {}),
      },
      {
        expectedRevision: view.revision,
        onError: (e) => {
          outcome = e.code === "revision_conflict" ? "conflict" : null;
        },
        onCallError: () => {
          outcome = "lost";
          // The response was lost: re-read once, so the owner sees whether the question landed.
          void queryClient.invalidateQueries({ queryKey: roadmapKey(hostId, projectId) });
        },
      },
    );
    const current = sent === generation.current;
    if (out === null) {
      // A refusal or a lost response marks only the draft that was sent (the re-read still happened).
      if (current) setDraft((d) => (d === null ? d : { ...d, outcome, forceDuplicate: false }));
      return;
    }
    if (current) setDraft(null);
    // The question was created. Its answer not recorded is told by its title, which also holds when the
    // form was cancelled and another draft opened meanwhile.
    if (answerText !== "" && out.rev !== 1) {
      if (current) setNotice("The question was added, but the answer was not recorded; answer the question from its card.");
      else {
        const late = `The question “${title}” was added, but its answer was not recorded; answer it from its card.`;
        setLateNotices((all) => (all.includes(late) ? all : [...all, late]));
      }
    }
  }

  return { draft, notice, lateNotices, dismissLate, target, rowRef, open, close, edit, submit, pending: create.pending };
}

export type AddQuestion = ReturnType<typeof useAddQuestion>;

export function AddQuestionForm(props: { add: AddQuestion; view: SessionView; theme: PluginTheme }) {
  const { add, view, theme } = props;
  const { draft, target } = add;
  if (target === null) return null;
  const blockLabel = target.number !== null ? `Block ${target.number}` : null;
  // An earlier draft's question, told apart from the draft on screen: announced as an alert, and kept
  // until dismissed (also while a newer draft is open and after it is sent).
  const late =
    add.lateNotices.length > 0 ? (
      <View accessibilityRole="alert" accessibilityLiveRegion="polite" style={{ gap: 6, marginTop: 6 }}>
        {add.lateNotices.map((text) => (
          <Text key={text} style={{ color: theme.colors.statusWarning, fontSize: 13 }}>
            {text}
          </Text>
        ))}
        <ActionButton label="Dismiss" theme={theme} onPress={add.dismissLate} />
      </View>
    ) : null;

  if (draft === null) {
    return (
      <View style={{ gap: 6 }}>
        <Pressable
          ref={add.rowRef}
          accessibilityRole="button"
          accessibilityLabel={blockLabel !== null ? `Add question to ${blockLabel}` : "Add question"}
          onPress={add.open}
          style={{ minHeight: TARGET_SIZE, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, marginTop: 6, borderWidth: 1, borderStyle: "dashed", borderColor: theme.colors.border, borderRadius: 8 }}
        >
          <Icon name={lucideName("plus")} size={14} color={theme.colors.foregroundMuted} />
          <Text style={{ fontSize: 13, color: theme.colors.foregroundMuted }}>{blockLabel !== null ? `Add question to ${blockLabel}` : "Add question"}</Text>
        </Pressable>
        {add.notice !== null ? <Text style={{ color: theme.colors.statusWarning, fontSize: 13 }}>{add.notice}</Text> : null}
        {late}
      </View>
    );
  }

  const title = draft.title.trim();
  const duplicate = sameTitle(view, target.blockId, title);
  const tooShort = title.length > 0 && title.length < MIN_TITLE;
  const moved = draft.blockId !== target.blockId;
  // A legacy session has no blocks: its questions (all without a block) are compared session-wide.
  const error = tooShort ? `Enter at least ${MIN_TITLE} characters.` : duplicate !== undefined && draft.outcome !== "lost" ? `${qLabel(duplicate.number)} in this ${target.blockId === undefined ? "session" : "block"} already has this title.` : null;
  const valid = title.length >= MIN_TITLE && duplicate === undefined;
  const submitLabel = moved && blockLabel !== null ? `Add to ${blockLabel}` : "Add";
  const fromNumber = blockNumber(view, draft.blockId);
  const onKey = (e: { nativeEvent: { key: string; metaKey?: boolean; ctrlKey?: boolean } }) => {
    const k = e.nativeEvent;
    if (k.key === "Enter" && (k.metaKey === true || k.ctrlKey === true)) void add.submit();
    if (k.key === "Escape") add.close();
  };

  return (
    <>
      {late}
      <View style={{ gap: 6, marginTop: 6, paddingTop: 12, paddingBottom: 14, paddingHorizontal: 14, backgroundColor: theme.colors.surface1, borderWidth: 1, borderColor: theme.colors.accent, borderRadius: 8 }}>
        <Text style={{ fontSize: 14, fontWeight: "600", color: theme.colors.foreground }}>{blockLabel !== null ? `Add question to ${blockLabel}` : "Add question"}</Text>
        <Text style={{ fontSize: 12, color: theme.colors.foregroundMuted }}>Question</Text>
        <TextInput
          accessibilityLabel="Question"
          placeholder="What should be decided?"
          placeholderTextColor={theme.colors.foregroundMuted}
          value={draft.title}
          onChangeText={(value: string) => add.edit({ title: value })}
          onKeyPress={onKey}
          autoFocus
          style={[inputStyle(theme), { minHeight: TARGET_SIZE }]}
        />
        {error !== null ? <Text style={{ fontSize: 12, color: theme.colors.statusDanger }}>{error}</Text> : null}
        <Text style={{ fontSize: 12, color: theme.colors.foregroundMuted }}>Answer (optional, free text)</Text>
        <TextInput
          accessibilityLabel="Answer (optional, free text)"
          placeholder="Leave empty to add the question unanswered"
          placeholderTextColor={theme.colors.foregroundMuted}
          value={draft.answer}
          onChangeText={(value: string) => add.edit({ answer: value })}
          onKeyPress={onKey}
          multiline
          style={[inputStyle(theme), { minHeight: 52 }]}
        />
        {draft.outcome === "conflict" ? <Text style={{ fontSize: 13, color: theme.colors.statusWarning }}>The roadmap changed meanwhile. Review the draft and add it again.</Text> : null}
        {draft.outcome === "lost" ? <Text style={{ fontSize: 13, color: theme.colors.statusWarning }}>The request did not complete; the roadmap is being re-read.</Text> : null}
        {moved && fromNumber !== null && blockLabel !== null ? (
          <Text style={{ fontSize: 13, color: theme.colors.statusWarning }}>{`Block ${fromNumber} was accepted; this question will be added to ${blockLabel}.`}</Text>
        ) : null}
        {draft.outcome === "lost" && duplicate !== undefined ? (
          <Text style={{ fontSize: 13, color: theme.colors.statusWarning }}>{`${qLabel(duplicate.number)} with this title now exists in ${blockLabel ?? "this session"}.`}</Text>
        ) : null}
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 4 }}>
          {draft.outcome === "lost" && duplicate !== undefined ? (
            <>
              <ActionButton label="Discard draft" theme={theme} onPress={add.close} />
              <ActionButton label="Add anyway" theme={theme} primary disabled={add.pending || title.length < MIN_TITLE} onPress={() => void add.submit({ forceDuplicate: true })} />
            </>
          ) : (
            <>
              <ActionButton label={submitLabel} theme={theme} primary disabled={!valid || add.pending} onPress={() => void add.submit()} />
              <ActionButton label="Cancel" theme={theme} onPress={add.close} />
            </>
          )}
        </View>
      </View>
    </>
  );
}
