// Package store keeps tomeshelf's data in SQLite: the embedded schema
// migrations, and the users and sessions behind sign-in (ADR-0008, ADR-0009).
package store

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"embed"
	"encoding/base64"
	"errors"
	"fmt"
	"io/fs"
	"net/url"
	"time"

	"github.com/pressly/goose/v3"
	_ "modernc.org/sqlite"

	"github.com/wiloon/tomeshelf/internal/store/dbq"
)

// SessionLifetime is how long a session lasts after sign-in or setup.
const SessionLifetime = 30 * 24 * time.Hour

var (
	ErrUserExists      = errors.New("a user already exists")
	ErrUnknownUser     = errors.New("unknown user")
	ErrPasswordChanged = errors.New("the password changed after it was read")
	ErrNoSession       = errors.New("no valid session")
)

//go:embed migrations/*.sql
var migrations embed.FS

// Migrations returns the embedded goose migrations.
func Migrations() fs.FS {
	sub, err := fs.Sub(migrations, "migrations")
	if err != nil {
		panic(err)
	}
	return sub
}

// Store is the database. Its methods are safe for concurrent use.
type Store struct {
	db *sql.DB
	q  *dbq.Queries
	// Now is the clock sessions are created and checked against.
	Now func() time.Time
}

// Session is a signed-in session. Token goes in the cookie; the database keeps
// only its hash.
type Session struct {
	Token   string
	Expires time.Time
}

// Open opens the database at path in WAL mode, creating it if missing, and
// applies the embedded migrations.
func Open(ctx context.Context, path string) (*Store, error) {
	q := url.Values{}
	q.Add("_pragma", "journal_mode(WAL)")
	q.Add("_pragma", "busy_timeout(10000)")
	q.Add("_pragma", "foreign_keys(1)")
	q.Set("_txlock", "immediate")
	u := url.URL{Scheme: "file", Opaque: (&url.URL{Path: path}).EscapedPath(), RawQuery: q.Encode()}
	db, err := sql.Open("sqlite", u.String())
	if err != nil {
		return nil, err
	}
	if err := migrate(ctx, db); err != nil {
		_ = db.Close()
		return nil, err
	}
	return &Store{db: db, q: dbq.New(db), Now: time.Now}, nil
}

func migrate(ctx context.Context, db *sql.DB) error {
	provider, err := goose.NewProvider(goose.DialectSQLite3, db, Migrations())
	if err != nil {
		return fmt.Errorf("migrations: %w", err)
	}
	if _, err := provider.Up(ctx); err != nil {
		return fmt.Errorf("migrations: %w", err)
	}
	return nil
}

// Close closes the database.
func (s *Store) Close() error {
	return s.db.Close()
}

// HasUser reports whether any user exists, that is, whether setup has run.
func (s *Store) HasUser(ctx context.Context) (bool, error) {
	n, err := s.q.CountUsers(ctx)
	return n > 0, err
}

// CreateAdmin creates the first user and a session for it in one
// transaction, so a password reset cannot run between them. It returns
// ErrUserExists, and changes nothing, once any user exists.
func (s *Store) CreateAdmin(ctx context.Context, username, passwordHash string) (Session, error) {
	sess, tokenHash, err := s.newSession()
	if err != nil {
		return Session{}, err
	}
	err = s.inTx(ctx, func(q *dbq.Queries) error {
		id, err := q.InsertFirstUser(ctx, dbq.InsertFirstUserParams{Username: username, PasswordHash: passwordHash})
		if errors.Is(err, sql.ErrNoRows) {
			return ErrUserExists
		}
		if err != nil {
			return err
		}
		return q.InsertSession(ctx, dbq.InsertSessionParams{TokenHash: tokenHash, UserID: id, ExpiresAt: sess.Expires.Unix()})
	})
	if err != nil {
		return Session{}, err
	}
	return sess, nil
}

// PasswordHash returns the user's id and stored password hash, or
// ErrUnknownUser.
func (s *Store) PasswordHash(ctx context.Context, username string) (int64, string, error) {
	row, err := s.q.GetUserByUsername(ctx, username)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, "", ErrUnknownUser
	}
	return row.ID, row.PasswordHash, err
}

// CreateSession starts a session for the user whose password was verified
// against passwordHash. The insert happens only while the stored hash still
// equals passwordHash; when a reset changed it in between, CreateSession
// returns ErrPasswordChanged and creates nothing.
func (s *Store) CreateSession(ctx context.Context, userID int64, passwordHash string) (Session, error) {
	sess, tokenHash, err := s.newSession()
	if err != nil {
		return Session{}, err
	}
	n, err := s.q.InsertSessionIfPasswordHash(ctx, dbq.InsertSessionIfPasswordHashParams{
		TokenHash:    tokenHash,
		ExpiresAt:    sess.Expires.Unix(),
		UserID:       userID,
		PasswordHash: passwordHash,
	})
	if err != nil {
		return Session{}, err
	}
	if n == 0 {
		return Session{}, ErrPasswordChanged
	}
	return sess, nil
}

// SessionUser returns the username a session token belongs to, or
// ErrNoSession when the token is unknown or its session has expired.
func (s *Store) SessionUser(ctx context.Context, token string) (string, error) {
	username, err := s.q.GetSessionUsername(ctx, dbq.GetSessionUsernameParams{
		TokenHash: hashToken(token),
		ExpiresAt: s.Now().Unix(),
	})
	if errors.Is(err, sql.ErrNoRows) {
		return "", ErrNoSession
	}
	return username, err
}

// DeleteSession ends a session. Deleting an unknown token is not an error.
func (s *Store) DeleteSession(ctx context.Context, token string) error {
	return s.q.DeleteSession(ctx, hashToken(token))
}

// ResetPassword stores a new password hash for the user and deletes all of
// the user's sessions, in one transaction. It returns ErrUnknownUser when no
// such user exists.
func (s *Store) ResetPassword(ctx context.Context, username, passwordHash string) error {
	return s.inTx(ctx, func(q *dbq.Queries) error {
		id, err := q.UpdatePasswordHash(ctx, dbq.UpdatePasswordHashParams{PasswordHash: passwordHash, Username: username})
		if errors.Is(err, sql.ErrNoRows) {
			return ErrUnknownUser
		}
		if err != nil {
			return err
		}
		return q.DeleteUserSessions(ctx, id)
	})
}

func (s *Store) inTx(ctx context.Context, fn func(*dbq.Queries) error) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	if err := fn(s.q.WithTx(tx)); err != nil {
		_ = tx.Rollback()
		return err
	}
	return tx.Commit()
}

func (s *Store) newSession() (Session, []byte, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return Session{}, nil, err
	}
	token := base64.RawURLEncoding.EncodeToString(b)
	return Session{Token: token, Expires: s.Now().Add(SessionLifetime)}, hashToken(token), nil
}

func hashToken(token string) []byte {
	sum := sha256.Sum256([]byte(token))
	return sum[:]
}
