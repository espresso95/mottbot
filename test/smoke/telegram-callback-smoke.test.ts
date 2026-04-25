import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { createTelegramCallbackSmokeResult } from "../../scripts/smoke/telegram-callback-smoke.js";

describe("telegram callback smoke", () => {
  it("validates tool and memory callback handlers in process", async () => {
    const result = await createTelegramCallbackSmokeResult();

    expect(result.status).toBe("passed");
    expect(result.scenarios).toEqual([
      expect.objectContaining({ name: "tool approval callback", status: "passed" }),
      expect.objectContaining({ name: "tool deny callback", status: "passed" }),
      expect.objectContaining({ name: "memory candidate accept callback", status: "passed" }),
    ]);
    expect(fs.existsSync(result.tempRoot)).toBe(false);
  });
});
