# Tool Use Design

## Purpose

Mottbot can execute the initial read-only model tool set through the Codex provider boundary. The runtime remains deny-by-default: side-effecting tools are defined only as disabled placeholders until approval UX, audit persistence, and runbooks are implemented.

## Current State

Implemented:

- transcript roles include a reserved `tool` value
- prompts filter tool messages out of deterministic summaries
- run orchestration already owns one model turn from queue claim through final Telegram delivery
- a static deny-by-default tool registry exists in `src/tools/registry.ts`
- the registry exposes only enabled read-only tool declarations
- disabled side-effecting tool definitions are accepted but not exposed or resolvable
- tool declarations sent to the model
- provider-specific tool-call parsing in `src/codex/tool-calls.ts`
- read-only tool execution in `src/tools/executor.ts`
- provider-native tool result continuation inside the active model turn
- tool call and result metadata persisted as `tool` transcript rows
- Telegram status updates while tools are prepared, executed, completed, or failed
- side-effect approval prompt, decision, expiration, and audit-record types in `src/tools/approval.ts`

Not implemented:

- persistent approval storage for side-effecting tools
- execution of local-write, network, process-control, or secret-adjacent tools
- arbitrary sandboxed plugin execution

## Safety Requirements

Tool execution must be deny-by-default.

Required controls:

- static allowlist of tool names and schemas
- per-tool side-effect classification: read-only, local write, network, process control, or secret-adjacent
- maximum tool-call count per model turn
- timeout and output-size limits per tool call
- no environment dumps, raw credential reads, or arbitrary shell by default
- no automatic execution of side-effecting tools without explicit operator opt-in
- token-free logs and transcript records

## Proposed Runtime Shape

Keep ownership boundaries narrow:

- `src/runs/*` owns tool-call orchestration within a model turn
- `src/codex/*` owns provider-specific tool-call transport details
- `src/telegram/*` owns approval and result notifications
- a new `src/tools/*` module owns tool definitions, validation, execution, and result normalization

The first implementation supports read-only tools only. Side-effecting tools remain designed but disabled until approval UX and audit logging are complete.

## Initial Tool Registry

The current registry is sent to the model only for enabled read-only tools. The executor resolves every requested tool through the registry again before execution.

Enabled read-only tools:

| Tool | Side effect | Input schema | Purpose |
| --- | --- | --- | --- |
| `mottbot_health_snapshot` | `read_only` | empty object, no additional properties | Return a token-free runtime health snapshot. |

Disabled reserved tools:

| Tool | Side effect | Status | Reason |
| --- | --- | --- | --- |
| `mottbot_restart_service` | `process_control` | disabled | Requires explicit operator approval UX and audit logging before use. |

Registry behavior:

- unknown tool names are rejected
- disabled tool names are rejected
- enabled tools with side effects are rejected at registry construction time
- input payloads are validated against the declared JSON-schema subset before execution

## Runtime Behavior

- `CodexTransport` converts registry declarations into `@mariozechner/pi-ai` tool declarations.
- Streamed `toolcall_start`, `toolcall_delta`, and `toolcall_end` events are normalized in `src/codex/*`; malformed or incomplete events are ignored rather than executed.
- `RunOrchestrator` allows up to three tool rounds and five tool calls per run.
- `ToolExecutor` executes registry-approved read-only tools only, with per-tool timeout and output-size limits.
- Tool results are sent back to the provider as `toolResult` messages in the same active turn.
- Persisted `tool` transcript rows contain tool name, call ID, arguments, elapsed time, byte count, truncation status, and error code when present. They do not store credentials or raw auth payloads.
- Historical prompt construction excludes persisted `tool` rows; tool results are replayed only in the active provider continuation where the call ID is valid.
- Telegram shows short status updates such as `Preparing tool`, `Running tool`, and completion/failure state. The final assistant response remains model-authored.

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

Status: complete for design. Side-effecting execution remains disabled.

Deliverables:

- Define approval prompts for local writes, network calls, and process-control tools.
- Add expiration for pending approvals.
- Add audit records for approved and denied calls.
- Keep side-effecting tools disabled until approval tests and runbooks exist.

## Non-Goals For The First Tool Phase

- arbitrary shell execution
- plugin marketplace loading
- remote MCP server execution
- multi-user public bot tooling
- background autonomous task loops
- tools that read local credentials or secret files
