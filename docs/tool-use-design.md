# Tool Use Design

## Purpose

Mottbot can execute registry-approved model tools through the Codex provider boundary. The runtime remains deny-by-default: side-effecting tools are exposed only when the host opts in, and real side-effect execution requires a fresh session-scoped admin approval. Dry-run policy can return a preview without calling a handler.

## Current State

Implemented:

- transcript roles include a reserved `tool` value
- prompts filter tool messages out of deterministic summaries
- run orchestration already owns one model turn from queue claim through final Telegram delivery
- a static deny-by-default tool registry exists in `src/tools/registry.ts`
- the registry exposes enabled read-only declarations by default
- side-effecting tool definitions are accepted only behind explicit runtime opt-in
- tool declarations sent to the model
- provider-specific tool-call parsing in `src/codex/tool-calls.ts`
- read-only tool execution in `src/tools/executor.ts`
- provider-native tool result continuation inside the active model turn
- tool call and result metadata persisted as `tool` transcript rows
- Telegram status updates while tools are prepared, executed, completed, or failed
- persistent side-effect approval prompts, decisions, expiration, consumption, and audit records in `src/tools/approval.ts`
- admin-only Telegram approval commands through `/tool approve`, `/tool revoke`, and `/tool status`
- an opt-in delayed `mottbot_restart_service` process-control tool guarded by one-shot session-scoped approval
- admin-only bounded document reads from approved local-write roots
- opt-in local note creation, document append, and document replace under approved roots
- opt-in allowlisted local command execution under approved workspace roots
- opt-in MCP stdio bridge calls to configured servers and allowlisted MCP tools
- opt-in Telegram message and reaction tools restricted to the current chat or configured approved targets
- opt-in GitHub issue creation and issue/PR comments through the host GitHub CLI
- read-only operator diagnostics tools for service status, recent runs, recent errors, and recent logs
- per-tool runtime policies loaded from config or `MOTTBOT_TOOL_POLICIES_JSON`
- sanitized approval previews and request fingerprints for side-effecting calls
- admin `/tool audit` inspection with bounded session, tool, and decision-code filters

Not implemented:

- broader GitHub write operations beyond issue creation and issue/PR comments
- generic network-write beyond configured MCP servers
- secret-adjacent tools
- arbitrary sandboxed plugin execution

## Safety Requirements

Tool execution must be deny-by-default.

Required controls:

- static allowlist of tool names and schemas
- per-tool side-effect classification: read-only, local write, local command execution, network write, Telegram send, GitHub write, process control, or secret-adjacent
- maximum tool-call count per model turn
- timeout and output-size limits per tool call
- no environment dumps, raw credential reads, or arbitrary shell by default
- no automatic execution of side-effecting tools without explicit operator opt-in
- no side-effect execution when a tool policy is missing or denies the caller role/chat
- no reuse of a request-bound approval for a different tool argument payload
- token-free logs and transcript records

## Proposed Runtime Shape

Keep ownership boundaries narrow:

- `src/runs/*` owns tool-call orchestration within a model turn
- `src/codex/*` owns provider-specific tool-call transport details
- `src/telegram/*` owns approval and result notifications
- a new `src/tools/*` module owns tool definitions, validation, execution, and result normalization

The default runtime supports read-only tools only. Side-effecting implementations are opt-in and currently cover delayed service restart, Telegram reactions, Telegram sends, local note/document writes, allowlisted local command execution, configured MCP stdio tool calls, and GitHub issue/comment writes with admin policy, approval previews, request-bound one-shot approvals, and audit logging.

## Initial Tool Registry

The current registry is sent to the model only for enabled tools. The executor resolves every requested tool through the registry again before execution.

Enabled read-only tools:

| Tool | Side effect | Input schema | Purpose |
| --- | --- | --- | --- |
| `mottbot_health_snapshot` | `read_only` | empty object, no additional properties | Return a token-free runtime health snapshot. |
| `mottbot_service_status` | `read_only` | empty object, no additional properties | Return local launchd service status. |
| `mottbot_recent_runs` | `read_only` | optional `limit` and `sessionKey` | Return recent SQLite run records. |
| `mottbot_recent_errors` | `read_only` | optional `limit` | Return failed/cancelled runs and recent stderr lines. |
| `mottbot_recent_logs` | `read_only` | optional `stream` and `lines` | Return recent launchd stdout/stderr lines. |
| `mottbot_repo_list_files` | `read_only` | optional `root`, `path`, `recursive`, and `limit` | List files under an approved local repository root without reading contents. |
| `mottbot_repo_read_file` | `read_only` | required `path`; optional `root`, `startLine`, `maxLines`, and `maxBytes` | Read a bounded text slice from an approved local repository file. |
| `mottbot_repo_search` | `read_only` | required `query`; optional `root`, `path`, `maxMatches`, and `maxBytes` | Search literal text in approved repository files. |
| `mottbot_git_status` | `read_only` | optional `root` | Read git branch and working-tree status. |
| `mottbot_git_branch` | `read_only` | optional `root` | Read the current branch or detached commit. |
| `mottbot_git_recent_commits` | `read_only` | optional `root` and `limit` | Read recent commit summaries. |
| `mottbot_git_diff` | `read_only` | optional `root`, `path`, and `maxBytes` | Read diff stat/summary or a bounded selected-file diff. |
| `mottbot_github_repo` | `read_only` | optional `repository` | Read GitHub repository metadata through the host GitHub CLI. |
| `mottbot_github_open_prs` | `read_only` | optional `repository` and `limit` | Read open pull request summaries. |
| `mottbot_github_recent_issues` | `read_only` | optional `repository` and `limit` | Read recent open issue summaries. |
| `mottbot_github_ci_status` | `read_only` | optional `repository` and `limit` | Read recent GitHub Actions workflow runs. |
| `mottbot_github_workflow_failures` | `read_only` | optional `repository` and `limit` | Read recent failed workflow runs. |
| `mottbot_local_doc_read` | `read_only` | required `path`; optional `root` and `maxBytes` | Read a bounded `.md` or `.txt` file from an approved local-write root and return its SHA-256 for safe edits. |

Disabled reserved tools:

| Tool | Side effect | Status | Reason |
| --- | --- | --- | --- |
| `mottbot_local_note_create` | `local_write` | opt-in | Creates only new `.md` or `.txt` files under approved local-write roots; requires one-shot admin approval before execution. |
| `mottbot_local_doc_append` | `local_write` | opt-in | Appends plain text to existing `.md` or `.txt` files under approved local-write roots; requires one-shot admin approval before execution. |
| `mottbot_local_doc_replace` | `local_write` | opt-in | Replaces existing `.md` or `.txt` files under approved local-write roots only when the supplied SHA-256 matches the current file; requires one-shot admin approval before execution. |
| `mottbot_local_command_run` | `local_exec` | opt-in | Runs one host-allowlisted command in an approved workspace root without shell expansion; requires one-shot admin approval before execution. |
| `mottbot_mcp_call_tool` | `network_write` | opt-in | Calls one allowlisted tool on one configured MCP stdio server; requires one-shot admin approval before execution. |
| `mottbot_github_issue_create` | `github_write` | opt-in | Creates a GitHub issue through the host `gh` CLI; requires one-shot admin approval before execution. |
| `mottbot_github_issue_comment` | `github_write` | opt-in | Adds a GitHub issue comment through the host `gh` CLI; requires one-shot admin approval before execution. |
| `mottbot_github_pr_comment` | `github_write` | opt-in | Adds a GitHub pull request conversation comment through the host `gh` CLI; requires one-shot admin approval before execution. |
| `mottbot_telegram_send_message` | `telegram_send` | opt-in | Sends plain-text Telegram messages only to the current chat or configured approved targets; requires one-shot admin approval before execution. |
| `mottbot_restart_service` | `process_control` | opt-in | Exposed only to admin callers when `MOTTBOT_ENABLE_SIDE_EFFECT_TOOLS=true`; requires one-shot admin approval before execution. |
| `mottbot_telegram_react` | `telegram_send` | opt-in | Adds or clears Telegram reactions only after one-shot admin approval. |

Registry behavior:

- unknown tool names are rejected
- disabled tool names are rejected
- enabled tools with side effects are rejected at registry construction time unless the runtime explicitly opts into side-effect definitions
- input payloads are validated against the declared JSON-schema subset before execution
- operator diagnostics, repository, and git tools are marked admin-only even though they are read-only
- all current side-effecting tools are admin-only and require a fresh approval for real execution

## Local Write Scope

Local write tools are governed separately from general tool policy by `tools.localWrite` or the `MOTTBOT_LOCAL_WRITE_*` environment variables.

Defaults:

```json
{
  "roots": ["./data/tool-notes"],
  "deniedPaths": [],
  "maxWriteBytes": 20000
}
```

Safety rules:

- local write roots are created on startup if missing
- paths must be relative to an approved root
- only `.md` and `.txt` files can be created, read, appended, or replaced
- the note tool never overwrites existing files
- full-file replace requires a SHA-256 from `mottbot_local_doc_read`, so stale edits are rejected before writing
- parent directories are checked after realpath resolution so symlink escapes are rejected
- built-in denied paths include `.env`, config files, auth files, `.codex`, `.git`, `node_modules`, build output, database files, logs, and Telegram session files
- write output returns path, size, and checksums, not the written content

## Local Command Scope

Local command execution is governed separately from general tool policy by `tools.localExec` or the `MOTTBOT_LOCAL_EXEC_*` environment variables.

Defaults:

```json
{
  "roots": ["./data/tool-workspace"],
  "deniedPaths": [],
  "allowedCommands": [],
  "timeoutMs": 5000,
  "maxOutputBytes": 40000
}
```

Safety rules:

- no command runs unless it is listed in `allowedCommands` by exact command or executable basename
- shells and privilege-changing host commands are denied even if accidentally allowlisted
- working directories must be relative to an approved root
- traversal, denied directories, and symlink escapes are rejected before execution
- commands run with `shell:false`, ignored stdin, bounded stdout/stderr, timeout enforcement, and a minimal environment
- nonzero command exits return bounded stdout/stderr and exit metadata instead of throwing a tool infrastructure error

## MCP Stdio Bridge

MCP tool calls are governed by `tools.mcp.servers` or `MOTTBOT_MCP_SERVERS_JSON`.

Example:

```json
{
  "servers": [
    {
      "name": "docs",
      "command": "node",
      "args": ["./mcp/docs-server.mjs"],
      "allowedTools": ["search", "read"],
      "timeoutMs": 10000,
      "maxOutputBytes": 40000
    }
  ]
}
```

Safety rules:

- server names are explicit config keys, not arbitrary executable input
- each server must allow at least one named MCP tool
- the requested MCP tool must appear in that server's `allowedTools`
- shell and privilege-changing server commands are denied
- servers are started per tool call over stdio with `shell:false`, bounded stderr, timeout enforcement, and a minimal environment
- only `initialize`, `notifications/initialized`, and one `tools/call` round are supported in this first bridge
- remote MCP servers and long-lived background MCP sessions remain out of scope

## Telegram Send Scope

Telegram send tools are governed by `tools.telegramSend` or `MOTTBOT_TELEGRAM_SEND_ALLOWED_CHAT_IDS`.

Defaults:

```json
{
  "allowedChatIds": []
}
```

Safety rules:

- `mottbot_telegram_send_message` defaults to the current chat
- sending to another chat requires that target in `allowedChatIds`
- topic replies inherit the current Telegram thread when sending to the current chat
- messages are plain text only and capped by the tool schema
- the approval fingerprint includes the target chat and message text, so target or text changes cannot reuse an approval

## GitHub Write Scope

GitHub write tools use the same host GitHub CLI boundary as read tools. Mottbot does not store GitHub tokens; the process can only do what the host `gh` account is already authorized to do.

Supported writes:

- `mottbot_github_issue_create`: creates an issue with a title, optional body, and up to ten labels
- `mottbot_github_issue_comment`: comments on an existing issue by number
- `mottbot_github_pr_comment`: comments on an existing pull request by number

Safety rules:

- tools are disabled unless `MOTTBOT_ENABLE_SIDE_EFFECT_TOOLS=true`
- callers must pass admin policy checks and a matching one-shot approval
- repository identifiers must be `owner/name`; when omitted, the configured repository or local `origin` is used
- titles, bodies, labels, CLI output, and errors are sanitized for token-like text
- labels are trimmed, deduplicated, and capped before calling `gh`
- live validation should use a disposable repository or disposable issue/PR before real project use

## Repository Read Scope

Repository tools are governed separately from general tool policy by `tools.repository` or the `MOTTBOT_REPOSITORY_*` environment variables.

Defaults:

```json
{
  "roots": ["."],
  "deniedPaths": [],
  "maxReadBytes": 40000,
  "maxSearchMatches": 100,
  "maxSearchBytes": 80000,
  "commandTimeoutMs": 5000
}
```

Built-in denied paths include `.env`, `.env.*`, `mottbot.config.json`, `auth.json`, `.codex`, `.git`, `node_modules`, `data`, `dist`, `coverage`, SQLite/database files, logs, and Telegram session files.

Path safety rules:

- every requested path is resolved through `realpath`
- traversal outside an approved root is rejected
- symlinks that resolve outside an approved root are rejected
- denied paths are checked before and after realpath resolution
- file reads reject binary-looking files and return bounded line/byte slices
- search prefers `rg --json --fixed-strings` and falls back to bounded Node search when `rg` is unavailable
- git status filters denied paths before returning output

## GitHub Read Scope

GitHub tools use the host GitHub CLI as the auth boundary. Operators authenticate with `gh auth login`; Mottbot does not persist GitHub tokens or accept token values in config.

Configuration:

```json
{
  "defaultRepository": "owner/name",
  "command": "gh",
  "commandTimeoutMs": 10000,
  "maxItems": 10,
  "maxOutputBytes": 80000
}
```

Safety rules:

- GitHub tools are admin-only read-only tools.
- Repository identifiers must be `owner/name`.
- When no repository is provided, the service uses `MOTTBOT_GITHUB_REPOSITORY` or infers from local `origin`.
- Pull request, issue, and workflow lists are bounded by `maxItems`.
- CLI errors and GitHub response strings are sanitized for token-looking values before returning to Telegram or the model.
- Rate limits, missing auth, and inaccessible repositories surface as bounded tool errors rather than raw API payloads.

## Tool Policy

Every enabled tool receives a runtime policy before it can be exposed or executed.

Policy fields:

- `allowedRoles`: any of `owner`, `admin`, `trusted`, and `user`
- `allowedChatIds`: optional Telegram chat allowlist for the tool
- `requiresApproval`: read-only tools are always false; side-effecting tools always require approval for real execution
- `dryRun`: return the sanitized preview without calling the handler
- `maxOutputBytes`: output cap, never above the tool definition cap

Configuration sources:

- `tools.policies` in `mottbot.config.json`
- `MOTTBOT_TOOL_POLICIES_JSON` as a JSON object, which takes precedence over file config

Example:

```json
{
  "mottbot_health_snapshot": {
    "allowedRoles": ["owner", "admin", "trusted", "user"],
    "allowedChatIds": ["123456789"],
    "maxOutputBytes": 4000
  },
  "mottbot_restart_service": {
    "allowedRoles": ["owner", "admin"],
    "requiresApproval": true,
    "dryRun": false
  }
}
```

Admin-only tool definitions remain owner/admin-only even if policy config tries to expose them to trusted or normal users.
For side-effecting tools, `requiresApproval:false` is ignored; use `dryRun:true` to return a preview without executing a side effect.
Per-agent `toolNames` and per-chat `toolNames` governance policy further filter model-exposed tools and are rechecked immediately before tool execution. Agent `toolPolicies` can add stricter role, chat, dry-run, or output-byte limits on top of global policy.

## Runtime Behavior

- `CodexTransport` converts registry declarations into `@mariozechner/pi-ai` tool declarations.
- Streamed `toolcall_start`, `toolcall_delta`, and `toolcall_end` events are normalized in `src/codex/*`; malformed or incomplete events are ignored rather than executed.
- `RunOrchestrator` allows up to three tool rounds and five tool calls per run.
- `RunOrchestrator` filters tool declarations by caller role, selected agent, and chat policy before sending them to the model.
- `ToolExecutor` rechecks registry, schema, caller role, chat policy, timeout, and output limits immediately before execution.
- `ToolExecutor` executes side-effecting tools only when the runtime exposes them and a fresh matching approval exists for the same session. Dry-run policy returns the sanitized preview without calling the handler.
- Tool results are sent back to the provider as `toolResult` messages in the same active turn.
- Persisted `tool` transcript rows contain tool name, call ID, arguments, elapsed time, byte count, truncation status, and error code when present. They do not store credentials or raw auth payloads.
- Approval audit rows record the decision, tool, side-effect type, session, optional run, approver, reason, optional request fingerprint, and sanitized approval preview without credentials.
- Historical prompt construction excludes persisted `tool` rows; tool results are replayed only in the active provider continuation where the call ID is valid.
- Telegram shows short status updates such as `Preparing tool: <name>...`, `Running tool: <name>...`, and `Tool <name> completed. Continuing...` or `Tool <name> failed. Continuing...`. The final assistant response remains model-authored, and smoke tests treat these messages as transient.
- Telegram actions use the same side-effect policy: acknowledgement reactions are runtime-owned, while model-initiated `mottbot_telegram_react` and `mottbot_telegram_send_message` calls are admin-only and require one-shot approval.

## Approval Previews And Audit

When a side-effecting tool lacks a matching active approval, execution returns a denial with an approval preview. The preview includes:

- tool name and description
- side-effect class
- approval and dry-run status
- maximum output
- bounded JSON arguments with sensitive fields redacted

The operator can approve the latest pending request in the current session:

```text
/tool approve mottbot_restart_service planned restart
```

When a latest pending request exists, the stored approval includes the request fingerprint. A later call with different arguments cannot consume that approval.

Audit inspection:

```text
/tool audit [limit] [here] [tool:<name>] [code:<decision>]
```

`here` filters to the current session. Decision codes include `policy_allowed`, `policy_missing`, `role_denied`, `chat_denied`, `approval_required`, `approval_expired`, `approval_mismatch`, `approved`, `operator_approved`, and `revoked`.

## Phase: Tool Use Design And Safety

### Task T1: Define Tool Registry

Status: complete.

Deliverables:

- Create typed tool definitions with name, description, JSON schema, timeout, and side-effect level.
- Add a registry that rejects unknown tools.
- Add tests for schema validation, unknown tools, and disabled side-effecting tools.
- Document the initial read-only tool set.

### Task T2: Add Provider Tool-Call Boundary

Status: complete.

Deliverables:

- Determine the exact `@mariozechner/pi-ai` tool-call event shapes for the Codex provider.
- Keep provider-specific parsing in `src/codex/*`.
- Add mocked transport tests for tool-call start, arguments, completion, and malformed events.
- Ensure normal text streaming still works when no tools are requested.

### Task T3: Execute Read-Only Tools

Status: complete.

Deliverables:

- Execute only registry-approved read-only tools.
- Enforce timeout, output-size, and max-call limits.
- Persist tool call and result metadata without credentials or large raw payloads.
- Add integration tests across run orchestration and transcript persistence.

### Task T4: Add Telegram Operator UX

Status: complete.

Deliverables:

- Show when a tool call is running.
- Show concise tool results in Telegram when useful.
- Add clear failure messages for denied, timed-out, or invalid tool calls.
- Add tests for user-visible tool-call states.

### Task T5: Design Side-Effect Approval

Status: complete for the initial process-control scope.

Deliverables:

- Define approval prompts for local writes, network calls, and process-control tools.
- Add expiration for pending approvals.
- Add audit records for approved and denied calls.
- Keep side-effecting tools disabled by default unless the host opts in with `MOTTBOT_ENABLE_SIDE_EFFECT_TOOLS=true`.

## Non-Goals For The First Tool Phase

- arbitrary shell execution
- plugin marketplace loading
- remote MCP server execution
- multi-user public bot tooling
- background autonomous task loops
- tools that read local credentials or secret files
