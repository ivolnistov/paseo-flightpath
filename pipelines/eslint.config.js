import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import globals from "globals";
import { parse } from "parse5";
import tseslint from "typescript-eslint";
import { htmlPreviewConfig } from "../tooling/eslint-html.mjs";

export default defineConfig(
  htmlPreviewConfig({
    js,
    globals,
    parse,
    // reference/ holds unchanged provenance snapshots: roadmap-combined.html is byte-identical to
    // roadmap/reference/roadmap-combined.html, which Roadmap lints, and execution-workspace.html is the
    // body-only fragment that mockups/execution.html was built from.
    ignores: ["reference/**", "dist/**"],
  }),
  // Correctness rules only. Both project configs are listed because tsconfig.json excludes the tests.
  {
    files: ["**/*.ts", "**/*.tsx", "**/*.mts"],
    extends: [tseslint.configs.base],
    languageOptions: {
      parserOptions: {
        project: ["./tsconfig.json", "./tsconfig.node.json"],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { args: "after-used", argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/no-unsafe-assignment": "error",
      "@typescript-eslint/no-unsafe-member-access": "error",
      "@typescript-eslint/no-unsafe-call": "error",
      "@typescript-eslint/no-unsafe-return": "error",
      "@typescript-eslint/no-unsafe-argument": "error",
      "@typescript-eslint/no-unsafe-type-assertion": "error",
      "@typescript-eslint/no-non-null-assertion": "error",
      "@typescript-eslint/switch-exhaustiveness-check": ["error", { considerDefaultExhaustiveForUnions: true }],
      "@typescript-eslint/no-unnecessary-type-assertion": "error",
      "@typescript-eslint/ban-ts-comment": "error",
      "no-fallthrough": "error",
    },
  },
);
