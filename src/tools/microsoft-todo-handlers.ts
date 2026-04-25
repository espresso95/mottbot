import type { ToolHandler } from "./executor.js";
import type { MicrosoftTodoService } from "./microsoft-todo.js";

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function optionalInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

/** Creates Microsoft To Do tool handlers backed by the configured service. */
export function createMicrosoftTodoToolHandlers(todo: MicrosoftTodoService): Partial<Record<string, ToolHandler>> {
  return {
    mottbot_ms_todo_lists: ({ arguments: input, signal }) =>
      todo.listTaskLists({
        limit: optionalInteger(input.limit),
        signal,
      }),
    mottbot_ms_todo_tasks: ({ arguments: input, signal }) =>
      todo.listTasks({
        listId: optionalString(input.listId),
        limit: optionalInteger(input.limit),
        signal,
      }),
    mottbot_ms_todo_task_create: ({ arguments: input, signal }) =>
      todo.createTask({
        listId: optionalString(input.listId),
        title: typeof input.title === "string" ? input.title : "",
        body: optionalString(input.body),
        dueDateTime: optionalString(input.dueDateTime),
        signal,
      }),
    mottbot_ms_todo_task_get: ({ arguments: input, signal }) =>
      todo.getTask({
        listId: optionalString(input.listId),
        taskId: typeof input.taskId === "string" ? input.taskId : "",
        signal,
      }),
    mottbot_ms_todo_task_update: ({ arguments: input, signal }) =>
      todo.updateTask({
        listId: optionalString(input.listId),
        taskId: typeof input.taskId === "string" ? input.taskId : "",
        title: optionalString(input.title),
        body: optionalString(input.body),
        status: optionalString(input.status),
        importance: optionalString(input.importance),
        dueDateTime: optionalString(input.dueDateTime),
        signal,
      }),
  };
}
