import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { systemClock } from "../../src/shared/clock.js";
import { AppError, getErrorMessage } from "../../src/shared/errors.js";
import { ensureParentDir, fileExists } from "../../src/shared/fs.js";
import { createTempDir, removeTempDir } from "../helpers/tmp.js";

describe("shared utilities", () => {
  it("returns the current time from systemClock", () => {
    expect(typeof systemClock.now()).toBe("number");
  });

  it("formats error messages", () => {
    expect(getErrorMessage(new AppError("x", "boom"))).toBe("boom");
    expect(getErrorMessage("oops")).toBe("oops");
    expect(getErrorMessage({})).toBe("Unknown error");
  });

  it("creates parent dirs and checks file existence", () => {
    const dir = createTempDir();
    try {
      const file = path.join(dir, "nested", "file.txt");
      ensureParentDir(file);
      fs.writeFileSync(file, "ok");
      expect(fileExists(file)).toBe(true);
      expect(fileExists(path.join(dir, "missing"))).toBe(false);
    } finally {
      removeTempDir(dir);
    }
  });
});
