package store_test

import (
	"context"
	"database/sql"
	"path/filepath"
	"testing"

	"github.com/pressly/goose/v3"
	_ "modernc.org/sqlite"

	"github.com/wiloon/tomeshelf/internal/store"
)

// clickedColumns lists the reading_positions columns whose names start with
// clicked_.
func clickedColumns(t *testing.T, db *sql.DB) []string {
	t.Helper()
	rows, err := db.Query("SELECT name FROM pragma_table_info('reading_positions') WHERE name LIKE 'clicked\\_%' ESCAPE '\\' ORDER BY cid")
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var names []string
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			t.Fatal(err)
		}
		names = append(names, name)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	return names
}

func TestClickedCharacterMigrationRunsUpAndDownKeepingPositions(t *testing.T) {
	ctx := context.Background()
	db, err := sql.Open("sqlite", "file:"+filepath.Join(t.TempDir(), "tomeshelf.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	provider, err := goose.NewProvider(goose.DialectSQLite3, db, store.Migrations())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := provider.UpTo(ctx, 11); err != nil {
		t.Fatal(err)
	}

	want := []string{
		"clicked_css_selector", "clicked_character_offset",
		"clicked_text_before", "clicked_text_highlight", "clicked_text_after",
	}
	if got := clickedColumns(t, db); len(got) != len(want) {
		t.Fatalf("after Up, clicked columns = %v, want %v", got, want)
	}
	mustExec(t, db, "INSERT INTO users (id, username, password_hash) VALUES (1, 'ada', 'h')")
	mustExec(t, db, "INSERT INTO books (user_id, id, title, authors, imported_at) VALUES (1, ?, 'Book', '[]', 1000)", shaOwn)
	mustExec(t, db, `INSERT INTO reading_positions (user_id, book_id, href, progression, total_progression,
		css_selector, character_offset, text_highlight, clicked_css_selector, clicked_character_offset,
		clicked_text_highlight, saved_at)
		VALUES (1, ?, 'a.xhtml', 0.5, 0.25, '[data-tomeshelf-block="1"]', 0, 'start', '[data-tomeshelf-block="2"]', 7, 'clicked', 2000)`, shaOwn)

	if _, err := provider.DownTo(ctx, 10); err != nil {
		t.Fatalf("Down: %v", err)
	}
	if got := clickedColumns(t, db); len(got) != 0 {
		t.Fatalf("after Down, clicked columns = %v, want none", got)
	}
	var href string
	var progression float64
	if err := db.QueryRow("SELECT href, progression FROM reading_positions WHERE book_id = ?", shaOwn).Scan(&href, &progression); err != nil {
		t.Fatalf("the position did not survive Down: %v", err)
	}
	if href != "a.xhtml" || progression != 0.5 {
		t.Errorf("after Down, position = %q %v, want a.xhtml 0.5", href, progression)
	}

	if _, err := provider.UpTo(ctx, 11); err != nil {
		t.Fatalf("Up again: %v", err)
	}
	var clicked sql.NullString
	if err := db.QueryRow("SELECT clicked_text_highlight FROM reading_positions WHERE book_id = ?", shaOwn).Scan(&clicked); err != nil {
		t.Fatal(err)
	}
	if clicked.Valid {
		t.Errorf("after Up again, clicked_text_highlight = %q, want NULL", clicked.String)
	}
}
