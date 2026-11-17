package server

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"math"
	"net/http"
	"strconv"
	"time"

	"github.com/wiloon/tomeshelf/internal/library"
	"github.com/wiloon/tomeshelf/internal/store"
)

type bookJSON struct {
	SavedAt  *int64   `json:"savedAt,omitempty"`
	ID       int64    `json:"id"`
	Title    string   `json:"title"`
	Authors  []string `json:"authors"`
	Progress *int     `json:"progress,omitempty"`
}

func toBookJSON(b store.Book) bookJSON {
	out := bookJSON{ID: b.ID, Title: b.Title, Authors: b.Authors, SavedAt: b.SavedAt}
	if b.TotalProgression != nil {
		p := int(math.Floor(*b.TotalProgression * 100))
		if p > 100 {
			p = 100
		}
		if p < 0 {
			p = 0
		}
		out.Progress = &p
	}
	return out
}

// listBooks answers the signed-in user's library.
func (s *site) listBooks(w http.ResponseWriter, r *http.Request) {
	user, ok := s.requireUser(w, r)
	if !ok {
		return
	}
	books, err := s.books.Books(r.Context(), user)
	if err != nil {
		s.apiError(w, err)
		return
	}
	list := make([]bookJSON, 0, len(books))
	for _, b := range books {
		list = append(list, toBookJSON(b))
	}
	writeJSON(w, http.StatusOK, list)
}

// importBook adds the EPUB in the request body to the signed-in user's
// library. The session is checked before the body is read, and a body over
// the cap is refused before it is stored.
func (s *site) importBook(w http.ResponseWriter, r *http.Request) {
	user, ok := s.requireUser(w, r)
	if !ok {
		return
	}
	tooLarge := fmt.Sprintf("The file is larger than the %s limit.", formatSize(s.maxBookBytes))
	if r.ContentLength > s.maxBookBytes {
		writeError(w, http.StatusRequestEntityTooLarge, tooLarge)
		return
	}
	book, err := s.books.Import(r.Context(), user, http.MaxBytesReader(w, r.Body, s.maxBookBytes))
	var maxBytesErr *http.MaxBytesError
	var parseErr *library.ParseError
	switch {
	case err == nil:
		writeJSON(w, http.StatusCreated, toBookJSON(book))
	case errors.As(err, &maxBytesErr):
		writeError(w, http.StatusRequestEntityTooLarge, tooLarge)
	case errors.Is(err, store.ErrBookExists):
		writeError(w, http.StatusConflict, "This book is already in the library.")
	case errors.Is(err, library.ErrDRM):
		writeError(w, http.StatusUnprocessableEntity, "This book is DRM-encrypted, and DRM is not supported.")
	case errors.As(err, &parseErr):
		writeError(w, http.StatusUnprocessableEntity, "The file could not be read as an EPUB: "+parseErr.Error())
	case errors.Is(err, context.Canceled) && r.Context().Err() != nil:
		s.logger.Info("import cancelled", "user", user)
	default:
		s.apiError(w, err)
	}
}

// deleteBook deletes a book from the signed-in user's library. Another
// user's book answers 404, as an unknown one does. Once the row is gone the
// deletion has happened: files that could not be removed are logged and
// left behind (ADR-0007).
func (s *site) deleteBook(w http.ResponseWriter, r *http.Request) {
	user, ok := s.requireUser(w, r)
	if !ok {
		return
	}
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	err = s.books.Delete(r.Context(), user, id)
	var leftover *library.LeftoverError
	switch {
	case err == nil:
	case errors.As(err, &leftover):
		s.logger.Error("book deleted, files left behind", "user", user, "book", id, "err", leftover.Err)
	case errors.Is(err, store.ErrUnknownBook):
		writeError(w, http.StatusNotFound, "not found")
		return
	default:
		s.apiError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// thumbnail answers the cover thumbnail of a book in the signed-in user's
// library. The session and the book's owner are checked before anything is
// read, on every request, so neither a thumbnail cached on the server nor a
// conditional request from a browser cache bypasses them. Browsers must
// revalidate before each reuse, and shared caches must not store it.
func (s *site) thumbnail(w http.ResponseWriter, r *http.Request) {
	user, ok := s.requireUser(w, r)
	if !ok {
		return
	}
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	thumb, err := s.books.Thumbnail(r.Context(), user, id)
	switch {
	case err == nil:
	case errors.Is(err, store.ErrUnknownBook):
		writeError(w, http.StatusNotFound, "not found")
		return
	case errors.Is(err, library.ErrNoCover):
		writeError(w, http.StatusNotFound, "This book has no cover.")
		return
	case errors.Is(err, context.Canceled) && r.Context().Err() != nil:
		return
	default:
		s.apiError(w, err)
		return
	}
	serveRevalidated(w, r, "image/jpeg", thumb)
}

// manifest answers the RWPM manifest of a book in the signed-in user's
// library, with the session and owner checked as for the thumbnail.
func (s *site) manifest(w http.ResponseWriter, r *http.Request) {
	user, ok := s.requireUser(w, r)
	if !ok {
		return
	}
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	m, err := s.books.Manifest(r.Context(), user, id)
	switch {
	case err == nil:
	case errors.Is(err, store.ErrUnknownBook):
		writeError(w, http.StatusNotFound, "not found")
		return
	case errors.Is(err, context.Canceled) && r.Context().Err() != nil:
		return
	default:
		s.apiError(w, err)
		return
	}
	serveRevalidated(w, r, "application/webpub+json", m)
}

// packageFile answers one file of the package of a book in the signed-in
// user's library as stored, with the session and owner checked as for the
// thumbnail. The file is only data for the Navigator: it is sandboxed so that
// opening it directly runs no script in tomeshelf's origin (ADR-0004).
func (s *site) packageFile(w http.ResponseWriter, r *http.Request) {
	user, ok := s.requireUser(w, r)
	if !ok {
		return
	}
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	data, mediaType, err := s.books.PackageFile(r.Context(), user, id, r.PathValue("path"))
	switch {
	case err == nil:
	case errors.Is(err, store.ErrUnknownBook), errors.Is(err, library.ErrNoFile):
		writeError(w, http.StatusNotFound, "not found")
		return
	case errors.Is(err, context.Canceled) && r.Context().Err() != nil:
		return
	default:
		s.apiError(w, err)
		return
	}
	w.Header().Set("Content-Security-Policy", "sandbox")
	serveRevalidated(w, r, mediaType, data)
}

// serveRevalidated answers data with an ETag of its content. Browsers must
// revalidate before each reuse, and shared caches must not store it.
func serveRevalidated(w http.ResponseWriter, r *http.Request, contentType string, data []byte) {
	sum := sha256.Sum256(data)
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Cache-Control", "private, no-cache")
	w.Header().Set("ETag", `"`+hex.EncodeToString(sum[:16])+`"`)
	http.ServeContent(w, r, "", time.Time{}, bytes.NewReader(data))
}

// requireUser returns the signed-in username, or answers 401 and false.
func (s *site) requireUser(w http.ResponseWriter, r *http.Request) (string, bool) {
	user, err := s.sessionUser(r)
	if err != nil {
		s.apiError(w, err)
		return "", false
	}
	if user == "" {
		writeError(w, http.StatusUnauthorized, "not signed in")
		return "", false
	}
	return user, true
}

func formatSize(n int64) string {
	if n%(1<<20) == 0 {
		return fmt.Sprintf("%d MB", n>>20)
	}
	return fmt.Sprintf("%d KB", n>>10)
}
