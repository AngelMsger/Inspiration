#!/usr/bin/env node
/**
 * pnpm demo [--corpus examples/corpus] [--today YYYY-MM-DD] [--port 5173]
 *
 * Starts the demo: the engine process over a copy of a corpus (pnpm engine serve), and once it
 * has read the corpus, the web app's development server in front of it. The copy is what the
 * demo's upstream edits change (updates.ts), so the corpus in the repository stays as it is.
 * Models are the development stand-ins, so the demo costs nothing and needs no network. Ctrl-C
 * stops both and removes the copy.
 */

import { spawn } from "node:child_process";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createServer } from "vite";

const SERVE = fileURLToPath(new URL("../../engine/src/serve.ts", import.meta.url));
const ENGINE_PORT = 4100;

async function healthy(url: string, deadline: number, alive: () => boolean): Promise<void> {
  while (Date.now() < deadline) {
    if (!alive()) throw new Error("the engine stopped before it served");
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // Not listening yet.
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`the engine did not answer at ${url}`);
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      corpus: { type: "string", default: "examples/corpus" },
      today: { type: "string" },
      port: { type: "string", default: "5173" },
    },
  });
  const copy = await mkdtemp(join(tmpdir(), "inspiration-demo-"));
  await cp(resolve(values.corpus), copy, { recursive: true });
  process.env.INSPIRATION_DEMO_CORPUS = copy;
  process.env.INSPIRATION_PEOPLE ??= join(copy, "people.yaml");
  const engine = spawn(
    process.execPath,
    [
      SERVE,
      "serve",
      copy,
      "--dev-identity",
      "--port",
      String(ENGINE_PORT),
      ...(values.today ? ["--today", values.today] : []),
    ],
    { stdio: "inherit", env: { INSPIRATION_LOG_LEVEL: "warn", ...process.env } },
  );
  let running = true;
  engine.on("exit", () => {
    running = false;
  });
  console.log(`reading ${values.corpus} with the development models…`);
  await healthy(`http://127.0.0.1:${ENGINE_PORT}/v0/health`, Date.now() + 300_000, () => running);

  const web = await createServer({
    configFile: fileURLToPath(new URL("../vite.config.ts", import.meta.url)),
    server: { port: Number(values.port), strictPort: true },
  });
  await web.listen();
  web.printUrls();
  const stop = () => {
    void web.close();
    engine.kill("SIGTERM");
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  engine.on("exit", (code) => {
    void web.close();
    void rm(copy, { recursive: true, force: true });
    process.exitCode = code ?? 0;
  });
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
