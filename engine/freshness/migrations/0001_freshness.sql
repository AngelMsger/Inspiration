-- Freshness's own state. Only freshness reads or writes freshness.*.
CREATE SCHEMA IF NOT EXISTS freshness;

-- Every current document: its review clock, its claims' classes and plan days.
CREATE TABLE freshness.documents (
    key               text PRIMARY KEY,
    tenant_id         text NOT NULL,
    source_version_id text NOT NULL,
    doc               jsonb NOT NULL
);

CREATE INDEX documents_version ON freshness.documents (source_version_id);
CREATE INDEX documents_tenant ON freshness.documents (tenant_id);

-- Documents that repeat each other, one row per direction, with their shared share of text.
CREATE TABLE freshness.copies (
    key       text PRIMARY KEY,
    tenant_id text NOT NULL,
    document  text NOT NULL,
    doc       jsonb NOT NULL
);

CREATE INDEX copies_document ON freshness.copies (tenant_id, document);

-- Reviews that fall due on a day: a document's review interval ends, or a plan's day comes.
CREATE TABLE freshness.due (
    key       text PRIMARY KEY,
    tenant_id text NOT NULL,
    document  text NOT NULL,
    day       text NOT NULL,
    doc       jsonb NOT NULL
);

CREATE INDEX due_day ON freshness.due (tenant_id, day COLLATE "C");
CREATE INDEX due_document ON freshness.due (tenant_id, document);

-- Deleted documents: the version that deleted them. Anything later about an older or the
-- deleted version changes nothing, so a late claims update cannot bring a document back.
CREATE TABLE freshness.deleted (
    key       text PRIMARY KEY,
    tenant_id text NOT NULL,
    doc       jsonb NOT NULL
);
