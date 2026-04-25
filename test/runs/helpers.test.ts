import { describe, expect, it, vi } from "vitest";
import { appendPreparedAttachmentsToLatestUserMessage } from "../../src/runs/attachment-inputs.js";
import { StreamCollector } from "../../src/runs/stream-collector.js";
import { UsageRecorder } from "../../src/runs/usage-recorder.js";

describe("run helpers", () => {
  it("collects text and thinking deltas", () => {
    const collector = new StreamCollector();
    expect(collector.appendText("hello ")).toBe("hello ");
    expect(collector.appendText("world")).toBe("hello world");
    expect(collector.appendThinking("hmm")).toBe("hmm");
    expect(collector.getText()).toBe("hello world");
    expect(collector.getThinking()).toBe("hmm");
  });

  it("records usage through the run store", () => {
    const update = vi.fn();
    const recorder = new UsageRecorder({ update });
    recorder.record("run-1", { input: 2 });
    recorder.record("run-2", undefined);
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith("run-1", { usageJson: '{"input":2}' });
  });

  it("appends extracted file text and native images only to the latest user message", () => {
    const messages = appendPreparedAttachmentsToLatestUserMessage({
      messages: [
        { role: "user", content: "older", timestamp: 1 },
        { role: "assistant", content: "ok", timestamp: 2 },
        { role: "user", content: "new", timestamp: 3 },
      ],
      extractedTexts: [
        {
          kind: "code",
          fileName: "/tmp/secret/main.ts",
          mimeType: "text/typescript",
          language: "typescript",
          text: "const value = 1;",
          textChars: 16,
          promptChars: 16,
          truncated: false,
        },
      ],
      nativeInputs: [
        { type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
        { type: "file", data: "c2VjcmV0", mimeType: "application/pdf", fileName: "/tmp/secret/report.pdf" },
      ],
    });

    expect(messages[0]?.content).toBe("older");
    expect(messages[2]?.content).toEqual([
      { type: "text", text: "new" },
      expect.objectContaining({
        type: "text",
        text: expect.stringContaining("main.ts"),
      }),
      { type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
      { type: "file", data: "c2VjcmV0", mimeType: "application/pdf", fileName: "report.pdf" },
    ]);
    expect(JSON.stringify(messages)).not.toContain("/tmp/secret");
  });
});
