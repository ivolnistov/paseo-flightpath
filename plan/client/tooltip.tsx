// A plugin-owned tooltip: neither the plugin SDK nor the host offers one. It shows a control's hint
// on hover (web), keyboard focus and long press (touch), and hides it on hover out, blur, release,
// Escape and a press on any control with a tooltip (on web, a press anywhere). The focus a tap or a
// click leaves on the web is not keyboard focus and shows nothing. Only one shows at a time. The hint
// is also the control's accessibility hint, so it is never the only carrier of the text. The bubble
// wraps at up to 240 px whatever the control's width, and is drawn in a tooltip layer over the panel
// or sheet (see "The layer" below), so content drawn later does not paint over it; it is out of flow,
// so showing it never changes the control's size.
// Placement uses a bounding rectangle: of the registered clipping regions whose frame overlaps the
// control, the one with the smallest measured area (equal areas: the earlier registered), else the
// window. The tooltip opens below and flips above when that rectangle leaves less than about two
// short lines below the control and more room above; its height is not limited to the rectangle.
// It shifts left so its right edge stays inside the rectangle, never past the rectangle's left edge,
// so a rectangle narrower than its 240 px maximum width can still leave its right edge outside.
import type { PluginTheme } from "@getpaseo/plugin";
import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { Dimensions, Text, View, type GestureResponderEvent } from "react-native";

/** The handlers the wrapped control passes to its Pressable. */
export type TooltipHandlers = {
  onHoverIn(): void;
  onHoverOut(): void;
  onFocus(e?: unknown): void;
  onBlur(): void;
  onLongPress(e?: GestureResponderEvent): void;
  onPressIn(e?: unknown): void;
  onPressOut(): void;
  onKeyDown(e: { key?: string; nativeEvent?: { key?: string } }): void;
};

const GAP = 4;
const MAX_WIDTH = 240;
/** Room the tooltip needs below the control before it flips above (two short lines). */
const ROOM = 56;

/**
 * The one tooltip shown at a time. Showing a tooltip hides the previous one, and a press starting on
 * any control that has a tooltip hides it; a long press then shows that control's own.
 */
let active: { hide(): void } | null = null;
const dismissActive = () => {
  const shown = active;
  active = null;
  shown?.hide();
};

/** Web only, detected rather than assumed: the document, for a press anywhere outside a control. */
type PressTarget = { addEventListener(type: string, fn: () => void, capture: boolean): void; removeEventListener(type: string, fn: () => void, capture: boolean): void };
const isPressTarget = (v: unknown): v is PressTarget =>
  typeof v === "object" && v !== null && typeof Reflect.get(v, "addEventListener") === "function" && typeof Reflect.get(v, "removeEventListener") === "function";
function pressTarget(): PressTarget | null {
  const doc: unknown = Reflect.get(globalThis, "document");
  return isPressTarget(doc) ? doc : null;
}

type Rect = { x: number; y: number; width: number; height: number };

/**
 * Whether a focus event comes from a pointer rather than the keyboard. On the web a tap (and a mouse
 * click) on a button is followed by the browser focusing it; that focus is not `:focus-visible`, while
 * keyboard focus is. Where the node cannot answer (native, an older browser), the press that came just
 * before decides: a touch press leaves a pointer focus.
 */
function pointerFocus(e: unknown, afterTouch: boolean): boolean {
  const native: unknown = typeof e === "object" && e !== null ? Reflect.get(e, "nativeEvent") : undefined;
  const fromNative: unknown = typeof native === "object" && native !== null ? Reflect.get(native, "target") : undefined;
  const target: unknown = fromNative ?? (typeof e === "object" && e !== null ? Reflect.get(e, "target") : undefined);
  const matches: unknown = typeof target === "object" && target !== null ? Reflect.get(target, "matches") : undefined;
  if (typeof matches === "function") {
    try {
      return Reflect.apply(matches, target, [":focus-visible"]) !== true;
    } catch {
      // A browser without :focus-visible: fall back to the press.
    }
  }
  return afterTouch;
}

/** Whether a press event comes from a touch (RN Web's pointer events, or touches on native). */
function touchPress(e: unknown): boolean {
  const native: unknown = typeof e === "object" && e !== null ? Reflect.get(e, "nativeEvent") : undefined;
  if (typeof native !== "object" || native === null) return false;
  return Reflect.get(native, "pointerType") === "touch";
}

/**
 * Regions that clip their content: a tooltip of a control overlapping one is placed against its
 * bounds, as the module header describes, not only against the window. A screen registers the clipping
 * view itself (its scroll view), whose measured rectangle is the visible frame; a wrapper around it
 * would report larger bounds.
 */
const boundaries = new Set<{ readonly current: unknown }>();
export function registerTooltipBoundary(ref: { readonly current: unknown }): () => void {
  boundaries.add(ref);
  return () => void boundaries.delete(ref);
}

/** A view's rectangle in the window, where the platform can measure it (a view or a scroll view). */
function measure(node: unknown): Promise<Rect | null> {
  return new Promise((resolve) => {
    const fn: unknown = typeof node === "object" && node !== null ? Reflect.get(node, "measureInWindow") : undefined;
    if (typeof fn !== "function") return resolve(null);
    Reflect.apply(fn, node, [(x: number, y: number, width: number, height: number) => resolve({ x, y, width, height })]);
  });
}

/** Whether two rectangles share some area. */
const overlaps = (a: Rect, b: Rect): boolean => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

/**
 * Below the control unless the room below inside `bounds` is too small and the room above is larger;
 * shifted left so its right edge stays inside `bounds`, never past their left edge.
 */
function placement(control: Rect, bounds: Rect): { above: boolean; left: number } {
  const below = bounds.y + bounds.height - (control.y + control.height);
  const aboveRoom = control.y - bounds.y;
  const above = below < GAP + ROOM && aboveRoom > below;
  const overflow = control.x + MAX_WIDTH - (bounds.x + bounds.width);
  return { above, left: overflow > 0 ? -Math.min(overflow, Math.max(0, control.x - bounds.x)) : 0 };
}

/**
 * The window size, kept current: re-renders when the platform reports a change (a resize, a
 * rotation). Detected: where there is no change listener it is read at each render, as before.
 */
export function useWindowSize(): { width: number; height: number } | null {
  const [, setTick] = useState(0);
  useEffect(() => {
    let add: unknown;
    try {
      add = Reflect.get(Dimensions, "addEventListener");
    } catch {
      return undefined;
    }
    if (typeof add !== "function") return undefined;
    const sub: unknown = Reflect.apply(add, Dimensions, ["change", () => setTick((t) => t + 1)]);
    const remove: unknown = typeof sub === "object" && sub !== null ? Reflect.get(sub, "remove") : undefined;
    return () => {
      if (typeof remove === "function") Reflect.apply(remove, sub, []);
    };
  }, []);
  return windowSize();
}

/** The window size, when the platform reports one. */
export function windowSize(): { width: number; height: number } | null {
  try {
    const w = Dimensions.get("window");
    return { width: w.width, height: w.height };
  } catch {
    return null;
  }
}

// ---- The layer ----
// A shown bubble is drawn in a tooltip layer, not beside its control: React Native Web makes every
// View a stacking context, so a bubble inside the control's own branch is painted under content drawn
// later in other branches (the next rows, the cards under a block header). A layer is an absolutely
// positioned, full-size View rendered last in its container, which takes no touches itself
// (`box-none`) and holds at most one bubble, which takes none either (`none`). It is neither a dialog
// nor in the focus order. The panel has one; each plugin sheet has its own (a host sheet portals its
// content above the panel). A bubble goes to the latest-registered layer whose measured frame holds
// the control's centre (a hidden panel or tab measures empty); when the control cannot be measured, to
// the latest layer; with no layer that fits, it stays beside its control, as before.

type Bubble = {
  owner: object;
  hint: string;
  theme: PluginTheme;
  left: number;
  top?: number;
  bottom?: number;
  /** The control's top and bottom and the layer's height, in the layer: for the check once drawn. */
  anchor?: { top: number; bottom: number; height: number };
  /** Set once the drawn height has been checked against the layer. */
  checked?: boolean;
};

/** The shared part of two rectangles, or null when they do not overlap. */
function intersection(a: Rect, b: Rect): Rect | null {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  return right > x && bottom > y ? { x, y, width: right - x, height: bottom - y } : null;
}

/**
 * The bubble kept inside its layer once its height is known (a long hint wraps to several lines):
 * on the side it was placed when it fits, else on the other side when that fits, else clamped into
 * the layer (it may then cover its control).
 */
function keptInside(b: Bubble, height: number): Bubble {
  const a = b.anchor;
  if (a === undefined) return { ...b, checked: true };
  const belowTop = a.bottom + GAP;
  const aboveTop = a.top - GAP - height;
  const fitsBelow = belowTop + height <= a.height;
  const fitsAbove = aboveTop >= 0;
  const below = b.bottom === undefined;
  const { top: _t, bottom: _b, ...rest } = b;
  if (below ? fitsBelow : fitsAbove) return { ...b, checked: true };
  if (below && fitsAbove) return { ...rest, bottom: a.height - (a.top - GAP), checked: true };
  if (!below && fitsBelow) return { ...rest, top: belowTop, checked: true };
  return { ...rest, top: Math.max(0, Math.min(below ? belowTop : aboveTop, a.height - height)), checked: true };
}
type Layer = { ref: RefObject<View | null>; set(b: Bubble | null): void; owner(): object | null };
const layers: Layer[] = [];

/** The point inside a rectangle. */
const holds = (r: Rect, x: number, y: number) => x >= r.x && x <= r.x + r.width && y >= r.y && y <= r.y + r.height;

async function layerFor(control: Rect | null): Promise<{ layer: Layer; frame: Rect | null } | null> {
  const live = [...layers].reverse();
  if (live.length === 0) return null;
  if (control === null) return { layer: live[0], frame: null };
  const cx = control.x + control.width / 2;
  const cy = control.y + control.height / 2;
  for (const layer of live) {
    const frame = await measure(layer.ref.current);
    if (frame !== null && frame.width > 0 && frame.height > 0 && holds(frame, cx, cy)) return { layer, frame };
  }
  return null;
}

/** A tooltip layer: render it as the last child of a container that fills the panel or a sheet. */
export function TooltipLayer() {
  const ref = useRef<View | null>(null);
  const [bubble, setBubble] = useState<Bubble | null>(null);
  const current = useRef<Bubble | null>(null);
  const self = useRef<Layer | null>(null);
  // The drawn height of the shown bubble, by its owner and hint: a placement again (a scroll) is kept
  // inside at once, since a move alone may not report a new layout.
  const drawn = useRef<{ owner: object; hint: string; height: number } | null>(null);
  self.current ??= {
    ref,
    set: (b) => {
      const h = drawn.current;
      const next = b !== null && b.checked !== true && h !== null && h.owner === b.owner && h.hint === b.hint ? keptInside(b, h.height) : b;
      if (next === null || (h !== null && h.owner !== next.owner)) drawn.current = null;
      current.current = next;
      setBubble(next);
    },
    owner: () => current.current?.owner ?? null,
  };
  useEffect(() => {
    const layer = self.current!;
    if (!layers.includes(layer)) layers.push(layer);
    return () => {
      const i = layers.indexOf(layer);
      if (i !== -1) layers.splice(i, 1);
    };
  }, []);
  return (
    <View
      ref={ref}
      pointerEvents="box-none"
      // A change of the container's size moves the controls: the shown bubble would be left behind.
      onLayout={() => {
        if (current.current !== null) dismissActive();
      }}
      style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, zIndex: 1000 }}
    >
      {bubble !== null ? (
        <View
          pointerEvents="none"
          // Once drawn, its height decides whether it still fits on its side of the control.
          onLayout={(e: { nativeEvent: { layout: { height: number } } }) => {
            const b = current.current;
            if (b === null || b.owner !== bubble.owner) return;
            drawn.current = { owner: b.owner, hint: b.hint, height: e.nativeEvent.layout.height };
            if (b.checked !== true) self.current!.set(keptInside(b, e.nativeEvent.layout.height));
          }}
          style={{
            position: "absolute",
            left: bubble.left,
            ...(bubble.bottom !== undefined ? { bottom: bubble.bottom } : { top: bubble.top ?? 0 }),
            width: MAX_WIDTH,
            alignItems: "flex-start",
          }}
        >
          <BubbleBox hint={bubble.hint} theme={bubble.theme} />
        </View>
      ) : null}
    </View>
  );
}

function BubbleBox(props: { hint: string; theme: PluginTheme }) {
  const { theme } = props;
  return (
    <View
      style={{
        maxWidth: MAX_WIDTH,
        paddingVertical: 4,
        paddingHorizontal: 8,
        borderRadius: 6,
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface2,
      }}
    >
      <Text style={{ color: theme.colors.foreground, fontSize: 12 }}>{props.hint}</Text>
    </View>
  );
}

export function Tooltip(props: { hint: string; theme: PluginTheme; children(handlers: TooltipHandlers, ref: RefObject<View | null>): ReactNode }) {
  const { hint, theme } = props;
  // Shown, and where: "pending" while measuring, "layer" in a tooltip layer, "inline" beside the control.
  const [shown, setShown] = useState<false | "pending" | "layer" | "inline">(false);
  const [inlinePlace, setPlace] = useState<{ above: boolean; left: number }>({ above: false, left: 0 });
  const anchor = useRef<View | null>(null);
  // A touch press on this control: the browser's focus that follows it shows no tooltip.
  const touched = useRef(false);
  // Each show has a number, so a measurement that answers after a hide (or a newer show) does nothing.
  const showing = useRef(0);
  const placedIn = useRef<Layer | null>(null);
  // The clipping region the control was in when its tooltip showed (null: none).
  const regionAtShow = useRef<{ readonly current: unknown } | null>(null);

  const entry = useRef<{ hide(): void } | null>(null);
  const clear = () => {
    showing.current += 1;
    const layer = placedIn.current;
    placedIn.current = null;
    if (layer !== null && layer.owner() === entry.current) layer.set(null);
    setShown(false);
  };
  const hide = () => {
    clear();
    if (active === entry.current) active = null;
  };
  entry.current ??= { hide: () => clear() };

  // On web, while this tooltip shows, a press anywhere hides it, and a scroll anywhere (captured: scroll
  // events do not bubble) places it again, at most once a frame, since a bubble in a layer does not move
  // with its control (keyboard focus scrolls a control into view, so hiding would lose it). Nothing is
  // registered on native, where a tooltip shows only during a long press.
  useEffect(() => {
    const target = shown !== false ? pressTarget() : null;
    if (target === null) return undefined;
    const onDown = () => dismissActive();
    let queued = false;
    const onScroll = () => {
      if (queued) return;
      queued = true;
      setTimeout(() => {
        queued = false;
        if (active === entry.current) void place(showing.current, true);
      }, 16);
    };
    target.addEventListener("pointerdown", onDown, true);
    target.addEventListener("scroll", onScroll, true);
    return () => {
      target.removeEventListener("pointerdown", onDown, true);
      target.removeEventListener("scroll", onScroll, true);
    };
  }, [shown]);
  // A window size change moves the controls too: place it again.
  useEffect(() => {
    if (shown === false) return undefined;
    // Detected: a platform (or test double) without the listener just does not re-place on a resize.
    const add: unknown = Reflect.get(Dimensions, "addEventListener");
    if (typeof add !== "function") return undefined;
    const sub: unknown = Reflect.apply(add, Dimensions, [
      "change",
      () => {
        if (active === entry.current) void place(showing.current, true);
      },
    ]);
    const remove: unknown = typeof sub === "object" && sub !== null ? Reflect.get(sub, "remove") : undefined;
    return () => {
      if (typeof remove === "function") Reflect.apply(remove, sub, []);
    };
  }, [shown]);
  // Unmounting while shown leaves no stale entry or bubble behind.
  useEffect(
    () => () => {
      const layer = placedIn.current;
      if (layer !== null && layer.owner() === entry.current) layer.set(null);
      if (active === entry.current) active = null;
    },
    [],
  );

  /**
   * Measured where the platform supports it. Placed against the clipping region the control overlaps
   * (see below), else against the window; then drawn in the layer that holds the control, or beside
   * the control when none does. `seq` is the show it belongs to.
   */
  const place = async (seq: number, again = false) => {
    const control = await measure(anchor.current);
    let where: { above: boolean; left: number } = { above: false, left: 0 };
    // Placed again (a scroll or a resize) after showing inside a clipping region: a control that has
    // left that region is no longer visible there, so its tooltip hides rather than being drawn over
    // whatever is outside the region (the layer does not clip).
    if (again && regionAtShow.current !== null) {
      const r = control === null ? null : await measure(regionAtShow.current.current);
      if (control !== null && (r === null || !overlaps(control, r))) {
        if (seq === showing.current && active === entry.current) dismissActive();
        return;
      }
    }
    let bounds: Rect | null = null;
    if (control !== null) {
      const win = windowSize();
      bounds = win !== null ? { x: 0, y: 0, ...win } : null;
      // The smallest-area region whose frame overlaps the control, also when the control is partly
      // scrolled out of it; of two regions with the same measured area the earlier registered stays.
      let innermost: Rect | null = null;
      let innermostRef: { readonly current: unknown } | null = null;
      for (const ref of [...boundaries]) {
        const r = await measure(ref.current);
        if (r !== null && overlaps(control, r) && (innermost === null || r.width * r.height < innermost.width * innermost.height)) {
          innermost = r;
          innermostRef = ref;
        }
      }
      if (innermost !== null) bounds = innermost;
      if (bounds !== null) where = placement(control, bounds);
      if (!again && seq === showing.current) regionAtShow.current = innermostRef;
    }
    const target = await layerFor(control);
    if (seq !== showing.current || active !== entry.current) return;
    setPlace(where);
    const previous = placedIn.current;
    if (target === null) {
      if (previous !== null && previous.owner() === entry.current) previous.set(null);
      placedIn.current = null;
      setShown("inline");
      return;
    }
    const { layer, frame } = target;
    if (previous !== null && previous !== layer && previous.owner() === entry.current) previous.set(null);
    let bubble: Bubble = { owner: entry.current!, hint, theme, left: where.left, top: 0 };
    if (control !== null && frame !== null) {
      // The room is the region (or window) and the layer together: a layer inside a host modal ends
      // where the modal does, which the region behind the modal or the window does not know.
      const room = intersection(bounds ?? frame, frame) ?? frame;
      const fit = placement(control, room);
      // In the layer's own coordinates, kept inside it.
      const x = control.x - frame.x + fit.left;
      const left = Math.max(0, Math.min(x, frame.width - MAX_WIDTH));
      const anchor = { top: control.y - frame.y, bottom: control.y + control.height - frame.y, height: frame.height };
      bubble = fit.above
        ? { owner: entry.current!, hint, theme, left, bottom: frame.y + frame.height - (control.y - GAP), anchor }
        : { owner: entry.current!, hint, theme, left, top: control.y + control.height + GAP - frame.y, anchor };
    }
    placedIn.current = layer;
    layer.set(bubble);
    setShown("layer");
  };
  const show = () => {
    if (active !== entry.current) dismissActive();
    active = entry.current;
    // With no layer mounted (a control rendered outside the panel) it shows beside the control at once.
    setShown(layers.length === 0 ? "inline" : "pending");
    regionAtShow.current = null;
    void place(++showing.current);
  };
  const handlers: TooltipHandlers = {
    onHoverIn: show,
    onHoverOut: hide,
    // Keyboard focus shows the hint; the focus a tap or click leaves behind does not (on a touch screen
    // it would otherwise stay until focus moves on).
    onFocus: (e) => {
      const afterTouch = touched.current;
      touched.current = false;
      if (!pointerFocus(e, afterTouch)) show();
    },
    onBlur: () => {
      touched.current = false;
      hide();
    },
    // Handling the long press keeps the platform from also invoking the control's onPress.
    onLongPress: show,
    // A press on any control hides a shown tooltip, this control's own included.
    onPressIn: (e) => {
      touched.current = touchPress(e);
      dismissActive();
    },
    onPressOut: hide,
    onKeyDown: (e) => {
      if ((e.nativeEvent?.key ?? e.key) === "Escape") hide();
    },
  };

  // The bubble sits in a transparent box of the full tooltip width, so its text wraps at that width,
  // not at the control's (an absolute box is laid out in its parent, which here only wraps the control);
  // the bubble itself shrinks to its text. Neither takes touches. While shown the wrapper is raised over
  // its siblings; content outside the wrapper's own row can still paint over it (see SPEC).
  return (
    <View style={{ position: "relative", alignSelf: "flex-start", ...(shown === "inline" ? { zIndex: 10 } : {}) }}>
      {props.children(handlers, anchor)}
      {shown === "inline" ? (
        <View
          pointerEvents="none"
          style={{
            position: "absolute",
            zIndex: 10,
            left: inlinePlace.left,
            ...(inlinePlace.above ? { bottom: "100%", marginBottom: GAP } : { top: "100%", marginTop: GAP }),
            width: MAX_WIDTH,
            alignItems: "flex-start",
          }}
        >
          <BubbleBox hint={hint} theme={theme} />
        </View>
      ) : null}
    </View>
  );
}
