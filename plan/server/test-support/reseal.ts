// Hand-edits the questions of the current v2 generation and reseals it, so a test can build a store
// shaped like an older release (or a mixed one) from data written by today's commands. The
// manifest's changeToken covers the whole snapshot, so it is recomputed over the edited data;
// without that the store would read as invalid.
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { canonicalJson } from "../../shared/canonical";
import { sha256Hex } from "../hash";
import { openStore } from "../store";
import { fixedClock, isJsonObject, jsonString, nextId, readJsonObject } from "./build";

export type QuestionEdit = (question: Record<string, unknown>, sessionId: string) => void;

export async function resealQuestions(storeRoot: string, projectId: string, edit: QuestionEdit): Promise<void> {
  const read = await openStore({ storeRoot, projectId, now: fixedClock, newId: nextId }).read();
  if (read.status !== "ok") throw new Error(`expected an ok store, got ${read.status}`);
  if (read.schemaVersion !== 2) throw new Error("resealQuestions edits v2 generations only");
  const snapshot = readJsonObject(JSON.stringify(read.data));
  const sessions = snapshot.sessions;
  if (!Array.isArray(sessions)) throw new Error("snapshot without sessions");

  const decisions = join(storeRoot, ".decisions");
  const manifestPath = join(decisions, "manifest.json");
  const manifest = readJsonObject(await readFile(manifestPath, "utf8"));
  const genDir = join(decisions, "generations", jsonString(manifest, "generation"));
  for (const session of sessions) {
    if (!isJsonObject(session) || !Array.isArray(session.questions)) throw new Error("malformed session");
    const sessionId = jsonString(session, "id");
    for (const question of session.questions) {
      if (!isJsonObject(question)) throw new Error("malformed question");
      edit(question, sessionId);
    }
    await writeFile(join(genDir, "sessions", `${sessionId}.json`), canonicalJson(session));
  }
  await writeFile(manifestPath, canonicalJson({ ...manifest, changeToken: sha256Hex(canonicalJson(snapshot)) }));
}

/** Removes the stored number from every question: the shape of a store written before numbering. */
export const stripNumbers: QuestionEdit = (question) => {
  delete question.number;
};
