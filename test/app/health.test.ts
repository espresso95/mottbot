import { afterEach, describe, expect, it } from "vitest";
import { createStores } from "../helpers/fakes.js";
import { removeTempDir } from "../helpers/tmp.js";

describe("HealthReporter", () => {
  const cleanup: Array<() => void> = [];

  afterEach(() => {
    while (cleanup.length > 0) {
      cleanup.pop()?.();
    }
  });

  it("reports current runtime counts", () => {
    const stores = createStores();
    cleanup.push(() => {
      stores.database.close();
      removeTempDir(stores.tempDir);
    });

    stores.authProfiles.upsert({
      profileId: "openai-codex:default",
      source: "local_oauth",
      accessToken: "access",
      refreshToken: "refresh",
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
    stores.runs.update(run.runId, { status: "starting" });
    stores.updateStore.begin(5);
    stores.updateStore.markProcessed({ updateId: 5, chatId: "chat-1", messageId: 10 });

    const snapshot = stores.health.snapshot();

    expect(snapshot.sessions).toBe(1);
    expect(snapshot.authProfiles).toBe(1);
    expect(snapshot.interruptedRuns).toBe(1);
    expect(snapshot.processedUpdates).toBe(1);
    expect(snapshot.status).toBe("degraded");
  });
});
