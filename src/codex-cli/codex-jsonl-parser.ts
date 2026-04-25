/** One JSONL event emitted by the Codex CLI process. */
export type CodexJsonlEvent = {
  type?: string;
  [key: string]: unknown;
};

/** Parses an incremental JSONL chunk while preserving any incomplete trailing line. */
export function parseJsonlChunk(buffer: string, chunk: string): { nextBuffer: string; events: CodexJsonlEvent[] } {
  const raw = `${buffer}${chunk}`;
  const lines = raw.split(/\r?\n/);
  const nextBuffer = lines.pop() ?? "";
  const events: CodexJsonlEvent[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      const parsed = JSON.parse(trimmed) as CodexJsonlEvent;
      events.push(parsed);
    } catch {
      events.push({ type: "mottbot.parse_error", raw: trimmed });
    }
  }
  return { nextBuffer, events };
}
