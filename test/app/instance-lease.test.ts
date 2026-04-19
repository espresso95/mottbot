import os from "node:os";
import { describe, expect, it } from "vitest";
import { ApplicationInstanceLease } from "../../src/app/instance-lease.js";
import { createStores } from "../helpers/fakes.js";
import { removeTempDir } from "../helpers/tmp.js";

describe("ApplicationInstanceLease", () => {
  it("prevents overlapping active leases and releases on stop", () => {
    const stores = createStores();
    try {
      const first = new ApplicationInstanceLease(stores.database, stores.clock, stores.logger, {
        leaseName: "bot",
        enabled: true,
        ttlMs: 60_000,
        refreshMs: 30_000,
      });
      const second = new ApplicationInstanceLease(stores.database, stores.clock, stores.logger, {
        leaseName: "bot",
        enabled: true,
        ttlMs: 60_000,
        refreshMs: 30_000,
      });

      first.start();
      expect(() => second.start()).toThrow("Another Mottbot instance owns lease");
      first.stop();
      expect(() => second.start()).not.toThrow();
      second.stop();
    } finally {
      stores.database.close();
      removeTempDir(stores.tempDir);
    }
  });

  it("allows takeover after expiration", () => {
    const stores = createStores();
    try {
      const first = new ApplicationInstanceLease(stores.database, stores.clock, stores.logger, {
        leaseName: "bot",
        enabled: true,
        ttlMs: 10_000,
        refreshMs: 30_000,
      });
      const second = new ApplicationInstanceLease(stores.database, stores.clock, stores.logger, {
        leaseName: "bot",
        enabled: true,
        ttlMs: 10_000,
        refreshMs: 30_000,
      });

      first.start();
      stores.clock.advance(10_001);
      expect(() => second.start()).not.toThrow();
      first.stop();
      second.stop();
    } finally {
      stores.database.close();
      removeTempDir(stores.tempDir);
    }
  });

  it("allows takeover from a dead local owner before expiration", () => {
    const stores = createStores();
    try {
      stores.database.db
        .prepare(
          `insert into app_instance_leases (lease_name, owner_id, expires_at, updated_at)
           values (?, ?, ?, ?)`,
        )
        .run("bot", `${os.hostname()}:999999999:test-owner`, stores.clock.now() + 60_000, stores.clock.now());
      const lease = new ApplicationInstanceLease(stores.database, stores.clock, stores.logger, {
        leaseName: "bot",
        enabled: true,
        ttlMs: 60_000,
        refreshMs: 30_000,
      });

      expect(() => lease.start()).not.toThrow();
      lease.stop();
    } finally {
      stores.database.close();
      removeTempDir(stores.tempDir);
    }
  });
});
