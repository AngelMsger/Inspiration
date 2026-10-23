# Contracts

Every type that crosses a component boundary is defined once, in JSON Schema (draft
2020-12) written as YAML under `packages/contracts/schema/`. The TypeScript types, the
runtime validators and the event catalogue are generated from it. Data on the wire and in
the database is `snake_case`; TypeScript APIs are `camelCase`.

| File | Contents |
| --- | --- |
| `common.yaml` | IDs, instants, intervals, hashes, sensitivity labels, blob references, producer info, component names |
| `source.yaml` | sources, connector capabilities, versions, normalized documents, spans, chunks, approval flows |
| `knowledge.yaml` | claims and evidence, entities, relations, SOPs, knowledge models, research, freshness, lineage, conflicts |
| `page.yaml` | PageSpec and its 14 block types, data references, charts, diagrams, views and their message protocol, snapshots |
| `collab.yaml` | comments, anchors, proposals, overrides, todos, publishing |
| `authz.yaml` | principals, permissions, decisions, index filters, ACL snapshots, spaces, audit events |
| `gateway.yaml` | completion, embedding, rerank and OCR requests and results, usage, budgets, errors |
| `retrieval.yaml` | search and answer requests and results, citations, feedback |
| `events.yaml` | the event envelope and the payload of each event type (`x-events`) |
| `agents.yaml` | tool specs, agent specs, run context, steps and results |

Interfaces between components (`KnowledgeStore`, `AuthZ`, `ModelGateway`, `Retriever`,
`AgentRuntime`, the plugin interfaces) are hand-written TypeScript in
`packages/contracts/src/interfaces.ts`, over the generated types.

## Changing a contract

```bash
$EDITOR packages/contracts/schema/page.yaml
pnpm contracts           # bundle, then generate src/generated.ts and src/events.ts
pnpm contracts:check     # what CI runs: fails if anything generated is stale
pnpm vitest run packages/contracts   # examples validate against the schema
```

Never edit `dist/inspiration.schema.json`, `src/generated.ts` or `src/events.ts` by hand.

Rules:

- Type names are unique across all files; the bundler flattens them into one namespace
  (`packages/contracts/dist/inspiration.schema.json`, the file other languages read).
- Every enum and every object used in more than one place gets its own named definition,
  so generated code has readable names.
- Unions that cross the wire carry a tag (`type` for blocks and view messages, `kind` for
  data references); the bundler adds a `discriminator` for code generators.
- Put an example of every new cross-component type in
  `packages/contracts/examples/<Type>.<name>.json`; the tests validate it.
- Validate data from outside the process with `parseAs(typeName, value)` or
  `contractErrors(typeName, value)`. `newEvent` validates every event it builds.
- Offsets into text (`quote_start`, `char_start`) are UTF-16 code units, the indices
  JavaScript strings use. The parsing worker converts.

## Compatibility

- **Additive** (new optional field, new type, new enum value that consumers may ignore):
  allowed in any branch. Say so in the PR.
- **Breaking** (removing or renaming a field, making a field required, narrowing a type,
  changing what a value means): agree on it first. For events, add a new payload version:
  bump the event's `version` in `x-events`. Consumers dead-letter events whose version is
  newer than the one they know, so nothing silently misreads data.

## IDs

IDs are a short kind prefix and a ULID (`clm_01JC...`), so they sort by creation time and
say what they point at. `newId("claim")` makes one; `stableId(kind, ...parts)` makes a
deterministic one for units that must keep their ID across rebuilds (page IDs from
taxonomy keys, for example). `kindOf(id)` reads the kind back. Content hashes are
`sha256:<hex>`; `combineHashes` builds an artifact's inputs hash from its inputs and its
producer's name, version, model and prompt version.

Source documents have no Inspiration ID of their own. A `ResourceRef` names them as
`"<source id>:<external id>"`, and access control stores them in SpiceDB under
`documentObjectId(sourceId, externalId)`.

Component names (`ComponentName`) are kebab case: `extraction`, `page-compiler`. A
component's name is its event producer name, its consumer group and the first part of its
model task names (`extraction.extract_claims`).

## Events

`newEvent(type, payload, { tenantId, producer })` builds a validated `EventEnvelope` with
the type's current version; `payloadOf(event, type)` reads the payload back with its type.
Pass `causation` when one event leads to another, so the correlation ID follows the whole
chain.

| Event | Published by | Consumed by |
| --- | --- | --- |
| `source.changed` | connectors, source-sync, research | source-sync |
| `document.fetched` | source-sync | normalization |
| `acl.changed` | source-sync | retrieval, access-control |
| `blocks.changed` | normalization | extraction, freshness, retrieval |
| `claims.updated` | extraction, governance, collaboration | freshness, governance, retrieval |
| `artifact.dirty` | freshness | extraction, page-compiler, retrieval |
| `review.due` | freshness | collaboration, research |
| `todo.created` | freshness, governance, collaboration, views | collaboration, web |
| `page.rendered` | page-compiler | collaboration, retrieval, web, views |
| `comment.created` | collaboration | extraction, collaboration |
| `unit.published` | collaboration | retrieval, agent-api |

`test/manifest.test.ts` keeps `components.yaml` and the catalogue in step; update this
table when either changes.
