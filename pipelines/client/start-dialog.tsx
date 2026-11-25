import { useRpc } from "@getpaseo/plugin/client";
import { useEffect, useMemo, useRef, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { runPreview, runStart, type RunError, type RunPreview } from "../shared/rpc";
import type { InputDecl } from "../shared/workflow";
import { Banner, Button, MONOSPACE, Muted, SectionTitle, type Colors } from "./ui";
import { CRITERIA_TITLE, jobTitle, providerChoices, startBlockers } from "./view-model";

/** A fresh, random key for one Start submission. */
export function newStartKey(): string {
  return `start-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/** Form values to Start inputs: empty optional fields are left out, numbers are sent as numbers when they parse. */
export function startInputs(decls: Record<string, InputDecl>, values: Record<string, string | boolean>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, decl] of Object.entries(decls)) {
    const value = values[name];
    if (decl.type === "boolean") {
      if (typeof value === "boolean") out[name] = value;
      continue;
    }
    if (typeof value !== "string" || value.trim() === "") continue;
    if (decl.type === "number") {
      const parsed = Number(value);
      out[name] = Number.isFinite(parsed) ? parsed : value;
    } else out[name] = value;
  }
  return out;
}

type StartDialogProps = {
  colors: Colors;
  compact: boolean;
  projectId: string;
  /** The saved workflow's inputs; null when the saved workflow does not parse. */
  inputs: Record<string, InputDecl> | null;
  onStarted: (runId: string) => void;
  onClose: () => void;
};

/**
 * The start key of one exact submission: a retry of the same inputs and workflow digest reuses
 * its key, so a repeated Start returns the same run; changed inputs get a new key.
 */
export function startKeyFor(keys: Map<string, string>, inputs: Record<string, unknown>, workflowDigest: string, make: () => string = newStartKey): string {
  const identity = JSON.stringify([workflowDigest, inputs]);
  let key = keys.get(identity);
  if (key === undefined) {
    key = make();
    keys.set(identity, key);
  }
  return key;
}

/** Start a run from the saved workflow: inputs, job count, primary and fallback per job, blockers. */
export function StartDialog({ colors, compact, projectId, inputs, onStarted, onClose }: StartDialogProps) {
  const preview = useRpc(runPreview);
  const start = useRpc(runStart);
  const startKeys = useRef(new Map<string, string>());
  const [values, setValues] = useState<Record<string, string | boolean>>(() =>
    Object.fromEntries(Object.entries(inputs ?? {}).flatMap(([name, decl]) => (decl.default === undefined ? [] : [[name, typeof decl.default === "boolean" ? decl.default : typeof decl.default === "string" ? decl.default : JSON.stringify(decl.default)]]))),
  );
  const sent = useMemo(() => startInputs(inputs ?? {}, values), [inputs, values]);
  const sentKey = JSON.stringify(sent);
  const [result, setResult] = useState<{ key: string; preview: RunPreview } | null>(null);
  const [error, setError] = useState<RunError | null>(null);
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    let live = true;
    const timer = setTimeout(() => {
      preview({ projectId, inputs: sent }).then(
        (answer) => {
          if (!live) return;
          if (answer.ok) {
            setResult({ key: sentKey, preview: answer.value });
            setError(null);
          } else setError(answer.error);
        },
        (failure: unknown) => live && setError({ code: "unavailable", message: failure instanceof Error ? failure.message : "The host did not answer." }),
      );
    }, 350);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [preview, projectId, sent, sentKey]);

  const current = result?.key === sentKey ? result.preview : null;
  const blockers = startBlockers(current);
  const diagnostics = [...(current?.diagnostics ?? []), ...(error?.diagnostics ?? [])];
  const taskJobs = (current?.graph?.jobs ?? []).filter((job) => job.uses === "run-task");

  const onStart = () => {
    if (!current?.workflowDigest || blockers.length > 0) return;
    setStarting(true);
    const startKey = startKeyFor(startKeys.current, sent, current.workflowDigest);
    start({ projectId, inputs: sent, workflowDigest: current.workflowDigest, startKey })
      .then((answer) => {
        if (answer.ok) onStarted(answer.value.runId);
        else setError(answer.error);
      })
      .catch((failure: unknown) => setError({ code: "unavailable", message: failure instanceof Error ? failure.message : "The host did not answer." }))
      .finally(() => setStarting(false));
  };

  return (
    <ScrollView style={{ flex: 1, backgroundColor: colors.surface0 }} contentContainerStyle={{ padding: compact ? 12 : 16, gap: 10 }} testID="start-dialog">
      <View style={{ flexDirection: "row", alignItems: "center" }}>
        <Text style={{ flex: 1, color: colors.foreground, fontSize: 16, fontWeight: "600" }}>Start run</Text>
        <Button colors={colors} compact label="Close" onPress={onClose} />
      </View>
      {current?.hasDraft ? <Banner colors={colors} tone="info" text="The workflow has unsaved draft changes. A run starts from the saved workflow." testID="start-draft-note" /> : null}
      {inputs === null ? <Muted colors={colors} text="The saved workflow does not parse, so it declares no inputs here." /> : null}
      {Object.entries(inputs ?? {}).map(([name, decl]) => {
        const value = values[name];
        const own = diagnostics.filter((diagnostic) => diagnostic.input === name);
        const label = `${name}${decl.required ? "" : " (optional)"} · ${decl.type}`;
        return (
          <View key={name} style={{ gap: 4 }}>
            <Text style={{ color: colors.foreground, fontSize: 13 }}>{label}</Text>
            {decl.description ? <Muted colors={colors} text={decl.description} /> : null}
            {decl.type === "boolean" ? (
              <Pressable accessibilityRole="switch" accessibilityState={{ checked: value === true }} onPress={() => setValues({ ...values, [name]: value !== true })} style={{ flexDirection: "row", gap: 6, alignItems: "center" }}>
                <View style={{ width: 18, height: 18, borderRadius: 4, borderWidth: 1, borderColor: colors.border, backgroundColor: value === true ? colors.accent : colors.surface0 }} />
                <Text style={{ color: colors.foreground }}>{value === true ? "true" : "false"}</Text>
              </Pressable>
            ) : (
              <TextInput
                testID={`start-input-${name}`}
                accessibilityLabel={name}
                value={typeof value === "string" ? value : ""}
                onChangeText={(text) => setValues({ ...values, [name]: text })}
                multiline={decl.type === "tasks"}
                autoCapitalize="none"
                autoCorrect={false}
                placeholder={decl.type === "tasks" ? "- id: api\n  title: …\n  done: [{ criterion: … }]" : undefined}
                placeholderTextColor={colors.foregroundMuted}
                style={{ borderWidth: 1, borderColor: own.length > 0 ? colors.statusDanger : colors.border, borderRadius: 6, padding: 8, minHeight: decl.type === "tasks" ? 140 : undefined, color: colors.foreground, fontFamily: decl.type === "tasks" ? MONOSPACE : undefined, fontSize: 13, textAlignVertical: "top" }}
              />
            )}
            {own.map((diagnostic, index) => (
              <Text key={index} style={{ color: colors.statusDanger, fontSize: 12, fontFamily: MONOSPACE }}>
                {diagnostic.line > 0 ? `${diagnostic.line}:${diagnostic.column} ` : ""}[{diagnostic.code}] {diagnostic.message}
              </Text>
            ))}
          </View>
        );
      })}
      {taskJobs.length > 0 ? (
        <View style={{ gap: 6 }}>
          <SectionTitle colors={colors} text={`Tasks and their ${CRITERIA_TITLE.toLowerCase()}`} />
          {taskJobs.map((job) => (
            <View key={job.id} style={{ padding: 8, borderRadius: 6, borderWidth: 1, borderColor: colors.border, gap: 2 }}>
              <Text style={{ color: colors.foreground, fontWeight: "600" }}>{jobTitle(job)}</Text>
              <Muted colors={colors} mono text={job.id} />
              {job.done.length === 0 ? <Muted colors={colors} text="No acceptance criteria." /> : null}
              {job.done.map((item, index) => (
                <Text key={index} style={{ color: colors.foreground, fontSize: 12 }}>
                  • {"criterion" in item ? item.criterion : `run: ${typeof item.run === "string" ? item.run : item.run.join(" ")}`}
                </Text>
              ))}
              {job.humanAcceptance ? <Muted colors={colors} text="A person accepts this task." /> : null}
            </View>
          ))}
        </View>
      ) : null}
      <SectionTitle colors={colors} text="Jobs" />
      <Muted colors={colors} text={current ? `${current.jobCount} job${current.jobCount === 1 ? "" : "s"}` : "Checking…"} />
      {(current?.graph?.jobs ?? []).map((job) => {
        const choices = providerChoices(current?.settings[job.id]);
        if (choices.length === 0) return null;
        return (
          <View key={job.id} style={{ gap: 2 }}>
            <Text style={{ color: colors.foreground, fontSize: 12 }}>{jobTitle(job)}</Text>
            {choices.map((choice) => (
              <Muted key={`${choice.role}-${choice.target}`} colors={colors} mono text={`${choice.role} ${choice.target}: ${choice.label}`} />
            ))}
          </View>
        );
      })}
      {diagnostics.filter((diagnostic) => diagnostic.input === undefined).map((diagnostic, index) => (
        <Text key={index} style={{ color: colors.statusDanger, fontSize: 12, fontFamily: MONOSPACE }}>
          [{diagnostic.code}] {diagnostic.message}
        </Text>
      ))}
      {error && !error.diagnostics ? <Banner colors={colors} tone="danger" text={error.message} /> : null}
      {blockers.map((blocker) => (
        <Text key={blocker} style={{ color: colors.statusWarning, fontSize: 12 }}>
          {blocker}
        </Text>
      ))}
      <View style={{ flexDirection: "row" }}>
        <Button colors={colors} primary label={starting ? "Starting…" : "Start"} testID="start-run" disabled={blockers.length > 0 || starting} onPress={onStart} />
      </View>
    </ScrollView>
  );
}
