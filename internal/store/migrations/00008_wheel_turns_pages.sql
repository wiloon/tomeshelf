-- +goose Up
ALTER TABLE reading_settings ADD COLUMN wheel_turns_pages BOOLEAN NOT NULL DEFAULT TRUE;

-- +goose Down
ALTER TABLE reading_settings DROP COLUMN wheel_turns_pages;
