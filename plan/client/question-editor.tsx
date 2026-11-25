import type { PluginTheme } from "@getpaseo/plugin";
import { TextInput } from "@getpaseo/plugin/client/react-native";
import { useState } from "react";
import { Text, View } from "react-native";
import type { Option, Question } from "../shared/model";
import { definitionPatch } from "./definition-patch";
import { QuestionCreate, QuestionUpdate, type SessionView } from "../shared/rpc";
import { useRoadmapMutation } from "./hooks";
import { RelationsEditor, type RelationDraft } from "./relations-editor";
import { Button, Heading, Muted, Toggle, inputStyle } from "./ui";

/** Next client-assigned option id: `o<n>` with n = 1 + the max numeric suffix, so edits keep ids. */
export function nextOptionId(options: Array<{ id: string }>): string {
  const max = options.reduce((m, o) => {
    const match = /^o(\d+)$/.exec(o.id);
    return match ? Math.max(m, Number(match[1])) : m;
  }, 0);
  return `o${max + 1}`;
}

type OptionRow = { id: string; label: string; description: string };

const toRows = (options: Option[]): OptionRow[] => options.map((o) => ({ id: o.id, label: o.label, description: o.description ?? "" }));
const toOptions = (rows: OptionRow[]): Option[] =>
  rows.map((r) => ({ id: r.id, label: r.label.trim(), ...(r.description.trim() ? { description: r.description.trim() } : {}) }));

export function QuestionEditor(props: {
  mode: "create" | "edit";
  hostId: string;
  projectId: string;
  view: SessionView;
  theme: PluginTheme;
  question?: Question;
  onDone(questionId?: string): void;
}) {
  const { mode, hostId, projectId, view, theme, question, onDone } = props;
  const create = useRoadmapMutation(hostId, projectId, QuestionCreate);
  const update = useRoadmapMutation(hostId, projectId, QuestionUpdate);
  const [title, setTitle] = useState(question?.title ?? "");
  const [context, setContext] = useState(question?.context ?? "");
  const [rows, setRows] = useState<OptionRow[]>(toRows(question?.options ?? []));
  const [recommended, setRecommended] = useState<string | undefined>(question?.recommendedOptionId);
  const [allowFreeText, setAllowFreeText] = useState(question?.allowFreeText ?? false);
  // Pinned for the draft's lifetime: the question, store revision and open grilling block the user
  // started from, all read from the same view. Background refreshes of `question`/`view` must not
  // change what the patch is diffed against, which revision it claims or which block it joins.
  const [base] = useState(() => ({
    question,
    revision: view.revision,
    usesBlocks: view.session.blocks !== undefined,
    openBlockId: view.session.blocks?.find((b) => b.state === "open")?.id,
  }));
  const [conflict, setConflict] = useState(false);
  const [relations, setRelations] = useState<RelationDraft>({ activatedBy: [], invalidatedBy: [] });
  const [error, setError] = useState<string | null>(null);

  const setRow = (index: number, patch: Partial<OptionRow>) => setRows((rs) => rs.map((r, i) => (i === index ? { ...r, ...patch } : r)));

  function validate(): string | null {
    if (!title.trim()) return "Title is required.";
    if (rows.some((r) => !r.label.trim())) return "Every option needs a label.";
    if (rows.length === 0 && !allowFreeText) return "Add at least one option or allow a free-text answer.";
    if (recommended !== undefined && !rows.some((r) => r.id === recommended)) return "The recommended option was removed.";
    return null;
  }

  async function save() {
    const problem = validate();
    setError(problem);
    if (problem) return;
    const options = toOptions(rows);
    if (mode === "create") {
      const input = {
        sessionId: view.session.id,
        title: title.trim(),
        context,
        options,
        ...(recommended !== undefined ? { recommendedOptionId: recommended } : {}),
        allowFreeText,
        activatedBy: relations.activatedBy,
        invalidatedBy: relations.invalidatedBy,
      };
      let out;
      if (!base.usesBlocks) {
        out = await create.run(input);
      } else {
        // A session with grilling blocks takes new questions into its open block only. The block is
        // paired with the revision of the same view, so a block accepted since then is a conflict.
        if (base.openBlockId === undefined) {
          setError("This session has no open block to add questions to.");
          return;
        }
        out = await create.run({ ...input, blockId: base.openBlockId }, { expectedRevision: base.revision });
      }
      if (out) onDone((out as { questionId: string }).questionId);
      return;
    }
    const original = base.question;
    if (!original) return;
    const patch = definitionPatch(original, {
      title: title.trim(),
      context,
      options,
      ...(recommended !== undefined ? { recommendedOptionId: recommended } : {}),
      allowFreeText,
    });
    if (Object.keys(patch).length === 0) {
      onDone(original.id);
      return;
    }
    const out = await update.run(
      { sessionId: view.session.id, questionId: original.id, patch },
      {
        expectedRevision: base.revision,
        onError: (e) => {
          if (e.code === "revision_conflict") setConflict(true);
        },
      },
    );
    if (out) onDone(original.id);
  }

  const pending = create.pending || update.pending;
  return (
    <View style={{ gap: 8 }}>
      <Heading theme={theme}>{mode === "create" ? "New question" : "Edit question"}</Heading>
      <TextInput accessibilityLabel="Question title" placeholder="Title" placeholderTextColor={theme.colors.foregroundMuted} value={title} onChangeText={setTitle} style={inputStyle(theme)} />
      <TextInput
        accessibilityLabel="Question context"
        placeholder="Context (optional)"
        placeholderTextColor={theme.colors.foregroundMuted}
        value={context}
        onChangeText={setContext}
        multiline
        style={[inputStyle(theme), { minHeight: 60 }]}
      />
      <Text style={{ color: theme.colors.foreground }}>Options</Text>
      {rows.map((row, index) => (
        <View key={row.id} style={{ gap: 4, borderWidth: 1, borderColor: theme.colors.border, borderRadius: 6, padding: 8 }}>
          <TextInput
            accessibilityLabel={`Option ${index + 1} label`}
            placeholder={`Option ${index + 1}`}
            placeholderTextColor={theme.colors.foregroundMuted}
            value={row.label}
            onChangeText={(label) => setRow(index, { label })}
            style={inputStyle(theme)}
          />
          <TextInput
            accessibilityLabel={`Option ${index + 1} description`}
            placeholder="Description (optional)"
            placeholderTextColor={theme.colors.foregroundMuted}
            value={row.description}
            onChangeText={(description) => setRow(index, { description })}
            style={inputStyle(theme)}
          />
          <View style={{ flexDirection: "row", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <Toggle
              label="Recommended"
              value={recommended === row.id}
              theme={theme}
              onChange={(on) => setRecommended(on ? row.id : undefined)}
            />
            <Button
              label="Remove option"
              theme={theme}
              onPress={() => {
                setRows((rs) => rs.filter((_, i) => i !== index));
                if (recommended === row.id) setRecommended(undefined);
              }}
            />
          </View>
        </View>
      ))}
      <Button label="Add option" theme={theme} onPress={() => setRows((rs) => [...rs, { id: nextOptionId(rs), label: "", description: "" }])} />
      <Toggle label="Allow a free-text answer" value={allowFreeText} theme={theme} onChange={setAllowFreeText} />
      {mode === "edit" && question?.answer ? (
        <Muted theme={theme}>Removing the chosen option marks this question stale.</Muted>
      ) : null}
      {mode === "create" ? (
        <RelationsEditor hostId={hostId} projectId={projectId} view={view} theme={theme} draft={relations} onDraftChange={setRelations} />
      ) : null}
      {conflict ? (
        <Text style={{ color: theme.colors.statusWarning }}>
          This question changed elsewhere after you opened the editor, so nothing was saved. Your edits are still here. Review the
          current question, then cancel and reopen Edit to apply them again.
        </Text>
      ) : null}
      {error ? <Text style={{ color: theme.colors.statusDanger }}>{error}</Text> : null}
      <View style={{ flexDirection: "row", gap: 8 }}>
        <Button label={mode === "create" ? "Create question" : "Save"} theme={theme} primary disabled={pending} onPress={() => void save()} />
        <Button label="Cancel" theme={theme} onPress={() => onDone(question?.id)} />
      </View>
    </View>
  );
}
