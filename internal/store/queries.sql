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
INSERT INTO books (user_id, sha256, title, authors, imported_at)
VALUES ((SELECT id FROM users WHERE username = sqlc.arg(username)), sqlc.arg(sha256), sqlc.arg(title), sqlc.arg(authors), sqlc.arg(imported_at))
ON CONFLICT (user_id, sha256) DO NOTHING
RETURNING id;

-- name: ListBooks :many
SELECT books.id, books.sha256, books.title, books.authors
FROM books JOIN users ON users.id = books.user_id
WHERE users.username = ?
ORDER BY books.title COLLATE NOCASE, books.id;
