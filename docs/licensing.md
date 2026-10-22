# Licensing of the stack

This is an engineering summary to guide choices, not legal advice. Have counsel confirm it
before the first customer delivery.

| Component | Licence | Used as |
| --- | --- | --- |
| PostgreSQL | PostgreSQL Licence | database server |
| pgvector | PostgreSQL Licence | Postgres extension |
| ParadeDB pg_search (and the ParadeDB image) | AGPL-3.0 | Postgres extension for BM25 |
| Valkey | BSD-3-Clause | event streams and cache |
| SpiceDB | Apache-2.0 | permission service |
| authzed (Python client), grpcio | Apache-2.0 | M13 client |
| psycopg 3 | LGPL-3.0 | Postgres driver, used unmodified as a library |
| pydantic, FastAPI, jsonschema, redis-py | MIT | libraries |
| httpx, uvicorn | BSD-3-Clause | libraries |
| datamodel-code-generator, json-schema-to-typescript | MIT | build-time code generation |

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
same protocol, and works with the same client (`redis-py`), so nothing in the code depends
on which one runs.

**Model weights** are not part of this repository. Each model a deployment configures in
the gateway (Qwen, DeepSeek, bge, PaddleOCR-VL and others) has its own licence, which the
deployment must check, especially for commercial use and for fine-tuned variants.
