/**
 * Deployment settings, read from INSPIRATION_* environment variables (and a .env file in the
 * working directory, which the environment overrides).
 *
 * The defaults match infra/compose.yaml and `pnpm parsing`, so a developer machine needs no
 * configuration.
 */

import { existsSync, readFileSync } from "node:fs";
import { parseEnv } from "node:util";

export interface Settings {
  readonly databaseUrl: string;
  readonly valkeyUrl: string;
  readonly spicedbEndpoint: string;
  readonly spicedbKey: string;
  readonly spicedbInsecure: boolean;
  readonly blobDir: string;
  /** YAML file with model providers, routes and budgets. */
  readonly gatewayConfig: string | undefined;
  readonly streamPrefix: string;
  /** The parsing worker (engine/parsing) that reads Word, PowerPoint, Excel and PDF files. */
  readonly parsingUrl: string;
}

const DEFAULTS: Settings = {
  databaseUrl: "postgresql://inspiration:inspiration@localhost:5432/inspiration",
  valkeyUrl: "redis://localhost:6379/0",
  spicedbEndpoint: "localhost:50051",
  spicedbKey: "inspiration-dev-key",
  spicedbInsecure: true,
  blobDir: ".data/blobs",
  gatewayConfig: undefined,
  streamPrefix: "insp",
  parsingUrl: "http://127.0.0.1:8790",
};

function envName(key: string): string {
  return `INSPIRATION_${key.replace(/[A-Z]/g, (c) => `_${c}`).toUpperCase()}`;
}

function parseBool(name: string, value: string): boolean {
  if (/^(1|true|yes|on)$/i.test(value)) return true;
  if (/^(0|false|no|off)$/i.test(value)) return false;
  throw new RangeError(`${name} must be true or false, not ${JSON.stringify(value)}`);
}

/** Settings from the given environment, falling back to the defaults. */
export function loadSettings(env: Readonly<Record<string, string | undefined>> = process.env): Settings {
  const out: Record<string, unknown> = { ...DEFAULTS };
  for (const [key, fallback] of Object.entries(DEFAULTS)) {
    const name = envName(key);
    const value = env[name];
    if (value === undefined || value === "") continue;
    out[key] = typeof fallback === "boolean" ? parseBool(name, value) : value;
  }
  return out as unknown as Settings;
}

let cached: Settings | undefined;

/** The process's settings: the environment over .env over the defaults. Read once. */
export function getSettings(): Settings {
  if (cached === undefined) {
    const file = existsSync(".env") ? parseEnv(readFileSync(".env", "utf8")) : {};
    cached = loadSettings({ ...file, ...process.env });
  }
  return cached;
}
