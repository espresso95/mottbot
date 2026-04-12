import { afterEach, describe, expect, it } from "vitest";
import { createStores } from "../helpers/fakes.js";
import { removeTempDir } from "../helpers/tmp.js";

describe("AuthProfileStore", () => {
  const cleanup: Array<() => void> = [];

  afterEach(() => {
    while (cleanup.length > 0) {
      cleanup.pop()?.();
    }
  });

  it("encrypts and loads auth profiles", () => {
    const stores = createStores();
    cleanup.push(() => {
      stores.database.close();
      removeTempDir(stores.tempDir);
    });

    stores.authProfiles.upsert({
      profileId: "openai-codex:default",
      source: "local_oauth",
      accessToken: "access-token",
      refreshToken: "refresh-token",
      expiresAt: 1234,
      accountId: "acct",
      email: "user@example.com",
      displayName: "User",
      metadata: { foo: "bar" },
    });

    const profile = stores.authProfiles.get("openai-codex:default");
    expect(profile).toMatchObject({
      accessToken: "access-token",
      refreshToken: "refresh-token",
      accountId: "acct",
      email: "user@example.com",
      displayName: "User",
      metadata: { foo: "bar" },
    });
    expect(stores.authProfiles.list()).toHaveLength(1);
  });
});
