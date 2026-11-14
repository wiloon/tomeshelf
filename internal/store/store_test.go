package store_test

import (
	"context"
	"database/sql"
	"errors"
	"path/filepath"
	"testing"

	"github.com/wiloon/tomeshelf/internal/store"
)

func openStore(t *testing.T) (*store.Store, string) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "tomeshelf.db")
	st, err := store.Open(context.Background(), path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	return st, path
}

func requireNoSession(t *testing.T, st *store.Store, token string) {
	t.Helper()
	if _, err := st.SessionUser(context.Background(), token); !errors.Is(err, store.ErrNoSession) {
		t.Fatalf("SessionUser err = %v, want ErrNoSession", err)
	}
}

func TestSignInRacingAResetCreatesNoSession(t *testing.T) {
	ctx := context.Background()
	st, _ := openStore(t)
	if _, err := st.CreateAdmin(ctx, "admin", "old-hash"); err != nil {
		t.Fatal(err)
	}

	id, hash, err := st.PasswordHash(ctx, "admin")
	if err != nil {
		t.Fatal(err)
	}
	if err := st.ResetPassword(ctx, "admin", "new-hash"); err != nil {
		t.Fatal(err)
	}
	if _, err := st.CreateSession(ctx, id, hash); !errors.Is(err, store.ErrPasswordChanged) {
		t.Fatalf("CreateSession err = %v, want ErrPasswordChanged", err)
	}
}

func TestResetDeletesASessionCreatedBeforeIt(t *testing.T) {
	ctx := context.Background()
	st, _ := openStore(t)
	if _, err := st.CreateAdmin(ctx, "admin", "old-hash"); err != nil {
		t.Fatal(err)
	}
	id, hash, err := st.PasswordHash(ctx, "admin")
	if err != nil {
		t.Fatal(err)
	}
	sess, err := st.CreateSession(ctx, id, hash)
	if err != nil {
		t.Fatal(err)
	}
	if got, err := st.SessionUser(ctx, sess.Token); err != nil || got != "admin" {
		t.Fatalf("SessionUser before reset = %q, %v; want admin", got, err)
	}

	if err := st.ResetPassword(ctx, "admin", "new-hash"); err != nil {
		t.Fatal(err)
	}
	requireNoSession(t, st, sess.Token)
}

func TestResetBeforeSetupReportsUnknownUserAndSetupStillWorks(t *testing.T) {
	ctx := context.Background()
	st, _ := openStore(t)
	if err := st.ResetPassword(ctx, "admin", "reset-hash"); !errors.Is(err, store.ErrUnknownUser) {
		t.Fatalf("ResetPassword err = %v, want ErrUnknownUser", err)
	}

	sess, err := st.CreateAdmin(ctx, "admin", "setup-hash")
	if err != nil {
		t.Fatal(err)
	}
	if got, err := st.SessionUser(ctx, sess.Token); err != nil || got != "admin" {
		t.Fatalf("SessionUser = %q, %v; want admin", got, err)
	}
	if _, hash, err := st.PasswordHash(ctx, "admin"); err != nil || hash != "setup-hash" {
		t.Fatalf("PasswordHash = %q, %v; want setup-hash", hash, err)
	}
}

func TestResetAfterSetupDeletesSetupSession(t *testing.T) {
	ctx := context.Background()
	st, _ := openStore(t)
	sess, err := st.CreateAdmin(ctx, "admin", "setup-hash")
	if err != nil {
		t.Fatal(err)
	}
	if err := st.ResetPassword(ctx, "admin", "reset-hash"); err != nil {
		t.Fatal(err)
	}
	requireNoSession(t, st, sess.Token)
}

func TestSetupWritesAdminAndSessionInOneTransaction(t *testing.T) {
	ctx := context.Background()
	st, path := openStore(t)
	raw, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	defer raw.Close()
	if _, err := raw.ExecContext(ctx, `CREATE TRIGGER fail_session_insert BEFORE INSERT ON sessions
		BEGIN SELECT RAISE(ABORT, 'session insert fails'); END`); err != nil {
		t.Fatal(err)
	}

	if _, err := st.CreateAdmin(ctx, "admin", "setup-hash"); err == nil {
		t.Fatal("CreateAdmin succeeded although the session insert fails")
	}
	var users int
	if err := raw.QueryRowContext(ctx, "SELECT count(*) FROM users").Scan(&users); err != nil {
		t.Fatal(err)
	}
	if users != 0 {
		t.Fatalf("users = %d after the failed setup, want 0", users)
	}
	if has, err := st.HasUser(ctx); err != nil || has {
		t.Fatalf("HasUser = %v, %v; want false", has, err)
	}
}

func TestSecondAdminIsRefused(t *testing.T) {
	ctx := context.Background()
	st, _ := openStore(t)
	if _, err := st.CreateAdmin(ctx, "admin", "hash"); err != nil {
		t.Fatal(err)
	}
	if _, err := st.CreateAdmin(ctx, "other", "hash"); !errors.Is(err, store.ErrUserExists) {
		t.Fatalf("second CreateAdmin err = %v, want ErrUserExists", err)
	}
}
