// Stable question labels and the links a question offers for copying: the question link and the
// current-answer link, never the revision-pinned history form.
import { describe, expect, it } from "vitest";
import type { QuestionView } from "../shared/rpc";

const modulePath = "./question-number";
async function helpers(): Promise<{ qLabel: (n: number) => unknown; copyLinks: (qv: QuestionView) => unknown }> {
  const mod: unknown = await import(/* @vite-ignore */ modulePath);
  const pick = (name: string): ((...args: unknown[]) => unknown) => {
    const fn: unknown = typeof mod === "object" && mod !== null ? Object.entries(mod).find(([k]) => k === name)?.[1] : undefined;
    if (typeof fn !== "function") throw new Error(`missing export: question-number.${name}`);
    return (...args: unknown[]) => {
      const out: unknown = Reflect.apply(fn, undefined, args);
      return out;
    };
  };
  return { qLabel: pick("qLabel"), copyLinks: pick("copyLinks") };
}

const AT = "2026-10-20T10:00:00.000Z";
const view = (answered: boolean): QuestionView => ({
  question: {
    id: "q7", order: 6, number: 7, title: "Export format", context: "", options: [{ id: "a", label: "A" }], allowFreeText: false, definitionRev: 1,
    activatedBy: [], invalidatedBy: [], discussion: [], validity: answered ? "valid" : "unanswered",
    revisions: answered ? [{ rev: 2, optionId: "a", source: "ui", actor: { kind: "human" }, at: AT }] : [],
    ...(answered ? { answer: { rev: 2, optionId: "a", source: "ui", actor: { kind: "human" }, at: AT } } : {}),
  },
  visibility: "active",
  status: answered ? "answered" : "open",
  depth: 0,
  number: 7,
  links: { question: "roadmap://prj_test/s/S1/q/7", answer: "roadmap://prj_test/s/S1/q/7/answer" },
});

describe("question labels and copy links", () => {
  it("labels a question by its stable number", async () => {
    const { qLabel } = await helpers();
    expect(qLabel(7)).toBe("Q7");
    expect(qLabel(12)).toBe("Q12");
  });

  it("offers the question link and the current-answer link, never a revision-pinned one", async () => {
    const { copyLinks } = await helpers();
    const qv = view(true);
    expect(copyLinks(qv)).toEqual({ question: qv.links.question, answer: qv.links.answer });
    const links = JSON.stringify(copyLinks(qv));
    expect(links).not.toMatch(/\/answer\/r\d+/);
  });
});
