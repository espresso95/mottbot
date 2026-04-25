# Telegram Runtime

## Runtime Contract

The Telegram layer receives updates, decides whether they are eligible for handling, maps them to a session, and then streams model output back into Telegram. Everything after normalization works on internal event records instead of raw Telegram payloads.

## Inbound Event Shape

`normalizeUpdate()` emits this internal event contract:

```ts
type InboundEvent = {
  updateId: number;
  chatId: string;
  chatType: "private" | "group" | "supergroup" | "channel";
  messageId: number;
  threadId?: number;
  fromUserId?: string;
  fromUsername?: string;
  text?: string;
  caption?: string;
  entities: NormalizedEntity[];
  attachments: NormalizedAttachment[];
  replyToMessageId?: number;
  mentionsBot: boolean;
  isCommand: boolean;
  arrivedAt: number;
};
```

## Ingress Normalization

Current behavior:

- accepts Telegram message updates and, when reaction notifications are enabled, Telegram `message_reaction` updates
- captures `text` or `caption` as visible text
- extracts entities from `entities` or `caption_entities`
- extracts a single representative file ID and Telegram metadata for supported attachment kinds
- rejects messages before command/model routing when text or attachment safety limits are exceeded
- records processed update IDs durably after successful acceptance
- detects bot mention by username substring match
- flags commands when the visible text begins with `/`
- carries topic thread ID through `message_thread_id`

## Telegram Reactions

Mottbot supports Telegram emoji reactions in three separate paths:

- acknowledgement reactions while an accepted message is being processed
- reaction notifications that become `system` transcript context for the next model turn
- an approved owner/admin-only model tool for adding or clearing a bot reaction

Configuration:

- `telegram.reactions.enabled`
- `telegram.reactions.ackEmoji`
- `telegram.reactions.removeAckAfterReply`
- `telegram.reactions.notifications` with `off`, `own`, or `all`

Ack behavior:

- the bot sends the configured acknowledgement reaction only after command handling, safety checks, and ACL checks pass
- ack reaction failures are logged as warnings and do not block the model run
- when `removeAckAfterReply` is enabled, Mottbot clears the bot's reaction on the triggering message after success or failure

Notification behavior:

- webhook mode requests `message_reaction` updates when notifications are enabled
- `own` records reactions only on known bot-authored messages
- `all` records reactions from allowed chats
- reaction notifications are stored as `system` transcript messages, not as standalone user turns
- Telegram reaction updates do not include forum topic thread IDs, so group reactions route to the group-level session

Approved reaction tool:

- `mottbot_telegram_react` adds a Unicode emoji reaction or clears the bot reaction with an empty emoji
- it is owner/admin-only, side-effecting, and requires the one-shot `/tool approve` flow before execution unless policy is set to dry-run

Approved send tool:

- `mottbot_telegram_send_message` sends plain text to the current chat or a configured approved target
- it is owner/admin-only, side-effecting, and requires the same one-shot approval flow; the target and text are bound into the approval fingerprint

## Safety Limits

Before command routing or model execution, `validateInboundSafety()` checks:

- visible text length against `behavior.maxInboundTextChars`
- attachment count against `attachments.maxPerMessage`
- known per-file sizes against `attachments.maxFileBytes`
- combined known attachment sizes against `attachments.maxTotalBytes`
- downloaded attachment bytes against `attachments.maxTotalBytes` when Telegram did not provide complete sizes up front
- extracted file prompt text against `attachments.maxExtractedTextCharsPerFile`
- extracted file prompt text across one message against `attachments.maxExtractedTextCharsTotal`

Rejected messages receive a short Telegram reply explaining the limit and are marked processed for update dedupe. They do not create sessions, runs, transcript entries, or queue rows.

Supported attachment kinds:

- `photo`
- `document`
- `audio`
- `voice`
- `video`
- `sticker`
- `animation`

Current behavior:

- attachments are recorded on the event and persisted into transcript metadata
- stored metadata can include file name, MIME type, size, dimensions, duration, Telegram file IDs, ingestion status, and extraction summaries
- prompts render attachment summaries as text context and strip directory-like prefixes from file names
- image attachments are downloaded through Telegram `getFile` when the selected model supports native image input
- downloaded image bytes are converted into base64 image blocks for the model request
- native non-image file inputs are represented internally and capability-gated, but the active Codex provider adapter currently reports file input as unsupported
- text, Markdown, code, CSV, TSV, and PDF documents are downloaded within byte limits and extracted into bounded prompt-only text
- CSV and TSV attachments are represented as bounded table previews
- PDF extraction is bounded by `attachments.pdfMaxPages` and reports encrypted, unreadable, or no-text PDFs in attachment metadata
- unsupported attachment kinds and MIME types remain text metadata
- cached attachment files are deleted after model request construction or failure cleanup
- raw extracted file text is not persisted in SQLite; only metadata and extraction summaries are retained

Current limitation:

- non-image documents are not passed as native provider file blocks until the provider adapter exposes a real file content type; supported documents are converted into prompt text instead
- audio, video, stickers, and animations are not passed as native model inputs
- media-group coalescing is not implemented

## Access Control

`AccessController` applies the following policy:

1. Owner/admin roles are always allowed. `telegram.adminUserIds` resolve as protected owner roles.
2. If `telegram.allowedChatIds` is non-empty, all other chats are denied for non-operators unless listed.
3. Chat governance `allowedRoles` can deny non-operator messages for a specific chat.
4. Private chats are allowed when the global and chat governance checks pass.
5. Commands are handled before model routing, but the command router enforces its own role, chat, and command policy.
6. A previously bound route is always allowed when role and chat policy pass.
7. Replies are allowed only when the replied-to message is a known bot-authored Telegram message for the same chat/thread.
8. In groups, if `behavior.respondInGroupsOnlyWhenMentioned` is true, only direct mentions are allowed.

Decision reasons returned today:

- allow: `private`, `mentioned`, `reply`, `bound`, `command`
- deny: `chat_not_allowed`, `role_not_allowed`, `mention_required`

Current limitation:

- continuation messages from very long replies are tracked, but ACL verification is still based on a simple persisted message index rather than richer sender metadata

## Session Routing

`RouteResolver` first checks for an existing bound route for the same `chat_id` and `thread_id`. If it finds one, that route wins. Otherwise it computes a session key from chat type and topic state.

### Session Key Rules

Private chat with user ID:

```text
tg:dm:<chat_id>:user:<user_id>
```

Private chat without user ID:

```text
tg:dm:<chat_id>
```

Group chat:

```text
tg:group:<chat_id>
```

Topic in a supergroup:

```text
tg:group:<chat_id>:topic:<thread_id>
```

Bound route:

```text
tg:bound:<bound_name>
```

### Route Modes

- `dm`
- `group`
- `topic`
- `bound`

When a new route is created, `RouteResolver` selects an agent from `agents.bindings` in config. Bindings may match by chat ID, thread ID, chat type, and user ID. The first matching binding wins; otherwise the configured default agent is used. A binding may also set `projectKey`; that key is attached to the resolved route so approved `project`-scoped memory for the same key is visible to `/memory` and injected into prompts for that route.

The selected agent provides:

- `agentId`
- `profileId`
- `modelRef`
- `fastMode`
- optional `systemPrompt`
- optional model tool allow-list and per-tool policy restrictions

If no agents are configured, startup synthesizes a default `main` agent from `auth.defaultProfile` and `models.default`. Existing session routes keep their persisted agent, profile, model, fast mode, and system prompt settings; config changes apply to newly created routes.

Owner/admin users can use `/agent list`, `/agent show [agent-id]`, `/agent set <agent-id>`, and `/agent reset` to inspect or update the current route's agent. Agent switching validates the target profile, rejects models disallowed by chat governance, and checks local usage budgets before mutating the route. Model runs also re-check chat model policy before transport, so policy changes apply even to existing routes.

When an agent defines `toolNames`, only those tools are exposed to the model and executable for sessions using that agent. Agent `toolPolicies` are applied as additional restrictions on top of global tool policies and chat governance.

Agents can also define `maxConcurrentRuns` and `maxQueuedRuns`. Concurrent-run limits are enforced in memory across sessions for the selected agent. Queue limits are counted from persisted run records by `agent_id`; a full queue creates a failed run with `agent_queue_full` and sends a normal failed-run Telegram status.

Admins can inspect agent state with `/debug agents` or the dashboard Agents panel. The summary includes configured limits, route counts, queued runs, active runs, terminal run counts, and stale agent IDs that remain in persisted routes or runs after config edits.

## Command Surface

`TelegramCommandRouter` handles commands before the ACL-model pipeline.

On startup, the bot registers its top-level slash commands with Telegram so clients can suggest commands such as `/status` and `/help` while typing. Telegram command menus only support top-level commands; model-visible tools such as the Codex job tools remain available through the normal tool policy path, not as Telegram commands.

### Command authorization

Current policy:

- owner/admin roles can run commands in any chat, including chats outside `telegram.allowedChatIds`
- `telegram.adminUserIds` are treated as protected owners and cannot be revoked from Telegram
- normal and trusted users can run commands only in private chats by default
- when `telegram.allowedChatIds` is non-empty, non-operator private commands are rejected unless the chat is listed
- group and supergroup commands from non-operators are rejected unless a chat policy explicitly allows the command for that role
- chat governance can restrict allowed roles, allowed commands, allowed models, allowed model tools, memory scopes, and stricter attachment limits per chat
- denied commands receive a short Telegram reply and are marked processed by update dedupe

### Session and runtime commands

- `/help`
- `/commands`
- `/status`
- `/usage [daily|monthly]`
- `/health`
- `/model <provider/model>`
- `/profile <profile_id>`
- `/fast on|off`
- `/new`
- `/reset`
- `/stop`
- `/files [list [limit]]`
- `/files forget <file-id-prefix|all>`
- `/files clear`
- `/bind [name]`
- `/unbind`
- `/remember [scope:session|personal|chat|group|project:<key>] <fact>`
- `/memory`
- `/memory candidates [pending|accepted|rejected|archived|all]`
- `/memory accept <candidate-id-prefix>`
- `/memory reject <candidate-id-prefix>`
- `/memory edit <candidate-id-prefix> <replacement fact>`
- `/memory pin|unpin <memory-id-prefix>`
- `/memory archive <memory-id-prefix>`
- `/memory archive candidate <candidate-id-prefix>`
- `/memory clear candidates`
- `/forget <memory-id-prefix|all|auto>`

### Governance commands

- `/users me`
- `/users list`
- `/users grant <user-id> <owner|admin|trusted> [reason]`
- `/users revoke <user-id> [reason]`
- `/users audit [limit]`
- `/users chat show [chat-id]`
- `/users chat set [chat-id] <json>`
- `/users chat clear [chat-id]`

Chat policy JSON accepts:

- `allowedRoles`: roles allowed to use that chat for non-operator model routing
- `commandRoles`: command-to-role allow-list, with `*` as a wildcard
- `modelRefs`: model refs allowed by `/model`
- `toolNames`: model tools allowed in that chat
- `memoryScopes`: memory scopes allowed for `/remember` and candidate acceptance
- `attachmentMaxFileBytes` and `attachmentMaxPerMessage`: stricter per-chat attachment limits

### Auth commands

- `/auth status`
- `/auth import-cli`
- `/auth login`

### Tool approval commands

- `/tool status`
- `/tool help`
- `/tools`
- `/tool approve <tool-name> <reason>`
- `/tool revoke <tool-name>`
- `/tool audit [limit] [here] [tool:<name>] [code:<decision>]`

When a run hits a side-effecting tool without an active approval, the final Telegram response includes a structured approval card plus inline approve and deny buttons for each pending request. The card summarizes the tool, action, side effect, target arguments, expiration, and request ID. Approving from the button creates the request-fingerprinted one-shot approval, edits the original message with an approved status, removes the stale keyboard, and continues in the same session by replaying the exact stored tool call when the transcript still contains it. If that context is unavailable, the bot falls back to a same-session continuation prompt. Denying records an operator denial, edits the source message, and does not continue. Expired pending approval buttons record `approval_expired` and ask the model to retry. The typed `/tool approve` command remains available as a fallback.

### Current command behavior

- `/help` and `/commands` return caller-aware command discovery based on role, chat type, enabled runtime features, and per-chat command policy
- `/status` includes session key, model, profile, fast mode, profile count, and usage when available
- `/usage` reports local UTC daily or monthly run counts for the current global/chat/session/user/model context and shows configured limits without exposing account identifiers or tokens
- `/health` returns a lightweight runtime snapshot
- `/model` updates `session_routes.model_ref` only for known built-in Codex model refs
- `/profile` updates `session_routes.profile_id` only when the target profile exists and the profile ID has a safe shape
- `/agent` lists, shows, sets, or resets the route agent; set/reset is owner/admin-only
- `/fast` updates `session_routes.fast_mode`
- `/new` and `/reset` both clear transcript history for the session
- `/stop` aborts the active run for the session if one exists
- `/files` lists recent retained file metadata for the session
- `/files forget <id-prefix>` removes one retained file metadata record and strips the matching attachment envelope from transcript JSON without deleting the transcript message text
- `/files clear` removes all retained file metadata for the session and strips attachment envelopes from transcript JSON
- `/bind` switches the existing route into `bound` mode after validating the binding name
- `/unbind` restores the route mode based on the session key shape
- `/remember`, `/memory`, and `/forget` manage approved long-term memory for the current route
- memory can be scoped to the session, Telegram user, chat, group, or an explicit project key
- model-assisted memory candidates are stored separately and require `/memory accept` or an inline accept button before they are included in prompts
- `/memory pin` raises accepted memory above ordinary scoped memory and automatic summaries; `/memory archive` hides it without deleting the row
- `/auth import-cli` imports credentials from Codex CLI storage into the configured default profile
- `/auth login` intentionally tells the operator to run a host-local command instead of attempting OAuth inside Telegram
- `/tool status` shows enabled host tools, caller-visible model tools, and active approvals
- `/tool help` and `/tools` explain tool commands for the current caller after command policy filtering
- `/tool approve` and `/tool revoke` are owner/admin controls for side-effecting tools
- `/tool approve` binds to the latest pending approval preview in the current session when one exists
- inline tool approval buttons approve or deny the exact pending audit request encoded in the button, re-check the caller role and session, mark source messages, expire with the configured approval TTL, and treat replayed buttons as the original operator decision
- run status messages include inline controls: active runs offer `Stop`, failed runs offer `Retry` and `New chat`, and completed runs offer `New chat`, `Usage`, and `Files`; state-changing run buttons return short callback text, mark the source message, remove the stale keyboard, and avoid duplicate chat replies, while `Usage` and `Files` remain repeatable chat-message actions
- retry buttons replay only text-backed failed or cancelled runs; attachment-backed failed runs omit the dead retry action, keep `New chat` and `Files` available, and ask the operator to send the file again so transient attachment cache state is not silently reused
- inline memory candidate buttons accept, reject, or archive pending candidates from `/memory candidates`
- `/tool audit` is owner/admin-only and lists bounded policy/approval audit decisions, optionally filtered to `here`, `tool:<name>`, and `code:<decision>`

## Session Queue

`SessionQueue` is the primary in-process concurrency guard.

Behavior:

- one active task per `session_key`
- later tasks chain behind the current tail
- cancellation aborts only the active task
- accepted run queue metadata is persisted in `run_queue`, including approved-tool continuations created from inline approval buttons
- execution claims use a single-process lease to avoid duplicate execution after restart

Current behavior:

- accepted updates are persisted into transcript and `runs` before the queued execution phase starts
- the in-memory queue owns execution ordering, while `run_queue` owns restart recovery metadata
- queued runs are resumed on restart when their session route and user transcript record still exist
- approved-tool continuation runs are resumed on restart from the persisted callback continuation payload instead of requiring a user transcript row for the continuation run

Important implementation detail:

- the internal stored tail promise is deliberately non-throwing so cancelled or failed runs do not leak unhandled rejections

## Run Execution Flow

`RunOrchestrator` owns one full assistant turn.

### Execution steps

1. Reject messages that exceed ingress safety limits.
2. Ignore empty text and caption-only empty events.
3. Ensure the session route exists in the database.
4. Create a `runs` row in `queued` state.
5. Persist the user message to the transcript with the run ID.
6. Persist a `run_queue` row with the inbound context needed for restart recovery.
7. Return control to ingress so the accepted update can be marked processed.
8. Claim the queued run for execution.
9. Send a placeholder Telegram message through the outbox.
10. Move the run to `starting`.
11. Validate chat attachment policy and configured local usage budgets.
12. Resolve auth for the selected profile.
13. Load recent transcript history.
14. Download supported attachments.
15. Convert supported images into native model input blocks.
16. Extract bounded prompt-only text from supported text, Markdown, code, CSV, TSV, and PDF documents.
17. Persist attachment metadata and extraction summaries without raw extracted text.
18. Build the model prompt.
19. Append prompt-only extracted file text and native image blocks to the latest user message.
20. Start streaming through `CodexTransport`.
21. Move the run to `streaming` on stream start.
22. Append text deltas to the collector and edit the placeholder message.
23. Finalize the message, persist the assistant transcript entry, and record usage.
24. If enabled, update the deterministic automatic session summary.
25. Mark the run `completed` and the queue row `completed`.

### Failure path

If execution throws:

- the error is logged
- the outbox is finalized with `Run failed: <message>`
- the run is marked `failed`, or `cancelled` if the abort signal was set

## Tool Calls

When the model requests an enabled tool, the run orchestrator:

- shows short Telegram status edits while the tool is prepared and running
- executes read-only tools directly after registry and policy checks, including owner/admin-only repository tools scoped to approved roots and owner/admin-only GitHub tools backed by the host `gh` CLI
- executes side-effecting tools only after a fresh one-shot session approval; dry-run policy returns the preview without calling the handler
- enforces per-run tool-round and tool-call limits
- persists a `tool` transcript row with call/result metadata, not credentials or raw auth payloads
- persists side-effecting approval decisions in `tool_approval_audit`
- sends the provider-native tool result back to Codex in the same active turn
- finalizes Telegram with the model's answer after tool continuation

Unknown, disabled, invalid, policy-denied, unapproved, timed-out, or oversized tool calls are represented as tool errors and returned to the model for a final response. Side-effecting tools remain disabled unless `tools.enableSideEffectTools=true`.

## Prompt Building

The prompt builder is intentionally simple.

Current policy:

- default system prompt is short and Telegram-specific
- only the latest history window is sent to the model
- tool messages are excluded from prompt construction
- approved scoped memories are injected as system context before recent transcript history
- optional automatic summaries are stored as session memory only when `memory.autoSummariesEnabled=true`
- model-proposed memory candidates are never injected until accepted
- older history is compacted into a deterministic summary system message
- attachment metadata is rendered into user prompt text
- native image inputs are appended only to the latest user message
- cached attachment paths and raw bytes are never rendered into user-visible Telegram output

Default system prompt:

```text
You are Mottbot, a Telegram-based coding and operator assistant.
Reply concisely and clearly.
Preserve code fences when returning code.
Prefer direct answers over padding.
```

## Outbox Rendering

`TelegramOutbox` uses a single-message-first strategy.

### Start

- send one placeholder message, currently `Starting run...`
- store its Telegram message ID in `outbox_messages`

### Streaming updates

- split text to Telegram-safe chunk size
- edit only the first chunk in place
- throttle edits using `behavior.editThrottleMs`
- skip edits when the next rendered text is empty or unchanged
- if an edit fails mid-stream, send a continuation message, rebind the active outbox handle, and continue streaming
- transient status updates are intentionally terse and stable: `Starting run...`, `Resuming queued run after restart...`, `Preparing tool: <name>...`, `Running tool: <name>...`, and `Tool <name> completed. Continuing...` or `Tool <name> failed. Continuing...`
- recovery ignores these transient statuses when deciding whether an interrupted run had partial assistant text worth preserving

### Finish

- edit the original placeholder into the first final chunk
- send remaining chunks as continuation messages
- persist the primary and continuation Telegram message IDs into the bot-message index
- mark the outbox row `final`

### Fail

- try to edit the placeholder with an error summary
- if that edit fails, send a new message
- persist the fallback failure message ID when a new message is sent
- mark the outbox row `failed`

## Telegram-Specific Limits

The runtime is optimized for Telegram's constraints:

- edits are throttled to avoid flood control
- long output is chunked before sending
- the first message in a stream remains stable for better chat readability

## Runtime Gaps

The Telegram runtime intentionally leaves several hardening items for later:

- no media group coalescing
- no native provider file-block support for non-image attachment types
- no multi-process or multi-replica queue ownership
