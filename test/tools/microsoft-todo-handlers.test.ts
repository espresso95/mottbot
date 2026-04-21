import { describe, expect, it, vi } from "vitest";
import { createMicrosoftTodoToolHandlers } from "../../src/tools/microsoft-todo-handlers.js";
import type { ToolDefinition } from "../../src/tools/registry.js";
import type { MicrosoftTodoService } from "../../src/tools/microsoft-todo.js";

const definition: ToolDefinition = {
  name: "test_tool",
  description: "Test tool.",
  inputSchema: {
    type: "object",
    properties: {},
    required: [],
    additionalProperties: false,
  },
  timeoutMs: 1_000,
  maxOutputBytes: 4_000,
  sideEffect: "read_only",
  enabled: true,
};

describe("Microsoft To Do tool handlers", () => {
  it("routes read calls to the Microsoft To Do service", async () => {
    const service = {
      listTaskLists: vi.fn(async () => ({ lists: [], truncated: false })),
      listTasks: vi.fn(async () => ({ listId: "abc", tasks: [], truncated: false })),
      getTask: vi.fn(async () => ({ listId: "abc", task: { id: "task-1", title: "A task" } })),
      createTask: vi.fn(async () => ({ listId: "abc", task: { id: "1", title: "x" } })),
      updateTask: vi.fn(async () => ({ listId: "abc", task: { id: "1", title: "x" } })),
    } as unknown as MicrosoftTodoService;
    const handlers = createMicrosoftTodoToolHandlers(service);

    await handlers.mottbot_ms_todo_lists!({ definition, arguments: { limit: 5 } });
    await handlers.mottbot_ms_todo_tasks!({ definition, arguments: { listId: "abc", limit: 7 } });
    await handlers.mottbot_ms_todo_task_get!({ definition, arguments: { listId: "abc", taskId: "task-1" } });

    expect(service.listTaskLists).toHaveBeenCalledWith({ limit: 5, signal: undefined });
    expect(service.listTasks).toHaveBeenCalledWith({ listId: "abc", limit: 7, signal: undefined });
    expect(service.getTask).toHaveBeenCalledWith({ listId: "abc", taskId: "task-1", signal: undefined });
  });

  it("routes create calls to the Microsoft To Do service", async () => {
    const service = {
      listTaskLists: vi.fn(),
      listTasks: vi.fn(),
      getTask: vi.fn(),
      createTask: vi.fn(async () => ({ listId: "abc", task: { id: "1", title: "follow up" } })),
      updateTask: vi.fn(async () => ({ listId: "abc", task: { id: "1", title: "follow up" } })),
    } as unknown as MicrosoftTodoService;
    const handlers = createMicrosoftTodoToolHandlers(service);

    await handlers.mottbot_ms_todo_task_create!({
      definition,
      arguments: {
        listId: "abc",
        title: "Follow up with customer",
        body: "Add latest notes",
        dueDateTime: "2026-05-01T12:00:00Z",
      },
    });

    expect(service.createTask).toHaveBeenCalledWith({
      listId: "abc",
      title: "Follow up with customer",
      body: "Add latest notes",
      dueDateTime: "2026-05-01T12:00:00Z",
      signal: undefined,
    });

    await handlers.mottbot_ms_todo_task_update!({
      definition,
      arguments: {
        listId: "abc",
        taskId: "task-7",
        title: "Follow up tomorrow",
        status: "inProgress",
      },
    });

    expect(service.updateTask).toHaveBeenCalledWith({
      listId: "abc",
      taskId: "task-7",
      title: "Follow up tomorrow",
      body: undefined,
      status: "inProgress",
      importance: undefined,
      dueDateTime: undefined,
      signal: undefined,
    });
  });
});
