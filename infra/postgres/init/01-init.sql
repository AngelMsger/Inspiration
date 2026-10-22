-- Runs once, when the data volume is created.
-- SpiceDB keeps its relationship tuples in its own database on the same instance.
CREATE DATABASE spicedb OWNER inspiration;

\connect inspiration
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_search;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
