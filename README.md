# Inspiration

Inspiration turns a company's scattered documents, approval flows and conversations into a
living knowledge base. It extracts claims with exact evidence, keeps them fresh as sources
change, compiles them into cited pages, SOPs and interactive views, and serves them to
people and to agents with the reader's own permissions.

This repository holds the backend. The UI comes later and talks to the same APIs.

## Status

Foundations are built and tested. The remaining modules are specified in
[`modules.yaml`](modules.yaml) and can be built in parallel against the contracts.

| Part | Package | State |
| --- | --- | --- |
| Contracts (JSON Schema, generated Python and TypeScript) | `contracts/` | built |
| Kernel: settings, plugins, migrations, blob store | `platform/kernel` | built |
| Event bus: outbox, relay, Valkey Streams, in-memory bus | `platform/eventbus` | built |
| M10 knowledge store, pgvector and pg_search indexes | `modules/m10-store` | built |
| M13 permissions on SpiceDB | `modules/m13-authz` | built |
| M14 model gateway and agent runtime | `modules/m14-gateway` | built |
| M1 to M9, M11, M12, M15 to M17 | | planned |

## Quick start

You need [uv](https://docs.astral.sh/uv/), Docker with Compose, and Node 20 or later.

```bash
make sync          # Python and TypeScript dependencies
make up            # ParadeDB (Postgres 16 + pgvector + pg_search), Valkey, SpiceDB
make migrate       # SQL migrations of every installed package
make authz-schema  # the SpiceDB schema
make check         # lint, mypy, contract freshness, all tests
```

Without make, the same steps are `uv sync`, `docker compose -f infra/compose.yaml up -d --wait`,
`uv run inspiration-migrate`, `uv run inspiration-authz-schema` and
`INSPIRATION_REQUIRE_STACK=1 uv run pytest -q`.

Integration tests (marked `integration`) skip when the stack is not running, unless
`INSPIRATION_REQUIRE_STACK=1` is set, as it is in CI. Each one gets its own database copied
from a migrated template and its own Valkey key prefix.

To try the model gateway without a model server, run it with the fake providers:

```bash
uv run inspiration-gateway --config config/gateway.dev.yaml
curl -s localhost:8100/healthz
```

## Layout

```
contracts/          schema/*.yaml is the source of truth; codegen/ writes python/ and typescript/
platform/kernel     settings, plugin registry, migrations runner, blob stores
platform/eventbus   transactional outbox, relay to Valkey Streams, consumers, in-memory bus
modules/mNN-name    one package per module (see modules.yaml)
infra/              docker compose for the prototype stack
config/             example configuration
docs/               architecture, contracts, PageSpec and views, licensing
tests/              repo-wide checks (module manifest against the event catalogue)
```

## Documentation

- [Architecture](docs/architecture.md): planes, modules, how they talk, storage, security.
- [Contracts](docs/contracts.md): changing schemas, code generation, IDs, events, versioning.
- [PageSpec and views](docs/pagespec.md): how pages match Claude Artifacts, and the view sandbox.
- [Licensing](docs/licensing.md): licences of the stack and what they mean for delivery.
- [AGENTS.md](AGENTS.md): rules for anyone, human or agent, building a module.
