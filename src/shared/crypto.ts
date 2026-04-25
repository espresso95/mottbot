import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { AppError } from "./errors.js";

const IV_BYTES = 12;
const TAG_BYTES = 16;

function normalizeKey(secret: string): Buffer {
  const trimmed = secret.trim();
  if (!trimmed) {
    throw new AppError("config.master_key_missing", "Missing security.masterKey.");
  }
  try {
    const base64 = Buffer.from(trimmed, "base64");
    if (base64.length === 32) {
      return base64;
    }
  } catch {
    // fall through to hash
  }
  return createHash("sha256").update(trimmed, "utf8").digest();
}

/** AES-GCM helper for sealing and opening local credential fields with the configured master key. */
export class SecretBox {
  readonly #key: Buffer;

  constructor(secret: string) {
    this.#key = normalizeKey(secret);
  }

  seal(plaintext: string): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", this.#key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, tag, ciphertext]).toString("base64");
  }

  open(ciphertext: string): string {
    const packed = Buffer.from(ciphertext, "base64");
    const iv = packed.subarray(0, IV_BYTES);
    const tag = packed.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
    const body = packed.subarray(IV_BYTES + TAG_BYTES);
    const decipher = createDecipheriv("aes-256-gcm", this.#key, iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(body), decipher.final()]);
    return plaintext.toString("utf8");
  }
}
