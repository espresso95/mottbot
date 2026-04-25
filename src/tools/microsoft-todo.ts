const DEFAULT_GRAPH_BASE_URL = "https://graph.microsoft.com/v1.0";
const TASK_TITLE_MAX_LENGTH = 200;

export type MicrosoftTodoToolConfig = {
  enabled: boolean;
  tenantId?: string;
  clientId?: string;
  graphBaseUrl: string;
  accessTokenEnv: string;
  defaultListId?: string;
  timeoutMs: number;
  maxItems: number;
};

export type MicrosoftTodoListSummary = {
  id: string;
  displayName: string;
  isOwner: boolean;
  isShared: boolean;
  wellknownListName?: string;
};

export type MicrosoftTodoTaskSummary = {
  id: string;
  title: string;
  status?: string;
  importance?: string;
  createdDateTime?: string;
  dueDateTime?: string;
  body?: string;
};

export type MicrosoftTodoCreatedTask = {
  id: string;
  title: string;
  status?: string;
  importance?: string;
  webLink?: string;
};

type FetchLike = typeof fetch;

type TodoListResponse = {
  value?: Array<Record<string, unknown>>;
};

type TodoTaskResponse = {
  value?: Array<Record<string, unknown>>;
};

type TodoTaskRecord = Record<string, unknown>;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asBoolean(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function sanitizeConfigValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeGraphBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

function normalizeTaskTitle(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error("Task title cannot be empty.");
  }
  if (trimmed.length > TASK_TITLE_MAX_LENGTH) {
    return trimmed.slice(0, TASK_TITLE_MAX_LENGTH);
  }
  return trimmed;
}

function normalizePositiveInt(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1) {
    return fallback;
  }
  return Math.trunc(value);
}

function mapList(value: Record<string, unknown>): MicrosoftTodoListSummary | undefined {
  const id = asString(value.id);
  const displayName = asString(value.displayName);
  if (!id || !displayName) {
    return undefined;
  }
  return {
    id,
    displayName,
    isOwner: asBoolean(value.isOwner),
    isShared: asBoolean(value.isShared),
    ...(asString(value.wellknownListName) ? { wellknownListName: asString(value.wellknownListName) } : {}),
  };
}

function mapTask(value: Record<string, unknown>): MicrosoftTodoTaskSummary | undefined {
  const id = asString(value.id);
  const title = asString(value.title);
  if (!id || !title) {
    return undefined;
  }
  const dueDateTimeRecord = asRecord(value.dueDateTime);
  const bodyRecord = asRecord(value.body);
  return {
    id,
    title,
    ...(asString(value.status) ? { status: asString(value.status) } : {}),
    ...(asString(value.importance) ? { importance: asString(value.importance) } : {}),
    ...(asString(value.createdDateTime) ? { createdDateTime: asString(value.createdDateTime) } : {}),
    ...(asString(dueDateTimeRecord?.dateTime) ? { dueDateTime: asString(dueDateTimeRecord?.dateTime) } : {}),
    ...(asString(bodyRecord?.content) ? { body: asString(bodyRecord?.content) } : {}),
  };
}

function mapCreatedTask(value: TodoTaskRecord): MicrosoftTodoCreatedTask {
  const task = mapTask(value);
  if (!task) {
    throw new Error("Graph returned an invalid todoTask payload.");
  }
  return {
    id: task.id,
    title: task.title,
    ...(task.status ? { status: task.status } : {}),
    ...(task.importance ? { importance: task.importance } : {}),
    ...(asString(value.webLink) ? { webLink: asString(value.webLink) } : {}),
  };
}

async function parseJson(response: Response): Promise<Record<string, unknown> | undefined> {
  try {
    const parsed = await response.json();
    return asRecord(parsed);
  } catch {
    return undefined;
  }
}

export class MicrosoftTodoService {
  private readonly graphBaseUrl: string;
  private readonly fetchImpl: FetchLike;

  constructor(
    private readonly config: MicrosoftTodoToolConfig,
    deps: {
      fetchImpl?: FetchLike;
      getEnv?: (name: string) => string | undefined;
    } = {},
  ) {
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.getEnv = deps.getEnv ?? ((name) => process.env[name]);
    this.graphBaseUrl = normalizeGraphBaseUrl(config.graphBaseUrl || DEFAULT_GRAPH_BASE_URL);
  }

  private readonly getEnv: (name: string) => string | undefined;

  async listTaskLists(params: { limit?: number; signal?: AbortSignal } = {}): Promise<{
    lists: MicrosoftTodoListSummary[];
    truncated: boolean;
  }> {
    this.assertEnabled();
    const limit = normalizePositiveInt(params.limit, this.config.maxItems);
    const query = new URLSearchParams({
      $top: String(limit + 1),
      $select: "id,displayName,isOwner,isShared,wellknownListName",
    });
    const payload = await this.requestJson<TodoListResponse>(`/me/todo/lists?${query.toString()}`, {
      method: "GET",
      signal: params.signal,
    });
    const lists = (payload.value ?? [])
      .map((item) => asRecord(item))
      .filter((item): item is Record<string, unknown> => Boolean(item))
      .map(mapList)
      .filter((item): item is MicrosoftTodoListSummary => Boolean(item));
    return {
      lists: lists.slice(0, limit),
      truncated: lists.length > limit,
    };
  }

  async listTasks(params: { listId?: string; limit?: number; signal?: AbortSignal } = {}): Promise<{
    listId: string;
    tasks: MicrosoftTodoTaskSummary[];
    truncated: boolean;
  }> {
    this.assertEnabled();
    const listId = this.resolveListId(params.listId);
    const limit = normalizePositiveInt(params.limit, this.config.maxItems);
    const query = new URLSearchParams({
      $top: String(limit + 1),
      $select: "id,title,status,importance,createdDateTime,dueDateTime",
      $orderby: "createdDateTime desc",
    });
    const payload = await this.requestJson<TodoTaskResponse>(
      `/me/todo/lists/${encodeURIComponent(listId)}/tasks?${query.toString()}`,
      {
        method: "GET",
        signal: params.signal,
      },
    );
    const tasks = (payload.value ?? [])
      .map((item) => asRecord(item))
      .filter((item): item is Record<string, unknown> => Boolean(item))
      .map(mapTask)
      .filter((item): item is MicrosoftTodoTaskSummary => Boolean(item));
    return {
      listId,
      tasks: tasks.slice(0, limit),
      truncated: tasks.length > limit,
    };
  }

  async createTask(params: {
    listId?: string;
    title: string;
    body?: string;
    dueDateTime?: string;
    signal?: AbortSignal;
  }): Promise<{ listId: string; task: MicrosoftTodoCreatedTask }> {
    this.assertEnabled();
    const listId = this.resolveListId(params.listId);
    const payload: Record<string, unknown> = {
      title: normalizeTaskTitle(params.title),
    };
    const body = asString(params.body);
    if (body) {
      payload.body = {
        content: body,
        contentType: "text",
      };
    }
    const dueDateTime = asString(params.dueDateTime);
    if (dueDateTime) {
      payload.dueDateTime = {
        dateTime: dueDateTime,
        timeZone: "UTC",
      };
    }
    const created = await this.requestJson<TodoTaskRecord>(`/me/todo/lists/${encodeURIComponent(listId)}/tasks`, {
      method: "POST",
      signal: params.signal,
      body: JSON.stringify(payload),
    });
    return {
      listId,
      task: mapCreatedTask(created),
    };
  }

  async getTask(params: {
    listId?: string;
    taskId: string;
    signal?: AbortSignal;
  }): Promise<{ listId: string; task: MicrosoftTodoTaskSummary }> {
    this.assertEnabled();
    const listId = this.resolveListId(params.listId);
    const taskId = this.resolveTaskId(params.taskId);
    const payload = await this.requestJson<TodoTaskRecord>(
      `/me/todo/lists/${encodeURIComponent(listId)}/tasks/${encodeURIComponent(taskId)}`,
      {
        method: "GET",
        signal: params.signal,
      },
    );
    const task = mapTask(payload);
    if (!task) {
      throw new Error("Graph returned an invalid todoTask payload.");
    }
    return {
      listId,
      task,
    };
  }

  async updateTask(params: {
    listId?: string;
    taskId: string;
    title?: string;
    body?: string;
    status?: string;
    importance?: string;
    dueDateTime?: string;
    signal?: AbortSignal;
  }): Promise<{ listId: string; task: MicrosoftTodoTaskSummary }> {
    this.assertEnabled();
    const listId = this.resolveListId(params.listId);
    const taskId = this.resolveTaskId(params.taskId);
    const payload: Record<string, unknown> = {};
    if (typeof params.title === "string") {
      payload.title = normalizeTaskTitle(params.title);
    }
    if (typeof params.body === "string") {
      payload.body = {
        content: params.body.trim(),
        contentType: "text",
      };
    }
    const status = asString(params.status);
    if (status) {
      payload.status = status;
    }
    const importance = asString(params.importance);
    if (importance) {
      payload.importance = importance;
    }
    const dueDateTime = asString(params.dueDateTime);
    if (dueDateTime) {
      payload.dueDateTime = {
        dateTime: dueDateTime,
        timeZone: "UTC",
      };
    }
    if (Object.keys(payload).length === 0) {
      throw new Error("At least one update field is required.");
    }
    const updated = await this.requestJson<TodoTaskRecord>(
      `/me/todo/lists/${encodeURIComponent(listId)}/tasks/${encodeURIComponent(taskId)}`,
      {
        method: "PATCH",
        signal: params.signal,
        body: JSON.stringify(payload),
      },
    );
    const task = mapTask(updated);
    if (!task) {
      throw new Error("Graph returned an invalid todoTask payload.");
    }
    return {
      listId,
      task,
    };
  }

  private assertEnabled(): void {
    if (!this.config.enabled) {
      throw new Error("Microsoft To Do integration is disabled. Set tools.microsoftTodo.enabled=true.");
    }
  }

  private resolveListId(explicitListId: string | undefined): string {
    const listId = sanitizeConfigValue(explicitListId) ?? sanitizeConfigValue(this.config.defaultListId);
    if (!listId) {
      throw new Error("To Do listId is required. Configure tools.microsoftTodo.defaultListId or pass listId.");
    }
    return listId;
  }

  private resolveTaskId(value: string): string {
    const taskId = sanitizeConfigValue(value);
    if (!taskId) {
      throw new Error("taskId is required.");
    }
    return taskId;
  }

  private resolveToken(): string {
    const envName = sanitizeConfigValue(this.config.accessTokenEnv);
    if (!envName) {
      throw new Error("tools.microsoftTodo.accessTokenEnv must be configured.");
    }
    const token = sanitizeConfigValue(this.getEnv(envName));
    if (!token) {
      throw new Error(`Microsoft Graph access token is missing in ${envName}.`);
    }
    return token;
  }

  private async requestJson<T extends Record<string, unknown>>(
    path: string,
    options: {
      method: "GET" | "POST" | "PATCH";
      body?: string;
      signal?: AbortSignal;
    },
  ): Promise<T> {
    const token = this.resolveToken();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.graphBaseUrl}${path}`, {
        method: options.method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
          ...(options.body ? { "Content-Type": "application/json" } : {}),
        },
        body: options.body,
        signal: options.signal ?? controller.signal,
      });
      if (!response.ok) {
        const errorBody = await parseJson(response);
        const message = asString(errorBody?.error && asRecord(errorBody.error)?.message) ?? response.statusText;
        throw new Error(`Microsoft Graph request failed (${response.status}): ${message || "Unknown error"}`);
      }
      const parsed = await response.json();
      const record = asRecord(parsed);
      if (!record) {
        throw new Error("Microsoft Graph response was not a JSON object.");
      }
      return record as T;
    } finally {
      clearTimeout(timeout);
    }
  }
}
