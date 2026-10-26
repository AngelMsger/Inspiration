-- Value groups stored before governed statements were counted by the day they take effect
-- have no governed_from. Governance counts such a group again from its members when it reads
-- it, but a slot no new claim touches would keep its old decision and miss the day a
-- governed statement takes effect. A recheck due at once decides each such slot again, which
-- stores its groups recounted and schedules its next recheck.
INSERT INTO governance.rechecks (key, tenant_id, day, doc)
SELECT DISTINCT tenant_id || chr(31) || slot, tenant_id, '', jsonb_build_object('tenant_id', tenant_id, 'slot', slot, 'day', '')
FROM governance.value_groups
WHERE NOT doc ? 'governed_from'
ON CONFLICT (key) DO UPDATE SET day = EXCLUDED.day, doc = EXCLUDED.doc;
