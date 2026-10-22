# Building in this repository

These rules let several people and agents build modules at the same time without
stepping on each other. Read them before you change anything.

## Before you start

1. Find your module in `modules.yaml`. It says what the module owns, which events it
   publishes and consumes, which synchronous APIs it may call, and which plugin groups it
   provides. Set its `status` to `in_progress` in your branch.
2. Read the contracts your module touches in `contracts/schema/` and the protocols in
   `contracts/python/src/inspiration/contracts/interfaces.py`.
3. Run `make up` and `make check` once, so you start from green.

## Boundaries

- A module talks to the rest of the system only through:
  - **events**, published inside a store transaction (`tx.publish(...)`) so they commit with
    the data, and consumed with a consumer group named after the module (`"m5"`);
  - **the M10 repository API** (`KnowledgeStore`), never another module's tables;
  - **AuthZ** (M13) for every read on behalf of a person or an agent;
  - **ModelGateway** (M14) for every model call, embedding, rerank and OCR;
  - **Retriever** (M11) and the **blob store**.
- If a module owns tables, they live in their own Postgres schema, created by SQL files in
  `src/inspiration/<name>/migrations/` and registered as a `MigrationSet` entry point. The
  `kb` schema belongs to M10, `bus` to the event bus, `gateway` to M14.
- Plugins register through entry points in the group `inspiration.<group>` (see
  `inspiration.kernel.plugins.GROUPS`). Never import another module's plugin directly.
- Delivery is at least once. Handlers must be idempotent; use `first_delivery` (bus.inbox)
  when a side effect cannot be repeated.

## Contracts

- `contracts/schema/*.yaml` is the source of truth. Never edit `models.py`, `events.py`,
  `generated.ts` or `events.ts`; run `make contracts` after changing a schema.
- Additive changes (a new optional field, a new type) are fine in your branch; say so in the
  PR. Anything that removes, renames or tightens a field, or changes an event payload, needs
  agreement first: raise it before you build on it. See `docs/contracts.md`.
- Every new type used across modules gets an example in `contracts/examples/`; the tests
  validate it against both the JSON Schema and the pydantic model.

## Models and prompts

- Call models only through M14. Name tasks `mN.verb_object` (`m5.extract_claims`); the name
  drives routing, budgets, metering and evals.
- Pass the content's sensitivity label on every call. The gateway refuses to send content
  to a provider that is not cleared for it.
- Prompts are versioned files (`PromptRegistry.load_dir`). Change the version whenever the
  text changes; the version is part of every artifact's inputs hash.
- Built-in agents run on `inspiration.gateway.Runtime` with an `AgentSpec`. Their tools only
  read or propose; nothing an agent does changes knowledge without a person approving it.

## Knowledge rules (enforced by M10)

- A claim without supporting evidence or a derivation is rejected.
- An evidence quote must be a verbatim substring of its span.
- Claims are never deleted; `supersede` closes their "known when" interval.
- Page versions are immutable and increase by one.

## Tests

- Unit tests use the in-memory doubles: `MemoryStore` and `inspiration.store.testing.Sample`
  for data, `MemoryGraph` with `AuthzService` for permissions, `InMemoryBus` for events,
  and the `fake` model provider (`config/gateway.dev.yaml`).
- Code that has a Postgres, Valkey or SpiceDB implementation gets the same tests against
  both the double and the real service (see `modules/m10-store/tests/conftest.py`). Mark
  the real one `integration`.
- Tests run with `--import-mode=importlib`, so test modules cannot import each other. Share
  fixtures through your module's `tests/conftest.py` and test data through
  `inspiration.store.testing`.

## Definition of done

- `make check` passes: ruff, mypy strict, contract freshness, all tests with the stack up.
- `modules.yaml` is updated (status, package, events, calls), and `tests/test_manifest.py`
  passes.
- Public behaviour is described in the package docstring or `docs/`.

## Style

- Python 3.12, `from __future__ import annotations`, full type hints, line length 120.
- Comments explain why, not what. Match the density and idiom of the surrounding code.
- Write user-facing text in plain English; Chinese test data is welcome and expected.
