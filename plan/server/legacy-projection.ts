// Read-side projection of a legacy (schema v1) generation into the v2 in-memory view (plan §1).
// Sessions and plans are carried over as they are: no legacy marker is added (they are derived
// from absent fields), so the next commit writes their exact bytes again.
import { deepClone } from "../shared/canonical";
import type { RoadmapDataV1, RoadmapDataV2 } from "../shared/model";

/** Pure: the input is not mutated and the result shares no objects with it. */
export function projectV1(data: RoadmapDataV1): RoadmapDataV2 {
  const v1 = deepClone(data);
  return {
    meta: { ...v1.meta, version: 2, featureIds: [], runIds: [], settings: {} },
    sessions: v1.sessions,
    plans: v1.plans,
    features: [],
    runs: [],
    delegations: [],
  };
}
