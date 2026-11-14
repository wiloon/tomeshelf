package server

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"sync"

	"github.com/wiloon/tomeshelf/internal/password"
	"github.com/wiloon/tomeshelf/internal/store"
)

const sessionCookieName = "tomeshelf_session"

// Accounts is the user and session storage the handler signs users in with.
// *store.Store implements it.
type Accounts interface {
	HasUser(ctx context.Context) (bool, error)
	CreateAdmin(ctx context.Context, username, passwordHash string) (store.Session, error)
	PasswordHash(ctx context.Context, username string) (int64, string, error)
	CreateSession(ctx context.Context, userID int64, passwordHash string) (store.Session, error)
	SessionUser(ctx context.Context, token string) (string, error)
	DeleteSession(ctx context.Context, token string) error
}

// unknownUserHash is verified against when the username is unknown, so that
// answer takes as long as a wrong password.
var unknownUserHash = sync.OnceValue(func() string {
	hash, err := password.Hash("unknown user")
	if err != nil {
		panic(err)
	}
	return hash
})

type credentials struct {
	Username string `json:"username"`
	Password string `json:"password"`
}

type userJSON struct {
	Username string `json:"username"`
}

// setup creates the admin and signs it in, while no user exists.
func (s *site) setup(w http.ResponseWriter, r *http.Request) {
	creds, ok := readCredentials(w, r)
	if !ok {
		return
	}
	hasUser, err := s.accounts.HasUser(r.Context())
	if err != nil {
		s.apiError(w, err)
		return
	}
	if hasUser {
		writeError(w, http.StatusConflict, "setup has already run")
		return
	}
	hash, err := password.Hash(creds.Password)
	if err != nil {
		s.apiError(w, err)
		return
	}
	sess, err := s.accounts.CreateAdmin(r.Context(), creds.Username, hash)
	if errors.Is(err, store.ErrUserExists) {
		writeError(w, http.StatusConflict, "setup has already run")
		return
	}
	if err != nil {
		s.apiError(w, err)
		return
	}
	setSessionCookie(w, r, sess)
	writeJSON(w, http.StatusCreated, userJSON{Username: creds.Username})
}

// signIn starts a session for the right username and password.
func (s *site) signIn(w http.ResponseWriter, r *http.Request) {
	creds, ok := readCredentials(w, r)
	if !ok {
		return
	}
	id, hash, err := s.accounts.PasswordHash(r.Context(), creds.Username)
	if errors.Is(err, store.ErrUnknownUser) {
		password.Verify(creds.Password, unknownUserHash())
		writeError(w, http.StatusUnauthorized, "wrong username or password")
		return
	}
	if err != nil {
		s.apiError(w, err)
		return
	}
	if !password.Verify(creds.Password, hash) {
		writeError(w, http.StatusUnauthorized, "wrong username or password")
		return
	}
	sess, err := s.accounts.CreateSession(r.Context(), id, hash)
	if errors.Is(err, store.ErrPasswordChanged) {
		writeError(w, http.StatusUnauthorized, "wrong username or password")
		return
	}
	if err != nil {
		s.apiError(w, err)
		return
	}
	setSessionCookie(w, r, sess)
	w.WriteHeader(http.StatusNoContent)
}

// signOut deletes the request's session, if it has one.
func (s *site) signOut(w http.ResponseWriter, r *http.Request) {
	if c, err := r.Cookie(sessionCookieName); err == nil {
		if err := s.accounts.DeleteSession(r.Context(), c.Value); err != nil {
			s.apiError(w, err)
			return
		}
	}
	http.SetCookie(w, &http.Cookie{
		Name:     sessionCookieName,
		Path:     "/",
		MaxAge:   -1,
		HttpOnly: true,
		Secure:   isHTTPS(r),
		SameSite: http.SameSiteLaxMode,
	})
	w.WriteHeader(http.StatusNoContent)
}

func (s *site) me(w http.ResponseWriter, r *http.Request) {
	user, err := s.sessionUser(r)
	if err != nil {
		s.apiError(w, err)
		return
	}
	if user == "" {
		writeError(w, http.StatusUnauthorized, "not signed in")
		return
	}
	writeJSON(w, http.StatusOK, userJSON{Username: user})
}

// apiNotFound answers API paths no route handles: 401 when signed out, so
// the API reveals nothing without a session, and 404 when signed in.
func (s *site) apiNotFound(w http.ResponseWriter, r *http.Request) {
	user, err := s.sessionUser(r)
	if err != nil {
		s.apiError(w, err)
		return
	}
	if user == "" {
		writeError(w, http.StatusUnauthorized, "not signed in")
		return
	}
	writeError(w, http.StatusNotFound, "not found")
}

// sessionUser returns the signed-in username, or "" without a valid session.
func (s *site) sessionUser(r *http.Request) (string, error) {
	c, err := r.Cookie(sessionCookieName)
	if err != nil {
		return "", nil
	}
	user, err := s.accounts.SessionUser(r.Context(), c.Value)
	if errors.Is(err, store.ErrNoSession) {
		return "", nil
	}
	return user, err
}

func (s *site) apiError(w http.ResponseWriter, err error) {
	s.logger.Error("request failed", "err", err)
	writeError(w, http.StatusInternalServerError, "internal server error")
}

func readCredentials(w http.ResponseWriter, r *http.Request) (credentials, bool) {
	var creds credentials
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10)).Decode(&creds); err != nil {
		writeError(w, http.StatusBadRequest, "the body must be a JSON object with username and password")
		return creds, false
	}
	if creds.Username == "" || creds.Password == "" {
		writeError(w, http.StatusBadRequest, "username and password must not be empty")
		return creds, false
	}
	return creds, true
}

func setSessionCookie(w http.ResponseWriter, r *http.Request, sess store.Session) {
	http.SetCookie(w, &http.Cookie{
		Name:     sessionCookieName,
		Value:    sess.Token,
		Path:     "/",
		Expires:  sess.Expires,
		HttpOnly: true,
		Secure:   isHTTPS(r),
		SameSite: http.SameSiteLaxMode,
	})
}

// isHTTPS reports whether the request came over TLS, directly or through an
// HTTPS reverse proxy. A spoofed header can only make the cookie Secure.
func isHTTPS(r *http.Request) bool {
	return r.TLS != nil || strings.EqualFold(r.Header.Get("X-Forwarded-Proto"), "https")
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}
