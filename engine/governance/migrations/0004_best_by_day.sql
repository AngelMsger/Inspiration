-- Value groups stored before each group kept its best statement by the day it takes effect
-- have no best_from. As with 0003, governance counts such a group again from its members when
-- it reads it, and a recheck due at once decides each such slot again.
INSERT INTO governance.rechecks (key, tenant_id, day, doc)
SELECT DISTINCT tenant_id || chr(31) || slot, tenant_id, '', jsonb_build_object('tenant_id', tenant_id, 'slot', slot, 'day', '')
FROM governance.value_groups
WHERE NOT doc ? 'best_from'
ON CONFLICT (key) DO UPDATE SET day = EXCLUDED.day, doc = EXCLUDED.doc;
