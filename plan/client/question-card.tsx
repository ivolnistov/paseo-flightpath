import type { PluginTheme } from "@getpaseo/plugin";
import { Modal, TextInput, copyText, useToast } from "@getpaseo/plugin/client/react-native";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { Answer, Question, Ref } from "../shared/model";
import type { QuestionView, SessionView } from "../shared/rpc";
import { currentAnswer } from "../shared/status";
import { DecisionCancel } from "../shared/rpc-decisions";
import { decisionMarks, readOnlyReason } from "./grilling-blocks";
import { sessionLanguage } from "./grilling-header";
import { useRoadmapMutation } from "./hooks";
import { ClarifyComposer } from "./clarify-composer";
import { discussContext } from "./discuss-context";
import { QuestionAnswerPanel } from "./question-answer-panel";
import { QuestionEditor } from "./question-editor";
import { copyLinks, qLabel } from "./question-number";
import type { Focus } from "./link-target";
import { LinkText } from "./link-text";
import type { ParsedLink } from "../shared/links";
import { RelationsEditor } from "./relations-editor";
import { ActionButton } from "./roadmap-screen";
import { STATUS_LABEL, TARGET_SIZE } from "./theme";
import { Heading, Muted, inputStyle } from "./ui";

const valueLabel = (q: Question, a: Answer) =>
  a.text !== undefined ? `“${a.text}”` : (q.options.find((o) => o.id === a.optionId)?.label ?? a.optionId ?? "");

const when = (iso: string) => iso.replace("T", " ").slice(0, 16);

type BodyProps = {
  hostId: string;
  projectId: string;
  view: SessionView;
  questionId: string;
  theme: PluginTheme;
  compact: boolean;
  /** Opens a decision in another session (wired by the panel in R1.4). */
  onOpenRef?(ref: Ref): void;
  /** Selects another question of the same session (the grilling screen). */
  onSelectQuestion?(questionId: string): void;
  /** History, links and relations only: no answering, editing or cancelling (hidden questions). */
  readOnly?: boolean;
  /** The host's navigation to a chat; absent on hosts without it. */
  openAgent?(agentId: string): void;
  /** The planner chat's status from the host's client state; null when unknown. */
  plannerStatus?: string | null;
  /** From a link: the current answer, or a history revision, is shown highlighted. */
  focus?: Focus;
  /** Opens a roadmap link or Q<n> mentioned in this question's answer notes. */
  onOpenLink?(link: ParsedLink | number): void;
};

type Linked = { ref: Ref; label: string; sameSession: boolean };

/** Questions this one depends on (activation or invalidation) and the ones that directly depend on it. */
export function linkedQuestions(view: SessionView, qv: QuestionView): { parents: Linked[]; dependents: Linked[] } {
  const sid = view.session.id;
  const describe = (ref: Ref): Linked => {
    const same = ref.sessionId === sid ? view.questions.find((x) => x.question.id === ref.questionId) : undefined;
    if (same !== undefined) return { ref, label: `${qLabel(same.number)} ${same.question.title}`, sameSession: true };
    const entry = view.catalog.find((c) => c.ref.sessionId === ref.sessionId && c.ref.questionId === ref.questionId);
    return { ref, label: entry !== undefined ? `${entry.questionTitle} (${entry.sessionTitle})` : "A question that no longer exists", sameSession: ref.sessionId === sid };
  };
  const seen = new Set<string>();
  const parents: Linked[] = [];
  for (const ref of [...qv.question.activatedBy.map((a) => a.parent), ...qv.question.invalidatedBy.map((i) => i.upstream)]) {
    const key = `${ref.sessionId}/${ref.questionId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    parents.push(describe(ref));
  }
  const self = qv.question.id;
  const dependents = view.questions
    .filter((x) => [...x.question.activatedBy.map((a) => a.parent), ...x.question.invalidatedBy.map((i) => i.upstream)].some((r) => r.sessionId === sid && r.questionId === self))
    .map((x) => describe({ sessionId: sid, questionId: x.question.id }));
  return { parents, dependents };
}

/**
 * One question without a modal: its decision marks, the answer panel, the edit and relation entries
 * (only while it is editable), its history and the explicit cancellation. Callers key it by
 * question, so the cancellation draft and its pinned revision belong to one question.
 */
export function QuestionBody(props: BodyProps) {
  const { hostId, projectId, view, questionId, theme, compact, onOpenRef, onSelectQuestion } = props;
  const readOnlyBody = props.readOnly === true;
  const cancel = useRoadmapMutation(hostId, projectId, DecisionCancel);
  const toast = useToast();
  const [dependentsOpen, setDependentsOpen] = useState(false);
  // Pinned when this question's body opens; a refetch or the cache never moves it. Only the explicit
  // "Review latest before cancelling" action re-pins, to the revision the human is looking at.
  const [pinned, setPinned] = useState(() => view.revision);
  const [reason, setReason] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [section, setSection] = useState<"none" | "edit" | "relations">("none");
  const [aboutLanguage, setAboutLanguage] = useState(false);

  const qv = view.questions.find((x) => x.question.id === questionId);
  if (!qv) return <Muted theme={theme}>This question no longer exists.</Muted>;

  const q = qv.question;
  const ref = { sessionId: view.session.id, questionId: q.id };
  const marks = decisionMarks(view, q.id);
  const editable = !readOnlyBody && readOnlyReason(view, q.id) === null;
  const links = copyLinks(qv);
  const answered = currentAnswer(q) !== undefined;

  const linked = linkedQuestions(view, qv);
  const planner = view.session.planner;
  const current = currentAnswer(q);
  const focus = props.focus;
  const pinnedRev = typeof focus === "object" ? focus : undefined;
  // Roadmap links and Q<n> in answer notes open in place when the screen can navigate.
  const noteText = (text: string) =>
    props.onOpenLink !== undefined ? (
      <LinkText text={text} theme={theme} color={theme.colors.foregroundMuted} onOpen={props.onOpenLink} />
    ) : (
      <Muted theme={theme}>{text}</Muted>
    );
  const copy = (text: string, what: string) =>
    void copyText(text).then(
      () => toast.show(`${what} copied`),
      () => toast.error(`${what} could not be copied`),
    );
  const go = (l: Linked) =>
    l.sameSession ? onSelectQuestion && (() => onSelectQuestion(l.ref.questionId)) : onOpenRef && (() => onOpenRef(l.ref));
  const linkRow = (l: Linked) => {
    const press = go(l);
    return press ? (
      <Pressable
        key={`${l.ref.sessionId}/${l.ref.questionId}`}
        accessibilityRole="link"
        accessibilityLabel={l.label}
        onPress={press}
        style={{ minHeight: TARGET_SIZE, minWidth: TARGET_SIZE, justifyContent: "center", alignSelf: "flex-start" }}
      >
        <Text style={{ color: theme.colors.accent }}>{l.label}</Text>
      </Pressable>
    ) : (
      <Text key={`${l.ref.sessionId}/${l.ref.questionId}`} style={{ color: theme.colors.foreground }}>
        {l.label}
      </Text>
    );
  };
  const replacement = marks.replacedBy;
  const pinStale = view.revision !== pinned;

  async function submitCancel() {
    const trimmed = reason.trim();
    if (!trimmed || cancel.pending || pinStale) return;
    setConfirming(false);
    const out = await cancel.run({ ...ref, reason: trimmed }, { expectedRevision: pinned });
    if (out) setReason("");
  }

  const replacementView = replacement
    ? (() => {
        const label = `Replaced by ${replacement.title}`;
        const press = replacement.sameSession
          ? onSelectQuestion && (() => onSelectQuestion(replacement.ref.questionId))
          : onOpenRef && (() => onOpenRef(replacement.ref));
        if (!press) {
          return (
            <Text style={{ color: theme.colors.foregroundMuted }}>
              {replacement.sameSession ? label : `${label} (${replacement.sessionTitle})`}
            </Text>
          );
        }
        return (
          <Pressable
            accessibilityRole="link"
            accessibilityLabel={label}
            onPress={press}
            style={{ minHeight: TARGET_SIZE, minWidth: TARGET_SIZE, justifyContent: "center", alignSelf: "flex-start" }}
          >
            <Text style={{ color: theme.colors.accent }}>{label}</Text>
          </Pressable>
        );
      })()
    : null;

  const language = sessionLanguage(view);
  return (
    <View style={{ gap: 14, minWidth: 0 }}>
      {/* The title row: the question, then the effective language chip and its info control (wrapping below on narrow screens). */}
      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8, minWidth: 0 }}>
        <Text
          style={{
            color: marks.cancelled ? theme.colors.statusDanger : theme.colors.foreground,
            fontSize: 18,
            fontWeight: "600",
            flexShrink: 1,
            ...(marks.cancelled ? { textDecorationLine: "line-through" as const } : {}),
          }}
        >
          {`${qLabel(qv.number)} ${q.title}`}
        </Text>
        {language.known ? (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
            <Text
              style={{ fontSize: 12, color: theme.colors.foregroundMuted, borderWidth: 1, borderColor: theme.colors.border, borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2 }}
            >{`Language: ${language.label}`}</Text>
            {language.notice !== null ? (
              <ActionButton label="About the language" icon="info" iconOnly hint="Show the note about translation" theme={theme} onPress={() => setAboutLanguage(true)} />
            ) : null}
          </View>
        ) : null}
      </View>
      {aboutLanguage && language.notice !== null ? (
        <Modal title="About the language" open onOpenChange={(open) => setAboutLanguage(open)}>
          <Modal.Content>
            <Text style={{ color: theme.colors.foreground }}>{language.notice}</Text>
          </Modal.Content>
        </Modal>
      ) : null}
      {marks.cancelled ? <Text style={{ color: theme.colors.statusDanger }}>{`Cancelled: ${marks.cancelled.reason}`}</Text> : null}
      {replacementView}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        <ActionButton label="Copy link" icon="link" iconOnly hint="Copy the link to this question" theme={theme} onPress={() => copy(links.question, "Question link")} />
        {answered ? (
          <ActionButton label="Copy answer link" icon="link-2" iconOnly hint="Copy the link to the current answer" theme={theme} onPress={() => copy(links.answer, "Answer link")} />
        ) : null}
      </View>

      {linked.parents.length > 0 ? (
        <View style={{ gap: 2, minWidth: 0 }}>
          <Muted theme={theme}>↳ Depends on · a change there needs this answer reviewed</Muted>
          {linked.parents.map(linkRow)}
        </View>
      ) : null}
      {linked.dependents.length > 0 ? (
        <View style={{ gap: 2, minWidth: 0 }}>
          <ActionButton
            label={`${linked.dependents.length} dependent ${linked.dependents.length === 1 ? "question" : "questions"}`}
            theme={theme}
            selected={dependentsOpen}
            onPress={() => setDependentsOpen(!dependentsOpen)}
          />
          {dependentsOpen ? linked.dependents.map(linkRow) : null}
        </View>
      ) : null}

      {readOnlyBody ? null : (
        <QuestionAnswerPanel hostId={hostId} projectId={projectId} view={view} questionId={questionId} theme={theme} compact={compact} />
      )}
      {!readOnlyBody && !marks.cancelled && planner !== undefined && view.session.status === "active" ? (
        <ClarifyComposer
          key={`clarify:${q.id}`}
          hostId={hostId}
          agentId={planner.agentId}
          number={qv.number}
          title={q.title}
          context={discussContext(qv)}
          theme={theme}
          plannerStatus={props.plannerStatus ?? null}
          {...(props.openAgent !== undefined ? { openAgent: () => props.openAgent!(planner.agentId) } : {})}
        />
      ) : null}

      {editable ? (
        <View style={{ flexDirection: "row", gap: 8 }}>
          <ActionButton label="Edit" theme={theme} primary={section === "edit"} onPress={() => setSection(section === "edit" ? "none" : "edit")} />
          <ActionButton
            label="Relations"
            theme={theme}
            primary={section === "relations"}
            onPress={() => setSection(section === "relations" ? "none" : "relations")}
          />
        </View>
      ) : null}
      {editable && section === "edit" ? (
        <QuestionEditor mode="edit" hostId={hostId} projectId={projectId} view={view} theme={theme} question={q} onDone={() => setSection("none")} />
      ) : null}
      {editable && section === "relations" ? <RelationsEditor hostId={hostId} projectId={projectId} view={view} theme={theme} target={ref} /> : null}

      {focus === "answer" ? (
        <View style={{ gap: 2, borderWidth: 2, borderColor: theme.colors.accent, borderRadius: 6, padding: 8 }}>
          {current !== undefined ? (
            <Text style={{ color: theme.colors.foreground, fontWeight: "600" }}>{`Current answer (rev ${current.rev}): ${valueLabel(q, current)}`}</Text>
          ) : (
            <Text style={{ color: theme.colors.foreground, fontWeight: "600" }}>
              {`No current answer (${STATUS_LABEL[qv.status].toLowerCase()})${q.answer !== undefined ? `; rev ${q.answer.rev} is kept as history` : ""}`}
            </Text>
          )}
        </View>
      ) : null}
      {pinnedRev !== undefined && !q.revisions.some((a) => a.rev === pinnedRev.rev) ? (
        <Text style={{ color: theme.colors.statusWarning }}>{`Revision ${pinnedRev.rev} does not exist for this question.`}</Text>
      ) : null}

      <View style={{ gap: 6 }}>
        <Heading theme={theme}>History</Heading>
        {q.revisions.length === 0 ? <Muted theme={theme}>Not answered yet.</Muted> : null}
        {[...q.revisions].reverse().map((a) => {
          const isCurrent = current?.rev === a.rev;
          const highlighted = pinnedRev?.rev === a.rev;
          const mark = isCurrent ? " (current)" : highlighted ? (current !== undefined ? ` (not current; current is rev ${current.rev})` : " (not current; no current answer)") : "";
          return (
            <View key={a.rev} style={{ gap: 2, ...(highlighted ? { borderWidth: 2, borderColor: theme.colors.accent, borderRadius: 6, padding: 6 } : {}) }}>
              <Text style={{ color: theme.colors.foreground }}>{`Rev ${a.rev}: ${valueLabel(q, a)}${mark}`}</Text>
              <Muted theme={theme}>
                {a.source === "ui" ? "Roadmap" : "Chat"} · {a.actor.kind === "human" ? "person" : "agent"} · {when(a.at)}
              </Muted>
              {a.note ? noteText(a.note) : null}
            </View>
          );
        })}
      </View>


      {marks.cancelled || readOnlyBody ? null : (
        <View style={{ gap: 6 }}>
          <Heading theme={theme}>Cancel decision</Heading>
          {pinStale ? (
            <>
              <Muted theme={theme}>This question changed since you opened it. Review the latest state before cancelling.</Muted>
              <ActionButton
                label="Review latest before cancelling"
                theme={theme}
                onPress={() => {
                  setPinned(view.revision);
                  setReason("");
                  setConfirming(false);
                }}
              />
            </>
          ) : (
            <>
              <TextInput
                accessibilityLabel="Cancellation reason"
                placeholder="Why is this decision cancelled? (required)"
                placeholderTextColor={theme.colors.foregroundMuted}
                value={reason}
                onChangeText={(value: string) => {
                  setReason(value);
                  setConfirming(false);
                }}
                multiline
                style={[inputStyle(theme), { minHeight: TARGET_SIZE }]}
              />
              <ActionButton
                label={confirming ? "Confirm cancel decision" : "Cancel decision"}
                theme={theme}
                danger
                disabled={!reason.trim() || cancel.pending}
                onPress={() => (confirming ? void submitCancel() : setConfirming(true))}
              />
            </>
          )}
        </View>
      )}
    </View>
  );
}

/** The question in a modal, as used by the timeline card (`client/timeline-card.tsx`). */
export function QuestionCard(props: BodyProps & { open: boolean; onOpenChange(open: boolean): void }) {
  const { view, questionId, open, onOpenChange, compact, ...rest } = props;
  const title = view.questions.find((x) => x.question.id === questionId)?.question.title ?? "Question";
  return (
    <Modal title={title} open={open} onOpenChange={onOpenChange}>
      <Modal.Content contentContainerStyle={{ padding: compact ? 16 : 24, gap: 14 }}>
        <QuestionBody key={questionId} {...rest} view={view} questionId={questionId} compact={compact} />
      </Modal.Content>
    </Modal>
  );
}
