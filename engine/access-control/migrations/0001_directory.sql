-- Access control's own state: the engine's copy of the business layer's directory (tenants
-- and their members) and the spaces, which the engine keeps. Only access-control reads or
-- writes authz.*; the permission graph in SpiceDB holds what these records grant.
CREATE SCHEMA IF NOT EXISTS authz;

CREATE TABLE authz.tenants (
    key text PRIMARY KEY,
    doc jsonb NOT NULL
);

-- Keyed "<tenant id>|<member id>", since member IDs are unique only within their tenant.
CREATE TABLE authz.members (
    key       text PRIMARY KEY,
    tenant_id text NOT NULL,
    doc       jsonb NOT NULL
);

CREATE INDEX members_tenant ON authz.members (tenant_id);

-- Each space with its owners and audience.
CREATE TABLE authz.spaces (
    key       text PRIMARY KEY,
    tenant_id text NOT NULL,
    doc       jsonb NOT NULL
);

CREATE INDEX spaces_tenant ON authz.spaces (tenant_id);

-- Spaces created with an Idempotency-Key, keyed "<tenant id>|<key>": the request's hash and
-- the space it created.
CREATE TABLE authz.requests (
    key text PRIMARY KEY,
    doc jsonb NOT NULL
);
