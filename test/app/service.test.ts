import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildLaunchAgentPlist,
  launchAgentPaths,
  launchAgentNodeCandidates,
  resolveLaunchAgentNodePath,
  SERVICE_LABEL,
} from "../../src/app/service.js";

describe("launchd service helpers", () => {
  it("builds a LaunchAgent plist that runs the bot from the project root", () => {
    const plist = buildLaunchAgentPlist({
      projectRoot: "/Users/mottbot/mottbot",
      configPath: "/Users/mottbot/mottbot/mottbot.config.json",
      stdoutPath: "/tmp/mottbot.out.log",
      stderrPath: "/tmp/mottbot.err.log",
    });

    expect(plist).toContain(`<string>${SERVICE_LABEL}</string>`);
    expect(plist).toContain("<key>KeepAlive</key>");
    expect(plist).toContain("<key>ThrottleInterval</key>");
    expect(plist).toContain("node_modules/tsx/dist/cli.mjs");
    expect(plist).toContain("MOTTBOT_CONFIG_PATH=&apos;/Users/mottbot/mottbot/mottbot.config.json&apos;");
    expect(plist).toContain("src/index.ts start");
    expect(plist).toContain("<string>/tmp/mottbot.out.log</string>");
    expect(plist).toContain("<string>/tmp/mottbot.err.log</string>");
  });

  it("embeds the resolved service Node path in the LaunchAgent command", () => {
    const plist = buildLaunchAgentPlist({
      projectRoot: "/Users/mottbot/mottbot",
      nodePath: "/tmp/node-24/bin/node",
      stdoutPath: "/tmp/mottbot.out.log",
      stderrPath: "/tmp/mottbot.err.log",
    });

    expect(plist).toContain("&apos;/tmp/node-24/bin/node&apos;");
  });

  it("uses per-label plist and log paths for parallel smoke lanes", () => {
    const paths = launchAgentPaths("ai.mottbot.bot.lane-1");

    expect(paths.label).toBe("ai.mottbot.bot.lane-1");
    expect(paths.plistPath).toContain("ai.mottbot.bot.lane-1.plist");
    expect(paths.logDir).toContain("mottbot/ai.mottbot.bot.lane-1");
    expect(paths.stdoutPath).toContain("mottbot/ai.mottbot.bot.lane-1/bot.out.log");
  });

  it("rejects unsafe service labels", () => {
    expect(() => launchAgentPaths("bad label")).toThrow(/service label/i);
  });

  it("escapes project roots before embedding them into shell and XML strings", () => {
    const plist = buildLaunchAgentPlist({
      projectRoot: "/tmp/mottbot's <workspace>",
      stdoutPath: "/tmp/out.log",
      stderrPath: "/tmp/err.log",
    });

    expect(plist).toContain("/tmp/mottbot&apos;s &lt;workspace&gt;");
    expect(plist).toContain("cd &apos;/tmp/mottbot&apos;\\&apos;&apos;s &lt;workspace&gt;&apos;");
  });

  it("honors MOTTBOT_SERVICE_NODE_PATH as the only service Node candidate", () => {
    const candidates = launchAgentNodeCandidates({
      MOTTBOT_SERVICE_NODE_PATH: "~/bin/node",
      PATH: path.dirname(process.execPath),
    });

    expect(candidates).toEqual([path.join(os.homedir(), "bin", "node")]);
  });

  it("rejects a service Node override that does not exist", () => {
    expect(() =>
      resolveLaunchAgentNodePath("/tmp", {
        MOTTBOT_SERVICE_NODE_PATH: "/tmp/mottbot-missing-node",
      }),
    ).toThrow(/MOTTBOT_SERVICE_NODE_PATH/);
  });
});
