import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";

test("cloud startup names missing keys before starting Docker or downloading models", async () => {
  const dir = await mkdtemp(`${tmpdir()}/inspiration-local-start-`);
  try {
    const result = spawnSync(process.execPath, [resolve("apps/web/src/local.ts")], {
      cwd: dir,
      env: {
        ...process.env,
        INSPIRATION_GATEWAY_CONFIG: "",
        INSPIRATION_DEEPSEEK_API_KEY: "",
        INSPIRATION_SILICONFLOW_API_KEY: "",
      },
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

test.each(["flag", "environment"])("custom gateway from %s requires its own credentials only", async (selection) => {
  const dir = await mkdtemp(`${tmpdir()}/inspiration-local-config-`);
  try {
    const config = join(dir, "gateway.yaml");
    await writeFile(
      config,
      JSON.stringify({
        providers: [
          {
            name: "alternate",
            kind: "openai_compatible",
            base_url: "https://alternate.example/v1",
            api_key_env: "INSPIRATION_TEST_ALTERNATE_KEY",
            max_sensitivity: "internal",
            models: [{ name: "alternate-model", operations: ["complete"] }],
          },
        ],
      }),
    );
    const args = [resolve("apps/web/src/local.ts"), ...(selection === "flag" ? ["--gateway", config] : [])];
    const env = {
      ...process.env,
      INSPIRATION_DEEPSEEK_API_KEY: "",
      INSPIRATION_SILICONFLOW_API_KEY: "",
      INSPIRATION_TEST_ALTERNATE_KEY: "",
      INSPIRATION_GATEWAY_CONFIG: selection === "environment" ? config : "unused.yaml",
    };
    const missing = spawnSync(process.execPath, args, { cwd: dir, env, encoding: "utf8", timeout: 10_000 });
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain("Set INSPIRATION_TEST_ALTERNATE_KEY in .env");
    expect(missing.stderr).not.toContain("INSPIRATION_DEEPSEEK_API_KEY");
    expect(missing.stderr).not.toContain("INSPIRATION_SILICONFLOW_API_KEY");
    expect(missing.stdout).not.toContain("Starting");
    // A provider with no credentials must not inherit the default preset's key requirements.
    const publicConfig = JSON.parse(await readFile(config, "utf8"));
    delete publicConfig.providers[0].api_key_env;
    await writeFile(config, JSON.stringify(publicConfig));
    const ready = spawnSync(process.execPath, args, {
      cwd: dir,
      env: { ...env, INSPIRATION_PUBLIC_URL: "https://not-loopback.example" },
      encoding: "utf8",
      timeout: 10_000,
    });
    expect(ready.stderr).toContain("Local services require HTTP loopback URLs");
    expect(ready.stderr).not.toContain("Set INSPIRATION_");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
