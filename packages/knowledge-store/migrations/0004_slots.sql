-- Fact slots: claims that state the same single-valued fact share a slot key. The column
-- holds the key slotOf() gives a claim: its own slot_key, else its subject entity when
-- resolved, its predicate and its qualifiers in code point order. Claims stored before this
-- migration carry no slot_key of their own, so they get the derived one.
ALTER TABLE kb.claims ADD COLUMN slot_key text;

UPDATE kb.claims SET slot_key = COALESCE(
    NULLIF(doc->>'slot_key', ''),
    CASE WHEN COALESCE(doc->>'predicate', '') <> '' THEN
        CASE WHEN COALESCE(doc->>'subject_entity_id', '') <> '' THEN (doc->>'subject_entity_id') || '/' ELSE '' END
        || concat_ws('|', doc->>'predicate', (
            SELECT string_agg(q, '|' ORDER BY q COLLATE "C")
            FROM jsonb_array_elements_text(COALESCE(doc->'qualifiers', '[]'::jsonb)) AS q
        ))
    END
);

CREATE INDEX claims_slot ON kb.claims (tenant_id, slot_key) WHERE slot_key IS NOT NULL;
