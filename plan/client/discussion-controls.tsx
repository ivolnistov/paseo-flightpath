// Discuss on a feature card: one click with the default profile, or "Discuss with…" to choose a saved
// profile. Each creation is one feature.discussion.open call; a bound chat opens without any call.
// The server words every refusal (a creation in progress or unresolved); this control shows it and
// opens nothing. An unresolved creation is created again only through the owner's explicit
// confirmation that they checked and no chat was created; a plain Discuss never carries it. With
// languages configured besides English, a language row above Discuss chooses the chat's language
// (English by default); with English alone there is no choice and no language is sent.
import type { PluginTheme } from "@getpaseo/plugin";
import { useToast } from "@getpaseo/plugin/client/react-native";
import { useState } from "react";
import { View } from "react-native";
import type { Feature } from "../shared/model";
import { FeatureDiscussionOpen, type DiscussionTools } from "../shared/rpc-discussion";
import { ENGLISH } from "../shared/settings";
import { useProfiles, useRoadmapMutation } from "./hooks";
import { ActionButton } from "./roadmap-screen";
import { Muted } from "./ui";

/** "discuss" for a feature still being shaped, "open" once its chat is bound, null otherwise (bugs, finished cards). */
export function discussAvailability(feature: Feature): "discuss" | "open" | null {
  if (feature.kind !== "feature" || feature.status === "done" || feature.status === "cancelled") return null;
  return feature.discussion?.state === "bound" && feature.grillSessionId !== undefined ? "open" : "discuss";
}

/** What the card says about a chat that is not bound; null when there is nothing to say. */
export function discussionStatusText(feature: Feature): string | null {
  const d = feature.discussion;
  switch (d?.state) {
    case "creating":
      return "A discussion chat is being created.";
    case "unresolved":
      return "The discussion chat's creation outcome is unknown: no chat was found for it, which does not prove none was created. Check the workspace's chats first.";
    case "failed":
      return `Creating the discussion chat failed: ${d.error}`;
    default:
      return null;
  }
}

/** A note on the chat's roadmap tools after Discuss; null when they are attached. */
export function toolsNote(tools: DiscussionTools): string | null {
  switch (tools) {
    case "attached":
      return null;
    case "pending":
      return "The chat's roadmap tools were issued for it; they attach when its session starts.";
    case "not_attached":
      return "The chat has no roadmap tools: it holds no current grant for them, for example because its provider does not support them or an earlier grant was invalidated.";
    case "unknown":
      return "Whether the chat has its roadmap tools cannot be determined.";
  }
}

const ROW = { flexDirection: "row", flexWrap: "wrap", gap: 8, minWidth: 0 } as const;
// Columns wrap too, so no container of several controls can overflow a narrow screen.
const COLUMN = { gap: 8, minWidth: 0, flexWrap: "wrap" } as const;

export function DiscussionControls(props: {
  hostId: string;
  projectId: string;
  workspaceId: string;
  feature: Feature;
  revision: number;
  defaultProfile: string | undefined;
  /** The offered discussion languages, English first; English alone (or absent) shows no choice. */
  languages?: readonly string[];
  theme: PluginTheme;
  onOpened(sessionId: string): void;
}) {
  const { hostId, projectId, workspaceId, feature, revision, defaultProfile, theme, onOpened } = props;
  const languages = props.languages ?? [ENGLISH];
  const open = useRoadmapMutation(hostId, projectId, FeatureDiscussionOpen);
  const profiles = useProfiles(hostId);
  const toast = useToast();
  // "default": no default profile, shown with the settings hint; "override": Discuss with….
  const [choosing, setChoosing] = useState<"default" | "override" | null>(null);
  const [chosenLanguage, setLanguage] = useState<string>(ENGLISH);
  const availability = discussAvailability(feature);
  if (availability === null) return null;

  // A choice no longer offered (settings changed) falls back to English.
  const language = languages.includes(chosenLanguage) ? chosenLanguage : ENGLISH;
  const start = async (profileRef?: string, confirmedNoChat = false) => {
    const out = await open.run(
      {
        featureId: feature.id,
        workspaceId,
        ...(profileRef !== undefined ? { profileRef } : {}),
        ...(language !== ENGLISH ? { language } : {}),
        ...(confirmedNoChat ? { retryUnresolved: true as const, confirmedNoChat: true as const } : {}),
      },
      { expectedRevision: revision },
    );
    if (out === null) return;
    setChoosing(null);
    const note = toolsNote(out.tools);
    if (note !== null) toast.show(note);
    onOpened(out.sessionId);
  };

  if (availability === "open") {
    const sessionId = feature.grillSessionId!;
    return <ActionButton label="Open discussion" theme={theme} onPress={() => onOpened(sessionId)} />;
  }
  const status = discussionStatusText(feature);
  return (
    <View style={COLUMN}>
      {status !== null ? <Muted theme={theme}>{status}</Muted> : null}
      {feature.discussion?.state === "unresolved" ? (
        <ActionButton
          label="I checked: no chat was created. Create it again"
          theme={theme}
          disabled={open.pending}
          onPress={() => void start(undefined, true)}
        />
      ) : null}
      {languages.length > 1 ? (
        <View style={ROW}>
          <Muted theme={theme}>Language:</Muted>
          {languages.map((l) => (
            <ActionButton key={l} label={l} theme={theme} selected={l === language} disabled={open.pending} onPress={() => setLanguage(l)} />
          ))}
        </View>
      ) : null}
      <View style={ROW}>
        <ActionButton
          label="Discuss"
          theme={theme}
          primary
          disabled={open.pending}
          onPress={() => (defaultProfile !== undefined ? void start() : setChoosing("default"))}
        />
        <ActionButton label="Discuss with…" theme={theme} disabled={open.pending} onPress={() => setChoosing((v) => (v === null ? "override" : null))} />
      </View>
      {choosing !== null ? (
        <View style={COLUMN}>
          <Muted theme={theme}>
            {choosing === "default" ? "No default discussion profile. Set a default under Settings, or choose a profile now." : "Choose the profile for this discussion chat."}
          </Muted>
          {profiles.data !== undefined && profiles.data.length === 0 ? <Muted theme={theme}>No saved agent profiles.</Muted> : null}
          {profiles.isError ? <Muted theme={theme}>The saved agent profiles could not be read.</Muted> : null}
          <View style={ROW}>
            {(profiles.data ?? []).map((p) => (
              <ActionButton key={p.id} label={p.label} theme={theme} selected={p.id === defaultProfile} disabled={open.pending} onPress={() => void start(p.id)} />
            ))}
          </View>
          <ActionButton label="Cancel" theme={theme} disabled={open.pending} onPress={() => setChoosing(null)} />
        </View>
      ) : null}
    </View>
  );
}
