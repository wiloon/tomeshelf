-- +goose Up
-- sha256 names the original at /data/books/<sha256>.epub (ADR-0007). authors
-- is a JSON array of names, in the order the package lists them.
CREATE TABLE books (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    sha256 TEXT NOT NULL,
    title TEXT NOT NULL,
    authors TEXT NOT NULL,
    imported_at INTEGER NOT NULL,
    UNIQUE (user_id, sha256)
);

-- +goose Down
DROP TABLE books;
