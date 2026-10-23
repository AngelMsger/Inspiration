-- The knowledge store. Every table keeps the full contract object in `doc` and copies the
-- fields that queries filter on into typed columns. Only the knowledge store reads or writes kb.*.
CREATE SCHEMA IF NOT EXISTS kb;

-- Immutable fetched revisions of source items.
CREATE TABLE kb.source_versions (
    id          text        PRIMARY KEY,
    tenant_id   text        NOT NULL,
    source_id   text        NOT NULL,
    space_id    text        NOT NULL,
    external_id text        NOT NULL,
    fetched_at  timestamptz NOT NULL,
    deleted     boolean     NOT NULL DEFAULT false,
    sensitivity text        NOT NULL,
    doc         jsonb       NOT NULL
);

CREATE INDEX source_versions_item ON kb.source_versions (source_id, external_id, fetched_at DESC);

-- Exact passages, cells and fields. Evidence quotes must be substrings of span text.
CREATE TABLE kb.spans (
    id                text    PRIMARY KEY,
    tenant_id         text    NOT NULL,
    source_version_id text    NOT NULL REFERENCES kb.source_versions (id),
    ordinal           integer NOT NULL,
    text              text    NOT NULL,
    doc               jsonb   NOT NULL
);

CREATE INDEX spans_version ON kb.spans (source_version_id, ordinal);

-- Retrieval chunks. search_text is what BM25 sees: contextual header, heading path, text.
CREATE TABLE kb.chunks (
    id                text     PRIMARY KEY,
    tenant_id         text     NOT NULL,
    source_version_id text     NOT NULL REFERENCES kb.source_versions (id),
    space_id          text     NOT NULL,
    ordinal           integer  NOT NULL,
    search_text       text     NOT NULL,
    sensitivity_rank  smallint NOT NULL,
    acl_tokens        text[]   NOT NULL DEFAULT '{}',
    doc               jsonb    NOT NULL
);

CREATE INDEX chunks_version ON kb.chunks (source_version_id, ordinal);

-- BM25 with jieba for Chinese (search mode, whitespace tokens trimmed, traditional folded to
-- simplified). Space and sensitivity filters are pushed into the index; the ACL token
-- overlap runs as a heap filter before the top-k cut.
CREATE INDEX chunks_bm25 ON kb.chunks USING bm25 (
    id,
    (search_text::pdb.jieba('search_mode=true', 'trim=true', 'chinese_convert=t2s')),
    (space_id::pdb.literal),
    sensitivity_rank
);

-- Embeddings. The column has no fixed size so models can change; the HNSW index covers
-- 1024-dimension vectors (Qwen3-Embedding-0.6B, bge-m3). Other sizes are searched exactly.
CREATE TABLE kb.chunk_embeddings (
    chunk_id  text    PRIMARY KEY REFERENCES kb.chunks (id) ON DELETE CASCADE,
    model     text    NOT NULL,
    dims      integer NOT NULL,
    embedding vector  NOT NULL
);

CREATE INDEX chunk_embeddings_hnsw_1024 ON kb.chunk_embeddings
    USING hnsw ((embedding::vector(1024)) vector_cosine_ops) WHERE dims = 1024;

-- Claims are never deleted. superseded_at closes the "known when" interval.
CREATE TABLE kb.claims (
    id                text        PRIMARY KEY,
    tenant_id         text        NOT NULL,
    space_id          text        NOT NULL,
    status            text        NOT NULL,
    knowledge_class   text        NOT NULL,
    subject_entity_id text,
    predicate         text,
    valid_from        timestamptz,
    valid_to          timestamptz,
    recorded_at       timestamptz NOT NULL,
    superseded_at     timestamptz,
    superseded_by     text        REFERENCES kb.claims (id),
    supersede_reason  text,
    sensitivity       text        NOT NULL,
    doc               jsonb       NOT NULL
);

CREATE INDEX claims_space ON kb.claims (space_id, status);
CREATE INDEX claims_subject ON kb.claims (subject_entity_id, predicate) WHERE subject_entity_id IS NOT NULL;
CREATE INDEX claims_predicate ON kb.claims (predicate) WHERE predicate IS NOT NULL;
CREATE INDEX claims_current ON kb.claims (tenant_id, recorded_at) WHERE superseded_at IS NULL;

CREATE TABLE kb.claim_evidence (
    claim_id          text  NOT NULL REFERENCES kb.claims (id),
    span_id           text  NOT NULL REFERENCES kb.spans (id),
    source_version_id text  NOT NULL REFERENCES kb.source_versions (id),
    role              text  NOT NULL,
    doc               jsonb NOT NULL,
    PRIMARY KEY (claim_id, span_id, role)
);

CREATE INDEX claim_evidence_span ON kb.claim_evidence (span_id);
CREATE INDEX claim_evidence_version ON kb.claim_evidence (source_version_id);

CREATE TABLE kb.claim_derivations (
    claim_id       text   PRIMARY KEY REFERENCES kb.claims (id),
    from_claim_ids text[] NOT NULL,
    method         text   NOT NULL
);

CREATE INDEX claim_derivations_from ON kb.claim_derivations USING gin (from_claim_ids);

-- What each built artifact (claim set, SOP, page, view) was built from, for the freshness
-- engine's dirty propagation and for lineage.
CREATE TABLE kb.dependencies (
    artifact_id text NOT NULL,
    input_id    text NOT NULL,
    input_hash  text NOT NULL,
    PRIMARY KEY (artifact_id, input_id)
);

CREATE INDEX dependencies_input ON kb.dependencies (input_id);

-- Every rendered page version, immutable.
CREATE TABLE kb.page_snapshots (
    page_id     text        NOT NULL,
    version     integer     NOT NULL CHECK (version >= 1),
    tenant_id   text        NOT NULL,
    space_id    text        NOT NULL,
    inputs_hash text        NOT NULL,
    created_at  timestamptz NOT NULL,
    doc         jsonb       NOT NULL,
    PRIMARY KEY (page_id, version)
);
