-- Whom each call is charged to: the member who asked for the work, or the space whose
-- documents it reads. Both are absent for upkeep and for calls recorded before this.
ALTER TABLE gateway.usage ADD COLUMN member_id text, ADD COLUMN space_id text;
