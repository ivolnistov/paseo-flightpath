import type { Acceptance, DoneItem } from "./workflow";

export const TASK_ID_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;
export const MAX_TASKS = 64;
export const MAX_TASKS_BYTES = 256 * 1024;

export type TaskInput = {
  id: string;
  title: string;
  description?: string;
  needs: string[];
  done: DoneItem[];
  acceptance: Acceptance;
};
