import js from "@eslint/js";
import prettier from "eslint-config-prettier";
import tsdoc from "eslint-plugin-tsdoc";
import globals from "globals";
import tseslint from "typescript-eslint";

const relativeImportRoots = ["..", "../..", "../../..", "../../../..", "../../../../.."];

const boundaryImportPatterns = (moduleNames) =>
  relativeImportRoots.flatMap((root) =>
    moduleNames.flatMap((moduleName) => [`${root}/${moduleName}`, `${root}/${moduleName}/**`]),
  );

const restrictedBoundaryImports = (moduleNames, message) => ({
  "no-restricted-imports": [
    "error",
    {
      patterns: [
        {
          group: boundaryImportPatterns(moduleNames),
          message,
        },
      ],
    },
  ],
});

export default tseslint.config(
  {
    ignores: [
      "coverage/**",
      "data/**",
      "dist/**",
      "node_modules/**",
      "patches/**",
      ".vitest/**",
      "mottbot.config.json",
      "*.sqlite",
      "*.sqlite-*",
      "*.session",
      "*.log",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    files: ["src/**/*.ts", "scripts/**/*.ts", "test/**/*.ts", "vitest.config.ts"],
    languageOptions: {
      globals: {
        ...globals.node,
      },
      parserOptions: {
        project: "./tsconfig.eslint.json",
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      tsdoc,
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": [
        "error",
        {
          fixStyle: "inline-type-imports",
          prefer: "type-imports",
        },
      ],
      "@typescript-eslint/no-confusing-void-expression": [
        "error",
        {
          ignoreArrowShorthand: true,
        },
      ],
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": [
        "error",
        {
          checksVoidReturn: false,
        },
      ],
      "@typescript-eslint/no-redundant-type-constituents": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
        },
      ],
      "@typescript-eslint/array-type": "off",
      "@typescript-eslint/consistent-type-definitions": "off",
      "@typescript-eslint/no-unnecessary-condition": "off",
      "@typescript-eslint/prefer-nullish-coalescing": "off",
      "@typescript-eslint/require-await": "off",
      "@typescript-eslint/restrict-template-expressions": "off",
      "no-console": "off",
      "no-control-regex": "off",
      "tsdoc/syntax": "error",
    },
  },
  {
    files: ["src/shared/**/*.ts"],
    rules: restrictedBoundaryImports(
      [
        "app",
        "codex",
        "codex-cli",
        "db",
        "models",
        "ops",
        "project-tasks",
        "runs",
        "sessions",
        "telegram",
        "tools",
        "worktrees",
      ],
      "Shared utilities must stay runtime-agnostic. Move domain behavior out of src/shared or pass it in from the caller.",
    ),
  },
  {
    files: ["src/db/**/*.ts"],
    rules: restrictedBoundaryImports(
      [
        "app",
        "codex",
        "codex-cli",
        "models",
        "ops",
        "project-tasks",
        "runs",
        "sessions",
        "telegram",
        "tools",
        "worktrees",
      ],
      "Database helpers should only depend on storage-local code and shared infrastructure.",
    ),
  },
  {
    files: ["src/codex/**/*.ts"],
    rules: restrictedBoundaryImports(
      ["codex-cli", "project-tasks", "sessions", "telegram", "worktrees"],
      "Codex provider code must not depend on Telegram, session, project-task, CLI-worker, or worktree orchestration modules.",
    ),
  },
  {
    files: [
      "src/telegram/acl.ts",
      "src/telegram/attachments.ts",
      "src/telegram/bot.ts",
      "src/telegram/file-extraction.ts",
      "src/telegram/formatting.ts",
      "src/telegram/governance.ts",
      "src/telegram/message-store.ts",
      "src/telegram/outbox.ts",
      "src/telegram/reactions.ts",
      "src/telegram/route-resolver.ts",
      "src/telegram/safety.ts",
      "src/telegram/types.ts",
      "src/telegram/update-normalizer.ts",
      "src/telegram/update-store.ts",
    ],
    rules: restrictedBoundaryImports(
      ["codex", "codex-cli", "project-tasks", "worktrees"],
      "Telegram runtime modules should stay transport-focused. Keep Codex and project-task orchestration behind command or app wiring.",
    ),
  },
  {
    files: ["src/worktrees/**/*.ts"],
    rules: restrictedBoundaryImports(
      ["app", "codex", "codex-cli", "db", "models", "ops", "project-tasks", "runs", "sessions", "telegram", "tools"],
      "Worktree helpers should stay reusable Git/filesystem utilities.",
    ),
  },
  {
    files: ["src/codex-cli/codex-cli-service.ts", "src/codex-cli/codex-jsonl-parser.ts"],
    rules: restrictedBoundaryImports(
      ["app", "db", "models", "ops", "project-tasks", "runs", "sessions", "telegram", "tools", "worktrees"],
      "Codex CLI service and parser code should stay reusable and independent of app runtime modules.",
    ),
  },
  {
    files: ["test/**/*.ts"],
    rules: {
      "@typescript-eslint/consistent-type-imports": "off",
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/no-base-to-string": "off",
      "@typescript-eslint/no-empty-function": "off",
      "@typescript-eslint/no-unnecessary-type-assertion": "off",
      "@typescript-eslint/prefer-promise-reject-errors": "off",
      "@typescript-eslint/unbound-method": "off",
    },
  },
  prettier,
);
