# Inspiration

Inspiration turns a company's scattered documents, approval flows and conversations into a
living knowledge base. It extracts claims with exact evidence, keeps them fresh as sources
change, compiles them into cited pages, SOPs and interactive views, and serves them to
people and to agents with the reader's own permissions.

This repository holds the whole product as one monorepo. The engine (ingestion, the knowledge
pipeline, storage, permissions, model access and the agent API) is built; the business layer
(identity, tenants and accounts, publishing policy) and the web app come next, in their own
folder, and use the engine only through its APIs and events. Checks keep each layer and each
component inside its boundaries (see [Architecture](docs/architecture.md)).

## Status

The engine's foundations and its knowledge pipeline are built and tested; the business layer
and the web app are not started. [`components.yaml`](components.yaml) lists every component
with its status (built, in progress or planned), and each package's `src/index.ts` says what
it does. The [overview](docs/overview.md) says what is built, what comes next and what is
still open.

Everything is TypeScript on Node 22 except the parsing worker, which is Python because the
best document parsers are.

## Quick start

You need Node 22.18 or later, pnpm 10 (`corepack enable`), and Docker with Compose.

```bash
make install       # pnpm dependencies
make up            # ParadeDB (Postgres 16 + pgvector + pg_search), Valkey, SpiceDB
make migrate       # SQL migrations of every installed component
make authz-schema  # the SpiceDB schema
make check         # Biome, tsc, contract freshness, all tests with the stack required
```

Without make, the same steps are `pnpm install`, `docker compose -f infra/compose.yaml up -d --wait`,
`pnpm exec inspiration-migrate`, `pnpm exec inspiration-authz-schema` and
`INSPIRATION_REQUIRE_STACK=1 pnpm test`.

Tests that need the stack skip when it is not running, unless `INSPIRATION_REQUIRE_STACK=1`
is set, as it is in CI. Each one gets its own database copied from a migrated template and
its own Valkey key prefix. `make test-unit` runs only the tests that need nothing.

To run the engine over a corpus and print what it produced, use the measurement harness:

```bash
pnpm bench ingest examples/corpus            # the demo tenant, in memory
pnpm bench ingest examples/corpus --stack    # on Postgres and Valkey from INSPIRATION_* settings
pnpm bench synthesize /tmp/synth --documents 2000 && pnpm bench ingest /tmp/synth --stack
pnpm bench replay examples/gitlab-expenses   # a real policy through 21 versions of its history
pnpm bench ask examples/kubernetes-docs "How many nodes can a Kubernetes cluster have at most?"
```

[`examples/README.md`](examples/README.md) lists every corpus, what it measures, how to run
it and which test holds it to its answers.

To try the model gateway without a model server, run it with the fake providers:

```bash
make gateway
curl -s localhost:8100/healthz
```

## Layout

```
libs/contracts      schema/*.yaml is the source of truth; codegen/ writes src/generated.ts and src/events.ts
libs/kernel         settings, logging, plugin registry, migrations runner, blob stores, database pools
libs/eventbus       transactional outbox, relay to Valkey Streams, consumers, in-memory bus
libs/testkit        fixtures for tests against the compose stack
engine/<component>  one package per engine component (see components.yaml)
business/           business-layer packages (none yet); engine/ and libs/ never depend on them
apps/engine         the engine process: wires the components to the store, the bus and the blob store
apps/bench          the measurement harness (pnpm bench): runs the engine over a corpus, reports, checks answers
apps/site           the product website (pnpm site): static pages in three languages with a scripted demo
examples/<corpus>   corpora with the answers runs are checked against (see examples/README.md)
infra/              docker compose for the prototype stack, and a local embedding server for runs
config/             example configuration of the model gateway
docs/               overview, engine reference and design docs, indexed in docs/README.md
docs/zh/            Chinese copies of every doc
test/               repo-wide checks: the component manifest, languages, docs, file paths
```

Business components will live in `business/`, next to `engine/` and `libs/` (see
[Architecture](docs/architecture.md#one-repository-a-folder-per-layer)).

## Documentation

Start with the [overview](docs/overview.md) ([中文](docs/zh/overview.md)): the product
requirements and technical architecture in one document, with scenarios, diagrams, a
feasibility check, and what is built and what is planned. [docs/README.md](docs/README.md)
lists every doc with its status: adopted, proposed or superseded.

[AGENTS.md](AGENTS.md) holds the rules for anyone, human or agent, building a component, and
for keeping the repo small. A Chinese copy of this README is in [README.zh.md](README.zh.md).
