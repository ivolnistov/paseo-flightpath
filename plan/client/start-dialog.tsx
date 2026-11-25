// Start or replace dialog (Stage R4.2). Start: a feature without a coordinator needs a profile
// (`run.start { featureId, profileRef }`); a bound feature starts with its coordinator
// (`run.start { featureId }`). Replace: `coordinator.replace { featureId, profileRef }` (feature
// scoped, no run token). Success closes; a refusal is shown by the mutation and nothing retries.
import type { PluginTheme } from "@getpaseo/plugin";
import { Modal } from "@getpaseo/plugin/client/react-native";
import { useState } from "react";
import { View } from "react-native";
import type { Feature } from "../shared/model";
import { CoordinatorReplace, RunStart } from "../shared/rpc-runs";
import { useProfiles, useRoadmapMutation } from "./hooks";
import { ActionButton } from "./roadmap-screen";
import { Muted } from "./ui";

export { profileOptions } from "./hooks";

export function StartDialog(props: {
  hostId: string;
  projectId: string;
  feature: Feature;
  theme: PluginTheme;
  compact: boolean;
  mode: "start" | "replace";
  onClose(): void;
}) {
  const { hostId, projectId, feature, theme, compact, mode, onClose } = props;
  const profiles = useProfiles(hostId);
  const start = useRoadmapMutation(hostId, projectId, RunStart);
  const replace = useRoadmapMutation(hostId, projectId, CoordinatorReplace);
  const [profileRef, setProfileRef] = useState<string | null>(null);
  const needsProfile = mode === "replace" || feature.coordinator === undefined;
  const busy = start.pending || replace.pending;
  const options = profiles.data ?? [];

  const confirm = async () => {
    if (busy || (needsProfile && profileRef === null)) return;
    const out =
      mode === "replace"
        ? await replace.run({ featureId: feature.id, profileRef: profileRef! })
        : await start.run({ featureId: feature.id, ...(needsProfile ? { profileRef: profileRef! } : {}) });
    if (out !== null) onClose();
  };

  const title = mode === "replace" ? `Replace the coordinator of ${feature.title}` : `Start ${feature.title}`;
  return (
    <Modal title={title} open onOpenChange={(open: boolean) => !open && onClose()}>
      <Modal.Content contentContainerStyle={{ padding: compact ? 16 : 24, gap: 12 }}>
        {needsProfile ? (
          <View style={{ gap: 8 }}>
            <Muted theme={theme}>{mode === "replace" ? "Choose the profile for the new coordinator." : "Choose the coordinator profile."}</Muted>
            {profiles.isPending ? <Muted theme={theme}>Loading profiles…</Muted> : null}
            {profiles.isError ? (
              <Muted theme={theme}>{`Could not read the host's agent profiles: ${profiles.error instanceof Error ? profiles.error.message : "read failed"}`}</Muted>
            ) : !profiles.isPending && options.length === 0 ? (
              <Muted theme={theme}>No agent profiles are configured on this host.</Muted>
            ) : null}
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
              {options.map((o) => (
                <ActionButton key={o.id} label={o.label} theme={theme} selected={profileRef === o.id} onPress={() => setProfileRef(o.id)} />
              ))}
            </View>
          </View>
        ) : (
          <Muted theme={theme}>The run starts with the bound coordinator.</Muted>
        )}
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          <ActionButton label="Close" theme={theme} onPress={onClose} />
          <ActionButton
            label={mode === "replace" ? "Replace coordinator" : "Start"}
            theme={theme}
            primary
            disabled={busy || (needsProfile && profileRef === null)}
            onPress={() => void confirm()}
          />
        </View>
      </Modal.Content>
    </Modal>
  );
}
