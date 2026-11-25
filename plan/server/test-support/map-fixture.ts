// A synthetic 40-question branching session for the Map, built from the shared test builders. Every
// id and text is synthetic. Shape:
// - session S, six blocks (b1–b5 accepted, b6 open), questions m1–m40 with 7, 7, 7, 7, 7 and 5
//   questions per block;
// - activation tree: m<i> is activated by m<floor(i/2)> on option a; m5 has a second activation by
//   m2 on options a and b (same parent, another option set; both conditions hold); m1 is activated by t1 of session T, so its
//   server depth, and every local depth, is at least 1;
// - inactive: m33 and m34 need option b of m16, m38 and m39 option c of m19, none of them chosen;
// - invalidations: m22←m3, m30←m8, m25←m4, m40←m21, m36←m11, m28←m27;
// - links: m30 informs m4 (a back edge), m10 and m11 inform each other (a two-link cycle in one
//   column), m26 supersedes m25, m5 informs T/t1, T/t2 supersedes m6, m8 informs session U (a session
//   without questions), T/t1 informs session S (a bare end naming this session), and T/t1 informs
//   T/t2 (between two other-session questions: not in this session's view);
// - m24 is a cancelled decision.
import type { Link, Question, RoadmapData, Session } from "../../shared/model";
import { answered, NOW_ISO, q } from "./build";
import { roadmapData } from "./grilling";

export const MAP_SESSION = "S";
export const OTHER_SESSION = "T";
export const EMPTY_SESSION = "U";
const abc = [
  { id: "a", label: "Option A" },
  { id: "b", label: "Option B" },
  { id: "c", label: "Option C" },
];
const BLOCK_SIZES = [7, 7, 7, 7, 7, 5];

export const blockOf = (i: number): string => {
  let n = i;
  for (let b = 0; b < BLOCK_SIZES.length; b++) {
    if (n <= BLOCK_SIZES[b]) return `b${b + 1}`;
    n -= BLOCK_SIZES[b];
  }
  throw new Error(`m${i} is outside the fixture`);
};
const ref = (questionId: string, sessionId = MAP_SESSION) => ({ sessionId, questionId });
const INACTIVE: Record<number, string> = { 33: "b", 34: "b", 38: "c", 39: "c" };
export const INACTIVE_IDS = Object.keys(INACTIVE).map((i) => `m${i}`);
const INVALIDATIONS: Array<[number, number]> = [
  [22, 3],
  [30, 8],
  [25, 4],
  [40, 21],
  [36, 11],
  [28, 27],
];

function mapQuestion(i: number): Question {
  const activatedBy =
    i === 1
      ? [{ parent: ref("t1", OTHER_SESSION), optionIds: ["a"] }]
      : [
          { parent: ref(`m${Math.floor(i / 2)}`), optionIds: [INACTIVE[i] ?? "a"] },
          ...(i === 5 ? [{ parent: ref("m2"), optionIds: ["a", "b"] }] : []),
        ];
  const invalidatedBy = INVALIDATIONS.filter(([child]) => child === i).map(([, up]) => ({ upstream: ref(`m${up}`) }));
  const base = q(`m${i}`, { order: i - 1, number: i, title: `Map question ${i}`, options: abc, blockId: blockOf(i), activatedBy, invalidatedBy });
  // Every parent (m1–m20) is answered with option a, so their option-a children are active.
  return i <= 20 ? answered(base, "a") : base;
}

export const MAP_LINKS: Link[] = [
  { id: "lk-back", kind: "informs", from: ref("m30"), to: ref("m4") },
  { id: "lk-cycle-1", kind: "informs", from: ref("m10"), to: ref("m11") },
  { id: "lk-cycle-2", kind: "informs", from: ref("m11"), to: ref("m10") },
  { id: "lk-super", kind: "supersedes", from: ref("m26"), to: ref("m25") },
  { id: "lk-out", kind: "informs", from: ref("m5"), to: ref("t1", OTHER_SESSION) },
  { id: "lk-in", kind: "supersedes", from: ref("t2", OTHER_SESSION), to: ref("m6") },
  { id: "lk-empty", kind: "informs", from: ref("m8"), to: { sessionId: EMPTY_SESSION } },
  { id: "lk-self", kind: "informs", from: ref("t1", OTHER_SESSION), to: { sessionId: MAP_SESSION } },
  { id: "lk-external", kind: "informs", from: ref("t1", OTHER_SESSION), to: ref("t2", OTHER_SESSION) },
];

export function mapRoadmap(): RoadmapData {
  const blocks: NonNullable<Session["blocks"]> = BLOCK_SIZES.map((_, b) =>
    b < BLOCK_SIZES.length - 1
      ? { id: `b${b + 1}`, order: b, state: "accepted" as const, openedAt: NOW_ISO, acceptedAt: NOW_ISO, acceptedBy: { kind: "human" as const } }
      : { id: `b${b + 1}`, order: b, state: "open" as const, openedAt: NOW_ISO },
  );
  const map: Session = {
    id: MAP_SESSION,
    title: "Map session",
    createdAt: NOW_ISO,
    status: "active",
    questions: Array.from({ length: 40 }, (_, k) => mapQuestion(k + 1)),
    blocks,
  };
  const other: Session = {
    id: OTHER_SESSION,
    title: "Other session",
    createdAt: NOW_ISO,
    status: "active",
    questions: [answered(q("t1", { order: 0, number: 1, title: "Other question 1", options: abc }), "a"), q("t2", { order: 1, number: 2, title: "Other question 2", options: abc })],
  };
  const empty: Session = { id: EMPTY_SESSION, title: "Empty session", createdAt: NOW_ISO, status: "active", questions: [] };
  const data = roadmapData([map, other, empty]);
  data.meta.links = MAP_LINKS;
  data.meta.cancellations = [{ id: "c-m24", ref: ref("m24"), reason: "Dropped", at: NOW_ISO, actor: { kind: "human" } }];
  return data;
}

/** The same session without blocks: one lane of all questions. */
export function legacyMapRoadmap(): RoadmapData {
  const data = mapRoadmap();
  const s = data.sessions.find((x) => x.id === MAP_SESSION)!;
  delete s.blocks;
  s.questions = s.questions.map(({ blockId: _b, ...rest }) => rest);
  return data;
}

/**
 * A larger synthetic session for the Map's collapse and list-first rules: `count` questions in blocks
 * of `perBlock` (the last block open), m<i> activated by m<floor(i/2)> on option a, every parent
 * answered a, so all are active; no links. Activation crosses blocks wherever a parent sits in an
 * earlier block.
 */
export function largeMapRoadmap(count: number, perBlock = 25): RoadmapData {
  const blockCount = Math.ceil(count / perBlock);
  const blocks: NonNullable<Session["blocks"]> = Array.from({ length: blockCount }, (_, b) =>
    b < blockCount - 1
      ? { id: `b${b + 1}`, order: b, state: "accepted" as const, openedAt: NOW_ISO, acceptedAt: NOW_ISO, acceptedBy: { kind: "human" as const } }
      : { id: `b${b + 1}`, order: b, state: "open" as const, openedAt: NOW_ISO },
  );
  const questions = Array.from({ length: count }, (_, k) => {
    const i = k + 1;
    const base = q(`m${i}`, {
      order: k,
      number: i,
      title: `Large question ${i}`,
      options: abc,
      blockId: `b${Math.floor(k / perBlock) + 1}`,
      activatedBy: i === 1 ? [] : [{ parent: ref(`m${Math.floor(i / 2)}`), optionIds: ["a"] }],
    });
    return i <= Math.floor(count / 2) ? answered(base, "a") : base;
  });
  return roadmapData([{ id: MAP_SESSION, title: "Large map session", createdAt: NOW_ISO, status: "active", questions, blocks }]);
}
