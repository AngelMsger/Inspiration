# Inspiration

Inspiration turns a company's scattered documents, approval flows and conversations into a
living knowledge base. It extracts claims with exact evidence, keeps them fresh as sources
change, compiles them into cited pages, SOPs and interactive views, and serves them to
people and to agents with the reader's own permissions.

This repository holds the engine: ingestion, the knowledge pipeline, storage, permissions,
model access and the agent API. The business layer (identity, tenants and accounts,
publishing policy) and the UI are built separately and use the engine's APIs and events.

## Status

The foundations are built and tested. The remaining components are specified in
[`components.yaml`](components.yaml) and can be built in parallel against the contracts.

| Part | Package | State |
| --- | --- | --- |
| Contracts: JSON Schema, generated types, validators, event catalogue, interfaces | `packages/contracts` | built |
| Kernel: settings, logging, plugins, migrations, blob store, database pools | `packages/kernel` | built |
| Event bus: outbox, relay, Valkey Streams consumers, in-memory bus | `packages/eventbus` | built |
| Test kit: per-test databases and Valkey prefixes on the compose stack | `packages/testkit` | built |
| Knowledge store, pgvector and pg_search indexes | `packages/knowledge-store` | built |
| Access control on SpiceDB | `packages/access-control` | built |
| Model gateway, as a library and an HTTP service | `packages/model-gateway` | built |
| Agent runtime for built-in agents | `packages/agent-runtime` | built |
| Connectors: local folders, Feishu documents and approvals (recorded fixtures) | `packages/connectors` | built |
| Source sync: versions, tombstones, ACL snapshots, principal mapping | `packages/source-sync` | built |
| Normalization: parsers, source blocks and spans with stable IDs, block diff, duplicates | `packages/normalization` | built |
| Extraction: claims with verbatim evidence, predicate catalogue and slots, supersede on edits (mocked model) | `packages/extraction` | built |
| Engine process and CLI: ingest runs, reports, synthetic corpora | `apps/engine` | built |
| Governance: fact slots and their values, conflict cases with a proposed value, one todo request per conflicting slot, rechecks when a dated change takes effect | `packages/governance` | built |
| Freshness: review clocks per document, plan days, copies an edit left behind, staleness scores, review.due | `packages/freshness` | built |
| Page compiler: topics and the knowledge outline, every statement's placement (pages not yet) | `packages/page-compiler` | built |
| Collaboration: the inbox, todos on owners' weekly cards, notes, campaigns and stewards (comments not yet) | `packages/collaboration` | built |
| parsing, retrieval, agent-api, research, views, credential-broker, sandbox | | planned |

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

To run the ingest pipeline (sync, normalization, extraction) over the demo corpus ([`examples/corpus`](examples/corpus/README.md),
a fictional company with planted duplicates and conflicts) and print what it produced:

```bash
pnpm engine ingest examples/corpus            # in memory
pnpm engine ingest examples/corpus --stack    # Postgres and Valkey from INSPIRATION_* settings
pnpm engine synthesize /tmp/synth --documents 2000 && pnpm engine ingest /tmp/synth --stack
```

To try the model gateway without a model server, run it with the fake providers:

```bash
make gateway
curl -s localhost:8100/healthz
```

## Layout

```
packages/contracts        schema/*.yaml is the source of truth; codegen/ writes src/generated.ts and src/events.ts
packages/kernel           settings, logging, plugin registry, migrations runner, blob stores, database pools
packages/eventbus         transactional outbox, relay to Valkey Streams, consumers, in-memory bus
packages/testkit          fixtures for tests against the compose stack
packages/<component>      one package per component (see components.yaml)
apps/engine               the engine process: wires components to the store and the bus; ingest CLI
examples/corpus           a demo tenant (Chinese enterprise documents, folder ACLs, Feishu fixtures)
infra/                    docker compose for the prototype stack
config/                   example configuration
docs/                     architecture, contracts, PageSpec and views, licensing
test/                     repo-wide checks (the component manifest)
```

## Documentation

- [Architecture](docs/architecture.md): engine and business layer, components, how they
  talk, storage, security.
- [Contracts](docs/contracts.md): changing schemas, code generation, IDs, events,
  versioning.
- [PageSpec and views](docs/pagespec.md): how pages match Claude Artifacts, and the view
  sandbox.
- [Licensing](docs/licensing.md): licences of the stack and what they mean for delivery.
- [AGENTS.md](AGENTS.md): rules for anyone, human or agent, building a component.
