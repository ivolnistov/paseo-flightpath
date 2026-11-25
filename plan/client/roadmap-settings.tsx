// Host settings for roadmap execution (Stage R4.5a, task card §6.2): repair ceiling, runner bounds,
// review command, base ref, the coordinator profile for delegated starts and the global DoD template;
// and for feature discussions the discussion profile, the languages offered besides English and a
// reserved translation profile.
// Same pattern as the tracker screen: the draft is pinned to the revision it was taken from, Save is
// refused when the settings changed elsewhere (Reload, never overwrite or retry), and invalid stored
// settings fall back to the defaults with a Reset. Validation is the settings schema itself.
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useSettings } from "@getpaseo/plugin/client";
import { ScrollView, TextInput } from "@getpaseo/plugin/client/react-native";
import { SettingsAction, SettingsInput, SettingsSection, SettingsSelect } from "@getpaseo/plugin/client/ui";
import { useEffect, useState, type ReactNode } from "react";
import { Text, View } from "react-native";
import { canonicalJson } from "../shared/canonical";
import { DISCUSSION_LANGUAGE_MAX, DISCUSSION_LANGUAGES_MAX, discussionLanguageChoices, roadmapSettings, type RoadmapSettings } from "../shared/settings";
import { useProfiles } from "./hooks";

export type SettingsForm = {
  dodTemplate: string;
  repairCeiling: string;
  reviewCommand: string;
  checkTimeoutMs: string;
  reviewTimeoutMs: string;
  maxBuffer: string;
  baseRef: string;
  /** "" = none. */
  coordinatorProfile: string;
  /** "" = none. */
  discussionProfile: string;
  /** "" = none; reserved, no translation is performed. */
  translationProfile: string;
};

const INTEGER_KEYS = ["repairCeiling", "checkTimeoutMs", "reviewTimeoutMs", "maxBuffer"] as const;
const TEXT_KEYS = ["reviewCommand", "baseRef", "coordinatorProfile", "discussionProfile", "translationProfile"] as const;
type ProfileKey = "coordinatorProfile" | "discussionProfile" | "translationProfile";
const FORM_KEYS: ReadonlyArray<string> = [...INTEGER_KEYS, ...TEXT_KEYS, "dodTemplate"];
const isFormKey = (key: unknown): key is keyof SettingsForm => typeof key === "string" && FORM_KEYS.includes(key);

export function settingsDraft(values: RoadmapSettings): SettingsForm {
  return {
    dodTemplate: values.dodTemplate ?? "",
    repairCeiling: String(values.repairCeiling),
    reviewCommand: values.reviewCommand ?? "",
    checkTimeoutMs: String(values.checkTimeoutMs),
    reviewTimeoutMs: String(values.reviewTimeoutMs),
    maxBuffer: String(values.maxBuffer),
    baseRef: values.baseRef ?? "",
    coordinatorProfile: values.coordinatorProfile ?? "",
    discussionProfile: values.discussionProfile ?? "",
    translationProfile: values.translationProfile ?? "",
  };
}

/**
 * Text fields are trimmed and "" omits the optional key (the DoD template keeps its text as typed
 * unless it is blank). Integer fields must be whole numbers; the result is then validated by
 * `roadmapSettings.schema`, and the first issue of each field is reported on that field.
 */
export function parseSettingsDraft(
  form: SettingsForm,
): { ok: true; values: RoadmapSettings } | { ok: false; errors: Partial<Record<keyof SettingsForm, string>> } {
  const errors: Partial<Record<keyof SettingsForm, string>> = {};
  const candidate: Record<string, unknown> = {};
  for (const key of INTEGER_KEYS) {
    const text = form[key].trim();
    const n = Number(text);
    if (text === "" || !Number.isInteger(n)) errors[key] = "Enter a whole number.";
    else candidate[key] = n;
  }
  for (const key of TEXT_KEYS) {
    const text = form[key].trim();
    if (text !== "") candidate[key] = text;
  }
  if (form.dodTemplate.trim() !== "") candidate.dodTemplate = form.dodTemplate;
  const parsed = roadmapSettings.schema.safeParse(candidate);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const key = issue.path[0];
      if (isFormKey(key) && errors[key] === undefined) errors[key] = issue.message;
    }
  }
  if (Object.keys(errors).length > 0 || !parsed.success) return { ok: false, errors };
  return { ok: true, values: parsed.data };
}

/** The additional discussion languages as one comma-separated text. */
export const languagesDraft = (values: Pick<RoadmapSettings, "discussionLanguages">): string => (values.discussionLanguages ?? []).join(", ");

/** Comma-separated labels, trimmed, without English (always offered) or repeats. */
export function parseLanguagesDraft(text: string): { ok: true; languages: string[] } | { ok: false; error: string } {
  const languages = discussionLanguageChoices(text.split(",")).slice(1);
  if (languages.some((l) => l.length > DISCUSSION_LANGUAGE_MAX)) return { ok: false, error: `Each language is at most ${DISCUSSION_LANGUAGE_MAX} characters.` };
  if (languages.length > DISCUSSION_LANGUAGES_MAX) return { ok: false, error: `At most ${DISCUSSION_LANGUAGES_MAX} additional languages.` };
  return { ok: true, languages };
}

/** "None" first, then each saved profile by id, labelled with its name; never a model or provider. */
export function profileChoice(profiles: Array<{ id: string; label: string }>): Array<{ label: string; value: string }> {
  return [{ label: "None", value: "" }, ...profiles.map((p) => ({ label: p.label, value: p.id }))];
}

export function RoadmapSettingsScreen(props: PluginSurfaceProps): ReactNode {
  const { theme } = props;
  const settings = useSettings(roadmapSettings);
  const profiles = useProfiles(props.host?.id ?? "");
  // The draft is pinned to the revision it was taken from; Save writes against that revision only.
  const [draft, setDraft] = useState<{ form: SettingsForm; revision: string; languages: string } | null>(null);
  const ready = settings.status === "ready" ? settings : null;

  useEffect(() => {
    if (ready && draft === null) setDraft({ form: settingsDraft(ready.values), revision: ready.revision, languages: languagesDraft(ready.values) });
  }, [ready, draft]);

  if (settings.status === "loading") return <Text style={{ color: theme.colors.foregroundMuted, padding: 16 }}>Loading…</Text>;
  if (settings.status === "error" || settings.status === "invalid") {
    return (
      <View style={{ padding: 16, gap: 8 }}>
        <Text style={{ color: theme.colors.statusWarning }}>Roadmap settings could not be read; defaults in use.</Text>
        <SettingsAction label="Reset to defaults" actionLabel="Reset" onPress={() => void settings.reset()} />
      </View>
    );
  }
  if (!draft) return null;

  const form = draft.form;
  const formParsed = parseSettingsDraft(form);
  const languages = parseLanguagesDraft(draft.languages);
  // The languages are kept beside the form, so a save always carries them.
  const parsed = formParsed.ok && languages.ok ? { ok: true as const, values: { ...formParsed.values, discussionLanguages: languages.languages } } : { ok: false as const };
  const errors = formParsed.ok ? {} : formParsed.errors;
  const changedElsewhere = settings.revision !== draft.revision;
  const changed = !parsed.ok || canonicalJson(parsed.values) !== canonicalJson(settings.values) || changedElsewhere;
  const update = (patch: Partial<SettingsForm>) => setDraft({ ...draft, form: { ...form, ...patch } });
  const reload = () => setDraft({ form: settingsDraft(settings.values), revision: settings.revision, languages: languagesDraft(settings.values) });
  // A stored profile that is no longer saved stays selectable, so opening the screen never drops it.
  // "(not found)" needs a successful profile list; while the read is pending or failed it keeps a
  // neutral label.
  const optionsFor = (key: ProfileKey) => {
    const options = profileChoice(profiles.data ?? []);
    const stored = form[key];
    if (stored !== "" && !options.some((o) => o.value === stored)) {
      options.push({ label: profiles.data ? `${stored} (not found)` : stored, value: stored });
    }
    return options;
  };
  const profilesNote = profiles.data
    ? null
    : profiles.isError
      ? `Agent profiles could not be read: ${profiles.error instanceof Error ? profiles.error.message : "read failed"}`
      : profiles.isPending
        ? "Loading agent profiles…"
        : null;
  const input = (key: (typeof INTEGER_KEYS)[number] | "reviewCommand" | "baseRef", label: string, hint: string, placeholder?: string) => (
    <SettingsInput
      key={`${draft.revision}:${key}`}
      label={label}
      hint={hint}
      initialValue={form[key]}
      {...(placeholder !== undefined ? { placeholder } : {})}
      error={errors[key] ?? null}
      onChangeText={(text) => update({ [key]: text })}
    />
  );

  return (
    <ScrollView contentContainerStyle={{ padding: 16, gap: 16 }}>
      <SettingsSection title="Roadmap execution">
        {input("repairCeiling", "Repair ceiling", "Failed verification cycles per task before a human grant is needed.")}
        {input("checkTimeoutMs", "Check timeout (ms)", "Upper bound for one DoD check command.")}
        {input("reviewTimeoutMs", "Review timeout (ms)", "Upper bound for one review command run.")}
        {input("maxBuffer", "Output buffer (bytes)", "Largest output kept from one check or review run.")}
        {input("reviewCommand", "Review command", "Runs locally in the feature worktree. Do not put credentials in it.", "reviewer --json")}
        {input("baseRef", "Base ref", "The branch or commit the review compares against.", "main")}
        <SettingsSelect
          label="Coordinator profile"
          hint="Saved agent profile used when a delegated start needs a new coordinator. None skips such starts with a note."
          value={form.coordinatorProfile}
          options={optionsFor("coordinatorProfile")}
          onValueChange={(coordinatorProfile) => update({ coordinatorProfile })}
        />
        {profilesNote ? <Text style={{ color: profiles.isError ? theme.colors.statusWarning : theme.colors.foregroundMuted }}>{profilesNote}</Text> : null}
      </SettingsSection>
      <SettingsSection title="Feature discussions">
        <SettingsSelect
          label="Discussion profile"
          hint="Saved agent profile that Discuss uses to create a feature's discussion chat. None asks you to choose one each time."
          value={form.discussionProfile}
          options={optionsFor("discussionProfile")}
          onValueChange={(discussionProfile) => update({ discussionProfile })}
        />
        <SettingsInput
          key={`${draft.revision}:discussionLanguages`}
          label="Additional discussion languages"
          hint="Comma-separated, for example: Deutsch, Français. English is always offered and is the default; with no additional language Discuss shows no language choice."
          initialValue={draft.languages}
          error={languages.ok ? null : languages.error}
          onChangeText={(text) => setDraft({ ...draft, languages: text })}
        />
        <SettingsSelect
          label="Translation profile (reserved)"
          hint="Stored for a later release; no translation is performed. Questions are shown as the agent wrote them."
          value={form.translationProfile}
          options={optionsFor("translationProfile")}
          onValueChange={(translationProfile) => update({ translationProfile })}
        />
      </SettingsSection>
      <SettingsSection title="Global Definition of done template">
        <TextInput
          multiline
          value={form.dodTemplate}
          onChangeText={(dodTemplate) => update({ dodTemplate })}
          placeholder="- [check] npm test"
          placeholderTextColor={theme.colors.foregroundMuted}
          style={{
            fontSize: 16,
            minHeight: 96,
            maxHeight: 240,
            padding: 10,
            borderWidth: 1,
            borderRadius: 6,
            borderColor: theme.colors.border,
            color: theme.colors.foreground,
            backgroundColor: theme.colors.surface1,
            textAlignVertical: "top",
          }}
        />
      </SettingsSection>
      <SettingsSection title="Save">
        <SettingsAction
          label="Save roadmap settings"
          actionLabel={settings.saving ? "Saving…" : "Save"}
          disabled={!changed || !parsed.ok || changedElsewhere || settings.saving}
          error={settings.saveError}
          onPress={() => {
            if (parsed.ok) void settings.save(parsed.values, draft.revision);
          }}
        />
        {changedElsewhere ? (
          <SettingsAction
            label="Reload the current settings"
            hint="These settings were changed elsewhere. Save is disabled so the other change is not overwritten; Reload discards your unsaved changes."
            actionLabel="Reload"
            onPress={reload}
          />
        ) : null}
      </SettingsSection>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
        No credentials are stored here. The review and check commands run locally with your own environment.
      </Text>
    </ScrollView>
  );
}
