# AGENTS.md

## Repository expectations

- Use `pnpm` for installs, scripts, and lockfile changes. Do not introduce `npm` or `yarn` artifacts.
- Keep the repo clean of generated output. Do not commit `coverage/`, `dist/`, `data/`, local `.env` variants, or SQLite database files.
- Preserve the existing module boundaries:
  - `src/telegram/*` owns Telegram ingress, commands, ACL, routing, and outbox behavior.
  - `src/codex/*` owns the subscription-backed `openai-codex` path, auth, transport, and usage logic.
  - `src/sessions/*` owns session identity, persistence, and queueing.
  - `src/runs/*` owns prompt building, orchestration, and run persistence.
- Keep TypeScript code ESM-friendly and strongly typed. Avoid `any` in production code unless it is required at an external library boundary and isolated to a small surface.
- Prefer small focused helpers over cross-module coupling. If a change alters a public runtime behavior or operator workflow, update the relevant files in `docs/`.

## Verification

- Run `pnpm check` after TypeScript changes.
- Run `pnpm test` after logic changes.
- Run `pnpm test:coverage` when changing shared runtime paths, auth flows, transport behavior, or cross-module orchestration.
- Add or update tests with behavior changes. Prefer integration tests for flows that cross SQLite stores, Telegram command routing, or Codex transport fallback behavior.

## Codex-specific guidance

- Keep undocumented Codex subscription behavior isolated to `src/codex/*`. Do not spread provider-specific assumptions into Telegram, session, or run modules.
- When changing token refresh, CLI auth import, or transport fallback behavior, cover both success and failure paths with tests.
- Do not log credentials, bearer tokens, refresh tokens, or raw auth payloads.

## Operational guidance

- Prefer host-local, single-process assumptions unless the task explicitly expands the deployment model.
- Treat schema changes in `src/db/schema.sql` as behavioral changes: keep stores, tests, and docs in sync.
- Favor operator-safe failure behavior. If a command can put the bot into a broken state, validate inputs early and return a clear error instead.
