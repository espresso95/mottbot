/** Parsed command-line flags for smoke harnesses. */
export type ParsedCliArgs = {
  values: Map<string, string[]>;
  positionals: string[];
};

function appendValue(values: Map<string, string[]>, name: string, value: string): void {
  values.set(name, [...(values.get(name) ?? []), value]);
}

/** Parses simple --flag value, --flag=value, --flag, and --no-flag arguments. */
export function parseCliArgs(argv: readonly string[]): ParsedCliArgs {
  const values = new Map<string, string[]>();
  const positionals: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item) {
      continue;
    }
    if (item === "--") {
      positionals.push(...argv.slice(index + 1));
      break;
    }
    if (!item.startsWith("--")) {
      positionals.push(item);
      continue;
    }
    if (item.startsWith("--no-")) {
      appendValue(values, item.slice("--no-".length), "false");
      continue;
    }
    const withoutPrefix = item.slice("--".length);
    const equalsIndex = withoutPrefix.indexOf("=");
    if (equalsIndex >= 0) {
      appendValue(values, withoutPrefix.slice(0, equalsIndex), withoutPrefix.slice(equalsIndex + 1));
      continue;
    }
    const next = argv[index + 1];
    if (next && !next.startsWith("--")) {
      appendValue(values, withoutPrefix, next);
      index += 1;
      continue;
    }
    appendValue(values, withoutPrefix, "true");
  }
  return { values, positionals };
}

function lastFlagValue(args: ParsedCliArgs, name: string): string | undefined {
  const values = args.values.get(name);
  return values?.[values.length - 1];
}

/** Reads a non-empty string flag. */
export function stringFlag(args: ParsedCliArgs, name: string): string | undefined {
  const trimmed = lastFlagValue(args, name)?.trim();
  return trimmed ? trimmed : undefined;
}

/** Reads a comma-splittable, repeatable string flag. */
export function stringListFlag(args: ParsedCliArgs, name: string): string[] {
  return (args.values.get(name) ?? [])
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter(Boolean);
}

/** Parses common boolean flag values. */
export function parseBooleanValue(name: string, value: string | undefined, fallback: boolean): boolean {
  const raw = value?.trim().toLowerCase();
  if (!raw) {
    return fallback;
  }
  if (["1", "true", "yes", "on"].includes(raw)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(raw)) {
    return false;
  }
  throw new Error(`--${name} must be true or false.`);
}

/** Reads a boolean flag. */
export function booleanFlag(args: ParsedCliArgs, name: string, fallback: boolean): boolean {
  return parseBooleanValue(name, lastFlagValue(args, name), fallback);
}

export function positiveIntegerFlag(args: ParsedCliArgs, name: string): number | undefined;
export function positiveIntegerFlag(args: ParsedCliArgs, name: string, fallback: number): number;

/** Reads a positive integer flag. */
export function positiveIntegerFlag(args: ParsedCliArgs, name: string, fallback?: number): number | undefined {
  const raw = stringFlag(args, name);
  if (!raw) {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`--${name} must be a positive integer.`);
  }
  return parsed;
}

/** Appends a string flag when its value is present. */
export function pushStringFlag(argv: string[], name: string, value: string | undefined): void {
  const trimmed = value?.trim();
  if (trimmed) {
    argv.push(`--${name}`, trimmed);
  }
}

/** Appends a number flag when its value is present. */
export function pushNumberFlag(argv: string[], name: string, value: number | undefined): void {
  if (value !== undefined) {
    argv.push(`--${name}`, String(value));
  }
}

/** Appends a boolean flag when it differs from the default. */
export function pushBooleanFlag(argv: string[], name: string, value: boolean | undefined, fallback: boolean): void {
  if (value === undefined || value === fallback) {
    return;
  }
  argv.push(value ? `--${name}` : `--no-${name}`);
}

/** Lists unique flag names from argv without exposing flag values. */
export function listCliFlagNames(argv: readonly string[]): string[] {
  const names = new Set<string>();
  for (const item of argv) {
    if (!item.startsWith("--")) {
      continue;
    }
    if (item === "--") {
      continue;
    }
    const withoutPrefix = item.startsWith("--no-") ? item.slice("--no-".length) : item.slice("--".length);
    names.add(`--${withoutPrefix.split("=")[0]}`);
  }
  return [...names].sort();
}
