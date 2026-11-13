-- Pending indexing survives model outages, exhausted budgets and process restarts.
CREATE TABLE retrieval.jobs (
    key       text PRIMARY KEY,
    tenant_id text NOT NULL,
    source_id text NOT NULL,
    doc       jsonb NOT NULL
);
CREATE INDEX jobs_tenant ON retrieval.jobs (tenant_id);
CREATE INDEX jobs_source ON retrieval.jobs (source_id);
