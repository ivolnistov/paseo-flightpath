// Roadmap screen (Stage R1.1): the ordered feature list, its card actions and the create/edit form.
// Every action maps to an existing server command; there is no start, run or chat control. Stage
// R4.4 adds a read-only progress line per feature and the active start delegations with Revoke.
import type { PluginTheme } from "@getpaseo/plugin";
import { Icon, TextInput } from "@getpaseo/plugin/client/react-native";
import { useState, type ReactNode, type Ref, type RefObject } from "react";
import { Pressable, Text, View } from "react-native";
import type { EndReason, Feature, FeatureStatus, PauseReason, Plan, StartDelegation } from "../shared/model";
import type { PlanSummary } from "../shared/rpc";
import { FeatureCreate, FeatureDelete, FeatureDependenciesSet, FeatureReorder, FeatureStatusSet, FeatureUpdate } from "../shared/rpc-features";
import { DelegationRevoke, type RunView } from "../shared/rpc-runs";
import { DiscussionControls } from "./discussion-controls";
import { usePlanList, useProjectRuns, useRoadmapMutation } from "./hooks";
import { FEATURE_STATUS_LABEL, TARGET_SIZE, featureStatusColor } from "./theme";
import { Tooltip, type TooltipHandlers } from "./tooltip";
import { Heading, Muted, inputStyle } from "./ui";

export type FeatureAction = "open" | "edit" | "dependencies" | "defer" | "resume" | "cancel" | "delete" | "createRemoval";

const ACTIVE: ReadonlySet<FeatureStatus> = new Set<FeatureStatus>(["created", "planned", "executing"]);

/**
 * The actions the screens offer for this feature now, in a fixed order. The server may still refuse
 * one: `feature.delete` of a feature that a plan is bound to fails with `feature_transition`.
 */
export function featureActions(feature: Feature, features: Feature[]): FeatureAction[] {
  const out: FeatureAction[] = ["open", "edit", "dependencies"];
  if (ACTIVE.has(feature.status)) out.push("defer");
  if (feature.status === "deferred") out.push("resume");
  if (ACTIVE.has(feature.status) || feature.status === "deferred") out.push("cancel");
  const isPrerequisite = features.some((f) => f.id !== feature.id && f.dependsOn.includes(feature.id));
  if (!feature.everStarted && !isPrerequisite) out.push("delete");
  if (feature.status === "done") out.push("createRemoval");
  return out;
}

/** The status an undefer returns to; only for a deferred feature. */
export function resumeTarget(feature: Feature): "created" | "planned" | "executing" | undefined {
  return feature.status === "deferred" ? feature.statusBeforeDefer : undefined;
}

export type FeatureRow = {
  id: string;
  title: string;
  kind: "feature" | "bug";
  status: FeatureStatus;
  statusLabel: string;
  statusReason?: string;
  dependsOn: Array<{ id: string; title: string }>;
  relatedTo: Array<{ id: string; title: string }>;
  actions: FeatureAction[];
};

/** One row per feature, in roadmap order; referenced titles come from the same list. */
export function featureRows(features: Feature[]): FeatureRow[] {
  const titles = new Map(features.map((f) => [f.id, f.title] as const));
  const named = (ids: string[]) => ids.map((id) => ({ id, title: titles.get(id) ?? id }));
  return features.map((f) => ({
    id: f.id,
    title: f.title,
    kind: f.kind,
    status: f.status,
    statusLabel: FEATURE_STATUS_LABEL[f.status],
    ...(f.statusReason !== undefined ? { statusReason: f.statusReason } : {}),
    dependsOn: named(f.dependsOn),
    relatedTo: named(f.relatedTo),
    actions: featureActions(f, features),
  }));
}

/** The full order with `id` moved one place; null at an edge or for an unknown id. */
export function moveFeature(order: string[], id: string, direction: "up" | "down"): string[] | null {
  const from = order.indexOf(id);
  const to = direction === "up" ? from - 1 : from + 1;
  if (from < 0 || to < 0 || to >= order.length) return null;
  const next = [...order];
  [next[from], next[to]] = [next[to], next[from]];
  return next;
}

/** Only the card fields that changed; the title is trimmed. */
export function editPatch(feature: Feature, draft: { title: string; description: string }): { title?: string; description?: string } {
  const title = draft.title.trim();
  return {
    ...(title !== feature.title ? { title } : {}),
    ...(draft.description !== feature.description ? { description: draft.description } : {}),
  };
}

/**
 * The Lucide component name the host's `Icon` resolves. The host looks the name up among the Lucide
 * module's component exports (PascalCase: `Link`, `ChevronLeft`) and renders nothing for any other
 * name, so the kebab-case icon names Lucide documents (`link`, `chevron-left`, `link-2`) are converted.
 */
export function lucideName(name: string): string {
  if (/^[A-Z]/.test(name)) return name;
  return name
    .split("-")
    .filter((part) => part !== "")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

/**
 * A button with a 44 px minimum target; `selected` marks a choice in a picker. With `icon` it shows a
 * Lucide icon before the label; with `iconOnly` it is a 44×44 square showing the icon alone, the label
 * staying its accessibility label. `hint` is its accessibility hint and shows as a tooltip on hover,
 * focus and long press. An icon-only button shows `selected` by its border and state, never a glyph.
 */
export function ActionButton(props: {
  label: string;
  onPress(): void;
  theme: PluginTheme;
  disabled?: boolean;
  primary?: boolean;
  danger?: boolean;
  selected?: boolean;
  icon?: string;
  iconOnly?: boolean;
  hint?: string;
  /** The underlying Pressable, for returning focus to it. */
  ref?: Ref<View>;
  /** A toggle's on/off state, exposed as aria-pressed (the web) next to accessibilityState; without it, `selected` is. */
  pressed?: boolean;
}) {
  const { theme, primary, danger, disabled, selected, icon, hint } = props;
  const iconOnly = props.iconOnly === true && icon !== undefined;
  const border = danger ? theme.colors.statusDanger : primary || selected ? theme.colors.accent : theme.colors.border;
  const color = primary ? theme.colors.accentForeground : danger ? theme.colors.statusDanger : theme.colors.foreground;
  const style = {
    minHeight: TARGET_SIZE,
    minWidth: TARGET_SIZE,
    justifyContent: "center",
    alignItems: iconOnly ? "center" : undefined,
    paddingHorizontal: iconOnly ? 0 : 12,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: border,
    backgroundColor: primary ? theme.colors.accent : selected ? theme.colors.surface1 : theme.colors.surface2,
    opacity: disabled ? 0.5 : 1,
    alignSelf: "flex-start",
  } as const;
  const content = iconOnly ? (
    <Icon name={lucideName(icon)} size={20} color={color} />
  ) : icon !== undefined ? (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
      <Icon name={lucideName(icon)} size={16} color={color} />
      <Text style={{ color }}>{selected ? `✓ ${props.label}` : props.label}</Text>
    </View>
  ) : (
    <Text style={{ color }}>{selected ? `✓ ${props.label}` : props.label}</Text>
  );
  const pressable = (extra: Partial<TooltipHandlers> = {}, anchor?: RefObject<View | null>) => (
    <Pressable
      ref={(node: View | null) => {
        if (anchor !== undefined) anchor.current = node;
        const own = props.ref;
        if (typeof own === "function") own(node);
        else if (own !== undefined && own !== null) own.current = node;
      }}
      accessibilityRole="button"
      accessibilityLabel={props.label}
      {...(hint !== undefined ? { accessibilityHint: hint } : {})}
      accessibilityState={{ disabled: !!disabled, ...(selected !== undefined ? { selected } : {}) }}
      // React Native Web drops accessibilityState: a selected (or pressed) button says so through
      // aria-pressed, the state ARIA defines for a button; native reads accessibilityState.
      {...(props.pressed !== undefined || selected !== undefined ? { "aria-pressed": props.pressed ?? selected } : {})}
      disabled={disabled}
      onPress={props.onPress}
      {...extra}
      style={style}
    >
      {content}
    </Pressable>
  );
  if (hint === undefined) return pressable();
  return (
    <Tooltip hint={hint} theme={theme}>
      {(handlers, ref) => pressable(handlers, ref)}
    </Tooltip>
  );
}

/** The status chip, rendered inline so its label is part of the screen's own text. */
export function featureStatusChip(status: FeatureStatus, theme: PluginTheme): ReactNode {
  const color = featureStatusColor(status, theme);
  return (
    <View style={{ borderColor: color, borderWidth: 1, borderRadius: 10, paddingHorizontal: 8, paddingVertical: 2, alignSelf: "flex-start" }}>
      <Text style={{ color, fontSize: 12 }}>{FEATURE_STATUS_LABEL[status]}</Text>
    </View>
  );
}

/**
 * Create or edit a feature card. The store revision (and, when editing, the feature) are pinned
 * when the form opens; kind is chosen at creation only; dependencies have their own action.
 */
export function FeatureForm(props: {
  mode: "create" | "edit";
  hostId: string;
  projectId: string;
  theme: PluginTheme;
  compact: boolean;
  revision: number;
  feature?: Feature;
  initial?: { title: string; relatedTo: string[] };
  onDone(featureId?: string): void;
  onCancel(): void;
}) {
  const { mode, hostId, projectId, theme, onDone, onCancel } = props;
  const create = useRoadmapMutation(hostId, projectId, FeatureCreate);
  const update = useRoadmapMutation(hostId, projectId, FeatureUpdate);
  const [base] = useState(() => ({ revision: props.revision, feature: props.feature, relatedTo: props.initial?.relatedTo ?? [] }));
  const [title, setTitle] = useState(props.feature?.title ?? props.initial?.title ?? "");
  const [description, setDescription] = useState(props.feature?.description ?? "");
  const [kind, setKind] = useState<"feature" | "bug">("feature");
  const pending = create.pending || update.pending;

  async function submit() {
    if (mode === "create") {
      if (!title.trim()) return;
      const out = await create.run(
        { title: title.trim(), description, kind, ...(base.relatedTo.length > 0 ? { relatedTo: base.relatedTo } : {}) },
        { expectedRevision: base.revision },
      );
      if (out) onDone(out.featureId);
      return;
    }
    const original = base.feature;
    if (!original) return;
    const patch = editPatch(original, { title, description });
    if (Object.keys(patch).length === 0) {
      onDone(original.id);
      return;
    }
    const out = await update.run({ featureId: original.id, patch }, { expectedRevision: base.revision });
    if (out) onDone(original.id);
  }

  return (
    <View style={{ gap: 8, minWidth: 0 }}>
      <Heading theme={theme}>{mode === "create" ? "New feature" : "Edit feature"}</Heading>
      <TextInput
        accessibilityLabel="Feature title"
        placeholder="Title"
        placeholderTextColor={theme.colors.foregroundMuted}
        value={title}
        onChangeText={setTitle}
        style={[inputStyle(theme), { minHeight: TARGET_SIZE }]}
      />
      <TextInput
        accessibilityLabel="Feature description"
        placeholder="Description"
        placeholderTextColor={theme.colors.foregroundMuted}
        value={description}
        onChangeText={setDescription}
        multiline
        style={[inputStyle(theme), { minHeight: TARGET_SIZE * 2 }]}
      />
      {mode === "create" ? (
        <View style={{ flexDirection: "row", gap: 8 }}>
          <ActionButton label="Feature" theme={theme} selected={kind === "feature"} onPress={() => setKind("feature")} />
          <ActionButton label="Bug" theme={theme} selected={kind === "bug"} onPress={() => setKind("bug")} />
        </View>
      ) : (
        <Muted theme={theme}>{`Kind: ${base.feature?.kind === "bug" ? "Bug" : "Feature"}`}</Muted>
      )}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        <ActionButton
          label={mode === "create" ? "Create feature" : "Save feature"}
          theme={theme}
          primary
          disabled={pending || !title.trim()}
          onPress={() => void submit()}
        />
        <ActionButton label="Discard" theme={theme} disabled={pending} onPress={onCancel} />
      </View>
    </View>
  );
}

type Confirming = { featureId: string; action: "cancel" | "delete" } | null;

/** State and handlers for the card actions, shared by the roadmap list and the feature screen. */
export function useFeatureActions(props: { hostId: string; projectId: string; revision: number; features: Feature[] }) {
  const { hostId, projectId, revision, features } = props;
  const status = useRoadmapMutation(hostId, projectId, FeatureStatusSet);
  const reorder = useRoadmapMutation(hostId, projectId, FeatureReorder);
  const dependencies = useRoadmapMutation(hostId, projectId, FeatureDependenciesSet);
  const remove = useRoadmapMutation(hostId, projectId, FeatureDelete);
  const [confirming, setConfirming] = useState<Confirming>(null);
  const [picking, setPicking] = useState<{ featureId: string; selected: string[] } | null>(null);
  // Every list and detail action is sent against the snapshot the screen was rendered from.
  const at = { expectedRevision: revision };
  return {
    pending: status.pending || reorder.pending || dependencies.pending || remove.pending,
    confirming,
    setConfirming,
    picking,
    setStatus: (featureId: string, to: FeatureStatus) => void status.run({ featureId, status: to }, at),
    move: (featureId: string, direction: "up" | "down") => {
      const order = moveFeature(
        features.map((f) => f.id),
        featureId,
        direction,
      );
      if (order) void reorder.run({ order }, at);
    },
    remove: async (featureId: string) => {
      setConfirming(null);
      return remove.run({ featureId }, at);
    },
    cancel: (featureId: string) => {
      setConfirming(null);
      void status.run({ featureId, status: "cancelled" }, at);
    },
    openPicker: (feature: Feature) => setPicking({ featureId: feature.id, selected: [...feature.dependsOn] }),
    closePicker: () => setPicking(null),
    toggle: (id: string) =>
      setPicking((p) => (p ? { ...p, selected: p.selected.includes(id) ? p.selected.filter((x) => x !== id) : [...p.selected, id] } : p)),
    savePicker: () => {
      if (!picking) return;
      // Roadmap order, not selection order.
      const dependsOn = features.map((f) => f.id).filter((id) => picking.selected.includes(id));
      setPicking(null);
      void dependencies.run({ featureId: picking.featureId, dependsOn }, at);
    },
  };
}
export type FeatureActionsState = ReturnType<typeof useFeatureActions>;

/**
 * The action buttons of one feature (rendered inline, not as a child component), including the
 * second confirming press for cancel and delete and the dependency picker.
 */
export function featureActionButtons(
  feature: Feature,
  features: Feature[],
  state: FeatureActionsState,
  opts: { theme: PluginTheme; omit?: FeatureAction[]; onOpen(): void; onEdit(): void; onCreateRemoval(): void; onDeleted?(): void },
): ReactNode {
  const { theme } = opts;
  const actions = featureActions(feature, features).filter((a) => !opts.omit?.includes(a));
  const busy = state.pending;
  const confirm = state.confirming?.featureId === feature.id ? state.confirming.action : null;
  const buttons: ReactNode[] = [];
  for (const action of actions) {
    switch (action) {
      case "open":
        buttons.push(<ActionButton key="open" label="Open" theme={theme} onPress={opts.onOpen} />);
        break;
      case "edit":
        buttons.push(<ActionButton key="edit" label="Edit" theme={theme} disabled={busy} onPress={opts.onEdit} />);
        break;
      case "dependencies":
        buttons.push(<ActionButton key="deps" label="Dependencies" theme={theme} disabled={busy} onPress={() => state.openPicker(feature)} />);
        break;
      case "defer":
        buttons.push(<ActionButton key="defer" label="Defer" theme={theme} disabled={busy} onPress={() => state.setStatus(feature.id, "deferred")} />);
        break;
      case "resume": {
        const target = resumeTarget(feature);
        if (target) buttons.push(<ActionButton key="resume" label="Resume" theme={theme} disabled={busy} onPress={() => state.setStatus(feature.id, target)} />);
        break;
      }
      case "cancel":
        buttons.push(
          confirm === "cancel" ? (
            <ActionButton key="cancel" label="Confirm cancel" theme={theme} danger disabled={busy} onPress={() => state.cancel(feature.id)} />
          ) : (
            <ActionButton key="cancel" label="Cancel" theme={theme} disabled={busy} onPress={() => state.setConfirming({ featureId: feature.id, action: "cancel" })} />
          ),
        );
        break;
      case "delete":
        buttons.push(
          confirm === "delete" ? (
            <ActionButton
              key="delete"
              label="Confirm delete"
              theme={theme}
              danger
              disabled={busy}
              onPress={() => void state.remove(feature.id).then((out) => (out ? opts.onDeleted?.() : undefined))}
            />
          ) : (
            <ActionButton key="delete" label="Delete" theme={theme} disabled={busy} onPress={() => state.setConfirming({ featureId: feature.id, action: "delete" })} />
          ),
        );
        break;
      case "createRemoval":
        buttons.push(<ActionButton key="removal" label="Create removal feature" theme={theme} disabled={busy} onPress={opts.onCreateRemoval} />);
        break;
    }
  }
  if (confirm) buttons.push(<ActionButton key="keep" label="Keep" theme={theme} onPress={() => state.setConfirming(null)} />);
  const picker =
    state.picking?.featureId === feature.id ? (
      <View key="picker" style={{ gap: 6, width: "100%", minWidth: 0 }}>
        <Muted theme={theme}>Depends on</Muted>
        {features
          .filter((f) => f.id !== feature.id)
          .map((f) => (
            <ActionButton key={f.id} label={f.title} theme={theme} selected={state.picking!.selected.includes(f.id)} onPress={() => state.toggle(f.id)} />
          ))}
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          <ActionButton label="Save dependencies" theme={theme} primary disabled={busy} onPress={state.savePicker} />
          <ActionButton label="Discard" theme={theme} onPress={state.closePicker} />
        </View>
      </View>
    ) : null;
  return (
    <View style={{ gap: 8, minWidth: 0 }}>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>{buttons}</View>
      {picker}
    </View>
  );
}

// ---- Stage R4.4: progress line and delegations ----

export type FeatureProgress =
  | { kind: "none" }
  | {
      kind: "live";
      state: "running" | "paused";
      pauseReason?: PauseReason;
      verified: number;
      total: number;
      planRev: number;
      latestRev?: number;
      delegated: boolean;
      unauthorised: boolean;
    }
  | { kind: "ended"; endReason?: EndReason; verified: number; total: number; planRev: number; latestRev?: number };

/** The plan's latest revision from a full plan or a `plan.list` summary. */
type PlanRevisions = Pick<Plan, "revisions"> | Pick<PlanSummary, "latestRev">;
function latestRevOf(plan: PlanRevisions | undefined): number | undefined {
  if (plan === undefined) return undefined;
  if ("latestRev" in plan) return plan.latestRev ?? undefined;
  return plan.revisions.at(-1)?.rev;
}

/**
 * The feature's progress (card §5.2): its single non-ended run, else its most recently ended one.
 * Counts come from that run's own task runs (its `planRev`) and are never mixed across revisions;
 * `latestRev` is set only when the plan has moved past the run's revision. `delegated` is the
 * live run's historical start authorisation; `unauthorised` is its current `start_unauthorised`.
 */
export function featureProgress(feature: Feature, plan: PlanRevisions | undefined, runs: RunView[]): FeatureProgress {
  const own = runs.filter((v) => v.run.featureId === feature.id);
  const live = own.find((v) => v.run.state !== "ended");
  const ended = own
    .filter((v) => v.run.state === "ended")
    .reduce<RunView | undefined>((best, v) => (best === undefined || (v.run.endedAt ?? "") > (best.run.endedAt ?? "") ? v : best), undefined);
  const chosen = live ?? ended;
  if (!chosen) return { kind: "none" };
  const { run } = chosen;
  const latest = latestRevOf(plan);
  const counts = {
    verified: run.tasks.filter((t) => t.state === "verified").length,
    total: run.tasks.length,
    planRev: run.planRev,
    ...(latest !== undefined && latest !== run.planRev ? { latestRev: latest } : {}),
  };
  if (run.state === "ended") return { kind: "ended", ...(run.endReason ? { endReason: run.endReason } : {}), ...counts };
  const delegated = run.startAuth.kind === "delegation";
  return {
    kind: "live",
    state: run.state,
    ...(run.pauseReason ? { pauseReason: run.pauseReason } : {}),
    ...counts,
    delegated,
    unauthorised: delegated && chosen.blocked.some((b) => b.code === "start_unauthorised"),
  };
}

const words = (code: string) => code.replace(/_/g, " ");

/** One line of plain text for the row (no control). */
export function progressText(p: FeatureProgress): string {
  if (p.kind === "none") return "Not started";
  const head = p.kind === "ended" ? `Ended${p.endReason ? ` (${words(p.endReason)})` : ""}` : p.state === "paused" ? `Paused${p.pauseReason ? ` (${words(p.pauseReason)})` : ""}` : "Running";
  const rev = p.latestRev !== undefined ? ` · run rev ${p.planRev} · plan now rev ${p.latestRev}` : "";
  return `${head} · ${p.verified}/${p.total} verified${rev}`;
}

const QUOTE_MAX = 120;

/** The active (unrevoked) start delegations, each with a UI-only Revoke that never retries. */
function DelegationsStrip(props: { hostId: string; projectId: string; theme: PluginTheme; features: Feature[]; delegations: StartDelegation[] }) {
  const { hostId, projectId, theme, features, delegations } = props;
  const revoke = useRoadmapMutation(hostId, projectId, DelegationRevoke);
  const active = delegations.filter((d) => d.revokedAt === undefined);
  if (active.length === 0) return null;
  return (
    <View style={{ gap: 8, minWidth: 0 }}>
      <Text style={{ color: theme.colors.foreground, fontWeight: "600" }}>Start delegations</Text>
      {active.map((d) => {
        const title = d.scope === "roadmap" ? "Whole roadmap" : `Feature: ${features.find((f) => f.id === d.featureId)?.title ?? d.featureId ?? "unknown"}`;
        const quoted = d.provenance.quoted.length > QUOTE_MAX ? `${d.provenance.quoted.slice(0, QUOTE_MAX - 1)}…` : d.provenance.quoted;
        return (
          <View key={d.id} style={{ gap: 6, minWidth: 0, borderWidth: 1, borderColor: theme.colors.border, borderRadius: 8, padding: 10 }}>
            <Text style={{ color: theme.colors.foreground, flexShrink: 1 }}>{`${title} · granted ${d.grantedAt}`}</Text>
            <Text style={{ color: theme.colors.foregroundMuted, flexShrink: 1 }}>{`“${quoted}”`}</Text>
            <ActionButton label="Revoke" theme={theme} danger disabled={revoke.pending} onPress={() => void revoke.run({ delegationId: d.id })} />
          </View>
        );
      })}
    </View>
  );
}

type FormState = { mode: "create" } | { mode: "edit"; feature: Feature } | { mode: "removal"; feature: Feature } | null;

export function RoadmapScreen(props: {
  hostId: string;
  projectId: string;
  theme: PluginTheme;
  compact: boolean;
  features: Feature[];
  /** `feature.list` delegations (Stage R4.4); absent for callers that have none to show. */
  delegations?: StartDelegation[];
  revision: number;
  onOpenFeature(featureId: string): void;
  onBack(): void;
  /** One-click Discuss: the panel's workspace, the default discussion profile and how to open a session. */
  discussion?: { workspaceId: string; defaultProfile: string | undefined; languages?: readonly string[]; onOpenSession(sessionId: string): void };
}) {
  const { hostId, projectId, theme, compact, features, revision, onOpenFeature, onBack, discussion } = props;
  const state = useFeatureActions({ hostId, projectId, revision, features });
  const [form, setForm] = useState<FormState>(null);
  const runs = useProjectRuns(hostId, projectId, true);
  const plans = usePlanList(hostId, projectId);

  if (form?.mode === "removal") {
    // A normal create that records which done feature it removes; the done feature is not changed.
    return (
      <FeatureForm
        key={`removal:${form.feature.id}`}
        mode="create"
        hostId={hostId}
        projectId={projectId}
        theme={theme}
        compact={compact}
        revision={revision}
        initial={{ title: `Remove: ${form.feature.title}`, relatedTo: [form.feature.id] }}
        onDone={(id) => {
          setForm(null);
          if (id) onOpenFeature(id);
        }}
        onCancel={() => setForm(null)}
      />
    );
  }
  if (form) {
    return (
      <FeatureForm
        key={form.mode === "edit" ? `edit:${form.feature.id}` : "create"}
        mode={form.mode}
        hostId={hostId}
        projectId={projectId}
        theme={theme}
        compact={compact}
        revision={revision}
        {...(form.mode === "edit" ? { feature: form.feature } : {})}
        onDone={() => setForm(null)}
        onCancel={() => setForm(null)}
      />
    );
  }

  const rows = featureRows(features);
  return (
    <View style={{ gap: 12, minWidth: 0 }}>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
        <ActionButton label="Back" theme={theme} onPress={onBack} />
        <Heading theme={theme}>Roadmap</Heading>
        <ActionButton label="New feature" theme={theme} primary disabled={state.pending} onPress={() => setForm({ mode: "create" })} />
      </View>
      <DelegationsStrip hostId={hostId} projectId={projectId} theme={theme} features={features} delegations={props.delegations ?? []} />
      {rows.length === 0 ? <Muted theme={theme}>No features yet.</Muted> : null}
      {rows.map((row, index) => {
        const feature = features[index];
        // Progress only once the project runs have resolved: a pending or failed read is not "no run".
        const progress = runs.data
          ? featureProgress(
              feature,
              plans.data?.plans.find((p) => p.featureId === feature.id),
              runs.data.runs,
            )
          : null;
        return (
          <View
            key={row.id}
            style={{ gap: 6, minWidth: 0, borderWidth: 1, borderColor: theme.colors.border, borderRadius: 8, padding: compact ? 10 : 12, backgroundColor: theme.colors.surface1 }}
          >
            <Text style={{ color: theme.colors.foreground, fontWeight: "600" }}>{row.title}</Text>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
              {featureStatusChip(row.status, theme)}
              <Text style={{ color: theme.colors.foregroundMuted }}>{row.kind === "bug" ? "Bug" : "Feature"}</Text>
            </View>
            {progress ? <Text style={{ color: theme.colors.foregroundMuted, flexShrink: 1 }}>{progressText(progress)}</Text> : null}
            {progress?.kind === "live" && progress.delegated ? (
              <Text style={{ color: progress.unauthorised ? theme.colors.statusWarning : theme.colors.accent }}>
                {progress.unauthorised ? "delegated · unauthorised" : "delegated"}
              </Text>
            ) : null}
            {row.statusReason ? <Text style={{ color: theme.colors.foregroundMuted }}>{row.statusReason}</Text> : null}
            {row.dependsOn.length > 0 ? (
              <Text style={{ color: theme.colors.foregroundMuted }}>{`Depends on: ${row.dependsOn.map((d) => d.title).join(", ")}`}</Text>
            ) : null}
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
              {index > 0 ? <ActionButton label="Move up" theme={theme} disabled={state.pending} onPress={() => state.move(row.id, "up")} /> : null}
              {index < rows.length - 1 ? (
                <ActionButton label="Move down" theme={theme} disabled={state.pending} onPress={() => state.move(row.id, "down")} />
              ) : null}
            </View>
            {featureActionButtons(feature, features, state, {
              theme,
              onOpen: () => onOpenFeature(row.id),
              onEdit: () => setForm({ mode: "edit", feature }),
              onCreateRemoval: () => setForm({ mode: "removal", feature }),
            })}
            {discussion !== undefined ? (
              <DiscussionControls
                hostId={hostId}
                projectId={projectId}
                workspaceId={discussion.workspaceId}
                feature={feature}
                revision={revision}
                defaultProfile={discussion.defaultProfile}
                {...(discussion.languages !== undefined ? { languages: discussion.languages } : {})}
                theme={theme}
                onOpened={discussion.onOpenSession}
              />
            ) : null}
          </View>
        );
      })}
    </View>
  );
}
