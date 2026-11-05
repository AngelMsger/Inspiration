-- One row per answer given: the member it was for, the spaces of the sources it read, how long
-- it took and what its model calls cost; never the question or the answer. Usage reads a
-- tenant's answers by month.
CREATE TABLE retrieval.answers (
    key       text PRIMARY KEY,
    tenant_id text NOT NULL,
    month     text NOT NULL,
    doc       jsonb NOT NULL
);

CREATE INDEX answers_tenant_month ON retrieval.answers (tenant_id, month);
