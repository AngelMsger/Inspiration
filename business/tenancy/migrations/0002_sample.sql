-- The sample company anyone may open. The engine keeps its record, loaded from a corpus, so
-- tenancy never sends it; it keeps the company here only for its visitors' member records.
ALTER TABLE tenancy.companies ADD COLUMN sample boolean NOT NULL DEFAULT false;
