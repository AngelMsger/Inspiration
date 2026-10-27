# Licensing of the stack

This is an engineering summary to guide choices, not legal advice. Have counsel confirm it
before the first customer delivery. A Chinese copy is in [zh/licensing.md](zh/licensing.md);
if the two differ, this English version wins.

| Component | Licence | Used as |
| --- | --- | --- |
| PostgreSQL | PostgreSQL Licence | database server |
| pgvector | PostgreSQL Licence | Postgres extension |
| ParadeDB pg_search (and the ParadeDB image) | AGPL-3.0 | Postgres extension for BM25 |
| Valkey | BSD-3-Clause | event streams and cache |
| SpiceDB | Apache-2.0 | permission service |
| Node.js | MIT | runtime |
| @authzed/authzed-node, @grpc/grpc-js | Apache-2.0 | SpiceDB client in access-control |
| pg (node-postgres), ioredis | MIT | database and Valkey drivers |
| Hono, @hono/node-server | MIT | model gateway HTTP service |
| Ajv, ajv-formats | MIT | contract validation |
| yaml | ISC | configuration and schema files |
| json-schema-to-typescript | MIT | build-time code generation |
| TypeScript | Apache-2.0 | build-time type checking |
| Vitest | MIT | tests |
| Biome | MIT or Apache-2.0 | lint and format |

The parsing worker is Python; its parser libraries (for Office, PDF and scanned documents)
are chosen when it is built and get their own rows here. Watch for copyleft PDF libraries
(PyMuPDF is AGPL-3.0).

## What needs attention

**pg_search is AGPL-3.0.** Running it unmodified as a separate database extension, and
talking to it over SQL, does not make Inspiration's own code a derivative work in the usual
reading of the AGPL. The obligations attach if we modify pg_search and offer it over a
network, or if we ship it to customers as part of an on-premises delivery, in which case we
must pass on its source and licence. Options if that is unacceptable for a customer:

1. Buy ParadeDB's commercial licence.
2. Swap the keyword index. BM25 sits behind the `KeywordIndex` plugin protocol, so an
   OpenSearch (Apache-2.0) implementation can replace `PgSearchIndex` without touching
   retrieval. The Chinese analyzer then needs the IK or jieba plugin on OpenSearch.

**Valkey instead of Redis.** Redis 7.4 and later are licensed under RSALv2, SSPLv1 or
AGPLv3, which complicates on-premises delivery. Valkey is the BSD-licensed fork, speaks the
same protocol, and works with the same client (`ioredis`), so nothing in the code depends
on which one runs.

**Model weights** are not part of this repository. Each model a deployment configures in
the gateway (Qwen, DeepSeek, bge, PaddleOCR-VL and others) has its own licence, which the
deployment must check, especially for commercial use and for fine-tuned variants.

## Test data

Sample data in `examples/` is ours except where its README names a source.
[`examples/gitlab-expenses`](../examples/gitlab-expenses/README.md) holds 21 versions of
GitLab's public travel and expense policy, © GitLab Inc. and contributors, under CC BY-SA
4.0. They are copied unchanged with a link to each commit, which is the attribution the
licence asks for; a changed copy would have to carry the same licence.
[`examples/kubernetes-docs`](../examples/kubernetes-docs/README.md) holds the content of five
pages of the Kubernetes documentation in English, Chinese and Japanese, © The Kubernetes
Authors, under CC BY 4.0, with the title and link of each page and its commit in
`sources.yaml`. Test data stays out of what we ship to customers.
