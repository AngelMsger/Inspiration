-- Document ACLs as read from their sources, one row per distinct ACL (acl.changed names
-- the hash it means). Access control mirrors them into SpiceDB.
CREATE TABLE kb.acl_snapshots (
    source_id   text        NOT NULL,
    external_id text        NOT NULL,
    acl_hash    text        NOT NULL,
    captured_at timestamptz NOT NULL,
    doc         jsonb       NOT NULL,
    PRIMARY KEY (source_id, external_id, acl_hash)
);

CREATE INDEX acl_snapshots_latest ON kb.acl_snapshots (source_id, external_id, captured_at DESC);
