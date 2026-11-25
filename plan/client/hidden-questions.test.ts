// Hidden conditional questions: inactive questions are listed apart from the main list, each with
// the condition that would show it, named by the parent's stable number and option label.
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

// The module renders React Native components; in Node those are inert markers and the host SDK
// surfaces are stubs, so only the pure helpers run. Nothing reaches a host.
const { marker } = vi.hoisted(() => ({ marker: (name: string) => Object.assign(() => null, { displayName: name }) }));
vi.mock("react-native", () => ({ Text: marker("Text"), View: marker("View"), Pressable: marker("Pressable"), ScrollView: marker("RNScrollView") }));
vi.mock("@getpaseo/plugin/client/react-native", () => ({
  TextInput: marker("TextInput"),
  ScrollView: marker("ScrollView"),
  Modal: Object.assign(marker("Modal"), { Content: marker("ModalContent") }),
  useToast: () => ({ show: () => undefined, error: () => undefined }),
  copyText: async () => undefined,
}));
vi.mock("@getpaseo/plugin/client/ui", () => ({ SettingsAction: marker("SettingsAction"), SettingsInput: marker("SettingsInput"), SettingsSection: marker("SettingsSection"), SettingsSelect: marker("SettingsSelect") }));
vi.mock("@getpaseo/plugin/client", () => ({ useRpc: () => async () => ({ ok: true, value: {} }), useWorkspace: () => ({}), useSettings: () => ({ status: "loading" }), usePaseo: () => null }));
vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: undefined, isError: false }),
  useQueryClient: () => ({ getQueryData: () => undefined, getQueriesData: () => [], invalidateQueries: async () => undefined }),
}));
import type { QuestionView, SessionView } from "../shared/rpc";

const modulePath = "./hidden-questions";
async function helpers(): Promise<{ hiddenQuestions: (v: SessionView) => unknown; activationText: (qv: QuestionView, v: SessionView) => unknown }> {
  const mod: unknown = await import(/* @vite-ignore */ modulePath);
  const pick = (name: string): ((...args: unknown[]) => unknown) => {
    const fn: unknown = typeof mod === "object" && mod !== null ? Object.entries(mod).find(([k]) => k === name)?.[1] : undefined;
    if (typeof fn !== "function") throw new Error(`missing export: hidden-questions.${name}`);
    return (...args: unknown[]) => {
      const out: unknown = Reflect.apply(fn, undefined, args);
      return out;
    };
  };
  return { hiddenQuestions: pick("hiddenQuestions"), activationText: pick("activationText") };
}

const AT = "2026-10-20T10:00:00.000Z";
const options = [{ id: "a", label: "Option A" }, { id: "b", label: "Option B" }];
function qv(id: string, number: number, visibility: "active" | "inactive", extra: Partial<QuestionView["question"]> = {}): QuestionView {
  return {
    question: { id, order: number - 1, number, title: `Question ${number}`, context: "", options, allowFreeText: false, definitionRev: 1, activatedBy: [], invalidatedBy: [], revisions: [], discussion: [], validity: "unanswered", ...extra },
    visibility,
    status: visibility === "inactive" ? "inactive" : "open",
    depth: 0,
    number,
    links: { question: `roadmap://prj_test/s/S/q/${number}`, answer: `roadmap://prj_test/s/S/q/${number}/answer` },
  };
}
const answered = { rev: 1, optionId: "a", source: "ui" as const, actor: { kind: "human" as const }, at: AT };
const parentRef = { sessionId: "S", questionId: "q3" };
function view(): SessionView {
  return {
    revision: 5,
    session: { id: "S", title: "S", createdAt: AT, status: "active" },
    cancellations: [],
    questions: [
      qv("q1", 1, "active"),
      qv("q3", 3, "active", { answer: answered, revisions: [answered], validity: "valid" }),
      qv("q4", 4, "inactive", { activatedBy: [{ parent: parentRef, optionIds: ["b"] }] }),
      // A hidden question keeps its own outcome and history; it is still listed as hidden.
      qv("q5", 5, "inactive", { activatedBy: [{ parent: parentRef, optionIds: ["a", "b"] }], answer: answered, revisions: [answered], validity: "skipped" }),
    ],
    links: [],
    catalog: [],
  };
}

describe("hidden questions", () => {
  it("lists exactly the inactive questions, whatever their outcome", async () => {
    const { hiddenQuestions } = await helpers();
    const ids = z.array(z.looseObject({ question: z.looseObject({ id: z.string() }) })).parse(hiddenQuestions(view())).map((x) => x.question.id);
    expect(ids).toEqual(["q4", "q5"]);
  });

  it("names the condition by the parent's number and the option labels", async () => {
    const { activationText } = await helpers();
    const v = view();
    const q4 = String(activationText(v.questions[2], v));
    expect(q4).toContain("Q3");
    expect(q4).toContain("Option B");
    expect(q4).not.toContain("q3");
    const q5 = String(activationText(v.questions[3], v));
    expect(q5).toContain("Option A");
    expect(q5).toContain("Option B");
  });
});
