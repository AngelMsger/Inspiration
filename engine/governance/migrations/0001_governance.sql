-- Governance's own state. Only governance reads or writes governance.*.
CREATE SCHEMA IF NOT EXISTS governance;

-- Every current claim with a slot and a value.
CREATE TABLE governance.members (
    key       text PRIMARY KEY,
    tenant_id text NOT NULL,
    slot      text NOT NULL,
    value     text NOT NULL,
    doc       jsonb NOT NULL
);

CREATE INDEX members_value ON governance.members (tenant_id, slot, value);

-- The members of a slot that state one value, as counts and representatives.
CREATE TABLE governance.value_groups (
    key       text PRIMARY KEY,
    tenant_id text NOT NULL,
    slot      text NOT NULL,
    doc       jsonb NOT NULL
);

CREATE INDEX value_groups_slot ON governance.value_groups (tenant_id, slot);

-- Conflict cases (ConflictCase), one per slot and competing value.
CREATE TABLE governance.conflicts (
    key       text PRIMARY KEY,
    tenant_id text NOT NULL,
    slot      text,
    status    text NOT NULL,
    doc       jsonb NOT NULL
);

CREATE INDEX conflicts_slot ON governance.conflicts (tenant_id, slot);

-- What governance last asked a person to decide for each slot.
CREATE TABLE governance.slots (
    key       text PRIMARY KEY,
    tenant_id text NOT NULL,
    doc       jsonb NOT NULL
);
