import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // CLI/SDK files spawn real processes; keep file-level load bounded in small CI runners.
    maxWorkers: 2,
    include: ["tests/**/*.test.ts"],
    testTimeout: 15_000,
    restoreMocks: true,
    clearMocks: true,
  },
});
