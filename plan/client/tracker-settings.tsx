import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useSettings } from "@getpaseo/plugin/client";
import { ScrollView } from "@getpaseo/plugin/client/react-native";
import { SettingsAction, SettingsInput, SettingsSection, SettingsSelect } from "@getpaseo/plugin/client/ui";
import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import { canonicalJson } from "../shared/canonical";
import { trackerSettings, type TrackerSettings } from "../shared/settings";

const PROJECT_KEY_RE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Host settings for tracker sync: provider, mode, project key and the per-project close field and
 * value. No credentials are stored here.
 */
export function TrackerSettingsScreen({ theme }: PluginSurfaceProps) {
  const settings = useSettings(trackerSettings);
  // The draft is pinned to the revision it was taken from; Save writes against that revision only.
  const [draft, setDraft] = useState<{ values: TrackerSettings; revision: string } | null>(null);
  // Close config is edited as a pair; an incomplete pair is kept out of the saved settings.
  const [closeDraft, setCloseDraft] = useState<Record<string, { field: string; value: string }>>({});
  const ready = settings.status === "ready" ? settings : null;

  useEffect(() => {
    if (ready && draft === null) setDraft({ values: ready.values, revision: ready.revision });
  }, [ready, draft]);

  if (settings.status === "loading") return <Text style={{ color: theme.colors.foregroundMuted, padding: 16 }}>Loading…</Text>;
  if (settings.status === "error" || settings.status === "invalid") {
    return (
      <View style={{ padding: 16, gap: 8 }}>
        <Text style={{ color: theme.colors.statusWarning }}>Tracker settings could not be read; the plugin uses the defaults (no provider, dry run).</Text>
        <SettingsAction label="Reset to defaults" actionLabel="Reset" onPress={() => void settings.reset()} />
      </View>
    );
  }
  if (!draft) return null;

  const values = draft.values;
  const keyValid = values.projectKey === undefined || PROJECT_KEY_RE.test(values.projectKey);
  const changedElsewhere = settings.revision !== draft.revision;
  // Semantic comparison: clearing and retyping a key reorders properties without changing a setting.
  const changed = canonicalJson(values) !== canonicalJson(settings.values) || changedElsewhere;
  const update = (patch: Partial<TrackerSettings>) => {
    // A cleared optional key is omitted, not kept as undefined: the host save boundary accepts JSON only.
    const next = { ...values, ...patch };
    if (next.projectKey === undefined) delete next.projectKey;
    setDraft({ values: next, revision: draft.revision });
  };
  const reload = () => {
    setCloseDraft({});
    setDraft({ values: settings.values, revision: settings.revision });
  };
  const closePair = (key: string) => closeDraft[key] ?? values.closeByProject[key] ?? { field: "", value: "" };
  const setClose = (key: string, patch: Partial<{ field: string; value: string }>) => {
    const next = { ...closePair(key), ...patch };
    setCloseDraft((d) => ({ ...d, [key]: next }));
    // A complete pair replaces the entry and two blank inputs remove it. An incomplete pair leaves the
    // last complete entry in place, so switching projects mid-edit cannot save a deletion.
    const map = { ...values.closeByProject };
    if (next.field && next.value) map[key] = next;
    else if (!next.field && !next.value) delete map[key];
    else return;
    update({ closeByProject: map });
  };
  const currentPair = values.projectKey ? closePair(values.projectKey) : { field: "", value: "" };
  const closeValid = !currentPair.field === !currentPair.value;

  return (
    <ScrollView contentContainerStyle={{ padding: 16, gap: 16 }}>
      <SettingsSection title="Tracker">
        <SettingsSelect
          label="Provider"
          hint="Where approved plan tasks are mirrored. None keeps everything local."
          value={values.provider}
          options={[
            { label: "None", value: "none" },
            { label: "SnailOrbit", value: "snailorbit" },
          ]}
          onValueChange={(provider) => update({ provider })}
        />
        <SettingsSelect
          label="Mode"
          hint="Live sends real tracker writes after you confirm each batch. Dry run only shows what would be sent. Whether a live connection is configured is shown in the tracker preview."
          value={values.mode}
          options={[
            { label: "Dry run", value: "dry-run" },
            { label: "Live", value: "live" },
          ]}
          onValueChange={(mode) => update({ mode })}
        />
        <SettingsInput
          key={draft.revision}
          label="Project key"
          hint="Tracker project for new issues. Letters, digits, _ or -."
          initialValue={values.projectKey ?? ""}
          placeholder="ABC"
          error={keyValid ? null : "Use 1–64 letters, digits, _ or -."}
          onChangeText={(text) => update({ projectKey: text.trim() === "" ? undefined : text.trim() })}
        />
        {values.projectKey && keyValid ? (
          <>
            <SettingsInput
              key={`${draft.revision}:field:${values.projectKey}`}
              label="Close field"
              hint={`Field set when closing issues in ${values.projectKey}, for example State. Leave both empty to never close issues there.`}
              initialValue={values.closeByProject[values.projectKey]?.field ?? ""}
              placeholder="State"
              onChangeText={(text) => setClose(values.projectKey!, { field: text.trim() })}
            />
            <SettingsInput
              key={`${draft.revision}:value:${values.projectKey}`}
              label="Close value"
              hint="The final value that closes an issue, for example Done."
              initialValue={values.closeByProject[values.projectKey]?.value ?? ""}
              placeholder="Done"
              error={closeValid ? null : "Set both the close field and the close value, or neither."}
              onChangeText={(text) => setClose(values.projectKey!, { value: text.trim() })}
            />
          </>
        ) : null}
        <SettingsAction
          label="Save tracker settings"
          actionLabel={settings.saving ? "Saving…" : "Save"}
          disabled={!changed || !keyValid || !closeValid || changedElsewhere || settings.saving}
          error={settings.saveError}
          onPress={() => void settings.save(values, draft.revision)}
        />
        {changedElsewhere ? (
          <SettingsAction
            label="These settings were changed elsewhere"
            hint="Save is disabled so the other change is not overwritten. Reload to edit the current settings; your unsaved changes are discarded."
            actionLabel="Reload"
            onPress={reload}
          />
        ) : null}
      </SettingsSection>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
        Live mode uses the SnailOrbit connection configured for Codex on this machine (a url-only entry); no credentials are stored
        here. Issues are closed only for projects with a close field and value. Outcomes that stay unknown are listed in the plan view
        and are never resent automatically.
      </Text>
    </ScrollView>
  );
}
