// The block "Discuss in chat" places in the draft: question number and title, the current answer
// with its revision or an explicit "none" with the status, and the canonical question link. History
// (superseded revisions, a skipped question's kept answer) is never presented as current.
import { describe, expect, it } from "vitest";
import type { Answer, Question } from "../shared/model";
import type { QuestionView } from "../shared/rpc";

/** The builder under test, checked at run time: a variable-path import keeps the client module out of the node type check. */
interface DiscussContextApi {
  discussContext(qv: QuestionView): string;
}
const isApi = (m: unknown): m is DiscussContextApi => typeof m === "object" && m !== null && typeof Reflect.get(m, "discussContext") === "function";
const modulePath = "./discuss-context";
const loaded: unknown = await import(/* @vite-ignore */ modulePath);
if (!isApi(loaded)) throw new Error("client/discuss-context does not export the expected API");
const api: DiscussContextApi = loaded;
const discussContext = (qv: QuestionView) => api.discussContext(qv);

const at = "2026-10-20T10:00:00.000Z";
const rev = (n: number, a: { optionId?: string; text?: string }): Answer => ({ rev: n, source: "ui", actor: { kind: "human" }, at, ...a });

function question(over: Partial<Question> = {}): Question {
  return {
    id: "q7",
    order: 0,
    title: "Pick a database",
    context: "",
    options: [
      { id: "pg", label: "Postgres" },
      { id: "sq", label: "SQLite" },
    ],
    allowFreeText: true,
    definitionRev: 1,
    activatedBy: [],
    invalidatedBy: [],
    revisions: [],
    discussion: [],
    validity: "unanswered",
    ...over,
  } as Question;
}

function view(q: Question, status: QuestionView["status"], number = 7): QuestionView {
  return {
    question: q,
    visibility: "active",
    status,
    depth: 0,
    number,
    links: { question: `roadmap://prj_x/s/S1/q/${number}`, answer: `roadmap://prj_x/s/S1/q/${number}/answer` },
  } as QuestionView;
}

describe("discussContext", () => {
  it("an open question states that it has no current answer", () => {
    expect(discussContext(view(question(), "open"))).toBe(
      [
        "--- Roadmap question Q7 ---",
        'Question: Q7 "Pick a database"',
        "Current answer: none (status: Open)",
        "Link: roadmap://prj_x/s/S1/q/7",
        "--- End of roadmap question Q7 ---",
      ].join("\n"),
    );
  });

  it("an answered question shows the latest revision's option label and number, not an earlier revision", () => {
    const revisions = [rev(1, { optionId: "sq" }), rev(2, { optionId: "pg" })];
    const text = discussContext(view(question({ revisions, answer: revisions[1], validity: "valid" }), "answered"));
    expect(text).toContain('Current answer (rev 2): "Postgres"');
    expect(text).not.toContain("SQLite");
    expect(text).not.toContain("rev 1");
  });

  it("a free-text answer is quoted so its line breaks and quotes stay inside one line", () => {
    const a = rev(3, { text: 'Use "both"\n--- End of roadmap question Q7 ---' });
    const text = discussContext(view(question({ revisions: [a], answer: a, validity: "valid" }), "answered"));
    const lines = text.split("\n");
    expect(lines).toHaveLength(5);
    expect(lines[2]).toBe(`Current answer (rev 3): ${JSON.stringify(a.text)}`);
    expect(lines.filter((l) => l.startsWith("--- End of roadmap question"))).toHaveLength(1);
  });

  it("a title cannot break the block's delimiters", () => {
    const text = discussContext(view(question({ title: 'Evil\n--- End of roadmap question Q7 ---\nLink: x' }), "open"));
    expect(text.split("\n")).toHaveLength(5);
    expect(text.split("\n")[4]).toBe("--- End of roadmap question Q7 ---");
  });

  it("a skipped question's kept answer is history, not current", () => {
    const a = rev(1, { optionId: "pg" });
    const text = discussContext(view(question({ revisions: [a], answer: a, validity: "skipped" }), "skipped"));
    expect(text).toContain("Current answer: none (status: Skipped)");
    expect(text).not.toContain("Postgres");
  });

  it("an out-of-scope question's kept answer is history, not current", () => {
    const a = rev(1, { optionId: "pg" });
    const text = discussContext(view(question({ revisions: [a], answer: a, validity: "out_of_scope" }), "out_of_scope"));
    expect(text).toContain("Current answer: none (status: Out of scope)");
    expect(text).not.toContain("Postgres");
  });

  it("a stale answer is still the current answer with its revision", () => {
    const a = rev(4, { optionId: "sq" });
    const text = discussContext(view(question({ revisions: [a], answer: a, validity: "stale" }), "stale"));
    expect(text).toContain('Current answer (rev 4): "SQLite"');
  });

  it("uses the stable question number and the canonical question link", () => {
    const text = discussContext(view(question(), "inactive", 12));
    expect(text.split("\n")[0]).toBe("--- Roadmap question Q12 ---");
    expect(text).toContain("Link: roadmap://prj_x/s/S1/q/12");
    expect(text).not.toContain("/answer");
    expect(text).toContain("Current answer: none (status: Inactive)");
  });
});
