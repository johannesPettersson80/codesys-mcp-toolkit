import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    exclude: process.env.CODESYS_LIVE ? [] : ["test/live/**"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    pool: "forks",
  },
});
