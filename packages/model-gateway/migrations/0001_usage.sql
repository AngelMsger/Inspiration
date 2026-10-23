-- Metering: one row per model call. Budgets and cost reports read this table.
CREATE SCHEMA IF NOT EXISTS gateway;

-- One row per gateway call, including failures. Budgets are sums over this table.
CREATE TABLE gateway.usage (
    request_id     text        PRIMARY KEY,
    at             timestamptz NOT NULL,
    tenant_id      text,
    operation      text        NOT NULL,
    task           text,
    prompt_version text,
    budget_key     text        NOT NULL,
    sensitivity    text        NOT NULL,
    provider       text,
    model          text,
    status         text        NOT NULL,
    input_tokens   integer     NOT NULL DEFAULT 0,
    output_tokens  integer     NOT NULL DEFAULT 0,
    cached_tokens  integer     NOT NULL DEFAULT 0,
    cost           numeric(18, 8) NOT NULL DEFAULT 0,
    currency       text        NOT NULL,
    latency_ms     integer     NOT NULL DEFAULT 0,
    error          text
);

CREATE INDEX usage_budget ON gateway.usage (budget_key, at);
CREATE INDEX usage_tenant ON gateway.usage (tenant_id, at);
