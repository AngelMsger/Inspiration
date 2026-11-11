-- Discovered normalization vocabulary stays inside the space whose documents supplied it.
CREATE TABLE extraction.catalogues (
    key text PRIMARY KEY,
    tenant_id text NOT NULL,
    space_id text NOT NULL,
    doc jsonb NOT NULL
);
