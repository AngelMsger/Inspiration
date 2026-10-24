-- Fact slots: claims that state the same single-valued fact share a slot key.
ALTER TABLE kb.claims ADD COLUMN slot_key text;

UPDATE kb.claims SET slot_key = doc->>'slot_key' WHERE doc ? 'slot_key';

CREATE INDEX claims_slot ON kb.claims (tenant_id, slot_key) WHERE slot_key IS NOT NULL;
