-- Decide for me: the assistant's decisions in members' names, and each member's standing
-- delegation.
CREATE TABLE collaboration.decisions (
    key       text PRIMARY KEY,
    tenant_id text NOT NULL,
    member    text NOT NULL,
    todo      text NOT NULL,
    week      text NOT NULL,
    doc       jsonb NOT NULL
);

CREATE INDEX decisions_member_week ON collaboration.decisions (tenant_id, member, week);
CREATE INDEX decisions_todo ON collaboration.decisions (tenant_id, todo);

CREATE TABLE collaboration.delegations (
    key       text PRIMARY KEY,
    tenant_id text NOT NULL,
    doc       jsonb NOT NULL
);
