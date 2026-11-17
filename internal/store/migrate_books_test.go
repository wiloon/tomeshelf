package store_test

import (
	"context"
	"database/sql"
	"net/url"
	"path/filepath"
	"strings"
	"testing"

	"github.com/pressly/goose/v3"
	_ "modernc.org/sqlite"

	"github.com/wiloon/tomeshelf/internal/store"
)

const (
	shaShared = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	shaOwn    = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
)

// openAtVersion8 creates a database file at the version before ADR-0015, with
// foreign keys enforced as the server does.
func openAtVersion8(t *testing.T) (string, *sql.DB) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "tomeshelf.db")
	q := url.Values{}
	q.Add("_pragma", "foreign_keys(1)")
	db, err := sql.Open("sqlite", "file:"+path+"?"+q.Encode())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	provider, err := goose.NewProvider(goose.DialectSQLite3, db, store.Migrations())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := provider.UpTo(context.Background(), 8); err != nil {
		t.Fatal(err)
	}
	return path, db
}

func mustExec(t *testing.T, db *sql.DB, query string, args ...any) {
	t.Helper()
	if _, err := db.Exec(query, args...); err != nil {
		t.Fatalf("%s: %v", query, err)
	}
}

func TestMigrationConvertsBookIDsToSHA256AndCarriesPositionsOver(t *testing.T) {
	ctx := context.Background()
	path, db := openAtVersion8(t)
	mustExec(t, db, "INSERT INTO users (id, username, password_hash) VALUES (1, 'ada', 'h'), (2, 'bob', 'h')")
	// Ada: book 1 (shared file) and book 2. Bob: book 3 (shared file).
	mustExec(t, db, `INSERT INTO books (id, user_id, sha256, title, authors, imported_at) VALUES
		(1, 1, ?, 'Shared', '["A"]', 1000),
		(2, 1, ?, 'Own', '[]', 2000),
		(3, 2, ?, 'Shared', '["A"]', 3000)`, shaShared, shaOwn, shaShared)
	mustExec(t, db, `INSERT INTO reading_positions (book_id, href, progression, total_progression, css_selector, character_offset, saved_at)
		VALUES (1, 'a.xhtml', 0.5, 0.25, 'p', 7, 1700000000123), (3, 'b.xhtml', 0.9, 0.8, NULL, NULL, NULL)`)
	mustExec(t, db, `INSERT INTO reading_position_tabs (book_id, tab_id, highest_sequence)
		VALUES (1, 'tab-a', 4), (1, 'tab-b', 2), (3, 'tab-a', 9)`)
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}

	st, err := store.Open(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })

	ada, err := st.Books(ctx, "ada")
	if err != nil {
		t.Fatal(err)
	}
	if len(ada) != 2 || ada[0].ID != shaOwn || ada[0].Title != "Own" || ada[0].ImportedAt != 2000 ||
		ada[1].ID != shaShared || ada[1].Title != "Shared" || ada[1].ImportedAt != 1000 || ada[1].Authors[0] != "A" {
		t.Fatalf("ada's library = %+v", ada)
	}
	if ada[0].TotalProgression != nil || ada[1].TotalProgression == nil || *ada[1].TotalProgression != 0.25 ||
		ada[1].SavedAt == nil || *ada[1].SavedAt != 1700000000123 {
		t.Errorf("ada's progress = %+v", ada)
	}
	bob, err := st.Books(ctx, "bob")
	if err != nil || len(bob) != 1 || bob[0].ID != shaShared || bob[0].TotalProgression == nil || *bob[0].TotalProgression != 0.8 || bob[0].SavedAt != nil {
		t.Fatalf("bob's library = %+v, err %v", bob, err)
	}
	pos, err := st.ReadingPosition(ctx, "ada", shaShared)
	if err != nil || pos.Href != "a.xhtml" || pos.Progression != 0.5 || pos.CSSSelector == nil || *pos.CSSSelector != "p" || *pos.CharacterOffset != 7 {
		t.Fatalf("ada's position = %+v, err %v", pos, err)
	}

	// Tab sequences were carried over: an old sequence is ignored, a newer one stored.
	res, err := st.SaveReadingPosition(ctx, "ada", shaShared, "tab-a", 4, store.ReadingPosition{Href: "z.xhtml"})
	if err != nil || res != store.PositionIgnored {
		t.Errorf("save with sequence 4 = %v, %v, want ignored", res, err)
	}
	res, err = st.SaveReadingPosition(ctx, "ada", shaShared, "tab-b", 3, store.ReadingPosition{Href: "z.xhtml"})
	if err != nil || res != store.PositionSaved {
		t.Errorf("save with sequence 3 = %v, %v, want saved", res, err)
	}
	res, err = st.SaveReadingPosition(ctx, "bob", shaShared, "tab-a", 9, store.ReadingPosition{Href: "z.xhtml"})
	if err != nil || res != store.PositionIgnored {
		t.Errorf("bob's save with sequence 9 = %v, %v, want ignored", res, err)
	}

	check, err := sql.Open("sqlite", "file:"+path)
	if err != nil {
		t.Fatal(err)
	}
	defer check.Close()
	rows, err := check.Query("PRAGMA foreign_key_check")
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	if rows.Next() {
		t.Error("PRAGMA foreign_key_check reported a violation")
	}
}

func TestMigrationWithAnUnconvertibleBookFailsLeavesTheDatabaseAndNamesTheRecovery(t *testing.T) {
	ctx := context.Background()
	for name, sha := range map[string]string{
		"uppercase": strings.ToUpper(shaOwn),
		"short":     shaOwn[:63],
		"non-hex":   strings.Repeat("g", 64),
	} {
		t.Run(name, func(t *testing.T) {
			path, db := openAtVersion8(t)
			mustExec(t, db, "INSERT INTO users (id, username, password_hash) VALUES (1, 'ada', 'h')")
			mustExec(t, db, "INSERT INTO books (id, user_id, sha256, title, authors, imported_at) VALUES (1, 1, ?, 'Good', '[]', 1), (2, 1, ?, 'Bad', '[]', 2)", shaShared, sha)
			mustExec(t, db, "INSERT INTO reading_positions (book_id, href, progression, total_progression) VALUES (2, 'a', 0.1, 0.1)")
			if err := db.Close(); err != nil {
				t.Fatal(err)
			}

			_, err := store.Open(ctx, path)
			if err == nil {
				t.Fatal("Open succeeded, want a migration error")
			}
			for _, want := range []string{"SHA-256", "delete the books and reading positions", "import"} {
				if !strings.Contains(err.Error(), want) {
					t.Errorf("error %q does not mention %q", err, want)
				}
			}

			after, err := sql.Open("sqlite", "file:"+path)
			if err != nil {
				t.Fatal(err)
			}
			defer after.Close()
			var version int
			if err := after.QueryRow("SELECT max(version_id) FROM goose_db_version").Scan(&version); err != nil || version != 8 {
				t.Errorf("version = %d, err %v, want 8", version, err)
			}
			var books, positions int
			if err := after.QueryRow("SELECT (SELECT count(*) FROM books WHERE id IN (1, 2) AND sha256 <> ''), (SELECT count(*) FROM reading_positions WHERE book_id = 2)").Scan(&books, &positions); err != nil {
				t.Fatalf("the previous schema is gone: %v", err)
			}
			if books != 2 || positions != 1 {
				t.Errorf("books = %d, positions = %d, want 2 and 1 unchanged", books, positions)
			}
		})
	}
}
