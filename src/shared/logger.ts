import pino from "pino";

/** Pino logger type used across runtime services. */
export type Logger = pino.Logger;

/** Creates the process logger with the configured minimum level. */
export function createLogger(level = "info"): Logger {
  return pino({
    level,
    base: null,
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}
