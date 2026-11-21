ALTER TABLE collaboration.document_comments ADD COLUMN dedupe_key text;
UPDATE collaboration.document_comments SET dedupe_key = 'document-comment:' || (doc->>'id');
ALTER TABLE collaboration.document_comments ALTER COLUMN dedupe_key SET NOT NULL;
CREATE INDEX document_comments_dedupe ON collaboration.document_comments (tenant_id, dedupe_key);

UPDATE collaboration.items SET doc = jsonb_set(doc, '{todo,title}', '"Review source feedback"')
WHERE dedupe_key LIKE 'document-comment:%';
