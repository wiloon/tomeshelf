package server_test

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/wiloon/tomeshelf/internal/library"
	"github.com/wiloon/tomeshelf/internal/store"
)

func TestABooksIDIsTheSHA256OfItsOriginalAndSurvivesAReimport(t *testing.T) {
	e := newEnv(t, buildFS())
	cookie := e.setup(t)
	first := fixture(t, "chapters.epub")
	second := fixture(t, "epub3.epub")

	id := e.importedID(t, cookie, first)
	if id != sha(first) {
		t.Fatalf("id = %q, want the SHA-256 %q", id, sha(first))
	}
	requireStatus(t, e.deleteBook(t, id, cookie), http.StatusNoContent)

	if again := e.importedID(t, cookie, first); again != id {
		t.Errorf("re-import id = %q, want %q", again, id)
	}
	requireStatus(t, e.deleteBook(t, id, cookie), http.StatusNoContent)
	if other := e.importedID(t, cookie, second); other == id || other != sha(second) {
		t.Errorf("a different file got id %q (deleted book %q, its own SHA-256 %q)", other, id, sha(second))
	}
}

func TestDeletingAFileTwoUsersImportedLeavesTheOthersBookAndPosition(t *testing.T) {
	e := newEnv(t, buildFS())
	admin := e.setup(t)
	other := e.otherUser(t, "other")
	book := fixture(t, "chapters.epub")
	id := e.importedID(t, admin, book)
	if got := e.importedID(t, other, book); got != id {
		t.Fatalf("ids differ between users: %q and %q", id, got)
	}
	href := readingOrderHref(t, e, id, admin, 0)
	requireStatus(t, e.putPosition(t, id, admin, saveBody("tab", 1, href, 0.4, "")), http.StatusNoContent)
	requireStatus(t, e.putPosition(t, id, other, saveBody("tab", 1, href, 0.8, "")), http.StatusNoContent)

	requireStatus(t, e.deleteBook(t, id, admin), http.StatusNoContent)

	if got := e.books(t, other); len(got) != 1 || got[0].ID != id || got[0].Progress == nil {
		t.Fatalf("other library = %+v, want the book with its position", got)
	}
	requireStatus(t, e.getPosition(t, id, other), http.StatusOK)
	requireJSONError(t, e.getPosition(t, id, admin), http.StatusNotFound)
	e.requireOnly(t, book)
	if n := e.count(t, "reading_positions"); n != 1 {
		t.Errorf("reading_positions rows = %d, want only the other user's", n)
	}
	if n := e.count(t, "reading_position_tabs"); n != 1 {
		t.Errorf("reading_position_tabs rows = %d, want only the other user's", n)
	}
}

func TestDeletingABookDeletesItsPositionAndTabSequences(t *testing.T) {
	e := newEnv(t, buildFS())
	cookie := e.setup(t)
	book := fixture(t, "chapters.epub")
	id := e.importedID(t, cookie, book)
	href := readingOrderHref(t, e, id, cookie, 0)
	requireStatus(t, e.putPosition(t, id, cookie, saveBody("tab", 5, href, 0.4, "")), http.StatusNoContent)

	requireStatus(t, e.deleteBook(t, id, cookie), http.StatusNoContent)
	for _, table := range []string{"reading_positions", "reading_position_tabs"} {
		if n := e.count(t, table); n != 0 {
			t.Errorf("%s rows = %d after the deletion, want 0", table, n)
		}
	}

	// The same file again starts with no position and no tab sequence: a save
	// with a lower sequence than the deleted book's is accepted.
	e.importedID(t, cookie, book)
	requireJSONError(t, e.getPosition(t, id, cookie), http.StatusNotFound)
	requireStatus(t, e.putPosition(t, id, cookie, saveBody("tab", 1, href, 0.9, "")), http.StatusNoContent)
	requireStatus(t, e.getPosition(t, id, cookie), http.StatusOK)
}

// countingStore counts the calls that carry a book id into the store.
type countingStore struct {
	*store.Store
	calls *atomic.Int64
}

func (c countingStore) Book(ctx context.Context, username, id string) (store.Book, error) {
	c.calls.Add(1)
	return c.Store.Book(ctx, username, id)
}

func (c countingStore) DeleteBook(ctx context.Context, username, id string, keepPosition bool) error {
	c.calls.Add(1)
	return c.Store.DeleteBook(ctx, username, id, keepPosition)
}

func (c countingStore) ReadingPosition(ctx context.Context, username, id string) (store.ReadingPosition, error) {
	c.calls.Add(1)
	return c.Store.ReadingPosition(ctx, username, id)
}

func (c countingStore) SaveReadingPosition(ctx context.Context, username, id, tab string, seq int64, p store.ReadingPosition) (store.SaveReadingPositionResult, error) {
	c.calls.Add(1)
	return c.Store.SaveReadingPosition(ctx, username, id, tab, seq, p)
}

func TestEveryBookRouteAnswers404ForAnIdThatIsNotLowercaseSHA256Hex(t *testing.T) {
	var calls atomic.Int64
	e := openEnv(t, buildFS(), envOptions{books: func(st *store.Store) library.Store {
		return countingStore{Store: st, calls: &calls}
	}})
	cookie := e.setup(t)
	book := fixture(t, "chapters.epub")
	valid := e.importedID(t, cookie, book)
	calls.Store(0)

	bad := map[string]string{
		"integer":     "1",
		"uppercase":   strings.ToUpper(valid),
		"63 chars":    valid[:63],
		"65 chars":    valid + "0",
		"non-hex":     strings.Repeat("g", 64),
		"dot dot":     "..",
		"escaped dot": "%2e%2e",
		"traversal":   "..%2f..%2fbooks%2f" + valid,
	}
	routes := []struct {
		method, suffix, body string
	}{
		{http.MethodDelete, "", ""},
		{http.MethodGet, "/thumbnail", ""},
		{http.MethodGet, "/manifest", ""},
		{http.MethodGet, "/package/OEBPS/text.xhtml", ""},
		{http.MethodGet, "/position", ""},
		{http.MethodPut, "/position", saveBody("tab", 1, "OEBPS/text.xhtml", 0.5, "")},
	}
	for name, id := range bad {
		for _, route := range routes {
			t.Run(fmt.Sprintf("%s %s%s", name, route.method, route.suffix), func(t *testing.T) {
				req := httptest.NewRequest(route.method, "/api/books/"+id+route.suffix, strings.NewReader(route.body))
				req.Header.Set("Content-Type", "application/json")
				req.AddCookie(cookie)
				requireJSONError(t, e.do(t, req), http.StatusNotFound)
			})
		}
	}
	if n := calls.Load(); n != 0 {
		t.Errorf("the store was asked about a book %d times for malformed ids, want 0", n)
	}
	e.requireOnly(t, book)
}
