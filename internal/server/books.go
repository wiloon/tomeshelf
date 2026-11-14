package server

import (
	"context"
	"errors"
	"fmt"
	"net/http"

	"github.com/wiloon/tomeshelf/internal/library"
	"github.com/wiloon/tomeshelf/internal/store"
)

type bookJSON struct {
	ID      int64    `json:"id"`
	Title   string   `json:"title"`
	Authors []string `json:"authors"`
}

func toBookJSON(b store.Book) bookJSON {
	return bookJSON{ID: b.ID, Title: b.Title, Authors: b.Authors}
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
