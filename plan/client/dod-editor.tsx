// Draft editor for a feature-bound plan (Stage R1.2): per task, the human-owned DoD text and the
// grill checkbox. Saving drafts the next, unapproved revision with the full task list; it never
// changes an approved revision or its task states.
import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { TextInput, useToast } from "@getpaseo/plugin/client/react-native";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { PlanRevisionV2 } from "../shared/model";
import { PlanDraft, type PlanView, type Result } from "../shared/rpc";
import { DodTemplateGet, type DodTemplateValue } from "../shared/rpc-dod";
import { useRoadmapMutation } from "./hooks";
import { conflictMessage } from "./layout";
import { dodSourceLabel, draftTasks, insertTemplate, taskEditsChanged, type TaskEdits } from "./plan-format";
import { ActionButton } from "./roadmap-screen";
import { TARGET_SIZE } from "./theme";
import { Heading, Muted, inputStyle } from "./ui";

export function DodEditor(props: {
  hostId: string;
  projectId: string;
  theme: PluginTheme;
  compact: boolean;
  plan: PlanView["plan"];
  revision: PlanRevisionV2;
  storeRevision: number;
  onSaved(rev: number): void;
  onCancel(): void;
}) {
  const { hostId, projectId, theme, onSaved, onCancel } = props;
  const draft = useRoadmapMutation(hostId, projectId, PlanDraft);
  const templateRpc = useRpc(DodTemplateGet) as (input: { projectId: string }) => Promise<Result<DodTemplateValue>>;
  const toast = useToast();
  // The whole editing base is pinned at open as one unit: later props never move it.
  const [base] = useState(() => ({ plan: props.plan, revision: props.revision, storeRevision: props.storeRevision }));
  const [edits, setEdits] = useState<TaskEdits>({});
  const [notice, setNotice] = useState<string | null>(null);
  const [fetching, setFetching] = useState<string | null>(null);

  const dodOf = (all: TaskEdits, taskId: string) => all[taskId]?.dod ?? base.revision.tasks.find((t) => t.id === taskId)?.dod ?? "";
  const grillOf = (all: TaskEdits, taskId: string) => all[taskId]?.grill ?? base.revision.tasks.find((t) => t.id === taskId)?.grill ?? false;
  const setDod = (taskId: string, dod: string) => setEdits((all) => ({ ...all, [taskId]: { ...all[taskId], dod } }));

  async function insert(taskId: string) {
    setFetching(taskId);
    try {
      const out = await templateRpc({ projectId });
      if (!out.ok) {
        toast.show(conflictMessage(out.error), { variant: "error" });
        return;
      }
      if (out.value.source === "none") {
        setNotice("No DoD template is set");
        return;
      }
      const text = out.value.text;
      // Applied to the latest working text, so typing during the request is kept.
      setEdits((all) => ({ ...all, [taskId]: { ...all[taskId], dod: insertTemplate(dodOf(all, taskId), text) } }));
      setNotice(`Template from: ${dodSourceLabel(out.value.source)}`);
    } catch (e) {
      toast.show(e instanceof Error ? e.message : "Request failed", { variant: "error" });
    } finally {
      setFetching(null);
    }
  }

  async function save() {
    const { plan, revision, storeRevision } = base;
    const out = await draft.run(
      {
        planId: plan.id,
        ...(plan.featureId !== undefined ? { featureId: plan.featureId } : {}),
        title: plan.title,
        sessionIds: plan.sessionIds,
        markdown: revision.markdown,
        tasks: draftTasks(revision, edits),
      },
      { expectedRevision: storeRevision },
    );
    if (out) onSaved(out.rev);
  }

  const changed = taskEditsChanged(base.revision, edits);
  return (
    <View style={{ gap: 12, minWidth: 0 }}>
      <Heading theme={theme}>{`Edit DoD · revision ${base.revision.rev}`}</Heading>
      <Muted theme={theme}>Saving drafts a new revision for review and approval; the shown revision stays as it is.</Muted>
      {notice ? <Text style={{ color: theme.colors.foregroundMuted }}>{notice}</Text> : null}
      {base.revision.tasks.map((t) => {
        const checked = grillOf(edits, t.id);
        return (
          <View key={t.id} style={{ gap: 6, minWidth: 0 }}>
            <Text style={{ color: theme.colors.foreground, fontWeight: "600" }}>{t.title}</Text>
            <TextInput
              accessibilityLabel={`DoD for ${t.title}`}
              placeholder="Definition of Done"
              placeholderTextColor={theme.colors.foregroundMuted}
              value={dodOf(edits, t.id)}
              onChangeText={(text: string) => setDod(t.id, text)}
              multiline
              style={[inputStyle(theme), { minHeight: TARGET_SIZE * 2 }]}
            />
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
              <Pressable
                accessibilityRole="checkbox"
                accessibilityLabel={`Grill ${t.title}`}
                accessibilityState={{ checked }}
                onPress={() => setEdits((all) => ({ ...all, [t.id]: { ...all[t.id], grill: !grillOf(all, t.id) } }))}
                style={{ minHeight: TARGET_SIZE, minWidth: TARGET_SIZE, flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 8 }}
              >
                <Text style={{ color: theme.colors.foreground }}>{checked ? "☑ Grill" : "☐ Grill"}</Text>
              </Pressable>
              <ActionButton label={`Insert template for ${t.title}`} theme={theme} disabled={fetching !== null} onPress={() => void insert(t.id)} />
            </View>
          </View>
        );
      })}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        <ActionButton label="Save" theme={theme} primary disabled={!changed || draft.pending} onPress={() => void save()} />
        <ActionButton label="Discard" theme={theme} disabled={draft.pending} onPress={onCancel} />
      </View>
    </View>
  );
}
