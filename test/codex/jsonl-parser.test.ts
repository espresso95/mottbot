import { describe, expect, it } from "vitest";
import { parseJsonlChunk } from "../../src/codex-cli/codex-jsonl-parser.js";

describe("parseJsonlChunk", () => {
  it("parses complete lines and preserves tail buffer", () => {
    const first = parseJsonlChunk("", '{"type":"turn.started"}\n{"type":"turn');
    expect(first.events).toHaveLength(1);
    expect(first.events[0]?.type).toBe("turn.started");
    expect(first.nextBuffer).toBe('{"type":"turn');

    const second = parseJsonlChunk(first.nextBuffer, '.completed"}\nnot json\n');
    expect(second.events).toHaveLength(2);
    expect(second.events[0]?.type).toBe("turn.completed");
    expect(second.events[1]?.type).toBe("mottbot.parse_error");
    expect(second.nextBuffer).toBe("");
  });
});
