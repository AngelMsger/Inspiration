#!/usr/bin/env node
// Write schema.zed to SpiceDB.
//
// Usage: inspiration-authz-schema [--endpoint localhost:50051] [--insecure]

import { parseArgs } from "node:util";
import { getSettings } from "@inspiration/kernel";
import { closeClient, connect, writeSchema } from "../spicedb.ts";

const settings = getSettings();
const { values } = parseArgs({
  options: {
    endpoint: { type: "string", default: settings.spicedbEndpoint },
    insecure: { type: "boolean", default: settings.spicedbInsecure },
  },
});

const client = connect(values.endpoint, settings.spicedbKey, { insecure: values.insecure });
try {
  console.log(`authz: schema written at ${await writeSchema(client)}`);
} catch (e) {
  console.error(`authz: schema write failed: ${(e as Error).message}`);
  process.exitCode = 1;
} finally {
  closeClient(client);
}
