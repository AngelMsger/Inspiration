CREATE TABLE collaboration.document_comments (
    key text PRIMARY KEY,
    tenant_id text NOT NULL,
    version_id text NOT NULL,
    doc jsonb NOT NULL
);
CREATE INDEX document_comments_version ON collaboration.document_comments (tenant_id, version_id);
