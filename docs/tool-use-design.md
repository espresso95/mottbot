# Tool Use Design

## Purpose

Mottbot does not currently execute tools on behalf of the model. The existing runtime can talk to Telegram, persist sessions, stream Codex responses, and pass native image inputs, but there is no model-facing tool registry or executor.

This document defines the implementation phase that must happen before real tool execution is enabled.

## Current State

Implemented:

- transcript roles include a reserved `tool` value
- prompts filter tool messages out of deterministic summaries
- run orchestration already owns one model turn from queue claim through final Telegram delivery

Not implemented:

- tool declarations sent to the model
- model tool-call parsing
- allowlisted host tools
- operator approval before side-effecting tools
- execution sandboxing
- tool result persistence and replay
- Telegram UX for pending, approved, denied, or failed tool calls

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

The first implementation should support read-only tools only. Side-effecting tools should remain designed but disabled until approval UX and audit logging are complete.

## Phase: Tool Use Design And Safety

### Task T1: Define Tool Registry

Deliverables:

- Create typed tool definitions with name, description, JSON schema, timeout, and side-effect level.
- Add a registry that rejects unknown tools.
- Add tests for schema validation, unknown tools, and disabled side-effecting tools.
- Document the initial read-only tool set.

### Task T2: Add Provider Tool-Call Boundary

Deliverables:

- Determine the exact `@mariozechner/pi-ai` tool-call event shapes for the Codex provider.
- Keep provider-specific parsing in `src/codex/*`.
- Add mocked transport tests for tool-call start, arguments, completion, and malformed events.
- Ensure normal text streaming still works when no tools are requested.

### Task T3: Execute Read-Only Tools

Deliverables:

- Execute only registry-approved read-only tools.
- Enforce timeout, output-size, and max-call limits.
- Persist tool call and result metadata without credentials or large raw payloads.
- Add integration tests across run orchestration and transcript persistence.

### Task T4: Add Telegram Operator UX

Deliverables:

- Show when a tool call is running.
- Show concise tool results in Telegram when useful.
- Add clear failure messages for denied, timed-out, or invalid tool calls.
- Add tests for user-visible tool-call states.

### Task T5: Design Side-Effect Approval

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
