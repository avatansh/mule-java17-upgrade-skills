// eslint.config.js — flat config (ESLint 9+). Lints the ES-module Node sources without a build step.
//
// Scope: our own source (lib_shared, server, skills scripts, tests). Vendored/generated trees and
// the JSON schema payloads are ignored. Rules stay deliberately light — correctness signals
// (no-unused-vars, no-undef via the Node globals) over stylistic bike-shedding, since Prettier owns
// formatting. eslint-config-prettier is applied last so no lint rule fights the formatter.

import js from "@eslint/js";
import globals from "globals";
import prettier from "eslint-config-prettier";

export default [
  {
    ignores: ["node_modules/**", "coverage/**", "**/*.min.js", ".github/**", ".agents/**"],
  },
  js.configs.recommended,
  {
    files: ["**/*.js", "**/*.mjs"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: {
        ...globals.node,
      },
    },
    rules: {
      "no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "no-var": "error",
      "prefer-const": "error",
      eqeqeq: ["error", "smart"],
      "no-console": "off",
    },
  },
  {
    // Tests use the node:test harness; allow a slightly looser surface.
    files: ["tests/**/*.js"],
    rules: {
      "no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
    },
  },
  prettier,
];
