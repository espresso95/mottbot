import type { ParsedCommand } from "./types.js";

/** Profile IDs accepted by Telegram profile selection commands. */
export const PROFILE_ID_PATTERN = /^[A-Za-z0-9:_./-]{1,128}$/;

/** Maximum visible label length accepted by Telegram route bindings. */
export const MAX_BINDING_NAME_LENGTH = 64;

/** Parses a Telegram slash command into the command name, arguments, and raw text. */
export function parseCommand(text: string): ParsedCommand {
  const trimmed = text.trim();
  const [head = "", ...rest] = trimmed.split(/\s+/);
  const command = head.replace(/^\//, "").replace(/@.+$/, "").toLowerCase();
  return {
    command,
    args: rest,
    raw: trimmed,
  };
}

/** Returns a trimmed single command argument, or undefined when it is empty. */
export function normalizeSingleArg(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/** Normalizes free-form words into a compact route binding label. */
export function normalizeBindingName(raw: string[]): string {
  return raw.join(" ").replace(/\s+/g, " ").trim() || "here";
}

/** Checks whether a route binding label is within Telegram command constraints. */
export function validateBindingName(value: string): boolean {
  return value.length <= MAX_BINDING_NAME_LENGTH && !/[\u0000-\u001f\u007f]/.test(value);
}

/** Joins command arguments into one normalized free-text value. */
export function normalizeFreeText(args: string[]): string {
  return args.join(" ").replace(/\s+/g, " ").trim();
}

/** Parses a positive list limit and clamps it to the standard command range. */
export function parseBoundedLimit(value: string | undefined, fallback: number): number {
  const parsed = Number(value ?? fallback);
  return Number.isInteger(parsed) ? Math.min(Math.max(parsed, 1), 50) : fallback;
}
