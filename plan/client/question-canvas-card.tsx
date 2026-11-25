// One question on the block canvas: the recorded answer until Edit opens the answer panel, the
// Description and Why recommended disclosures, the relation links with kind and direction, and a More
// menu with the remaining actions (copy links, history, definition and relations editors, clarify in
// chat, cancel decision).
import type { PluginTheme } from "@getpaseo/plugin";
import {
  Modal,
  TextInput,
  copyText,
  useToast,
} from "@getpaseo/plugin/client/react-native";
import { useState } from "react";
import { Text, View } from "react-native";
import type { Answer, Question, Ref } from "../shared/model";
import type { SessionView } from "../shared/rpc";
import { DecisionCancel } from "../shared/rpc-decisions";
import { currentAnswer } from "../shared/status";
import type { ParsedLink } from "../shared/links";
import { useDiscussInChat } from "./chat-draft";
import { ClarifyComposer } from "./clarify-composer";
import { discussContext } from "./discuss-context";
import {
  Disclosure,
  LinkChip,
  MenuItem,
  SmallButton,
  Tag,
} from "./discussion-ui";
import { decisionMarks, readOnlyReason } from "./grilling-blocks";
import { sessionLanguage } from "./grilling-header";
import { useRoadmapMutation } from "./hooks";
import { staleCauseText } from "./layout";
import type { Focus } from "./link-target";
import { LinkText } from "./link-text";
import { QuestionAnswerPanel } from "./question-answer-panel";
import { QuestionEditor } from "./question-editor";
import { copyLinks, qLabel } from "./question-number";
import { relationLinks, type RelationLink } from "./relation-links";
import { RelationsEditor } from "./relations-editor";
import { ActionButton } from "./roadmap-screen";
import { STATUS_LABEL, TARGET_SIZE } from "./theme";
import { Muted, inputStyle } from "./ui";

const when = (iso: string) => iso.replace("T", " ").slice(0, 16);
const valueLabel = (q: Question, a: Answer) =>
  a.text !== undefined
    ? `“${a.text}”`
    : (q.options.find((o) => o.id === a.optionId)?.label ?? a.optionId ?? "");

export type CardProps = {
  hostId: string;
  projectId: string;
  view: SessionView;
  questionId: string;
  theme: PluginTheme;
  compact: boolean;
  /** The language chip and its note sit on the first card only. */
  first: boolean;
  /** A link led here: the card is outlined. */
  highlighted: boolean;
  /** From a link: the current answer or a history revision is shown highlighted. */
  focus?: Focus;
  plannerStatus: string | null;
  onSelectQuestion(questionId: string): void;
  onOpenRef?(ref: Ref): void;
  onOpenSession?(sessionId: string): void;
  openAgent?(agentId: string): void;
  onOpenLink?(link: ParsedLink | number): void;
};

type Section = "none" | "edit" | "relations" | "clarify" | "cancel";

/** A card section on a line of its own. */
const FULL = { width: "100%", minWidth: 0 } as const;

export function QuestionCanvasCard(props: CardProps) {
  const { hostId, projectId, view, questionId, theme, compact } = props;
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [descOpen, setDescOpen] = useState(false);
  const [whyOpen, setWhyOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [section, setSection] = useState<Section>("none");
  // A link to a history revision opens the history once.
  const [historyOpen, setHistoryOpen] = useState(
    () => typeof props.focus === "object",
  );
  // Adjust state while rendering: a new link to a history revision opens the history once.
  const [focusSeen, setFocusSeen] = useState(props.focus);
  if (focusSeen !== props.focus) {
    setFocusSeen(props.focus);
    if (typeof props.focus === "object") setHistoryOpen(true);
  }
  const [aboutLanguage, setAboutLanguage] = useState(false);
  // Bound to the session's planner chat only; with no planner it names no chat.
  const draft = useDiscussInChat(view.session.planner?.agentId ?? null);

  const qv = view.questions.find((x) => x.question.id === questionId);
  if (qv === undefined) return null;
  const q = qv.question;
  const marks = decisionMarks(view, q.id);
  const editable = readOnlyReason(view, q.id) === null;
  const current = currentAnswer(q);
  const links = copyLinks(qv);
  const planner = view.session.planner;
  const recommended = q.options.find((o) => o.id === q.recommendedOptionId);
  const why =
    recommended?.description !== undefined && recommended.description !== ""
      ? recommended.description
      : null;
  const stale = staleCauseText(qv, view);
  const language = sessionLanguage(view);
  const related = relationLinks(view, q.id);
  const canClarify =
    !marks.cancelled &&
    planner !== undefined &&
    view.session.status === "active";

  const copy = (text: string, what: string) =>
    void copyText(text).then(
      () => toast.show(`${what} copied`),
      () => toast.error(`${what} could not be copied`),
    );
  const openSection = (next: Section) => {
    setMoreOpen(false);
    setSection(section === next ? "none" : next);
  };
  const linkPress = (l: RelationLink): (() => void) | undefined => {
    const t = l.target;
    if (t.kind === "question")
      return () => props.onSelectQuestion(t.questionId);
    if (t.kind === "ref" && props.onOpenRef !== undefined)
      return () => props.onOpenRef!(t.ref);
    if (t.kind === "session" && props.onOpenSession !== undefined)
      return () => props.onOpenSession!(t.sessionId);
    return undefined;
  };
  const noteText = (text: string) =>
    props.onOpenLink !== undefined ? (
      <LinkText
        text={text}
        theme={theme}
        color={theme.colors.foregroundMuted}
        onOpen={props.onOpenLink}
      />
    ) : (
      <Muted theme={theme}>{text}</Muted>
    );

  const statusColor =
    qv.status === "answered"
      ? theme.colors.statusSuccess
      : qv.status === "open" || qv.status === "stale"
        ? theme.colors.statusWarning
        : theme.colors.foregroundMuted;
  const answerRow = (() => {
    const frame = {
      flexDirection: "row" as const,
      flexWrap: "wrap" as const,
      alignItems: "center" as const,
      gap: 8,
      minHeight: 26,
      paddingHorizontal: 10,
      paddingVertical: 4,
      borderRadius: 6,
      borderWidth: 1,
      borderColor:
        props.focus === "answer"
          ? theme.colors.statusSuccess
          : theme.colors.accent,
      backgroundColor: "rgba(32, 116, 74, 0.12)",
    };
    if (current?.optionId !== undefined) {
      const option = q.options.find((o) => o.id === current.optionId);
      return (
        <View style={frame}>
          <Text
            style={{
              color: theme.colors.foreground,
              fontSize: 13,
              flexShrink: 1,
            }}
          >
            {option?.label ?? current.optionId}
          </Text>
          {current.optionId === q.recommendedOptionId ? (
            <Tag theme={theme}>Recommended</Tag>
          ) : null}
          <Text
            style={{
              marginLeft: "auto",
              fontSize: 12,
              color: theme.colors.statusSuccess,
            }}
          >
            ✓ Chosen
          </Text>
        </View>
      );
    }
    if (current?.text !== undefined) {
      return (
        <View style={frame}>
          <Text
            selectable
            style={{
              color: theme.colors.foreground,
              fontSize: 13,
              flex: 1,
              minWidth: 0,
            }}
          >
            {current.text}
          </Text>
          <Tag theme={theme}>free text</Tag>
        </View>
      );
    }
    const settled = qv.status === "skipped" || qv.status === "out_of_scope";
    return (
      <Text
        style={{
          fontSize: 13,
          lineHeight: 17,
          color: theme.colors.foregroundMuted,
        }}
      >
        {settled
          ? `${STATUS_LABEL[qv.status]}${q.answer !== undefined ? "; the earlier answer is kept as history" : ""}.`
          : "No answer yet."}
      </Text>
    );
  })();

  const pinnedRev = typeof props.focus === "object" ? props.focus : undefined;
  const historyModal = historyOpen ? (
    <Modal
      title={`${qLabel(qv.number)} history`}
      open
      onOpenChange={(open) => !open && setHistoryOpen(false)}
    >
      <Modal.Content>
        {pinnedRev !== undefined &&
        !q.revisions.some((a) => a.rev === pinnedRev.rev) ? (
          <Text
            style={{ color: theme.colors.statusWarning }}
          >{`Revision ${pinnedRev.rev} does not exist for this question.`}</Text>
        ) : null}
        {q.revisions.length === 0 ? (
          <Muted theme={theme}>Not answered yet.</Muted>
        ) : null}
        {[...q.revisions].reverse().map((a) => {
          const isCurrent = current?.rev === a.rev;
          const highlighted = pinnedRev?.rev === a.rev;
          const mark = isCurrent
            ? " (current)"
            : highlighted
              ? current !== undefined
                ? ` (not current; current is rev ${current.rev})`
                : " (not current; no current answer)"
              : "";
          return (
            <View
              key={a.rev}
              style={{
                gap: 2,
                ...(highlighted
                  ? {
                      borderWidth: 2,
                      borderColor: theme.colors.accent,
                      borderRadius: 6,
                      padding: 6,
                    }
                  : {}),
              }}
            >
              <Text
                style={{ color: theme.colors.foreground }}
              >{`Rev ${a.rev}: ${valueLabel(q, a)}${mark}`}</Text>
              <Muted theme={theme}>
                {a.source === "ui" ? "Roadmap" : "Chat"} ·{" "}
                {a.actor.kind === "human" ? "person" : "agent"} · {when(a.at)}
              </Muted>
              {a.note ? noteText(a.note) : null}
            </View>
          );
        })}
        <ActionButton
          label="Close"
          theme={theme}
          onPress={() => setHistoryOpen(false)}
        />
      </Modal.Content>
    </Modal>
  ) : null;

  const moreMenu = moreOpen ? (
    <View
      accessibilityRole="menu"
      accessibilityLabel={`${qLabel(qv.number)} actions`}
      style={{
        minWidth: 220,
        padding: 6,
        gap: 2,
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 8,
        backgroundColor: theme.colors.surface1,
      }}
    >
      <MenuItem
        label="Copy link"
        theme={theme}
        onPress={() => (
          setMoreOpen(false),
          copy(links.question, "Question link")
        )}
      />
      {current !== undefined ? (
        <MenuItem
          label="Copy answer link"
          theme={theme}
          onPress={() => (
            setMoreOpen(false),
            copy(links.answer, "Answer link")
          )}
        />
      ) : null}
      <MenuItem
        label="History"
        theme={theme}
        onPress={() => (setMoreOpen(false), setHistoryOpen(true))}
      />
      {editable ? (
        <MenuItem
          label="Edit question"
          theme={theme}
          onPress={() => openSection("edit")}
        />
      ) : null}
      {editable ? (
        <MenuItem
          label="Relations"
          theme={theme}
          onPress={() => openSection("relations")}
        />
      ) : null}
      {canClarify ? (
        <MenuItem
          label="Discuss in chat"
          hint="Adds this question's context to the chat's draft without sending it"
          theme={theme}
          onPress={() => (
            setMoreOpen(false),
            void draft.discuss(discussContext(qv))
          )}
        />
      ) : null}
      {canClarify ? (
        <MenuItem
          label="Clarify in chat"
          theme={theme}
          onPress={() => openSection("clarify")}
        />
      ) : null}
      {!marks.cancelled ? (
        <MenuItem
          label="Cancel decision"
          danger
          theme={theme}
          onPress={() => openSection("cancel")}
        />
      ) : null}
    </View>
  ) : null;

  // The card is one wrapping row: the title, status and Edit share its first line, and every other
  // section takes the full width (FULL), so each starts a line of its own.
  return (
    <View
      style={{
        flexDirection: "row",
        flexWrap: "wrap",
        alignItems: "center",
        columnGap: 8,
        rowGap: 4,
        paddingTop: 8,
        paddingBottom: 7,
        paddingHorizontal: 12,
        backgroundColor: theme.colors.surface1,
        borderWidth: props.highlighted ? 2 : 1,
        borderColor: props.highlighted
          ? theme.colors.statusSuccess
          : theme.colors.border,
        borderRadius: 8,
        minWidth: 0,
      }}
    >
      <Text
        style={{
          flex: 1,
          minWidth: 120,
          fontSize: 14,
          lineHeight: 17,
          fontWeight: "600",
          color: marks.cancelled
            ? theme.colors.statusDanger
            : theme.colors.foreground,
          ...(marks.cancelled
            ? { textDecorationLine: "line-through" as const }
            : {}),
        }}
      >
        {`${qLabel(qv.number)} ${q.title}`}
      </Text>
      {props.first && language.known ? (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
          <Text
            style={{
              fontSize: 12,
              color: theme.colors.foregroundMuted,
              borderWidth: 1,
              borderColor: theme.colors.border,
              borderRadius: 6,
              paddingHorizontal: 6,
            }}
          >{`Language: ${language.label}`}</Text>
          {language.notice !== null ? (
            <SmallButton
              label="About the language"
              theme={theme}
              onPress={() => setAboutLanguage(true)}
            />
          ) : null}
        </View>
      ) : null}
      <Text
        style={{
          fontSize: 12,
          color: marks.cancelled ? theme.colors.statusDanger : statusColor,
        }}
      >
        {marks.cancelled ? "Cancelled" : STATUS_LABEL[qv.status]}
      </Text>
      <SmallButton
          label={editing ? "Cancel" : "Edit"}
        theme={theme}
        expanded={editing}
        disabled={marks.cancelled !== undefined}
        hint={
          marks.cancelled !== undefined
            ? "A cancelled decision cannot be answered"
            : editing
              ? "Closes the answer panel without saving"
              : "Change the answer"
        }
        onPress={() => setEditing(!editing)}
      />
      {aboutLanguage && language.notice !== null ? (
        <Modal
          title="About the language"
          open
          onOpenChange={(open) => setAboutLanguage(open)}
        >
          <Modal.Content>
            <Text style={{ color: theme.colors.foreground }}>
              {language.notice}
            </Text>
          </Modal.Content>
        </Modal>
      ) : null}
      {marks.cancelled ? (
        <Text
          style={{ ...FULL, color: theme.colors.statusDanger }}
        >{`Cancelled: ${marks.cancelled.reason}`}</Text>
      ) : null}
      {stale !== null ? (
        <Text
          style={{ ...FULL, fontSize: 13, color: theme.colors.statusWarning }}
        >
          {stale}
        </Text>
      ) : null}
      {editing ? (
        <View style={{ ...FULL, gap: 8, paddingTop: 4 }}>
          <QuestionAnswerPanel
            hostId={hostId}
            projectId={projectId}
            view={view}
            questionId={q.id}
            theme={theme}
            compact={compact}
            hideContext
            onDone={() => setEditing(false)}
          />
        </View>
      ) : (
        <View style={FULL}>{answerRow}</View>
      )}
      {!editing && current?.note ? (
        <View style={FULL}>{noteText(`Note: ${current.note}`)}</View>
      ) : null}
      <View
        style={{
          ...FULL,
          flexDirection: "row",
          flexWrap: "wrap",
          alignItems: "center",
          gap: 2,
        }}
      >
        {q.context !== "" ? (
          <Disclosure
            label="Description"
            open={descOpen}
            theme={theme}
            onPress={() => setDescOpen(!descOpen)}
          />
        ) : null}
        {why !== null ? (
          <Disclosure
            label="Why recommended"
            open={whyOpen}
            theme={theme}
            onPress={() => setWhyOpen(!whyOpen)}
          />
        ) : null}
        <View
          style={{
            flexDirection: "row",
            flexWrap: "wrap",
            alignItems: "center",
            gap: 4,
            marginLeft: "auto",
            minWidth: 0,
          }}
        >
          {related.map((l) => {
            const press = linkPress(l);
            return (
              <LinkChip
                key={l.key}
                text={l.text}
                label={l.label}
                theme={theme}
                {...(press !== undefined ? { onPress: press } : {})}
              />
            );
          })}
          <SmallButton
            label="More"
            hint="More actions"
            theme={theme}
            expanded={moreOpen}
            onPress={() => setMoreOpen(!moreOpen)}
          />
        </View>
      </View>
      {descOpen && q.context !== "" ? (
        <PanelText theme={theme}>{q.context}</PanelText>
      ) : null}
      {whyOpen && why !== null ? (
        <PanelText theme={theme}>{why}</PanelText>
      ) : null}
      {moreMenu !== null ? (
        <View style={{ ...FULL, alignItems: "flex-end" }}>{moreMenu}</View>
      ) : null}
      {historyModal}
      <View style={{ ...FULL, gap: 8 }}>
        {section === "edit" && editable ? (
          <QuestionEditor
            mode="edit"
            hostId={hostId}
            projectId={projectId}
            view={view}
            theme={theme}
            question={q}
            onDone={() => setSection("none")}
          />
        ) : null}
        {section === "relations" && editable ? (
          <RelationsEditor
            hostId={hostId}
            projectId={projectId}
            view={view}
            theme={theme}
            target={{ sessionId: view.session.id, questionId: q.id }}
          />
        ) : null}
        {section === "clarify" && canClarify ? (
          <ClarifyComposer
            key={`clarify:${q.id}`}
            hostId={hostId}
            agentId={planner.agentId}
            number={qv.number}
            title={q.title}
            context={discussContext(qv)}
            theme={theme}
            plannerStatus={props.plannerStatus}
            {...(props.openAgent !== undefined
              ? { openAgent: () => props.openAgent!(planner.agentId) }
              : {})}
          />
        ) : null}
        {section === "cancel" && !marks.cancelled ? (
          <CancelDecision
            hostId={hostId}
            projectId={projectId}
            view={view}
            questionRef={{ sessionId: view.session.id, questionId: q.id }}
            theme={theme}
            onDone={() => setSection("none")}
          />
        ) : null}
      </View>
    </View>
  );
}

function PanelText(props: { children: string; theme: PluginTheme }) {
  const { theme } = props;
  return (
    <Text
      selectable
      style={{
        ...FULL,
        marginTop: 2,
        paddingVertical: 7,
        paddingHorizontal: 10,
        borderRadius: 6,
        backgroundColor: theme.colors.surface0,
        fontSize: 13,
        lineHeight: 17,
        color: theme.colors.foreground,
      }}
    >
      {props.children}
    </Text>
  );
}

/**
 * The explicit cancellation of a decision: a required reason and a second confirming press. The
 * revision is pinned when this section opens; a later change asks the owner to review first.
 */
function CancelDecision(props: {
  hostId: string;
  projectId: string;
  view: SessionView;
  questionRef: Ref;
  theme: PluginTheme;
  onDone(): void;
}) {
  const { view, theme } = props;
  const cancel = useRoadmapMutation(
    props.hostId,
    props.projectId,
    DecisionCancel,
  );
  const [pinned, setPinned] = useState(() => view.revision);
  const [reason, setReason] = useState("");
  const [confirming, setConfirming] = useState(false);
  const pinStale = view.revision !== pinned;

  async function submit() {
    const trimmed = reason.trim();
    if (!trimmed || cancel.pending || pinStale) return;
    setConfirming(false);
    const out = await cancel.run(
      { ...props.questionRef, reason: trimmed },
      { expectedRevision: pinned },
    );
    if (out) {
      setReason("");
      props.onDone();
    }
  }

  return (
    <View style={{ gap: 6, paddingTop: 4 }}>
      <Text style={{ color: theme.colors.foreground, fontWeight: "600" }}>
        Cancel decision
      </Text>
      {pinStale ? (
        <>
          <Muted theme={theme}>
            This question changed since you opened this. Review the latest state
            before cancelling.
          </Muted>
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
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            <ActionButton
              label={confirming ? "Confirm cancel decision" : "Cancel decision"}
              theme={theme}
              danger
              disabled={!reason.trim() || cancel.pending}
              onPress={() => (confirming ? void submit() : setConfirming(true))}
            />
            <ActionButton label="Close" theme={theme} onPress={props.onDone} />
          </View>
        </>
      )}
    </View>
  );
}
