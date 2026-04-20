import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { rotateServiceLogs, serviceLogStatus } from "../../src/ops/logs.js";
import type { LaunchAgentPaths } from "../../src/app/service.js";
import { createTempDir, removeTempDir } from "../helpers/tmp.js";

function testPaths(logDir: string): LaunchAgentPaths {
  return {
    label: "test.mottbot",
    plistPath: path.join(logDir, "test.plist"),
    logDir,
    stdoutPath: path.join(logDir, "bot.out.log"),
    stderrPath: path.join(logDir, "bot.err.log"),
  };
}

describe("service log operations", () => {
  it("reports log size and rotates logs into an archive directory", () => {
    const logDir = createTempDir();
    try {
      const paths = testPaths(logDir);
      fs.writeFileSync(paths.stdoutPath, "one\ntwo\n", "utf8");
      fs.writeFileSync(paths.stderrPath, "warn\n", "utf8");

      const status = serviceLogStatus(paths);
      expect(status.files).toEqual([
        expect.objectContaining({ role: "stdout", exists: true, sizeBytes: 8, symlink: false }),
        expect.objectContaining({ role: "stderr", exists: true, sizeBytes: 5, symlink: false }),
      ]);

      const rotation = rotateServiceLogs({
        paths,
        truncate: true,
        now: new Date("2026-04-20T00:00:00.000Z"),
      });

      expect(rotation.files).toEqual([
        expect.objectContaining({ role: "stdout", sizeBytes: 8, truncated: true }),
        expect.objectContaining({ role: "stderr", sizeBytes: 5, truncated: true }),
      ]);
      expect(fs.readFileSync(path.join(rotation.archiveDir, "bot.out.log"), "utf8")).toBe("one\ntwo\n");
      expect(fs.statSync(paths.stdoutPath).size).toBe(0);
      expect(fs.statSync(paths.stderrPath).size).toBe(0);
    } finally {
      removeTempDir(logDir);
    }
  });

  it("handles missing logs, skips symlinks, and prunes old archives", () => {
    const logDir = createTempDir();
    try {
      const paths = testPaths(logDir);
      const archiveRoot = path.join(logDir, "archive");
      fs.mkdirSync(archiveRoot, { recursive: true });
      fs.mkdirSync(path.join(archiveRoot, "logs-20260101T000000000Z"));
      fs.mkdirSync(path.join(archiveRoot, "logs-20260102T000000000Z"));
      const target = path.join(logDir, "actual.err.log");
      fs.writeFileSync(target, "err\n", "utf8");
      fs.symlinkSync(target, paths.stderrPath);

      const rotation = rotateServiceLogs({
        paths,
        archiveRoot,
        truncate: true,
        maxArchives: 1,
        now: new Date("2026-04-20T00:00:00.000Z"),
      });

      expect(rotation.files).toEqual([
        expect.objectContaining({ role: "stdout", skippedReason: "missing", truncated: false }),
        expect.objectContaining({ role: "stderr", skippedReason: "symlink", truncated: false }),
      ]);
      expect(rotation.removedArchives).toHaveLength(2);
      expect(fs.existsSync(rotation.archiveDir)).toBe(true);
      expect(() => rotateServiceLogs({ paths, archiveRoot, maxArchives: 0 })).toThrow("maxArchives");
    } finally {
      removeTempDir(logDir);
    }
  });
});
