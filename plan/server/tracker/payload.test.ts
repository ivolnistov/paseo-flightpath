// Tracker payloads (Stage 4 ruling 4, T4.2): idempotency key, provider-neutral create payload with
// its marker, and the strict wire schemas.
import { describe, expect, it } from "vitest";
import { CreatePayload, TrackerAction } from "../../shared/rpc";
import { createPayload, idempotencyKey } from "./payload";

const task = { id: "t1", title: "Ship the flag", description: "Roll out behind a flag." };
const INTENT = "01JABCDEFGHJKMNPQRSTVWXYZ0";

describe("tracker payloads", () => {
  it("idempotency key is dr:<projectId>:<planId>:<planRev>:<taskId>:<kind>", () => {
    expect(idempotencyKey("prj_test", "plan-1", 3, "t1", "create")).toBe("dr:prj_test:plan-1:3:t1:create");
    expect(idempotencyKey("prj_test", "plan-1", 3, "t1", "close")).toBe("dr:prj_test:plan-1:3:t1:close");
    expect(idempotencyKey("prj_test", "plan-1", 4, "t1", "create")).not.toBe(idempotencyKey("prj_test", "plan-1", 3, "t1", "create"));
  });

  it("createPayload keeps the task title and appends the intent marker to the description", () => {
    const key = idempotencyKey("prj_test", "plan-1", 3, "t1", "create");
    const payload = createPayload(task, INTENT, key);
    const marker = `decision-roadmap intent ${INTENT} (dr:prj_test:plan-1:3:t1:create)`;
    expect(payload).toEqual({ title: "Ship the flag", body: `Roll out behind a flag.\n\n${marker}` });
    expect(payload.body.endsWith(marker)).toBe(true);
    expect(Object.keys(payload).sort()).toEqual(["body", "title"]);
  });

  it("an empty description still carries the marker", () => {
    const payload = createPayload({ ...task, description: "" }, INTENT, "dr:p:q:1:t1:create");
    expect(payload.body).toBe(`\n\ndecision-roadmap intent ${INTENT} (dr:p:q:1:t1:create)`);
  });

  it("payloads parse with the strict CreatePayload schema; extra or oversized fields are rejected", () => {
    const payload = createPayload(task, INTENT, "dr:p:q:1:t1:create");
    expect(CreatePayload.parse(payload)).toEqual(payload);
    expect(CreatePayload.safeParse({ ...payload, labels: ["x"] }).success).toBe(false);
    expect(CreatePayload.safeParse({ ...payload, title: "" }).success).toBe(false);
    expect(CreatePayload.safeParse({ ...payload, title: "x".repeat(501) }).success).toBe(false);
    expect(CreatePayload.safeParse({ ...payload, body: "x".repeat(100_001) }).success).toBe(false);
  });

  it("TrackerAction accepts create and skip shapes", () => {
    const key = "dr:prj_test:plan-1:3:t1:create";
    const create = { actionId: "abc", intentId: INTENT, taskId: "t1", planRev: 3, kind: "create", payload: createPayload(task, INTENT, key), idempotencyKey: key, reason: null };
    expect(TrackerAction.safeParse(create).success).toBe(true);
    const skip = { actionId: null, intentId: null, taskId: "t2", planRev: 3, kind: "skip", payload: null, idempotencyKey: null, reason: "provider none" };
    expect(TrackerAction.safeParse(skip).success).toBe(true);
    expect(TrackerAction.safeParse({ ...skip, kind: "delete" }).success).toBe(false);
  });
});

// Stage R4.5a (task card §6.2): createPayload sends the task's Definition of done between the
// description and the intent marker: body = description + (dod non-empty after trim ?
// "\n\nDefinition of done:\n" + dod : "") + "\n\n" + marker. The marker stays last (recovery parses
// it); a missing or blank DoD gives the old body exactly; over length still refuses invalid_input
// with no truncation; the idempotency key is unchanged.
describe("R4.5a createPayload with the Definition of done", () => {
  const key = "dr:prj_test:plan-1:3:t1:create";
  const marker = `decision-roadmap intent ${INTENT} (${key})`;

  it("puts the DoD block between the description and the marker, the marker last", () => {
    const dod = "- [check] npm test\nDocs are updated";
    const payload = createPayload({ ...task, dod }, INTENT, key);
    expect(payload.body).toBe(`Roll out behind a flag.\n\nDefinition of done:\n${dod}\n\n${marker}`);
    expect(payload.body.endsWith(marker)).toBe(true);
    expect(payload.title).toBe("Ship the flag");
  });

  it("a missing or blank DoD gives the old body exactly", () => {
    const old = `Roll out behind a flag.\n\n${marker}`;
    expect(createPayload(task, INTENT, key).body).toBe(old);
    for (const dod of ["", "   ", "\n\t "]) expect(createPayload({ ...task, dod }, INTENT, key).body, JSON.stringify(dod)).toBe(old);
  });

  it("an over-length body (DoD included) refuses invalid_input and is never truncated", () => {
    let thrown: unknown;
    try {
      createPayload({ ...task, dod: "x".repeat(100_000) }, INTENT, key);
    } catch (e) {
      thrown = e;
    }
    expect(typeof thrown === "object" && thrown !== null && "code" in thrown ? thrown.code : undefined).toBe("invalid_input");
    const fits = createPayload({ ...task, dod: "y".repeat(1000) }, INTENT, key);
    expect(fits.body).toContain("y".repeat(1000));
  });

  it("the idempotency key and the marker format are unchanged", () => {
    expect(idempotencyKey("prj_test", "plan-1", 3, "t1", "create")).toBe(key);
    expect(createPayload({ ...task, dod: "done" }, INTENT, key).body.split("\n\n").at(-1)).toBe(marker);
  });
});
