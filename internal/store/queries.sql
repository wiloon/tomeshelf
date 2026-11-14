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
