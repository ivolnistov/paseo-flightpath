/** FIFO mutual exclusion per key within this process. */
export interface KeyedLock {
  run<T>(key: string, work: () => Promise<T>): Promise<T>;
}

export function createKeyedLock(): KeyedLock {
  const tails = new Map<string, Promise<void>>();
  return {
    async run(key, work) {
      const previous = tails.get(key) ?? Promise.resolve();
      let release = (): void => undefined;
      const current = new Promise<void>((resolve) => {
        release = resolve;
      });
      const tail = previous.then(() => current);
      tails.set(key, tail);
      await previous;
      try {
        return await work();
      } finally {
        release();
        if (tails.get(key) === tail) tails.delete(key);
      }
    },
  };
}
