// Effective DoD template (plan §1, design Q31=1): `<storeRoot>/dod template.md` when it is a
// regular non-symlink file, else project text, else global text. The first source found wins
// entirely; nothing is merged. Reads only; returned text is verbatim.
import { join } from "node:path";
import type { StoreFs } from "./fs-port";

export const DOD_TEMPLATE_FILE = "dod template.md";

export type DodTemplateSource = "file" | "project" | "global" | "none";

export interface DodTemplateOptions {
  fs: StoreFs;
  storeRoot: string;
  /** Project text from `meta.settings.dodTemplate`; used only when non-empty after trim. */
  project?: string;
  /** Global text from the host `roadmap` settings; used only when non-empty after trim. */
  global?: string;
  log: (message: string) => void;
}

/**
 * A regular file is used even when empty, so an explicit file can override inherited text. A
 * missing file falls through; any other lstat or read failure propagates rather than silently
 * selecting a different source.
 */
export async function resolveDodTemplate(opts: DodTemplateOptions): Promise<{ source: DodTemplateSource; text: string }> {
  const path = join(opts.storeRoot, DOD_TEMPLATE_FILE);
  const stat = await opts.fs.lstat(path);
  if (stat !== null) {
    if (stat.isFile() && !stat.isSymbolicLink()) return { source: "file", text: await opts.fs.readFile(path) };
    opts.log(`decision-roadmap: ignoring "${DOD_TEMPLATE_FILE}": not a regular file`);
  }
  if (opts.project !== undefined && opts.project.trim() !== "") return { source: "project", text: opts.project };
  if (opts.global !== undefined && opts.global.trim() !== "") return { source: "global", text: opts.global };
  return { source: "none", text: "" };
}
