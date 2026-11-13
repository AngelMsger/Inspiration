import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { expect, test } from "vitest";

test("cloud startup names missing keys before starting Docker or downloading models", async () => {
  const dir = await mkdtemp(`${tmpdir()}/inspiration-local-start-`);
  try {
    const result = spawnSync(process.execPath, [resolve("apps/web/src/local.ts")], {
      cwd: dir,
      env: { ...process.env, INSPIRATION_DEEPSEEK_API_KEY: "", INSPIRATION_SILICONFLOW_API_KEY: "" },
      encoding: "utf8",
      timeout: 10_000,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("INSPIRATION_DEEPSEEK_API_KEY and INSPIRATION_SILICONFLOW_API_KEY");
    expect(result.stdout).not.toContain("Starting");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
