import { describe, expect, it, vi } from "vitest";
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
    const recorder = new UsageRecorder({ update } as any);
    recorder.record("run-1", { input: 2 });
    recorder.record("run-2", undefined);
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith("run-1", { usageJson: "{\"input\":2}" });
  });
});
