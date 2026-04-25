import os from "node:os";
import process from "node:process";
import type { DatabaseClient } from "../db/client.js";
import type { Clock } from "../shared/clock.js";
import { createId } from "../shared/ids.js";
import type { Logger } from "../shared/logger.js";

/** Coordinates a SQLite-backed single-instance lease for host-local bot processes. */
export class ApplicationInstanceLease {
  private readonly hostname = os.hostname();
  private readonly ownerId = `${this.hostname}:${process.pid}:${createId()}`;
  private refreshTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly database: DatabaseClient,
    private readonly clock: Clock,
    private readonly logger: Logger,
    private readonly options: {
      leaseName: string;
      enabled: boolean;
      ttlMs: number;
      refreshMs: number;
    },
  ) {}

  start(): void {
    if (!this.options.enabled) {
      return;
    }
    this.acquire();
    this.refreshTimer = setInterval(() => {
      try {
        this.refresh();
      } catch (error) {
        this.logger.error({ error, leaseName: this.options.leaseName }, "Failed to refresh instance lease.");
      }
    }, this.options.refreshMs);
    this.refreshTimer.unref();
  }

  stop(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = undefined;
    }
    if (!this.options.enabled) {
      return;
    }
    this.database.db
      .prepare("delete from app_instance_leases where lease_name = ? and owner_id = ?")
      .run(this.options.leaseName, this.ownerId);
  }

  private acquire(): void {
    const now = this.clock.now();
    const row = this.database.db
      .prepare<
        unknown[],
        { owner_id: string; expires_at: number }
      >("select owner_id, expires_at from app_instance_leases where lease_name = ?")
      .get(this.options.leaseName);
    if (row && row.owner_id !== this.ownerId && row.expires_at > now && !this.isDeadLocalOwner(row.owner_id)) {
      throw new Error(
        `Another Mottbot instance owns lease ${this.options.leaseName} until ${new Date(row.expires_at).toISOString()}.`,
      );
    }
    this.database.db
      .prepare(
        `insert into app_instance_leases (lease_name, owner_id, expires_at, updated_at)
         values (?, ?, ?, ?)
         on conflict(lease_name) do update set
           owner_id = excluded.owner_id,
           expires_at = excluded.expires_at,
           updated_at = excluded.updated_at`,
      )
      .run(this.options.leaseName, this.ownerId, now + this.options.ttlMs, now);
  }

  private isDeadLocalOwner(ownerId: string): boolean {
    const [host, rawPid] = ownerId.split(":", 2);
    if (host !== this.hostname || !rawPid) {
      return false;
    }
    const pid = Number(rawPid);
    if (!Number.isInteger(pid) || pid < 1) {
      return false;
    }
    try {
      process.kill(pid, 0);
      return false;
    } catch (error) {
      const code =
        error && typeof error === "object" && "code" in error ? (error as { code?: unknown }).code : undefined;
      return code === "ESRCH";
    }
  }

  private refresh(): void {
    const now = this.clock.now();
    const changed = this.database.db
      .prepare(
        `update app_instance_leases
         set expires_at = ?, updated_at = ?
         where lease_name = ? and owner_id = ?`,
      )
      .run(now + this.options.ttlMs, now, this.options.leaseName, this.ownerId).changes;
    if (changed === 0) {
      throw new Error(`Lost Mottbot instance lease ${this.options.leaseName}.`);
    }
  }
}
