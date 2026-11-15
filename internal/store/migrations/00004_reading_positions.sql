-- +goose Up
-- One reading position per book (per user, via books.user_id). Tab sequence
-- numbers are kept apart so a delayed save cannot overwrite a newer one after
-- another tab has saved (ADR-0005).
CREATE TABLE reading_positions (
    book_id INTEGER PRIMARY KEY REFERENCES books (id) ON DELETE CASCADE,
    href TEXT NOT NULL,
    progression REAL NOT NULL,
    total_progression REAL NOT NULL,
    css_selector TEXT,
    character_offset INTEGER,
    text_before TEXT,
    text_highlight TEXT,
    text_after TEXT
);

CREATE TABLE reading_position_tabs (
    book_id INTEGER NOT NULL REFERENCES books (id) ON DELETE CASCADE,
    tab_id TEXT NOT NULL,
    highest_sequence INTEGER NOT NULL,
    PRIMARY KEY (book_id, tab_id)
);

-- +goose Down
DROP TABLE reading_position_tabs;
DROP TABLE reading_positions;
