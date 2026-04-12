import { describe, expect, it } from "vitest";
import { SecretBox } from "../../src/shared/crypto.js";

describe("SecretBox", () => {
  it("round-trips plaintext", () => {
    const box = new SecretBox("test-secret");
    const sealed = box.seal("hello");
    expect(sealed).not.toBe("hello");
    expect(box.open(sealed)).toBe("hello");
  });

  it("accepts a base64-encoded 32-byte key", () => {
    const key = Buffer.alloc(32, 7).toString("base64");
    const box = new SecretBox(key);
    const sealed = box.seal("payload");
    expect(box.open(sealed)).toBe("payload");
  });
});
