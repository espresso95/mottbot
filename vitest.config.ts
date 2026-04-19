import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    restoreMocks: true,
    clearMocks: true,
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["src/**/*.ts"],
      exclude: ["src/index.ts", "src/tools/live-smoke-preflight.ts", "src/app/service.ts"],
      thresholds: {
        statements: 84,
        branches: 70,
        functions: 88,
        lines: 84,
      },
    },
  },
});
