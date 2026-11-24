-- +goose Up
ALTER TABLE reading_settings ADD COLUMN repeated_lines INTEGER NOT NULL DEFAULT 1;

-- +goose Down
ALTER TABLE reading_settings DROP COLUMN repeated_lines;
