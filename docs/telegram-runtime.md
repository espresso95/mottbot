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

- accepts only Telegram message updates
- captures `text` or `caption` as visible text
- extracts entities from `entities` or `caption_entities`
- extracts a single representative file ID and Telegram metadata for supported attachment kinds
- records processed update IDs durably after successful acceptance
- detects bot mention by username substring match
- flags commands when the visible text begins with `/`
- carries topic thread ID through `message_thread_id`

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
- stored metadata can include file name, MIME type, size, dimensions, duration, and Telegram file IDs
- prompts render attachment summaries as text context and strip directory-like prefixes from file names

Current limitation:

- attachment files are not downloaded into the local cache yet
- attachments are not yet uploaded or passed as native binary/image inputs to the model

## Access Control

`AccessController` applies the following policy:

1. Admin users listed in `telegram.adminUserIds` are always allowed.
2. If `telegram.allowedChatIds` is non-empty, all other chats are denied unless listed.
3. Private chats are always allowed.
4. Commands are handled before model routing, but the command router enforces its own chat and admin policy.
5. A previously bound route is always allowed.
6. Replies are allowed only when the replied-to message is a known bot-authored Telegram message for the same chat/thread.
7. In groups, if `behavior.respondInGroupsOnlyWhenMentioned` is true, only direct mentions are allowed.

Decision reasons returned today:

- allow: `private`, `mentioned`, `reply`, `bound`, `command`
- deny: `chat_not_allowed`, `mention_required`

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

When a new route is created, it inherits:

- `profileId = auth.defaultProfile`
- `modelRef = models.default`
- `fastMode = false`

## Command Surface

`TelegramCommandRouter` handles commands before the ACL-model pipeline.

### Command authorization

Current policy:

- configured admin users can run commands in any chat, including chats outside `telegram.allowedChatIds`
- non-admin users can run commands only in private chats
- when `telegram.allowedChatIds` is non-empty, non-admin private commands are rejected unless the chat is listed
- non-admin group and supergroup commands are rejected before a session route is created
- denied commands receive a short Telegram reply and are marked processed by update dedupe

### Session and runtime commands

- `/status`
- `/health`
- `/model <provider/model>`
- `/profile <profile_id>`
- `/fast on|off`
- `/new`
- `/reset`
- `/stop`
- `/bind [name]`
- `/unbind`

### Auth commands

- `/auth status`
- `/auth import-cli`
- `/auth login`

### Current command behavior

- `/status` includes session key, model, profile, fast mode, profile count, and usage when available
- `/health` returns a lightweight runtime snapshot
- `/model` updates `session_routes.model_ref` only for known built-in Codex model refs
- `/profile` updates `session_routes.profile_id` only when the target profile exists and the profile ID has a safe shape
- `/fast` updates `session_routes.fast_mode`
- `/new` and `/reset` both clear transcript history for the session
- `/stop` aborts the active run for the session if one exists
- `/bind` switches the existing route into `bound` mode after validating the binding name
- `/unbind` restores the route mode based on the session key shape
- `/auth import-cli` imports credentials from Codex CLI storage into the configured default profile
- `/auth login` intentionally tells the operator to run a host-local command instead of attempting OAuth inside Telegram

## Session Queue

`SessionQueue` is the primary concurrency guard.

Behavior:

- one active task per `session_key`
- later tasks chain behind the current tail
- cancellation aborts only the active task
- queue state is in memory, not persisted

Current behavior:

- accepted updates are persisted into transcript and `runs` before the queued execution phase starts
- the queue only owns execution, not ingress durability

Important implementation detail:

- the internal stored tail promise is deliberately non-throwing so cancelled or failed runs do not leak unhandled rejections

## Run Execution Flow

`RunOrchestrator` owns one full assistant turn.

### Execution steps

1. Ignore empty text and caption-only empty events.
2. Ensure the session route exists in the database.
3. Persist the user message to the transcript.
4. Create a `runs` row in `queued` state.
5. Return control to ingress so the accepted update can be marked processed.
6. Send a placeholder Telegram message through the outbox.
7. Move the run to `starting`.
8. Resolve auth for the selected profile.
9. Load recent transcript history.
10. Build the model prompt.
11. Start streaming through `CodexTransport`.
12. Move the run to `streaming` on stream start.
13. Append text deltas to the collector and edit the placeholder message.
14. Finalize the message, persist the assistant transcript entry, and record usage.
15. Mark the run `completed`.

### Failure path

If execution throws:

- the error is logged
- the outbox is finalized with `Run failed: <message>`
- the run is marked `failed`, or `cancelled` if the abort signal was set

## Prompt Building

The prompt builder is intentionally simple.

Current policy:

- default system prompt is short and Telegram-specific
- only the latest history window is sent to the model
- tool messages are excluded from prompt construction
- older history is compacted into a deterministic summary system message
- attachment metadata is rendered into user prompt text

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

- send one placeholder message, currently `Working...`
- store its Telegram message ID in `outbox_messages`

### Streaming updates

- split text to Telegram-safe chunk size
- edit only the first chunk in place
- throttle edits using `behavior.editThrottleMs`
- skip edits when the next rendered text is empty or unchanged
- if an edit fails mid-stream, send a continuation message, rebind the active outbox handle, and continue streaming

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
- no native attachment upload or rehydration into model inputs
- no persisted execution queue recovery on restart beyond interrupted-run reconciliation
