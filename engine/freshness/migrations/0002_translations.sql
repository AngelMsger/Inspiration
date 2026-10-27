-- Translations, one row each, by the document they translate, so an edit of the original
-- finds the translations it leaves behind.
CREATE TABLE freshness.translations (
    key       text PRIMARY KEY,
    tenant_id text NOT NULL,
    original  text NOT NULL,
    doc       jsonb NOT NULL
);

CREATE INDEX translations_original ON freshness.translations (tenant_id, original);
