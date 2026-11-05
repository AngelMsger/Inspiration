# Architecture

Inspiration is a set of components around one knowledge store. Each component owns one
job, talks to the others through a small number of well-defined paths, and can be built
and tested on its own. [`components.yaml`](../components.yaml) is the authoritative list;
this page explains how the pieces fit. A Chinese copy is in
[zh/architecture.md](zh/architecture.md); if the two differ, this English version wins.

## Engine and business layer

The **engine** owns connectors, the knowledge pipeline, storage, permissions, model access
and the agent API. It knows tenants, spaces and principals by ID and enforces every
permission itself, but it has no accounts, sign-in, invitations or billing.

The **business layer** owns people and tenants: the external identity provider, accounts
that are members of many tenants, personal tenants, publishing policy and admin governance. It provisions the engine (members, groups, spaces, policy) through engine
commands and reacts to engine events. Calls go down, events come up: the engine never calls
the business layer. The design philosophy of the two layers, the test for where something
goes, what neither may do, and how shared concerns are split are in the overview's
[Architecture at a glance](overview.md#9-architecture-at-a-glance) section.

There are three IDs: the tenant (`ten_`), the business layer's user, which is the account
(`usr_`), and the member (`mem_`), which is one user inside one tenant. User IDs never reach
the engine; its only person ID is the member ID. A member ID is unique only within its
tenant (the business layer may give a person the same member ID in every tenant they join),
and nothing derives one ID from another or reads meaning into an ID's body. So everything
the engine keeps outside a tenant's own rows keys principals by tenant: the permission graph
(`<ten_…>|<mem_…>`, likewise for services, groups and departments), index principal
tokens, and agent runs.

Engine APIs are tenant- and membership-aware and free of UI concerns, so the business layer,
its web app and agents all use the same surface.

The web app reads the engine through its HTTP API, version 0 (`apps/engine/src/http.ts`): the
spaces a member may read, a space's Documents tree, one document with the marks of its
Annotated view, search and answers, a space's knowledge outline and each topic with the values
that hold for its facts, the member's inbox with the choices each todo offers, and for a space's
owner (or a tenant admin) an overview of the space: its open work, the facts its readers see
in dispute, its documents by governance level and the latest changes. The knowledge writes
so far are resolving a todo and, for a space's owner, syncing a source now; both answer once
the engine has read everything they caused. The business layer's tenancy service provisions
tenants and members into the engine's copy of its directory (access control's `Directory`),
and spaces are administered through the same API: the super admin creates a space and names
its owners, its owners rename it and set who reads it, and the super admin may take readers
out but not add them. `GET /v0/me` tells the web app whether the member is the super admin,
and `GET /v0/spaces?manage=true` lists the spaces they administer. A member is let in only
while the directory has them and their tenant active. Every read is checked against the
member's permissions, and anything the member may not read answers as if it did not exist. A request carries a
principal token, a JWT the business layer signs with Ed25519 (`signJwt` in the kernel, which
both layers use) and access control verifies against the business layer's published keys
(`TokenVerifier`); its scopes bound what the request may do. For development, `--dev-identity`
also lets a request name its tenant and member in the `x-inspiration-tenant` and
`x-inspiration-member` headers, a stand-in that listens on localhost only. The
web app's own backend is a stand-in too (`apps/web/src/backend.ts`): a person picks whom to act
as, and only the backend sets those headers. `pnpm demo` runs both over the demo tenant, and
`pnpm snapshot` records the demo script through both into a static page that answers from the
recording (`apps/web/src/replay.ts`).

## One repository, a folder per layer

Both layers are built in this repository, as one pnpm workspace, and each has its own folder:

```
libs/<name>       shared libraries both layers use: contracts, kernel, eventbus, testkit
engine/<name>     engine components, one package each
business/<name>   business-layer components, one package each
apps/<name>       composition roots: the engine process, its measurement harness and the
                  web app today; the business backend later
```

Package names stay `@inspiration/<name>`.

One repository makes boundaries a matter of checks rather than of repository walls:

- **Dependencies point one way.** Nothing in `engine/` or `libs/` depends on `business/`.
  A business component reaches the engine only through the contracts (types, interfaces and
  the engine's API client), never by importing an engine component, so the engine still runs
  on its own and either side can be tested against a fake of the other.
- **Within a layer, only what is declared.** A package depends on the libraries and on the
  components in its `calls`, as today. The business layer has its own levels: business
  components, the backend that wires them and serves the web app, and the web app, which talks
  only to that backend.
- **Apps wire, packages don't.** An app may wire components of both layers, for example a
  single-process development server, and no package depends on an app. The one exception is
  the measurement harness (`apps/bench`), which runs the engine process it measures.
- **One manifest and one check.** Each section of [`components.yaml`](../components.yaml)
  maps to one folder: `components` to `engine/`, `libraries` to `libs/`, `business` to
  `business/` and `apps` to `apps/`. An
  engine component's `layer` field keeps naming its stage (ingest, compile, store, serve,
  control). `test/manifest.test.ts` fails a package that sits outside its section's folder,
  and anything in `engine/` or `libs/` that depends on `business/`.
- **One schema tree.** Business-only types live in their own folder of the contracts
  (`libs/contracts/schema/business/`), generated into an entry of their own
  (`@inspiration/contracts/business`) that nothing in `engine/` or `libs/` imports.
- **One toolchain, separate deployments.** One lockfile, one Biome, `tsc` and Vitest setup,
  and one `make check`, so a contract change lands with both sides in one pull request. The
  engine's APIs stay versioned all the same, because outside agents use them too. The engine and
  the business backend still deploy as separate processes: the monorepo is about source, not
  runtime. When separate teams own the layers, `CODEOWNERS` follows the folders and CI can run
  only the packages a change affects.

## Layers and components

| Layer | Components | Job |
| --- | --- | --- |
| Ingest | connectors, source-sync, parsing, normalization, research | Fetch sources with their ACLs, parse them, and store canonical blocks and spans with stable IDs |
| Compile | extraction, freshness, governance, page-compiler | Claims with evidence, staleness and dirty propagation, conflicts, cited pages and diagrams |
| Store | knowledge-store | The only owner of knowledge tables: lineage, bitemporal reads, page snapshots, search indexes |
| Serve | retrieval, agent-api, views | Hybrid search and grounded answers, MCP and REST for agents, sandboxed interactive views |
| Control | collaboration, access-control, model-gateway, agent-runtime, credential-broker, sandbox | The inbox, comments and proposals, permissions, every model call, the loop built-in agents run on, source connections and their credentials, isolated jobs for code we did not write (vendor CLIs and MCP servers) and render checks |

Shared libraries sit under all of them: **contracts** (types, validators, the event
catalogue, component interfaces), **kernel** (settings, logging, plugins, migrations, blob
store, database pools, language packs), **eventbus** (outbox, relay, consumers) and
**testkit** (fixtures for the compose stack, test data).

Everything is TypeScript on Node 22 except **parsing**, a Python worker for the heavy
document parsers (Office, PDF, scans), which normalization calls over an HTTP contract.

The engine reads and writes English, Chinese and Japanese. What a component knows about a
language (cue words, punctuation, how dates and numbering are written, the words its model
stand-ins write) is data: a language pack per tag in its `languages/` directory, so a new
language takes new packs, not new code. Until documents carry a language tag, a component
reads every text with all its packs and writes in the language the text looks to be in.

## How components talk

There are exactly three paths.

1. **Events.** A component writes data and its events in one Postgres transaction
   (`tx.publish` writes `bus.outbox`). The relay moves outbox rows to Valkey Streams, one
   stream per event type. Each consuming component reads with its own consumer group,
   named after the component, so every component sees every event once (at least once on
   failure). Unparseable events, events of a newer version than the consumer knows, and
   events that keep failing go to a dead-letter stream per group.
2. **The knowledge store's repository API.** Reads and writes of knowledge go through
   `KnowledgeStore`. No component reads another component's tables.
3. **Synchronous calls** to the interfaces in `libs/contracts/src/interfaces.ts`:
   `AuthZ` (access-control), `ModelGateway` (model-gateway), `Retriever` (retrieval),
   `AgentRuntime` (agent-runtime), the blob store, and `SlotVerdicts` (governance) and
   `StalenessReader` (freshness), which retrieval reads while it answers: the value that
   holds in a slot, and how stale a unit is. Each has an in-process implementation and,
   where useful, an HTTP one with the same interface (the model gateway has both today). `components.yaml` lists which calls each component may make,
   and the manifest test checks that a package depends on nothing else.

The main flow, from a changed document to a fresh page:

```
source.changed -> source-sync fetch -> document.fetched (+ acl.changed, an advisory ACL snapshot)
  -> normalization parses (the parsing worker for Office and PDF) and diffs blocks -> blocks.changed
  -> extraction -> claims.updated -> freshness -> artifact.dirty
                                   -> governance compares slot values -> todo.requested -> collaboration
  freshness: review clocks, plan days, copies left behind -> review.due -> collaboration, research
  the engine's daily tick: freshness publishes due reviews, governance rechecks dated changes
  -> page-compiler rebuilds the page -> page.rendered
  -> retrieval reindexes, collaboration notifies, views refresh
```

## Governance levels and fact slots

Not every document deserves an owner's attention. A source, or a folder or item within it,
has a governance level that source sync resolves onto every version (`SourceVersion
.governance_level`; uploads and web pages start as `reference`):

| Level | Extraction | Governance | Freshness |
| --- | --- | --- | --- |
| `governed` | in full | its values decide a slot; owners get todos | review clocks and copy reviews |
| `reference` | where a block names a catalogue fact, slot claims only; a passage in full once a page or an answer uses it | its values never outvote or hold up a governed one, except a change it dates that is in effect and later than the governed value (an announcement the page has not caught up with), which holds and asks the page's owner; a value only it states is a note | none |
| `search_only` | never | none | none |

Claims about one single-valued fact share a slot key (`Claim.slot_key`: subject entity when
resolved, predicate and sorted qualifiers). `KnowledgeStore.slot()` reads a slot as a
handful of rows however many statements it holds: the current values with their counts and
representatives, and the values it held over time.

## The knowledge outline

Every statement has two outlines. The source outline (document, heading path, passage) comes
from its evidence spans. The knowledge outline (space, area, topic, subtopic) comes from a
placement (`Placement`: claim, topic key, page block, placed_by, confirmed).

- Page-compiler clusters the sections of current governed documents into topics, per space.
  Topics are `TaxonomyNode`s, at most three levels deep, with keys that stay the same from
  one re-clustering to the next.
- A statement with a fact slot sits where most of its slot's statements are. That is also
  the only way a reference document's statements are placed.
- A governed statement without a topic is unfiled and shows under its source section.
- Clustering proposes topics, and an owner confirms them. Confirmed topics, and placements
  made or confirmed by a person or a page, never move. At most `budget` (5%) of the placed
  statements change topic in one re-clustering.
- `KnowledgeStore.topics()`, `placementsOf()` and `placementsIn()` read the outline.

## The inbox

Collaboration turns `todo.requested` and `review.due` into todos and puts them in front of
the people who own the topics, in amounts a person can keep up with.

- There is one open todo per dedupe key. A later request updates it, and a request marked
  withdrawn (its reason went away) dismisses it.
- A todo's topic comes from its claims' placements. Its assignee is the topic's owner, or
  the nearest owner above it. The business layer names owners, and the topic keeps them
  (`TaxonomyNode.owner_id`).
- An owner's todos about one topic in one ISO week share a card (`Todo.batch_key`) of at
  most 20. An owner gets at most 10 cards a week; the rest wait for the first later week
  with room, except high and urgent todos. The budget is a soft limit: a conflict and its
  copy reviews also stay together in their week, over the budget when they must.
- Notes, where reference documents state another value than the governed one, go on a
  weekly notes card outside the budget, and one action acknowledges them.
- A copy review rides on the card of the conflict its source update opened (on its next
  part when the card is full), in whichever order the two arrive, until that conflict
  closes. Reviews already due when a document is first seen go to a first-review campaign
  per topic. The todos of topics nobody owns go to the space's steward.
- A todo may offer resolutions, each with an effect its requester applies: a conflict offers
  one per value. Resolving a todo publishes `todo.resolved` with the choice, in the same
  transaction. Governance then holds the chosen value (`SlotVerdict.chosen_by`), marks every
  other value outdated, and keeps the choice until a new value comes in. A choice made on a
  conflict that has changed since it was asked is asked again.

## Storage

One Postgres instance (ParadeDB image: Postgres 16 with pgvector and pg_search) holds:

| Schema | Owner | Contents |
| --- | --- | --- |
| `kb` | knowledge-store | source versions, source blocks, spans, chunks (BM25 index), embeddings (HNSW), claims, evidence, derivations, dependencies, page snapshots, ACL snapshots |
| `bus` | eventbus | outbox and inbox |
| `gateway` | model-gateway | usage records (budgets are sums over them) |
| `agents` | agent-runtime | agent run traces |
| `authz` | access-control | the copy of the business layer's directory (tenants, members, with their versions); spaces with their owners and audiences; idempotency keys of space creation. SpiceDB holds the graph these grant |
| `sync` | source-sync | registered sources; per item, the connector's version hashes and the source version they became |
| `normalization` | normalization | per document, the version last stored as blocks (the diff base), its parser and fingerprint; the SimHash band index for duplicates |
| `extraction` | extraction | per document, the latest version extracted |
| `freshness` | freshness | per document, its review clock, claim classes and plan days; copies; reviews due by day; deleted documents |
| `governance` | governance | slot members and value groups, conflict cases, what each slot last asked and the notes it left, recheck days |
| `page_compiler` | page-compiler | sections with their embeddings and topics, the last clustering's topics and centroids, the topic of each fact slot, store writes an update has yet to finish |
| `collaboration` | collaboration | the inbox: every todo with its dedupe key, card, week and the week it fell due |
| `retrieval` | retrieval | per document, the version its chunks are of; documents that are editions of one text, as normalization reported them |
| `public.inspiration_migrations` | kernel | migration ledger with checksums |

SpiceDB keeps its own datastore in a separate `spicedb` database on the same instance.
Valkey carries the event streams and the model response cache. Binary files go to the
blob store (a local directory in the prototype, object storage later).

Every `kb` table keeps the full contract object in a `doc` column and copies only the
fields queries filter on into typed columns, so a contract change rarely needs a
migration.

Search runs inside Postgres in the prototype: BM25 through pg_search with the jieba
tokenizer (search mode, whitespace trimmed, traditional folded to simplified), vectors
through pgvector. Both sit behind the `VectorIndex` and `KeywordIndex` interfaces, so a
deployment can move to Milvus or OpenSearch without touching retrieval.

## Security model

Visibility comes from the space a unit is in, never from source permissions (the adopted
permission model; see `docs/design/business-engine-contract.md`). Still to come are the
member's own space, readable by that member alone, and the proof rule for inputs a unit needs
together: a claim is visible when its space is readable and one complete proof of it is.

- **Spaces decide who reads.** A source belongs to one space, and its documents are readable
  by whoever may read the space: its audience (members, groups, departments or the whole
  tenant) with a role from viewer to owner, each holding in every space below. The super
  admin manages every space (its name, owners and audience) but reads only the spaces whose
  audience includes them. Source ACLs decide nothing: source-sync keeps them as advisory
  snapshots, for the audience-gap warning when something is published.
- **Derived knowledge follows its sources.** A claim, page or SOP is readable only through
  source documents the viewer can read now. Access control decides this at read time by
  walking lineage along support paths (supporting evidence, derivations, dependencies), so it
  follows the spaces the viewer can read now; evidence that contradicts or qualifies a claim
  never makes it readable. Hidden support is never counted or named. Source checks for one
  request go to SpiceDB in bulk and are memoised.
- **Search pre-filters.** `scopeFilter` gives each index the viewer's readable spaces, their
  tenant's token and their clearance, so top-k is taken only over rows the viewer may see.
  Results are re-checked before they leave the server.
- **Fresh reads after writes.** Every permission write returns SpiceDB's consistency token
  (a ZedToken). Decisions carry it as `consistency_token`, so a caller can ask a later
  read to be at least that fresh.
- **Sensitivity routing.** Every model call carries the highest sensitivity label of its
  content. Each model provider has a maximum label; confidential and secret content only
  ever reaches models inside the customer network.
- **Agents act for a member.** An agent principal must carry `on_behalf_of`, a member of
  its tenant. Its rights are the member's rights cut down to its scopes (read-only by
  default) and spaces. Built-in agent tools only read or propose; nothing an agent does
  changes knowledge without a person approving it.

## Deployment shapes

The prototype runs every component in one process or a few, against the compose stack. The
interfaces are the seams for splitting later: the model gateway already runs as its own
HTTP service (`inspiration-gateway`) with a client that raises the same errors, and the
event bus lets consumers run anywhere that reaches Valkey.
