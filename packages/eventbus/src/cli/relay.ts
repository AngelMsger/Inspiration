#!/usr/bin/env node
// Forward committed outbox rows to the event transport until interrupted.
//
// Usage: inspiration-relay [--transport valkey]

import { parseArgs } from "node:util";
import { getSettings, registry } from "@inspiration/kernel";
import { OutboxRelay } from "../relay.ts";
import type { Transport } from "../transport.ts";

interface TransportClass {
  new (): Transport;
  fromUrl?(url: string, options: { prefix: string }): Transport;
}

const { values } = parseArgs({ options: { transport: { type: "string", default: "valkey" } } });
const settings = getSettings();
const Cls = await registry("event_transports").get<TransportClass>(values.transport);
const transport = Cls.fromUrl ? Cls.fromUrl(settings.valkeyUrl, { prefix: settings.streamPrefix }) : new Cls();
const relay = new OutboxRelay(settings.databaseUrl, transport);
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => void relay.stop());
await relay.run();
await transport.close();
