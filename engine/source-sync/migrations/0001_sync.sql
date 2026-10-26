-- Source sync's own state. Only source sync reads or writes sync.*.
CREATE SCHEMA IF NOT EXISTS sync;

-- Connected sources, as the business layer registered them.
CREATE TABLE sync.sources (
    key       text PRIMARY KEY,
    tenant_id text NOT NULL,
    status    text NOT NULL,
    doc       jsonb NOT NULL
);

-- What source sync last stored for each item: the connector's version hashes and the
-- source version they became. Listing compares against these instead of the knowledge store.
CREATE TABLE sync.items (
    key       text PRIMARY KEY,
    source_id text NOT NULL,
    deleted   boolean NOT NULL,
    doc       jsonb NOT NULL
);

CREATE INDEX items_source ON sync.items (source_id);
