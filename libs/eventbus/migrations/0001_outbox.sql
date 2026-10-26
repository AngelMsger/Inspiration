-- Transactional outbox. Producers insert here in the same transaction as their data;
-- the relay forwards rows to the bus in seq order and stamps relayed_at.
CREATE SCHEMA IF NOT EXISTS bus;

CREATE TABLE bus.outbox (
    seq         bigserial   PRIMARY KEY,
    event_id    text        NOT NULL UNIQUE,
    event_type  text        NOT NULL,
    tenant_id   text        NOT NULL,
    subject     text,
    envelope    jsonb       NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    relayed_at  timestamptz
);

CREATE INDEX outbox_pending ON bus.outbox (seq) WHERE relayed_at IS NULL;

-- Wake the relay as soon as a transaction with events commits.
CREATE FUNCTION bus.notify_outbox() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    PERFORM pg_notify('inspiration_outbox', '');
    RETURN NULL;
END
$$;

CREATE TRIGGER outbox_notify AFTER INSERT ON bus.outbox
    FOR EACH STATEMENT EXECUTE FUNCTION bus.notify_outbox();

-- Consumer-side deduplication for handlers whose effects live in Postgres: insert the
-- event id in the same transaction as the effects (see firstDelivery in the eventbus package).
CREATE TABLE bus.inbox (
    consumer_group text        NOT NULL,
    event_id       text        NOT NULL,
    processed_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (consumer_group, event_id)
);
