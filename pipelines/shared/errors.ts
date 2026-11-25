import type { Diagnostic } from "./workflow";

export const WORKFLOW_CODES = [
  "yaml_syntax",
  "unknown_key",
  "duplicate_key",
  "value_invalid",
  "job_id_invalid",
  "needs_unknown",
  "needs_cycle",
  "needs_self",
  "uses_unknown",
  "with_unknown",
  "with_type",
  "input_type_invalid",
  "output_type_invalid",
  "ref_not_in_needs",
  "ref_unknown_output",
  "ref_unknown_input",
  "ref_type",
  "expression_unsupported",
  "run_tasks_multiple",
  "rework_target_not_ancestor",
  "rework_on_wrong_job",
  "criterion_unverified",
  "acceptance_invalid",
  "matrix_keys",
  "matrix_ref_not_list",
  "matrix_uses_unsupported",
  "matrix_outputs_unsupported",
  "matrix_empty",
  "matrix_too_large",
  "matrix_invalid",
  "command_shell_ref",
  "command_exec_ref",
  "command_argv_invalid",
] as const;

export const START_CODES = [
  "input_missing",
  "input_type",
  "tasks_schema",
  "tasks_duplicate_id",
  "tasks_unknown_need",
  "tasks_cycle",
  "tasks_empty",
  "tasks_reviewer_missing",
] as const;

export type WorkflowCode = (typeof WORKFLOW_CODES)[number];
export type StartCode = (typeof START_CODES)[number];
export type DiagnosticCode = WorkflowCode | StartCode;

/** An operation failure with a stable code. */
export class PipelineError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "PipelineError";
    this.code = code;
  }
}

/** A refusal that carries positioned diagnostics. */
export class DiagnosticsError extends PipelineError {
  readonly diagnostics: Diagnostic[];

  constructor(diagnostics: Diagnostic[]) {
    const first = diagnostics[0];
    super(first?.code ?? "invalid", first?.message ?? "Validation failed.");
    this.name = "DiagnosticsError";
    this.diagnostics = diagnostics;
  }
}
