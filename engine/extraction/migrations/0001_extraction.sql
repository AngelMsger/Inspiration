-- Extraction's own state. Only extraction reads or writes extraction.*.
CREATE SCHEMA IF NOT EXISTS extraction;

-- The latest version of each document extraction has worked on. An older version delivered
-- again later changes nothing.
CREATE TABLE extraction.documents (
    key       text PRIMARY KEY,
    tenant_id text NOT NULL,
    doc       jsonb NOT NULL
);
