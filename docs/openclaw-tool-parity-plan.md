# OpenClaw Tool Parity Plan

## Goal

Add the useful OpenClaw-style tool categories to Mottbot without changing Mottbot's trust model. The implementation should stay registry-approved, bounded, auditable, and conservative by default.

## Safety Model

All new tools follow the existing controls:

- registry-defined schemas only
- side-effecting tools disabled unless `tools.enableSideEffectTools=true`
- owner/admin-only for host, filesystem, process, network, automation, plugin, and media tools
- one-shot approval for every side-effecting call
- bounded input, timeout, and output
- no raw environment dumps or credential reads
- no writes outside approved or generated tool artifact directories

## Phase 1: Filesystem Edit Tools

Add a repository patch tool equivalent to OpenClaw's `apply_patch` capability.

- `mottbot_repo_apply_patch`
- Uses approved repository roots from `tools.repository.roots`
- Rejects denied paths before applying a patch
- Applies patches through `git apply` without shell expansion

## Phase 2: Runtime And Code Execution Tools

Keep the existing `mottbot_local_command_run`, then add explicit tools for the missing runtime surface.

- `mottbot_process_list`
- `mottbot_local_shell_run`
- `mottbot_code_execution_run`

Shell and code execution remain extra guarded: the host must opt into side-effect tools and the relevant command marker must be allowlisted in `tools.localExec.allowedCommands`.

## Phase 3: Web Tools

Add bounded network read tools.

- `mottbot_web_fetch`
- `mottbot_web_search`

These reject localhost/private network targets and return sanitized, bounded text.

## Phase 4: Browser And Canvas Tools

Add the first browser/canvas equivalents without adding a heavyweight browser dependency.

- `mottbot_browser_snapshot`
- `mottbot_canvas_create`

The browser snapshot fetches and extracts page metadata/text. The canvas tool writes a bounded local HTML artifact under `data/tool-canvas`.

## Phase 5: Session And Subagent Tools

Expose safe session introspection and reuse the existing Codex job boundary for subagent-style work.

- `mottbot_sessions_list`
- `mottbot_session_history`
- `mottbot_subagent_codex_start`

The subagent starter delegates to the same Codex CLI job handler as `mottbot_codex_job_start`.

## Phase 6: Tool Groups And Discovery

Add OpenClaw-style groups and better operator discovery.

- group selectors such as `group:fs`, `group:web`, `group:runtime`, `group:sessions`, `group:automation`, and `group:media`
- `mottbot_tool_catalog`
- `/tools verbose`

Agent `toolNames` should accept tool names or group selectors.

## Phase 7: Plugin And Skill Scaffold

Add a minimal local extension manifest surface.

- `mottbot_extension_catalog`
- `mottbot_extension_manifest_read`

This is intentionally read-only first. Executable third-party plugin tools should continue through the MCP bridge until a separate trust boundary is designed.

## Phase 8: Automation And Gateway Tools

Add a small local automation artifact surface and a guarded outbound webhook.

- `mottbot_automation_task_create`
- `mottbot_automation_tasks`
- `mottbot_gateway_webhook_post`

Task artifacts are stored under `data/tool-automation`. Webhook calls are bounded and approval-gated.

## Phase 9: Media Tools

Add media request artifacts first, not direct provider calls.

- `mottbot_media_artifact_create`

The tool records image, audio, video, or TTS generation requests under `data/tool-media`. Provider-backed generation can be layered on later.

## Validation

Run:

- `corepack pnpm check`
- `corepack pnpm test`
- `corepack pnpm test:coverage` if shared execution or policy paths change
