-- +goose Up
-- A user's saved reading settings. A user without a row reads with the
-- defaults, so existing users need no row.
CREATE TABLE reading_settings (
    user_id INTEGER PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
    font_size INTEGER NOT NULL,
    line_height REAL NOT NULL,
    width INTEGER NOT NULL,
    theme TEXT NOT NULL
);

-- +goose Down
DROP TABLE reading_settings;
