export class AgentRunLimiter {
  private readonly active = new Map<string, number>();
  private readonly waiters = new Map<string, Array<() => void>>();

  async run<T>(
    agentId: string,
    maxConcurrentRuns: number | undefined,
    task: () => Promise<T>,
  ): Promise<T> {
    if (maxConcurrentRuns === undefined) {
      return task();
    }
    await this.acquire(agentId, maxConcurrentRuns);
    try {
      return await task();
    } finally {
      this.release(agentId);
    }
  }

  private acquire(agentId: string, maxConcurrentRuns: number): Promise<void> {
    const activeCount = this.active.get(agentId) ?? 0;
    if (activeCount < maxConcurrentRuns) {
      this.active.set(agentId, activeCount + 1);
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const waiters = this.waiters.get(agentId) ?? [];
      waiters.push(() => {
        this.active.set(agentId, (this.active.get(agentId) ?? 0) + 1);
        resolve();
      });
      this.waiters.set(agentId, waiters);
    });
  }

  private release(agentId: string): void {
    const activeCount = this.active.get(agentId) ?? 0;
    if (activeCount <= 1) {
      this.active.delete(agentId);
    } else {
      this.active.set(agentId, activeCount - 1);
    }
    const waiters = this.waiters.get(agentId);
    const next = waiters?.shift();
    if (!waiters || waiters.length === 0) {
      this.waiters.delete(agentId);
    }
    next?.();
  }
}
