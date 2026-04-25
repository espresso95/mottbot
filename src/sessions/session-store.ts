import type { DatabaseClient } from "../db/client.js";
import type { Clock } from "../shared/clock.js";
import type { AgentConfig } from "../app/config.js";
import type { SessionRoute, SessionRouteMode } from "./types.js";

type SessionRow = {
  session_key: string;
  chat_id: string;
  thread_id: number | null;
  user_id: string | null;
  route_mode: SessionRouteMode;
  bound_name: string | null;
  agent_id: string;
  profile_id: string;
  model_ref: string;
  fast_mode: number;
  system_prompt: string | null;
  created_at: number;
  updated_at: number;
};

function mapSessionRow(row: SessionRow | undefined): SessionRoute | undefined {
  if (!row) {
    return undefined;
  }
  return {
    sessionKey: row.session_key,
    chatId: row.chat_id,
    ...(row.thread_id !== null ? { threadId: row.thread_id } : {}),
    ...(row.user_id ? { userId: row.user_id } : {}),
    routeMode: row.route_mode,
    ...(row.bound_name ? { boundName: row.bound_name } : {}),
    agentId: row.agent_id,
    profileId: row.profile_id,
    modelRef: row.model_ref,
    fastMode: row.fast_mode === 1,
    ...(row.system_prompt ? { systemPrompt: row.system_prompt } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Persists Telegram session routes and agent/model bindings. */
export class SessionStore {
  constructor(
    private readonly database: DatabaseClient,
    private readonly clock: Clock,
  ) {}

  get(sessionKey: string): SessionRoute | undefined {
    const row = this.database.db
      .prepare<unknown[], SessionRow>("select * from session_routes where session_key = ?")
      .get(sessionKey);
    return mapSessionRow(row);
  }

  findByChat(chatId: string, threadId?: number): SessionRoute | undefined {
    const row = this.database.db
      .prepare<
        unknown[],
        SessionRow
      >("select * from session_routes where chat_id = ? and thread_id is ? order by updated_at desc limit 1")
      .get(chatId, threadId ?? null);
    return mapSessionRow(row);
  }

  ensure(params: {
    sessionKey: string;
    chatId: string;
    threadId?: number;
    userId?: string;
    routeMode: SessionRouteMode;
    profileId: string;
    modelRef: string;
    boundName?: string;
    agentId?: string;
    fastMode?: boolean;
    systemPrompt?: string;
  }): SessionRoute {
    const existing = this.get(params.sessionKey);
    if (existing) {
      return existing;
    }
    const now = this.clock.now();
    this.database.db
      .prepare(
        `insert into session_routes (
          session_key, chat_id, thread_id, user_id, route_mode, bound_name, agent_id, profile_id, model_ref, fast_mode, system_prompt, created_at, updated_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        params.sessionKey,
        params.chatId,
        params.threadId ?? null,
        params.userId ?? null,
        params.routeMode,
        params.boundName ?? null,
        params.agentId ?? "main",
        params.profileId,
        params.modelRef,
        params.fastMode ? 1 : 0,
        params.systemPrompt ?? null,
        now,
        now,
      );
    return this.get(params.sessionKey)!;
  }

  setModelRef(sessionKey: string, modelRef: string): void {
    this.touch(sessionKey, { model_ref: modelRef });
  }

  setProfileId(sessionKey: string, profileId: string): void {
    this.touch(sessionKey, { profile_id: profileId });
  }

  setFastMode(sessionKey: string, fastMode: boolean): void {
    this.touch(sessionKey, { fast_mode: fastMode ? 1 : 0 });
  }

  setSystemPrompt(sessionKey: string, systemPrompt?: string): void {
    this.touch(sessionKey, { system_prompt: systemPrompt ?? null });
  }

  setAgent(sessionKey: string, agent: AgentConfig): void {
    this.touch(sessionKey, {
      agent_id: agent.id,
      profile_id: agent.profileId,
      model_ref: agent.modelRef,
      fast_mode: agent.fastMode ? 1 : 0,
      system_prompt: agent.systemPrompt ?? null,
    });
  }

  bind(sessionKey: string, boundName = "here"): void {
    this.touch(sessionKey, { route_mode: "bound", bound_name: boundName });
  }

  unbind(sessionKey: string): void {
    const current = this.get(sessionKey);
    if (!current) {
      return;
    }
    const routeMode: SessionRouteMode =
      current.threadId !== undefined ? "topic" : current.sessionKey.startsWith("tg:dm:") ? "dm" : "group";
    this.touch(sessionKey, {
      route_mode: routeMode,
      bound_name: null,
    });
  }

  private touch(
    sessionKey: string,
    patch: Partial<{
      route_mode: SessionRouteMode;
      bound_name: string | null;
      agent_id: string;
      profile_id: string;
      model_ref: string;
      fast_mode: number;
      system_prompt: string | null;
    }>,
  ): void {
    const existing = this.get(sessionKey);
    if (!existing) {
      return;
    }
    const next = {
      route_mode: patch.route_mode ?? existing.routeMode,
      bound_name: patch.bound_name === undefined ? (existing.boundName ?? null) : patch.bound_name,
      agent_id: patch.agent_id ?? existing.agentId,
      profile_id: patch.profile_id ?? existing.profileId,
      model_ref: patch.model_ref ?? existing.modelRef,
      fast_mode: patch.fast_mode ?? (existing.fastMode ? 1 : 0),
      system_prompt: patch.system_prompt === undefined ? (existing.systemPrompt ?? null) : patch.system_prompt,
      updated_at: this.clock.now(),
      session_key: sessionKey,
    };
    this.database.db
      .prepare(
        `update session_routes
         set route_mode = @route_mode,
             bound_name = @bound_name,
             agent_id = @agent_id,
             profile_id = @profile_id,
             model_ref = @model_ref,
             fast_mode = @fast_mode,
             system_prompt = @system_prompt,
             updated_at = @updated_at
         where session_key = @session_key`,
      )
      .run(next);
  }
}
