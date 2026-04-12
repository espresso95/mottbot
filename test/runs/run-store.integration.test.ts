import { afterEach, describe, expect, it } from "vitest";
import { createStores } from "../helpers/fakes.js";
import { removeTempDir } from "../helpers/tmp.js";

describe("RunStore", () => {
  const cleanup: Array<() => void> = [];

  afterEach(() => {
    while (cleanup.length > 0) {
      cleanup.pop()?.();
    }
  });

  it("creates and updates runs", () => {
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
    const updated = stores.runs.update(run.runId, {
      status: "completed",
      transport: "sse",
      requestIdentity: "req-1",
      usageJson: "{\"input\":1}",
    });
    expect(updated).toMatchObject({
      status: "completed",
      transport: "sse",
      requestIdentity: "req-1",
      usageJson: "{\"input\":1}",
    });
  });
});
