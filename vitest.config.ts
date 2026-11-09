import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    exclude: process.env.CODESYS_LIVE ? [] : ["test/live/**"],
    // Several CODESYS at once can fail to load libraries, so live files take turns.
    fileParallelism: !process.env.CODESYS_LIVE,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    pool: "forks",
  },
});
