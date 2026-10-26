-- Normalization's own state. Only normalization reads or writes normalization.*.
CREATE SCHEMA IF NOT EXISTS normalization;

-- The version of each document that normalization last stored blocks for, with its parser,
-- counts and text fingerprint. Block diffs are taken against this version.
CREATE TABLE normalization.documents (
    key       text PRIMARY KEY,
    tenant_id text NOT NULL,
    source_id text NOT NULL,
    status    text NOT NULL,
    doc       jsonb NOT NULL
);

CREATE INDEX documents_source ON normalization.documents (source_id);

-- SimHash bands of current documents, for finding duplicate candidates within a tenant.
CREATE TABLE normalization.fingerprints (
    key       text PRIMARY KEY,
    tenant_id text NOT NULL,
    band      text NOT NULL,
    doc       jsonb NOT NULL
);

CREATE INDEX fingerprints_band ON normalization.fingerprints (tenant_id, band);
