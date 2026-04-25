import type { MemoryCandidateSensitivity } from "./memory-store.js";

/** Classifies memory text by the highest privacy sensitivity detected locally. */
export function classifyMemorySensitivity(text: string): MemoryCandidateSensitivity {
  if (
    /token|secret|password|api\s*key|private\s*key|bearer|authorization|-----BEGIN/i.test(text) ||
    /\b\d{6,12}:[A-Za-z0-9_-]{20,}\b/.test(text) ||
    /\b(?:gho_|ghp_|github_pat_)[A-Za-z0-9_]+\b/i.test(text)
  ) {
    return "high";
  }
  if (
    /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(text) ||
    /\+?\d[\d\s().-]{7,}\d/.test(text) ||
    /\bhome address\b|\bmedical\b|\bfinancial\b|\bsocial security\b/i.test(text)
  ) {
    return "medium";
  }
  return "low";
}
