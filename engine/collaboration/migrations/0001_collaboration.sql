-- Collaboration's own state. Only collaboration reads or writes collaboration.*.
CREATE SCHEMA IF NOT EXISTS collaboration;

-- Every todo in the inbox, with what routing it needs: its dedupe key, the week it fell due,
-- the correlation of the source update that asked for it.
CREATE TABLE collaboration.items (
    key            text PRIMARY KEY,
    tenant_id      text NOT NULL,
    dedupe_key     text NOT NULL,
    status         text NOT NULL,
    assignee       text,
    week           text,
    batch_key      text,
    correlation_id text,
    doc            jsonb NOT NULL
);

CREATE INDEX items_dedupe ON collaboration.items (tenant_id, dedupe_key);
CREATE INDEX items_week ON collaboration.items (tenant_id, assignee, week);
CREATE INDEX items_batch ON collaboration.items (tenant_id, batch_key);
CREATE INDEX items_correlation ON collaboration.items (tenant_id, correlation_id);
CREATE INDEX items_status ON collaboration.items (tenant_id, status);
