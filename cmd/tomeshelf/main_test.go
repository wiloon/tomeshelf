package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/pressly/goose/v3"

	"github.com/wiloon/tomeshelf/internal/store"
)

// start runs the binary's run path on dataDir until the test stops it.
func start(t *testing.T, dataDir string) (string, func()) {
	t.Helper()
	return startWith(t, config{addr: "127.0.0.1:0", dataDir: dataDir, maxBookMB: 200})
}

func startWith(t *testing.T, cfg config) (string, func()) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	listening := make(chan string, 1)
	done := make(chan error, 1)
	go func() {
		done <- run(ctx, cfg, slog.New(slog.DiscardHandler), func(addr string) { listening <- addr })
	}()
	select {
	case addr := <-listening:
		stop := func() {
			cancel()
			if err := <-done; err != nil {
				t.Errorf("run: %v", err)
			}
		}
		t.Cleanup(func() {
			if ctx.Err() == nil {
				stop()
			}
		})
		return "http://" + addr, stop
	case err := <-done:
		cancel()
		t.Fatalf("run stopped before listening: %v", err)
		return "", nil
	}
}

func post(t *testing.T, url, username, pw string) *http.Response {
	t.Helper()
	body, _ := json.Marshal(map[string]string{"username": username, "password": pw})
	res, err := http.Post(url, "application/json", strings.NewReader(string(body)))
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	return res
}

func requireStatus(t *testing.T, res *http.Response, want int) {
	t.Helper()
	if res.StatusCode != want {
		t.Fatalf("%s %s: status = %d, want %d", res.Request.Method, res.Request.URL.Path, res.StatusCode, want)
	}
}

func getMe(t *testing.T, url string, cookies []*http.Cookie) int {
	t.Helper()
	req, err := http.NewRequest(http.MethodGet, url+"/api/me", nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range cookies {
		req.AddCookie(c)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	return res.StatusCode
}

func TestStartupCreatesAWALDatabaseWhoseDataSurvivesARestart(t *testing.T) {
	dataDir := filepath.Join(t.TempDir(), "data", "tomeshelf")
	url, stop := start(t, dataDir)
	requireStatus(t, post(t, url+"/api/setup", "admin", "first password"), http.StatusCreated)
	stop()

	dbPath := filepath.Join(dataDir, "tomeshelf.db")
	if _, err := os.Stat(dbPath); err != nil {
		t.Fatalf("database file: %v", err)
	}
	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	var mode string
	if err := db.QueryRow("PRAGMA journal_mode").Scan(&mode); err != nil {
		t.Fatal(err)
	}
	if mode != "wal" {
		t.Errorf("journal_mode = %q, want wal", mode)
	}
	provider, err := goose.NewProvider(goose.DialectSQLite3, db, store.Migrations())
	if err != nil {
		t.Fatal(err)
	}
	version, err := provider.GetDBVersion(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	sources := provider.ListSources()
	if latest := sources[len(sources)-1].Version; version != latest {
		t.Errorf("database version = %d, want the latest embedded migration %d", version, latest)
	}

	url, _ = start(t, dataDir)
	requireStatus(t, post(t, url+"/api/setup", "other", "other password"), http.StatusConflict)
	requireStatus(t, post(t, url+"/api/session", "admin", "first password"), http.StatusNoContent)
}

func TestStartupFailsOnABrokenDatabase(t *testing.T) {
	dataDir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dataDir, "tomeshelf.db"), []byte("not a database, just text that fills a page header"), 0o600); err != nil {
		t.Fatal(err)
	}
	listened := false
	err := run(context.Background(), config{addr: "127.0.0.1:0", dataDir: dataDir, maxBookMB: 200}, slog.New(slog.DiscardHandler), func(string) { listened = true })
	if err == nil {
		t.Fatal("run succeeded on a broken database")
	}
	if listened {
		t.Error("run listened before the migrations succeeded")
	}
}

func TestTheBookSizeCapComesFromTheFlagOrTheEnvironment(t *testing.T) {
	for name, tc := range map[string]struct {
		args []string
		env  map[string]string
		want int64
	}{
		"default":           {nil, nil, 200},
		"environment":       {nil, map[string]string{"TOMESHELF_MAX_BOOK_MB": "1"}, 1},
		"flag":              {[]string{"-max-book-mb", "3"}, nil, 3},
		"flag over the env": {[]string{"-max-book-mb", "3"}, map[string]string{"TOMESHELF_MAX_BOOK_MB": "1"}, 3},
	} {
		t.Run(name, func(t *testing.T) {
			cfg, err := parseConfig(tc.args, func(key string) (string, bool) {
				v, ok := tc.env[key]
				return v, ok
			})
			if err != nil {
				t.Fatal(err)
			}
			if cfg.maxBookMB != tc.want {
				t.Errorf("maxBookMB = %d, want %d", cfg.maxBookMB, tc.want)
			}
		})
	}
	for _, bad := range []string{"0", "-1", "lots"} {
		if _, err := parseConfig([]string{"-max-book-mb", bad}, func(string) (string, bool) { return "", false }); err == nil {
			t.Errorf("-max-book-mb %s: no error", bad)
		}
		if _, err := parseConfig(nil, func(string) (string, bool) { return bad, true }); err == nil {
			t.Errorf("TOMESHELF_MAX_BOOK_MB=%s: no error", bad)
		}
	}

	cfg, err := parseConfig([]string{"-addr", "127.0.0.1:0", "-data", t.TempDir()}, func(key string) (string, bool) {
		return "1", key == "TOMESHELF_MAX_BOOK_MB"
	})
	if err != nil {
		t.Fatal(err)
	}
	url, _ := startWith(t, cfg)
	setup := post(t, url+"/api/setup", "admin", "a password")
	requireStatus(t, setup, http.StatusCreated)
	upload := func(size int) int {
		req, err := http.NewRequest(http.MethodPost, url+"/api/books", strings.NewReader(strings.Repeat("x", size)))
		if err != nil {
			t.Fatal(err)
		}
		for _, c := range setup.Cookies() {
			req.AddCookie(c)
		}
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
		return res.StatusCode
	}
	if code := upload(1<<20 + 1); code != http.StatusRequestEntityTooLarge {
		t.Errorf("upload of 1 MB + 1 byte = %d, want 413", code)
	}
	if code := upload(1 << 20); code != http.StatusUnprocessableEntity {
		t.Errorf("upload of 1 MB that is no EPUB = %d, want 422", code)
	}
}

func resetPasswordWith(dataDir, user, stdin string) int {
	return resetPassword([]string{"-data", dataDir, "-user", user}, strings.NewReader(stdin), io.Discard)
}

func TestResetPasswordSetsANewPasswordAndEndsSessions(t *testing.T) {
	dataDir := t.TempDir()
	url, _ := start(t, dataDir)
	setup := post(t, url+"/api/setup", "admin", "old password")
	requireStatus(t, setup, http.StatusCreated)
	if code := getMe(t, url, setup.Cookies()); code != http.StatusOK {
		t.Fatalf("/api/me before reset = %d, want 200", code)
	}

	if code := resetPasswordWith(dataDir, "admin", "new password\n"); code != 0 {
		t.Fatalf("reset-password exit code = %d, want 0", code)
	}

	if code := getMe(t, url, setup.Cookies()); code != http.StatusUnauthorized {
		t.Errorf("/api/me with the session from before the reset = %d, want 401", code)
	}
	requireStatus(t, post(t, url+"/api/session", "admin", "old password"), http.StatusUnauthorized)
	requireStatus(t, post(t, url+"/api/session", "admin", "new password"), http.StatusNoContent)
}

func TestResetPasswordRefusesUnknownUsersAndEmptyPasswords(t *testing.T) {
	fresh := filepath.Join(t.TempDir(), "fresh")
	if code := resetPasswordWith(fresh, "admin", "new password\n"); code == 0 {
		t.Error("reset-password on a fresh data directory exited 0, want non-zero for the unknown user")
	}

	dataDir := t.TempDir()
	url, stop := start(t, dataDir)
	requireStatus(t, post(t, url+"/api/setup", "admin", "old password"), http.StatusCreated)
	stop()
	for name, tc := range map[string]struct{ user, stdin string }{
		"unknown user":   {"nobody", "new password\n"},
		"empty password": {"admin", "\n"},
		"no input":       {"admin", ""},
	} {
		if code := resetPasswordWith(dataDir, tc.user, tc.stdin); code == 0 {
			t.Errorf("%s: exit code 0, want non-zero", name)
		}
	}
	url, _ = start(t, dataDir)
	requireStatus(t, post(t, url+"/api/session", "admin", "old password"), http.StatusNoContent)
}
