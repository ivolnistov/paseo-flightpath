// Where a roadmap link lands in a session: a question link selects the question, a current-answer
// link also focuses its current answer, a pinned link opens that history revision, a hidden question
// is flagged so the hidden list opens, another session is pushed with the same link, and an unknown
// number is reported. Nothing in the link is dropped.
import { describe, expect, it } from "vitest";
import type { ParsedLink } from "../shared/links";
import type { QuestionView, SessionView } from "../shared/rpc";

const modulePath = "./link-target";
async function resolveTarget(view: SessionView, link: ParsedLink | number, nonce?: number): Promise<unknown> {
  const mod: unknown = await import(/* @vite-ignore */ modulePath);
  const fn: unknown = typeof mod === "object" && mod !== null ? Object.entries(mod).find(([k]) => k === "resolveTarget")?.[1] : undefined;
  if (typeof fn !== "function") throw new Error("missing export: link-target.resolveTarget");
  const out: unknown = Reflect.apply(fn, undefined, nonce === undefined ? [view, link] : [view, link, nonce]);
  return out;
}

const AT = "2026-10-20T10:00:00.000Z";
function qv(id: string, number: number, visibility: "active" | "inactive" = "active"): QuestionView {
  return {
    question: { id, order: number - 1, number, title: `Question ${number}`, context: "", options: [], allowFreeText: true, definitionRev: 1, activatedBy: [], invalidatedBy: [], revisions: [], discussion: [], validity: "unanswered" },
    visibility,
    status: visibility === "inactive" ? "inactive" : "open",
    depth: 0,
    number,
    links: { question: `roadmap://prj_1/s/S1/q/${number}`, answer: `roadmap://prj_1/s/S1/q/${number}/answer` },
  };
}
const view: SessionView = {
  revision: 3,
  session: { id: "S1", title: "S1", createdAt: AT, status: "active" },
  cancellations: [],
  questions: [qv("q3", 3), qv("q7", 7, "inactive")],
  links: [],
  catalog: [],
};
const base = { projectId: "prj_1", sessionId: "S1", number: 3 };

describe("resolveTarget", () => {
  it("a question link selects the question", async () => {
    expect(await resolveTarget(view, { ...base, kind: "question" })).toEqual({ kind: "target", target: { questionId: "q3", nonce: 0 } });
  });

  it("a current-answer link focuses the current answer; a pinned link focuses that revision", async () => {
    expect(await resolveTarget(view, { ...base, kind: "answer" })).toEqual({ kind: "target", target: { questionId: "q3", nonce: 0, focus: "answer" } });
    expect(await resolveTarget(view, { ...base, kind: "answer", rev: 1 })).toEqual({ kind: "target", target: { questionId: "q3", nonce: 0, focus: { rev: 1 } } });
  });

  it("carries the given nonce, so a repeated press selects again", async () => {
    expect(await resolveTarget(view, { ...base, kind: "question" }, 5)).toEqual({ kind: "target", target: { questionId: "q3", nonce: 5 } });
  });

  it("a short Q<n> reference resolves against the open session", async () => {
    expect(await resolveTarget(view, 3)).toEqual({ kind: "target", target: { questionId: "q3", nonce: 0 } });
  });

  it("a hidden question is flagged so the hidden list opens, keeping the focus", async () => {
    expect(await resolveTarget(view, { ...base, number: 7, kind: "answer" })).toEqual({ kind: "hidden", target: { questionId: "q7", nonce: 0, focus: "answer" } });
    expect(await resolveTarget(view, 7)).toMatchObject({ kind: "hidden", target: { questionId: "q7" } });
  });

  it("another session is pushed with the whole link; an unknown number is reported", async () => {
    const other: ParsedLink = { projectId: "prj_1", sessionId: "S2", number: 1, kind: "answer", rev: 2 };
    expect(await resolveTarget(view, other)).toEqual({ kind: "other-session", sessionId: "S2", link: other });
    expect(await resolveTarget(view, 99)).toEqual({ kind: "missing", number: 99 });
    expect(await resolveTarget(view, { ...base, number: 99, kind: "question" })).toEqual({ kind: "missing", number: 99 });
  });
});
