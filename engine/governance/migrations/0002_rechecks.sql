-- The next day on which a slot's decision can change without new claims: a dated change
-- it holds takes effect.
CREATE TABLE governance.rechecks (
    key       text PRIMARY KEY,
    tenant_id text NOT NULL,
    day       text NOT NULL,
    doc       jsonb NOT NULL
);

CREATE INDEX rechecks_day ON governance.rechecks (tenant_id, day COLLATE "C");
