-- Topics of a space's knowledge outline (TaxonomyNode), and where each statement sits in it
-- (Placement). A claim without a placement is unfiled.
CREATE TABLE kb.topics (
    tenant_id  text NOT NULL,
    key        text NOT NULL,
    space_id   text NOT NULL,
    parent_key text,
    doc        jsonb NOT NULL,
    PRIMARY KEY (tenant_id, key),
    FOREIGN KEY (tenant_id, parent_key) REFERENCES kb.topics (tenant_id, key) DEFERRABLE INITIALLY DEFERRED
);

CREATE INDEX topics_space ON kb.topics (tenant_id, space_id);

CREATE TABLE kb.placements (
    claim_id     text PRIMARY KEY REFERENCES kb.claims (id),
    tenant_id    text NOT NULL,
    taxonomy_key text NOT NULL,
    doc          jsonb NOT NULL,
    FOREIGN KEY (tenant_id, taxonomy_key) REFERENCES kb.topics (tenant_id, key)
);

CREATE INDEX placements_topic ON kb.placements (tenant_id, taxonomy_key);
