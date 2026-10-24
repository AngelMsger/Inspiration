-- Page compiler's own state. Only page-compiler reads or writes page_compiler.*.
CREATE SCHEMA IF NOT EXISTS page_compiler;

-- Sections of current documents: their current claims, the embedding of a governed one,
-- and the topic it sits in.
CREATE TABLE page_compiler.sections (
    key       text PRIMARY KEY,
    tenant_id text NOT NULL,
    document  text NOT NULL,
    doc       jsonb NOT NULL
);

CREATE INDEX sections_tenant ON page_compiler.sections (tenant_id);
CREATE INDEX sections_document ON page_compiler.sections (tenant_id, document);

-- Topics as the last clustering left them, with the centroids the next one starts from.
CREATE TABLE page_compiler.topics (
    key       text PRIMARY KEY,
    tenant_id text NOT NULL,
    space_id  text NOT NULL,
    leaf      boolean NOT NULL,
    doc       jsonb NOT NULL
);

CREATE INDEX topics_space ON page_compiler.topics (tenant_id, space_id, leaf);

-- The topic each fact slot's statements go to, per space.
CREATE TABLE page_compiler.slots (
    key       text PRIMARY KEY,
    tenant_id text NOT NULL,
    doc       jsonb NOT NULL
);

CREATE INDEX slots_tenant ON page_compiler.slots (tenant_id);
