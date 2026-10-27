-- Retrieval's own state. Only retrieval reads or writes retrieval.*; its chunks and
-- embeddings live in kb.chunks and kb.chunk_embeddings, behind the index plugins.
CREATE SCHEMA IF NOT EXISTS retrieval;

-- Every document retrieval has indexed: the version its chunks are of, and their IDs.
CREATE TABLE retrieval.documents (
    key       text PRIMARY KEY,
    tenant_id text NOT NULL,
    doc       jsonb NOT NULL
);

CREATE INDEX documents_tenant ON retrieval.documents (tenant_id);
