import { describe, expect, it } from "vitest";
import { createDashboardSmokeResult } from "../../src/tools/dashboard-smoke.js";
import { createStores } from "../helpers/fakes.js";
import { removeTempDir } from "../helpers/tmp.js";

describe("dashboard smoke", () => {
  it("starts a loopback dashboard and verifies the agents panel/runtime payload", async () => {
    const stores = createStores();
    try {
      const result = await createDashboardSmokeResult({
        config: stores.config,
        database: stores.database,
        clock: stores.clock,
      });

      expect(result).toMatchObject({
        status: "passed",
        htmlStatus: 200,
        runtimeStatus: 200,
        hasAgentsPanel: true,
        hasAgentRenderer: true,
        agentCount: 1,
        healthStatus: "ok",
        firstAgent: {
          agentId: "main",
          configured: true,
          routeCount: 0,
          queuedRuns: 0,
          activeRuns: 0,
        },
      });
    } finally {
      stores.database.close();
      removeTempDir(stores.tempDir);
    }
  });
});
