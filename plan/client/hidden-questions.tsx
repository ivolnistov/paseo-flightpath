// Hidden conditional questions: inactive questions are kept out of the main list and listed here on
// demand, closed by default, each read-only with the condition that would show it and its history.
// They keep their numbers, links and outcomes, and return to the main list when the condition holds.
import type { PluginTheme } from "@getpaseo/plugin";
import { useState } from "react";
import { View } from "react-native";
import type { QuestionView, SessionView } from "../shared/rpc";
import { QuestionBody } from "./question-card";
import { qLabel } from "./question-number";
import type { Focus } from "./link-target";
import type { ParsedLink } from "../shared/links";
import { ActionButton } from "./roadmap-screen";
import { Heading, Muted } from "./ui";

export function hiddenQuestions(view: SessionView): QuestionView[] {
  return view.questions.filter((qv) => qv.visibility === "inactive");
}

/** "Shown when Q3 is Option B", naming the parent by its number (or title in another session). */
export function activationText(qv: QuestionView, view: SessionView): string {
  const parts = qv.question.activatedBy.map((a) => {
    const sameSession = a.parent.sessionId === view.session.id;
    const parent = sameSession ? view.questions.find((p) => p.question.id === a.parent.questionId) : undefined;
    const entry = view.catalog.find((c) => c.ref.sessionId === a.parent.sessionId && c.ref.questionId === a.parent.questionId);
    const options = parent?.question.options ?? entry?.options ?? [];
    const labels = a.optionIds.map((id) => options.find((o) => o.id === id)?.label ?? id).join(" or ");
    const name = parent !== undefined ? qLabel(parent.number) : entry !== undefined ? `“${entry.questionTitle}” (${entry.sessionTitle})` : "a question that no longer exists";
    return `${name} is ${labels}`;
  });
  return parts.length === 0 ? "Hidden" : `Shown when ${parts.join(" and ")}`;
}

export function HiddenQuestions(props: {
  hostId: string;
  projectId: string;
  view: SessionView;
  theme: PluginTheme;
  compact: boolean;
  /** A new value opens the section once (a link to a hidden question). */
  forceOpen?: number;
  focus?: { questionId: string; focus: Focus };
  onOpenLink?(link: ParsedLink | number): void;
}) {
  const { view, theme, forceOpen, focus, onOpenLink, ...body } = props;
  const [open, setOpen] = useState(false);
  const [forced, setForced] = useState<number | null>(null);
  // Adjust state while rendering: each forced open is applied once.
  if (forceOpen !== undefined && forceOpen !== forced) {
    setForced(forceOpen);
    setOpen(true);
  }
  const hidden = hiddenQuestions(view);
  if (hidden.length === 0) return null;
  return (
    <View style={{ gap: 8, minWidth: 0 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <ActionButton
          label={`${open ? "Hide" : "Show"} hidden questions (${hidden.length})`}
          icon={open ? "eye-off" : "eye"}
          iconOnly
          hint={open ? "Hide the questions that are not shown now" : "Show the questions that are not shown now"}
          theme={theme}
          selected={open}
          onPress={() => setOpen(!open)}
        />
        <Muted theme={theme}>{`Hidden (${hidden.length})`}</Muted>
      </View>
      {open
        ? hidden.map((qv) => (
            <View key={qv.question.id} style={{ gap: 4, minWidth: 0, borderTopWidth: 1, borderColor: theme.colors.border, paddingTop: 8 }}>
              <Heading theme={theme}>{`${qLabel(qv.number)} ${qv.question.title}`}</Heading>
              <Muted theme={theme}>{activationText(qv, view)}</Muted>
              <QuestionBody
                {...body}
                view={view}
                theme={theme}
                key={qv.question.id}
                questionId={qv.question.id}
                readOnly
                {...(focus !== undefined && focus.questionId === qv.question.id ? { focus: focus.focus } : {})}
                {...(onOpenLink !== undefined ? { onOpenLink } : {})}
              />
            </View>
          ))
        : null}
    </View>
  );
}
