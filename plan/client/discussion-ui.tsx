// Small controls of the discussion screen: compact buttons, disclosures, link chips and menu items.
// A control drawn smaller than 44 px is a transparent 44 px target around its drawing, with negative
// vertical margins so the layout keeps the drawing's height.
import type { PluginTheme } from "@getpaseo/plugin";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useRef, type ReactNode, type Ref, type RefObject } from "react";
import { AccessibilityInfo, Platform, Pressable, Text, View, type TextInput } from "react-native";
import { lucideName } from "./roadmap-screen";
import { TARGET_SIZE } from "./theme";
import { TooltipLayer } from "./tooltip";

/** A control focus can move to: a view (a button) or a text input. */
export type FocusTarget = View | TextInput;

/** Moves keyboard focus (web) or the screen reader's focus (native) to a control. */
export function moveFocus(ref: RefObject<FocusTarget | null>, opts: { preventScroll?: boolean } = {}): void {
  const node = ref.current;
  if (node === null) return;
  if (Platform.OS === "web") webFocus(node, opts.preventScroll === true);
  else AccessibilityInfo.sendAccessibilityEvent(node, "focus");
}

/**
 * focus() on a web node. With `preventScroll` the browser does not scroll ancestors to bring it into
 * view: the focus that moves into a sheet as it opens uses it, since a scroll there moved the host's
 * sheet container; a Tab wrap does not, so the sheet's own list still scrolls to the control.
 */
function webFocus(node: unknown, preventScroll: boolean): void {
  if (typeof node !== "object" || node === null) return;
  const focus: unknown = Reflect.get(node, "focus");
  if (typeof focus === "function") Reflect.apply(focus, node, preventScroll ? [{ preventScroll: true }] : []);
}

/**
 * React Native Web maps aria-* props to DOM attributes, while accessibilityState reaches none on the
 * host; native reads accessibilityState. Controls pass both. Props React Native's types do not list
 * (aria-current, aria-description) go through this widened record.
 */
export const webAria = (attrs: Record<string, string | undefined>): Record<string, string> =>
  Object.fromEntries(Object.entries(attrs).filter((e): e is [string, string] => e[1] !== undefined));

const DRAWN = 24;
/** The 44 px target around a 24 px drawing, taking only the drawing's height in the layout. */
const TARGET = { minHeight: TARGET_SIZE, minWidth: TARGET_SIZE, marginVertical: -(TARGET_SIZE - DRAWN) / 2, justifyContent: "center", alignItems: "center" } as const;

/** A 24 px button, as the card's Edit. */
export function SmallButton(props: {
  label: string;
  onPress(): void;
  theme: PluginTheme;
  disabled?: boolean;
  expanded?: boolean;
  selected?: boolean;
  primary?: boolean;
  hint?: string;
}) {
  const { theme, disabled, expanded, selected, primary } = props;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.label}
      {...(props.hint !== undefined ? { accessibilityHint: props.hint } : {})}
      accessibilityState={{ disabled: disabled === true, ...(expanded !== undefined ? { expanded } : {}), ...(selected !== undefined ? { selected } : {}) }}
      aria-disabled={disabled === true}
      {...(expanded !== undefined ? { "aria-expanded": expanded } : {})}
      {...(selected !== undefined ? { "aria-selected": selected } : {})}
      disabled={disabled}
      onPress={props.onPress}
      style={TARGET}
    >
      <View
        style={{
          height: DRAWN,
          paddingHorizontal: 9,
          borderRadius: 5,
          justifyContent: "center",
          backgroundColor: primary ? theme.colors.accent : theme.colors.surface2,
          borderWidth: 1,
          borderColor: selected === true || expanded === true ? theme.colors.accent : "transparent",
          opacity: disabled === true ? 0.5 : 1,
        }}
      >
        <Text style={{ fontSize: 12, lineHeight: 16, color: primary ? theme.colors.accentForeground : theme.colors.foreground }}>{props.label}</Text>
      </View>
    </Pressable>
  );
}

/** A disclosure toggle with a chevron: Description, Why recommended. */
export function Disclosure(props: { label: string; open: boolean; onPress(): void; theme: PluginTheme }) {
  const { theme, open } = props;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.label}
      accessibilityState={{ expanded: open }}
      aria-expanded={open}
      onPress={props.onPress}
      style={TARGET}
    >
      <View style={{ height: DRAWN, flexDirection: "row", alignItems: "center", gap: 4, paddingLeft: 4, paddingRight: 8, borderRadius: 5 }}>
        <Icon name={lucideName(open ? "chevron-down" : "chevron-right")} size={12} color={open ? theme.colors.foreground : theme.colors.foregroundMuted} />
        <Text style={{ fontSize: 12, color: open ? theme.colors.foreground : theme.colors.foregroundMuted }}>{props.label}</Text>
      </View>
    </Pressable>
  );
}

/** A relation link: the visible text is short, the accessibility label names the target in full. */
export function LinkChip(props: { text: string; label: string; onPress?: () => void; theme: PluginTheme }) {
  const { theme } = props;
  if (props.onPress === undefined) {
    return <Text style={{ fontSize: 12, lineHeight: 24, color: theme.colors.foregroundMuted, paddingHorizontal: 6 }}>{props.text}</Text>;
  }
  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={props.label}
      onPress={props.onPress}
      style={TARGET}
    >
      <View style={{ height: DRAWN, flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 6, borderRadius: 5 }}>
        <Icon name={lucideName("link")} size={13} color={theme.colors.statusSuccess} />
        <Text style={{ fontSize: 12, color: theme.colors.statusSuccess }}>{props.text}</Text>
      </View>
    </Pressable>
  );
}

// The ARIA role of a radio menu item; React Native's role types do not list it, React Native Web passes it through.
const RADIO_ROLE: Record<string, string> = { accessibilityRole: "menuitemradio", role: "menuitemradio" };

/** One row of a menu: an action, or a radio when `checked` is given. */
let menuHints = 0;

export function MenuItem(props: {
  label: string;
  onPress(): void;
  theme: PluginTheme;
  icon?: string;
  checked?: boolean;
  disabled?: boolean;
  hint?: string;
  danger?: boolean;
  /** The underlying Pressable, for moving focus into the menu. */
  ref?: Ref<View>;
  /** Called when the item is laid out, so focus can wait for a sheet's content. */
  onLayout?: () => void;
  /** Called when the item loses focus, with the element that receives it (the web only). */
  onBlur?: (next: unknown) => void;
}) {
  const { theme, checked, disabled } = props;
  const radio = checked !== undefined;
  // React Native Web drops accessibilityHint: the drawn hint describes the item (aria-describedby).
  const hintRef = useRef<string | null>(null);
  hintRef.current ??= `menu-item-hint-${++menuHints}`;
  const hintId = hintRef.current;
  const color = disabled === true ? theme.colors.foregroundMuted : props.danger === true ? theme.colors.statusDanger : theme.colors.foreground;
  return (
    <Pressable
      ref={props.ref}
      {...(props.onLayout !== undefined ? { onLayout: props.onLayout } : {})}
      {...(props.onBlur !== undefined ? { onBlur: (e: object) => props.onBlur!(Reflect.get(e, "relatedTarget") ?? relatedOf(Reflect.get(e, "nativeEvent"))) } : {})}
      {...(radio ? RADIO_ROLE : { accessibilityRole: "menuitem" as const })}
      accessibilityLabel={props.label}
      {...(props.hint !== undefined ? { accessibilityHint: props.hint, ...webAria({ "aria-describedby": hintId }) } : {})}
      accessibilityState={{ disabled: disabled === true, ...(radio ? { checked } : {}) }}
      aria-disabled={disabled === true}
      {...(radio ? { "aria-checked": checked } : {})}
      disabled={disabled}
      onPress={props.onPress}
      style={{ minHeight: TARGET_SIZE, flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 10, borderRadius: 6 }}
    >
      {props.icon !== undefined ? (
        <Icon name={lucideName(radio && checked === true ? "check" : props.icon)} size={15} color={radio && checked === true ? theme.colors.statusSuccess : theme.colors.foregroundMuted} />
      ) : null}
      <Text style={{ color, flexShrink: 1 }}>{props.label}</Text>
      {props.hint !== undefined ? (
        <Text nativeID={hintId} style={{ marginLeft: "auto", fontSize: 12, color: theme.colors.foregroundMuted, flexShrink: 1 }}>
          {props.hint}
        </Text>
      ) : null}
    </Pressable>
  );
}

export function MenuSeparator(props: { theme: PluginTheme }) {
  return <View accessibilityRole="none" style={{ height: 1, marginVertical: 6, marginHorizontal: 4, backgroundColor: props.theme.colors.border }} />;
}

/** A small label chip: the block state, a tag. */
export function Chip(props: { children: ReactNode; theme: PluginTheme; tone?: "ok" | "muted" }) {
  const { theme } = props;
  const ok = props.tone === "ok";
  return (
    <Text
      style={{
        fontSize: 12,
        lineHeight: 18,
        paddingHorizontal: 6,
        borderRadius: 4,
        overflow: "hidden",
        backgroundColor: ok ? "rgba(32, 116, 74, 0.2)" : theme.colors.surface2,
        color: ok ? theme.colors.statusSuccess : theme.colors.foregroundMuted,
      }}
    >
      {props.children}
    </Text>
  );
}

/** A small tag beside an answer: Recommended, free text. */
export function Tag(props: { children: ReactNode; theme: PluginTheme }) {
  const { theme } = props;
  return (
    <Text style={{ fontSize: 11, lineHeight: 16, paddingHorizontal: 5, borderRadius: 4, overflow: "hidden", backgroundColor: theme.colors.surface2, color: theme.colors.foregroundMuted }}>
      {props.children}
    </Text>
  );
}

const relatedOf = (nativeEvent: unknown): unknown => (typeof nativeEvent === "object" && nativeEvent !== null ? Reflect.get(nativeEvent, "relatedTarget") : undefined);

type ScopeKey = { key?: string; shiftKey?: boolean; nativeEvent?: { key?: string; shiftKey?: boolean }; preventDefault?(): void; stopPropagation?(): void };

/** The element with keyboard focus on the web; undefined elsewhere. Read without the DOM types. */
export function activeElement(): unknown {
  const doc: unknown = Reflect.get(globalThis, "document");
  return typeof doc === "object" && doc !== null ? Reflect.get(doc, "activeElement") : undefined;
}

const FOCUSABLE = 'a[href], button, input, textarea, select, [tabindex]:not([tabindex="-1"])';

/** The focusable, enabled and shown elements inside a web node, in document order; [] elsewhere. */
function focusablesIn(node: unknown): Array<{ focus(): void }> {
  if (Platform.OS !== "web" || typeof node !== "object" || node === null) return [];
  const query: unknown = Reflect.get(node, "querySelectorAll");
  if (typeof query !== "function") return [];
  const found: unknown = Reflect.apply(query, node, [FOCUSABLE]);
  if (typeof found !== "object" || found === null) return [];
  const length: unknown = Reflect.get(found, "length");
  const list: unknown[] = typeof length === "number" ? Array.from({ length }, (_, i): unknown => Reflect.get(found, i)) : [];
  return list.filter((el): el is { focus(): void } => {
    if (typeof el !== "object" || el === null || typeof Reflect.get(el, "focus") !== "function") return false;
    const attr: unknown = Reflect.get(el, "getAttribute");
    const disabled = typeof attr === "function" && (Reflect.apply(attr, el, ["aria-disabled"]) === "true" || Reflect.apply(attr, el, ["disabled"]) !== null);
    const rects: unknown = Reflect.get(el, "getClientRects");
    const boxes: unknown = typeof rects === "function" ? Reflect.apply(rects, el, []) : undefined;
    const shown = typeof boxes !== "object" || boxes === null || Reflect.get(boxes, "length") !== 0;
    return !disabled && shown;
  });
}

/**
 * The content of a plugin sheet that the host renders as a compact bottom sheet: on the web that sheet
 * moves no focus, keeps no Tab order and handles no Escape, and its content is portalled, so keys
 * pressed inside never reach handlers outside it. The scope handles them on the content itself:
 * Escape calls `onEscape`; Tab past the last focusable control wraps to the first and Shift+Tab before
 * the first to the last (the browser keeps Tab between controls); with `focusOnMount` focus moves to
 * the first control (without scrolling) once the content is laid out. A text input inside reports keys
 * only to its own onKeyPress on React Native Web, so it handles them itself. Native gets the screen reader's focus on the
 * content and no key handling (it has no Tab order here).
 */
export function FocusScope(props: {
  children: ReactNode;
  label: string;
  onEscape(): void;
  /** Move focus in once mounted: to this control, or (true) to the first focusable one. */
  focusOnMount?: boolean | RefObject<FocusTarget | null>;
}) {
  const ref = useRef<View | null>(null);
  const pending = useRef(props.focusOnMount !== undefined && props.focusOnMount !== false);
  const focusIn = () => {
    if (!pending.current || ref.current === null) return;
    const target = typeof props.focusOnMount === "object" ? props.focusOnMount : null;
    if (Platform.OS === "web") {
      // Focus the user already moved inside is never taken back.
      const contains: unknown = Reflect.get(ref.current, "contains");
      const active = activeElement();
      if (typeof contains === "function" && active !== undefined && active !== null && Reflect.apply(contains, ref.current, [active]) === true) {
        pending.current = false;
        return;
      }
      if (target !== null) {
        if (target.current === null) return;
        pending.current = false;
        moveFocus(target, { preventScroll: true });
        return;
      }
      const first = focusablesIn(ref.current)[0];
      if (first === undefined) return;
      pending.current = false;
      webFocus(first, true);
      return;
    }
    pending.current = false;
    moveFocus(target ?? ref, { preventScroll: true });
  };
  // Focus moves in when the content is laid out (the sheet has opened), not on later renders.
  const keys: Record<string, (e: ScopeKey) => void> = {
    onKeyDown: (e) => {
      const key = e.key ?? e.nativeEvent?.key;
      if (key === "Escape") {
        e.preventDefault?.();
        e.stopPropagation?.();
        props.onEscape();
        return;
      }
      if (key !== "Tab") return;
      const list = focusablesIn(ref.current);
      if (list.length === 0) return;
      const shift = e.shiftKey ?? e.nativeEvent?.shiftKey ?? false;
      const active = activeElement();
      const edge = shift ? list[0] : list[list.length - 1];
      if (active !== edge) return;
      e.preventDefault?.();
      (shift ? list[list.length - 1] : list[0]).focus();
    },
  };
  return (
    <View ref={ref} accessibilityLabel={props.label} onLayout={focusIn} style={{ gap: 6, minWidth: 0 }} {...keys}>
      {props.children}
      {/* The host portals a sheet above the panel: its tooltips are drawn in the sheet's own layer. */}
      <TooltipLayer />
    </View>
  );
}
