import { afterEach, describe, expect, it } from "vitest";
import { createStores } from "../helpers/fakes.js";
import { removeTempDir } from "../helpers/tmp.js";

describe("RunStore recovery", () => {
  const cleanup: Array<() => void> = [];

  afterEach(() => {
    while (cleanup.length > 0) {
      cleanup.pop()?.();
    }
  });

  it("recovers interrupted runs as failed on restart", () => {
    const stores = createStores();
    cleanup.push(() => {
      stores.database.close();
      removeTempDir(stores.tempDir);
    });
    stores.sessions.ensure({
      sessionKey: "s1",
      chatId: "chat-1",
      routeMode: "dm",
      profileId: "openai-codex:default",
      modelRef: "openai-codex/gpt-5.4",
    });
    const run = stores.runs.create({
      sessionKey: "s1",
      modelRef: "openai-codex/gpt-5.4",
      profileId: "openai-codex:default",
    });
    stores.runs.update(run.runId, {
      status: "streaming",
      startedAt: stores.clock.now(),
    });

    const recovered = stores.runs.recoverInterruptedRuns();

    expect(recovered).toHaveLength(1);
    expect(recovered[0]?.status).toBe("failed");
    expect(recovered[0]?.errorCode).toBe("restart_recovery");
    expect(stores.runs.countByStatuses(["starting", "streaming"])).toBe(0);
  });
});
