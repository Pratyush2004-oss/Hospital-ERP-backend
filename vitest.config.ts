import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.vitest.test.ts"],
    setupFiles: ["./src/test/setup-env.ts"],
    // The integration suite shares one PostgreSQL database and one Redis
    // database, so files must not run concurrently.
    fileParallelism: false,
    sequence: { concurrent: false },
    testTimeout: 30_000,
    hookTimeout: 60_000,
    restoreMocks: true,
  },
});
