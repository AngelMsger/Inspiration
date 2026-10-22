# Contracts

Every type that crosses a module boundary is defined once, in JSON Schema (draft 2020-12)
written as YAML under `contracts/schema/`. Python and TypeScript are generated from it.

| File | Contents |
| --- | --- |
| `common.yaml` | IDs, instants, intervals, hashes, sensitivity labels, blob references, producer info |
| `source.yaml` | sources, connector capabilities, versions, normalized documents, spans, chunks, approval flows |
| `knowledge.yaml` | claims and evidence, entities, relations, SOPs, knowledge models, research, freshness, lineage, conflicts |
| `page.yaml` | PageSpec and its 14 block types, data references, charts, diagrams, views and their message protocol, snapshots |
| `collab.yaml` | comments, anchors, proposals, overrides, todos, publishing |
| `authz.yaml` | principals, permissions, decisions, index filters, ACL snapshots, spaces, audit events |
| `gateway.yaml` | completion, embedding, rerank and OCR requests and results, usage, budgets, errors |
| `retrieval.yaml` | search and answer requests and results, citations, feedback |
| `events.yaml` | the event envelope and the payload of each event type (`x-events`) |
| `agents.yaml` | tool specs, agent specs, run context, steps and results |

## Changing a contract

```bash
$EDITOR contracts/schema/page.yaml
make contracts          # bundle, then generate Python and TypeScript
make contracts-check    # what CI runs: fails if anything generated is stale
uv run pytest contracts # examples validate against schema and models
```

Rules:

- Type names are unique across all files; the bundler flattens them into one namespace
  (`contracts/dist/inspiration.schema.json`).
- Field names are `snake_case` in JSON, Python and TypeScript alike.
- Every enum and every object used in more than one place gets its own named definition,
  so generated code has readable names.
- Unions that cross the wire carry a tag (`type` for blocks and view messages, `kind` for
  data references); the bundler adds the discriminator so pydantic picks the right class.
- Put an example of every new cross-module type in `contracts/examples/<Type>.<name>.json`.

## Compatibility

- **Additive** (new optional field, new type, new enum value that consumers may ignore):
  allowed in any branch. Say so in the PR.
- **Breaking** (removing or renaming a field, making a field required, narrowing a type,
  changing what a value means): agree on it first. For events, add a new payload version:
  bump the event's `version` in `x-events`. Consumers dead-letter events whose version is
  newer than the one they know, so nothing silently misreads data.

## IDs

IDs are a short kind prefix and a ULID (`clm_01JC...`), so they sort by creation time and
say what they point at. `inspiration.contracts.new_id("claim")` makes one; `stable_id(kind,
*parts)` makes a deterministic one for units that must keep their ID across rebuilds (page
IDs from taxonomy keys, for example). `kind_of(id)` reads the kind back. Content hashes are
`sha256:<hex>`; `combine_hashes` builds an artifact's inputs hash from its inputs and its
producer's name, version, model and prompt version.

Source documents have no Inspiration ID of their own. A `ResourceRef` names them as
`"<source id>:<external id>"`, and M13 stores them in SpiceDB under
`document_object_id(source_id, external_id)`.

## Events

`new_event(payload, tenant_id=..., producer=...)` wraps a payload model in an
`EventEnvelope`, looking up the event type and version from the payload class;
`payload_of(event, Model)` reads it back. Pass `causation=` when one event leads to another,
so the correlation ID follows the whole chain.

| Event | Published by | Consumed by |
| --- | --- | --- |
| `source.changed` | M1, M2, M15 | M2 |
| `document.fetched` | M2 | M4 |
| `acl.changed` | M2 | M11, M13 |
| `chunks.updated` | M4 | M5, M6, M11 |
| `claims.updated` | M5, M7, M9 | M6, M7, M11 |
| `artifact.dirty` | M6 | M5, M8, M11 |
| `review.due` | M6 | M9, M15 |
| `todo.created` | M6, M7, M9, M17 | M9, M16 |
| `page.rendered` | M8 | M9, M11, M16, M17 |
| `comment.created` | M9 | M5, M9 |
| `unit.published` | M9 | M11, M12 |

`tests/test_manifest.py` keeps this table, `modules.yaml` and the catalogue in step.
