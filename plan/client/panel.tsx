import type { PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { FlatList, Modal, ScrollView, TextInput, useToast } from "@getpaseo/plugin/client/react-native";
import { useRpc, useSettings } from "@getpaseo/plugin/client";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Pressable, Text, View, type ScrollView as NativeScrollView } from "react-native";
import type { Feature, Ref } from "../shared/model";
import { RoadmapInit, SessionCreate, type Counts, type Overview } from "../shared/rpc";
import { SessionFinish } from "../shared/rpc-discussion";
import { discussionLanguageChoices, roadmapSettings } from "../shared/settings";
import { FeatureScreen } from "./feature-screen";
import { ChatMenu, GrillingBlocks, SessionNotices, type ViewMode } from "./grilling-blocks";
import { grillingActions } from "./grilling-header";
import { PlannerPicker } from "./planner-picker";
import { hostTabOf, restoreStack, saveStack, type HostTab, type StoredScreen } from "./host-tab";
import {
  RpcFailure,
  roadmapKey,
  useFeatureList,
  useLiveRevision,
  useOverview,
  usePlanList,
  useProjectId,
  useRoadmapMutation,
  useRoadmapVersion,
  useSessionView,
} from "./hooks";
import { conflictMessage } from "./layout";
import { PlanView } from "./plan-view";
import { PlansList } from "./plans-list";
import { ActionButton, RoadmapScreen } from "./roadmap-screen";
import { StageStrip } from "./stage-strip-view";
import { MapView } from "./map-view";
import { useAddQuestion } from "./add-question-form";
import { moveFocus } from "./discussion-ui";
import { registerTooltipBoundary, TooltipLayer, useWindowSize } from "./tooltip";
import { subscribePendingRoute, takePendingRoute, type RoadmapRoute } from "./slash";
import { resolveTarget, type Target as LinkTarget } from "./link-target";
import type { ParsedLink } from "../shared/links";
import { cardStyle, statusColor, STATUS_LABEL } from "./theme";
import { Heading, Muted, inputStyle } from "./ui";

type Target = LinkTarget & { showHidden?: boolean };
/** A link to resolve once the session's view is loaded: its kind and pinned revision are kept. */
type PendingLink = { link: ParsedLink | number; nonce: number };
/** A screen without its one-shot link target, as kept in the host's tab state. */
function storedScreen(s: Screen): StoredScreen {
  switch (s.kind) {
    case "feature":
      return { kind: "feature", featureId: s.featureId };
    case "plan":
      return { kind: "plan", planId: s.planId };
    case "session":
      return { kind: "session", sessionId: s.sessionId };
    default:
      return { kind: s.kind };
  }
}

type Screen =
  | { kind: "overview" }
  | { kind: "roadmap" }
  | { kind: "feature"; featureId: string }
  | { kind: "plan"; planId: string }
  | { kind: "session"; sessionId: string; target?: Target; link?: PendingLink };

const ANOTHER_PROJECT = "This link belongs to another project; open it from that project's roadmap.";

/** Every screen fills a bounded-height column, so the grilling screen can keep its action bar visible. */
const FILL = { flex: 1, minHeight: 0, minWidth: 0 } as const;
type Theme = PluginWorkspacePanelProps["theme"];

const errorText = (e: unknown) => (e instanceof RpcFailure ? conflictMessage(e.rpcError) : e instanceof Error ? e.message : "Something went wrong.");

function CountChips({ counts, theme }: { counts: Counts; theme: Theme }) {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- Object.keys returns string keys; Counts has only these fixed keys
  const keys = (Object.keys(counts) as Array<keyof Counts>).filter((k) => counts[k] > 0);
  if (keys.length === 0) return <Muted theme={theme}>No questions</Muted>;
  return (
    <View style={{ flexDirection: "row", gap: 6, flexWrap: "wrap" }}>
      {keys.map((k) => (
        <Text key={k} style={{ color: statusColor(k, theme), fontSize: 12 }}>
          {STATUS_LABEL[k]} {counts[k]}
        </Text>
      ))}
    </View>
  );
}

function OverviewScreen(props: {
  overview: Overview;
  hostId: string;
  projectId: string;
  theme: Theme;
  onOpen(sessionId: string): void;
  onOpenPlan(planId: string): void;
  onOpenRoadmap(): void;
}) {
  const { overview, hostId, projectId, theme, onOpen, onOpenPlan, onOpenRoadmap } = props;
  const create = useRoadmapMutation(hostId, projectId, SessionCreate);
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState("");
  const titles = new Map(overview.sessions.map((s) => [s.id, s.title]));

  async function submit() {
    const out = await create.run({ title: title.trim() });
    if (out) {
      setCreating(false);
      setTitle("");
      onOpen((out as { sessionId: string }).sessionId);
    }
  }

  return (
    <View style={{ flex: 1, gap: 12 }}>
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
        <Heading theme={theme}>Sessions</Heading>
        <View style={{ flexDirection: "row", gap: 8 }}>
          <ActionButton label="Roadmap" theme={theme} onPress={onOpenRoadmap} />
          <ActionButton label="New session" theme={theme} primary onPress={() => setCreating(true)} />
        </View>
      </View>
      <FlatList
        data={overview.sessions}
        keyExtractor={(s) => s.id}
        contentContainerStyle={{ gap: 8 }}
        ListEmptyComponent={<Muted theme={theme}>No sessions yet. Start one to collect decisions.</Muted>}
        renderItem={({ item }) => (
          <Pressable accessibilityRole="button" accessibilityLabel={`Open session ${item.title}`} onPress={() => onOpen(item.id)} style={cardStyle(theme, { dimmed: item.status === "closed" })}>
            <Text style={{ color: theme.colors.foreground, fontWeight: "600" }}>{item.title}</Text>
            <CountChips counts={item.counts} theme={theme} />
          </Pressable>
        )}
        ListFooterComponent={
          <View>
            {overview.links.length > 0 ? (
              <View style={{ gap: 2, paddingTop: 8 }}>
                <Muted theme={theme}>Links</Muted>
                {overview.links.map((l) => (
                  <Muted key={l.id} theme={theme}>
                    {titles.get(l.from.sessionId) ?? "Unknown session"} {l.kind} {titles.get(l.to.sessionId) ?? "Unknown session"}
                  </Muted>
                ))}
              </View>
            ) : null}
            <PlansList hostId={hostId} projectId={projectId} theme={theme} onOpen={onOpenPlan} />
          </View>
        }
      />
      <Modal title="New session" open={creating} onOpenChange={setCreating}>
        <Modal.Content>
          <TextInput
            accessibilityLabel="Session title"
            placeholder="What are we deciding?"
            placeholderTextColor={theme.colors.foregroundMuted}
            value={title}
            onChangeText={setTitle}
            style={inputStyle(theme)}
          />
          <ActionButton label="Create" theme={theme} primary disabled={!title.trim() || create.pending} onPress={() => void submit()} />
        </Modal.Content>
      </Modal>
    </View>
  );
}

function SessionScreen(props: {
  sessionId: string;
  initialTarget?: Target;
  /** A link or Q<n> to resolve once this session's view is loaded. */
  initialLink?: PendingLink;
  /** Opens a link of another session of this project, its kind and revision kept. */
  onOpenOtherSessionLink?(link: ParsedLink): void;
  hostId: string;
  projectId: string;
  theme: Theme;
  compact: boolean;
  onBack(): void;
  /** Opens a decision of another session (pushes that session with the decision selected). */
  onOpenOtherSession(ref: Ref): void;
  /** Opens another session of this project as a whole. */
  onOpenSession?(sessionId: string): void;
  /** The host's navigation to a chat; absent on hosts without it. */
  openAgent?(agentId: string): void;
  /** The feature whose question session this is; a standalone or legacy session has none. */
  feature?: Feature;
  /** Opens the feature screen (every stage of the strip but Questions). */
  onOpenFeature?(featureId: string): void;
}) {
  const { sessionId, hostId, projectId, theme, compact, onBack, onOpenOtherSession, openAgent, feature } = props;
  const session = useSessionView(hostId, projectId, sessionId);
  const [mode, setMode] = useState<ViewMode>("grilling");
  const [target, setTarget] = useState<Target | undefined>(props.initialTarget);
  const [pendingLink, setPendingLink] = useState<PendingLink | undefined>(props.initialLink);
  const [appliedLink, setAppliedLink] = useState<number | null>(null);
  const [linkNotice, setLinkNotice] = useState<string | null>(null);
  const view = session.data;

  // Adjust state while rendering: each pending link (by nonce) is resolved once, against the loaded view.
  if (view !== undefined && pendingLink !== undefined && pendingLink.nonce !== appliedLink) {
    setAppliedLink(pendingLink.nonce);
    // A link of another project is refused even when its session id matches this session's.
    const foreign = typeof pendingLink.link !== "number" && pendingLink.link.projectId !== projectId;
    const resolved = foreign ? null : resolveTarget(view, pendingLink.link);
    const nonce = (target?.nonce ?? 0) + 1;
    if (resolved === null) {
      setLinkNotice(ANOTHER_PROJECT);
    } else if (resolved.kind === "target" || resolved.kind === "hidden") {
      setTarget({ ...resolved.target, nonce, ...(resolved.kind === "hidden" ? { showHidden: true } : {}) });
      setLinkNotice(null);
      setMode("grilling");
    } else if (resolved.kind === "other-session") {
      props.onOpenOtherSessionLink?.(resolved.link);
    } else {
      setLinkNotice(`Q${resolved.number} is not in this session`);
    }
  }
  const openLink = (link: ParsedLink | number) => {
    if (typeof link !== "number" && link.projectId !== projectId) {
      setLinkNotice(ANOTHER_PROJECT);
      return;
    }
    setPendingLink((prev) => ({ link, nonce: (prev?.nonce ?? 0) + 1 }));
  };

  // Each explicit navigation gets a new nonce; repeated callbacks always move on.
  const select = (questionId: string) => {
    setTarget((prev) => ({ questionId, nonce: (prev?.nonce ?? 0) + 1 }));
    setMode("grilling");
  };
  const onOpenRef = (ref: Ref) => (ref.sessionId === sessionId ? select(ref.questionId) : onOpenOtherSession(ref));
  const [pickerOpen, setPickerOpen] = useState(false);
  // The window's height where the platform reports it (kept current on a resize or rotation); the
  // compact Map's notice row takes at most a third.
  const windowHeight = useWindowSize()?.height ?? 600;
  // Compact Map: the measured height of its scroll region and of the notice row above the Map.
  const [mapRoom, setMapRoom] = useState<{ region: number | null; notices: number }>({ region: null, notices: 0 });
  const measureRoom = (key: "region" | "notices", height: number) => setMapRoom((r) => (r[key] === height ? r : { ...r, [key]: height }));
  // The Map takes the room left under the notices, but never less than the region's height or 320 px,
  // whichever is smaller; with a long notice row the region then scrolls, and scrolled past the
  // notices it shows the whole Map (toolbar and graph) inside the region.
  const regionHeight = mapRoom.region ?? 480;
  // The region clips the Map's toolbar and graph as it scrolls: a tooltip of a control there is placed
  // against it, and hides once its control has scrolled out of it (the tooltip layer does not clip).
  // While the region is not drawn its ref is empty and it is not measured.
  const mapRegion = useRef<NativeScrollView | null>(null);
  useEffect(() => registerTooltipBoundary(mapRegion), []);
  const mapHeight = Math.max(regionHeight - mapRoom.notices - 8, Math.min(regionHeight, 320));
  // Kept across Grilling ↔ Map for this session screen only (its key names the host, project and
  // session): the add form with its request, and the chosen block. Nothing is stored outside it.
  const add = useAddQuestion(hostId, projectId, view);
  const selection = useRef<{ chosen: string | null; appliedNonce: number | null }>({ chosen: null, appliedNonce: null });
  const chatTriggerRef = useRef<View | null>(null);
  // One finish request for the screen: the menu's Finish and the proposal's Accept share its pending state.
  const finish = useRoadmapMutation(hostId, projectId, SessionFinish);
  const plannerId = view?.session.planner?.agentId;
  // The picker belongs to a session that can be rebound; it closes when that stops being true.
  const rebindable = view !== undefined && grillingActions(view).bind !== null;
  // Closed because the session stopped being rebindable (closed elsewhere, for example): its control
  // that held focus is gone, so focus returns to the Chat menu trigger, as when it closes otherwise.
  const pickerLost = useRef(false);
  if (pickerOpen && !rebindable) {
    pickerLost.current = true;
    setPickerOpen(false);
  }
  useEffect(() => {
    if (!pickerLost.current || pickerOpen) return;
    pickerLost.current = false;
    moveFocus(chatTriggerRef);
  });

  return (
    <View style={FILL}>
      {/* The title row: Back, the title, the Chat menu and Open chat. The header sits above the body, so the menu card overlays it. */}
      <View style={{ flexShrink: 0, gap: 8, paddingBottom: 12, zIndex: 10 }}>
        {(() => {
          const titleRow = (
            <>
              <ActionButton label="‹ Back" theme={theme} onPress={onBack} />
              <View style={{ flex: 1, minWidth: 0 }}>
                <Heading theme={theme}>{view?.session.title ?? "Session"}</Heading>
              </View>
            </>
          );
          const chatControls = (
            <>
              <ChatMenu hostId={hostId} projectId={projectId} view={view} theme={theme} compact={compact} mode={mode} onMode={setMode} onChangeChat={() => setPickerOpen(true)} triggerRef={chatTriggerRef} finish={finish} />
              {openAgent !== undefined && plannerId !== undefined ? (
                <ActionButton label="Open chat" icon="external-link" iconOnly hint="Open the planner chat" theme={theme} onPress={() => openAgent(plannerId)} />
              ) : null}
            </>
          );
          // Compact: the title keeps its own row; the Chat menu and Open chat follow on the next one, so a
          // narrow screen never squeezes the title between them.
          return compact ? (
            <>
              <View style={{ flexDirection: "row", gap: 8, alignItems: "center" }}>{titleRow}</View>
              <View style={{ flexDirection: "row", gap: 8, alignItems: "center", zIndex: 10 }}>{chatControls}</View>
            </>
          ) : (
            <View style={{ flexDirection: "row", gap: 8, alignItems: "center", zIndex: 10 }}>
              {titleRow}
              {chatControls}
            </View>
          );
        })()}
        {feature !== undefined ? (
          <StageStrip
            hostId={hostId}
            projectId={projectId}
            feature={feature}
            viewed="questions"
            theme={theme}
            compact={compact}
            onNavigate={(stage) => {
              if (stage !== "questions") props.onOpenFeature?.(feature.id);
            }}
          />
        ) : null}
        {pickerOpen && view !== undefined ? (
          // A long list of chats scrolls inside a bounded region, so the canvas below keeps its height.
          <ScrollView style={{ maxHeight: compact ? 220 : 320, flexGrow: 0 }} contentContainerStyle={{ paddingBottom: 4 }}>
          <PlannerPicker
            hostId={hostId}
            projectId={projectId}
            sessionId={view.session.id}
            revision={view.revision}
            currentAgentId={view.session.planner?.agentId ?? null}
            theme={theme}
            onDone={() => {
              setPickerOpen(false);
              moveFocus(chatTriggerRef);
            }}
          />
          </ScrollView>
        ) : null}
      </View>
      {session.isError ? <Text style={{ color: theme.colors.statusDanger }}>{errorText(session.error)}</Text> : null}
      {linkNotice !== null ? <Text style={{ color: theme.colors.statusWarning }}>{linkNotice}</Text> : null}
      {!view && session.isPending ? <Muted theme={theme}>Loading…</Muted> : null}
      {view && mode === "grilling" ? (
        <View style={{ flex: 1, minHeight: 0 }}>
          <GrillingBlocks
            key={sessionId}
            hostId={hostId}
            projectId={projectId}
            view={view}
            theme={theme}
            compact={compact}
            onOpenRef={onOpenRef}
            finish={finish}
            {...(props.onOpenSession ? { onOpenSession: props.onOpenSession } : {})}
            {...(target ? { target } : {})}
            {...(openAgent ? { openAgent } : {})}
            onOpenLink={openLink}
            kept={{ add, selection }}
          />
        </View>
      ) : null}
      {view && mode === "map" ? (
        // The notices under the stage strip stay visible on the Map too (plan r4 §2.1); the Grilling
        // view draws its own above its canvas, so there is one copy in either view.
        compact ? (
          // Compact: one vertical region holds the notices and the Map, so neither is ever out of reach
          // on a short window. The notice row scrolls inside its own bound (a third of the window, at
          // most 200 px); the Map below has a measured height (see mapHeight), so its graph keeps room
          // and, past a long notice row, the region scrolls to it.
          <ScrollView
            key="map-region"
            ref={mapRegion}
            style={{ flex: 1, minHeight: 0 }}
            contentContainerStyle={{ gap: 8 }}
            nestedScrollEnabled
            onLayout={(e: { nativeEvent: { layout: { height: number } } }) => measureRoom("region", e.nativeEvent.layout.height)}
          >
            <ScrollView
              accessibilityLabel="Session notices"
              nestedScrollEnabled
              style={{ flexGrow: 0, flexShrink: 0, maxHeight: Math.min(200, Math.round(windowHeight / 3)) }}
              onLayout={(e: { nativeEvent: { layout: { height: number } } }) => measureRoom("notices", e.nativeEvent.layout.height)}
            >
              <SessionNotices hostId={hostId} projectId={projectId} view={view} theme={theme} />
            </ScrollView>
            <View style={{ height: mapHeight }}>
              <MapView
                view={view}
                theme={theme}
                compact={compact}
                onOpenQuestion={select}
                onOpenRef={onOpenRef}
                // The Map is the region's last part and never taller than the region: its end shows
                // the whole Map, so a target the Map scrolls to is in view.
                onReveal={() => {
                  const region = mapRegion.current;
                  if (region !== null && typeof region.scrollToEnd === "function") region.scrollToEnd({ animated: true });
                }}
                {...(props.onOpenSession ? { onOpenSession: props.onOpenSession } : {})}
              />
            </View>
          </ScrollView>
        ) : (
          <View style={{ flex: 1, minHeight: 0, gap: 8 }}>
            <SessionNotices hostId={hostId} projectId={projectId} view={view} theme={theme} />
            <MapView
              view={view}
              theme={theme}
              compact={compact}
              onOpenQuestion={select}
              onOpenRef={onOpenRef}
              {...(props.onOpenSession ? { onOpenSession: props.onOpenSession } : {})}
            />
          </View>
        )
      ) : null}
    </View>
  );
}

/** A feature by exact id, else by a unique case-insensitive title; null on a miss or an ambiguity. */
function resolveFeature<F extends { id: string; title: string }>(features: F[], query: string): F | null {
  const byId = features.find((f) => f.id === query);
  if (byId) return byId;
  const wanted = query.toLowerCase();
  const byTitle = features.filter((f) => f.title.trim().toLowerCase() === wanted);
  return byTitle.length === 1 ? byTitle[0] : null;
}

function ProjectRoadmap(props: {
  hostId: string;
  projectId: string;
  workspaceId: string;
  theme: Theme;
  compact: boolean;
  openAgent?(agentId: string): void;
  /** The host's per-tab state when it passes one: the screen stack outlives a remount there. */
  tab: HostTab | null;
}) {
  const { hostId, projectId, workspaceId, theme, compact, openAgent, tab } = props;
  const version = useRoadmapVersion(hostId, projectId);
  // Live revision events make changes appear sooner where supported; the version poll stays the fallback.
  useLiveRevision(hostId, projectId);
  const ok = version.data?.status === "ok";
  const overview = useOverview(hostId, projectId, ok);
  // The default discussion profile; unread or invalid settings mean "no default" (Discuss then asks).
  const settings = useSettings(roadmapSettings);
  const discussionProfile = settings.status === "ready" ? settings.values.discussionProfile : undefined;
  // English, then the configured discussion languages; unread settings offer English alone.
  const discussionLanguages = discussionLanguageChoices(settings.status === "ready" ? (settings.values.discussionLanguages ?? []) : []);
  const [stack, setStack] = useState<Screen[]>(() => restoreStack(tab, hostId, projectId) ?? [{ kind: "overview" }]);
  // Kept in the host's tab (when it has one) without one-shot link targets, so a remount of the panel,
  // as on a compact/wide breakpoint change, reopens the same screen with Back leading the same way.
  useEffect(() => saveStack(tab, hostId, projectId, stack.map(storedScreen)), [tab, hostId, projectId, stack]);
  const screen = stack[stack.length - 1];
  const [notice, setNotice] = useState<string | null>(null);
  const push = (next: Screen) => {
    setNotice(null);
    setStack((s) => [...s, next]);
  };
  const back = () => {
    setNotice(null);
    setStack((s) => (s.length > 1 ? s.slice(0, -1) : s));
  };
  // Stage R4.5a: the route left by `/roadmap` for this workspace and project, taken once on mount
  // and whenever a new one is set while the panel is open.
  const [route, setRoute] = useState<RoadmapRoute | null>(null);
  const [routeTick, setRouteTick] = useState(0);
  useEffect(() => subscribePendingRoute(() => setRouteTick((t) => t + 1)), []);
  useEffect(() => {
    const next = takePendingRoute({ workspaceId, projectId });
    if (next) setRoute(next);
  }, [workspaceId, projectId, routeTick]);
  const features = useFeatureList(hostId, projectId, ok && (route !== null || screen.kind === "roadmap" || screen.kind === "feature" || screen.kind === "session"));
  const listed = features.data?.features;
  useEffect(() => {
    if (!route) return;
    if (route.kind === "roadmap") {
      setRoute(null);
      push({ kind: "roadmap" });
      return;
    }
    // A question link opens its session with the whole link, resolved there once the view loads.
    if (route.kind === "question") {
      setRoute(null);
      if (route.link.projectId !== projectId) {
        setNotice(ANOTHER_PROJECT);
        return;
      }
      push({ kind: "session", sessionId: route.link.sessionId, link: { link: route.link, nonce: routeTick + 1 } });
      return;
    }
    // A short Q<n> names a question of the session open in the panel.
    if (route.kind === "question-number") {
      setRoute(null);
      const top = stack[stack.length - 1];
      if (top.kind !== "session") {
        setNotice(`Open a session first to go to Q${route.number}`);
        return;
      }
      setStack((s) => [...s.slice(0, -1), { ...top, link: { link: route.number, nonce: routeTick + 1 } }]);
      return;
    }
    // A feature query resolves only once the feature list is ready. A failed read with no list goes to
    // the roadmap route, whose error branch shows the failure, instead of stalling on the overview.
    if (!listed) {
      if (features.isError) {
        setRoute(null);
        push({ kind: "roadmap" });
      }
      return;
    }
    setRoute(null);
    const target = resolveFeature(listed, route.query);
    if (target) push({ kind: "feature", featureId: target.id });
    else {
      push({ kind: "roadmap" });
      setNotice(`No single feature matches '${route.query}'`);
    }
  }, [route, listed, features.isError]);
  const plans = usePlanList(hostId, projectId, ok && screen.kind === "feature");
  const init = useRpc(RoadmapInit);
  const queryClient = useQueryClient();
  const toast = useToast();
  const [initialising, setInitialising] = useState(false);

  async function initialise() {
    setInitialising(true);
    try {
      const out = await init({ projectId });
      if (!out.ok) toast.show(conflictMessage(out.error), { variant: "error" });
      await queryClient.invalidateQueries({ queryKey: roadmapKey(hostId, projectId) });
    } catch (e) {
      toast.show(errorText(e), { variant: "error" });
    } finally {
      setInitialising(false);
    }
  }

  if (version.isError) return <Text style={{ color: theme.colors.statusDanger }}>{errorText(version.error)}</Text>;
  if (!version.data) return <Muted theme={theme}>Loading…</Muted>;
  if (version.data.status === "missing") {
    return (
      <View style={{ gap: 12 }}>
        <Text style={{ color: theme.colors.foreground }}>No decision roadmap in this project</Text>
        <Muted theme={theme}>Initialising creates a .decisions folder in the project for questions, answers and their history.</Muted>
        <ActionButton label="Initialise roadmap" theme={theme} primary disabled={initialising} onPress={() => void initialise()} />
      </View>
    );
  }
  if (version.data.status === "invalid") {
    return (
      <View style={{ gap: 8, borderWidth: 1, borderColor: theme.colors.statusWarning, borderRadius: 8, padding: 12 }}>
        <Text style={{ color: theme.colors.statusWarning, fontWeight: "600" }}>The roadmap data could not be read</Text>
        <Text style={{ color: theme.colors.foreground }}>{version.data.error ?? "Unknown problem"}</Text>
        <Muted theme={theme}>Nothing was changed. Fix or restore the .decisions folder to continue.</Muted>
      </View>
    );
  }
  const key = `${stack.length}:${screen.kind}`;
  // A notice (a refused link or route) shows above whatever screen the panel is on.
  const content = (() => {
    if (screen.kind === "session") {
      const sessionFeature = features.data?.features.find((f) => f.grillSessionId === screen.sessionId);
      return (
        <View style={FILL}>
          <SessionScreen
            key={`${key}:${screen.sessionId}:${screen.link?.nonce ?? 0}`}
            sessionId={screen.sessionId}
            {...(screen.target ? { initialTarget: screen.target } : {})}
            {...(screen.link ? { initialLink: screen.link } : {})}
            onOpenOtherSessionLink={(link) =>
              link.projectId === projectId
                ? push({ kind: "session", sessionId: link.sessionId, link: { link, nonce: 1 } })
                : setNotice(ANOTHER_PROJECT)
            }
            hostId={hostId}
            projectId={projectId}
            theme={theme}
            compact={compact}
            onBack={back}
            onOpenOtherSession={(ref) => push({ kind: "session", sessionId: ref.sessionId, target: { questionId: ref.questionId, nonce: 1 } })}
            onOpenSession={(id) => push({ kind: "session", sessionId: id })}
            {...(openAgent ? { openAgent } : {})}
            {...(sessionFeature !== undefined ? { feature: sessionFeature } : {})}
            onOpenFeature={(featureId) => push({ kind: "feature", featureId })}
          />
        </View>
      );
    }
    if (screen.kind === "plan") {
      return (
        <View style={FILL}>
          <PlanView key={`${key}:${screen.planId}`} planId={screen.planId} hostId={hostId} projectId={projectId} theme={theme} compact={compact} onBack={back} />
        </View>
      );
    }
    if (screen.kind === "roadmap" || screen.kind === "feature") {
      // A route whose data is loading or failed keeps its way back.
      const unresolved = (query: { isError: boolean; error: unknown }) => (
        <View style={{ gap: 8 }}>
          <ActionButton label="‹ Back" theme={theme} onPress={back} />
          {query.isError ? <Text style={{ color: theme.colors.statusDanger }}>{errorText(query.error)}</Text> : <Muted theme={theme}>Loading…</Muted>}
        </View>
      );
      if (features.isError || !features.data) return unresolved(features);
      if (screen.kind === "roadmap") {
        return (
          <View style={FILL}>
            <ScrollView style={{ flex: 1, minHeight: 0 }} contentContainerStyle={{ paddingBottom: 24 }}>
              <RoadmapScreen
                key={key}
                hostId={hostId}
                projectId={projectId}
                theme={theme}
                compact={compact}
                features={features.data.features}
                delegations={features.data.delegations}
                revision={features.data.revision}
                onOpenFeature={(featureId) => push({ kind: "feature", featureId })}
                onBack={back}
                discussion={{ workspaceId, defaultProfile: discussionProfile, languages: discussionLanguages, onOpenSession: (sessionId) => push({ kind: "session", sessionId }) }}
              />
            </ScrollView>
          </View>
        );
      }
      const feature = features.data.features.find((f) => f.id === screen.featureId);
      if (!feature) {
        return (
          <View style={{ gap: 8 }}>
            <Text style={{ color: theme.colors.foreground }}>This feature no longer exists</Text>
            <ActionButton label="‹ Back" theme={theme} onPress={back} />
          </View>
        );
      }
      if (plans.isError || !plans.data) return unresolved(plans);
      return (
        // Stage R4.2: a bounded viewport; FeatureScreen owns its scrolling (sticky run bar and composer).
        <View style={FILL}>
          <FeatureScreen
            key={`${key}:${feature.id}`}
            hostId={hostId}
            projectId={projectId}
            theme={theme}
            compact={compact}
            feature={feature}
            features={features.data.features}
            plans={plans.data.plans}
            revision={features.data.revision}
            onOpenFeature={(featureId) => push({ kind: "feature", featureId })}
            onOpenPlan={(planId) => push({ kind: "plan", planId })}
            onOpenSession={(sessionId) => push({ kind: "session", sessionId })}
            onBack={back}
          />
        </View>
      );
    }
    if (overview.isError) return <Text style={{ color: theme.colors.statusDanger }}>{errorText(overview.error)}</Text>;
    if (!overview.data) return <Muted theme={theme}>Loading…</Muted>;
    return (
      <OverviewScreen
        overview={overview.data}
        hostId={hostId}
        projectId={projectId}
        theme={theme}
        onOpen={(sessionId) => push({ kind: "session", sessionId })}
        onOpenPlan={(planId) => push({ kind: "plan", planId })}
        onOpenRoadmap={() => push({ kind: "roadmap" })}
      />
    );

  })();
  if (notice === null) return content;
  return (
    <View style={FILL}>
      <Text accessibilityRole="alert" style={{ color: theme.colors.statusWarning, marginBottom: 8, flexShrink: 0 }}>
        {notice}
      </Text>
      {content}
    </View>
  );
}

export function RoadmapPanel(props: PluginWorkspacePanelProps) {
  const { theme, layout, host, workspaceId } = props;
  const navigation = props.navigation;
  const openAgent = navigation !== undefined ? (agentId: string) => navigation.openAgent({ agentId }) : undefined;
  const projectId = useProjectId(workspaceId);
  return (
    <View style={{ flex: 1, padding: layout.compact ? 12 : 16, backgroundColor: theme.colors.surface0 }}>
      {projectId === null ? (
        <Text style={{ color: theme.colors.foreground }}>Workspace has no project</Text>
      ) : (
        <ProjectRoadmap
          key={`${host.id}:${projectId}`}
          hostId={host.id}
          projectId={projectId}
          workspaceId={workspaceId}
          theme={theme}
          compact={layout.compact}
          {...(openAgent ? { openAgent } : {})}
          tab={hostTabOf(props)}
        />
      )}
      {/* Last, so a shown tooltip is drawn over the whole panel (it takes no touches). */}
      <TooltipLayer />
    </View>
  );
}
