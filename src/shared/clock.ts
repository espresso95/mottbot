/** Injectable clock interface used by stores and tests for deterministic timestamps. */
export type Clock = {
  now(): number;
};

/** Clock implementation backed by Date.now for production runtime paths. */
export const systemClock: Clock = {
  now: () => Date.now(),
};
