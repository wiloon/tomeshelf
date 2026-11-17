-- +goose Up
ALTER TABLE reading_positions ADD COLUMN saved_at INTEGER;

-- +goose Down
ALTER TABLE reading_positions DROP COLUMN saved_at;
