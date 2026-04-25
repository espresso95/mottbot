# Code Quality

This repo uses TypeScript strict mode, ESLint, and Prettier as the local quality gate.

## Commands

Run these before submitting TypeScript or docs changes:

```bash
pnpm verify
```

Use Prettier to apply formatting:

```bash
pnpm format
```

Logic changes should also run the relevant Vitest target, usually:

```bash
pnpm test
```

Audit exported production symbols for missing TSDoc:

```bash
pnpm tsdoc:audit -- --strict
```

Check local Markdown links:

```bash
pnpm docs:check
```

Check for circular TypeScript imports:

```bash
pnpm deps:cycles
```

Check for unused files, dependencies, and unlisted package use:

```bash
pnpm knip
```

## ESLint

The ESLint flat config in `eslint.config.js` applies type-aware TypeScript rules to `src/**/*.ts`, `scripts/**/*.ts`, `test/**/*.ts`, and `vitest.config.ts`.

Production code keeps stricter safety rules than tests:

- no production `any`
- no unhandled promises
- no unsafe async callback usage
- consistent type imports
- valid TSDoc syntax

Tests intentionally allow common mock and fixture patterns such as `any` casts and empty test-double methods.

ESLint also enforces module-boundary rules where the current architecture has clear ownership:

- `src/shared/*` stays independent from runtime and domain modules
- `src/db/*` depends only on storage-local code and shared infrastructure
- `src/codex/*` stays isolated from Telegram, sessions, project tasks, CLI workers, and worktrees
- Telegram runtime helpers stay free of Codex, project-task, and worktree orchestration imports
- worktree helpers stay reusable Git/filesystem utilities
- the reusable Codex CLI service and JSONL parser stay independent from app runtime modules

Command and orchestration files still own some cross-module wiring, so boundary rules are intentionally scoped to the seams that are enforceable without a broader refactor.

## Formatting

Prettier is configured by `.prettierrc.json` with a 120-column print width to match the current code shape. `.prettierignore` excludes generated output, local runtime state, patches, lockfiles, local env files, and SQLite artifacts.

## TSDoc

Use TSDoc where it carries contract information that is not obvious from the type or name:

- exported classes, functions, and constants that form a module boundary
- callbacks, handlers, and store methods with side effects or persistence behavior
- runtime assumptions, limits, security behavior, or operator-visible failure modes
- non-obvious private helpers that encode policy or parsing rules

Avoid comments that only restate an identifier. Prefer readable names and small helpers for local variables and straightforward code.

`pnpm tsdoc:audit` scans `src/**/*.ts` and reports exported symbols without a leading TSDoc comment. The CI gate uses `pnpm tsdoc:audit -- --strict` so newly exported production symbols need TSDoc before merge.

## Repository Hygiene

`pnpm docs:check` scans checked-in Markdown files and fails on broken local links.

`pnpm deps:cycles` scans production, script, and test TypeScript entrypoints with Madge and fails on circular imports.

`pnpm knip` is configured for high-signal hygiene checks: unused files, unused dependencies, unlisted dependencies, unresolved imports, and missing binaries. Export-level checks stay out of the default command because many exported types are intentional module-boundary contracts.

The Knip config intentionally ignores the direct `punycode` dependency. The patched `whatwg-url` transitive package resolves `punycode/` at runtime, so package validation needs it even though application source does not import it directly.

## Naming

Use domain-specific names at module boundaries: `sessionKey`, `chatId`, `profileId`, `toolName`, and similar terms are preferred over vague placeholders. Short names are acceptable only for narrow, conventional scopes such as array callbacks or local parser internals.
