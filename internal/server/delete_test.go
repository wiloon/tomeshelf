package server_test

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"testing"

	"github.com/wiloon/tomeshelf/internal/library"
	"github.com/wiloon/tomeshelf/internal/store"
)

func (e env) deleteBook(t *testing.T, id string, cookie *http.Cookie) *http.Response {
	t.Helper()
	req := httptest.NewRequest(http.MethodDelete, fmt.Sprintf("/api/books/%s", id), nil)
	if cookie != nil {
		req.AddCookie(cookie)
	}
	return e.do(t, req)
}

// exists reports whether the file at path under the data directory exists.
func (e env) exists(t *testing.T, path string) bool {
	t.Helper()
	_, err := os.Stat(filepath.Join(e.dataDir, path))
	if errors.Is(err, os.ErrNotExist) {
		return false
	}
	if err != nil {
		t.Fatal(err)
	}
	return true
}

func originalPath(book []byte) string { return filepath.Join("books", sha(book)+".epub") }
func thumbPath(book []byte) string    { return filepath.Join("cache", "covers", sha(book)+".jpg") }
func noCoverPath(book []byte) string  { return filepath.Join("cache", "covers", sha(book)+".none") }

// requireGone checks that the book with the id answers 404 on every book
// route and is not listed.
func (e env) requireGone(t *testing.T, id string, cookie *http.Cookie) {
	t.Helper()
	if slices.ContainsFunc(e.books(t, cookie), func(b listedBook) bool { return b.ID == id }) {
		t.Errorf("book %s is still listed", id)
	}
	for _, path := range []string{
		thumbnailPath(id),
		fmt.Sprintf("/api/books/%s/manifest", id),
		fmt.Sprintf("/api/books/%s/package/OEBPS/text.xhtml", id),
	} {
		requireJSONError(t, e.get(t, path, cookie), http.StatusNotFound)
	}
}

func TestDeletingABookRemovesItsRowOriginalAndCache(t *testing.T) {
	withCover := coverEPUB(t, "With Cover", &cover{"cover.jpg", "image/jpeg", jpegImage(t, 600, 900)})
	withoutCover := coverEPUB(t, "Without Cover", nil)
	e := newEnv(t, buildFS())
	cookie := e.setup(t)
	kept := fixture(t, "epub3.epub")
	keptID := e.importedID(t, cookie, kept)

	coverID := e.importedID(t, cookie, withCover)
	requireThumbnail(t, e.thumbnail(t, coverID, cookie, ""), 600, 900)
	noCoverID := e.importedID(t, cookie, withoutCover)
	requireNoCover(t, e.thumbnail(t, noCoverID, cookie, ""))
	if !e.exists(t, thumbPath(withCover)) || !e.exists(t, noCoverPath(withoutCover)) {
		t.Fatal("the cache files were not written before the deletion")
	}

	for _, tc := range []struct {
		id    string
		book  []byte
		cache string
	}{{coverID, withCover, thumbPath(withCover)}, {noCoverID, withoutCover, noCoverPath(withoutCover)}} {
		res := e.deleteBook(t, tc.id, cookie)
		requireStatus(t, res, http.StatusNoContent)
		if b := body(t, res); b != "" {
			t.Errorf("204 body = %q, want none", b)
		}
		e.requireGone(t, tc.id, cookie)
		for _, path := range []string{originalPath(tc.book), tc.cache} {
			if e.exists(t, path) {
				t.Errorf("%s is left after the deletion", path)
			}
		}
	}
	e.requireOnly(t, kept)
	if got := e.books(t, cookie); len(got) != 1 || got[0].ID != keptID {
		t.Errorf("list = %+v, want only book %s", got, keptID)
	}
}

func TestDeletingUnknownOrOthersBooksAnswers404AndChangesNothing(t *testing.T) {
	book := coverEPUB(t, "Shared", &cover{"cover.jpg", "image/jpeg", jpegImage(t, 600, 900)})
	e := newEnv(t, buildFS())
	admin := e.setup(t)
	other := e.otherUser(t, "other")
	othersID := e.importedID(t, other, book)
	requireThumbnail(t, e.thumbnail(t, othersID, other, ""), 600, 900)
	deleted := e.importedID(t, admin, fixture(t, "epub3.epub"))
	requireStatus(t, e.deleteBook(t, deleted, admin), http.StatusNoContent)
	cache := e.cacheFiles(t)

	for name, id := range map[string]string{"unknown": absentID, "already deleted": deleted, "another user's": othersID} {
		t.Run(name, func(t *testing.T) {
			res := e.deleteBook(t, id, admin)
			requireJSONError(t, res, http.StatusNotFound)
		})
	}
	req := httptest.NewRequest(http.MethodDelete, "/api/books/abc", nil)
	req.AddCookie(admin)
	requireJSONError(t, e.do(t, req), http.StatusNotFound)

	e.requireOnly(t, book)
	if got := e.books(t, other); len(got) != 1 || got[0].ID != othersID {
		t.Errorf("the other user's list = %+v, want book %s", got, othersID)
	}
	if got := e.cacheFiles(t); len(got) != len(cache) || !e.exists(t, thumbPath(book)) {
		t.Errorf("cache/ = %v, want %v", got, cache)
	}
}

func TestSignedOutAndCrossSiteDeletionsAreRefused(t *testing.T) {
	e := newEnv(t, buildFS())
	cookie := e.setup(t)
	book := fixture(t, "epub3.epub")
	id := e.importedID(t, cookie, book)

	requireJSONError(t, e.deleteBook(t, id, nil), http.StatusUnauthorized)
	requireJSONError(t, e.deleteBook(t, id, &http.Cookie{Name: "tomeshelf_session", Value: "forged"}), http.StatusUnauthorized)
	req := httptest.NewRequest(http.MethodDelete, fmt.Sprintf("/api/books/%s", id), nil)
	req.AddCookie(cookie)
	req.Header.Set("Sec-Fetch-Site", "cross-site")
	requireStatus(t, e.do(t, req), http.StatusForbidden)
	e.requireOnly(t, book)
}

func TestDeletingASharedBookKeepsTheOtherUsersBookOriginalAndCache(t *testing.T) {
	book := coverEPUB(t, "Shared", &cover{"cover.jpg", "image/jpeg", jpegImage(t, 600, 900)})
	e := newEnv(t, buildFS())
	admin := e.setup(t)
	other := e.otherUser(t, "other")
	adminsID := e.importedID(t, admin, book)
	othersID := e.importedID(t, other, book)
	_, thumb := requireThumbnail(t, e.thumbnail(t, othersID, other, ""), 600, 900)

	requireStatus(t, e.deleteBook(t, adminsID, admin), http.StatusNoContent)
	e.requireGone(t, adminsID, admin)
	e.requireOnly(t, book)
	if !e.exists(t, thumbPath(book)) {
		t.Error("the shared thumbnail was removed")
	}
	if _, got := requireThumbnail(t, e.thumbnail(t, othersID, other, ""), 600, 900); got != thumb {
		t.Error("the other user's thumbnail changed")
	}

	requireStatus(t, e.deleteBook(t, othersID, other), http.StatusNoContent)
	e.requireOnly(t)
	if files := e.cacheFiles(t); len(files) != 0 {
		t.Errorf("cache/ = %v after the last deletion, want empty", files)
	}
}

func TestReimportingADeletedBookIsAFreshImportWithARebuiltThumbnail(t *testing.T) {
	book := coverEPUB(t, "Again", &cover{"cover.jpg", "image/jpeg", jpegImage(t, 600, 900)})
	e := newEnv(t, buildFS())
	cookie := e.setup(t)
	id := e.importedID(t, cookie, book)
	_, first := requireThumbnail(t, e.thumbnail(t, id, cookie, ""), 600, 900)
	requireStatus(t, e.deleteBook(t, id, cookie), http.StatusNoContent)

	again := e.importedID(t, cookie, book)
	if got := e.books(t, cookie); len(got) != 1 || got[0].ID != again {
		t.Errorf("list = %+v, want only the re-imported book %s", got, again)
	}
	if e.exists(t, thumbPath(book)) {
		t.Fatal("the thumbnail is cached before it was requested")
	}
	if _, got := requireThumbnail(t, e.thumbnail(t, again, cookie, ""), 600, 900); got != first {
		t.Error("the rebuilt thumbnail differs from the first")
	}
	e.requireOnly(t, book)
}

// failingDelete fails every DeleteBook.
type failingDelete struct{ *store.Store }

func (failingDelete) DeleteBook(context.Context, string, string, bool) error {
	return errors.New("injected delete failure")
}

func TestAFailedRowDeletionAnswers500AndChangesNothing(t *testing.T) {
	e := openEnv(t, buildFS(), envOptions{books: func(st *store.Store) library.Store {
		return failingDelete{Store: st}
	}})
	cookie := e.setup(t)
	book := coverEPUB(t, "Stays", &cover{"cover.jpg", "image/jpeg", jpegImage(t, 600, 900)})
	id := e.importedID(t, cookie, book)
	requireThumbnail(t, e.thumbnail(t, id, cookie, ""), 600, 900)

	requireJSONError(t, e.deleteBook(t, id, cookie), http.StatusInternalServerError)
	e.requireOnly(t, book)
	if !e.exists(t, thumbPath(book)) {
		t.Error("the thumbnail was removed")
	}
	requireThumbnail(t, e.thumbnail(t, id, cookie, ""), 600, 900)
}

func TestAFailedFileRemovalStillDeletesAndAReimportReusesTheLeftovers(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root ignores directory permissions")
	}
	cases := []struct {
		name  string
		book  []byte
		cache func([]byte) string
		check func(t *testing.T, e env, id string, cookie *http.Cookie) string
	}{
		{"with a cover", coverEPUB(t, "Leftover Cover", &cover{"cover.jpg", "image/jpeg", jpegImage(t, 600, 900)}), thumbPath,
			func(t *testing.T, e env, id string, cookie *http.Cookie) string {
				_, thumb := requireThumbnail(t, e.thumbnail(t, id, cookie, ""), 600, 900)
				return thumb
			}},
		{"without a cover", coverEPUB(t, "Leftover None", nil), noCoverPath,
			func(t *testing.T, e env, id string, cookie *http.Cookie) string {
				requireNoCover(t, e.thumbnail(t, id, cookie, ""))
				return ""
			}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			e := newEnv(t, buildFS())
			cookie := e.setup(t)
			id := e.importedID(t, cookie, tc.book)
			before := tc.check(t, e, id, cookie)
			covers := filepath.Join(e.dataDir, "cache", "covers")
			if err := os.Chmod(covers, 0o500); err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = os.Chmod(covers, 0o700) })

			requireStatus(t, e.deleteBook(t, id, cookie), http.StatusNoContent)
			e.requireGone(t, id, cookie)
			if n := e.count(t, "books"); n != 0 {
				t.Errorf("books rows = %d, want 0", n)
			}
			if !e.exists(t, tc.cache(tc.book)) {
				t.Fatalf("%s was removed although its directory is read-only", tc.cache(tc.book))
			}
			if err := os.Chmod(covers, 0o700); err != nil {
				t.Fatal(err)
			}

			again := e.importedID(t, cookie, tc.book)
			if after := tc.check(t, e, again, cookie); after != before {
				t.Error("the thumbnail after the re-import differs from the one before the deletion")
			}
			e.requireOnly(t, tc.book)
		})
	}
}

func TestKeepingAPositionHidesItUntilReimportAndKeepsTabSequences(t *testing.T) {
	e := newEnv(t, buildFS())
	c := e.setup(t)
	book := fixture(t, "chapters.epub")
	id := e.importedID(t, c, book)
	href := readingOrderHref(t, e, id, c, 1)
	requireStatus(t, e.putPosition(t, id, c, saveBody("tab-a", 7, href, 0.5, "")), http.StatusNoContent)
	before := body(t, e.getPosition(t, id, c))
	progress := *e.books(t, c)[0].Progress
	requireStatus(t, e.deleteBook(t, id+"?keepPosition=true", c), http.StatusNoContent)
	e.requireGone(t, id, c)
	e.requireOnly(t)
	requireJSONError(t, e.getPosition(t, id, c), http.StatusNotFound)
	requireJSONError(t, e.putPosition(t, id, c, saveBody("tab-a", 8, href, 0.9, "")), http.StatusNotFound)
	for _, table := range []string{"reading_positions", "reading_position_tabs"} {
		if n := e.count(t, table); n != 1 {
			t.Errorf("%s rows = %d, want 1", table, n)
		}
	}
	e.importedID(t, c, book)
	if got := e.books(t, c); len(got) != 1 || got[0].Progress == nil || *got[0].Progress != progress {
		t.Fatalf("progress after reimport = %+v", got)
	}
	requireStatus(t, e.putPosition(t, id, c, saveBody("tab-a", 7, href, 0.9, "")), http.StatusNoContent)
	if got := body(t, e.getPosition(t, id, c)); got != before {
		t.Errorf("position = %s, want %s", got, before)
	}
}

func TestDeleteKeepPositionValidationAndErrorOrder(t *testing.T) {
	for _, query := range []string{"keepPosition=", "keepPosition=1", "keepPosition=TRUE", "keepPosition=true&keepPosition=false", "keepPosition=false&keepPosition=false"} {
		t.Run(query, func(t *testing.T) {
			e := newEnv(t, buildFS())
			c := e.setup(t)
			book := fixture(t, "chapters.epub")
			id := e.importedID(t, c, book)
			href := readingOrderHref(t, e, id, c, 0)
			requireStatus(t, e.putPosition(t, id, c, saveBody("tab", 1, href, 0.5, "")), http.StatusNoContent)
			requireJSONError(t, e.deleteBook(t, id+"?"+query, nil), http.StatusUnauthorized)
			requireJSONError(t, e.deleteBook(t, "abc?"+query, c), http.StatusNotFound)
			requireJSONError(t, e.deleteBook(t, absentID+"?"+query, c), http.StatusNotFound)
			other := e.otherUser(t, "other")
			requireJSONError(t, e.deleteBook(t, id+"?"+query, other), http.StatusNotFound)
			requireJSONError(t, e.deleteBook(t, id+"?"+query, c), http.StatusBadRequest)
			e.requireOnly(t, book)
			requireStatus(t, e.getPosition(t, id, c), http.StatusOK)
			for _, table := range []string{"books", "reading_positions", "reading_position_tabs"} {
				if n := e.count(t, table); n != 1 {
					t.Errorf("%s rows = %d, want 1", table, n)
				}
			}
		})
	}
}

func TestAKeptPositionBelongsOnlyToTheUserWhoDeletedTheBook(t *testing.T) {
	e := newEnv(t, buildFS())
	a := e.setup(t)
	b := e.otherUser(t, "other")
	book := fixture(t, "chapters.epub")
	id := e.importedID(t, a, book)
	href := readingOrderHref(t, e, id, a, 1)
	requireStatus(t, e.putPosition(t, id, a, saveBody("same-tab", 7, href, 0.5, "")), http.StatusNoContent)
	before := body(t, e.getPosition(t, id, a))
	requireStatus(t, e.deleteBook(t, id+"?keepPosition=true", a), http.StatusNoContent)
	e.importedID(t, b, book)
	if books := e.books(t, b); len(books) != 1 || books[0].Progress != nil || books[0].SavedAt != nil {
		t.Fatalf("other user's books = %+v", books)
	}
	requireJSONError(t, e.getPosition(t, id, b), http.StatusNotFound)
	requireStatus(t, e.putPosition(t, id, b, saveBody("same-tab", 1, href, 0.9, "")), http.StatusNoContent)
	requireStatus(t, e.getPosition(t, id, b), http.StatusOK)
	e.importedID(t, a, book)
	requireStatus(t, e.putPosition(t, id, a, saveBody("same-tab", 7, href, 0.1, "")), http.StatusNoContent)
	if got := body(t, e.getPosition(t, id, a)); got != before {
		t.Errorf("A's position changed: %s, want %s", got, before)
	}
	for _, table := range []string{"reading_positions", "reading_position_tabs"} {
		if n := e.count(t, table); n != 2 {
			t.Errorf("%s rows = %d, want 2", table, n)
		}
	}
}

func TestDeleteWithoutKeepingRemovesPositionsAndTabs(t *testing.T) {
	for _, query := range []string{"", "?keepPosition=false"} {
		t.Run(query, func(t *testing.T) {
			e := newEnv(t, buildFS())
			c := e.setup(t)
			book := fixture(t, "chapters.epub")
			id := e.importedID(t, c, book)
			href := readingOrderHref(t, e, id, c, 1)
			requireStatus(t, e.putPosition(t, id, c, saveBody("tab", 7, href, 0.5, "")), http.StatusNoContent)
			requireStatus(t, e.deleteBook(t, id+query, c), http.StatusNoContent)
			for _, table := range []string{"reading_positions", "reading_position_tabs"} {
				if n := e.count(t, table); n != 0 {
					t.Errorf("%s rows = %d, want 0", table, n)
				}
			}
			e.importedID(t, c, book)
			if books := e.books(t, c); len(books) != 1 || books[0].Progress != nil {
				t.Fatalf("reimported books = %+v", books)
			}
			requireJSONError(t, e.getPosition(t, id, c), http.StatusNotFound)
			requireStatus(t, e.putPosition(t, id, c, saveBody("tab", 1, href, 0.9, "")), http.StatusNoContent)
			requireStatus(t, e.getPosition(t, id, c), http.StatusOK)
		})
	}
}
