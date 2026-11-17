-- +goose Up
-- A book's id becomes the SHA-256 of its original (ADR-0015). books is keyed
-- (user_id, id) and the position tables key on (user_id, book_id) and
-- reference users, not books, so they can outlive a book row. The new tables
-- are built beside the old ones so the whole conversion runs inside goose's
-- transaction without PRAGMA foreign_keys=OFF: nothing references books while
-- it is dropped, because the old position tables are dropped first.
--
-- A sha256 that is not 64 lowercase hex fails the CHECK below, which rolls the
-- migration back and leaves the database at version 8. The constraint name is
-- the message the owner sees. The migration never deletes data on its own.
CREATE TABLE books_new (
    user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    id TEXT NOT NULL
        CONSTRAINT "a book id is not a 64-character lowercase hex SHA-256: delete the books and reading positions, then import the books again"
        CHECK (length(id) = 64 AND id NOT GLOB '*[^0-9a-f]*'),
    title TEXT NOT NULL,
    authors TEXT NOT NULL,
    imported_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, id)
);

INSERT INTO books_new (user_id, id, title, authors, imported_at)
SELECT user_id, sha256, title, authors, imported_at FROM books;

CREATE TABLE reading_positions_new (
    user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    book_id TEXT NOT NULL,
    href TEXT NOT NULL,
    progression REAL NOT NULL,
    total_progression REAL NOT NULL,
    css_selector TEXT,
    character_offset INTEGER,
    text_before TEXT,
    text_highlight TEXT,
    text_after TEXT,
    saved_at INTEGER,
    PRIMARY KEY (user_id, book_id)
);

INSERT INTO reading_positions_new (
    user_id, book_id, href, progression, total_progression,
    css_selector, character_offset, text_before, text_highlight, text_after, saved_at
)
SELECT books.user_id, books.sha256, p.href, p.progression, p.total_progression,
       p.css_selector, p.character_offset, p.text_before, p.text_highlight, p.text_after, p.saved_at
FROM reading_positions AS p JOIN books ON books.id = p.book_id;

CREATE TABLE reading_position_tabs_new (
    user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    book_id TEXT NOT NULL,
    tab_id TEXT NOT NULL,
    highest_sequence INTEGER NOT NULL,
    PRIMARY KEY (user_id, book_id, tab_id)
);

INSERT INTO reading_position_tabs_new (user_id, book_id, tab_id, highest_sequence)
SELECT books.user_id, books.sha256, t.tab_id, t.highest_sequence
FROM reading_position_tabs AS t JOIN books ON books.id = t.book_id;

DROP TABLE reading_position_tabs;
DROP TABLE reading_positions;
DROP TABLE books;
ALTER TABLE books_new RENAME TO books;
ALTER TABLE reading_positions_new RENAME TO reading_positions;
ALTER TABLE reading_position_tabs_new RENAME TO reading_position_tabs;

-- +goose Down
-- Not reversible: SHA-256 ids cannot become integer row ids again.
