// Close-config draft regressions for the REAL TrackerSettingsScreen (KensAI c0102), in node.
// Minimal harness (no React renderer is installed): `react` keeps its real JSX/elements but its
// useState/useEffect are replaced by a tiny slot-based implementation; host UI, React Native and
// useSettings are inert mocks. The component's own handlers (onChangeText, onPress) are invoked
// from the rendered element tree and the component is re-rendered until stable. Limitations: no
// real reconciler, keys/remounts, layout or host behaviour; only state/handler logic is exercised.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { trackerSettings } from "../shared/settings";

type El = { type: unknown; props: Record<string, any> };
const h = vi.hoisted(() => {
  const state = {
    slots: [] as unknown[],
    index: 0,
    effects: [] as Array<{ deps: unknown[]; prev?: unknown[]; fn: () => void }>,
    effectIndex: 0,
    dirty: false,
    settings: null as any,
  };
  const useState = (init: unknown) => {
    const i = state.index++;
    if (!(i in state.slots)) state.slots[i] = typeof init === "function" ? (init as () => unknown)() : init;
    const set = (v: unknown) => {
      const next = typeof v === "function" ? (v as (p: unknown) => unknown)(state.slots[i]) : v;
      if (next !== state.slots[i]) {
        state.slots[i] = next;
        state.dirty = true;
      }
    };
    return [state.slots[i], set];
  };
  const useEffect = (fn: () => void, deps: unknown[]) => {
    const i = state.effectIndex++;
    const prev = state.effects[i]?.deps;
    state.effects[i] = { deps, prev, fn };
  };
  const marker = (name: string) => Object.assign(() => null, { displayName: name });
  return { state, useState, useEffect, marker };
});

vi.mock("react", async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  return { ...real, default: { ...(real.default as object), useState: h.useState, useEffect: h.useEffect }, useState: h.useState, useEffect: h.useEffect };
});
vi.mock("react-native", () => ({ Text: h.marker("Text"), View: h.marker("View") }));
vi.mock("@getpaseo/plugin/client/react-native", () => ({ ScrollView: h.marker("ScrollView") }));
vi.mock("@getpaseo/plugin/client/ui", () => ({
  SettingsAction: h.marker("SettingsAction"),
  SettingsInput: h.marker("SettingsInput"),
  SettingsSection: h.marker("SettingsSection"),
  SettingsSelect: h.marker("SettingsSelect"),
}));
vi.mock("@getpaseo/plugin/client", () => ({ useSettings: () => h.state.settings }));

// Loaded through a non-literal specifier so the node TypeScript program does not pull the client
// component (and its host UI/DOM-flavoured types) into its type graph; Vitest resolves it at runtime.
const componentPath = "./tracker-settings";
const { TrackerSettingsScreen } = (await import(/* @vite-ignore */ componentPath)) as { TrackerSettingsScreen: (props: unknown) => unknown };
const theme = { colors: new Proxy({}, { get: () => "#000" }) } as never;

function render(): El {
  for (let pass = 0; pass < 20; pass++) {
    h.state.index = 0;
    h.state.effectIndex = 0;
    h.state.dirty = false;
    const tree = TrackerSettingsScreen({ theme } as never) as El;
    for (const e of h.state.effects) {
      if (!e.prev || e.deps.some((d, i) => !Object.is(d, e.prev![i]))) e.fn();
    }
    if (!h.state.dirty) return tree;
  }
  throw new Error("component did not settle");
}
function find(tree: El, typeName: string, label: string): El {
  const out: El[] = [];
  const walk = (n: unknown) => {
    if (Array.isArray(n)) return n.forEach(walk);
    if (!n || typeof n !== "object") return;
    const el = n as El;
    if ((el.type as { displayName?: string })?.displayName === typeName && el.props?.label === label) out.push(el);
    walk(el.props?.children);
  };
  walk(tree);
  if (out.length !== 1) throw new Error(`expected one ${typeName} "${label}", found ${out.length}`);
  return out[0];
}
/** Invoke a real handler, then re-render until stable, returning the fresh tree. */
const act = (fn: () => void) => {
  fn();
  return render();
};

const initial = { provider: "snailorbit", mode: "dry-run", projectKey: "SYN", closeByProject: { SYN: { field: "State", value: "Done" } } };

beforeEach(() => {
  h.state.slots = [];
  h.state.effects = [];
  h.state.settings = { status: "ready", values: structuredClone(initial), revision: "rev-1", saving: false, saveError: null, save: vi.fn(async () => undefined), reset: vi.fn() };
});

describe("TrackerSettingsScreen close-pair draft (c0102)", () => {
  it("clearing only the close field on SYN keeps Save disabled (c0102 as written)", () => {
    let tree = render();
    expect(find(tree, "SettingsAction", "Save tracker settings").props.disabled).toBe(true); // unchanged
    tree = act(() => find(tree, "SettingsInput", "Close field").props.onChangeText(""));
    expect(find(tree, "SettingsInput", "Close value").props.error).toBeTruthy();
    expect(find(tree, "SettingsAction", "Save tracker settings").props.disabled).toBe(true);
  });

  it("clearing SYN's field and switching to OTHER must not save away SYN's complete pair", () => {
    let tree = render();
    tree = act(() => find(tree, "SettingsInput", "Close field").props.onChangeText(""));
    tree = act(() => find(tree, "SettingsInput", "Project key").props.onChangeText("OTHER"));
    const save = find(tree, "SettingsAction", "Save tracker settings");
    expect(save.props.disabled).toBe(false);
    save.props.onPress();
    expect(h.state.settings.save).toHaveBeenCalledTimes(1);
    const [values, revision] = h.state.settings.save.mock.calls[0];
    expect(revision).toBe("rev-1");
    expect(values.projectKey).toBe("OTHER");
    expect(values.closeByProject.SYN, "an incomplete edit must not delete the saved SYN pair").toEqual({ field: "State", value: "Done" });
  });

  it("explicitly clearing both SYN inputs removes SYN's close config and Save is enabled", () => {
    let tree = render();
    tree = act(() => find(tree, "SettingsInput", "Close field").props.onChangeText(""));
    tree = act(() => find(tree, "SettingsInput", "Close value").props.onChangeText(""));
    const save = find(tree, "SettingsAction", "Save tracker settings");
    expect(save.props.disabled).toBe(false);
    save.props.onPress();
    const [values, revision] = h.state.settings.save.mock.calls[0];
    expect(revision).toBe("rev-1");
    expect(values.closeByProject).toEqual({});
  });

  it("clearing then completing a new pair saves exactly the new pair", () => {
    let tree = render();
    tree = act(() => find(tree, "SettingsInput", "Close field").props.onChangeText(""));
    tree = act(() => find(tree, "SettingsInput", "Close field").props.onChangeText("Status"));
    const save = find(tree, "SettingsAction", "Save tracker settings");
    expect(save.props.disabled).toBe(false);
    save.props.onPress();
    const [values, revision] = h.state.settings.save.mock.calls[0];
    expect(revision).toBe("rev-1");
    expect(values.closeByProject).toEqual({ SYN: { field: "Status", value: "Done" } });
  });
});

/**
 * The installed host's settings write boundary (Paseo 0.12.0 `useSettings`, web UI and desktop
 * bundles): `values: z.json().parse(await definition.schema.parseAsync(values))`, applied in the
 * client before the `settings.tracker.write` RPC is sent. A rejection here is the "Invalid input"
 * save error the host shows; the mocked `save` itself never validates.
 */
const hostWriteBoundary = async (values: unknown) => z.json().parse(await trackerSettings.schema.parseAsync(values));

describe("TrackerSettingsScreen clearing the optional project key (settings-clear correction)", () => {
  /** Saved SYN dry-run pair; clear both close inputs and the key, choose provider None. */
  const clearAll = () => {
    let tree = render();
    tree = act(() => find(tree, "SettingsInput", "Close field").props.onChangeText(""));
    tree = act(() => find(tree, "SettingsInput", "Close value").props.onChangeText(""));
    tree = act(() => find(tree, "SettingsInput", "Project key").props.onChangeText(""));
    tree = act(() => find(tree, "SettingsSelect", "Provider").props.onValueChange("none"));
    return tree;
  };

  it("saves provider None with no project key and no close pair through the host write boundary", async () => {
    const save = find(clearAll(), "SettingsAction", "Save tracker settings");
    expect(save.props.disabled).toBe(false);
    save.props.onPress();
    expect(h.state.settings.save).toHaveBeenCalledTimes(1);
    const [values, revision] = h.state.settings.save.mock.calls[0];
    expect(revision).toBe("rev-1");
    // The cleared key is omitted, not sent as undefined (c0037); the boundary below would also reject it.
    expect(Object.keys(values)).not.toContain("projectKey");
    await expect(hostWriteBoundary(values)).resolves.toEqual({ provider: "none", mode: "dry-run", closeByProject: {} });
  });

  it("clearing then retyping the same project key leaves Save disabled (c0036)", () => {
    let tree = render();
    tree = act(() => find(tree, "SettingsInput", "Project key").props.onChangeText(""));
    tree = act(() => find(tree, "SettingsInput", "Project key").props.onChangeText("SYN"));
    expect(find(tree, "SettingsAction", "Save tracker settings").props.disabled, "no setting changed").toBe(true);
    expect(h.state.settings.save).not.toHaveBeenCalled();
  });

  it("control: restoring the SYN key with provider None and no close pair passes the same boundary", async () => {
    let tree = clearAll();
    tree = act(() => find(tree, "SettingsInput", "Project key").props.onChangeText("SYN"));
    const save = find(tree, "SettingsAction", "Save tracker settings");
    expect(save.props.disabled).toBe(false);
    save.props.onPress();
    const [values, revision] = h.state.settings.save.mock.calls[0];
    expect(revision).toBe("rev-1");
    await expect(hostWriteBoundary(values)).resolves.toEqual({ provider: "none", mode: "dry-run", projectKey: "SYN", closeByProject: {} });
  });
});
