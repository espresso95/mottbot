# Code Quality

This repo uses TypeScript strict mode, ESLint, and Prettier as the local quality gate.

## Commands

Run these before submitting TypeScript or docs changes:

```bash
pnpm check
pnpm lint
pnpm format:check
```

Use Prettier to apply formatting:

```bash
pnpm format
```

Logic changes should also run the relevant Vitest target, usually:

```bash
pnpm test
```

## ESLint

The ESLint flat config in `eslint.config.js` applies type-aware TypeScript rules to `src/**/*.ts`, `test/**/*.ts`, and `vitest.config.ts`.

Production code keeps stricter safety rules than tests:

- no production `any`
- no unhandled promises
- no unsafe async callback usage
- consistent type imports
- valid TSDoc syntax

Tests intentionally allow common mock and fixture patterns such as `any` casts and empty test-double methods.

## Formatting

Prettier is configured by `.prettierrc.json` with a 120-column print width to match the current code shape. `.prettierignore` excludes generated output, local runtime state, patches, lockfiles, local env files, and SQLite artifacts.

## TSDoc

Use TSDoc where it carries contract information that is not obvious from the type or name:

- exported classes, functions, and constants that form a module boundary
- callbacks, handlers, and store methods with side effects or persistence behavior
- runtime assumptions, limits, security behavior, or operator-visible failure modes
- non-obvious private helpers that encode policy or parsing rules

Avoid comments that only restate an identifier. Prefer readable names and small helpers for local variables and straightforward code.

## Naming

Use domain-specific names at module boundaries: `sessionKey`, `chatId`, `profileId`, `toolName`, and similar terms are preferred over vague placeholders. Short names are acceptable only for narrow, conventional scopes such as array callbacks or local parser internals.
