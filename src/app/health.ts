import type { DatabaseClient } from "../db/client.js";
import type { Clock } from "../shared/clock.js";
import type { AppConfig } from "./config.js";
import type { AuthProfileStore } from "../codex/auth-store.js";

export type HealthSnapshot = {
  status: "ok" | "degraded";
  mode: "polling" | "webhook";
  sessions: number;
  authProfiles: number;
  interruptedRuns: number;
  degradedSessions: number;
  processedUpdates: number;
  generatedAt: number;
};

export class HealthReporter {
  constructor(
    private readonly config: AppConfig,
    private readonly database: DatabaseClient,
    private readonly authProfiles: AuthProfileStore,
    private readonly clock: Clock,
  ) {}

  snapshot(): HealthSnapshot {
    const sessions = this.scalarCount("select count(*) as count from session_routes");
    const interruptedRuns = this.scalarCount(
      `select count(*) as count from runs where status in ('starting', 'streaming')`,
    );
    const degradedSessions = this.database.db
      .prepare<unknown[], { count: number }>(
        `select count(*) as count
         from transport_state
         where websocket_degraded_until is not null and websocket_degraded_until > ?`,
      )
      .get(this.clock.now())?.count ?? 0;
    const processedUpdates = this.scalarCount("select count(*) as count from telegram_updates");
    return {
      status: interruptedRuns > 0 ? "degraded" : "ok",
      mode: this.config.telegram.polling ? "polling" : "webhook",
      sessions,
      authProfiles: this.authProfiles.list().length,
      interruptedRuns,
      degradedSessions,
      processedUpdates,
      generatedAt: this.clock.now(),
    };
  }

  formatForText(): string {
    const snapshot = this.snapshot();
    return [
      `Status: ${snapshot.status}`,
      `Mode: ${snapshot.mode}`,
      `Sessions: ${snapshot.sessions}`,
      `Auth profiles: ${snapshot.authProfiles}`,
      `Interrupted runs: ${snapshot.interruptedRuns}`,
      `Degraded sessions: ${snapshot.degradedSessions}`,
      `Processed updates: ${snapshot.processedUpdates}`,
      `Generated at: ${new Date(snapshot.generatedAt).toISOString()}`,
    ].join("\n");
  }

  private scalarCount(sql: string): number {
    return this.database.db.prepare<unknown[], { count: number }>(sql).get()?.count ?? 0;
  }
}
