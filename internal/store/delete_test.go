package store_test

import (
	"context"
	"database/sql"
	"errors"
	"testing"

	"github.com/wiloon/tomeshelf/internal/store"
)

func TestDeleteBookRemovesPositionAndTabsAtomically(t *testing.T) {
	for _, fail := range []bool{false, true} {
		t.Run(map[bool]string{false: "success", true: "rollback"}[fail], func(t *testing.T) {
			ctx := context.Background()
			st, path := openStore(t)
			if _, err := st.CreateAdmin(ctx, "reader", "hash"); err != nil {
				t.Fatal(err)
			}
			if _, err := st.AddBook(ctx, "reader", store.Book{ID: shaShared, Title: "Book"}); err != nil {
				t.Fatal(err)
			}
			for _, tab := range []string{"tab-a", "tab-b"} {
				if _, err := st.SaveReadingPosition(ctx, "reader", shaShared, tab, 7, store.ReadingPosition{Href: "one.xhtml", Progression: 0.5}); err != nil {
					t.Fatal(err)
				}
			}
			db, err := sql.Open("sqlite", path)
			if err != nil {
				t.Fatal(err)
			}
			defer db.Close()
			if fail {
				mustExec(t, db, `CREATE TRIGGER fail_tab_delete BEFORE DELETE ON reading_position_tabs BEGIN SELECT RAISE(ABORT, 'injected tab deletion failure'); END`)
			}
			err = st.DeleteBook(ctx, "reader", shaShared, false)
			if fail && err == nil {
				t.Fatal("delete succeeded despite failing tab deletion")
			}
			if !fail && err != nil {
				t.Fatal(err)
			}
			want := map[bool]int{false: 0, true: 1}[fail]
			for _, table := range []string{"books", "reading_positions", "reading_position_tabs"} {
				var count int
				if err := db.QueryRow("SELECT count(*) FROM " + table).Scan(&count); err != nil {
					t.Fatal(err)
				}
				expected := want
				if table == "reading_position_tabs" {
					expected *= 2
				}
				if count != expected {
					t.Errorf("%s rows = %d, want %d", table, count, expected)
				}
			}
			if !fail {
				if _, err := st.SaveReadingPosition(ctx, "reader", shaShared, "late-tab", 8, store.ReadingPosition{Href: "one.xhtml"}); !errors.Is(err, store.ErrUnknownBook) {
					t.Errorf("late save error = %v", err)
				}
				for _, table := range []string{"reading_positions", "reading_position_tabs"} {
					var count int
					if err := db.QueryRow("SELECT count(*) FROM " + table).Scan(&count); err != nil {
						t.Fatal(err)
					}
					if count != 0 {
						t.Errorf("late save recreated %s rows", table)
					}
				}
			}
		})
	}
}
