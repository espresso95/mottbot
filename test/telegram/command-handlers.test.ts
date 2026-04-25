import { afterEach, describe, expect, it, vi } from "vitest";
import type { HealthReporter } from "../../src/app/health.js";
import type { OperatorDiagnostics } from "../../src/app/diagnostics.js";
import { MemoryStore } from "../../src/sessions/memory-store.js";
import type { SessionRoute } from "../../src/sessions/types.js";
import { ToolApprovalStore } from "../../src/tools/approval.js";
import { createRuntimeToolRegistry } from "../../src/tools/registry.js";
import { TelegramGovernanceStore } from "../../src/telegram/governance.js";
import { handleDebugCommand, handleRunsCommand } from "../../src/telegram/diagnostic-commands.js";
import { handleFilesCommand } from "../../src/telegram/files-commands.js";
import { handleForgetCommand, handleMemoryCommand, handleRememberCommand } from "../../src/telegram/memory-commands.js";
import { handleToolCommand, parseToolAuditArgs } from "../../src/telegram/tool-commands.js";
import { handleUsersCommand } from "../../src/telegram/user-commands.js";
import type { InboundEvent } from "../../src/telegram/types.js";
import { createInboundEvent, createStores } from "../helpers/fakes.js";
import { removeTempDir } from "../helpers/tmp.js";

type TestApi = {
  sendMessage: ReturnType<typeof vi.fn>;
};

const cleanup: Array<() => void> = [];

function makeApi(): TestApi {
  return {
    sendMessage: vi.fn(async () => ({})),
  };
}

function sentTexts(api: TestApi): string[] {
  return api.sendMessage.mock.calls.map((call) => String(call[1]));
}

function makeSession(overrides: Partial<SessionRoute> = {}): SessionRoute {
  return {
    sessionKey: "session-1",
    chatId: "chat-1",
    userId: "user-1",
    routeMode: "dm",
    agentId: "main",
    profileId: "openai-codex:default",
    modelRef: "openai-codex/gpt-5.4",
    fastMode: false,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    ...overrides,
  };
}

function closeStores(stores: ReturnType<typeof createStores>): void {
  stores.database.close();
  removeTempDir(stores.tempDir);
}

function ensureSession(stores: ReturnType<typeof createStores>, overrides: Partial<SessionRoute> = {}): SessionRoute {
  const session = makeSession(overrides);
  return stores.sessions.ensure({
    sessionKey: session.sessionKey,
    chatId: session.chatId,
    threadId: session.threadId,
    userId: session.userId,
    routeMode: session.routeMode,
    profileId: session.profileId,
    modelRef: session.modelRef,
    boundName: session.boundName,
    agentId: session.agentId,
    fastMode: session.fastMode,
    systemPrompt: session.systemPrompt,
  });
}

afterEach(() => {
  while (cleanup.length > 0) {
    cleanup.pop()?.();
  }
});

describe("diagnostic command handlers", () => {
  it("gates /runs and passes bounded filters to diagnostics", async () => {
    const api = makeApi();
    const event = createInboundEvent();
    const session = makeSession();
    const recentRunsText = vi.fn(() => "recent runs");
    const diagnostics = { recentRunsText } as unknown as OperatorDiagnostics;

    await handleRunsCommand({ api: api as any, event, session, args: ["7", "here"], diagnostics, isAdmin: true });
    await handleRunsCommand({ api: api as any, event, session, args: [], diagnostics, isAdmin: false });

    expect(recentRunsText).toHaveBeenCalledWith({ limit: 7, sessionKey: "session-1" });
    expect(sentTexts(api)).toContain("recent runs");
    expect(sentTexts(api)).toContain("Only owner/admin roles can inspect runs.");
  });

  it("formats /debug summary and parses log stream arguments", async () => {
    const api = makeApi();
    const event = createInboundEvent();
    const session = makeSession();
    const diagnostics = {
      configText: vi.fn(() => "config text"),
      recentRunsText: vi.fn(() => "run text"),
      serviceStatus: vi.fn(() => "service text"),
      agentDiagnosticsText: vi.fn(() => "agent text"),
      recentErrorsText: vi.fn(() => "error text"),
      recentLogsText: vi.fn(() => "log text"),
    } as unknown as OperatorDiagnostics;
    const health = { formatForText: vi.fn(() => "health text") } as unknown as HealthReporter;

    await handleDebugCommand({ api: api as any, event, session, args: [], diagnostics, health, isAdmin: true });
    await handleDebugCommand({
      api: api as any,
      event,
      session,
      args: ["logs", "stderr", "12"],
      diagnostics,
      health,
      isAdmin: true,
    });

    expect(sentTexts(api)[0]).toContain("health text\n\nconfig text\n\nrun text");
    expect(diagnostics.recentLogsText).toHaveBeenCalledWith({ stream: "stderr", lines: 12 });
    expect(sentTexts(api)).toContain("log text");
  });
});

describe("file command handler", () => {
  it("lists and forgets file metadata while removing transcript attachment references", async () => {
    const stores = createStores();
    cleanup.push(() => closeStores(stores));
    const api = makeApi();
    const event = createInboundEvent();
    const session = ensureSession(stores);
    const run = stores.runs.create({
      sessionKey: session.sessionKey,
      modelRef: session.modelRef,
      profileId: session.profileId,
      agentId: session.agentId,
    });
    const [record] = stores.attachmentRecords.addMany({
      sessionKey: session.sessionKey,
      runId: run.runId,
      telegramMessageId: 42,
      attachments: [
        {
          recordId: "file-alpha",
          kind: "document",
          fileId: "telegram-file",
          fileName: "report.txt",
          mimeType: "text/plain",
          fileSize: 12,
          ingestionStatus: "extracted_text",
          extraction: {
            kind: "text",
            status: "extracted",
            promptChars: 10,
            textChars: 12,
            truncated: false,
          },
        },
      ],
    });
    stores.transcripts.add({
      sessionKey: session.sessionKey,
      runId: run.runId,
      role: "user",
      contentJson: JSON.stringify({ attachments: [{ recordId: record!.id, fileName: "report.txt" }] }),
    });

    await handleFilesCommand({
      api: api as any,
      event,
      session,
      args: ["list"],
      attachments: stores.attachmentRecords,
      transcripts: stores.transcripts,
    });
    await handleFilesCommand({
      api: api as any,
      event,
      session,
      args: ["forget", "file-alp"],
      attachments: stores.attachmentRecords,
      transcripts: stores.transcripts,
    });

    expect(sentTexts(api)[0]).toContain("report.txt");
    expect(sentTexts(api)[1]).toBe("Forgot file file-alp and updated 1 transcript messages.");
    expect(stores.attachmentRecords.listRecent(session.sessionKey)).toHaveLength(0);
    expect(stores.transcripts.listRecent(session.sessionKey, 1)[0]?.contentJson).toBeUndefined();
  });

  it("reports unavailable file metadata stores", async () => {
    const stores = createStores();
    cleanup.push(() => closeStores(stores));
    const api = makeApi();

    await handleFilesCommand({
      api: api as any,
      event: createInboundEvent(),
      session: makeSession(),
      args: [],
      transcripts: stores.transcripts,
    });

    expect(sentTexts(api)).toContain("File metadata is not available.");
  });
});

describe("memory command handlers", () => {
  it("stores, reviews, pins, and forgets session memory", async () => {
    const stores = createStores();
    cleanup.push(() => closeStores(stores));
    const api = makeApi();
    const event = createInboundEvent({ fromUserId: "user-1" });
    const session = ensureSession(stores);
    const memories = new MemoryStore(stores.database, stores.clock);

    await handleRememberCommand({
      api: api as any,
      event,
      session,
      args: ["prefers", "concise", "answers"],
      memories,
    });
    const candidate = memories.addCandidate({
      sessionKey: session.sessionKey,
      scope: "session",
      scopeKey: session.sessionKey,
      contentText: "prefers short examples",
      sensitivity: "low",
    });
    expect(candidate.inserted).toBe(true);
    const candidateId = candidate.inserted ? candidate.candidate.id.slice(0, 8) : "";

    await handleMemoryCommand({ api: api as any, event, session, args: ["candidates"], memories });
    await handleMemoryCommand({
      api: api as any,
      event,
      session,
      args: ["edit", candidateId, "prefers runnable examples"],
      memories,
    });
    await handleMemoryCommand({ api: api as any, event, session, args: ["accept", candidateId], memories });
    const acceptedMemory = memories.listForScopeContext(session).find((record) => record.source === "model_candidate")!;
    await handleMemoryCommand({
      api: api as any,
      event,
      session,
      args: ["pin", acceptedMemory.id.slice(0, 8)],
      memories,
    });
    await handleForgetCommand({ api: api as any, event, session, args: ["all"], memories });

    expect(sentTexts(api)).toContain("Memory pinned.");
    expect(sentTexts(api).at(-1)).toBe("Forgot 2 memories.");
    expect(memories.listForScopeContext(session)).toHaveLength(0);
  });

  it("rejects disallowed memory scopes before storing content", async () => {
    const stores = createStores();
    cleanup.push(() => closeStores(stores));
    const api = makeApi();
    const event = createInboundEvent({ chatId: "chat-1", fromUserId: "owner-1" });
    const session = ensureSession(stores, { userId: "owner-1" });
    const memories = new MemoryStore(stores.database, stores.clock);
    const governance = new TelegramGovernanceStore(stores.database, stores.clock, { ownerUserIds: ["owner-1"] });
    governance.setChatPolicy({
      chatId: "chat-1",
      policy: { memoryScopes: ["session"] },
      actorUserId: "owner-1",
    });

    await handleRememberCommand({
      api: api as any,
      event,
      session,
      args: ["scope:personal", "private", "fact"],
      memories,
      governance,
    });

    expect(sentTexts(api)).toContain("Memory scope personal is not allowed in this chat.");
    expect(memories.listForScopeContext(session)).toHaveLength(0);
  });
});

describe("user governance command handler", () => {
  it("grants roles, lists audit records, and manages chat policy", async () => {
    const stores = createStores();
    cleanup.push(() => closeStores(stores));
    const api = makeApi();
    const event = createInboundEvent({ fromUserId: "owner-1" });
    const governance = new TelegramGovernanceStore(stores.database, stores.clock, { ownerUserIds: ["owner-1"] });
    const base = {
      api: api as any,
      event,
      governance,
      role: "owner" as const,
      isAdmin: true,
      isOwner: true,
    };

    await handleUsersCommand({ ...base, args: ["grant", "user-2", "trusted", "ship", "it"] });
    await handleUsersCommand({ ...base, args: ["list"] });
    await handleUsersCommand({ ...base, args: ["audit", "5"] });
    await handleUsersCommand({ ...base, args: ["chat", "set", '{"allowedRoles":["trusted"]}'] });
    await handleUsersCommand({ ...base, args: ["chat", "clear"] });

    expect(sentTexts(api)).toContain("Granted trusted to user-2.");
    expect(sentTexts(api).some((text) => text.includes("user-2: trusted"))).toBe(true);
    expect(sentTexts(api).some((text) => text.includes("User governance audit:"))).toBe(true);
    expect(sentTexts(api).some((text) => text.includes('"allowedRoles"'))).toBe(true);
    expect(sentTexts(api)).toContain("Cleared chat policy for chat-1.");
  });

  it("blocks owner-only actions for non-owner callers", async () => {
    const stores = createStores();
    cleanup.push(() => closeStores(stores));
    const api = makeApi();
    const governance = new TelegramGovernanceStore(stores.database, stores.clock, { ownerUserIds: ["owner-1"] });

    await handleUsersCommand({
      api: api as any,
      event: createInboundEvent({ fromUserId: "admin-1" }),
      args: ["grant", "user-2", "trusted"],
      governance,
      role: "admin",
      isAdmin: true,
      isOwner: false,
    });

    expect(sentTexts(api)).toContain("Only owner roles can grant user roles.");
  });
});

describe("tool command handler", () => {
  it("parses audit filters and rejects invalid decision codes", () => {
    expect(parseToolAuditArgs(["25", "here", "tool:mottbot_local_note_create", "code:operator_approved"])).toEqual({
      limit: 25,
      here: true,
      toolName: "mottbot_local_note_create",
      decisionCode: "operator_approved",
    });
    expect(parseToolAuditArgs(["code:nope"]).error).toContain("Unknown decision code nope.");
  });

  it("approves, audits, and revokes side-effecting tool approvals", async () => {
    const stores = createStores({ tools: { enableSideEffectTools: true } as any });
    cleanup.push(() => closeStores(stores));
    const api = makeApi();
    const event: InboundEvent = createInboundEvent({ fromUserId: "owner-1" });
    const session = ensureSession(stores);
    const toolRegistry = createRuntimeToolRegistry({ enableSideEffectTools: true });
    const toolApprovals = new ToolApprovalStore(stores.database, stores.clock);
    const base = {
      api: api as any,
      event,
      session,
      toolsConfig: stores.config.tools,
      exposedTools: toolRegistry.listModelDeclarations({ includeAdminTools: true }).slice(0, 1),
      isAdmin: true,
      visibleCommandTexts: (entries: readonly { text: string }[]) => entries.map((entry) => entry.text),
      toolRegistry,
      toolApprovals,
    };

    await handleToolCommand({ ...base, args: ["status"] });
    await handleToolCommand({ ...base, args: ["approve", "mottbot_local_note_create", "maintenance"] });
    await handleToolCommand({ ...base, args: ["audit", "here", "code:operator_approved"] });
    await handleToolCommand({ ...base, args: ["revoke", "mottbot_local_note_create"] });

    expect(sentTexts(api)[0]).toContain("Enabled tools:");
    expect(sentTexts(api)[1]).toContain("Approved mottbot_local_note_create");
    expect(sentTexts(api)[2]).toContain("Tool audit:");
    expect(sentTexts(api)[3]).toBe("Revoked 1 approvals.");
  });

  it("reports unavailable approval dependencies before inspecting tools", async () => {
    const stores = createStores();
    cleanup.push(() => closeStores(stores));
    const api = makeApi();

    await handleToolCommand({
      api: api as any,
      event: createInboundEvent(),
      session: makeSession(),
      args: ["status"],
      toolsConfig: stores.config.tools,
      exposedTools: [],
      isAdmin: false,
      visibleCommandTexts: () => [],
    });

    expect(sentTexts(api)).toContain("Tool approvals are not available.");
  });
});
