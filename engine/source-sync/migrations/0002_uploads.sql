-- The files people put into each space's upload area: the stored bytes and who put them there.
-- The upload area's connector lists and fetches these as a connector lists its system.
CREATE TABLE sync.uploads (
    key       text PRIMARY KEY,
    source_id text NOT NULL,
    doc       jsonb NOT NULL
);

CREATE INDEX uploads_source ON sync.uploads (source_id);
