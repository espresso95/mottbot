import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { importCodexCliAuthProfile, resolveCodexAccessTokenExpiry, resolveCodexCliHome } from "../../src/codex/cli-auth-import.js";
import { createStores } from "../helpers/fakes.js";
import { createTempDir, removeTempDir } from "../helpers/tmp.js";

function createJwt(expSeconds: number, extra: Record<string, unknown> = {}): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none", typ: "JWT" })}.${encode({
    exp: expSeconds,
    "https://api.openai.com/profile": { email: "user@example.com" },
    ...extra,
  })}.sig`;
}

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length > 0) {
    removeTempDir(dirs.pop()!);
  }
});

describe("cli auth import", () => {
  it("resolves expiry from JWTs", () => {
    const exp = 1_800_000_000;
    expect(resolveCodexAccessTokenExpiry(createJwt(exp))).toBe(exp * 1000);
  });

  it("imports a Codex CLI auth.json profile", () => {
    const stores = createStores();
    const dir = createTempDir();
    dirs.push(dir, stores.tempDir);
    try {
      const codexHome = path.join(dir, ".codex");
      fs.mkdirSync(codexHome, { recursive: true });
      fs.writeFileSync(
        path.join(codexHome, "auth.json"),
        JSON.stringify({
          auth_mode: "chatgpt",
          tokens: {
            access_token: createJwt(1_900_000_000),
            refresh_token: "refresh",
            account_id: "acct-1",
          },
        }),
      );
      const env = { ...process.env, CODEX_HOME: codexHome };
      expect(resolveCodexCliHome(env)).toBe(codexHome);
      const result = importCodexCliAuthProfile({
        store: stores.authProfiles,
        env,
      });
      expect(result.imported).toBe(true);
      const profile = stores.authProfiles.get("openai-codex:default");
      expect(profile).toMatchObject({
        source: "codex_cli",
        accountId: "acct-1",
        email: "user@example.com",
      });
    } finally {
      stores.database.close();
    }
  });
});
