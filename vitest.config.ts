import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts", "apps/*/test/**/*.test.ts", "test/**/*.test.ts"],
    globalSetup: ["packages/testkit/src/global-setup.ts"],
    // Tests provoke failures on purpose; set INSPIRATION_LOG_LEVEL=debug to see the logs.
    env: { INSPIRATION_LOG_LEVEL: process.env.INSPIRATION_LOG_LEVEL ?? "off" },
    // Integration tests create databases and talk to the stack; give them room.
    testTimeout: 20_000,
    hookTimeout: 60_000,
  },
});
