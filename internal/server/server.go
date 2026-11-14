// Package server builds the HTTP handler the tomeshelf binary serves.
package server

import (
	"errors"
	"io/fs"
	"log/slog"
	"net/http"
	"path"
	"strings"

	"github.com/wiloon/tomeshelf/internal/library"
)

// contentSecurityPolicy is the app's CSP baseline (ADR-0004). script-src must
// stay exactly 'self', and there must be no script-src-elem or script-src-attr
// directive, so inline and third-party scripts stay blocked. Trusted Types
// guard every script sink, and only the Navigator's policy may create
// TrustedHTML.
const contentSecurityPolicy = "default-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; require-trusted-types-for 'script'; trusted-types tomeshelf"

const indexHTML = "index.html"

// New returns the handler for the health endpoints, the sign-in API and the
// browser app, whose static build is read from build. Everything outside the
// health endpoints, the build's files, the setup and sign-in pages and their
// API needs a signed-in session. Cross-origin browser requests that change
// state are rejected. Reading settings are kept in settings. Imported books go
// into books, and an EPUB upload over maxBookBytes is refused.
func New(build fs.FS, logger *slog.Logger, accounts Accounts, settings Settings, books *library.Library, maxBookBytes int64) http.Handler {
	s := &site{build: build, logger: logger, accounts: accounts, settings: settings, books: books, maxBookBytes: maxBookBytes}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		writeText(w, http.StatusOK, "ok")
	})
	mux.HandleFunc("GET /readyz", func(w http.ResponseWriter, _ *http.Request) {
		if _, err := fs.Stat(build, indexHTML); err != nil {
			writeText(w, http.StatusServiceUnavailable, "browser app build has no index.html")
			return
		}
		writeText(w, http.StatusOK, "ok")
	})
	mux.HandleFunc("POST /api/setup", s.setup)
	mux.HandleFunc("POST /api/session", s.signIn)
	mux.HandleFunc("DELETE /api/session", s.signOut)
	mux.HandleFunc("GET /api/me", s.me)
	mux.HandleFunc("GET /api/settings", s.getSettings)
	mux.HandleFunc("PUT /api/settings", s.putSettings)
	mux.HandleFunc("GET /api/books", s.listBooks)
	mux.HandleFunc("POST /api/books", s.importBook)
	mux.HandleFunc("GET /api/books/{id}/thumbnail", s.thumbnail)
	mux.HandleFunc("GET /api/books/{id}/manifest", s.manifest)
	mux.HandleFunc("GET /api/books/{id}/package/{path...}", s.packageFile)
	mux.HandleFunc("/api/", s.apiNotFound)
	mux.HandleFunc("GET /setup", s.setupPage)
	mux.HandleFunc("GET /signin", s.signInPage)
	mux.HandleFunc("/", s.page)
	return http.NewCrossOriginProtection().Handler(s.unredirectedAPI(mux))
}

// unredirectedAPI answers an API path holding dot segments or repeated
// slashes as unknown, where mux would redirect it to its cleaned form, so a
// package path cannot step out of its book.
func (s *site) unredirectedAPI(mux *http.ServeMux) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p := r.URL.Path
		clean := path.Clean(p)
		if strings.HasSuffix(p, "/") && clean != "/" {
			clean += "/"
		}
		if strings.HasPrefix(p, "/api/") && clean != p {
			s.apiNotFound(w, r)
			return
		}
		mux.ServeHTTP(w, r)
	})
}

type site struct {
	build        fs.FS
	logger       *slog.Logger
	accounts     Accounts
	settings     Settings
	books        *library.Library
	maxBookBytes int64
}

// page serves a file from the build to anyone. A path that names no file is a
// page: signed in, it gets index.html so the client router handles it;
// signed out, it is sent to setup or sign-in. Asset paths that name no file
// 404.
func (s *site) page(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.Header().Set("Allow", "GET, HEAD")
		writeText(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	setPageHeaders(w)

	name := strings.TrimPrefix(path.Clean(r.URL.Path), "/")
	if name != "" && name != indexHTML {
		info, err := fs.Stat(s.build, name)
		if err == nil && !info.IsDir() {
			http.ServeFileFS(w, r, s.build, name)
			return
		}
		if isAssetPath(name) {
			http.NotFound(w, r)
			return
		}
	}

	user, err := s.sessionUser(r)
	if err != nil {
		s.internalError(w, err)
		return
	}
	if user == "" {
		s.redirectSignedOut(w, r)
		return
	}
	s.shell(w)
}

// setupPage serves the setup form until a user exists.
func (s *site) setupPage(w http.ResponseWriter, r *http.Request) {
	setPageHeaders(w)
	hasUser, err := s.accounts.HasUser(r.Context())
	if err != nil {
		s.internalError(w, err)
		return
	}
	if !hasUser {
		s.shell(w)
		return
	}
	user, err := s.sessionUser(r)
	if err != nil {
		s.internalError(w, err)
		return
	}
	if user != "" {
		http.Redirect(w, r, "/", http.StatusSeeOther)
		return
	}
	http.Redirect(w, r, "/signin", http.StatusSeeOther)
}

// signInPage serves the sign-in form to a signed-out user.
func (s *site) signInPage(w http.ResponseWriter, r *http.Request) {
	setPageHeaders(w)
	user, err := s.sessionUser(r)
	if err != nil {
		s.internalError(w, err)
		return
	}
	if user != "" {
		http.Redirect(w, r, "/", http.StatusSeeOther)
		return
	}
	s.shell(w)
}

func (s *site) redirectSignedOut(w http.ResponseWriter, r *http.Request) {
	hasUser, err := s.accounts.HasUser(r.Context())
	if err != nil {
		s.internalError(w, err)
		return
	}
	if !hasUser {
		http.Redirect(w, r, "/setup", http.StatusSeeOther)
		return
	}
	http.Redirect(w, r, "/signin", http.StatusSeeOther)
}

func (s *site) shell(w http.ResponseWriter) {
	page, err := fs.ReadFile(s.build, indexHTML)
	if err != nil {
		if !errors.Is(err, fs.ErrNotExist) {
			s.logger.Error("read index.html", "err", err)
		}
		writeText(w, http.StatusServiceUnavailable, "browser app build has no index.html")
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache")
	_, _ = w.Write(page)
}

func (s *site) internalError(w http.ResponseWriter, err error) {
	s.logger.Error("request failed", "err", err)
	writeText(w, http.StatusInternalServerError, "internal server error")
}

func setPageHeaders(w http.ResponseWriter) {
	w.Header().Set("Content-Security-Policy", contentSecurityPolicy)
	w.Header().Set("X-Content-Type-Options", "nosniff")
}

// isAssetPath reports whether name looks like a build file rather than a
// page. Reading URLs are always pages, whatever their last segment holds.
func isAssetPath(name string) bool {
	if strings.HasPrefix(name, "books/") {
		return false
	}
	return strings.HasPrefix(name, "assets/") || path.Ext(name) != ""
}

func writeText(w http.ResponseWriter, status int, body string) {
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.WriteHeader(status)
	_, _ = w.Write([]byte(body))
}
