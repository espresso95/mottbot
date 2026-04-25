import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    restoreMocks: true,
    clearMocks: true,
    coverage: {
      provider: "v8",
      reporter: ["text"],
      include: ["src/**/*.ts"],
      exclude: [
        "src/index.ts",
        "src/**/types.ts",
        "src/tools/live-smoke-preflight.ts",
        "src/tools/live-telegram-user-smoke.ts",
        "src/tools/docs-link-check.ts",
        "src/app/service.ts",
      ],
      thresholds: {
        statements: 85.2,
        branches: 74,
        functions: 92,
        lines: 85.2,
      },
    },
  },
});
