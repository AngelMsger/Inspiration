# Inspiration

Inspiration turns a company's scattered documents, approval flows and conversations into a
living knowledge base. It extracts claims with exact evidence, keeps them fresh as sources
change, compiles them into cited pages, SOPs and interactive views, and serves them to
people and to agents with the reader's own permissions.

This repository holds the whole product as one monorepo. The engine (ingestion, the knowledge
pipeline, storage, permissions, model access and the agent API) is built; the business layer
(identity, tenants and accounts, publishing policy) comes next, in its own folder, and uses
the engine only through its APIs and events. The web app has its first screens, for a demo. Checks keep each layer and each
component inside its boundaries (see [Architecture](docs/architecture.md)).

## Status

The engine's foundations and its knowledge pipeline are built and tested; the business layer
is not started. The web app shows the reading screens of the design canvas over the engine's
HTTP API, with a stand-in for sign-in, for demos. [`components.yaml`](components.yaml) lists every component
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

To see the product, run the demo. It reads the demo tenant with the development models, so it
costs nothing, then serves the web app at http://127.0.0.1:5173 (the account menu switches
the person you act as and the interface language). As 陈晨, ask how much a night in Shenzhen
may cost: the answer gives the hotel price list's 650 and says the travel policy still says
600. As 李娜, confirm 650 in the inbox, and the FAQ's and minutes' 600 reads as outdated. As
周敏, the finance space owner, put in edition 7 of the travel policy: within a second its
tier-1 row says 650:

```bash
pnpm demo                                    # the engine on port 4100, the web app on 5173
pnpm engine serve examples/corpus            # the engine's HTTP API alone
pnpm snapshot dist/snapshot                  # record the demo script as a static page
```

The demo script (`examples/corpus/script.yaml`) lists those steps, each with the person who
takes it. `pnpm snapshot` walks it against the engine and writes a static page that answers
from the recording, with a guide along the bottom that opens each step as its person, so anyone
can follow the demo from a link, without the engine. A question the script does not ask, or a
step it does not take, says it was not recorded. The page holds everything each person of the
demo tenant could read, for whoever opens it: acting as someone there is a simulation, not
access control. So record only the synthetic demo corpus, or a corpus whose whole contents
everyone who gets the link may read.

To try the model gateway without a model server, run it with the fake providers:

```bash
make gateway
curl -s localhost:8100/healthz
```

## Layout

```
libs/contracts      schema/*.yaml is the source of truth, schema/business/ the business layer's own; codegen/ writes the TypeScript
libs/kernel         settings, logging, plugin registry, migrations runner, blob stores, database pools
libs/eventbus       transactional outbox, relay to Valkey Streams, consumers, in-memory bus
libs/testkit        fixtures for tests against the compose stack
engine/<component>  one package per engine component (see components.yaml)
business/<name>     one package per business-layer component: tenancy so far; engine/ and libs/ never depend on them
apps/engine         the engine process: wires the components to the store, the bus and the blob store; HTTP API
apps/web            the product web app over the engine's HTTP API, a stand-in backend (pnpm demo) and snapshots (pnpm snapshot)
apps/bench          the measurement harness (pnpm bench): runs the engine over a corpus, reports, checks answers
apps/site           the product website (pnpm site): static pages in three languages with a scripted demo
examples/<corpus>   corpora with the answers runs are checked against (see examples/README.md)
infra/              docker compose for the prototype stack, and a local embedding server for runs
config/             example configuration of the model gateway
docs/               overview, engine reference and design docs, indexed in docs/README.md
docs/zh/            Chinese copies of every doc
test/               repo-wide checks: the component manifest, languages, docs, file paths
```

Business components live in `business/`, next to `engine/` and `libs/` (see
[Architecture](docs/architecture.md#one-repository-a-folder-per-layer)), and are listed in the
`business` section of `components.yaml`.

## Documentation

Start with the [overview](docs/overview.md) ([中文](docs/zh/overview.md)): the product
requirements and technical architecture in one document, with scenarios, diagrams, a
feasibility check, and what is built and what is planned. [docs/README.md](docs/README.md)
lists every doc with its status: adopted, proposed or superseded.

[AGENTS.md](AGENTS.md) holds the rules for anyone, human or agent, building a component, and
for keeping the repo small. A Chinese copy of this README is in [README.zh.md](README.zh.md).
