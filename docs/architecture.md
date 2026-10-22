# Architecture

Inspiration is a set of modules around one knowledge store. Each module owns one job,
talks to the others through a small number of well-defined paths, and can be built and
tested on its own. `modules.yaml` is the authoritative list; this page explains how the
pieces fit.

## Planes and modules

| Plane | Modules | Job |
| --- | --- | --- |
| Ingest | M1 connectors, M2 sync, M3 parsers, M4 normalizer | Fetch sources with their ACLs, parse them into blocks and spans, chunk and embed |
| Compile | M5 extractor, M6 freshness, M7 governance, M8 pages | Claims with evidence, staleness and dirty propagation, conflicts, cited pages and diagrams |
| Store | M10 knowledge store | The only owner of knowledge tables, lineage, bitemporal reads, page snapshots, search indexes |
| Serve | M11 retrieval, M12 agent gateway, M16 web, M17 views | Hybrid search and grounded answers, MCP and REST for agents, the reader UI, sandboxed interactive views |
| Control | M9 collaboration, M13 authz, M14 model gateway, M15 research | Comments and proposals, permissions, every model call, deep research |

## How modules talk

There are exactly three paths.

1. **Events.** A module writes data and its events in one Postgres transaction
   (`tx.publish` writes `bus.outbox`). The relay moves outbox rows to Valkey Streams, one
   stream per event type. Each consuming module reads with its own consumer group, so
   every module sees every event once (at least once on failure). Unparseable events,
   events of a newer version than the consumer knows, and events that keep failing go to a
   dead-letter stream per group.
2. **The repository API of M10.** Reads and writes of knowledge go through
   `KnowledgeStore`. No module reads another module's tables.
3. **Synchronous calls** to M13 (`AuthZ`), M14 (`ModelGateway`), M11 (`Retriever`) and the
   blob store. Each has an in-process implementation and, where useful, an HTTP one with
   the same protocol (M14 has both today).

The main flow, from a changed document to a fresh page:

```
source.changed -> M2 fetch -> document.fetched (+ acl.changed -> M13 mirror)
  -> M3 parse, M4 chunk and embed -> chunks.updated
  -> M5 extract -> claims.updated -> M6 freshness -> artifact.dirty
  -> M8 rebuild page -> page.rendered -> M11 reindex, M9 notify, M17 refresh views
```

## Storage

One Postgres instance (ParadeDB image: Postgres 16 with pgvector and pg_search) holds:

| Schema | Owner | Contents |
| --- | --- | --- |
| `kb` | M10 | source versions, spans, chunks (BM25 index), embeddings (HNSW), claims, evidence, derivations, dependencies, page snapshots, ACL snapshots |
| `bus` | event bus | outbox and inbox |
| `gateway` | M14 | usage records (budgets are sums over them), agent run traces |
| `public.inspiration_migrations` | kernel | migration ledger with checksums |

SpiceDB keeps its own datastore in a separate `spicedb` database on the same instance.
Valkey carries the event streams and the model response cache. Binary files go to the
blob store (local directory in the prototype, object storage later).

Every `kb` table keeps the full contract object in a `doc` column and copies only the
fields queries filter on into typed columns, so a contract change rarely needs a
migration.

Search runs inside Postgres in the prototype: BM25 through pg_search with the jieba
tokenizer (search mode, whitespace trimmed, traditional folded to simplified), vectors
through pgvector. Both sit behind the `VectorIndex` and `KeywordIndex` plugin protocols,
so a deployment can move to Milvus or OpenSearch without touching retrieval.

## Security model

- **Source ACLs are kept, not reinvented.** M13 mirrors each document's ACL from its
  source into SpiceDB. Unmapped and external principals get nothing. "Anyone with the
  link" and public sharing are kept as separate relations so the oversharing scan can find
  them.
- **Derived knowledge follows its sources.** A claim, page or SOP is readable only through
  source documents the viewer can read now. M13 decides this at read time by walking
  lineage, so it can never drift from the source ACLs. Hidden support is never counted or
  named. Document checks for one request go to SpiceDB in bulk and are memoised; M11 keeps
  each indexed derived unit's supporting documents so its pre-filter still applies.
- **Search pre-filters.** `scope_filter` gives each index the viewer's spaces, principal
  tokens and clearance, so top-k is taken only over rows the viewer may see. Results are
  re-checked before they leave the server.
- **Sensitivity routing.** Every model call carries the highest sensitivity label of its
  content. Each model provider has a maximum label; confidential and secret content only
  ever reaches models inside the customer network.
- **Agents act for a person.** An agent principal must carry `on_behalf_of`. Its rights are
  the person's rights cut down to its scopes (read-only by default) and spaces. Built-in
  agent tools only read or propose.

## Deployment shapes

The prototype runs every module in one process or a few, against the compose stack. The
protocols are the seams for splitting later: the model gateway already runs as its own
HTTP service (`inspiration-gateway`) with a client that raises the same errors, and the
event bus lets consumers run anywhere that reaches Valkey.
