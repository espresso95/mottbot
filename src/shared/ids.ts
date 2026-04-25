import { randomUUID } from "node:crypto";

/** Creates a random URL-safe identifier for persisted application records. */
export function createId(): string {
  return randomUUID();
}
