import type { Logger } from "../shared/logger.js";

/** Registers one-shot SIGINT and SIGTERM handlers that run async cleanup before exiting. */
export function installShutdown(params: { logger: Logger; onShutdown: () => Promise<void> }): void {
  let shuttingDown = false;
  const handle = async (signal: NodeJS.Signals) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    params.logger.info({ signal }, "Shutting down.");
    try {
      await params.onShutdown();
    } finally {
      process.exit(0);
    }
  };

  process.once("SIGINT", () => void handle("SIGINT"));
  process.once("SIGTERM", () => void handle("SIGTERM"));
}
