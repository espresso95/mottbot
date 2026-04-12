import { afterEach, describe, expect, it } from "vitest";
import { createStores } from "../helpers/fakes.js";
import { removeTempDir } from "../helpers/tmp.js";

describe("TelegramUpdateStore", () => {
  const cleanup: Array<() => void> = [];

  afterEach(() => {
    while (cleanup.length > 0) {
      cleanup.pop()?.();
    }
  });

  it("deduplicates inflight and persisted updates", () => {
    const stores = createStores();
    cleanup.push(() => {
      stores.database.close();
      removeTempDir(stores.tempDir);
    });

    expect(stores.updateStore.begin(10)).toEqual({ accepted: true, reason: "new" });
    expect(stores.updateStore.begin(10)).toEqual({ accepted: false, reason: "inflight" });
    stores.updateStore.markProcessed({ updateId: 10, chatId: "chat-1", messageId: 1 });
    expect(stores.updateStore.begin(10)).toEqual({ accepted: false, reason: "processed" });
    expect(stores.updateStore.countProcessed()).toBe(1);
  });
});
