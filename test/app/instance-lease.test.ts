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
});
