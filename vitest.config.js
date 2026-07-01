import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    // Extension-only: tests live under tests/ and load extension/*.js via evalModule().
    include: ["tests/unit/**/*.test.js", "tests/property/**/*.test.js"],
    globals: true,
    // Property tests re-evaluate extension modules (evalModule) on every one
    // of their ~200-500 fast-check runs, so a handful of them legitimately
    // take several seconds even in isolation. The default 5000ms timeout is
    // fine most of the time but flakes under CPU contention (e.g. running
    // the full suite, where many test files execute in parallel). Give
    // everything more headroom rather than tuning each slow test by hand.
    testTimeout: 20000,
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
