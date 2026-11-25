package store_test

import (
	"context"
	"testing"

	"github.com/pressly/goose/v3"

	"github.com/wiloon/tomeshelf/internal/store"
)

func TestClickedMigrationRunsUpAndDown(t *testing.T) {
	_, db := openAtVersion8(t)
	provider, err := goose.NewProvider(goose.DialectSQLite3, db, store.Migrations())
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	if _, err := provider.UpTo(ctx, 11); err != nil {
		t.Fatal(err)
	}
	cols := []string{"clicked_css_selector", "clicked_character_offset", "clicked_text_before", "clicked_text_highlight", "clicked_text_after"}
	for _, col := range cols {
		if _, err := db.Exec("SELECT " + col + " FROM reading_positions"); err != nil {
			t.Errorf("after Up: %v", err)
		}
	}
	if _, err := provider.DownTo(ctx, 10); err != nil {
		t.Fatal(err)
	}
	for _, col := range cols {
		if _, err := db.Exec("SELECT " + col + " FROM reading_positions"); err == nil {
			t.Errorf("column %s still present after Down", col)
		}
	}
}
