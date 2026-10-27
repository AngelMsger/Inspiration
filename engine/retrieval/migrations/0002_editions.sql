-- Documents that are editions of one text (a copy, an older revision), as normalization
-- reports them in blocks.changed: one row each way, so a document finds its editions.
CREATE TABLE retrieval.editions (
    key       text PRIMARY KEY,
    tenant_id text NOT NULL,
    document  text NOT NULL,
    doc       jsonb NOT NULL
);

CREATE INDEX editions_document ON retrieval.editions (tenant_id, document);
