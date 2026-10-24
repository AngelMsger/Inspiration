# Building in this repository

These rules let several people and agents build components at the same time without
stepping on each other. Read them before you change anything.

## Before you start

1. Find your component in `components.yaml`. It says what the component owns, which events
   it publishes and consumes, which synchronous APIs it may call, and which plugin groups it
   provides. Set its `status` to `in_progress` and its `owner` to your branch.
2. Read the contracts your component touches in `packages/contracts/schema/` and the
   interfaces in `packages/contracts/src/interfaces.ts`.
3. Run `make install`, `make up` and `make check` once, so you start from green.

## Shape of a component

```
packages/<name>/
  package.json        "@inspiration/<name>"; plugin declarations under "inspiration.plugins"
  src/index.ts        the public API; its doc comment describes the component's behaviour
  src/migrations.ts   only if the component owns tables, with migrations/NNNN_<what>.sql
  test/*.test.ts      Vitest tests; shared fixtures in test/fixtures.ts
```

The name is kebab case and says what the component does. It is also the component's event
producer name, its consumer group and the first part of its model task names.

## Boundaries

- A component talks to the rest of the system only through:
  - **events**, published inside a store transaction (`tx.publish(...)`) so they commit with
    the data, and consumed with a consumer group named after the component
    (`"extraction"`);
  - **the knowledge store's repository API** (`KnowledgeStore`), never another component's
    tables;
  - **AuthZ** (access-control) for every read on behalf of a person or an agent;
  - **ModelGateway** (model-gateway) for every model call, embedding, rerank and OCR;
  - **Retriever** (retrieval), **AgentRuntime** (agent-runtime) and the **blob store**.
- A package depends only on the libraries (contracts, kernel, eventbus, testkit for tests)
  and on the components listed in its `calls`. `test/manifest.test.ts` enforces this. Take
  another component as its interface from contracts where there is one, so tests can pass a
  double.
- If a component owns tables, they live in their own Postgres schema, created by SQL files
  in `packages/<name>/migrations/` and registered as a `migrations` plugin (a
  `MigrationSet`). The `kb` schema belongs to the knowledge store, `bus` to the event bus,
  `gateway` to the model gateway and `agents` to the agent runtime.
- Plugins are declared in `package.json` as
  `"inspiration": {"plugins": {"<group>": {"<name>": "./src/<file>.ts#<Export>"}}}`, in a
  group from `GROUPS` in `packages/kernel/src/plugins.ts`. Never import another component's
  plugin directly; ask `registry(group).get(name)`.
- Delivery is at least once. Handlers must be idempotent; use `firstDelivery` (bus.inbox)
  when a side effect cannot be repeated.
- Composition roots live in `apps/<name>` and are listed under `apps` in `components.yaml`.
  An app wires components to the store, the bus and the blob store and may depend on any of
  them; no package depends on an app.
- The engine has no accounts, sign-in or UI concerns. Every API takes the tenant and the
  principal it acts for; people, tenants and policy are provisioned by the business layer
  (see `docs/architecture.md`).

## Contracts

- `packages/contracts/schema/*.yaml` is the source of truth. Never edit
  `dist/inspiration.schema.json`, `src/generated.ts` or `src/events.ts`; run
  `pnpm contracts` after changing a schema.
- Additive changes (a new optional field, a new type) are fine in your branch; say so in the
  PR. Anything that removes, renames or tightens a field, or changes an event payload, needs
  agreement first: raise it before you build on it. See `docs/contracts.md`.
- Every new type used across components gets an example in `packages/contracts/examples/`;
  the tests validate it against the JSON Schema.
- Validate anything that comes from outside the process (HTTP bodies, plugin output, model
  output) with `parseAs` or `contractErrors`.

## Models and prompts

- Call models only through the model gateway. Name tasks `<component>.<verb_object>`
  (`extraction.extract_claims`) and budget keys `tenant:<id>/<component>`; the names drive
  routing, budgets, metering and evals.
- Pass the content's sensitivity label on every call. The gateway refuses to send content
  to a provider that is not cleared for it.
- Until real models are configured, a component that owns a model task ships a
  deterministic stand-in for it: a `model_mocks` plugin named after the task. The fake
  providers in `config/gateway.dev.yaml` (`options.mocks: true`) answer with it, so the
  pipeline runs end to end; numbers from a mock measure the pipeline, not model quality.
- Prompts are versioned YAML files (`PromptRegistry.loadDir`). Change the version whenever
  the text changes; the version is part of every artifact's inputs hash.
- Built-in agents run on the agent runtime (`Runtime`) with an `AgentSpec` named
  `<component>.<agent>`. Their tools only read or propose; nothing an agent does changes
  knowledge without a person approving it.

## Knowledge rules (enforced by the knowledge store)

- A claim without supporting evidence or a derivation is rejected.
- An evidence quote must be a verbatim substring of its span.
- Claims are never deleted; `supersede` closes their "known when" interval.
- Page versions are immutable and increase by one.

## Tests

- Tests use Vitest and live in `packages/<name>/test/` (repo-wide checks in `test/`).
- Unit tests use the in-memory doubles: `MemoryStore` and `Sample` (from
  `@inspiration/knowledge-store/testing`) for data, `MemoryGraph` with `AuthzService` for
  permissions, `InMemoryBus` for events, and the `fake` model provider
  (`config/gateway.dev.yaml`).
- Code that has a Postgres, Valkey or SpiceDB implementation gets the same tests against
  both the double and the real service: `describe.each` over the backends, with the real
  one skipped by `describe.skipIf(!hasStack())` (see
  `packages/knowledge-store/test/fixtures.ts`). `stackTest` from `@inspiration/testkit`
  gives a test its own migrated database (`databaseUrl`) and Valkey key prefix
  (`streamPrefix`, `valkey`).
- `INSPIRATION_REQUIRE_STACK=1` (set by `make check` and CI) turns a missing stack into a
  failure instead of skips; `INSPIRATION_STACK=off` skips the stack probe entirely.

## Definition of done

- `make check` passes: Biome, `tsc` strict, contract freshness, all tests with the stack up.
- `components.yaml` is updated (status, plugins, events, calls), and `test/manifest.test.ts`
  passes.
- Public behaviour is described in the doc comment of `src/index.ts` or in `docs/`.
- The change lands through a pull request.

## Style

- TypeScript that Node 22 runs directly by stripping types: import local files with their
  `.ts` extension, use only erasable syntax (no `enum`, `namespace` or parameter
  properties), and `import type` for types. ESM, `strict`, `noUncheckedIndexedAccess`.
- Contract data stays `snake_case`, as in the schema; TypeScript identifiers are
  `camelCase`. Biome formats with a line width of 120.
- Errors are `Error` subclasses with a `name`; unknown names and IDs raise `RangeError`.
- Comments explain why, not what. Match the density and idiom of the surrounding code.
- Write user-facing text in plain English; Chinese test data is welcome and expected.
