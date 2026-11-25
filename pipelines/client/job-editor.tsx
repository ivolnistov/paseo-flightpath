import { usePaseo } from "@getpaseo/plugin/client";
import { useEffect, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { REASONING_LEVELS, type Job, type Reasoning, type Workflow } from "../shared/workflow";
import { addOp, dependents, editOp, editorLocks, editorState, NEW_BLOCK_USES, newBlockProblem, type AgentSelection, type EditorState, type NewBlock, type NewBlockUses } from "./edit-model";
import type { EditOp } from "./hooks";
import { catalogGroups, findModel, reasoningChoices, searchCatalog, type CatalogGroup } from "./model-catalog";
import { Banner, Button, MONOSPACE, Muted, SectionTitle, type Colors } from "./ui";
import { CRITERIA_TITLE } from "./view-model";

export type ModelCatalog = { status: "loading" } | { status: "unavailable"; reason: string } | { status: "ready"; groups: CatalogGroup[]; profiles: string[] };

/** The selected host's provider catalog and agent profiles, refreshed when providers change. */
export function useModelCatalog(): { catalog: ModelCatalog; retry: () => void } {
  const paseo = usePaseo();
  const [catalog, setCatalog] = useState<ModelCatalog>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    const load = async (): Promise<void> => {
      try {
        let snapshot = await paseo.providers.snapshot();
        if (catalogGroups(snapshot.entries).length === 0 && snapshot.entries.some((entry) => entry.status === "loading")) {
          snapshot = await paseo.providers.waitForReady({ timeoutMs: 15_000 }).catch(() => snapshot);
        }
        const config = await paseo.config.get().catch(() => null);
        const groups = catalogGroups(snapshot.entries);
        const profiles = (config?.config.agentProfiles ?? []).map((profile) => profile.name);
        if (!live) return;
        setCatalog(groups.length === 0 && profiles.length === 0 ? { status: "unavailable", reason: "No enabled provider lists models." } : { status: "ready", groups, profiles });
      } catch (error) {
        if (live) setCatalog({ status: "unavailable", reason: error instanceof Error ? error.message : "The host did not answer." });
      }
    };
    void load();
    const release = paseo.providers.subscribe(() => void load());
    return () => {
      live = false;
      release();
    };
  }, [paseo, attempt]);
  return { catalog, retry: () => setAttempt((value) => value + 1) };
}

const inputStyle = (colors: Colors, multiline = false) => ({
  borderWidth: 1,
  borderColor: colors.border,
  borderRadius: 6,
  paddingHorizontal: 8,
  paddingVertical: 6,
  minHeight: multiline ? 64 : undefined,
  color: colors.foreground,
  backgroundColor: colors.surface0,
  fontSize: 13,
  textAlignVertical: multiline ? ("top" as const) : undefined,
});

function Field({ colors, label, value, onChange, multiline = false, testID, mono = false }: { colors: Colors; label: string; value: string; onChange: (value: string) => void; multiline?: boolean; testID: string; mono?: boolean }) {
  return (
    <View style={{ gap: 4 }}>
      <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>{label}</Text>
      <TextInput
        testID={testID}
        accessibilityLabel={label}
        value={value}
        onChangeText={onChange}
        multiline={multiline}
        autoCapitalize="none"
        autoCorrect={false}
        placeholderTextColor={colors.foregroundMuted}
        style={{ ...inputStyle(colors, multiline), fontFamily: mono ? MONOSPACE : undefined }}
      />
    </View>
  );
}

export function Choice<T extends string>({ colors, options, value, onChange, testID }: { colors: Colors; options: ReadonlyArray<{ value: T; label: string }>; value: T; onChange: (value: T) => void; testID: string }) {
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <Pressable
            key={option.value}
            testID={`${testID}-${option.value}`}
            accessibilityRole="radio"
            accessibilityState={{ selected }}
            onPress={() => onChange(option.value)}
            style={{ paddingHorizontal: 10, paddingVertical: 5, borderRadius: 12, borderWidth: 1, borderColor: selected ? colors.accent : colors.border, backgroundColor: selected ? colors.surface2 : colors.surface0 }}
          >
            <Text style={{ color: selected ? colors.foreground : colors.foregroundMuted, fontSize: 12 }}>{option.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/** Picks `<provider>/<model>` from the host catalog, searchable; a value the catalog lacks stays as written. */
function ModelPicker({ colors, catalog, value, onChange, testID, noneLabel }: { colors: Colors; catalog: ModelCatalog; value: string; onChange: (value: string) => void; testID: string; noneLabel?: string }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const groups = catalog.status === "ready" ? catalog.groups : [];
  const known = value === "" ? null : findModel(groups, value);
  const shown = searchCatalog(groups, query).map((group) => ({ ...group, models: group.models.slice(0, 30) }));
  return (
    <View style={{ gap: 4 }}>
      <Pressable testID={testID} accessibilityRole="button" accessibilityLabel={`Model: ${value || noneLabel || "none"}`} onPress={() => setOpen(!open)} style={{ ...inputStyle(colors), flexDirection: "row" }}>
        <Text numberOfLines={1} style={{ flex: 1, color: value ? colors.foreground : colors.foregroundMuted, fontSize: 13 }}>
          {value === "" ? (noneLabel ?? "Choose a model") : (known?.label ?? value)}
        </Text>
        <Text style={{ color: colors.foregroundMuted }}>{open ? "▴" : "▾"}</Text>
      </Pressable>
      {value !== "" ? <Muted colors={colors} mono text={`${value}${known || catalog.status !== "ready" ? "" : " · not in this host's catalog, kept as written"}`} /> : null}
      {open ? (
        <View style={{ gap: 4, padding: 6, borderRadius: 6, borderWidth: 1, borderColor: colors.border }}>
          {catalog.status === "loading" ? <Muted colors={colors} text="Loading the provider catalog…" /> : null}
          {catalog.status === "unavailable" ? <Muted colors={colors} text={`Provider catalog unavailable: ${catalog.reason}. The model stays editable in YAML.`} /> : null}
          {catalog.status === "ready" ? (
            <TextInput
              testID={`${testID}-search`}
              accessibilityLabel="Search models"
              value={query}
              onChangeText={setQuery}
              placeholder="Search provider or model"
              placeholderTextColor={colors.foregroundMuted}
              autoCapitalize="none"
              autoCorrect={false}
              style={inputStyle(colors)}
            />
          ) : null}
          {noneLabel ? (
            <Pressable accessibilityRole="button" onPress={() => (onChange(""), setOpen(false))} style={{ padding: 6 }}>
              <Text style={{ color: colors.foreground, fontSize: 13 }}>{noneLabel}</Text>
            </Pressable>
          ) : null}
          <ScrollView style={{ maxHeight: 220 }}>
            {shown.map((group) => (
              <View key={group.provider} style={{ gap: 2 }}>
                <Text style={{ color: colors.foregroundMuted, fontSize: 11 }}>{group.label}</Text>
                {group.models.map((model) => (
                  <Pressable
                    key={model.value}
                    testID={`${testID}-option-${model.value}`}
                    accessibilityRole="button"
                    accessibilityState={{ selected: model.value === value }}
                    onPress={() => {
                      onChange(model.value);
                      setOpen(false);
                      setQuery("");
                    }}
                    style={{ padding: 6, borderRadius: 4, backgroundColor: model.value === value ? colors.surface2 : undefined }}
                  >
                    <Text style={{ color: colors.foreground, fontSize: 13 }}>{model.label}</Text>
                    <Muted colors={colors} mono text={model.value} />
                  </Pressable>
                ))}
              </View>
            ))}
          </ScrollView>
        </View>
      ) : null}
    </View>
  );
}

function ReasoningPicker({ colors, catalog, model, value, onChange, testID, unsetLabel }: { colors: Colors; catalog: ModelCatalog; model: string | null; value: Reasoning | null; onChange: (value: Reasoning | null) => void; testID: string; unsetLabel: string }) {
  const choices = reasoningChoices(catalog.status === "ready" ? catalog.groups : null, model, value);
  const options = [{ value: "unset" as const, label: unsetLabel }, ...choices.options.flatMap((option) => (isReasoning(option.value) ? [{ value: option.value, label: option.label }] : []))];
  return (
    <View style={{ gap: 4 }}>
      <Choice<"unset" | Reasoning> colors={colors} testID={testID} options={options} value={value ?? "unset"} onChange={(next) => onChange(next === "unset" ? null : next)} />
      {choices.note ? <Muted colors={colors} text={choices.note} /> : null}
    </View>
  );
}

function isReasoning(value: string): value is Reasoning {
  return (REASONING_LEVELS as readonly string[]).includes(value);
}

function NeedsPicker({ colors, model, jobId, needs, onChange }: { colors: Colors; model: Pick<Workflow, "jobs">; jobId: string | null; needs: readonly string[]; onChange: (needs: string[]) => void }) {
  const blocked = jobId === null ? new Set<string>() : dependents(model, jobId);
  const candidates = model.jobs.filter((job) => job.id !== jobId);
  if (candidates.length === 0) return <Muted colors={colors} text="No other blocks yet." />;
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
      {candidates.map((job) => {
        const checked = needs.includes(job.id);
        const cycle = !checked && blocked.has(job.id);
        return (
          <Pressable
            key={job.id}
            testID={`need-${job.id}`}
            accessibilityRole="checkbox"
            accessibilityState={{ checked, disabled: cycle }}
            accessibilityHint={cycle ? "Needing this block would form a cycle" : undefined}
            disabled={cycle}
            onPress={() => onChange(checked ? needs.filter((need) => need !== job.id) : [...needs, job.id])}
            style={{ paddingHorizontal: 8, paddingVertical: 4, borderRadius: 12, borderWidth: 1, borderColor: checked ? colors.accent : colors.border, opacity: cycle ? 0.5 : 1 }}
          >
            <Text style={{ color: checked ? colors.foreground : colors.foregroundMuted, fontSize: 12 }}>
              {checked ? "✓ " : ""}
              {job.id}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

type JobEditorProps = {
  colors: Colors;
  compact: boolean;
  model: Workflow;
  job: Job;
  /** False when the views show the saved workflow under an invalid draft. */
  editable: boolean;
  busy: boolean;
  onApply: (op: EditOp) => Promise<boolean>;
  onClose: () => void;
};

/** A task's settings and acceptance criteria; Apply writes one server edit to the shared draft. */
export function JobEditor({ colors, compact, model, job, editable, busy, onApply, onClose }: JobEditorProps) {
  const [state, setState] = useState<EditorState>(() => editorState(job));
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => setState(editorState(job)), [job]);
  const { catalog, retry } = useModelCatalog();
  const locks = editorLocks(job);
  const op = editOp(job, state);
  const patch = (next: Partial<EditorState>) => setState((current) => ({ ...current, ...next }));
  const agent = state.agent;
  const setAgent = (next: Partial<NonNullable<EditorState["agent"]>>) => agent && patch({ agent: { ...agent, ...next } });
  const inherited = model.defaults.agent;
  const inheritedText = inherited.profile ? `profile ${inherited.profile}` : (inherited.model ?? "no default");
  const selectionModel = agent?.selection.kind === "model" ? agent.selection.value : agent?.selection.kind === "inherit" && !inherited.profile ? (inherited.model ?? null) : null;

  return (
    <ScrollView style={{ flex: 1, backgroundColor: colors.surface0 }} contentContainerStyle={{ padding: compact ? 12 : 16, gap: 10 }} testID="job-editor">
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Text style={{ flex: 1, color: colors.foreground, fontSize: 16, fontWeight: "600" }}>{job.name ?? job.id}</Text>
        <Button colors={colors} compact label="Close" onPress={onClose} testID="editor-close" />
      </View>
      <Muted colors={colors} mono text={`${job.id} · uses ${job.uses}`} />
      {!editable ? <Banner colors={colors} tone="warning" text="The YAML draft has errors, so this shows the saved workflow. Fix the draft in YAML to edit." /> : null}
      <Field colors={colors} label="Name" value={state.name} onChange={(name) => patch({ name })} testID="editor-name" />
      <Field colors={colors} label="Description" value={state.description} onChange={(description) => patch({ description })} multiline testID="editor-description" />
      {state.prompt !== null ? (
        <Field colors={colors} label="Prompt (with.prompt)" value={state.prompt} onChange={(prompt) => patch({ prompt })} multiline mono testID="editor-prompt" />
      ) : locks.prompt && job.with.prompt !== undefined ? (
        <Muted colors={colors} text={locks.prompt} />
      ) : null}
      {state.acceptance !== null ? (
        <View style={{ gap: 4 }}>
          <SectionTitle colors={colors} text="Acceptance" />
          <Choice<"auto" | "human">
            colors={colors}
            testID="editor-acceptance"
            options={[
              { value: "auto", label: "Automatic" },
              { value: "human", label: "Human accepts" },
            ]}
            value={state.acceptance}
            onChange={(acceptance) => patch({ acceptance })}
          />
        </View>
      ) : null}
      <SectionTitle colors={colors} text="Execution settings" />
      {agent ? (
        <View style={{ gap: 8 }}>
          <Choice<AgentSelection["kind"]>
            colors={colors}
            testID="editor-selection"
            options={[
              { value: "inherit", label: `Inherit (${inheritedText})` },
              { value: "profile", label: "Profile" },
              { value: "model", label: "Model" },
            ]}
            value={agent.selection.kind}
            onChange={(kind) => setAgent({ selection: kind === "inherit" ? { kind } : { kind, value: agent.selection.kind === kind ? agent.selection.value : "" } })}
          />
          {agent.selection.kind === "model" ? (
            <ModelPicker colors={colors} catalog={catalog} value={agent.selection.value} onChange={(value) => setAgent({ selection: { kind: "model", value } })} testID="editor-model" />
          ) : null}
          {agent.selection.kind === "profile" ? (
            catalog.status === "ready" && catalog.profiles.length > 0 ? (
              <Choice<string> colors={colors} testID="editor-profile" options={catalog.profiles.map((name) => ({ value: name, label: name }))} value={agent.selection.value} onChange={(value) => setAgent({ selection: { kind: "profile", value } })} />
            ) : (
              <Field colors={colors} label="Profile" value={agent.selection.value} onChange={(value) => setAgent({ selection: { kind: "profile", value } })} testID="editor-profile-text" />
            )
          ) : null}
          <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>Reasoning</Text>
          <ReasoningPicker colors={colors} catalog={catalog} model={selectionModel} value={agent.reasoning} onChange={(reasoning) => setAgent({ reasoning })} testID="editor-reasoning" unsetLabel={`Inherit${inherited.reasoning ? ` (${inherited.reasoning})` : ""}`} />
          <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>Fallback model</Text>
          <ModelPicker
            colors={colors}
            catalog={catalog}
            value={agent.fallback?.model ?? ""}
            noneLabel={inherited.fallback ? `Inherit (${inherited.fallback.model})` : "No fallback"}
            onChange={(value) => setAgent({ fallback: value === "" ? null : { model: value, reasoning: agent.fallback?.reasoning ?? null } })}
            testID="editor-fallback"
          />
          {agent.fallback ? (
            <ReasoningPicker colors={colors} catalog={catalog} model={agent.fallback.model} value={agent.fallback.reasoning} onChange={(reasoning) => agent.fallback && setAgent({ fallback: { ...agent.fallback, reasoning } })} testID="editor-fallback-reasoning" unsetLabel="Model default" />
          ) : null}
          <Field
            colors={colors}
            label="Retries (0–10, empty inherits)"
            value={agent.retries === null ? "" : String(agent.retries)}
            onChange={(value) => {
              const parsed = Number.parseInt(value, 10);
              setAgent({ retries: value.trim() === "" || !Number.isFinite(parsed) ? null : Math.min(10, Math.max(0, parsed)) });
            }}
            testID="editor-retries"
          />
          {catalog.status === "unavailable" ? <Button colors={colors} compact label="Retry catalog" onPress={retry} /> : null}
        </View>
      ) : (
        <Muted colors={colors} text={locks.agent ?? "No agent settings."} />
      )}
      <SectionTitle colors={colors} text={CRITERIA_TITLE} />
      {locks.criteria === null ? (
        <View style={{ gap: 6 }}>
          {state.criteria.map((criterion, index) => (
            <View key={index} style={{ flexDirection: "row", gap: 6, alignItems: "flex-start" }}>
              <View style={{ flex: 1 }}>
                <Field colors={colors} label={`Criterion ${index + 1}`} value={criterion} onChange={(text) => patch({ criteria: state.criteria.map((value, i) => (i === index ? text : value)) })} multiline testID={`editor-criterion-${index}`} />
              </View>
              <Button colors={colors} compact danger label="Remove" onPress={() => patch({ criteria: state.criteria.filter((_, i) => i !== index) })} />
            </View>
          ))}
          <View style={{ flexDirection: "row" }}>
            <Button colors={colors} compact label="Add criterion" testID="editor-add-criterion" onPress={() => patch({ criteria: [...state.criteria, ""] })} />
          </View>
          {job.done.some((item) => "run" in item) ? <Muted colors={colors} text="Command checks in `done` are kept; edit them in YAML." /> : null}
        </View>
      ) : (
        <Muted colors={colors} text={locks.criteria} />
      )}
      <SectionTitle colors={colors} text="Needs" />
      <NeedsPicker colors={colors} model={model} jobId={job.id} needs={state.needs} onChange={(needs) => patch({ needs })} />
      {job.strategy || job.rework ? <Muted colors={colors} text="Matrix and rework settings are edited in YAML." /> : null}
      {notice ? <Banner colors={colors} tone="danger" text={notice} /> : null}
      <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
        <Button
          colors={colors}
          primary
          label={busy ? "Applying…" : "Apply to draft"}
          testID="editor-apply"
          disabled={!editable || busy || op === null}
          onPress={() => {
            if (op === null) return;
            setNotice(null);
            void onApply(op).then((ok) => {
              if (!ok) setNotice("The edit was not applied. See the message above.");
            });
          }}
        />
        <Button colors={colors} label="Reset" disabled={op === null} onPress={() => setState(editorState(job))} />
        <Button colors={colors} danger label="Remove block" disabled={!editable || busy} onPress={() => void onApply({ kind: "job.remove", id: job.id }).then((ok) => ok && onClose())} />
      </View>
    </ScrollView>
  );
}

const USES_LABEL: Record<NewBlockUses, string> = { agent: "Agent", checks: "Checks", review: "Review", approval: "Final approval" };

/** A new block with basic settings; everything else is edited afterwards. */
export function AddBlock({ colors, compact, model, busy, onApply, onClose }: { colors: Colors; compact: boolean; model: Workflow; busy: boolean; onApply: (op: EditOp) => Promise<boolean>; onClose: (addedId: string | null) => void }) {
  const [block, setBlock] = useState<NewBlock>({ uses: "agent", name: "", prompt: "", command: "", needs: [] });
  const patch = (next: Partial<NewBlock>) => setBlock((current) => ({ ...current, ...next }));
  const problem = newBlockProblem(block);
  const op = addOp(block, model.jobs.map((job) => job.id));
  return (
    <ScrollView style={{ flex: 1, backgroundColor: colors.surface0 }} contentContainerStyle={{ padding: compact ? 12 : 16, gap: 10 }} testID="add-block">
      <View style={{ flexDirection: "row", alignItems: "center" }}>
        <Text style={{ flex: 1, color: colors.foreground, fontSize: 16, fontWeight: "600" }}>Add block</Text>
        <Button colors={colors} compact label="Close" onPress={() => onClose(null)} />
      </View>
      <Choice<NewBlockUses> colors={colors} testID="add-uses" options={NEW_BLOCK_USES.map((uses) => ({ value: uses, label: USES_LABEL[uses] }))} value={block.uses} onChange={(uses) => patch({ uses })} />
      <Field colors={colors} label="Name" value={block.name} onChange={(name) => patch({ name })} testID="add-name" />
      <Muted colors={colors} mono text={`id: ${op.id}`} />
      {block.uses === "checks" ? (
        <Field colors={colors} label="Command" value={block.command} onChange={(command) => patch({ command })} mono testID="add-command" />
      ) : (
        <Field colors={colors} label={block.uses === "agent" ? "Prompt" : "Prompt (optional)"} value={block.prompt} onChange={(prompt) => patch({ prompt })} multiline mono testID="add-prompt" />
      )}
      <SectionTitle colors={colors} text="Needs" />
      <NeedsPicker colors={colors} model={model} jobId={null} needs={block.needs} onChange={(needs) => patch({ needs })} />
      {problem ? <Muted colors={colors} text={problem} /> : null}
      <View style={{ flexDirection: "row", gap: 8 }}>
        <Button colors={colors} primary label={busy ? "Adding…" : "Add to draft"} testID="add-apply" disabled={problem !== null || busy} onPress={() => void onApply(op).then((ok) => ok && onClose(op.kind === "job.add" ? op.id : null))} />
      </View>
    </ScrollView>
  );
}
