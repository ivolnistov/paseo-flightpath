import type { PluginTheme } from "@getpaseo/plugin";
import { useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { Activation, Invalidation, Ref } from "../shared/model";
import { RelationAdd, RelationRemove, type CatalogEntry, type SessionView } from "../shared/rpc";
import { useRoadmapMutation } from "./hooks";
import { Button, Heading, Muted, Toggle } from "./ui";

export type RelationDraft = { activatedBy: Activation[]; invalidatedBy: Invalidation[] };

const sameRef = (a: Ref, b: Ref) => a.sessionId === b.sessionId && a.questionId === b.questionId;

function label(view: SessionView, ref: Ref): string {
  const entry = view.catalog.find((c) => sameRef(c.ref, ref));
  if (!entry) return "Missing question";
  return ref.sessionId === view.session.id ? entry.questionTitle : `${entry.sessionTitle} / ${entry.questionTitle}`;
}

export function RelationsEditor(props: {
  hostId: string;
  projectId: string;
  view: SessionView;
  theme: PluginTheme;
  /** Existing question; absent while creating one. */
  target?: Ref;
  draft?: RelationDraft;
  onDraftChange?(draft: RelationDraft): void;
  readOnly?: boolean;
}) {
  const { hostId, projectId, view, theme, target, draft, onDraftChange, readOnly } = props;
  const add = useRoadmapMutation(hostId, projectId, RelationAdd);
  const remove = useRoadmapMutation(hostId, projectId, RelationRemove);
  const [kind, setKind] = useState<"activation" | "invalidation">("activation");
  const [parent, setParent] = useState<CatalogEntry | null>(null);
  const [optionIds, setOptionIds] = useState<string[]>([]);

  const current: RelationDraft = useMemo(() => {
    if (draft) return draft;
    const q = target ? view.questions.find((qv) => qv.question.id === target.questionId)?.question : undefined;
    return { activatedBy: q?.activatedBy ?? [], invalidatedBy: q?.invalidatedBy ?? [] };
  }, [draft, target, view]);

  const groups = useMemo(() => {
    const out = new Map<string, CatalogEntry[]>();
    for (const entry of view.catalog) {
      if (target && sameRef(entry.ref, target)) continue;
      out.set(entry.sessionTitle, [...(out.get(entry.sessionTitle) ?? []), entry]);
    }
    return [...out.entries()];
  }, [view, target]);

  const canAdd = parent !== null && (kind === "invalidation" || optionIds.length > 0) && !readOnly;
  const reset = () => {
    setParent(null);
    setOptionIds([]);
  };

  async function onAdd() {
    if (!parent) return;
    const activation: Activation = { parent: parent.ref, optionIds };
    const invalidation: Invalidation = { upstream: parent.ref };
    if (draft && onDraftChange) {
      onDraftChange(
        kind === "activation"
          ? { ...draft, activatedBy: [...draft.activatedBy.filter((a) => !sameRef(a.parent, parent.ref)), activation] }
          : { ...draft, invalidatedBy: [...draft.invalidatedBy.filter((i) => !sameRef(i.upstream, parent.ref)), invalidation] },
      );
      reset();
      return;
    }
    if (!target) return;
    const ok = await add.run({
      relation: kind === "activation" ? { kind, target, activation } : { kind, target, invalidation },
    });
    if (ok) reset();
  }

  async function onRemove(rel: { kind: "activation"; activation: Activation } | { kind: "invalidation"; invalidation: Invalidation }) {
    if (draft && onDraftChange) {
      onDraftChange(
        rel.kind === "activation"
          ? { ...draft, activatedBy: draft.activatedBy.filter((a) => a !== rel.activation) }
          : { ...draft, invalidatedBy: draft.invalidatedBy.filter((i) => i !== rel.invalidation) },
      );
      return;
    }
    if (!target) return;
    await remove.run({ relation: { ...rel, target } });
  }

  const optionLabels = (ref: Ref, ids: string[]) => {
    const entry = view.catalog.find((c) => sameRef(c.ref, ref));
    return ids.map((id) => entry?.options.find((o) => o.id === id)?.label ?? id).join(" or ");
  };

  return (
    <View style={{ gap: 8 }}>
      <Heading theme={theme}>Relations</Heading>
      {current.activatedBy.length + current.invalidatedBy.length === 0 ? <Muted theme={theme}>No relations.</Muted> : null}
      {current.activatedBy.map((a) => (
        <View key={`a:${a.parent.sessionId}/${a.parent.questionId}`} style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <Text style={{ color: theme.colors.foreground, flexShrink: 1 }}>
            Active when {label(view, a.parent)} = {optionLabels(a.parent, a.optionIds)}
          </Text>
          {readOnly ? null : (
            <Button label="Remove" theme={theme} disabled={remove.pending} onPress={() => void onRemove({ kind: "activation", activation: a })} />
          )}
        </View>
      ))}
      {current.invalidatedBy.map((i) => (
        <View key={`i:${i.upstream.sessionId}/${i.upstream.questionId}`} style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <Text style={{ color: theme.colors.foreground, flexShrink: 1 }}>Invalidated by {label(view, i.upstream)}</Text>
          {readOnly ? null : (
            <Button label="Remove" theme={theme} disabled={remove.pending} onPress={() => void onRemove({ kind: "invalidation", invalidation: i })} />
          )}
        </View>
      ))}

      {readOnly ? null : (
        <View style={{ gap: 6, borderTopWidth: 1, borderTopColor: theme.colors.border, paddingTop: 8 }}>
          <Text style={{ color: theme.colors.foreground }}>Add relation</Text>
          <View style={{ flexDirection: "row", gap: 8 }}>
            <Button label="Activation" theme={theme} primary={kind === "activation"} onPress={() => setKind("activation")} />
            <Button label="Invalidation" theme={theme} primary={kind === "invalidation"} onPress={() => setKind("invalidation")} />
          </View>
          <Muted theme={theme}>
            {kind === "activation"
              ? "Shown only while the chosen question has one of the selected answers."
              : "Marked stale when the chosen question's answer changes or it goes out of scope."}
          </Muted>
          {groups.map(([sessionTitle, entries]) => (
            <View key={sessionTitle} style={{ gap: 2 }}>
              <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{sessionTitle}</Text>
              {entries.map((entry) => {
                const selected = parent !== null && sameRef(parent.ref, entry.ref);
                return (
                  <Pressable
                    key={`${entry.ref.sessionId}/${entry.ref.questionId}`}
                    accessibilityRole="radio"
                    accessibilityState={{ selected }}
                    accessibilityLabel={entry.questionTitle}
                    onPress={() => {
                      setParent(entry);
                      setOptionIds([]);
                    }}
                    style={{
                      paddingVertical: 6,
                      paddingHorizontal: 8,
                      borderRadius: 6,
                      borderWidth: 1,
                      borderColor: selected ? theme.colors.accent : theme.colors.border,
                    }}
                  >
                    <Text style={{ color: theme.colors.foreground }}>{entry.questionTitle}</Text>
                  </Pressable>
                );
              })}
            </View>
          ))}
          {kind === "activation" && parent ? (
            <View style={{ gap: 2 }}>
              <Muted theme={theme}>Active when the answer is:</Muted>
              {parent.options.map((o) => (
                <Toggle
                  key={o.id}
                  label={o.label}
                  value={optionIds.includes(o.id)}
                  theme={theme}
                  onChange={(on) => setOptionIds((ids) => (on ? [...ids, o.id] : ids.filter((x) => x !== o.id)))}
                />
              ))}
              {parent.options.length === 0 ? <Muted theme={theme}>This question has no options to branch on.</Muted> : null}
            </View>
          ) : null}
          <Button label="Add" theme={theme} primary disabled={!canAdd || add.pending} onPress={() => void onAdd()} />
        </View>
      )}
    </View>
  );
}
