-- Built-in agent runs, kept for traces, replay and evals.
CREATE SCHEMA IF NOT EXISTS agents;

CREATE TABLE agents.runs (
    run_id      text        PRIMARY KEY,
    agent       text        NOT NULL,
    version     text        NOT NULL,
    status      text        NOT NULL,
    trace_id    text        NOT NULL,
    principal   text        NOT NULL,
    started_at  timestamptz NOT NULL,
    finished_at timestamptz NOT NULL,
    result      jsonb       NOT NULL
);

CREATE INDEX runs_agent ON agents.runs (agent, started_at);
