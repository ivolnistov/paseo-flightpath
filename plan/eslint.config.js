// ESLint flat config (Stage R4.5b, task card §6.4): correctness rules only, no style rules.
// Type-aware over both project tsconfigs: tsconfig.json (client and shared) and tsconfig.node.json
// (server, shared, tests and vitest config). `projectService` is not used because it picks the
// nearest tsconfig.json, which excludes the tests.
import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";

export default defineConfig(
  { ignores: ["node_modules/**", ".decisions/**", ".sdd/**", "dist/**", "eslint.config.js"] },
  {
    files: ["**/*.ts", "**/*.tsx", "**/*.mts"],
    extends: [tseslint.configs.base],
    languageOptions: {
      parserOptions: {
        project: ["./tsconfig.json", "./tsconfig.node.json"],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    linterOptions: { reportUnusedDisableDirectives: "error" },
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { args: "after-used", argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/no-unsafe-assignment": "error",
      "@typescript-eslint/no-unsafe-member-access": "error",
      "@typescript-eslint/no-unsafe-call": "error",
      "@typescript-eslint/no-unsafe-return": "error",
      "@typescript-eslint/no-unsafe-argument": "error",
      "@typescript-eslint/no-unsafe-type-assertion": "error",
      // A `default` branch is an intentional exhaustive fallback; switches without one are still checked.
      "@typescript-eslint/switch-exhaustiveness-check": ["error", { considerDefaultExhaustiveForUnions: true }],
      "@typescript-eslint/no-unnecessary-type-assertion": "error",
      "no-fallthrough": "error",
    },
  },
  // G8 (root decision, R4.5b batch 1): the six no-unsafe-* rules are off ONLY for these listed test
  // files, whose harnesses are deliberately unchecked. Everything else stays on for them, and every
  // other test file, test-support module and production file keeps the full rule set. New test
  // files are strict unless added here with a reason.
  {
    files: [
      // M: React / React Native / SDK module-mock harnesses (vi.mock + vi.hoisted any-typed slot state,
      // inert host markers, mocked SDK clients).
      "client/discussion-screen.test.ts",
      "client/dod-editor.test.ts",
      "client/feature-chat.test.ts",
      "client/feature-screen.test.ts",
      "client/grilling-blocks.test.ts",
      "client/hooks.test.ts",
      "client/panel.test.ts",
      "client/plan-view.test.ts",
      "client/question-answer-panel.test.ts",
      "client/question-card.test.ts",
      "client/question-editor.test.ts",
      "client/roadmap-screen.test.ts",
      "client/roadmap-settings.test.ts",
      "client/run-timeline-card.test.ts",
      "client/start-dialog.test.ts",
      "client/task-spec-row.test.ts",
      "client/timeline-card.test.ts",
      "client/tracker-settings.test.ts",
      "client/use-agent-timeline.test.ts",
      "server/approvals.test.ts",
      "server/index-wiring.test.ts",
      "server/mcp-startup.test.ts",
      "server/process-port.test.ts",
      // F: raw store and input fixtures typed as the documented loose `type Json = any`, used to seed,
      // tamper with and byte-compare stored records.
      "server/feature-tools.test.ts",
      "server/features.test.ts",
      "server/sessions-blocks.test.ts",
      "server/sessions-cancel.test.ts",
      "server/store-migration.test.ts",
      "shared/model.test.ts",
      // X: legacy-shape and deliberately invalid revision/task fixtures built with `as any`.
      "client/plan-format.test.ts",
      "server/plan-hash.test.ts",
      "server/plans.test.ts",
    ],
    rules: {
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-type-assertion": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-return": "off",
    },
  },
);
