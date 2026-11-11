#!/usr/bin/env node
/** One workstation: durable engine, business backend, built web app and local embedding models. */
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs, parseEnv } from "node:util";
import { build } from "vite";

const children: ChildProcess[] = [];
let stopping = false;
function stop(code: number) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill("SIGTERM");
  const timer = setTimeout(() => {
    for (const child of children) child.kill("SIGKILL");
    process.exit(code);
  }, 5000);
  Promise.all(
    children.map((child) =>
      child.exitCode !== null ? Promise.resolve() : new Promise<void>((done) => child.once("exit", () => done())),
    ),
  ).then(() => {
    clearTimeout(timer);
    process.exit(code);
  });
}

function start(command: string, args: string[]): ChildProcess {
  const child = spawn(command, args, { stdio: "inherit", env: process.env });
  children.push(child);
  child.on("error", () => {
    console.error(`Could not start ${command}. See docs/local.md for prerequisites.`);
    stop(1);
  });
  if (command === process.execPath)
    child.on("exit", () => {
      if (!stopping) {
        console.error("A local service stopped; shutting down the other processes.");
        stop(1);
      }
    });
  return child;
}

async function ready(url: string, child: ChildProcess, seconds = 90): Promise<void> {
  const until = Date.now() + seconds * 1000;
  while (Date.now() < until) {
    if (child.exitCode !== null) throw new Error("A local service stopped during startup; see its output above.");
    const response = await fetch(url, { signal: AbortSignal.timeout(1000) }).catch(() => undefined);
    if (response?.ok) return;
    await new Promise((done) => setTimeout(done, 300));
  }
  throw new Error(`Local service did not become ready at ${url}. See its output above.`);
}

async function main() {
  const { values } = parseArgs({
    options: { mock: { type: "boolean", default: false }, "skip-stack": { type: "boolean", default: false } },
  });
  if (existsSync(".env"))
    for (const [key, value] of Object.entries(parseEnv(readFileSync(".env", "utf8")))) process.env[key] ??= value;
  if (!values.mock && !process.env.INSPIRATION_DEEPSEEK_API_KEY)
    throw new Error(
      "Set INSPIRATION_DEEPSEEK_API_KEY in .env, or use pnpm local --mock for a pipeline-only rehearsal.",
    );
  process.env.INSPIRATION_LOCAL_CONNECTIONS = "1";
  process.env.INSPIRATION_LOCAL_MODEL_MODE = values.mock ? "mock" : "deepseek";
  process.env.INSPIRATION_PUBLIC_URL ??= "http://localhost:4200";
  process.env.INSPIRATION_ENGINE_URL ??= "http://127.0.0.1:4100";
  const publicUrl = new URL(process.env.INSPIRATION_PUBLIC_URL);
  const engineUrl = new URL(process.env.INSPIRATION_ENGINE_URL);
  for (const url of [publicUrl, engineUrl])
    if (url.protocol !== "http:" || !["localhost", "127.0.0.1"].includes(url.hostname))
      throw new Error("Local services require HTTP loopback URLs.");
  // Mock vectors and real embeddings must never share an index, even though their dimensions match.
  const dataDir = values.mock ? ".data/local-mock" : ".data/local";
  await mkdir(dataDir, { recursive: true });
  process.env.INSPIRATION_BLOB_DIR ??= resolve(dataDir, "blobs");
  if (values.mock) {
    // Rehearsals keep their own database, graph and event stream via a separate Compose project.
    process.env.INSPIRATION_PG_PORT ??= "55432";
    process.env.INSPIRATION_VALKEY_PORT ??= "56379";
    process.env.INSPIRATION_SPICEDB_PORT ??= "55051";
    process.env.INSPIRATION_SPICEDB_HTTP_PORT ??= "58443";
  }
  const env = process.env;
  env.INSPIRATION_DATABASE_URL ??= `postgresql://inspiration:${encodeURIComponent(env.INSPIRATION_PG_PASSWORD ?? "inspiration")}@localhost:${env.INSPIRATION_PG_PORT ?? "5432"}/inspiration`;
  env.INSPIRATION_VALKEY_URL ??= `redis://localhost:${env.INSPIRATION_VALKEY_PORT ?? "6379"}/0`;
  env.INSPIRATION_SPICEDB_ENDPOINT ??= `localhost:${env.INSPIRATION_SPICEDB_PORT ?? "50051"}`;
  if (!values["skip-stack"]) {
    console.log("Starting the local database, event queue and permission store…");
    const docker = start("docker", [
      "compose",
      "-p",
      values.mock ? "inspiration-local-mock" : "inspiration",
      "-f",
      "infra/compose.yaml",
      "up",
      "-d",
      "--wait",
    ]);
    const code = await new Promise<number | null>((done) => docker.once("exit", done));
    if (code !== 0) throw new Error("The local stack did not start. Check Docker and available ports.");
  }
  console.log("Building the web app…");
  await build({ configFile: resolve("apps/web/vite.config.ts") });
  if (!values.mock) {
    if (!existsSync("infra/local-embeddings/node_modules"))
      throw new Error("Run npm ci --prefix infra/local-embeddings before starting the local models.");
    const embedding = start(process.execPath, ["infra/local-embeddings/server.ts"]);
    await ready("http://127.0.0.1:8090/v1/models", embedding);
    console.log("The embedding models load on first use; the first import can take several minutes.");
  }
  const python = process.platform === "win32" ? ".venv/Scripts/python.exe" : ".venv/bin/python";
  if (existsSync(python)) {
    const parser = spawn(resolve(python), ["-m", "inspiration_parsing"], {
      cwd: "engine/parsing/worker",
      stdio: "inherit",
      env,
    });
    children.push(parser);
    parser.on("error", () => {
      console.error("The parsing worker could not start.");
      stop(1);
    });
  }
  const engine = start(process.execPath, [
    "apps/engine/src/serve.ts",
    "serve",
    "--persistent",
    "--discover-facts",
    "--port",
    engineUrl.port || "4100",
    "--issuer",
    publicUrl.origin,
    "--audience",
    engineUrl.origin,
    "--gateway",
    values.mock ? "config/gateway.dev.yaml" : "config/gateway.trial.yaml",
  ]);
  await ready(`${engineUrl.origin}/v0/health`, engine);
  const business = start(process.execPath, [
    "apps/business/src/serve.ts",
    "serve",
    "--local",
    "--port",
    publicUrl.port || "4200",
    "--web",
    "apps/web/dist",
  ]);
  await ready(`${publicUrl.origin}/api/health`, business);
  for (const child of children)
    if (child.exitCode === null)
      child.on("exit", () => {
        if (!stopping) {
          console.error("A local service stopped; shutting down the other processes.");
          stop(1);
        }
      });
  console.log(
    `\nOpen ${publicUrl.origin} — ${values.mock ? "MOCK models: pipeline rehearsal only" : "DeepSeek with local embeddings"}. Ctrl+C stops the app; data is kept.`,
  );
}

process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));
main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Local startup failed.");
  stop(1);
});
