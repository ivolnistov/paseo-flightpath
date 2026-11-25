import type { PluginRpcContract, PluginSubscriptionContract } from "@getpaseo/plugin";
import type { PaseoApi } from "@getpaseo/client";
import type { z, ZodType } from "zod";
import { PipelineError } from "../shared/errors";
import {
  jobAccept,
  jobApprove,
  jobChanges,
  jobRequestChanges,
  jobRetry,
  jobStop,
  reworkGrant,
  runCancel,
  runGet,
  runList,
  runPause,
  runPreview,
  runResume,
  runRetryStop,
  runStart,
  runWatch,
  workflowChatOpen,
  type RunDetail,
  type RunError,
  STORE_ERROR_CODES,
  workflowDraftDiscard,
  workflowDraftEdit,
  workflowDraftSetText,
  workflowGet,
  workflowProposalApply,
  workflowProposalDiscard,
  workflowSave,
  type EditOpSchema,
  type RpcError,
  type StoreErrorCode,
  type ViewResult,
  type WorkflowView,
} from "../shared/rpc";
import type { EditOp } from "./workflow-edit";
import { RunServiceError, type RunService } from "./run-service";
import { WorkflowConflictError, WorkflowInvalidError, type WorkflowStore } from "./workflow-store";

type WireEditOp = z.output<typeof EditOpSchema>;
/** Compile-time proof that every wire edit operation is an editor operation. */
export const editOpInSync: WireEditOp extends EditOp ? true : never = true;

const KNOWN_CODES: ReadonlySet<string> = new Set(STORE_ERROR_CODES);

function isStoreCode(code: string): code is StoreErrorCode {
  return KNOWN_CODES.has(code);
}

/** Maps a refusal to its wire form; anything unexpected becomes `internal` and is logged. */
export function toRpcError(error: unknown, log: (message: string) => void): RpcError {
  if (error instanceof WorkflowConflictError) return { code: "workflow_conflict", message: error.message, current: error.current };
  if (error instanceof WorkflowInvalidError) return { code: "workflow_invalid", message: error.message, diagnostics: error.diagnostics };
  if (error instanceof PipelineError && isStoreCode(error.code) && error.code !== "internal") return { code: error.code, message: error.message };
  log(`workflow store failure: ${error instanceof Error ? `${error.name}: ${error.message}` : "unknown error"}`);
  return { code: "internal", message: "The workflow store failed." };
}

/** The part of the server context that registers RPC handlers. */
export interface RpcRegistrar {
  handle<I extends ZodType, O extends ZodType>(contract: PluginRpcContract<I, O>, handler: (input: z.output<I>) => z.input<O> | Promise<z.input<O>>): void;
}

export type HandlerOptions = {
  log: (message: string) => void;
  /** Settles once host settings have been read, so no request uses a stale data directory. */
  ready?: Promise<unknown>;
};

export function registerWorkflowHandlers(server: RpcRegistrar, store: WorkflowStore, options: HandlerOptions): void {
  const { log } = options;
  const result = async (work: () => Promise<WorkflowView>): Promise<ViewResult> => {
    try {
      await options.ready;
      return { ok: true, value: await work() };
    } catch (error) {
      return { ok: false, error: toRpcError(error, log) };
    }
  };
  server.handle(workflowGet, ({ projectId }) => result(() => store.get(projectId)));
  server.handle(workflowDraftSetText, ({ projectId, editableDigest, yaml }) => result(() => store.setDraftText(projectId, { editableDigest, yaml })));
  server.handle(workflowDraftEdit, ({ projectId, editableDigest, op }) => result(() => store.editDraft(projectId, { editableDigest, op })));
  server.handle(workflowDraftDiscard, ({ projectId, editableDigest }) => result(() => store.discardDraft(projectId, { editableDigest })));
  server.handle(workflowSave, ({ projectId, savedDigest, draftDigest }) => result(() => store.save(projectId, { savedDigest, draftDigest })));
  server.handle(workflowProposalApply, ({ projectId, proposalId, editableDigest }) =>
    result(() => store.applyProposal(projectId, { proposalId, editableDigest })),
  );
  server.handle(workflowProposalDiscard, ({ projectId, proposalId }) => result(() => store.discardProposal(projectId, { proposalId })));
}

/** The part of the server context that registers RPC handlers and subscriptions with their host context. */
export interface RunRegistrar {
  handle<I extends ZodType, E extends ZodType>(
    contract: PluginSubscriptionContract<I, E>,
    handler: (input: z.output<I>, context: { paseo: PaseoApi; push(event: z.input<E>): Promise<void>; signal: AbortSignal }) => void | Promise<void>,
  ): void;
  handle<I extends ZodType, O extends ZodType>(contract: PluginRpcContract<I, O>, handler: (input: z.output<I>, context: { paseo: PaseoApi }) => z.input<O> | Promise<z.input<O>>): void;
}

export type RunHandlerOptions = {
  log: (message: string) => void;
  /** Settles once settings are read and Pipeline state is ready. */
  ready: () => Promise<RunService>;
  /** Supplies the host SDK of each context; recovery runs before the first scheduling. */
  onContext: (paseo: PaseoApi) => Promise<void>;
  subscribe: (runId: string, listener: () => void) => () => void;
};

const RUN_CODES_PASSED = new Set(["run_not_found", "unsafe_path", "journal_corrupt", "snapshot_corrupt", "run_faulted", "event_invalid"]);

/** Maps a run refusal to its wire form; unexpected failures become `internal` and are logged. */
export function toRunError(error: unknown, log: (message: string) => void): RunError {
  if (error instanceof RunServiceError) return { code: error.code, message: error.message, ...(error.diagnostics && error.diagnostics.length > 0 ? { diagnostics: error.diagnostics } : {}) };
  if (error instanceof PipelineError && RUN_CODES_PASSED.has(error.code)) return { code: error.code, message: error.message };
  log(`run operation failure: ${error instanceof Error ? `${error.name}: ${error.message}` : "unknown error"}`);
  return { code: "internal", message: "The run operation failed." };
}

export function registerRunHandlers(server: RunRegistrar, options: RunHandlerOptions): void {
  const { log } = options;
  const run = async <T>(paseo: PaseoApi, work: (service: RunService) => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: RunError }> => {
    try {
      const service = await options.ready();
      await options.onContext(paseo);
      return { ok: true, value: await work(service) };
    } catch (error) {
      return { ok: false, error: toRunError(error, log) };
    }
  };
  server.handle(runPreview, ({ projectId, inputs }, { paseo }) => run(paseo, (service) => service.preview(projectId, inputs)));
  server.handle(runStart, ({ projectId, inputs, workflowDigest, startKey }, { paseo }) => run(paseo, (service) => service.start(projectId, { inputs, workflowDigest, startKey })));
  server.handle(runList, ({ projectId }, { paseo }) => run(paseo, async (service) => ({ runs: await service.list(projectId) })));
  server.handle(runGet, ({ runId }, { paseo }) => run(paseo, (service) => service.get(runId)));
  server.handle(runPause, ({ runId }, { paseo }) => run(paseo, (service) => service.pause(runId)));
  server.handle(runResume, ({ runId }, { paseo }) => run(paseo, (service) => service.resume(runId)));
  server.handle(runCancel, ({ runId }, { paseo }) => run(paseo, (service) => service.cancel(runId)));
  server.handle(runRetryStop, ({ runId }, { paseo }) => run(paseo, (service) => service.retryStop(runId)));
  server.handle(jobStop, ({ runId, jobId }, { paseo }) => run(paseo, (service) => service.stopJob(runId, jobId)));
  server.handle(jobRetry, ({ runId, jobId, target }, { paseo }) => run(paseo, (service) => service.retryJob(runId, jobId, target)));
  server.handle(jobAccept, ({ runId, jobId, cycleId, criteria }, { paseo }) => run(paseo, (service) => service.acceptJob(runId, jobId, cycleId, criteria)));
  server.handle(jobApprove, ({ runId, jobId, cycleId }, { paseo }) => run(paseo, (service) => service.approveJob(runId, jobId, cycleId)));
  server.handle(jobRequestChanges, ({ runId, jobId, note, taskIds }, { paseo }) => run(paseo, (service) => service.requestChanges(runId, jobId, note, taskIds)));
  server.handle(reworkGrant, ({ runId, jobId }, { paseo }) => run(paseo, (service) => service.grantReturn(runId, jobId)));
  server.handle(jobChanges, ({ runId, jobId }, { paseo }) => run(paseo, (service) => service.changes(runId, jobId)));
  server.handle(workflowChatOpen, ({ projectId, workspaceId, model }, { paseo }) => run(paseo, (service) => service.openChat(projectId, workspaceId, model)));

  // The returned promise settles only on abort after a successful start, so the subscription stays
  // open until release; a failed start rejects it, which closes the subscription with that error.
  server.handle(runWatch, ({ runId }, { paseo, push, signal }) => {
    let sending = false;
    let again = false;
    let service: RunService | null = null;
    const send = async (): Promise<void> => {
      if (service === null) return;
      if (sending) {
        again = true;
        return;
      }
      sending = true;
      try {
        do {
          again = false;
          if (signal.aborted) return;
          const detail: RunDetail = await service.get(runId);
          await push(detail);
        } while (again);
      } catch (error) {
        log(`run.watch push failed: ${error instanceof Error ? error.message : "unknown error"}`);
      } finally {
        sending = false;
      }
    };
    const start = async (): Promise<void> => {
      service = await options.ready();
      await options.onContext(paseo);
      if (signal.aborted) return;
      const unsubscribe = options.subscribe(runId, () => void send());
      signal.addEventListener("abort", unsubscribe, { once: true });
      await send();
    };
    return start().then(
      () =>
        new Promise<void>((resolve) => {
          if (signal.aborted) resolve();
          else signal.addEventListener("abort", () => resolve(), { once: true });
        }),
      (error: unknown) => {
        log(`run.watch failed: ${error instanceof Error ? error.message : "unknown error"}`);
        throw error;
      },
    );
  });
}
