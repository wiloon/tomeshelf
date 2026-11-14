// Package server builds the HTTP handler the tomeshelf binary serves.
package server

import (
	"errors"
	"io/fs"
	"log/slog"
	"net/http"
	"path"
	"strings"
)

// contentSecurityPolicy is the app's CSP baseline (ADR-0004). script-src must
// stay exactly 'self', and there must be no script-src-elem or script-src-attr
// directive, so inline and third-party scripts stay blocked.
const contentSecurityPolicy = "default-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"

const indexHTML = "index.html"

// New returns the handler for the health endpoints and the browser app,
// whose static build is read from build.
func New(build fs.FS, logger *slog.Logger) http.Handler {
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
	mux.Handle("GET /", app(build, logger))
	return mux
}

// app serves files from the build. Paths that name no file fall back to
// index.html so the client router handles them, except asset paths, which 404.
func app(build fs.FS, logger *slog.Logger) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Security-Policy", contentSecurityPolicy)
		w.Header().Set("X-Content-Type-Options", "nosniff")

		name := strings.TrimPrefix(path.Clean(r.URL.Path), "/")
		if name != "" && name != indexHTML {
			info, err := fs.Stat(build, name)
			if err == nil && !info.IsDir() {
				http.ServeFileFS(w, r, build, name)
				return
			}
			if isAssetPath(name) {
				http.NotFound(w, r)
				return
			}
		}

		page, err := fs.ReadFile(build, indexHTML)
		if err != nil {
			if !errors.Is(err, fs.ErrNotExist) {
				logger.Error("read index.html", "err", err)
			}
			writeText(w, http.StatusServiceUnavailable, "browser app build has no index.html")
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Cache-Control", "no-cache")
		_, _ = w.Write(page)
	})
}

func isAssetPath(name string) bool {
	return strings.HasPrefix(name, "assets/") || path.Ext(name) != ""
}

func writeText(w http.ResponseWriter, status int, body string) {
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.WriteHeader(status)
	_, _ = w.Write([]byte(body))
}
