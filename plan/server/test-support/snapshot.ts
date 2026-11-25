// Hand-written store generations, as an external editor or a bad merge would leave them.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { canonicalJson } from "../../shared/canonical";
import type { RoadmapDataV1 } from "../../shared/model";
import { sha256Hex } from "../hash";
import { NOW_ISO } from "./build";

export const emptyData = (projectId: string, sessions: RoadmapDataV1["sessions"] = []): RoadmapDataV1 => ({
  meta: {
    version: 1,
    projectId,
    createdAt: NOW_ISO,
    links: [],
    sessionIds: sessions.map((s) => s.id),
    planIds: [],
  },
  sessions,
  plans: [],
});

/** Writes `data` as generation `revision` with a matching changeToken and points the manifest at it. */
export async function writeSnapshot(root: string, data: RoadmapDataV1, revision: number): Promise<void> {
  const generation = `g-${String(revision).padStart(10, "0")}-${"7".repeat(26)}`;
  const gen = join(root, ".decisions", "generations", generation);
  await mkdir(join(gen, "sessions"), { recursive: true });
  await mkdir(join(gen, "plans"), { recursive: true });
  await writeFile(join(gen, "roadmap.json"), JSON.stringify(data.meta));
  for (const s of data.sessions) await writeFile(join(gen, "sessions", `${s.id}.json`), JSON.stringify(s));
  for (const p of data.plans) await writeFile(join(gen, "plans", `${p.id}.json`), JSON.stringify(p));
  const manifest = {
    version: 1,
    projectId: data.meta.projectId,
    revision,
    generation,
    changeToken: sha256Hex(canonicalJson(data)),
  };
  await writeFile(join(root, ".decisions", "manifest.json"), JSON.stringify(manifest));
}
