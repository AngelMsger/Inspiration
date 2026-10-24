# Architecture

Inspiration is a set of components around one knowledge store. Each component owns one
job, talks to the others through a small number of well-defined paths, and can be built
and tested on its own. [`components.yaml`](../components.yaml) is the authoritative list;
this page explains how the pieces fit.

## Engine and business layer

This repository is the **engine**: connectors, the knowledge pipeline, storage,
permissions, model access and the agent API. It knows tenants, spaces and principals by ID
and enforces every permission itself, but it has no accounts, sign-in, invitations or
billing.

The **business layer** (a separate system) owns people and tenants: the external identity
provider, accounts that are members of many tenants, personal tenants, publishing policy and
admin governance. It provisions the engine (members, groups, spaces, policy) through engine
commands and reacts to engine events. Calls go down, events come up: the engine never calls
the business layer.

There are three IDs: the tenant (`ten_`), the business layer's user, which is the account
(`usr_`), and the member (`mem_`), which is one user inside one tenant. User IDs never reach
the engine; its only person ID is the member ID. A member ID is unique only within its
tenant (the business layer may give a person the same member ID in every tenant they join),
and nothing derives one ID from another or reads meaning into an ID's body. So everything
the engine keeps outside a tenant's own rows keys principals by tenant: the permission graph
(`<ten_…>|<mem_…>`, likewise for services, groups and departments), index principal
tokens, and agent runs.

Engine APIs are tenant- and membership-aware and free of UI concerns, so the web app, the
business layer and agents all use the same surface.

## Layers and components

| Layer | Components | Job |
| --- | --- | --- |
| Ingest | connectors, source-sync, parsing, normalization, research | Fetch sources with their ACLs, parse them, and store canonical blocks and spans with stable IDs |
| Compile | extraction, freshness, governance, page-compiler | Claims with evidence, staleness and dirty propagation, conflicts, cited pages and diagrams |
| Store | knowledge-store | The only owner of knowledge tables: lineage, bitemporal reads, page snapshots, search indexes |
| Serve | retrieval, agent-api, web, views | Hybrid search and grounded answers, MCP and REST for agents, the reader UI, sandboxed interactive views |
| Control | collaboration, access-control, model-gateway, agent-runtime | Comments and proposals, permissions, every model call, the loop built-in agents run on |

Shared libraries sit under all of them: **contracts** (types, validators, the event
catalogue, component interfaces), **kernel** (settings, logging, plugins, migrations, blob
store, database pools), **eventbus** (outbox, relay, consumers) and **testkit** (fixtures
for the compose stack).

Everything is TypeScript on Node 22 except **parsing**, a Python worker for the heavy
document parsers (Office, PDF, scans), which normalization calls over an HTTP contract.

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
3. **Synchronous calls** to the interfaces in `packages/contracts/src/interfaces.ts`:
   `AuthZ` (access-control), `ModelGateway` (model-gateway), `Retriever` (retrieval),
   `AgentRuntime` (agent-runtime) and the blob store. Each has an in-process
   implementation and, where useful, an HTTP one with the same interface (the model
   gateway has both today). `components.yaml` lists which calls each component may make,
   and the manifest test checks that a package depends on nothing else.

The main flow, from a changed document to a fresh page:

```
source.changed -> source-sync fetch -> document.fetched (+ acl.changed -> access-control mirror)
  -> normalization parses (the parsing worker for Office and PDF) and diffs blocks -> blocks.changed
  -> extraction -> claims.updated -> freshness -> artifact.dirty
                                   -> governance compares slot values -> todo.requested -> collaboration
  freshness: review clocks, plan days, copies left behind -> review.due -> collaboration, research
  the engine's daily tick: freshness publishes due reviews, governance rechecks dated changes
  -> page-compiler rebuilds the page -> page.rendered
  -> retrieval reindexes, collaboration notifies, views refresh
```

## Storage

One Postgres instance (ParadeDB image: Postgres 16 with pgvector and pg_search) holds:

| Schema | Owner | Contents |
| --- | --- | --- |
| `kb` | knowledge-store | source versions, source blocks, spans, chunks (BM25 index), embeddings (HNSW), claims, evidence, derivations, dependencies, page snapshots, ACL snapshots |
| `bus` | eventbus | outbox and inbox |
| `gateway` | model-gateway | usage records (budgets are sums over them) |
| `agents` | agent-runtime | agent run traces |
| `sync` | source-sync | registered sources; per item, the connector's version hashes and the source version they became |
| `normalization` | normalization | per document, the version last stored as blocks (the diff base), its parser and fingerprint; the SimHash band index for duplicates |
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

- **Source ACLs are kept, not reinvented.** Access control mirrors each document's ACL
  from its source into SpiceDB. Unmapped and external principals get nothing. "Anyone with
  the link" and public sharing are kept as separate relations so the oversharing scan can
  find them.
- **Derived knowledge follows its sources.** A claim, page or SOP is readable only through
  source documents the viewer can read now. Access control decides this at read time by
  walking lineage along support paths (supporting evidence, derivations, dependencies), so it
  can never drift from the source ACLs; evidence that contradicts or qualifies a claim never
  makes it readable. Hidden support is never
  counted or named. Document checks for one request go to SpiceDB in bulk and are memoised;
  retrieval keeps each indexed derived unit's supporting documents so its pre-filter still
  applies.
- **Search pre-filters.** `scopeFilter` gives each index the viewer's spaces, principal
  tokens and clearance, so top-k is taken only over rows the viewer may see. Results are
  re-checked before they leave the server.
- **Fresh reads after writes.** Every permission write returns SpiceDB's consistency token
  (a ZedToken). Decisions carry it as `consistency_token`, so a caller can ask a later
  read to be at least that fresh.
- **Sensitivity routing.** Every model call carries the highest sensitivity label of its
  content. Each model provider has a maximum label; confidential and secret content only
  ever reaches models inside the customer network.
- **Agents act for a member.** An agent principal must carry `on_behalf_of`, a member of
  its tenant. Its rights are the member's rights cut down to its scopes (read-only by
  default) and spaces. Built-in
  agent tools only read or propose; nothing an agent does changes knowledge without a
  person approving it.

## Deployment shapes

The prototype runs every component in one process or a few, against the compose stack. The
interfaces are the seams for splitting later: the model gateway already runs as its own
HTTP service (`inspiration-gateway`) with a client that raises the same errors, and the
event bus lets consumers run anywhere that reaches Valkey.
