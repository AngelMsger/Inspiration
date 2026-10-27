-- Value groups stored before each group kept the newest of its documents' dates have no
-- newest, and their members no modified day. As with 0003 to 0005, governance counts such a
-- group again from its members when it reads it, giving each member its document's date from
-- its source version, and a recheck due at once decides each such slot again.
INSERT INTO governance.rechecks (key, tenant_id, day, doc)
SELECT DISTINCT tenant_id || chr(31) || slot, tenant_id, '', jsonb_build_object('tenant_id', tenant_id, 'slot', slot, 'day', '')
FROM governance.value_groups
WHERE NOT doc ? 'newest'
ON CONFLICT (key) DO UPDATE SET day = EXCLUDED.day, doc = EXCLUDED.doc;
