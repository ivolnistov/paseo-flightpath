// Stage R4.5a (task card §6.2, §6.3): the roadmap settings screen. Pure exports (settingsDraft,
// parseSettingsDraft, profileChoice) are schema-derived; the screen follows the tracker screen
// pattern: a draft pinned to useSettings' revision, Save disabled when unchanged / invalid / changed
// elsewhere / saving, "changed elsewhere" offers Reload (never overwrites, never retries), invalid
// stored settings show "defaults in use" + Reset. Node harness as client/tracker-settings.test.ts:
// slot useState/useEffect, inert host UI markers, handlers invoked from the tree. Labels are matched
// by regex (the card fixes behaviour, not label text). The module is new: non-literal import.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { roadmapSettings } from "../shared/settings";

type El = { type: unknown; props: Record<string, any> };
const h = vi.hoisted(() => {
  const state = {
    slots: [] as unknown[],
    index: 0,
    effects: [] as Array<{ deps: unknown[]; prev?: unknown[]; fn: () => void }>,
    effectIndex: 0,
    dirty: false,
    settings: null as any,
    profiles: [] as Array<{ id: string; label: string }>,
    // R4 final DeepSeek c0078: a whole profiles query override (pending / failed reads); reset per test.
    profilesQuery: undefined as undefined | { data?: Array<{ id: string; label: string }>; isPending: boolean; isError: boolean; error?: unknown },
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
  const hooks = { useState: h.useState, useEffect: h.useEffect, useMemo: (fn: () => unknown) => fn(), useCallback: (fn: unknown) => fn };
  return { ...real, ...hooks, default: { ...(real.default as object), ...hooks } };
});
vi.mock("react-native", () => ({ Text: h.marker("Text"), View: h.marker("View") }));
vi.mock("@getpaseo/plugin/client/react-native", () => ({ ScrollView: h.marker("ScrollView"), TextInput: h.marker("TextInput") }));
vi.mock("@getpaseo/plugin/client/ui", () => ({
  SettingsAction: h.marker("SettingsAction"),
  SettingsInput: h.marker("SettingsInput"),
  SettingsSection: h.marker("SettingsSection"),
  SettingsSelect: h.marker("SettingsSelect"),
}));
vi.mock("@getpaseo/plugin/client", () => ({ useSettings: () => h.state.settings, usePaseo: () => null, useRpc: () => async () => ({ ok: true, value: {} }) }));
vi.mock("./hooks", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useProfiles: () => h.state.profilesQuery ?? { data: h.state.profiles, isPending: false, isError: false },
}));

const modulePath = "./roadmap-settings";
type Form = Record<string, string>;
const load = async () => {
  const mod = (await import(/* @vite-ignore */ modulePath)) as Record<string, unknown>;
  for (const n of ["settingsDraft", "parseSettingsDraft", "profileChoice", "RoadmapSettingsScreen"]) expect(typeof mod[n], `client/roadmap-settings exports ${n}`).toBe("function");
  return mod as unknown as {
    settingsDraft: (v: unknown) => Form;
    parseSettingsDraft: (f: Form) => { ok: true; values: Record<string, unknown> } | { ok: false; errors: Record<string, string> };
    profileChoice: (p: Array<{ id: string; label: string }>) => Array<{ label: string; value: string }>;
    RoadmapSettingsScreen: (props: unknown) => unknown;
  };
};
const theme = { colors: new Proxy({}, { get: () => "#000" }) } as never;
const STORED = { ...roadmapSettings.schema.parse({}), reviewCommand: "reviewer --json", baseRef: "main", coordinatorProfile: "team-coordinator", dodTemplate: "- [check] npm test\nDocs updated" };
const PROFILES = [{ id: "team-coordinator", label: "Coordinator" }, { id: "plain", label: "Plain helper" }];

function mount(Screen: (p: unknown) => unknown) {
  const render = (): El => {
    for (let pass = 0; pass < 20; pass++) {
      h.state.index = 0;
      h.state.effectIndex = 0;
      h.state.dirty = false;
      const tree = Screen({ theme } as never) as El;
      for (const e of h.state.effects) if (!e.prev || e.deps.some((d, i) => !Object.is(d, e.prev![i]))) e.fn();
      if (!h.state.dirty) return tree;
    }
    throw new Error("component did not settle");
  };
  return { render };
}
function all(tree: unknown, pred: (el: El) => boolean): El[] {
  const out: El[] = [];
  const walk = (n: unknown, d = 0): void => {
    if (d > 80 || !n || typeof n !== "object") return;
    if (Array.isArray(n)) return n.forEach((x) => walk(x, d + 1));
    const el = n as El;
    if (typeof el.type === "function" && !(el.type as { displayName?: string }).displayName) return walk((el.type as (p: unknown) => unknown)(el.props ?? {}), d + 1);
    if (!el.props) return;
    if (pred(el)) out.push(el);
    walk(el.props.children, d + 1);
  };
  walk(tree);
  return out;
}
const named = (name: string) => (el: El) => (el.type as { displayName?: string })?.displayName === name;
const one = (tree: unknown, name: string, label: RegExp) => {
  const found = all(tree, (el) => named(name)(el) && label.test(String(el.props.label ?? el.props.title ?? "")));
  expect(found.length, `one ${name} ${label} (have: ${all(tree, named(name)).map((e) => e.props.label ?? e.props.title).join(" | ")})`).toBe(1);
  return found[0];
};
const textOf = (tree: unknown) => all(tree, () => true).map((el) => [el.props.label, el.props.title, el.props.error, el.props.description, typeof el.props.children === "string" ? el.props.children : ""].filter((x) => typeof x === "string").join(" ")).join("\n");

beforeEach(() => {
  h.state.slots = [];
  h.state.effects = [];
  h.state.profiles = PROFILES;
  h.state.profilesQuery = undefined;
  h.state.settings = { status: "ready", values: structuredClone(STORED), revision: "rev-1", saving: false, saveError: null, save: vi.fn(async () => true), reset: vi.fn() };
});

describe("R4.5a settingsDraft / parseSettingsDraft / profileChoice", () => {
  it("settingsDraft maps every schema key to text (numbers as strings, absent optionals as '')", async () => {
    const m = await load();
    const d = m.settingsDraft(roadmapSettings.schema.parse({}));
    expect(Object.keys(d).sort()).toEqual(
      ["baseRef", "checkTimeoutMs", "coordinatorProfile", "discussionProfile", "dodTemplate", "maxBuffer", "repairCeiling", "reviewCommand", "reviewTimeoutMs", "translationProfile"].sort(),
    );
    for (const k of ["dodTemplate", "reviewCommand", "baseRef", "coordinatorProfile", "discussionProfile", "translationProfile"]) expect(d[k], k).toBe("");
    expect(d.repairCeiling).toBe("30");
    expect(m.settingsDraft(STORED).coordinatorProfile).toBe("team-coordinator");
  });

  it("round-trips the stored values; trims text; cleared optionals are omitted; the profile id is kept", async () => {
    const m = await load();
    const ok = m.parseSettingsDraft(m.settingsDraft(STORED));
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.values).toEqual(STORED);
    const cleared = m.parseSettingsDraft({ ...m.settingsDraft(STORED), reviewCommand: "   ", baseRef: "", coordinatorProfile: "", dodTemplate: "" });
    expect(cleared.ok).toBe(true);
    if (cleared.ok) for (const k of ["reviewCommand", "baseRef", "coordinatorProfile", "dodTemplate"]) expect(k in cleared.values, `${k} omitted`).toBe(false);
    const trimmed = m.parseSettingsDraft({ ...m.settingsDraft(STORED), baseRef: "  develop  " });
    if (trimmed.ok) expect(trimmed.values.baseRef).toBe("develop");
    expect(JSON.stringify(ok)).not.toMatch(/opus|sonnet|gpt|provider|model/i);
  });

  it("integers come from the schema: repairCeiling 0 is an error, non-integers and non-numbers are errors (first issue per field)", async () => {
    const m = await load();
    const base = m.settingsDraft(STORED);
    for (const [k, v] of [["repairCeiling", "0"], ["repairCeiling", "2.5"], ["repairCeiling", "abc"], ["checkTimeoutMs", "-1"], ["maxBuffer", "1e"], ["reviewTimeoutMs", ""]] as const) {
      const out = m.parseSettingsDraft({ ...base, [k]: v });
      expect(out.ok, `${k}=${v}`).toBe(false);
      if (!out.ok) expect(typeof out.errors[k], `${k}=${v} error on its own field`).toBe("string");
    }
  });

  it("profileChoice: None first, then { label: name, value: id }; never a model or provider", async () => {
    const m = await load();
    expect(m.profileChoice(PROFILES)).toEqual([{ label: "None", value: "" }, { label: "Coordinator", value: "team-coordinator" }, { label: "Plain helper", value: "plain" }]);
  });
});

describe("R4.5a RoadmapSettingsScreen", () => {
  it("Save is disabled when unchanged and when invalid (the field shows its error); a valid change saves (values, pinned revision) exactly once", async () => {
    const { RoadmapSettingsScreen } = await load();
    const s = mount(RoadmapSettingsScreen);
    let tree = s.render();
    expect(one(tree, "SettingsAction", /save/i).props.disabled, "unchanged").toBe(true);
    one(tree, "SettingsInput", /repair|ceiling/i).props.onChangeText("0");
    tree = s.render();
    expect(one(tree, "SettingsAction", /save/i).props.disabled, "invalid").toBe(true);
    expect(one(tree, "SettingsInput", /repair|ceiling/i).props.error).toBeTruthy();
    one(tree, "SettingsInput", /repair|ceiling/i).props.onChangeText("5");
    tree = s.render();
    const save = one(tree, "SettingsAction", /save/i);
    expect(save.props.disabled).toBe(false);
    await save.props.onPress();
    expect(h.state.settings.save).toHaveBeenCalledTimes(1);
    const [values, revision] = h.state.settings.save.mock.calls[0];
    expect(revision).toBe("rev-1");
    expect(values).toEqual({ ...STORED, repairCeiling: 5 });
  });

  it("saving disables Save", async () => {
    const { RoadmapSettingsScreen } = await load();
    const s = mount(RoadmapSettingsScreen);
    let tree = s.render();
    one(tree, "SettingsInput", /repair|ceiling/i).props.onChangeText("7");
    h.state.settings.saving = true;
    tree = s.render();
    expect(one(tree, "SettingsAction", /save/i).props.disabled).toBe(true);
  });

  it("changed elsewhere (a newer revision under the draft): Save disabled, Reload offered, never overwrites or retries", async () => {
    const { RoadmapSettingsScreen } = await load();
    const s = mount(RoadmapSettingsScreen);
    let tree = s.render();
    one(tree, "SettingsInput", /repair|ceiling/i).props.onChangeText("9");
    h.state.settings = { ...h.state.settings, values: { ...STORED, repairCeiling: 12 }, revision: "rev-2" };
    tree = s.render();
    expect(one(tree, "SettingsAction", /save/i).props.disabled).toBe(true);
    const reload = one(tree, "SettingsAction", /reload/i);
    await reload.props.onPress();
    tree = s.render();
    expect(h.state.settings.save, "no overwrite, no retry").not.toHaveBeenCalled();
    // The installed SDK SettingsInput is uncontrolled (initialValue, no value prop): Reload must remount
    // the inputs (a revision-bearing key) with the stored value as their initialValue.
    const reloaded = one(tree, "SettingsInput", /repair|ceiling/i);
    expect(reloaded.props.initialValue, "the draft reloads the stored value").toBe("12");
    expect(String((reloaded as unknown as { key: unknown }).key ?? ""), "remounted for the new revision").toContain("rev-2");
    expect(one(tree, "SettingsAction", /save/i).props.disabled, "nothing to save right after Reload").toBe(true);
  });

  it("invalid stored settings show 'defaults in use' and Reset", async () => {
    const { RoadmapSettingsScreen } = await load();
    h.state.settings = { status: "invalid", values: undefined, revision: "rev-1", saving: false, saveError: null, save: vi.fn(), reset: vi.fn(), error: "bad" };
    const s = mount(RoadmapSettingsScreen);
    const tree = s.render();
    expect(textOf(tree)).toMatch(/defaults in use/i);
    await one(tree, "SettingsAction", /reset/i).props.onPress();
    expect(h.state.settings.reset).toHaveBeenCalledTimes(1);
  });

  it("a stored coordinatorProfile that is no longer saved stays selectable as '<id> (not found)' and is preserved on save", async () => {
    const { RoadmapSettingsScreen } = await load();
    h.state.settings.values = { ...STORED, coordinatorProfile: "gone-profile" };
    const s = mount(RoadmapSettingsScreen);
    let tree = s.render();
    const select = one(tree, "SettingsSelect", /coordinator/i);
    const opts = (select.props.options ?? select.props.choices ?? []) as Array<{ label: string; value: string }>;
    expect(opts.find((o) => o.value === "gone-profile")?.label).toMatch(/gone-profile.*not found/);
    expect(JSON.stringify(opts)).not.toMatch(/opus|gpt|claude|codex/i);
    one(tree, "SettingsInput", /repair|ceiling/i).props.onChangeText("4");
    tree = s.render();
    await one(tree, "SettingsAction", /save/i).props.onPress();
    expect(h.state.settings.save.mock.calls[0][0].coordinatorProfile).toBe("gone-profile");
  });

  // R4 final DeepSeek c0078: "(not found)" is a claim about the host's saved profiles, so it needs a
  // successful list. While the read is pending or failed the stored id stays selected with a neutral
  // label; a failed read is visible. The resolved-list case above stays the true "(not found)" control.
  const everyText = (tree: unknown) =>
    all(tree, () => true)
      .flatMap((el) => [...Object.values(el.props).filter((v): v is string => typeof v === "string"), ...((el.props.options ?? []) as Array<{ label: string }>).map((o) => o.label)])
      .join("\n");
  for (const mode of ["pending", "failed"] as const) {
    it(`profiles read ${mode}: the stored coordinatorProfile stays selected, is never labelled '(not found)'${mode === "failed" ? ", and the read failure is visible" : ""}`, async () => {
      const { RoadmapSettingsScreen } = await load();
      h.state.settings.values = { ...STORED, coordinatorProfile: "team-coordinator" };
      h.state.profilesQuery = mode === "pending" ? { data: undefined, isPending: true, isError: false } : { data: undefined, isPending: false, isError: true, error: new Error("host config unreadable") };
      const tree = mount(RoadmapSettingsScreen).render();
      const select = one(tree, "SettingsSelect", /coordinator/i);
      const opts = (select.props.options ?? []) as Array<{ label: string; value: string }>;
      expect(select.props.value, "the stored profile stays selected").toBe("team-coordinator");
      expect(opts.some((o) => o.value === "team-coordinator"), "the stored profile stays selectable").toBe(true);
      expect(everyText(tree), "no missing-profile claim while the list is unknown").not.toMatch(/not found/i);
      if (mode === "failed") expect(everyText(tree), "the failed read is visible").toMatch(/host config unreadable/);
    });
  }

  it("the DoD template is a multi-line 16 px bounded TextInput; a hint warns that the review command runs locally without credentials", async () => {
    const { RoadmapSettingsScreen } = await load();
    const tree = mount(RoadmapSettingsScreen).render();
    const inputs = all(tree, named("TextInput"));
    expect(inputs).toHaveLength(1);
    const style = Object.assign({}, ...[inputs[0].props.style].flat().filter(Boolean));
    expect(inputs[0].props.multiline).toBe(true);
    expect(style.fontSize).toBe(16);
    expect(typeof style.maxHeight === "number" || typeof style.height === "number", "bounded height").toBe(true);
    expect(inputs[0].props.value).toBe(STORED.dodTemplate);
    expect(textOf(tree)).toMatch(/credential/i);
  });
});

// R4.5a verification (T): every field is edited on the actual screen, and None omits the profile.
describe("R4.5a verification: per-field screen edits", () => {
  const edit = async (label: RegExp, text: string) => {
    const { RoadmapSettingsScreen } = await load();
    const s = mount(RoadmapSettingsScreen);
    let tree = s.render();
    one(tree, "SettingsInput", label).props.onChangeText(text);
    tree = s.render();
    const save = one(tree, "SettingsAction", /save/i);
    expect(save.props.disabled, `${label} edit enables Save`).toBe(false);
    await save.props.onPress();
    expect(h.state.settings.save).toHaveBeenCalledTimes(1);
    return h.state.settings.save.mock.calls[0][0] as Record<string, unknown>;
  };

  it("check timeout, review timeout and output buffer edits save as integers", async () => {
    expect((await edit(/check.*timeout/i, "1234")).checkTimeoutMs).toBe(1234);
    h.state.settings.save.mockClear();
    h.state.slots = [];
    expect((await edit(/review.*timeout/i, "5678")).reviewTimeoutMs).toBe(5678);
    h.state.settings.save.mockClear();
    h.state.slots = [];
    expect((await edit(/buffer/i, "4096")).maxBuffer).toBe(4096);
  });

  it("review command and base ref edits are trimmed; clearing one omits the key", async () => {
    expect((await edit(/review command/i, "  reviewer --strict  ")).reviewCommand).toBe("reviewer --strict");
    h.state.settings.save.mockClear();
    h.state.slots = [];
    expect("baseRef" in (await edit(/base/i, "   ")), "a cleared base ref is omitted").toBe(false);
  });

  it("choosing None in the profile select omits coordinatorProfile on save", async () => {
    const { RoadmapSettingsScreen } = await load();
    const s = mount(RoadmapSettingsScreen);
    let tree = s.render();
    const select = one(tree, "SettingsSelect", /coordinator/i);
    expect((select.props.options as Array<{ label: string; value: string }>)[0]).toEqual({ label: "None", value: "" });
    select.props.onValueChange("");
    tree = s.render();
    await one(tree, "SettingsAction", /save/i).props.onPress();
    expect("coordinatorProfile" in h.state.settings.save.mock.calls[0][0]).toBe(false);
  });
});

// Discussion settings: a Discussion profile select used by one-click Discuss, and a reserved
// Translation profile select; both follow the coordinator select's profile choices.
describe("discussion and translation profile settings", () => {
  it("the draft round-trips both profiles; a cleared one is omitted", async () => {
    const m = await load();
    const stored = { ...STORED, discussionProfile: "plain", translationProfile: "team-coordinator" };
    const out = m.parseSettingsDraft(m.settingsDraft(stored));
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.values).toEqual(stored);
    const cleared = m.parseSettingsDraft({ ...m.settingsDraft(stored), discussionProfile: "", translationProfile: "  " });
    expect(cleared.ok).toBe(true);
    if (cleared.ok) for (const k of ["discussionProfile", "translationProfile"]) expect(k in cleared.values, `${k} omitted`).toBe(false);
  });

  it("the screen shows a Discussion profile select and a reserved Translation profile select with the saved profiles", async () => {
    const { RoadmapSettingsScreen } = await load();
    const tree = mount(RoadmapSettingsScreen).render();
    const discussion = one(tree, "SettingsSelect", /discussion/i);
    const translation = one(tree, "SettingsSelect", /translation/i);
    expect(String(translation.props.label)).toMatch(/reserved/i);
    for (const select of [discussion, translation]) {
      expect(select.props.options).toEqual([{ label: "None", value: "" }, { label: "Coordinator", value: "team-coordinator" }, { label: "Plain helper", value: "plain" }]);
    }
    expect(String(translation.props.hint ?? "")).toMatch(/no translation/i);
  });

  it("choosing a discussion profile saves it; the other settings are kept", async () => {
    const { RoadmapSettingsScreen } = await load();
    const s = mount(RoadmapSettingsScreen);
    let tree = s.render();
    one(tree, "SettingsSelect", /discussion/i).props.onValueChange("plain");
    tree = s.render();
    await one(tree, "SettingsAction", /save/i).props.onPress();
    expect(h.state.settings.save.mock.calls[0][0]).toEqual({ ...STORED, discussionProfile: "plain" });
  });

  it("a stored discussion profile that is no longer saved stays selectable as '<id> (not found)'", async () => {
    const { RoadmapSettingsScreen } = await load();
    h.state.settings.values = { ...STORED, discussionProfile: "gone-profile" };
    const tree = mount(RoadmapSettingsScreen).render();
    const opts = one(tree, "SettingsSelect", /discussion/i).props.options as Array<{ label: string; value: string }>;
    expect(opts.find((o) => o.value === "gone-profile")?.label).toMatch(/gone-profile.*not found/);
  });
});
