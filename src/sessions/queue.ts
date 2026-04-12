import { AppError } from "../shared/errors.js";

export class SessionQueue {
  private readonly tails = new Map<string, Promise<unknown>>();
  private readonly activeControllers = new Map<string, AbortController>();

  enqueue<T>(sessionKey: string, task: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const currentTail = this.tails.get(sessionKey) ?? Promise.resolve();
    const next = currentTail
      .catch(() => undefined)
      .then(async () => {
        const controller = new AbortController();
        this.activeControllers.set(sessionKey, controller);
        try {
          return await task(controller.signal);
        } finally {
          if (this.activeControllers.get(sessionKey) === controller) {
            this.activeControllers.delete(sessionKey);
          }
        }
      });
    const tail = next
      .catch(() => undefined)
      .finally(() => {
        if (this.tails.get(sessionKey) === tail) {
          this.tails.delete(sessionKey);
        }
      });
    this.tails.set(sessionKey, tail);
    return next;
  }

  cancel(sessionKey: string): boolean {
    const controller = this.activeControllers.get(sessionKey);
    if (!controller || controller.signal.aborted) {
      return false;
    }
    controller.abort(new AppError("run.cancelled", "Run cancelled by operator."));
    return true;
  }
}
