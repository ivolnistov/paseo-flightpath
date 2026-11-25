import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["server/**/*.test.ts", "shared/**/*.test.ts", "client/**/*.test.ts"],
    // Many suites are integration tests with fsync-backed temp stores and real loopback HTTP
    // (MCP endpoint, SDK client, fake SnailOrbit). An unbounded pool (one worker per file) starved
    // them past the 5 s default. Four workers also proved too many: on the development host the
    // multi-store tests repeatedly exceeded 5 s under four-worker parallel load, while full
    // runs with two workers stayed green. Two workers is the standard cap; timeouts are unchanged.
    maxWorkers: 2,
  },
});
