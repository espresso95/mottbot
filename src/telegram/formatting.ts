const TELEGRAM_TEXT_LIMIT = 4000;

/** Removes Telegram-hostile null bytes and surrounding whitespace from outbound text. */
export function normalizeTelegramText(text: string): string {
  return text.replace(/\u0000/g, "").trim();
}

/** Splits outbound text into Telegram-sized chunks using natural whitespace breaks where possible. */
export function splitTelegramText(text: string, maxLength = TELEGRAM_TEXT_LIMIT): string[] {
  const normalized = normalizeTelegramText(text);
  if (!normalized) {
    return [""];
  }
  const chunks: string[] = [];
  let remaining = normalized;
  while (remaining.length > maxLength) {
    const slice = remaining.slice(0, maxLength);
    const breakAt =
      slice.lastIndexOf("\n\n") > maxLength / 2
        ? slice.lastIndexOf("\n\n")
        : slice.lastIndexOf("\n") > maxLength / 2
          ? slice.lastIndexOf("\n")
          : slice.lastIndexOf(" ") > maxLength / 2
            ? slice.lastIndexOf(" ")
            : maxLength;
    chunks.push(slice.slice(0, breakAt).trimEnd());
    remaining = remaining.slice(breakAt).trimStart();
  }
  if (remaining) {
    chunks.push(remaining);
  }
  return chunks.filter((chunk) => chunk.length > 0);
}
