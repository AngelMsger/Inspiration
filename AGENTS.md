# Building in this repository

These rules let several people and agents build components at the same time without
stepping on each other. Read them before you change anything.

## Before you start

Read [the overview](docs/overview.md), [decisions in force](docs/decisions.md) and the
[MVP](docs/design/mvp.md) before picking work. Use the [README roadmap](README.md#roadmap)
and the code for implementation status; dated agent notes and merged-PR lists are history.
The current local validation path is in [docs/local.md](docs/local.md). The paid benchmark
tuning line remains paused; local product validation does not reopen it.

1. Find your component in `components.yaml`. It says what the component owns, which events
   it publishes and consumes, which synchronous APIs it may call, and which plugin groups it
   provides. Set its `status` to `in_progress` and its `owner` to your branch.
2. Read the contracts your component touches in `libs/contracts/schema/` and the
   interfaces in `libs/contracts/src/interfaces.ts`.
3. Run `make install`, `make up` and `make check` once, so you start from green.

For a UI review or a new interaction, also read the product model and design judgment in
[UI philosophy](docs/design/ui-philosophy.md). Explain the user, concrete situation,
expected path and understanding before choosing controls. Keep source material, modeled
statements and current conclusions distinct; making a feature reachable alone is not a
design rationale. Reconcile durable decisions into that canonical document and its Chinese
copy rather than adding a competing set of principles.

## Shape of a component

Engine components live in `engine/<name>`, the shared libraries in `libs/<name>`, composition
roots in `apps/<name>` and business-layer packages in `business/<name>`.

```
engine/<name>/
  package.json          "@inspiration/<name>"; plugin declarations under "inspiration.plugins"
  src/index.ts          the public API; its doc comment describes the component's behaviour
  src/migrations.ts     only if the component owns tables, with migrations/NNNN_<what>.sql
  languages/<tag>.yaml  only if it reads or writes words of a language: en.yaml, ja.yaml, zh.yaml
  test/*.test.ts        Vitest tests; shared fixtures in test/fixtures.ts
  test/data/            test data in languages other than English, read with testData
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
  in `engine/<name>/migrations/` and registered as a `migrations` plugin (a
  `MigrationSet`). The `kb` schema belongs to the knowledge store, `bus` to the event bus,
  `gateway` to the model gateway and `agents` to the agent runtime.
- Plugins are declared in `package.json` as
  `"inspiration": {"plugins": {"<group>": {"<name>": "./src/<file>.ts#<Export>"}}}`, in a
  group from `GROUPS` in `libs/kernel/src/plugins.ts`. Never import another component's
  plugin directly; ask `registry(group).get(name)`.
- Delivery is at least once. Handlers must be idempotent; use `firstDelivery` (bus.inbox)
  when a side effect cannot be repeated.
- Composition roots live in `apps/<name>` and are listed under `apps` in `components.yaml`.
  An app wires components to the store, the bus and the blob store and may depend on any of
  them; no package depends on an app. The one exception is a harness that measures an app:
  `apps/bench` runs the engine process over corpora, and the business backend in front of it
  for the gate checks, and lists both under `uses`. Benchmarks, reports, checks against
  hand-written answers and the gate checks go there, not in `apps/engine` or `apps/business`.
- The engine has no accounts, sign-in or UI concerns. Every API takes the tenant and the
  principal it acts for; people, tenants and policy are provisioned by the business layer
  (see `docs/architecture.md`).
- The engine and the business layer share this repository, each in its own folder
  (`engine/`, `business/`, with `libs/` and `apps/`; see "One repository, a folder per layer"
  in `docs/architecture.md`). Nothing in the engine or the libraries depends on a business
  package (`test/manifest.test.ts`). A business package reaches the engine only through the
  contracts and the engine's API client, never by importing an engine component.

## Contracts

- `libs/contracts/schema/*.yaml` is the source of truth. Never edit
  `dist/inspiration.schema.json`, `src/generated.ts`, `src/business.ts` or `src/events.ts`; run
  `pnpm contracts` after changing a schema.
- Additive changes (a new optional field, a new type) are fine in your branch; say so in the
  PR. Anything that removes, renames or tightens a field, or changes an event payload, needs
  agreement first: raise it before you build on it. See `docs/contracts.md`.
- Every new type used across components gets an example in `libs/contracts/examples/`;
  the tests validate it against the JSON Schema.
- Validate anything that comes from outside the process (HTTP bodies, plugin output, model
  output) with `parseAs` or `contractErrors`.

## Models and prompts

- Call models only through the model gateway. Name tasks `<component>.<verb_object>`
  (`extraction.extract_claims`) and budget keys `tenant:<id>/<component>`; the names drive
  routing, budgets, metering and evals.
- Never put a key, token or password in the repository, including in tests, logs and recorded
  replies: name the environment variable that holds it (`api_key_env`). CI's `secrets` job
  (Gitleaks, `.github/gitleaks.toml`) fails on any that reaches a commit.
- Pass the content's sensitivity label on every call. The gateway refuses to send content
  to a provider that is not cleared for it.
- Until real models are configured, a component that owns a model task ships a
  deterministic stand-in for it: a `model_mocks` plugin named after the task. The fake
  providers in `config/gateway.dev.yaml` (`options.mocks: true`) answer with it, so the
  pipeline runs end to end; numbers from a mock measure the pipeline, not model quality.
- Prompts are versioned YAML files (`PromptRegistry.loadDir`). Change the version whenever
  the text changes; the version is part of every artifact's inputs hash.
- Before a paid validation step, run the exact command for free, inspect its catalogue,
  permissions and search results, reuse saved replies, and forecast new spend against the
  budget for that task. Keep a reusable run log and export the replies. Historical run caps
  are not a new budget; see [the paid-run checklist](docs/development.md#before-a-paid-validation-run).
- Built-in agents run on the agent runtime (`Runtime`) with an `AgentSpec` named
  `<component>.<agent>`. Their tools only read or propose; nothing an agent does changes
  knowledge without a person approving it.

## Knowledge rules (enforced by the knowledge store)

- A claim without supporting evidence or a derivation is rejected.
- An evidence quote must be a verbatim substring of its span.
- Claims are never deleted; `supersede` closes their "known when" interval.
- Page versions are immutable and increase by one.

## Tests

- Tests use Vitest and live in `engine/<name>/test/` (repo-wide checks in `test/`).
- Unit tests use the in-memory doubles: `MemoryStore` and `Sample` (from
  `@inspiration/knowledge-store/testing`) for data, `MemoryGraph` with `AuthzService` for
  permissions, `InMemoryBus` for events, and the `fake` model provider
  (`config/gateway.dev.yaml`).
- Code that has a Postgres, Valkey or SpiceDB implementation gets the same tests against
  both the double and the real service: `describe.each` over the backends, with the real
  one skipped by `describe.skipIf(!hasStack())` (see
  `engine/knowledge-store/test/fixtures.ts`). `stackTest` from `@inspiration/testkit`
  gives a test its own migrated database (`databaseUrl`) and Valkey key prefix
  (`streamPrefix`, `valkey`).
- `INSPIRATION_QUICK=1` (set by `make check`) leaves out the corpus runs that take minutes
  (`quick` from `@inspiration/testkit`); CI and `make check-full` run them. Give a new test
  that takes more than about 20 seconds the same skip under `quick()`.
- `INSPIRATION_REQUIRE_STACK=1` (set by `make check` and CI) turns a missing stack into a
  failure instead of skips; `INSPIRATION_STACK=off` skips the stack probe entirely.

## Definition of done

- `make check` passes: Biome, `tsc` strict, contract freshness, the tests with the stack up,
  the long corpus runs aside. A change to what the engine reads, governs or answers also
  passes `make check-full`, as CI does.
- `components.yaml` is updated (status, plugins, events, calls), and `test/manifest.test.ts`
  passes.
- Public behaviour is described in the doc comment of `src/index.ts` or in `docs/`.
- Whatever the change replaces or leaves unused is gone or marked (see below).
- The change keeps to "Keeping the code simple" below.
- The change lands through a pull request.

## Keeping the code simple

Code here is read again and again by people and agents who did not write it, so it stays as
small and as plain as its job allows. Rules marked *checked* fail `make check` (Biome and
`test/structure.test.ts`); the rest are on every pull request.

**Build what is decided, not what might be needed.**

- A new component, library, app, plugin group, contract type, event, setting or third-party
  package serves a requirement already in force: the overview, a design doc with
  `Status: adopted`, or an issue labelled `planned`. Its pull request names it. Nothing is
  added for later.
- An abstraction needs two users now. An interface or a plugin group needs two
  implementations (a test double counts as one); an option needs a caller that sets it to
  something other than its default. Until then, write a function or a constant.
- A pull request does one thing. When it changes more than about 600 lines of hand-written
  source, tests, data and generated files aside, its description says why it cannot be split.

**Reuse before adding.**

- Look in the libraries and in the component itself before writing a helper. Code moves into
  a library only when a second package needs it, and into one of the four that exist.
- One third-party package per job: one YAML parser, one HTTP framework, one Postgres client,
  one Valkey client. A new package says in its pull request why Node's standard library or a
  package already in the workspace will not do, and what its licence is.

**Small pieces** (*checked*).

- A TypeScript file has one job and at most 800 lines, generated files aside. Split it by job
  before it would pass the limit. The files over it today have a ceiling each in
  `test/structure.test.ts`; they are split when their component next gains a feature, and a
  ceiling is only ever lowered.
- A function's cognitive complexity is at most 40 (Biome's `noExcessiveCognitiveComplexity`).
  The files that hold a function above it today have a ceiling in `biome.json`; a change
  there splits the function instead of adding to it.

**A structure anyone can predict** (*checked*, except the last rule).

- A package's `src/` has at most one level of folders, each named for the kind of thing it
  holds (`parsers/`, `providers/`, `feishu/`, `cli/`).
- No file or folder is named `utils`, `helpers`, `misc`, `common` or `shared`: a name says
  what the code does.
- Other packages reach a package only by its name, which is its `src/index.ts`; tests may
  also use a `testing` entry. Each package's `exports` enforces this.
- A new top-level folder, library, app, component or plugin group changes the structure
  everyone works in. The product owner agrees to it before it is built, as with a breaking
  contract change, and the same pull request gives it its line in `components.yaml` or in
  the README's layout.

**Say what is built.**

- `components.yaml` gives each component's whole design, so its events and calls include
  planned ones. A built component's `owns` therefore ends with what is still planned
  ("Planned are ..."), so nobody takes a declared event or call for a working one.
- Code that only measures (a baseline, a rival, a report) lives in `apps/bench`. Where it
  needs a component's internals, as the retrieval baselines do, the component's doc comment
  and `components.yaml` say it is there to measure, and it goes when the measurement ends.

## Keeping the repo small

The repo is read by people and agents who were not in the discussion, so what is in it must
be current. `test/docs.test.ts` checks the mechanical part; the rest is on every pull request.

- **One home for each kind of file.** Engine components in `engine/`, libraries in `libs/`,
  business packages in `business/`, the engine process in `apps/engine`, benchmarks, reports
  and checks against answers in `apps/bench`, each corpus in `examples/<name>` with a README
  and a row in `examples/README.md`, docs in `docs/` with a Chinese copy and a row in
  `docs/README.md`. A new top-level folder or root file gets a line in the README's layout.
- **Replace, don't pile up.** The pull request that replaces a doc, a screen, a corpus or
  code deletes the old one; git history keeps it. When its history still matters to readers,
  mark it instead: its status line says `Status: superseded by <link>`, and so does its row in
  the docs index. Code a change leaves unused is deleted in that change.
- **Status lines stay true.** A design doc opens with `Status: adopted`, `proposed` or
  `superseded`, in one sentence that also says what is built, and then its conclusions; its
  history goes in "About this page" at the end. When the product owner decides, or a pull
  request it cites as open is merged, the next change to that doc updates the line, in both
  languages.
- **Conclusions first.** Documents state the conclusion, then any decision needed from the
  product owner, before the supporting detail. Update the existing canonical document when
  reconciling agent memory; do not create a competing decision list. Keep temporary session
  limits, artifact IDs and one-off approvals out of standing rules.
- **Link, don't copy.** Material from outside is copied only into `examples/`, with its
  source and date, so runs repeat without the network. Elsewhere, link to the source.
- **Merged branches are deleted.**

Once a week, and after each large stack of pull requests lands, a hygiene pass looks for
what these rules miss: merged branches, status lines that lag, superseded material still
unmarked, files over 500 KB, folders the README's layout does not list, source files close
to their line limit, exports nothing imports and packages nothing uses. It fixes the
mechanical part in one small pull request and lists the rest for the product owner.

## Languages

The product serves English, Chinese and Japanese users, and more languages later.

- Code, comments, prompts and configuration are in English. `test/languages.test.ts`
  rejects Han and kana anywhere else than in the places below.
- The words, punctuation and patterns a component needs to read or write a language are
  data: a language pack per BCP 47 tag in `languages/` (`loadLanguages` and `languageOf` in
  the kernel). Supporting a language means adding packs, not code. Every component's packs
  cover en, ja and zh. Documents have no language tag yet, so reading uses all packs at once
  and packs must not collide; writing follows the document's tag, else `languageOf`.
- Tests are in English where the language does not matter. Where it does, the cases live in
  `test/data/<tag>.yaml` (`testData` from `@inspiration/testkit`), and a test runs over each
  language with `describe.each`. Sample data in `examples/` may be in any language, and so
  may the screens copied from the design canvas into `docs/design/screens/` and the images
  and diagram sources in `docs/assets/`.
- Docs are written in English and every doc in `docs/` has a Chinese copy at the same path in
  `docs/zh/` (a README beside its data as `README.zh.md`). Change both in the same pull
  request.
- Product roles and wording follow the [three-language glossary](docs/overview.md#appendix-a-glossary-in-three-languages).
  Always name an owner's scope (space, topic, page or procedure); knowledge is shared across
  languages, not copied into separate language-specific knowledge bases.

## Style

- TypeScript that Node 22 runs directly by stripping types: import local files with their
  `.ts` extension, use only erasable syntax (no `enum`, `namespace` or parameter
  properties), and `import type` for types. ESM, `strict`, `noUncheckedIndexedAccess`.
- Contract data stays `snake_case`, as in the schema; TypeScript identifiers are
  `camelCase`. Biome formats with a line width of 120.
- Errors are `Error` subclasses with a `name`; unknown names and IDs raise `RangeError`.
- Comments explain why, not what. Match the density and idiom of the surrounding code.
- Write user-facing text in plain English (see Languages).
