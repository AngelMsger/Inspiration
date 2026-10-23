#!/usr/bin/env node
// Serve the model gateway over HTTP.
//
// Usage: inspiration-gateway [--config gateway.yaml] [--host 127.0.0.1] [--port 8100]

import { parseArgs } from "node:util";
import { serve } from "@hono/node-server";
import { getSettings, LocalBlobStore, logger, openPool } from "@inspiration/kernel";
import { Redis } from "ioredis";
import { ValkeyCache } from "../cache.ts";
import { loadGatewayConfig } from "../config.ts";
import { Gateway } from "../gateway.ts";
import { createApp } from "../http.ts";
import { PostgresUsage } from "../metering.ts";

const { values } = parseArgs({
  options: {
    config: { type: "string" },
    host: { type: "string", default: "127.0.0.1" },
    port: { type: "string", default: "8100" },
  },
});
const settings = getSettings();
const path = values.config ?? settings.gatewayConfig;
if (!path) {
  console.error("inspiration-gateway: --config or INSPIRATION_GATEWAY_CONFIG is required");
  process.exit(2);
}
const config = loadGatewayConfig(path);
const pool = await openPool(settings.databaseUrl);
const cache =
  config.cache.backend === "valkey"
    ? new ValkeyCache(new Redis(settings.valkeyUrl), { prefix: settings.streamPrefix })
    : undefined;
const gateway = await Gateway.create(config, {
  usage: new PostgresUsage(pool),
  blobs: new LocalBlobStore(settings.blobDir),
  ...(cache ? { cache } : {}),
});
const server = serve({ fetch: createApp(gateway).fetch, hostname: values.host, port: Number(values.port) });
logger("model-gateway").info("listening", { host: values.host, port: Number(values.port) });
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    server.close();
    void Promise.all([gateway.close(), pool.end(), cache?.client.quit()]);
  });
}
