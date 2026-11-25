// Pressable roadmap references inside plugin-rendered text: plain text, canonical roadmap:// links
// and short Q<n> references are split apart; each reference is a link-role control labelled with
// what it opens. Only text the plugin renders itself is made pressable.
import { describe, expect, it, vi } from "vitest";

const { marker } = vi.hoisted(() => ({ marker: (name: string) => Object.assign(() => null, { displayName: name }) }));
vi.mock("react-native", () => ({ Text: marker("Text"), View: marker("View"), Pressable: marker("Pressable") }));

const modulePath = "./link-text";
async function exported(name: string): Promise<(...args: unknown[]) => unknown> {
  const mod: unknown = await import(/* @vite-ignore */ modulePath);
  const fn: unknown = typeof mod === "object" && mod !== null ? Object.entries(mod).find(([k]) => k === name)?.[1] : undefined;
  if (typeof fn !== "function") throw new Error(`missing export: link-text.${name}`);
  return (...args: unknown[]) => {
    const out: unknown = Reflect.apply(fn, undefined, args);
    return out;
  };
}

type El = { type: unknown; props: Record<string, unknown> };
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isEl = (v: unknown): v is El => isRecord(v) && "type" in v && isRecord(v.props);
function all(tree: unknown, pred: (el: El) => boolean): El[] {
  const out: El[] = [];
  const walk = (n: unknown) => {
    if (Array.isArray(n)) return n.forEach(walk);
    if (!isEl(n)) return;
    if (pred(n)) out.push(n);
    walk(n.props.children);
  };
  walk(tree);
  return out;
}

describe("splitLinks", () => {
  it("splits plain text, canonical links and short references", async () => {
    const splitLinks = await exported("splitLinks");
    expect(splitLinks("see roadmap://prj_1/s/S1/q/3/answer and Q4.")).toEqual([
      { kind: "text", text: "see " },
      { kind: "link", raw: "roadmap://prj_1/s/S1/q/3/answer", link: { projectId: "prj_1", sessionId: "S1", number: 3, kind: "answer" } },
      { kind: "text", text: " and " },
      { kind: "short", raw: "Q4", number: 4 },
      { kind: "text", text: "." },
    ]);
  });

  it("keeps a pinned revision and leaves malformed links and words like Q0 or SQL as text", async () => {
    const splitLinks = await exported("splitLinks");
    expect(splitLinks("roadmap://prj_1/s/S1/q/3/answer/r2")).toEqual([{ kind: "link", raw: "roadmap://prj_1/s/S1/q/3/answer/r2", link: { projectId: "prj_1", sessionId: "S1", number: 3, kind: "answer", rev: 2 } }]);
    const text = (await exported("splitLinks"))("Q0 SQL roadmap://prj_1/s/S1/q/0 plain");
    expect(Array.isArray(text) && text.every((s) => isRecord(s) && s.kind === "text")).toBe(true);
  });
});

describe("LinkText", () => {
  it("renders each reference as a labelled link control that opens it", async () => {
    const LinkText = await exported("LinkText");
    const opened: unknown[] = [];
    const theme = { colors: new Proxy({}, { get: () => "#000" }) };
    const tree = LinkText({ text: "see roadmap://prj_1/s/S1/q/3 and Q4", theme, onOpen: (t: unknown) => void opened.push(t) });
    const links = all(tree, (el) => el.props.accessibilityRole === "link");
    expect(links.map((l) => l.props.accessibilityLabel)).toEqual(["Open roadmap://prj_1/s/S1/q/3", "Open Q4"]);
    for (const l of links) {
      const onPress = l.props.onPress;
      if (typeof onPress === "function") Reflect.apply(onPress, undefined, []);
    }
    expect(opened).toEqual([{ projectId: "prj_1", sessionId: "S1", number: 3, kind: "question" }, 4]);
  });
});
