-- +goose Up
-- How the reader arranges a document: pages (default) or scroll. Rows
-- saved before this column existed get pages through the default.
ALTER TABLE reading_settings ADD COLUMN layout TEXT NOT NULL DEFAULT 'pages';

-- +goose Down
ALTER TABLE reading_settings DROP COLUMN layout;
