-- Personal access tokens. Only a hash of each secret is kept, so a secret is shown once, when
-- the token is made. tenant_id and member_id name the engine's member the token acts for,
-- kept without foreign keys: each component owns its own tables.
CREATE SCHEMA IF NOT EXISTS access_grants;

CREATE TABLE access_grants.tokens (
    token_id     text        PRIMARY KEY,
    tenant_id    text        NOT NULL,
    member_id    text        NOT NULL,
    name         text        NOT NULL,
    -- NULL for every space the member can read.
    spaces       text[],
    scopes       text[]      NOT NULL,
    secret_hash  text        NOT NULL UNIQUE,
    created_at   timestamptz NOT NULL,
    expires_at   timestamptz NOT NULL,
    revoked_at   timestamptz,
    last_used_at timestamptz
);

CREATE INDEX tokens_member ON access_grants.tokens (tenant_id, member_id, created_at);
