// Package store keeps tomeshelf's data in SQLite: the embedded schema
// migrations, the users and sessions behind sign-in (ADR-0008, ADR-0009), and
// each user's library, reading settings and reading positions (ADR-0005).
package store

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"embed"
	"encoding/base64"
	"encoding/json"
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
	ErrBookExists      = errors.New("the book is already in the library")
	ErrUnknownBook     = errors.New("no such book in the library")
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
	// Now is the clock for sessions, imports and accepted reading position saves.
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

// Book is one book in a user's library. SHA256 is the hex digest of its
// original EPUB, which names the file (ADR-0007). TotalProgression is set when
// the user has a stored reading position for the book. SavedAt is the Unix
// millisecond time of its last accepted save, absent for pre-migration positions.
type Book struct {
	ID               int64
	SHA256           string
	Title            string
	Authors          []string
	TotalProgression *float64
	SavedAt          *int64
}

// AddBook adds the book to the user's library and returns it with its id. It
// returns ErrBookExists, and changes nothing, when the user's library already
// has a book with the same SHA256.
func (s *Store) AddBook(ctx context.Context, username string, b Book) (Book, error) {
	if b.Authors == nil {
		b.Authors = []string{}
	}
	authors, err := json.Marshal(b.Authors)
	if err != nil {
		return Book{}, err
	}
	id, err := s.q.InsertBook(ctx, dbq.InsertBookParams{
		Username:   username,
		Sha256:     b.SHA256,
		Title:      b.Title,
		Authors:    string(authors),
		ImportedAt: s.Now().Unix(),
	})
	if errors.Is(err, sql.ErrNoRows) {
		return Book{}, ErrBookExists
	}
	if err != nil {
		return Book{}, err
	}
	b.ID = id
	return b, nil
}

// Books returns the user's library, ordered by title, with each book's
// stored total progression when the user has one.
func (s *Store) Books(ctx context.Context, username string) ([]Book, error) {
	rows, err := s.q.ListBooksWithProgress(ctx, username)
	if err != nil {
		return nil, err
	}
	books := make([]Book, 0, len(rows))
	for _, row := range rows {
		b := Book{ID: row.ID, SHA256: row.Sha256, Title: row.Title}
		if err := json.Unmarshal([]byte(row.Authors), &b.Authors); err != nil {
			return nil, fmt.Errorf("book %d authors: %w", row.ID, err)
		}
		if row.TotalProgression.Valid {
			tp := row.TotalProgression.Float64
			b.TotalProgression = &tp
		}
		if row.SavedAt.Valid {
			savedAt := row.SavedAt.Int64
			b.SavedAt = &savedAt
		}
		books = append(books, b)
	}
	return books, nil
}

// Book returns the book with the id in the user's library, or ErrUnknownBook
// when the user's library has no such book.
func (s *Store) Book(ctx context.Context, username string, id int64) (Book, error) {
	row, err := s.q.GetBook(ctx, dbq.GetBookParams{Username: username, ID: id})
	if errors.Is(err, sql.ErrNoRows) {
		return Book{}, ErrUnknownBook
	}
	if err != nil {
		return Book{}, err
	}
	b := Book{ID: row.ID, SHA256: row.Sha256, Title: row.Title}
	if err := json.Unmarshal([]byte(row.Authors), &b.Authors); err != nil {
		return Book{}, fmt.Errorf("book %d authors: %w", row.ID, err)
	}
	return b, nil
}

// DeleteBook deletes the book with the id from the user's library and
// returns its SHA256. It returns ErrUnknownBook, and changes nothing, when
// the user's library has no such book.
func (s *Store) DeleteBook(ctx context.Context, username string, id int64) (string, error) {
	sum, err := s.q.DeleteBook(ctx, dbq.DeleteBookParams{ID: id, Username: username})
	if errors.Is(err, sql.ErrNoRows) {
		return "", ErrUnknownBook
	}
	return sum, err
}

// BookFileNamed reports whether any user's library has a book whose original
// has the SHA256.
func (s *Store) BookFileNamed(ctx context.Context, sha256 string) (bool, error) {
	return s.q.BookFileNamed(ctx, sha256)
}

// ReadingSettings are a user's saved reading settings. The server checks them
// against the settings contract before they are saved.
type ReadingSettings struct {
	FontSize   int64
	LineHeight float64
	Width      int64
	Theme      string
	Layout     string
	Font       string
}

// ReadingSettings returns the user's saved reading settings, and false when
// the user has saved none.
func (s *Store) ReadingSettings(ctx context.Context, username string) (ReadingSettings, bool, error) {
	row, err := s.q.GetReadingSettings(ctx, username)
	if errors.Is(err, sql.ErrNoRows) {
		return ReadingSettings{}, false, nil
	}
	if err != nil {
		return ReadingSettings{}, false, err
	}
	return ReadingSettings(row), true, nil
}

// SaveReadingSettings replaces the user's saved reading settings. It returns
// ErrUnknownUser when no such user exists.
func (s *Store) SaveReadingSettings(ctx context.Context, username string, rs ReadingSettings) error {
	n, err := s.q.PutReadingSettings(ctx, dbq.PutReadingSettingsParams{
		FontSize:   rs.FontSize,
		LineHeight: rs.LineHeight,
		Width:      rs.Width,
		Theme:      rs.Theme,
		Layout:     rs.Layout,
		Font:       rs.Font,
		Username:   username,
	})
	if err != nil {
		return err
	}
	if n == 0 {
		return ErrUnknownUser
	}
	return nil
}

// ReadingPosition is a user's stored reading position for one book, shaped as
// the fields of a Readium Locator (ADR-0005). Optional fields are nil when
// missing: no block, no quote, or progressions alone.
type ReadingPosition struct {
	Href             string
	Progression      float64
	TotalProgression float64
	CSSSelector      *string
	CharacterOffset  *int64
	TextBefore       *string
	TextHighlight    *string
	TextAfter        *string
}

// ReadingPosition returns the user's stored position for the book, or
// ErrUnknownBook when the user's library has no such book or no position.
func (s *Store) ReadingPosition(ctx context.Context, username string, bookID int64) (ReadingPosition, error) {
	row, err := s.q.GetReadingPosition(ctx, dbq.GetReadingPositionParams{Username: username, ID: bookID})
	if errors.Is(err, sql.ErrNoRows) {
		return ReadingPosition{}, ErrUnknownBook
	}
	if err != nil {
		return ReadingPosition{}, err
	}
	return readingPositionFromRow(row), nil
}

func readingPositionFromRow(row dbq.GetReadingPositionRow) ReadingPosition {
	p := ReadingPosition{
		Href:             row.Href,
		Progression:      row.Progression,
		TotalProgression: row.TotalProgression,
	}
	if row.CssSelector.Valid {
		p.CSSSelector = &row.CssSelector.String
	}
	if row.CharacterOffset.Valid {
		p.CharacterOffset = &row.CharacterOffset.Int64
	}
	if row.TextBefore.Valid {
		p.TextBefore = &row.TextBefore.String
	}
	if row.TextHighlight.Valid {
		p.TextHighlight = &row.TextHighlight.String
	}
	if row.TextAfter.Valid {
		p.TextAfter = &row.TextAfter.String
	}
	return p
}

// SaveReadingPositionResult is whether a save was stored or ignored as stale
// for its tab.
type SaveReadingPositionResult int

const (
	PositionSaved SaveReadingPositionResult = iota
	PositionIgnored
)

// SaveReadingPosition stores the position when sequence is newer than the
// tab's highest accepted sequence, and records that sequence. An equal or
// older sequence is ignored and the stored position is left as it is.
// ErrUnknownBook means the user's library has no such book.
func (s *Store) SaveReadingPosition(ctx context.Context, username string, bookID int64, tabID string, sequence int64, p ReadingPosition) (SaveReadingPositionResult, error) {
	var result SaveReadingPositionResult
	err := s.inTx(ctx, func(q *dbq.Queries) error {
		if _, err := q.GetBook(ctx, dbq.GetBookParams{Username: username, ID: bookID}); err != nil {
			if errors.Is(err, sql.ErrNoRows) {
				return ErrUnknownBook
			}
			return err
		}
		highest, err := q.GetTabHighestSequence(ctx, dbq.GetTabHighestSequenceParams{
			Username: username,
			ID:       bookID,
			TabID:    tabID,
		})
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			return err
		}
		if err == nil && sequence <= highest {
			result = PositionIgnored
			return nil
		}
		n, err := q.UpsertReadingPosition(ctx, dbq.UpsertReadingPositionParams{
			SavedAt:          sql.NullInt64{Int64: s.Now().UnixMilli(), Valid: true},
			Href:             p.Href,
			Progression:      p.Progression,
			TotalProgression: p.TotalProgression,
			CssSelector:      nullString(p.CSSSelector),
			CharacterOffset:  nullInt64(p.CharacterOffset),
			TextBefore:       nullString(p.TextBefore),
			TextHighlight:    nullString(p.TextHighlight),
			TextAfter:        nullString(p.TextAfter),
			Username:         username,
			BookID:           bookID,
		})
		if err != nil {
			return err
		}
		if n == 0 {
			return ErrUnknownBook
		}
		if _, err := q.UpsertTabHighestSequence(ctx, dbq.UpsertTabHighestSequenceParams{
			TabID:           tabID,
			HighestSequence: sequence,
			Username:        username,
			BookID:          bookID,
		}); err != nil {
			return err
		}
		result = PositionSaved
		return nil
	})
	return result, err
}

func nullString(s *string) sql.NullString {
	if s == nil {
		return sql.NullString{}
	}
	return sql.NullString{String: *s, Valid: true}
}

func nullInt64(n *int64) sql.NullInt64 {
	if n == nil {
		return sql.NullInt64{}
	}
	return sql.NullInt64{Int64: *n, Valid: true}
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
