-- Companies (tenants), their members and invite links. The business layer is their system of
-- record; the engine keeps a copy of companies and members that tenancy provisions.
CREATE SCHEMA IF NOT EXISTS tenancy;

CREATE TABLE tenancy.companies (
    tenant_id      text        PRIMARY KEY,
    name           text        NOT NULL,
    default_locale text        NOT NULL,
    version        integer     NOT NULL,
    created_at     timestamptz NOT NULL
);

-- A member ID is unique only within its company. user_id is the account (accounts.users),
-- kept without a foreign key: each component owns its own tables.
CREATE TABLE tenancy.members (
    tenant_id    text        NOT NULL REFERENCES tenancy.companies,
    member_id    text        NOT NULL,
    user_id      text        NOT NULL,
    role         text        NOT NULL CHECK (role IN ('super_admin', 'member')),
    status       text        NOT NULL CHECK (status IN ('active', 'left')),
    display_name text        NOT NULL,
    email        text        NOT NULL,
    version      integer     NOT NULL,
    joined_at    timestamptz NOT NULL,
    PRIMARY KEY (tenant_id, member_id),
    UNIQUE (tenant_id, user_id)
);

CREATE INDEX members_user ON tenancy.members (user_id);

-- Only a hash of an invite's code is kept, so the link is shown once, when it is made.
CREATE TABLE tenancy.invites (
    invite_id  text        PRIMARY KEY,
    tenant_id  text        NOT NULL REFERENCES tenancy.companies,
    code_hash  text        NOT NULL UNIQUE,
    created_by text        NOT NULL,
    created_at timestamptz NOT NULL,
    expires_at timestamptz NOT NULL,
    revoked_at timestamptz,
    joined     integer     NOT NULL DEFAULT 0
);

CREATE INDEX invites_tenant ON tenancy.invites (tenant_id, created_at);
