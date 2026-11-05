-- How far reading a document's latest version has come: "reading" until it is read to the
-- end, "paused" while a spent budget or a model out of reach holds it, null once it is read.
ALTER TABLE extraction.documents ADD COLUMN state text;

CREATE INDEX documents_state ON extraction.documents (state) WHERE state IS NOT NULL;
