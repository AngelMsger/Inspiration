/**
 * Minimal structured logging: one JSON object per line on stderr, so a collector can parse
 * it. The level comes from INSPIRATION_LOG_LEVEL (debug, info, warn, error, off; default info).
 */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
export type LogLevel = keyof typeof LEVELS;

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

function threshold(): number {
  const level = process.env.INSPIRATION_LOG_LEVEL;
  if (level === "off") return Number.POSITIVE_INFINITY;
  return LEVELS[(level ?? "info") as LogLevel] ?? LEVELS.info;
}

function describe(value: unknown): unknown {
  if (!(value instanceof Error)) return value;
  return { name: value.name, message: value.message, stack: value.stack };
}

/** A logger whose lines carry the given name, for example logger("eventbus.relay"). */
export function logger(name: string): Logger {
  const write = (level: LogLevel, message: string, fields: Record<string, unknown> = {}) => {
    if (LEVELS[level] < threshold()) return;
    const extra = Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, describe(v)]));
    process.stderr.write(
      `${JSON.stringify({ time: new Date().toISOString(), level, logger: name, message, ...extra })}\n`,
    );
  };
  return {
    debug: (m, f) => write("debug", m, f),
    info: (m, f) => write("info", m, f),
    warn: (m, f) => write("warn", m, f),
    error: (m, f) => write("error", m, f),
  };
}
