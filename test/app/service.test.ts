import { describe, expect, it } from "vitest";
import { buildLaunchAgentPlist, SERVICE_LABEL } from "../../src/app/service.js";

describe("launchd service helpers", () => {
  it("builds a LaunchAgent plist that runs the bot from the project root", () => {
    const plist = buildLaunchAgentPlist({
      projectRoot: "/Users/mottbot/mottbot",
      stdoutPath: "/tmp/mottbot.out.log",
      stderrPath: "/tmp/mottbot.err.log",
    });

    expect(plist).toContain(`<string>${SERVICE_LABEL}</string>`);
    expect(plist).toContain("<key>KeepAlive</key>");
    expect(plist).toContain("<key>ThrottleInterval</key>");
    expect(plist).toContain("node_modules/tsx/dist/cli.mjs");
    expect(plist).toContain("src/index.ts start");
    expect(plist).toContain("<string>/tmp/mottbot.out.log</string>");
    expect(plist).toContain("<string>/tmp/mottbot.err.log</string>");
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
});
