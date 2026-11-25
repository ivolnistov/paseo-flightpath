// Per-project critical section (R4 final review c0082): a cancel's approval-receipt check plus its
// transaction and an approval's checks, receipt publication and copy run one at a time per project in
// this plugin process. A separate registry from the store lock, which `transact` takes inside a section.
import type { Store } from "./store";

/** Runs `run` alone among callers with the same key; unrelated keys run in parallel. Not re-entrant. */
export type ProjectSection = <T>(key: string, run: () => Promise<T>) => Promise<T>;

/** A fresh, independent registry. A rejection releases the key and reaches its own caller unchanged. */
export function createProjectSection(): ProjectSection {
  const tails = new Map<string, Promise<unknown>>();
  return <T>(key: string, run: () => Promise<T>): Promise<T> => {
    const previous = tails.get(key) ?? Promise.resolve();
    const next = previous.then(run, run);
    const tail = next.catch(() => undefined);
    tails.set(key, tail);
    void tail.then(() => {
      if (tails.get(key) === tail) tails.delete(key);
    });
    return next;
  };
}

/** The process-wide default shared by every feature and plan command or service instance. */
export const projectSection: ProjectSection = createProjectSection();

/** The section key: the store's normalised realpath root plus the project id. */
export function projectSectionKey(store: Pick<Store, "storeRoot" | "projectId">): string {
  return `${store.storeRoot}\u0000${store.projectId}`;
}
