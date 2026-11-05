// The engine process's models when a gateway file configures them (serve --gateway). Every
// gateway here meters into one usage ledger and holds the budgets of --gateway, so a limit
// such as the trial's month over every company holds for the sample company as well, whose
// calls --corpus-gateway sends to other models. A month or a total outlives any one run of the
// server, so a config with such a budget keeps the ledger in Postgres (--usage) and the server
// will not start without it; there a restarted server, or a second one, reads what was spent.
// Each gateway holds its own calls in flight, so calls that start together on both can pass a
// limit by one call each, as calls in two processes can (gateway.ts).

import type { ModelGateway } from "@inspiration/contracts";
import { applyMigrations, type MigrationSet, openPool, registry } from "@inspiration/kernel";
import {
  Gateway,
  type GatewayConfig,
  loadGatewayConfig,
  MemoryUsage,
  PostgresUsage,
  type UsageSink,
  ValkeyCache,
} from "@inspiration/model-gateway";

export interface ModelFiles {
  /** The gateway file every tenant's calls take, and whose budgets hold for all of them. */
  gateway: string;
  /** Another gateway file for one tenant's calls, with that tenant. */
  corpus?: { gateway: string; tenantId: string };
  /** Where the reply caches are kept, for configs that keep them in Valkey. */
  valkeyUrl?: string;
  /** The Postgres database that keeps the usage ledger. */
  usageUrl?: string;
}

export interface Models {
  models: ModelGateway;
  /** The main gateway: the one ledger every call is metered in, and the budgets that hold. */
  ledger: Gateway;
  close(): Promise<void>;
}

/** The models the files configure, on one usage ledger. */
export async function openModels(files: ModelFiles): Promise<Models> {
  const config = loadGatewayConfig(files.gateway);
  const lasting = config.budgets.find((b) => b.period === "month" || b.period === "total");
  if (lasting && !files.usageUrl) {
    throw new RangeError(
      `${files.gateway} has a budget over a ${lasting.period}, longer than a run of the server: give --usage <postgres url>`,
    );
  }
  const corpus = files.corpus && loadGatewayConfig(files.corpus.gateway);
  if (corpus && corpus.currency !== config.currency) {
    throw new RangeError(
      `${files.corpus?.gateway} prices in ${corpus.currency}, ${files.gateway} in ${config.currency}`,
    );
  }
  const closers: (() => Promise<unknown>)[] = [];
  const close = async () => {
    for (const c of closers.reverse()) await c();
  };
  try {
    const usage = files.usageUrl ? await usageIn(files.usageUrl, closers) : new MemoryUsage();
    const main = await gatewayOf(files.gateway, config, usage, files.valkeyUrl, closers);
    if (!corpus || !files.corpus) return { models: main, ledger: main, close };
    // The corpus's tenant takes its own models, within the budgets every tenant has.
    const own = await gatewayOf(
      files.corpus.gateway,
      { ...corpus, budgets: config.budgets },
      usage,
      files.valkeyUrl,
      closers,
    );
    return { models: byTenant(files.corpus.tenantId, own, main), ledger: main, close };
  } catch (error) {
    await close();
    throw error;
  }
}

/** One tenant's calls on its own models, every other tenant's on the rest, by the calls' budget keys. */
export function byTenant(tenantId: string, own: ModelGateway, rest: ModelGateway): ModelGateway {
  const pick = (req: { budget_key: string }) => (req.budget_key.startsWith(`tenant:${tenantId}/`) ? own : rest);
  return {
    complete: (req) => pick(req).complete(req),
    embed: (req) => pick(req).embed(req),
    rerank: (req) => pick(req).rerank(req),
    ocr: (req) => pick(req).ocr(req),
  };
}

/** The ledger in Postgres, its schema migrated. */
async function usageIn(url: string, closers: (() => Promise<unknown>)[]): Promise<UsageSink> {
  await applyMigrations(url, [await registry("migrations").get<MigrationSet>("gateway")]);
  const pool = await openPool(url);
  closers.push(() => pool.end());
  return new PostgresUsage(pool);
}

async function gatewayOf(
  file: string,
  config: GatewayConfig,
  usage: UsageSink,
  valkeyUrl: string | undefined,
  closers: (() => Promise<unknown>)[],
): Promise<Gateway> {
  let cache: ValkeyCache | undefined;
  if (config.cache.backend === "valkey") {
    if (!valkeyUrl) throw new RangeError(`${file} keeps its response cache in Valkey: give --valkey`);
    const valkey = ValkeyCache.fromUrl(valkeyUrl);
    closers.push(() => valkey.close());
    cache = valkey;
  }
  const gateway = await Gateway.create(config, { usage, ...(cache && { cache }) });
  closers.push(() => gateway.close());
  return gateway;
}
