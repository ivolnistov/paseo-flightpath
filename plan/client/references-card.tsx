// The decision-references row beside an agent's message: each roadmap link of the turn with the
// question's live title and an Open control. Open leaves a one-shot question route (the whole link,
// kind and revision kept) for the agent's workspace and opens the panel there. This row is the
// clickable surface; the host-rendered message text itself stays plain text.
import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { useAgent } from "@getpaseo/plugin/client";
import { useToast } from "@getpaseo/plugin/client/react-native";
import { Text, View } from "react-native";
import { parseLink } from "../shared/links";
import { currentAnswer } from "../shared/status";
import { useSessionView } from "./hooks";
import { openInRoadmap } from "./panel-opener";
import { qLabel } from "./question-number";
import { ActionButton } from "./roadmap-screen";
import { MAX_REFERENCES, type RefRowData } from "./timeline-data";

type Ref = RefRowData["refs"][number];

export function ReferencesCard(props: PluginTimelineItemProps<RefRowData>) {
  const { theme, host, item, agentId } = props;
  const { projectId, refs } = item.data;
  const toast = useToast();
  const workspaceId = useAgent(agentId, (a) => a.workspaceId) ?? null;
  // A row holds at most MAX_REFERENCES references, so at most that many sessions; the views are read
  // through a fixed number of hook slots, an unused slot reading nothing, so the hook order never
  // changes when a rescan replaces the row.
  const sessionIds = [...new Set(refs.map((r) => r.sessionId))];
  const views = new Map<string, ReturnType<typeof useSessionView>>();
  for (let slot = 0; slot < MAX_REFERENCES; slot++) {
    const sessionId = sessionIds[slot] ?? null;
    const view = useSessionView(host.id, projectId, sessionId);
    if (sessionId !== null) views.set(sessionId, view);
  }

  const line = (reference: Ref, index: number) => {
    const session = views.get(reference.sessionId);
    const qv = session?.data?.questions.find((q) => q.number === reference.number);
    const link = parseLink(reference.link);
    // A revision-pinned answer link names its revision; whether it is still the current answer is said
    // only once the session view has loaded the question, never while it loads or after it failed.
    // Only an unpinned answer link stands for the current answer.
    const pinned = link?.rev;
    const currency = qv === undefined ? "" : pinned === currentAnswer(qv.question)?.rev ? ", still the current one" : " from history, not current";
    const what = `${qLabel(reference.number)}${reference.kind !== "answer" ? "" : pinned !== undefined ? ` (answer rev ${pinned}${currency})` : " (current answer)"}`;
    // Gone: the loaded session has no such question. A failed read says so instead of claiming it is gone.
    const gone = session?.data !== undefined && qv === undefined;
    const failed = session?.isError === true;
    const open = () => {
      if (link === null) return;
      if (workspaceId === null) {
        toast.error("The chat's workspace is not known on this client.");
        return;
      }
      if (!openInRoadmap({ workspaceId, projectId }, { kind: "question", link }, agentId)) toast.show("Open the decision roadmap panel to see this question.");
    };
    return (
      <View key={`${reference.link}:${index}`} style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, alignItems: "center", minWidth: 0 }}>
        <Text style={{ color: theme.colors.foreground, flexShrink: 1 }}>
          {gone
            ? `${what}: no longer available`
            : failed
              ? `${what}: could not be loaded`
              : `${what} ${qv?.question.title ?? ""}${session?.data !== undefined ? ` · ${session.data.session.title}` : ""}`}
        </Text>
        {!gone && link !== null ? <ActionButton label={`Open ${what}`} theme={theme} onPress={open} /> : null}
      </View>
    );
  };

  return (
    <View style={{ gap: 4, minWidth: 0, paddingVertical: 4 }}>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>Decision references</Text>
      {refs.map(line)}
    </View>
  );
}
