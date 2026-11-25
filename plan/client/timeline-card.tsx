import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { useAgent } from "@getpaseo/plugin/client";
import { useToast } from "@getpaseo/plugin/client/react-native";
import { parseLink } from "../shared/links";
import { currentAnswer } from "../shared/status";
import { openInRoadmap } from "./panel-opener";
import { useState, type ReactNode } from "react";
import { Text, View } from "react-native";
import type { RpcError } from "../shared/rpc";
import { RpcFailure, useRoadmapVersion, useSessionView } from "./hooks";
import { conflictMessage } from "./layout";
import { QuestionAnswerPanel } from "./question-answer-panel";
import { QuestionCard } from "./question-card";
import { cardStyle } from "./theme";
import { cardModel } from "./timeline-card-model";
import type { RowData } from "./timeline-data";
import { Button, Heading, Muted } from "./ui";

// These codes classify a lost reference (project or session gone) as "no longer available".
const GONE: ReadonlySet<RpcError["code"]> = new Set(["unknown_project", "not_found"]);
const isGone = (e: unknown) => e instanceof RpcFailure && GONE.has(e.rpcError.code);
const errorText = (e: unknown) => (e instanceof RpcFailure ? conflictMessage(e.rpcError) : e instanceof Error ? e.message : "Something went wrong.");

/**
 * Open in roadmap (the question) and Open current answer (when answered): leave the question route for
 * the agent's workspace and open the panel there through the entry-captured opener.
 */
export function OpenInRoadmap(props: { agentId: string; projectId: string; questionLink: string; answerLink?: string; theme: PluginTimelineItemProps<RowData>["theme"] }) {
  const { agentId, projectId, questionLink, answerLink, theme } = props;
  const workspaceId = useAgent(agentId, (a) => a.workspaceId);
  const toast = useToast();
  const open = (raw: string) => {
    const link = parseLink(raw);
    if (link === null) return;
    if (workspaceId === null) {
      toast.error("The chat's workspace is not known on this client.");
      return;
    }
    if (!openInRoadmap({ workspaceId, projectId }, { kind: "question", link }, agentId)) toast.show("Open the decision roadmap panel to see this question.");
  };
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
      <Button label="Open in roadmap" theme={theme} onPress={() => open(questionLink)} />
      {answerLink !== undefined ? <Button label="Open current answer" theme={theme} onPress={() => open(answerLink)} /> : null}
    </View>
  );
}

/**
 * A `decision-question` timeline row. The row holds only a reference; the question is read from
 * the store through the panel's queries and answered in place with the same RPCs.
 */
export function DecisionTimelineCard(props: PluginTimelineItemProps<RowData>) {
  const { theme, host, layout, item } = props;
  const { projectId, sessionId, questionId } = item.data;
  const compact = layout.compact;
  const version = useRoadmapVersion(host.id, projectId);
  const session = useSessionView(host.id, projectId, sessionId);
  const [details, setDetails] = useState(false);

  const view = session.data ?? null;
  const model = cardModel(view, questionId);
  const gone = isGone(version.error) || isGone(session.error) || (view !== null && model.kind === "missing");

  let body: ReactNode;
  if (gone) body = <Muted theme={theme}>Decision no longer available</Muted>;
  else if (view && model.kind === "question") {
    body = (
      <>
        <View style={{ flexDirection: "row", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <View style={{ flex: 1 }}>
            <Heading theme={theme}>{model.question.question.title}</Heading>
          </View>
          <Button label="Details" theme={theme} onPress={() => setDetails(true)} />
        </View>
        <OpenInRoadmap
          agentId={props.agentId}
          projectId={projectId}
          questionLink={model.question.links.question}
          {...(currentAnswer(model.question.question) !== undefined ? { answerLink: model.question.links.answer } : {})}
          theme={theme}
        />
        {/* One answering instance: the Details modal replaces the inline panel while open. */}
        {details ? null : (
          <QuestionAnswerPanel hostId={host.id} projectId={projectId} view={view} questionId={questionId} theme={theme} compact={compact} />
        )}
        {details ? (
          <QuestionCard
            hostId={host.id}
            projectId={projectId}
            view={view}
            questionId={questionId}
            open
            onOpenChange={(open) => !open && setDetails(false)}
            theme={theme}
            compact={compact}
          />
        ) : null}
      </>
    );
  } else if (session.isError) body = <Text style={{ color: theme.colors.statusDanger }}>{errorText(session.error)}</Text>;
  else body = <Muted theme={theme}>Loading…</Muted>;

  return (
    <View
      style={{
        ...cardStyle(theme, { dimmed: model.kind === "question" && model.question.visibility === "inactive" }),
        gap: compact ? 10 : 14,
        padding: compact ? 10 : 14,
      }}
    >
      {body}
    </View>
  );
}
