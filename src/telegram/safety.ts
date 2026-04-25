import type { AppConfig } from "../app/config.js";
import type { InboundEvent } from "./types.js";

/** Result of pre-run safety checks for inbound text and attachment limits. */
type SafetyDecision =
  | { allow: true }
  | {
      allow: false;
      reason: "text_too_long" | "too_many_attachments" | "attachment_too_large" | "attachments_too_large";
      message: string;
    };

function formatBytes(value: number): string {
  if (value < 1024) {
    return `${value} B`;
  }
  if (value < 1024 * 1024) {
    return `${(value / 1024).toFixed(1)} KB`;
  }
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

/** Applies configured inbound message and attachment limits before processing a Telegram event. */
export function validateInboundSafety(config: AppConfig, event: InboundEvent): SafetyDecision {
  const visibleText = event.text ?? event.caption ?? "";
  if (visibleText.length > config.behavior.maxInboundTextChars) {
    return {
      allow: false,
      reason: "text_too_long",
      message: `Message is too long. Limit is ${config.behavior.maxInboundTextChars} characters.`,
    };
  }

  if (event.attachments.length > config.attachments.maxPerMessage) {
    return {
      allow: false,
      reason: "too_many_attachments",
      message: `Too many attachments. Limit is ${config.attachments.maxPerMessage} per message.`,
    };
  }

  let knownTotalBytes = 0;
  for (const attachment of event.attachments) {
    if (typeof attachment.fileSize !== "number") {
      continue;
    }
    if (attachment.fileSize > config.attachments.maxFileBytes) {
      return {
        allow: false,
        reason: "attachment_too_large",
        message: `Attachment is too large. Per-file limit is ${formatBytes(config.attachments.maxFileBytes)}.`,
      };
    }
    knownTotalBytes += attachment.fileSize;
  }

  if (knownTotalBytes > config.attachments.maxTotalBytes) {
    return {
      allow: false,
      reason: "attachments_too_large",
      message: `Attachments are too large. Combined known-size limit is ${formatBytes(config.attachments.maxTotalBytes)}.`,
    };
  }

  return { allow: true };
}
