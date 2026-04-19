import { afterEach, describe, expect, it } from "vitest";
import { RunQueueStore } from "../../src/runs/run-queue-store.js";
import { FakeClock, createInboundEvent, createStores } from "../helpers/fakes.js";
import { removeTempDir } from "../helpers/tmp.js";

describe("RunQueueStore", () => {
  const cleanup: Array<() => void> = [];

  afterEach(() => {
    while (cleanup.length > 0) {
      cleanup.pop()?.();
    }
  });

  it("creates, claims, completes, and prevents duplicate active claims", () => {
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
    const queue = new RunQueueStore(stores.database, stores.clock);

    queue.create({
      runId: run.runId,
      sessionKey: "s1",
      event: createInboundEvent({ text: "hello", attachments: [{ kind: "photo", fileId: "p1" }] }),
    });

    const firstClaim = queue.claim(run.runId, 60_000);
    expect(firstClaim).toMatchObject({ state: "claimed", attempts: 1 });
    expect(queue.claim(run.runId, 60_000)).toBeUndefined();

    queue.complete(run.runId);
    expect(queue.get(run.runId)).toMatchObject({ state: "completed" });
  });

  it("reclaims expired leases and lists only queued runs that are still runnable", () => {
    const stores = createStores();
    cleanup.push(() => {
      stores.database.close();
      removeTempDir(stores.tempDir);
    });
    const clock = stores.clock as FakeClock;
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
    const queue = new RunQueueStore(stores.database, clock);
    queue.create({
      runId: run.runId,
      sessionKey: "s1",
      event: createInboundEvent({ text: "hello" }),
    });

    expect(queue.claim(run.runId, 10)).toMatchObject({ attempts: 1 });
    expect(queue.claim(run.runId, 10, { recoverClaimed: true })).toMatchObject({ attempts: 2 });
    clock.advance(11);
    expect(queue.claim(run.runId, 10)).toMatchObject({ attempts: 3 });
    expect(queue.listRecoverableQueued()).toHaveLength(1);

    stores.runs.update(run.runId, { status: "starting" });
    expect(queue.listRecoverableQueued()).toHaveLength(0);
  });
});
