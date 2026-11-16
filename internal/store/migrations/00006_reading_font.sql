-- +goose Up
-- Typeface for book text. Rows saved before this column existed get
-- default through the column default and fontOrDefault on read.
ALTER TABLE reading_settings ADD COLUMN font TEXT NOT NULL DEFAULT 'default';

-- +goose Down
ALTER TABLE reading_settings DROP COLUMN font;
