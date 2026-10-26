-- Principal IDs are unique only within their tenant, so a run keeps its tenant, and the member
-- an agent acted for. Runs saved before this have neither.
ALTER TABLE agents.runs ADD COLUMN tenant_id text;
ALTER TABLE agents.runs ADD COLUMN on_behalf_of text;

CREATE INDEX runs_tenant ON agents.runs (tenant_id, started_at);
