-- Blocks of each source version, written by normalization. A block's ID is stable across
-- versions, so there is one row per version and block. span_ids lists the block's spans;
-- versions share the spans that did not change, so a span can appear in many rows.
CREATE TABLE kb.blocks (
    source_version_id text    NOT NULL REFERENCES kb.source_versions (id),
    id                text    NOT NULL,
    tenant_id         text    NOT NULL,
    ordinal           integer NOT NULL,
    span_ids          text[]  NOT NULL,
    doc               jsonb   NOT NULL,
    PRIMARY KEY (source_version_id, id)
);

CREATE INDEX blocks_order ON kb.blocks (source_version_id, ordinal);
-- Which versions contain a span, for freshness and lineage.
CREATE INDEX blocks_spans ON kb.blocks USING gin (span_ids);
