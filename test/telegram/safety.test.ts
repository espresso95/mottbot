import { describe, expect, it } from "vitest";
import { validateInboundSafety } from "../../src/telegram/safety.js";
import { createInboundEvent, createTestConfig } from "../helpers/fakes.js";

describe("validateInboundSafety", () => {
  it("allows normal inbound events", () => {
    const config = createTestConfig({
      behavior: { maxInboundTextChars: 20 } as any,
      attachments: { maxPerMessage: 2, maxFileBytes: 10, maxTotalBytes: 20 } as any,
    });

    expect(
      validateInboundSafety(
        config,
        createInboundEvent({
          text: "hello",
          attachments: [{ kind: "photo", fileId: "p1", fileSize: 5 }],
        }),
      ),
    ).toEqual({ allow: true });
  });

  it("rejects oversized text", () => {
    const config = createTestConfig({
      behavior: { maxInboundTextChars: 5 } as any,
    });

    expect(validateInboundSafety(config, createInboundEvent({ text: "too long" }))).toMatchObject({
      allow: false,
      reason: "text_too_long",
      message: "Message is too long. Limit is 5 characters.",
    });
  });

  it("rejects too many attachments", () => {
    const config = createTestConfig({
      attachments: { maxPerMessage: 1 } as any,
    });

    expect(
      validateInboundSafety(
        config,
        createInboundEvent({
          attachments: [
            { kind: "photo", fileId: "p1" },
            { kind: "photo", fileId: "p2" },
          ],
        }),
      ),
    ).toMatchObject({
      allow: false,
      reason: "too_many_attachments",
      message: "Too many attachments. Limit is 1 per message.",
    });
  });

  it("rejects oversized known attachment bytes", () => {
    const config = createTestConfig({
      attachments: { maxFileBytes: 4, maxTotalBytes: 10 } as any,
    });

    expect(
      validateInboundSafety(
        config,
        createInboundEvent({
          attachments: [{ kind: "document", fileId: "d1", fileSize: 5 }],
        }),
      ),
    ).toMatchObject({
      allow: false,
      reason: "attachment_too_large",
    });
  });

  it("rejects oversized combined known attachment bytes", () => {
    const config = createTestConfig({
      attachments: { maxPerMessage: 3, maxFileBytes: 10, maxTotalBytes: 9 } as any,
    });

    expect(
      validateInboundSafety(
        config,
        createInboundEvent({
          attachments: [
            { kind: "document", fileId: "d1", fileSize: 5 },
            { kind: "document", fileId: "d2", fileSize: 5 },
          ],
        }),
      ),
    ).toMatchObject({
      allow: false,
      reason: "attachments_too_large",
    });
  });
});
