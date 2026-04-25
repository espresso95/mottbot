import { describe, expect, it } from "vitest";
import {
  booleanFlag,
  listCliFlagNames,
  parseCliArgs,
  positiveIntegerFlag,
  stringFlag,
  stringListFlag,
} from "../../scripts/smoke/cli-args.js";

describe("smoke CLI args", () => {
  it("parses strings, booleans, lists, and positive integers", () => {
    const args = parseCliArgs([
      "--repository=owner/repo",
      "--no-dry-run",
      "--label",
      "smoke,bot",
      "--label",
      "extra",
      "--pr-number",
      "7",
    ]);

    expect(stringFlag(args, "repository")).toBe("owner/repo");
    expect(booleanFlag(args, "dry-run", true)).toBe(false);
    expect(stringListFlag(args, "label")).toEqual(["smoke", "bot", "extra"]);
    expect(positiveIntegerFlag(args, "pr-number")).toBe(7);
  });

  it("lists flag names without values", () => {
    expect(listCliFlagNames(["--api-id", "12345", "--api-hash=secret", "--no-expect-reply"])).toEqual([
      "--api-hash",
      "--api-id",
      "--expect-reply",
    ]);
  });
});
