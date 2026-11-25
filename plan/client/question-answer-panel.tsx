import type { PluginTheme } from "@getpaseo/plugin";
import { TextInput } from "@getpaseo/plugin/client/react-native";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { QuestionAnswer, QuestionConfirm, QuestionOutOfScope, QuestionSkip, type SessionView } from "../shared/rpc";
import { currentAnswer } from "../shared/status";
import { cancellationOf } from "./grilling-blocks";
import { useRoadmapMutation } from "./hooks";
import { relationLines, staleCauseText } from "./layout";
import { ActionButton } from "./roadmap-screen";
import { TARGET_SIZE } from "./theme";
import { Muted, StatusChip, inputStyle } from "./ui";

/**
 * Answering content of a question, shared by the question body and the timeline card: status and
 * relation lines, options with the recommendation first (preselected on an unanswered question and
 * recorded as the owner's accepted default when submitted unchanged), free text, note, and Answer /
 * Confirm / Skip / Out of scope. Answers stay editable on an accepted block, whose definition alone
 * is frozen. A cancelled decision is read-only: its answer and note are shown, and only the
 * explanation toggles stay interactive.
 * Renders nothing when the question is absent; callers show their own missing state.
 */
export function QuestionAnswerPanel(props: {
  hostId: string;
  projectId: string;
  view: SessionView;
  questionId: string;
  theme: PluginTheme;
  compact: boolean;
  /** Called after a successful answer, confirm or skip. */
  onDone?(): void;
  /** Offers Cancel beside Answer, which closes the panel without sending anything. */
  onCancel?(): void;
  /** The question card shows the context in its own Description disclosure. */
  hideContext?: boolean;
}) {
  const { hostId, projectId, view, questionId, theme, onDone } = props;
  const qv = view.questions.find((x) => x.question.id === questionId);
  const answer = useRoadmapMutation(hostId, projectId, QuestionAnswer);
  const confirm = useRoadmapMutation(hostId, projectId, QuestionConfirm);
  const skip = useRoadmapMutation(hostId, projectId, QuestionSkip);
  const outOfScope = useRoadmapMutation(hostId, projectId, QuestionOutOfScope);
  const recommendation = (id: string): string | null => {
    const q = view.questions.find((x) => x.question.id === id)?.question;
    return q?.validity === "unanswered" ? (q.recommendedOptionId ?? null) : null;
  };
  const [selected, setSelected] = useState<string | null>(() => recommendation(questionId));
  // True once the owner changes the selection or types: the preselected default is then theirs.
  const [touched, setTouched] = useState(false);
  const [text, setText] = useState("");
  const [note, setNote] = useState("");
  // Open explanations, scoped to the question they were opened for.
  const [whyOpen, setWhyOpen] = useState<{ questionId: string; ids: string[] }>({ questionId, ids: [] });

  // Adjust state while rendering: another question resets the draft. The recommendation is read once
  // per question; later refetches never move the selection.
  const [draftFor, setDraftFor] = useState(questionId);
  if (draftFor !== questionId) {
    setDraftFor(questionId);
    setSelected(recommendation(questionId));
    setTouched(false);
    setText("");
    setNote("");
  }

  if (!qv) return null;

  const q = qv.question;
  // A skipped or out-of-scope question keeps an earlier answer only as history; never show it as chosen.
  const current = currentAnswer(q);
  const ref = { sessionId: view.session.id, questionId: q.id };
  const inactive = qv.visibility === "inactive";
  const lines = relationLines(qv, view);
  const stale = staleCauseText(qv, view);
  const hasValue = selected !== null || text.trim() !== "";
  const busy = answer.pending || confirm.pending || skip.pending || outOfScope.pending;
  const readOnly = cancellationOf(view, q.id) !== undefined;
  // The recommendation first, in a new array; the question's options are never reordered in place.
  const options = [...q.options].sort((a, b) => Number(b.id === q.recommendedOptionId) - Number(a.id === q.recommendedOptionId));
  const explained = whyOpen.questionId === questionId ? whyOpen.ids : [];
  const toggleWhy = (id: string) =>
    setWhyOpen((prev) => {
      const ids = prev.questionId === questionId ? prev.ids : [];
      return { questionId, ids: ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id] };
    });

  async function submitAnswer() {
    const defaulted = selected !== null && selected === q.recommendedOptionId && !touched;
    const out = await answer.run({
      ...ref,
      ...(selected !== null ? { optionId: selected } : { text: text.trim() }),
      ...(note.trim() ? { note: note.trim() } : {}),
      ...(defaulted ? { defaulted: true } : {}),
    });
    if (out) {
      setSelected(null);
      setTouched(false);
      setText("");
      setNote("");
      onDone?.();
    }
  }

  const activationText = lines.filter((l) => l.kind === "activation").map((l) => l.text.replace(/^Active when /, ""));

  return (
    <>
      <View style={{ gap: 6 }}>
        {qv.status !== "answered" ? <StatusChip status={qv.status} theme={theme} /> : null}
        {readOnly ? <Text style={{ color: theme.colors.statusWarning }}>Read-only: decision cancelled</Text> : null}
        {q.context && props.hideContext !== true ? <Text style={{ color: theme.colors.foreground }}>{q.context}</Text> : null}
        {lines.map((line, i) => (
          <Muted key={i} theme={theme}>
            {line.text}
          </Muted>
        ))}
        {stale ? <Text style={{ color: theme.colors.statusWarning }}>{stale}</Text> : null}
        {inactive ? (
          <Text style={{ color: theme.colors.foregroundMuted }}>
            Inactive — active when {activationText.join(" and ") || "its conditions are met"}
          </Text>
        ) : null}
      </View>

      <View style={{ gap: 6 }}>
        {options.map((o, index) => {
          const isSelected = selected === o.id;
          const isCurrent = current?.optionId === o.id;
          const isRecommended = q.recommendedOptionId === o.id;
          const why = o.description ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Why ${o.label}`}
              accessibilityState={{ expanded: explained.includes(o.id) }}
              onPress={() => toggleWhy(o.id)}
              style={{ minHeight: TARGET_SIZE, minWidth: TARGET_SIZE, justifyContent: "center", alignSelf: "flex-start" }}
            >
              <Text style={{ color: theme.colors.accent, fontSize: 12 }}>{explained.includes(o.id) ? "Hide why" : "Why"}</Text>
            </Pressable>
          ) : null;
          const heading = (
            <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
              <Text style={{ color: theme.colors.foreground, fontWeight: "600" }}>
                {index + 1}. {o.label}
              </Text>
              {isRecommended ? <Text style={{ color: theme.colors.accent, fontSize: 12 }}>Recommended</Text> : null}
              {isCurrent ? <Text style={{ color: theme.colors.statusSuccess, fontSize: 12 }}>✓ Chosen</Text> : null}
            </View>
          );
          const frame = {
            borderWidth: 1,
            borderLeftWidth: isRecommended ? 4 : 1,
            borderRadius: 6,
            padding: 10,
            gap: 2,
            borderColor: isSelected ? theme.colors.accent : theme.colors.border,
            borderLeftColor: isRecommended ? theme.colors.accent : isSelected ? theme.colors.accent : theme.colors.border,
            backgroundColor: isSelected ? theme.colors.surface2 : theme.colors.surface1,
          };
          return (
            <View key={o.id} style={{ gap: 2 }}>
              {readOnly ? (
                <View style={frame}>{heading}</View>
              ) : (
                <Pressable
                  accessibilityRole="radio"
                  accessibilityState={{ selected: isSelected, disabled: inactive }}
                  accessibilityLabel={o.label}
                  disabled={inactive}
                  onPress={() => {
                    setSelected(isSelected ? null : o.id);
                    setTouched(true);
                    setText("");
                  }}
                  style={[frame, { minHeight: TARGET_SIZE }]}
                >
                  {heading}
                </Pressable>
              )}
              {why}
              {o.description && explained.includes(o.id) ? <Muted theme={theme}>{o.description}</Muted> : null}
            </View>
          );
        })}
        {current !== undefined ? (
          <View style={{ gap: 4 }}>
            {current.text !== undefined ? <Text style={{ color: theme.colors.foreground }}>{`Answer: “${current.text}”`}</Text> : null}
            {current.note ? <Text style={{ color: theme.colors.foregroundMuted }}>{`Note: ${current.note}`}</Text> : null}
          </View>
        ) : null}
        {!readOnly && q.allowFreeText ? (
          <TextInput
            accessibilityLabel="Free-text answer"
            placeholder="Or write your own answer"
            placeholderTextColor={theme.colors.foregroundMuted}
            editable={!inactive}
            value={text}
            onChangeText={(value) => {
              setText(value);
              setTouched(true);
              if (value) setSelected(null);
            }}
            multiline
            style={[inputStyle(theme), { minHeight: 48 }]}
          />
        ) : null}
        {readOnly ? null : (
          <>
        <TextInput
          accessibilityLabel="Answer note"
          placeholder="Note (optional)"
          placeholderTextColor={theme.colors.foregroundMuted}
          editable={!inactive}
          value={note}
          onChangeText={setNote}
          style={[inputStyle(theme), { minHeight: TARGET_SIZE }]}
        />
        <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
          <ActionButton label="Answer" theme={theme} primary disabled={inactive || !hasValue || busy} onPress={() => void submitAnswer()} />
          {q.validity === "stale" && !inactive ? (
            <ActionButton label="Confirm" theme={theme} disabled={busy} onPress={() => void confirm.run(ref).then((out) => out && onDone?.())} />
          ) : null}
          <ActionButton
            label="Skip"
            theme={theme}
            disabled={inactive || busy || (q.validity === "skipped" && q.review === undefined)}
            onPress={() => void skip.run(ref).then((out) => out && onDone?.())}
          />
          <ActionButton
            label="Out of scope"
            theme={theme}
            disabled={inactive || busy || (q.validity === "out_of_scope" && q.review === undefined)}
            onPress={() => void outOfScope.run(ref).then((out) => out && onDone?.())}
          />
          {props.onCancel !== undefined ? <ActionButton label="Cancel" theme={theme} onPress={props.onCancel} /> : null}
        </View>
          </>
        )}
      </View>
    </>
  );
}
