// The branching Map: the pure model of map-layout.ts drawn with plain Views (no SVG, no DOM). The
// world is scaled with a transform anchored at its top left inside a wrapper of the scaled size, so
// native scrolling pans it and its extents match. At 75 % and above every node is a 44 px target; below
// that the world is an overview, and the List and the Find question picker remain the accessible
// ways to select a question at any scale.
import type { PluginTheme } from "@getpaseo/plugin";
import { Modal, ScrollView, TextInput } from "@getpaseo/plugin/client/react-native";
import { createRef, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { Pressable, ScrollView as NativeScrollView, Text, View, type TextInput as NativeTextInput } from "react-native";
import type { Ref } from "../shared/model";
import type { QuestionView, SessionView } from "../shared/rpc";
import { currentAnswer } from "../shared/status";
import { blockLaneKey, GUTTER, LEGACY_LANE, mapModel, reserveLaneSpace, type MapEdge, type MapEdgeKind, type MapModel, type MapNode } from "./map-layout";
import { relationLinks } from "./relation-links";
import { FocusScope, moveFocus, webAria } from "./discussion-ui";
import { ActionButton } from "./roadmap-screen";
import { STATUS_LABEL, TARGET_SIZE } from "./theme";
import { inputStyle } from "./ui";

const LEVELS = [0.5, 0.75, 1, 1.25] as const;
/** Below this scale nodes are smaller than a 44 px target: the world is an overview. */
const INTERACTIVE = 0.75;
/** Above this many nodes the Map opens on the List; the graph stays behind the toggle. */
const LIST_FIRST = 400;
const DETAIL_WIDTH = 320;
/** Above this many nodes lanes start collapsed; a heuristic to tune from host evidence. */
const COLLAPSE_AT = 120;
/** How long a programmatic scroll may report nothing before it stops counting as in flight. */
const HEADING_MS = 1500;
/** The height of one row of activation-condition labels (a 14 px line and a gap). */
const LABEL_ROW = 15;
/** Each kind's glyph, drawn on cross-lane edges so the kind never depends on a line style alone. */
const KIND_GLYPH: Record<MapEdgeKind, string> = { activation: "▸", invalidation: "⊘", informs: "ⓘ", supersedes: "⇢" };

type Zoom = number | "fit";
type KeyEvent = { key?: string; nativeEvent?: { key?: string } };

const KIND_LINE: Record<MapEdgeKind, { style: "solid" | "dashed" | "dotted"; tone: "accent" | "muted" | "warning" }> = {
  activation: { style: "solid", tone: "accent" },
  invalidation: { style: "dashed", tone: "muted" },
  informs: { style: "dotted", tone: "muted" },
  supersedes: { style: "solid", tone: "warning" },
};

function optionLabels(view: SessionView, node: MapNode | undefined, optionIds: string[] | undefined): string {
  if (optionIds === undefined || optionIds.length === 0) return "";
  const qv = node?.questionId !== undefined ? view.questions.find((x) => x.question.id === node.questionId) : undefined;
  const entry = node?.ref?.questionId !== undefined ? view.catalog.find((c) => c.ref.sessionId === node.ref!.sessionId && c.ref.questionId === node.ref!.questionId) : undefined;
  const options = qv?.question.options ?? entry?.options ?? [];
  return optionIds.map((id) => options.find((o) => o.id === id)?.label ?? id).join(" or ");
}

type ConditionLabel = { key: string; lane: string; row: number; x: number; width: number; text: string };

/**
 * The selected node's activation conditions, each its own label in its target lane's routing track
 * (which holds no node), starting at the gutter before the target. Labels never share a place: they go
 * side by side and, when a row is full, on further rows. `extra` is the height each lane must grow by,
 * below its track, to hold its rows; the lanes below move down by that much, so no label reaches a node,
 * port, header or another lane, however many rows there are.
 */
function placeConditions(view: SessionView, full: MapModel, model: MapModel, selected: string | undefined): { labels: ConditionLabel[]; extra: Map<string, number> } {
  const labels: ConditionLabel[] = [];
  const extra = new Map<string, number>();
  if (selected === undefined) return { labels, extra };
  const width = model.world.width;
  const conditions = model.edges
    .filter((e) => e.kind === "activation" && e.optionIds !== undefined && (e.from === selected || e.to === selected))
    .map((e) => {
      const target = model.nodes.find((n) => n.key === e.to)!;
      const owner = full.nodes.find((n) => n.key === (e.via?.from ?? e.from));
      return { e, target, text: `when ${optionLabels(view, owner, e.optionIds)}` };
    })
    .sort((a, b) => a.target.x - b.target.x || (a.e.key < b.e.key ? -1 : 1));
  const rowEnds = new Map<string, number[]>();
  for (const { e, target, text } of conditions) {
    const w = Math.min(360, 8 + text.length * 6.5, width);
    const wanted = Math.min(Math.max(0, target.x - GUTTER + 2), Math.max(0, width - w));
    // The first row whose labels end left of this one's place (or that has room after them).
    const rows = rowEnds.get(target.lane) ?? [];
    let row = 0;
    let x = wanted;
    for (; row < rows.length; row++) {
      x = Math.max(wanted, rows[row] + 4);
      if (x + w <= width) break;
    }
    if (row === rows.length) {
      rows.push(0);
      x = wanted;
    }
    rows[row] = x + w;
    rowEnds.set(target.lane, rows);
    labels.push({ key: e.key, lane: target.lane, row, x, width: w, text });
  }
  for (const [lane, rows] of rowEnds) {
    const l = model.lanes.find((x) => x.key === lane)!;
    // Rows start 1 px into the track, each a 14 px line and a 1 px gap; the last gap stays as a margin.
    const grow = 1 + rows.length * LABEL_ROW - (l.y + l.height - l.trackY);
    if (grow > 0) extra.set(lane, grow);
  }
  return { labels, extra };
}

/** How a related question stands to the selected one, from the selected question's side. */
function kindWording(kind: MapEdgeKind, incoming: boolean, condition: string): string {
  const when = condition !== "" ? ` when ${condition}` : "";
  if (incoming) {
    if (kind === "activation") return `activates it${when}`;
    if (kind === "invalidation") return "a change there needs it reviewed";
    return kind === "informs" ? "informs it" : "supersedes it";
  }
  if (kind === "activation") return `activated by it${when}`;
  if (kind === "invalidation") return "needs review when it changes";
  return kind === "informs" ? "informed by it" : "superseded by it";
}

const nodeQuestion = (view: SessionView, n: MapNode): QuestionView | undefined => (n.questionId !== undefined ? view.questions.find((x) => x.question.id === n.questionId) : undefined);

function laneName(model: MapModel, n: MapNode): string {
  const label = model.lanes.find((l) => l.key === n.lane)?.label ?? "";
  return label.split(" · ")[0];
}

/** The status in words, with "inactive" added once for an inactive question whose status says otherwise. */
function statusText(qv: QuestionView, n: MapNode): string {
  const word = STATUS_LABEL[qv.status];
  return n.inactive === true && qv.status !== "inactive" ? `${word} · inactive` : word;
}

/** "Q3 How long…, Open, Block 2, 1 incoming, 1 outgoing"; an external stub names its session. */
function nodeLabel(view: SessionView, model: MapModel, n: MapNode): string {
  // A self-link counts once, as outgoing (the detail lists it under "Leads to").
  const incoming = model.edges.filter((e) => e.to === n.key && e.from !== n.key).length;
  const outgoing = model.edges.filter((e) => e.from === n.key).length;
  const counts = `${incoming} incoming, ${outgoing} outgoing`;
  const qv = nodeQuestion(view, n);
  if (qv !== undefined) return `${n.label}, ${statusText(qv, n)}, ${laneName(model, n)}, ${counts}`;
  const entry = n.ref?.questionId !== undefined ? view.catalog.find((c) => c.ref.sessionId === n.ref!.sessionId && c.ref.questionId === n.ref!.questionId) : undefined;
  return entry !== undefined ? `${entry.questionTitle} (${entry.sessionTitle}), external, ${counts}` : `${n.label}, external, ${counts}`;
}

export function MapView(props: {
  view: SessionView;
  theme: PluginTheme;
  compact: boolean;
  /** Shows the question on the Grilling canvas: its block selected and its card outlined. */
  onOpenQuestion(questionId: string): void;
  onOpenRef?(ref: Ref): void;
  onOpenSession?(sessionId: string): void;
  /**
   * The owner asked to see a place on the graph (Go to, a selection, an overview press, Fit): a
   * container that scrolls the Map itself (the compact Map's region below a long notice row) brings
   * the graph into view. Called from the owner's actions only, never from a layout.
   */
  onReveal?(): void;
}) {
  const { view, theme, compact } = props;
  const [showInactive, setShowInactive] = useState(true);
  // Every node and relation; the drawn model may collapse lanes. The detail, the List and the picker read the full one.
  const full = useMemo(() => mapModel(view, { showInactive }), [view, showInactive]);
  const [mode, setMode] = useState<"graph" | "list">(() => (full.nodes.length > LIST_FIRST ? "list" : "graph"));
  const [zoom, setZoom] = useState<Zoom>(compact ? "fit" : 1);
  const [selected, setSelected] = useState<string | null>(null);
  const [finding, setFinding] = useState(false);
  const [filter, setFilter] = useState("");
  const [viewport, setViewport] = useState<{ width: number; height: number } | null>(null);
  const vScroll = useRef<NativeScrollView | null>(null);
  const overviewRef = useRef<View | null>(null);
  // Closing the detail (its sheet, Close, Clear, Escape) returns focus to the node it described; in the
  // overview, or for a node that cannot take focus, to Find question.
  const nodeRefs = useRef(new Map<string, RefObject<View | null>>());
  const refFor = (key: string) => {
    let r = nodeRefs.current.get(key);
    if (r === undefined) {
      r = createRef<View>();
      nodeRefs.current.set(key, r);
    }
    return r;
  };
  const findRef = useRef<View | null>(null);
  // The compact Find question sheet is the host's bottom sheet, which moves no focus on the web: its
  // focus scope moves focus to the first question once laid out (not the filter, so a phone does not
  // raise its keyboard over the list), and focus returns to Find question when the sheet closes (the
  // host's dismissal, Escape or the toggle).
  const findFirstRef = useRef<View | null>(null);
  const findLastRef = useRef<View | null>(null);
  const filterRef = useRef<NativeTextInput | null>(null);
  const refocusFind = useRef(false);
  const openFind = () => setFinding(true);
  const closeFind = () => {
    refocusFind.current = true;
    setFinding(false);
  };
  const refocus = useRef<string | null>(null);
  const hScroll = useRef<NativeScrollView | null>(null);
  // Above COLLAPSE_AT nodes every lane but the open block's and the selected node's is collapsed;
  // the owner's own expand or collapse of a lane overrides that until the Map is left.
  const [laneToggle, setLaneToggle] = useState<Record<string, boolean>>({});
  const collapseMode = full.nodes.length > COLLAPSE_AT;
  // The visible note that describes a collapsed lane's port (its DOM id on the web).
  const portHintId = `map-port-hint-${view.session.id}`;
  const openLane = blockLaneKey(view.session.blocks?.find((b) => b.state === "open")?.id);
  const selectedLane = full.nodes.find((n) => n.key === selected)?.lane;
  const collapsedLanes = collapseMode
    ? full.lanes.filter((l) => l.key !== LEGACY_LANE && (laneToggle[l.key] ?? (l.key !== openLane && l.key !== selectedLane))).map((l) => l.key)
    : [];
  const collapsedKey = collapsedLanes.join("|");
  const laid = useMemo(
    () => (mode !== "graph" || collapsedLanes.length === 0 ? full : mapModel(view, { showInactive, collapsed: new Set(collapsedLanes) })),
    // collapsedKey stands for collapsedLanes; the collapsed graph is built only while it is shown.
    [full, collapsedKey, mode],
  );
  // The selected node's condition labels, and the room their lanes grow by to hold them. The drawn model
  // is the laid one with that room reserved; it is rebuilt only when the room changes.
  const conditionLabels = placeConditions(view, full, laid, mode === "graph" && selected !== null && laid.nodes.some((n) => n.key === selected) ? selected : undefined);
  const extraKey = [...conditionLabels.extra].map(([k, v]) => `${k}:${v}`).join("|");
  const model = useMemo(
    () => reserveLaneSpace(laid, conditionLabels.extra),
    // extraKey stands for conditionLabels.extra.
    [laid, extraKey],
  );
  const setLaneCollapsed = (lane: string, collapsed: boolean) => setLaneToggle((t) => ({ ...t, [lane]: collapsed }));
  // What the view keeps centred: the selected node, or the point an overview press zoomed in on. It is
  // applied after each layout that can move it (the detail panel narrowing the world, a zoom, a lane
  // expanding), never from a layout measured before.
  const centreTarget = useRef<{ key: string } | { lane: string } | { x: number; y: number } | null>(null);
  // Fit scrolls the world to its origin once the fitted world is drawn.
  const toOrigin = useRef(false);
  const [centreRequest, setCentreRequest] = useState(0);

  const fitScale = viewport === null ? 1 : Math.min(1, Math.max(0.3, Math.min(viewport.width / model.world.width, viewport.height / model.world.height)));
  const scale = zoom === "fit" ? fitScale : zoom;
  // 50 % and Fit are overviews: Fit may land above 75 % on a small map, and stays an overview anyway.
  const overview = zoom === "fit" || scale < INTERACTIVE;
  const node = selected !== null ? full.nodes.find((n) => n.key === selected) : undefined;
  const drawn = selected !== null ? model.nodes.find((n) => n.key === selected) : undefined;
  const neighbours = new Set(drawn === undefined ? [] : model.edges.flatMap((e) => (e.from === drawn.key ? [e.to] : e.to === drawn.key ? [e.from] : [])));
  const percent = `${Math.round(scale * 100)} %`;

  // A user's pan (wheel, touch drag, scroll bar or keyboard) ends the centring: a later layout (a lane
  // expanding, a zoom) leaves the view where the user put it. Wheel and touch drag announce themselves;
  // a scroll bar or keyboard pan shows only as scroll events, which a programmatic scroll also gives. So
  // each axis keeps the position its own scrollTo is heading to, and the scroll views report every
  // scroll event (scrollEventThrottle) besides the run's end, which React Native Web reports 100 ms
  // after the last one at the same position. While a run is in flight:
  // - a call at the target, or at the target clamped to the content's extent then, ends it as the
  //   view's own;
  // - a call at the position of the one before, once the position has moved since this scrollTo, is
  //   the run's end: it stopped short of the target, so the user's scroll cut into it (the browser
  //   cancels a smooth scroll on the user's scroll);
  // - any other call is a step on the way.
  // The end report of a run that has finished can arrive after the next scrollTo (it is due 100 ms after
  // that run's last event and the next run's first event, which would postpone it, comes a frame later):
  // it repeats the old position before anything has moved, so it is not taken for this run's end. A run
  // the user cuts into before its first frame moves (by the user's scroll) and so still counts.
  // With no run in flight, a call that moves the position is the user's. A run that reports nothing for
  // HEADING_MS (one the browser never started) stops counting.
  const scrolled = useRef({ x: 0, y: 0 });
  const heading = useRef<Record<"x" | "y", { to: number; at: number; moved: boolean } | null>>({ x: null, y: null });
  // The graph's scroll views start at their origin each time they mount (leaving the List).
  const scrollMode = useRef(mode);
  if (scrollMode.current !== mode) {
    scrollMode.current = mode;
    scrolled.current = { x: 0, y: 0 };
    heading.current = { x: null, y: null };
  }
  const inFlight = (axis: "x" | "y") => {
    const h = heading.current[axis];
    return h !== null && Date.now() - h.at < HEADING_MS ? h : null;
  };
  const scrollAxis = (axis: "x" | "y", to: number, animated: boolean) => {
    // Already there with nothing in flight: the browser does not scroll, so no run is expected.
    if (inFlight(axis) !== null || Math.abs(to - scrolled.current[axis]) > 1) heading.current[axis] = { to, at: Date.now(), moved: false };
    if (axis === "x") hScroll.current?.scrollTo({ x: to, animated });
    else vScroll.current?.scrollTo({ y: to, animated });
  };
  const userPanned = () => {
    centreTarget.current = null;
  };
  const wheelProp: Record<string, () => void> = { onWheel: userPanned };
  type ScrollEvent = { nativeEvent: { contentOffset: { x: number; y: number }; contentSize?: { width: number; height: number }; layoutMeasurement?: { width: number; height: number } } };
  const onScrollOf = (axis: "x" | "y") => (e: ScrollEvent) => {
    const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
    const at = contentOffset[axis];
    const before = scrolled.current[axis];
    scrolled.current[axis] = at;
    const run = inFlight(axis);
    if (run === null) {
      heading.current[axis] = null;
      if (Math.abs(at - before) > 1) userPanned();
      return;
    }
    const dim = axis === "x" ? "width" : "height";
    const max = contentSize !== undefined && layoutMeasurement !== undefined ? Math.max(0, contentSize[dim] - layoutMeasurement[dim]) : Number.POSITIVE_INFINITY;
    if (Math.abs(at - run.to) <= 1 || Math.abs(at - Math.max(0, Math.min(run.to, max))) <= 1) {
      heading.current[axis] = null;
    } else if (Math.abs(at - before) < 0.01) {
      // Before this run has moved, a repeated position is the end report of the run before.
      if (!run.moved) return;
      heading.current[axis] = null;
      userPanned();
    } else {
      run.at = Date.now();
      run.moved = true;
    }
  };

  /** Scrolls so the world point is centred, clamped to the scrollable extent. */
  const centreOn = (x: number, y: number, s: number) => {
    if (viewport === null) return;
    const clamp = (v: number, max: number) => Math.max(0, Math.min(v, Math.max(0, max)));
    scrollAxis("x", clamp(x * s - viewport.width / 2, model.world.width * s - viewport.width), true);
    scrollAxis("y", clamp(y * s - viewport.height / 2, model.world.height * s - viewport.height), true);
  };
  const select = (key: string | null) => {
    setSelected(key);
    const n = key !== null ? full.nodes.find((x) => x.key === key) : undefined;
    if (n === undefined) return;
    if (collapsedLanes.includes(n.lane)) setLaneCollapsed(n.lane, false);
    toOrigin.current = false;
    centreTarget.current = { key: n.key };
    setCentreRequest((r) => r + 1);
    props.onReveal?.();
  };
  useEffect(() => {
    if (toOrigin.current) {
      if (viewport === null) return;
      toOrigin.current = false;
      scrollAxis("x", 0, false);
      scrollAxis("y", 0, false);
      return;
    }
    const t = centreTarget.current;
    if (t === null) return;
    if ("lane" in t) {
      // The first question of the lane in reading order, once the lane is drawn expanded.
      const n = model.nodes.find((x) => x.lane === t.lane && x.port === undefined);
      if (n !== undefined) centreOn(n.x + n.width / 2, n.y + n.height / 2, scale);
      return;
    }
    if ("key" in t) {
      // A cleared or changed selection is no longer kept centred.
      if (t.key !== selected) {
        centreTarget.current = null;
        return;
      }
      const n = model.nodes.find((x) => x.key === t.key);
      if (n !== undefined) centreOn(n.x + n.width / 2, n.y + n.height / 2, scale);
      return;
    }
    centreOn(t.x, t.y, scale);
  }, [centreRequest, viewport?.width, viewport?.height, scale, model, selected]);
  const dismissDetail = () => {
    refocus.current = selected;
    setSelected(null);
  };
  useEffect(() => {
    const key = refocus.current;
    if (key === null || selected !== null) return;
    refocus.current = null;
    const n = model.nodes.find((x) => x.key === key);
    moveFocus(n !== undefined && !overview && n.missing !== true && mode === "graph" ? refFor(key) : findRef);
  });
  // Wide: a pick from Find question or a List row unmounts the focused row, which would leave focus on
  // the page; focus moves to the picked node, or, when it is not drawn as a button (the overview, a
  // missing stub), to Find question. Compact leaves it to the detail sheet, which moves focus itself.
  const focusPicked = useRef<string | null>(null);
  const pickedFocus = (key: string) => {
    if (!compact) focusPicked.current = key;
  };
  useEffect(() => {
    const key = focusPicked.current;
    if (key === null || finding || mode !== "graph") return;
    const n = model.nodes.find((x) => x.key === key);
    focusPicked.current = null;
    // The pick's own commit draws the node (its lane expands with the selection); a node that is not
    // drawn as a button then leaves focus with Find question.
    const drawnButton = n !== undefined && !overview && n.missing !== true && refFor(key).current !== null;
    moveFocus(drawnButton ? refFor(key) : findRef, { preventScroll: true });
  });
  useEffect(() => {
    if (finding || !refocusFind.current) return;
    refocusFind.current = false;
    moveFocus(findRef);
  });
  /** Fit: the world fitted to the view and scrolled to its origin; no node is kept centred. */
  const fit = () => {
    centreTarget.current = null;
    toOrigin.current = true;
    setZoom("fit");
    setCentreRequest((r) => r + 1);
    props.onReveal?.();
  };
  // A wide world can leave the open block out of the first view (at Fit, for example): this brings its
  // first question into view at the current zoom, expanding its lane if it was collapsed.
  const openBlock = view.session.blocks?.find((b) => b.state === "open");
  const openBlockNumber = openBlock !== undefined && full.nodes.some((n) => n.lane === openLane && n.questionId !== undefined) ? openBlock.order + 1 : null;
  const goToOpenBlock = () => {
    if (collapsedLanes.includes(openLane)) setLaneCollapsed(openLane, false);
    toOrigin.current = false;
    centreTarget.current = { lane: openLane };
    setCentreRequest((r) => r + 1);
    props.onReveal?.();
  };
  const step = (dir: -1 | 1) => {
    const next = dir < 0 ? [...LEVELS].reverse().find((l) => l < scale - 0.001) : LEVELS.find((l) => l > scale + 0.001);
    if (next !== undefined) setZoom(next);
  };
  const escape: Record<string, (e: KeyEvent) => void> = {
    onKeyDown: (e) => {
      if ((e.key ?? e.nativeEvent?.key) !== "Escape") return;
      if (finding) closeFind();
      else dismissDetail();
    },
  };

  // ---- Toolbar: zoom, Fit, Graph/List, Show inactive, Find question ----
  // Icon buttons like the rest of the screen: a 44 px square, the label as accessibility label, and the
  // hint as accessibility hint and tooltip (hover, focus, long press).
  const toolButton = (label: string, icon: string, hint: string, onPress: () => void, disabled = false) => (
    <ActionButton label={label} icon={icon} iconOnly hint={hint} theme={theme} disabled={disabled} onPress={onPress} />
  );
  const toolbar = (
    <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
      {mode === "graph" ? (
        <>
          {toolButton("Zoom out", "minus", "Zoom out one step (50, 75, 100, 125 %)", () => step(-1), scale <= LEVELS[0] + 0.001)}
          <Text accessibilityLiveRegion="polite" style={{ minWidth: 48, textAlign: "center", color: theme.colors.foreground }}>
            {percent}
          </Text>
          {toolButton("Zoom in", "plus", "Zoom in one step (50, 75, 100, 125 %)", () => step(1), scale >= LEVELS[LEVELS.length - 1] - 0.001)}
          <ActionButton label="Fit" theme={theme} selected={zoom === "fit"} pressed={zoom === "fit"} onPress={fit} />
          {openBlockNumber !== null ? <ActionButton label={`Go to open Block ${openBlockNumber}`} theme={theme} onPress={goToOpenBlock} /> : null}
        </>
      ) : null}
      <ActionButton label="Graph" theme={theme} selected={mode === "graph"} pressed={mode === "graph"} onPress={() => setMode("graph")} />
      <ActionButton label="List" theme={theme} selected={mode === "list"} pressed={mode === "list"} onPress={() => setMode("list")} />
      <ActionButton label="Show inactive" theme={theme} selected={showInactive} pressed={showInactive} onPress={() => setShowInactive(!showInactive)} />
      <ActionButton ref={findRef} label="Find question" theme={theme} selected={finding} pressed={finding} onPress={() => (finding ? closeFind() : openFind())} />
    </View>
  );

  // ---- The world ----
  const color = (tone: "accent" | "muted" | "warning") => (tone === "accent" ? theme.colors.accent : tone === "warning" ? theme.colors.statusWarning : theme.colors.foregroundMuted);
  // The graph's views are made only when it is shown; the full model is computed in every mode (the
  // List and Find read its nodes), and the collapsed one only for the graph.
  const renderWorld = () => {
  const annotation = (key: string, x: number, y: number, text: string, tone: string) => (
    <Text
      key={key}
      numberOfLines={1}
      style={{ position: "absolute", left: x, top: y, maxWidth: 170, paddingHorizontal: 3, fontSize: 11, lineHeight: 14, color: tone, backgroundColor: theme.colors.surface0, borderRadius: 3 }}
    >
      {text}
    </Text>
  );
  const edgeViews = model.edges.flatMap((e) => {
    const touches = drawn !== undefined && (e.from === drawn.key || e.to === drawn.key);
    const parts = edgeParts(e, color, drawn === undefined || touches ? 1 : 0.25);
    const mid = e.segments[Math.floor(e.segments.length / 2)];
    if (e.crossLane && mid !== undefined) parts.push(annotation(`${e.key}#glyph`, (mid.x1 + mid.x2) / 2 - 6, (mid.y1 + mid.y2) / 2 - 8, KIND_GLYPH[e.kind], color(KIND_LINE[e.kind].tone)));
    return parts;
  });
  // The selected node's condition labels, in the rows their lanes grew to hold (placeConditions).
  const conditionViews = conditionLabels.labels.map((c) => (
    <Text
      key={`${c.key}#when`}
      numberOfLines={1}
      style={{
        position: "absolute",
        left: c.x,
        top: model.lanes.find((l) => l.key === c.lane)!.trackY + 1 + c.row * LABEL_ROW,
        width: c.width,
        lineHeight: 14,
        paddingHorizontal: 3,
        fontSize: 11,
        color: theme.colors.foreground,
        backgroundColor: theme.colors.surface0,
        borderRadius: 3,
      }}
    >
      {c.text}
    </Text>
  ));
  const nodeViews = model.nodes.map((n) => {
    if (n.port !== undefined) {
      const lane = n.port.lane;
      const portStyle = {
        position: "absolute" as const,
        left: n.x,
        top: n.y,
        width: n.width,
        height: n.height,
        paddingHorizontal: 8,
        justifyContent: "center" as const,
        borderRadius: 6,
        borderWidth: 1,
        borderStyle: "dashed" as const,
        borderColor: theme.colors.foregroundMuted,
        backgroundColor: theme.colors.surface2,
      };
      const text = <Text style={{ fontSize: 12, color: theme.colors.foreground }}>{n.label}</Text>;
      return overview ? (
        <View key={n.key} accessibilityLabel={n.label} style={portStyle}>
          {text}
        </View>
      ) : (
        // React Native Web drops accessibilityHint: the port is described by the visible collapse note.
        <Pressable
          key={n.key}
          accessibilityRole="button"
          accessibilityLabel={n.label}
          accessibilityHint="Expands this lane"
          {...webAria({ "aria-describedby": portHintId })}
          onPress={() => setLaneCollapsed(lane, false)}
          style={portStyle}
        >
          {text}
        </Pressable>
      );
    }
    const qv = nodeQuestion(view, n);
    const isSelected = n.key === selected;
    const dim = drawn !== undefined && !isSelected && !neighbours.has(n.key) ? 0.5 : 1;
    const cancelled = qv !== undefined && (view.cancellations ?? []).some((c) => c.ref.sessionId === view.session.id && c.ref.questionId === qv.question.id);
    const style = {
      position: "absolute" as const,
      left: n.x,
      top: n.y,
      width: n.width,
      height: n.height,
      paddingHorizontal: 8,
      paddingVertical: 6,
      borderRadius: 6,
      borderWidth: isSelected ? 2 : 1,
      borderStyle: n.inactive === true || n.ref !== undefined ? ("dashed" as const) : ("solid" as const),
      borderColor: isSelected ? theme.colors.accent : theme.colors.border,
      backgroundColor: theme.colors.surface1,
      opacity: dim,
      justifyContent: "space-between" as const,
    };
    const title = qv !== undefined ? qv.question.title : n.ref?.questionId !== undefined ? (view.catalog.find((c) => c.ref.sessionId === n.ref!.sessionId && c.ref.questionId === n.ref!.questionId)?.questionTitle ?? n.label) : n.label;
    const meta =
      qv !== undefined
        ? `Q${qv.number} · ${statusText(qv, n)}`
        : n.missing === true
          ? "external · missing"
          : `${n.ref?.questionId !== undefined ? (view.catalog.find((c) => c.ref.sessionId === n.ref!.sessionId)?.sessionTitle ?? n.ref.sessionId) : "session"} · external`;
    const content = (
      <>
        <Text
          numberOfLines={2}
          style={{
            fontSize: 12,
            lineHeight: 15,
            color: theme.colors.foreground,
            fontWeight: neighbours.has(n.key) || isSelected ? "700" : "400",
            ...(cancelled ? { textDecorationLine: "line-through" as const } : {}),
          }}
        >
          {title}
        </Text>
        <Text numberOfLines={1} style={{ fontSize: 11, color: theme.colors.foregroundMuted }}>
          {meta}
        </Text>
      </>
    );
    const label = nodeLabel(view, full, n);
    if (overview || n.missing === true) {
      return (
        <View key={n.key} ref={refFor(n.key)} accessibilityLabel={label} style={style}>
          {content}
        </View>
      );
    }
    return (
      <Pressable key={n.key} ref={refFor(n.key)} accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ selected: isSelected }} aria-pressed={isSelected} onPress={() => select(isSelected ? null : n.key)} style={style}>
        {content}
      </Pressable>
    );
  });
  const laneViews = model.lanes.map((lane, i) => (
    <View
      key={lane.key}
      style={{ position: "absolute", left: 0, top: lane.y, width: model.world.width, height: lane.height, backgroundColor: i % 2 === 0 ? theme.colors.surface0 : theme.colors.surface1, borderRadius: 6 }}
    >
      <View style={{ position: "absolute", left: 8, top: 10, width: 134, gap: 4 }}>
        {collapseMode && !overview && lane.key !== LEGACY_LANE ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${lane.label}${lane.collapsed === true ? ", collapsed" : ""}`}
            accessibilityState={{ expanded: lane.collapsed !== true }}
            aria-expanded={lane.collapsed !== true}
            accessibilityHint={lane.collapsed === true ? "Expands this lane" : "Collapses this lane"}
            onPress={() => setLaneCollapsed(lane.key, lane.collapsed !== true)}
            // A 44 px target on screen: the world is scaled, and headers are pressable from 75 %.
            style={{ minHeight: TARGET_SIZE / Math.min(1, scale), justifyContent: "center" }}
          >
            <Text style={{ fontSize: 12, fontWeight: "600", color: theme.colors.foreground }}>{`${lane.collapsed === true ? "▸" : "▾"} ${lane.label}`}</Text>
          </Pressable>
        ) : (
          <Text style={{ fontSize: 12, fontWeight: "600", color: theme.colors.foreground }}>{lane.label}</Text>
        )}
        {(lane.notes ?? []).map((note) => (
          <Text key={note} style={{ fontSize: 11, color: theme.colors.foregroundMuted }}>
            {note}
          </Text>
        ))}
      </View>
    </View>
  ));
  const scaledWorld = (
    // In the overview the world takes no touches, so a press reaches the wrapper with coordinates in
    // the wrapper's frame (not a node's) and zooms in on that point.
    <View
      pointerEvents={overview ? "none" : "auto"}
      style={{
        position: "absolute",
        left: 0,
        top: 0,
        width: model.world.width,
        height: model.world.height,
        transform: [{ scale }],
        transformOrigin: "top left",
      }}
    >
      {laneViews}
      {edgeViews}
      {nodeViews}
      {conditionViews}
    </View>
  );
  const wrapperSize = { width: model.world.width * scale, height: model.world.height * scale };
  const world = (
    // Its own key: the List's scroll region is another element, so the List starts at its top.
    <ScrollView
      key="map-graph"
      ref={vScroll}
      style={{ flex: 1, minHeight: 0 }}
      onLayout={(e: { nativeEvent: { layout: { width: number; height: number } } }) => setViewport({ width: e.nativeEvent.layout.width, height: e.nativeEvent.layout.height })}
      onScroll={onScrollOf("y")}
      scrollEventThrottle={1}
      // Both bubble from the horizontal scroll view inside. React Native Web passes onWheel on, though
      // React Native's types do not list it.
      {...wheelProp}
      onTouchMove={userPanned}
    >
      <NativeScrollView ref={hScroll} horizontal nestedScrollEnabled onScroll={onScrollOf("x")} scrollEventThrottle={1}>
        {overview ? (
          <Pressable
            ref={overviewRef}
            accessible={false}
            accessibilityLabel="Zoom in here"
            onPress={(e) => {
              // Read now: the scale and the event's coordinates as they were at the press.
              const s = scale;
              const { locationX, locationY, pageX, pageY } = e.nativeEvent as { locationX?: number; locationY?: number; pageX?: number; pageY?: number };
              const zoomAt = (x: number, y: number) => {
                toOrigin.current = false;
                centreTarget.current = { x: x / s, y: y / s };
                setZoom(1);
                setCentreRequest((r) => r + 1);
                props.onReveal?.();
              };
              // Native reports the point relative to the wrapper, which takes the touch because the
              // world takes none. React Native Web may leave locationX/Y undefined and give only page
              // coordinates: the wrapper's measured page position turns them into wrapper ones, which
              // also holds when the map is scrolled. 0 is a valid coordinate.
              if (Number.isFinite(locationX) && Number.isFinite(locationY)) {
                zoomAt(locationX!, locationY!);
                return;
              }
              if (!Number.isFinite(pageX) || !Number.isFinite(pageY)) return;
              overviewRef.current?.measure((_x, _y, _w, _h, left, top) => {
                if (Number.isFinite(left) && Number.isFinite(top)) zoomAt(pageX! - left, pageY! - top);
              });
            }}
            style={wrapperSize}
          >
            {scaledWorld}
          </Pressable>
        ) : (
          <View style={wrapperSize}>{scaledWorld}</View>
        )}
      </NativeScrollView>
    </ScrollView>
  );

    return world;
  };

  // ---- Detail panel ----
  const endText = (n: MapNode | undefined) => {
    if (n === undefined) return "";
    const qv = nodeQuestion(view, n);
    return qv !== undefined ? `Q${qv.number} ${qv.question.title}` : n.label;
  };
  const openEnd = (n: MapNode): (() => void) | undefined => {
    if (n.questionId !== undefined) return () => select(n.key);
    if (n.missing === true || n.ref === undefined) return undefined;
    const ref = n.ref;
    if (ref.questionId !== undefined) return props.onOpenRef !== undefined ? () => props.onOpenRef!({ sessionId: ref.sessionId, questionId: ref.questionId! }) : undefined;
    return props.onOpenSession !== undefined ? () => props.onOpenSession!(ref.sessionId) : undefined;
  };
  const relationRow = (e: MapEdge, incoming: boolean) => {
    const other = full.nodes.find((n) => n.key === (incoming ? e.from : e.to));
    if (other === undefined) return null;
    const conditionOwner = e.kind === "activation" ? full.nodes.find((n) => n.key === e.from) : undefined;
    // A self-link is listed once, under "Leads to", as what the question does to itself.
    const text =
      e.from === e.to
        ? `${endText(other)} · ${e.kind === "informs" ? "informs itself" : e.kind === "supersedes" ? "supersedes itself" : kindWording(e.kind, incoming, "")}`
        : `${endText(other)} · ${kindWording(e.kind, incoming, optionLabels(view, conditionOwner, e.optionIds))}${e.back ? " (back link)" : ""}`;
    const press = openEnd(other);
    if (press === undefined) {
      return (
        <Text key={`${e.key}|${incoming ? "in" : "out"}`} style={{ fontSize: 13, color: theme.colors.foregroundMuted, paddingVertical: 6 }}>
          {text}
        </Text>
      );
    }
    return (
      <Pressable
        key={`${e.key}|${incoming ? "in" : "out"}`}
        accessibilityRole={other.questionId !== undefined ? "button" : "link"}
        accessibilityLabel={text}
        onPress={press}
        style={{ minHeight: TARGET_SIZE, justifyContent: "center" }}
      >
        <Text style={{ fontSize: 13, color: theme.colors.statusSuccess }}>{text}</Text>
      </Pressable>
    );
  };
  const detail =
    node !== undefined ? (
      (() => {
        const qv = nodeQuestion(view, node);
        const answer = qv !== undefined ? currentAnswer(qv.question) : undefined;
        // A skipped or out-of-scope question is settled, not waiting (its status is the line above): as
        // on its card, an earlier answer is kept as history.
        const settled = qv !== undefined && (qv.status === "skipped" || qv.status === "out_of_scope");
        const answerText = settled
          ? qv.question.answer !== undefined
            ? "The earlier answer is kept as history."
            : "No answer was given."
          : answer === undefined
            ? "No answer yet."
            : answer.text !== undefined
              ? `Answer: ${answer.text}`
              : `Answer: ${qv!.question.options.find((o) => o.id === answer.optionId)?.label ?? answer.optionId}`;
        const incoming = full.edges.filter((e) => e.to === node.key && e.from !== node.key);
        const outgoing = full.edges.filter((e) => e.from === node.key);
        return (
          <View style={{ gap: 6, minWidth: 0 }}>
            <Text style={{ fontSize: 14, fontWeight: "600", color: theme.colors.foreground }}>{endText(node)}</Text>
            {qv !== undefined ? (
              <>
                <Text style={{ fontSize: 12, color: theme.colors.foregroundMuted }}>{`${statusText(qv, node)} · ${laneName(full, node)}`}</Text>
                <Text style={{ fontSize: 13, color: theme.colors.foreground }}>{answerText}</Text>
              </>
            ) : (
              <Text style={{ fontSize: 12, color: theme.colors.foregroundMuted }}>Another session. Relations among other sessions are not shown here.</Text>
            )}
            <Text style={{ fontSize: 13, fontWeight: "600", color: theme.colors.foreground, marginTop: 4 }}>Comes after</Text>
            {incoming.length === 0 ? <Text style={{ fontSize: 13, color: theme.colors.foregroundMuted }}>Nothing</Text> : incoming.map((e) => relationRow(e, true))}
            <Text style={{ fontSize: 13, fontWeight: "600", color: theme.colors.foreground, marginTop: 4 }}>Leads to</Text>
            {outgoing.length === 0 ? <Text style={{ fontSize: 13, color: theme.colors.foregroundMuted }}>Nothing</Text> : outgoing.map((e) => relationRow(e, false))}
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 4 }}>
              {qv !== undefined ? <ActionButton label={`Open Q${qv.number} in Grilling`} theme={theme} primary onPress={() => props.onOpenQuestion(qv.question.id)} /> : null}
              {qv === undefined && openEnd(node) !== undefined ? <ActionButton label="Open its session" theme={theme} onPress={openEnd(node)!} /> : null}
              <ActionButton label="Close" theme={theme} onPress={dismissDetail} />
            </View>
          </View>
        );
      })()
    ) : null;

  // ---- Find question: every node, filterable ----
  const wanted = filter.trim().toLowerCase();
  const found = finding ? full.nodes.filter((n) => n.missing !== true && (wanted === "" || endText(n).toLowerCase().includes(wanted))) : [];
  const renderPicker = () => {
    return (
      <View style={{ gap: 6, minWidth: 0 }}>
        <Text style={{ fontSize: 14, fontWeight: "600", color: theme.colors.foreground }}>Find question</Text>
        <TextInput
          ref={filterRef}
          accessibilityLabel="Filter questions"
          // React Native Web's TextInput stops keydown and reports keys only here, so the sheet's scope
          // never sees them: Escape closes the sheet, and Shift+Tab from the filter (its first control)
          // wraps to the last question. With no question found, the compact sheet holds only the filter,
          // so Tab and Shift+Tab stay on it (the host's sheet keeps no Tab order, and the browser's own
          // move would leave the sheet). Native reports no Tab here.
          onKeyPress={(e: { nativeEvent: { key: string; shiftKey?: boolean }; preventDefault?(): void }) => {
            if (e.nativeEvent.key === "Escape") closeFind();
            else if (e.nativeEvent.key === "Tab" && found.length === 0) {
              if (compact) e.preventDefault?.();
            } else if (e.nativeEvent.key === "Tab" && e.nativeEvent.shiftKey === true) {
              const last = findLastRef.current !== null ? findLastRef : findFirstRef;
              if (last.current === null) return;
              e.preventDefault?.();
              moveFocus(last);
            }
          }}
          placeholder="Filter by number or title"
          placeholderTextColor={theme.colors.foregroundMuted}
          value={filter}
          onChangeText={setFilter}
          style={[inputStyle(theme), { minHeight: TARGET_SIZE }]}
        />
        {found.map((n, i, list) => (
          <Pressable
            key={n.key}
            {...(i === 0 ? { ref: findFirstRef } : i === list.length - 1 ? { ref: findLastRef } : {})}
            accessibilityRole="button"
            accessibilityLabel={`Find ${endText(n)}`}
            onPress={() => {
              setFinding(false);
              setMode("graph");
              if (overview) setZoom(1);
              pickedFocus(n.key);
              select(n.key);
            }}
            style={{ minHeight: TARGET_SIZE, justifyContent: "center" }}
          >
            <Text numberOfLines={1} style={{ color: theme.colors.foreground }}>
              {endText(n)}
            </Text>
          </Pressable>
        ))}
      </View>
    );
  };

  // ---- List: every relation of every question, with kind and direction ----
  const renderList = () => (
    <ScrollView key="map-list" style={{ flex: 1, minHeight: 0 }} contentContainerStyle={{ gap: 10, paddingBottom: 24 }}>
      {full.nodes
        .filter((n) => n.questionId !== undefined)
        .map((n) => {
          const qv = nodeQuestion(view, n)!;
          return (
            <View key={n.key} style={{ gap: 2, paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: theme.colors.border }}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Show ${endText(n)} on the map`}
                onPress={() => {
                  // A pick shows the question's detail where Find question's picker stands (wide), so it
                  // closes Find; focus goes to the picked node, not back to Find question.
                  setFinding(false);
                  setMode("graph");
                  pickedFocus(n.key);
                  select(n.key);
                }}
                style={{ minHeight: TARGET_SIZE, justifyContent: "center" }}
              >
                <Text style={{ fontWeight: "600", color: theme.colors.foreground }}>{`${endText(n)} · ${statusText(qv, n)} · ${laneName(full, n)}`}</Text>
              </Pressable>
              {relationLinks(view, qv.question.id).map((l) => (
                <Text key={l.key} style={{ fontSize: 13, color: theme.colors.foregroundMuted, paddingLeft: 12 }}>
                  {l.label}
                </Text>
              ))}
            </View>
          );
        })}
    </ScrollView>
  );

  const side = finding ? renderPicker() : mode === "graph" ? detail : null;
  const main = mode === "list" ? renderList() : renderWorld();
  return (
    <View style={{ flex: 1, minHeight: 0, gap: 8, minWidth: 0 }} {...escape}>
      {toolbar}
      {full.nodes.length > LIST_FIRST ? <Text style={{ color: theme.colors.statusWarning }}>{`This map has ${full.nodes.length} nodes: it opens on the List; the graph stays behind Graph.`}</Text> : null}
      {mode === "graph" && overview ? <Text style={{ color: theme.colors.foregroundMuted }}>Overview: zoom in, or use List or Find question to select a question.</Text> : null}
      {mode === "graph" && node !== undefined ? (
        <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
          <Text style={{ color: theme.colors.foregroundMuted }}>{`Showing ${endText(node)} and its neighbours`}</Text>
          <ActionButton label="Clear" theme={theme} onPress={dismissDetail} />
        </View>
      ) : null}
      {mode === "graph" && !overview && model.nodes.some((n) => n.port !== undefined) ? (
        <Text nativeID={portHintId} style={{ fontSize: 12, color: theme.colors.foregroundMuted }}>
          Collapsed lanes show a header and a port (→ Block n); press either to expand the lane.
        </Text>
      ) : null}
      {model.notes.map((note) => (
        <Text key={note} style={{ fontSize: 12, color: theme.colors.foregroundMuted }}>
          {note}
        </Text>
      ))}
      {compact ? (
        <>
          {main}
          {side !== null ? (
            <Modal title={finding ? "Find question" : "Question"} open onOpenChange={(open) => !open && (finding ? closeFind() : dismissDetail())}>
              <Modal.Content>
                {/* The host's compact sheet portals its content and keeps no focus: the scope handles
                    Escape and Tab inside it, and moves focus into the question's detail. */}
                <FocusScope key={finding ? "find" : `detail:${selected ?? ""}`} label={finding ? "Find question" : "Question detail"} onEscape={finding ? closeFind : dismissDetail} focusOnMount={finding ? (found.length > 0 ? findFirstRef : filterRef) : true}>
                  {side}
                </FocusScope>
              </Modal.Content>
            </Modal>
          ) : null}
        </>
      ) : (
        <View style={{ flex: 1, minHeight: 0, flexDirection: "row", gap: 12, minWidth: 0 }}>
          <View style={{ flex: 1, minHeight: 0, minWidth: 0 }}>{main}</View>
          {side !== null ? (
            <ScrollView style={{ width: DETAIL_WIDTH, flexGrow: 0, minHeight: 0 }} contentContainerStyle={{ padding: 12, gap: 6, borderWidth: 1, borderColor: theme.colors.border, borderRadius: 8 }}>
              {side}
            </ScrollView>
          ) : null}
        </View>
      )}
    </View>
  );
}

/** One edge as positioned Views: its segments in the kind's line style and a chevron at the target. */
function edgeParts(e: MapEdge, color: (tone: "accent" | "muted" | "warning") => string, opacity: number) {
  const line = KIND_LINE[e.kind];
  const c = color(line.tone);
  const parts = e.segments.map((s, i) => {
    const horizontal = s.y1 === s.y2;
    const style = horizontal
      ? { left: Math.min(s.x1, s.x2), top: s.y1 - 1, width: Math.abs(s.x2 - s.x1), height: 0, borderTopWidth: 2, borderTopColor: c }
      : { left: s.x1 - 1, top: Math.min(s.y1, s.y2), width: 0, height: Math.abs(s.y2 - s.y1), borderLeftWidth: 2, borderLeftColor: c };
    return <View key={`${e.key}#${i}`} style={{ position: "absolute", ...style, borderStyle: line.style, opacity }} />;
  });
  // The chevron points along the final segment: rightwards into a forward edge's target, leftwards for a back edge.
  const last = e.segments.at(-1);
  if (last !== undefined) {
    const dir = last.x2 >= last.x1 ? 1 : -1;
    const bar = (dy: number, angle: number, k: string) => (
      <View
        key={`${e.key}#${k}`}
        style={{ position: "absolute", left: last.x2 - dir * 2.5 - 3.5, top: last.y2 + dy - 1, width: 7, height: 2, backgroundColor: c, opacity, transform: [{ rotate: `${angle}deg` }] }}
      />
    );
    parts.push(bar(-2.5, dir * 45, "up"), bar(2.5, -dir * 45, "down"));
  }
  return parts;
}
