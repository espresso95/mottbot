import { describe, expect, it, vi } from "vitest";
import { MicrosoftTodoService, type MicrosoftTodoToolConfig } from "../../src/tools/microsoft-todo.js";

function createConfig(overrides: Partial<MicrosoftTodoToolConfig> = {}): MicrosoftTodoToolConfig {
  return {
    enabled: true,
    graphBaseUrl: "https://graph.microsoft.com/v1.0",
    accessTokenEnv: "MS_TOKEN",
    timeoutMs: 10_000,
    maxItems: 5,
    ...overrides,
  };
}

describe("MicrosoftTodoService", () => {
  it("lists task lists using Graph", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            value: [
              { id: "A", displayName: "Tasks", isOwner: true, isShared: false },
              { id: "B", displayName: "Backlog", isOwner: true, isShared: false },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );
    const service = new MicrosoftTodoService(createConfig(), {
      fetchImpl,
      getEnv: () => "token",
    });

    const result = await service.listTaskLists({ limit: 1 });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result.lists).toHaveLength(1);
    expect(result.truncated).toBe(true);
  });

  it("lists tasks with configured default list", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            value: [{ id: "1", title: "Follow up", status: "notStarted", importance: "normal" }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );
    const service = new MicrosoftTodoService(createConfig({ defaultListId: "list-123" }), {
      fetchImpl,
      getEnv: () => "token",
    });

    const result = await service.listTasks();

    expect(result.listId).toBe("list-123");
    expect(result.tasks[0]?.title).toBe("Follow up");
  });

  it("creates tasks through Graph", async () => {
    const fetchImpl = vi.fn(
      async (_url: string, init?: RequestInit) =>
        new Response(JSON.stringify({ id: "7", title: JSON.parse(String(init?.body)).title }), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        }),
    );
    const service = new MicrosoftTodoService(createConfig({ defaultListId: "list-123" }), {
      fetchImpl,
      getEnv: () => "token",
    });

    const result = await service.createTask({ title: "Follow up" });

    expect(result.task.id).toBe("7");
    expect(result.task.title).toBe("Follow up");
  });

  it("gets a single task through Graph", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ id: "7", title: "Follow up", status: "inProgress" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    const service = new MicrosoftTodoService(createConfig({ defaultListId: "list-123" }), {
      fetchImpl,
      getEnv: () => "token",
    });

    const result = await service.getTask({ taskId: "7" });

    expect(result.task.id).toBe("7");
    expect(result.task.status).toBe("inProgress");
  });

  it("updates a task through Graph patch", async () => {
    const fetchImpl = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response(JSON.stringify({ id: "7", title: "Follow up tomorrow", status: "completed" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    const service = new MicrosoftTodoService(createConfig({ defaultListId: "list-123" }), {
      fetchImpl,
      getEnv: () => "token",
    });

    const result = await service.updateTask({ taskId: "7", title: "Follow up tomorrow", status: "completed" });

    expect(result.task.title).toBe("Follow up tomorrow");
    expect(fetchImpl).toHaveBeenCalledWith(
      expect.stringContaining("/tasks/7"),
      expect.objectContaining({ method: "PATCH" }),
    );
  });

  it("fails clearly when token is missing", async () => {
    const service = new MicrosoftTodoService(createConfig({ defaultListId: "list-123" }), {
      fetchImpl: vi.fn(),
      getEnv: () => undefined,
    });

    await expect(service.listTasks()).rejects.toThrow("Microsoft Graph access token is missing");
  });
});
