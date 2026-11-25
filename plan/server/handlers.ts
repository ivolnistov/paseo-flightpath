import type { PaseoApi } from "@getpaseo/client";
import type { PluginRpcContract } from "@getpaseo/plugin";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import {
  LinkCreate,
  LinkDelete,
  QuestionAnswer,
  QuestionConfirm,
  QuestionCreate,
  QuestionDiscuss,
  QuestionSkip,
  QuestionUpdate,
  RelationAdd,
  RelationRemove,
  RoadmapInit,
  RoadmapOverview,
  RoadmapVersion,
  SessionCreate,
  SessionGet,
} from "../shared/rpc";
import { BlockAccept } from "../shared/rpc-blocks";
import { DecisionCancel } from "../shared/rpc-decisions";
import { QuestionOutOfScope, SessionFinish } from "../shared/rpc-discussion";
import { SessionLanguageNoticeAck, SessionPlannerSet, SessionReopen } from "../shared/rpc-grilling";
import type { createPaseoHolder } from "./paseo-holder";
import type { RoadmapService } from "./sessions";

/**
 * Contract → service method; covers every STAGE1_CONTRACTS entry, block acceptance, decision
 * cancellation, the automatic-grilling planner binding and reopen, out-of-scope marks and Finish.
 */
const ROUTES: Array<[PluginRpcContract, keyof RoadmapService]> = [
  [RoadmapVersion, "version"],
  [RoadmapInit, "init"],
  [RoadmapOverview, "overview"],
  [SessionGet, "sessionGet"],
  [SessionCreate, "sessionCreate"],
  [QuestionCreate, "questionCreate"],
  [QuestionUpdate, "questionUpdate"],
  [QuestionAnswer, "questionAnswer"],
  [QuestionConfirm, "questionConfirm"],
  [QuestionSkip, "questionSkip"],
  [QuestionOutOfScope, "questionOutOfScope"],
  [QuestionDiscuss, "questionDiscuss"],
  [RelationAdd, "relationAdd"],
  [RelationRemove, "relationRemove"],
  [LinkCreate, "linkCreate"],
  [LinkDelete, "linkDelete"],
  [BlockAccept, "blockAccept"],
  [DecisionCancel, "decisionCancel"],
  [SessionPlannerSet, "plannerSet"],
  [SessionReopen, "sessionReopen"],
  [SessionLanguageNoticeAck, "sessionLanguageNoticeAck"],
  [SessionFinish, "sessionFinish"],
];

export function registerHandlers(
  server: Pick<PluginServerContext, "handle">,
  service: RoadmapService,
  holder?: ReturnType<typeof createPaseoHolder>,
): void {
  for (const [contract, method] of ROUTES) {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- heterogeneous SDK contract dispatch; the generic handler cannot type each method
    const call = service[method] as (paseo: PaseoApi, input: unknown) => Promise<unknown>;
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- heterogeneous SDK contract dispatch; the generic handler cannot type each method
    server.handle(contract, ((input: unknown, context: { paseo: PaseoApi }) => {
      holder?.set(context.paseo);
      return call(context.paseo, input);
    }) as never);
  }
}
