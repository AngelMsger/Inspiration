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

The foundations are built and tested. The remaining components are specified in
[`components.yaml`](components.yaml) and can be built in parallel against the contracts.

| Part | Package | State |
| --- | --- | --- |
| Contracts: JSON Schema, generated types, validators, event catalogue, interfaces | `libs/contracts` | built |
| Kernel: settings, logging, plugins, migrations, blob store, database pools | `libs/kernel` | built |
| Event bus: outbox, relay, Valkey Streams consumers, in-memory bus | `libs/eventbus` | built |
| Test kit: per-test databases and Valkey prefixes on the compose stack | `libs/testkit` | built |
| Knowledge store, pgvector and pg_search indexes | `engine/knowledge-store` | built |
| Access control on SpiceDB | `engine/access-control` | built |
| Model gateway, as a library and an HTTP service | `engine/model-gateway` | built |
| Agent runtime for built-in agents | `engine/agent-runtime` | built |
| Connectors: local folders, Feishu documents and approvals (recorded fixtures) | `engine/connectors` | built |
| Source sync: versions, tombstones, ACL snapshots, principal mapping | `engine/source-sync` | built |
| Normalization: parsers, source blocks and spans with stable IDs, block diff, duplicates | `engine/normalization` | built |
| Extraction: claims with verbatim evidence, predicate catalogue and slots, supersede on edits, keep facts a version stops stating (mocked model) | `engine/extraction` | built |
| Engine process: wires the components to the store, the bus and the blob store | `apps/engine` | built |
| Measurement harness and CLI: ingest runs, reports, checks against answers, synthetic corpora | `apps/bench` | built |
| Governance: fact slots and their values counted by independent source (copies and translations once), conflict cases with a proposed value, one todo request per conflicting slot, rechecks when a dated change takes effect | `engine/governance` | built |
| Freshness: review clocks per document, plan days, copies an edit left behind, staleness scores, review.due | `engine/freshness` | built |
| Page compiler: topics and the knowledge outline, every statement's placement (pages not yet) | `engine/page-compiler` | built |
| Collaboration: the inbox, todos on owners' weekly cards, notes, campaigns and stewards (comments not yet) | `engine/collaboration` | built |
| Retrieval: chunks with contextual headers, hybrid search and rerank over statements and passages, permission filters, answers that give the value governance holds, with notes (mocked model; page indexes not yet) | `engine/retrieval` | built |
| parsing, agent-api, research, views, credential-broker, sandbox | | planned |

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
pnpm bench ingest examples/corpus            # in memory
pnpm bench ingest examples/corpus --stack    # Postgres and Valkey from INSPIRATION_* settings
pnpm bench synthesize /tmp/synth --documents 2000 && pnpm bench ingest /tmp/synth --stack
pnpm bench ingest examples/control           # the control corpus, checked case by case
pnpm bench replay examples/gitlab-expenses   # a real policy through 21 versions of its history
pnpm bench ingest examples/kubernetes-docs   # real pages in English, Chinese and Japanese
pnpm bench ask examples/kubernetes-docs "Kubernetes 集群最多可以有多少个节点？"
```

[`examples/control`](examples/control/README.md) is a small corpus in which every case has one
right answer: a correct rule against a copied wrong value, two deadlines in one passage, and
reposts against independent sources. Its run reports, for each case, the slot each statement
lands in, each value's independent sources, the proposed value and what becomes of the others.

[`examples/gitlab-expenses`](examples/gitlab-expenses/README.md) is real knowledge that
changes: GitLab's public expense policy at 21 versions from 2020 to 2026. The replay ingests
each version on the day it was published and checks what governance would tell a reader about
14 facts against a timeline read by hand.

[`examples/kubernetes-docs`](examples/kubernetes-docs/README.md) is real knowledge in three
languages: five pages of the Kubernetes documentation with their official Chinese and Japanese
translations, checked like the control corpus. A page and its translations should give each
fact one value and one source, and the original holds over a translation that says otherwise.
Its 12 questions in the three languages check the answers, and `ask` answers any other one.

To try the model gateway without a model server, run it with the fake providers:

```bash
make gateway
curl -s localhost:8100/healthz
```

## Layout

```
libs/contracts            schema/*.yaml is the source of truth; codegen/ writes src/generated.ts and src/events.ts
libs/kernel               settings, logging, plugin registry, migrations runner, blob stores, database pools
libs/eventbus             transactional outbox, relay to Valkey Streams, consumers, in-memory bus
libs/testkit              fixtures for tests against the compose stack
engine/<component>        one package per engine component (see components.yaml)
business/                 business-layer packages (none yet); engine/ and libs/ never depend on them
apps/engine               the engine process: wires components to the store and the bus
apps/bench                the measurement harness and its CLI: ingest runs, reports, replay, checks against answers
examples/corpus           a demo tenant (Chinese enterprise documents, folder ACLs, Feishu fixtures)
examples/control          a control corpus with one right answer per case, and the engine's known gaps
examples/gitlab-expenses  a real policy's edit history, replayed version by version against a timeline
examples/kubernetes-docs  real pages in English with their Chinese and Japanese translations, checked like the control corpus
infra/                    docker compose for the prototype stack
config/                   example configuration
docs/                     overview, design, architecture, contracts, PageSpec and views, licensing
docs/zh/                  Chinese copies of the overview and design docs
test/                     repo-wide checks (the component manifest)
```

Business components will live in `business/`, next to `engine/` and `libs/` (see
[Architecture](docs/architecture.md#one-repository-a-folder-per-layer)).

## Documentation

Start with the [overview](docs/overview.md) ([中文](docs/zh/overview.md)): the product
requirements and technical architecture in one document, with scenarios, diagrams, a
feasibility check, and what is built and what is planned.

- [UI principles](docs/design/ui-principles.md) and
  [Statements at scale](docs/design/statements-at-scale.md): the adopted UI and review design.
- [Business layer](docs/design/business-layer.md) and
  [Business layer and engine contract](docs/design/business-engine-contract.md): accounts,
  companies, publishing and approvals above the engine, and the contract between the two.
- [Source changes](docs/design/source-changes.md): what happens when a source corrects itself,
  is deleted or changes at scale, and when a person is asked.
- [Knowledge and language](docs/design/knowledge-and-language.md): knowledge is language-neutral;
  translations, cross-language merge and pages in another language.
- [Permissions in compiled knowledge](docs/design/compiled-knowledge-permissions.md): how pages,
  procedures and answers use material that part of their audience cannot read.
- [Code repositories as a knowledge source](docs/design/code-repositories.md) (proposed): a local
  mirror and open-source code graph of each connected repository as an input of Deep Research,
  organized by topic and code area and kept current at every merge; with a head-to-head against a
  coding agent over a clone ([examples/code-questions](examples/code-questions/answers.md)).
- [Architecture](docs/architecture.md): engine and business layer, components, how they
  talk, storage, security.
- [Contracts](docs/contracts.md): changing schemas, code generation, IDs, events,
  versioning.
- [PageSpec and views](docs/pagespec.md): how pages match Claude Artifacts, and the view
  sandbox.
- [Licensing](docs/licensing.md): licences of the stack and what they mean for delivery.
- [AGENTS.md](AGENTS.md): rules for anyone, human or agent, building a component.
