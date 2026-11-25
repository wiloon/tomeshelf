-- name: CountUsers :one
SELECT count(*) FROM users;

-- name: InsertFirstUser :one
INSERT INTO users (username, password_hash)
SELECT CAST(sqlc.arg(username) AS TEXT), CAST(sqlc.arg(password_hash) AS TEXT)
WHERE NOT EXISTS (SELECT 1 FROM users)
RETURNING id;

-- name: GetUserByUsername :one
SELECT id, password_hash FROM users WHERE username = ?;

-- name: InsertSession :exec
INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?);

-- name: InsertSessionIfPasswordHash :execrows
INSERT INTO sessions (token_hash, user_id, expires_at)
SELECT CAST(sqlc.arg(token_hash) AS BLOB), id, CAST(sqlc.arg(expires_at) AS INTEGER)
FROM users
WHERE id = sqlc.arg(user_id) AND password_hash = sqlc.arg(password_hash);

-- name: GetSessionUsername :one
SELECT users.username
FROM sessions JOIN users ON users.id = sessions.user_id
WHERE sessions.token_hash = ? AND sessions.expires_at > ?;

-- name: DeleteSession :exec
DELETE FROM sessions WHERE token_hash = ?;

-- name: UpdatePasswordHash :one
UPDATE users SET password_hash = ? WHERE username = ?
RETURNING id;

-- name: DeleteUserSessions :exec
DELETE FROM sessions WHERE user_id = ?;

-- name: InsertBook :one
INSERT INTO books (user_id, id, title, authors, imported_at)
VALUES ((SELECT id FROM users WHERE username = sqlc.arg(username)), sqlc.arg(id), sqlc.arg(title), sqlc.arg(authors), sqlc.arg(imported_at))
ON CONFLICT (user_id, id) DO NOTHING
RETURNING id;

-- name: ListBooks :many
SELECT books.id, books.title, books.authors
FROM books JOIN users ON users.id = books.user_id
WHERE users.username = ?
ORDER BY books.title COLLATE NOCASE, books.id;

-- name: GetBook :one
SELECT books.id, books.title, books.authors, books.imported_at
FROM books JOIN users ON users.id = books.user_id
WHERE users.username = sqlc.arg(username) AND books.id = sqlc.arg(id);

-- name: DeleteBook :one
DELETE FROM books
WHERE books.id = sqlc.arg(id) AND books.user_id = (SELECT users.id FROM users WHERE users.username = sqlc.arg(username))
RETURNING user_id;

-- name: DeleteReadingPosition :exec
DELETE FROM reading_positions WHERE user_id = ? AND book_id = ?;

-- name: DeleteReadingPositionTabs :exec
DELETE FROM reading_position_tabs WHERE user_id = ? AND book_id = ?;

-- name: BookFileNamed :one
SELECT EXISTS (SELECT 1 FROM books WHERE id = ?);

-- name: GetReadingSettings :one
SELECT reading_settings.font_size, reading_settings.line_height, reading_settings.width, reading_settings.theme, reading_settings.layout, reading_settings.font, reading_settings.wheel_turns_pages, reading_settings.repeated_lines
FROM reading_settings JOIN users ON users.id = reading_settings.user_id
WHERE users.username = ?;

-- name: PutReadingSettings :execrows
INSERT INTO reading_settings (user_id, font_size, line_height, width, theme, layout, font, wheel_turns_pages, repeated_lines)
SELECT id, sqlc.arg(font_size), sqlc.arg(line_height), sqlc.arg(width), sqlc.arg(theme), sqlc.arg(layout), sqlc.arg(font), sqlc.arg(wheel_turns_pages), sqlc.arg(repeated_lines)
FROM users WHERE username = sqlc.arg(username)
ON CONFLICT (user_id) DO UPDATE SET
    font_size = excluded.font_size,
    line_height = excluded.line_height,
    width = excluded.width,
    theme = excluded.theme,
    layout = excluded.layout,
    font = excluded.font,
    wheel_turns_pages = excluded.wheel_turns_pages,
    repeated_lines = excluded.repeated_lines;

-- name: GetReadingPosition :one
SELECT reading_positions.href, reading_positions.progression, reading_positions.total_progression,
       reading_positions.css_selector, reading_positions.character_offset,
       reading_positions.text_before, reading_positions.text_highlight, reading_positions.text_after
FROM reading_positions
JOIN users ON users.id = reading_positions.user_id
JOIN books ON books.user_id = reading_positions.user_id AND books.id = reading_positions.book_id
WHERE users.username = sqlc.arg(username) AND reading_positions.book_id = sqlc.arg(book_id);

-- name: UpsertReadingPosition :execrows
INSERT INTO reading_positions (
    user_id, book_id, href, progression, total_progression,
    css_selector, character_offset, text_before, text_highlight, text_after, saved_at
)
SELECT books.user_id, books.id, sqlc.arg(href), sqlc.arg(progression), sqlc.arg(total_progression),
       sqlc.arg(css_selector), sqlc.arg(character_offset),
       sqlc.arg(text_before), sqlc.arg(text_highlight), sqlc.arg(text_after), sqlc.arg(saved_at)
FROM books JOIN users ON users.id = books.user_id
WHERE users.username = sqlc.arg(username) AND books.id = sqlc.arg(book_id)
ON CONFLICT (user_id, book_id) DO UPDATE SET
    href = excluded.href,
    progression = excluded.progression,
    total_progression = excluded.total_progression,
    css_selector = excluded.css_selector,
    character_offset = excluded.character_offset,
    text_before = excluded.text_before,
    text_highlight = excluded.text_highlight,
    text_after = excluded.text_after,
    saved_at = excluded.saved_at;

-- name: GetTabHighestSequence :one
SELECT reading_position_tabs.highest_sequence
FROM reading_position_tabs
JOIN users ON users.id = reading_position_tabs.user_id
JOIN books ON books.user_id = reading_position_tabs.user_id AND books.id = reading_position_tabs.book_id
WHERE users.username = sqlc.arg(username) AND reading_position_tabs.book_id = sqlc.arg(book_id) AND reading_position_tabs.tab_id = sqlc.arg(tab_id);

-- name: UpsertTabHighestSequence :execrows
INSERT INTO reading_position_tabs (user_id, book_id, tab_id, highest_sequence)
SELECT books.user_id, books.id, sqlc.arg(tab_id), sqlc.arg(highest_sequence)
FROM books JOIN users ON users.id = books.user_id
WHERE users.username = sqlc.arg(username) AND books.id = sqlc.arg(book_id)
ON CONFLICT (user_id, book_id, tab_id) DO UPDATE SET
    highest_sequence = excluded.highest_sequence;

-- name: ListBooksWithProgress :many
SELECT books.id, books.title, books.authors, books.imported_at, reading_positions.total_progression, reading_positions.saved_at
FROM books
JOIN users ON users.id = books.user_id
LEFT JOIN reading_positions ON reading_positions.user_id = books.user_id AND reading_positions.book_id = books.id
WHERE users.username = ?
ORDER BY books.title COLLATE NOCASE, books.id;
