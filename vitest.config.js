import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    // Extension-only: tests live under tests/ and load extension/*.js via evalModule().
    include: ["tests/unit/**/*.test.js", "tests/property/**/*.test.js"],
    globals: true,
    // Branch coverage for extension IIFE modules is verified by Stryker (npm run test:mutation).
    // v8 cannot attribute coverage to code loaded via `new Function()` without source maps.
    coverage: {
      // istanbul + evalModule instrumentation — v8 cannot track `new Function()` code.
      provider: "istanbul",
      reporter: ["text", "html"],
      include: ["extension/**/*.js"],
      exclude: ["extension/icons/**"],
      // Only list files that tests actually executed (avoids a flat 0% row per file).
      all: false,
    },
  },
});
