package server_test

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/wiloon/tomeshelf/internal/library"
	"github.com/wiloon/tomeshelf/internal/store"
)

type listedBook struct {
	ImportedAt int64    `json:"importedAt"`
	SavedAt    *int64   `json:"savedAt"`
	ID         int64    `json:"id"`
	Title      string   `json:"title"`
	Authors    []string `json:"authors"`
	Progress   *int     `json:"progress"`
}

func fixture(t *testing.T, name string) []byte {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("..", "..", "testdata", "books", name))
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func sha(b []byte) string {
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

func importRequest(body io.Reader, cookie *http.Cookie) *http.Request {
	req := httptest.NewRequest(http.MethodPost, "/api/books", body)
	req.Header.Set("Content-Type", "application/epub+zip")
	if cookie != nil {
		req.AddCookie(cookie)
	}
	return req
}

func (e env) importBook(t *testing.T, cookie *http.Cookie, book []byte) *http.Response {
	t.Helper()
	return e.do(t, importRequest(bytes.NewReader(book), cookie))
}

func (e env) books(t *testing.T, cookie *http.Cookie) []listedBook {
	t.Helper()
	res := e.get(t, "/api/books", cookie)
	requireStatus(t, res, http.StatusOK)
	var books []listedBook
	if err := json.Unmarshal([]byte(body(t, res)), &books); err != nil {
		t.Fatal(err)
	}
	return books
}

// files lists the names of the regular files in the data directory's sub
// directory; a missing directory has none.
func (e env) files(t *testing.T, sub string) []string {
	t.Helper()
	entries, err := os.ReadDir(filepath.Join(e.dataDir, sub))
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, entry := range entries {
		if entry.Type().IsRegular() {
			names = append(names, entry.Name())
		}
	}
	return names
}

func (e env) original(t *testing.T, book []byte) []byte {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(e.dataDir, "books", sha(book)+".epub"))
	if err != nil {
		t.Fatal(err)
	}
	return b
}

// requireOnly checks that the library holds exactly the given books, each
// with its original and nothing else in books/, and that tmp/ is empty.
func (e env) requireOnly(t *testing.T, books ...[]byte) {
	t.Helper()
	if n := e.count(t, "books"); n != len(books) {
		t.Errorf("books rows = %d, want %d", n, len(books))
	}
	var want []string
	for _, b := range books {
		want = append(want, sha(b)+".epub")
		if got := e.original(t, b); !bytes.Equal(got, b) {
			t.Errorf("original %s.epub differs from the imported file", sha(b))
		}
	}
	slices.Sort(want)
	if got := e.files(t, "books"); !slices.Equal(got, want) {
		t.Errorf("books/ = %v, want %v", got, want)
	}
	if got := e.files(t, "tmp"); len(got) != 0 {
		t.Errorf("tmp/ = %v, want empty", got)
	}
}

func jsonError(t *testing.T, res *http.Response) string {
	t.Helper()
	var e struct{ Error string }
	if err := json.Unmarshal([]byte(body(t, res)), &e); err != nil {
		t.Fatal(err)
	}
	return e.Error
}

func requireRefused(t *testing.T, res *http.Response, status int, message string) {
	t.Helper()
	requireStatus(t, res, status)
	if got := jsonError(t, res); !strings.Contains(got, message) {
		t.Errorf("error = %q, want it to contain %q", got, message)
	}
}

func TestImportedBooksAreListedWithTitleAndAuthorsAndSurviveARestart(t *testing.T) {
	cases := []struct {
		file    string
		title   string
		authors []string
	}{
		{"epub2.epub", "A Hand-Made EPUB 2", []string{"Ada Fixture"}},
		{"epub3.epub", "A Hand-Made EPUB 3", []string{"Ada Fixture", "Bo Example"}},
		{"robert-louis-stevenson_the-strange-case-of-dr-jekyll-and-mr-hyde.epub", "The Strange Case of Dr. Jekyll and Mr. Hyde", []string{"Robert Louis Stevenson"}},
		{"h-g-wells_the-time-machine.epub", "The Time Machine", []string{"H. G. Wells"}},
	}
	e := newEnv(t, buildFS())
	cookie := e.setup(t)
	var imported [][]byte
	for i, tc := range cases {
		e.store.Now = func() time.Time { return time.Unix(1700000000+int64(i), 0) }
		book := fixture(t, tc.file)
		res := e.importBook(t, cookie, book)
		requireStatus(t, res, http.StatusCreated)
		var got listedBook
		if err := json.Unmarshal([]byte(body(t, res)), &got); err != nil {
			t.Fatal(err)
		}
		if got.Title != tc.title || !slices.Equal(got.Authors, tc.authors) {
			t.Errorf("%s: imported %q by %v, want %q by %v", tc.file, got.Title, got.Authors, tc.title, tc.authors)
		}
		if got.ImportedAt != 1700000000+int64(i) {
			t.Errorf("%s: importedAt = %d, want %d", tc.file, got.ImportedAt, 1700000000+int64(i))
		}
		imported = append(imported, book)
	}

	requireListed := func(e env, cookie *http.Cookie) {
		t.Helper()
		books := e.books(t, cookie)
		if len(books) != len(cases) {
			t.Fatalf("listed %d books, want %d: %+v", len(books), len(cases), books)
		}
		for caseIndex, tc := range cases {
			i := slices.IndexFunc(books, func(b listedBook) bool { return b.Title == tc.title })
			if i < 0 {
				t.Errorf("%q is not listed: %+v", tc.title, books)
				continue
			}
			if books[i].ImportedAt != 1700000000+int64(caseIndex) {
				t.Errorf("%q: listed importedAt = %d, want %d", tc.title, books[i].ImportedAt, 1700000000+int64(caseIndex))
			}
			if !slices.Equal(books[i].Authors, tc.authors) {
				t.Errorf("%q listed by %v, want %v", tc.title, books[i].Authors, tc.authors)
			}
		}
	}
	requireListed(e, cookie)
	e.requireOnly(t, imported...)

	stray := filepath.Join(e.dataDir, "tmp", "left-by-a-crash.epub")
	if err := os.WriteFile(stray, []byte("partial upload"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := e.store.Close(); err != nil {
		t.Fatal(err)
	}
	restarted := openEnv(t, buildFS(), envOptions{dataDir: e.dataDir})
	requireListed(restarted, cookie)
	restarted.requireOnly(t, imported...)
}

func TestImportingTheSameFileAgainSaysItIsAlreadyInTheLibrary(t *testing.T) {
	e := newEnv(t, buildFS())
	cookie := e.setup(t)
	book := fixture(t, "epub3.epub")
	requireStatus(t, e.importBook(t, cookie, book), http.StatusCreated)
	before := e.books(t, cookie)

	requireRefused(t, e.importBook(t, cookie, book), http.StatusConflict, "already in the library")
	if after := e.books(t, cookie); !slices.EqualFunc(after, before, func(a, b listedBook) bool {
		return a.ID == b.ID && a.Title == b.Title && slices.Equal(a.Authors, b.Authors)
	}) {
		t.Errorf("list after the second import = %+v, want %+v", after, before)
	}
	e.requireOnly(t, book)
}

func TestConcurrentImportsOfOneFileLeaveOneBookAndOneOriginal(t *testing.T) {
	e := newEnv(t, buildFS())
	cookie := e.setup(t)
	book := fixture(t, "robert-louis-stevenson_the-strange-case-of-dr-jekyll-and-mr-hyde.epub")
	const n = 8
	statuses := make([]int, n)
	var wg sync.WaitGroup
	for i := range n {
		wg.Go(func() {
			rec := httptest.NewRecorder()
			e.h.ServeHTTP(rec, importRequest(bytes.NewReader(book), cookie))
			statuses[i] = rec.Code
		})
	}
	wg.Wait()

	created, duplicates := 0, 0
	for _, status := range statuses {
		switch status {
		case http.StatusCreated:
			created++
		case http.StatusConflict:
			duplicates++
		default:
			t.Errorf("import status = %d, want 201 or 409", status)
		}
	}
	if created != 1 || duplicates != n-1 {
		t.Errorf("created = %d, duplicates = %d; want 1 and %d", created, duplicates, n-1)
	}
	e.requireOnly(t, book)
}

func TestDRMBooksAreRefusedAndFontObfuscationIsAccepted(t *testing.T) {
	e := newEnv(t, buildFS())
	cookie := e.setup(t)
	earlier := fixture(t, "epub2.epub")
	requireStatus(t, e.importBook(t, cookie, earlier), http.StatusCreated)

	for _, name := range []string{"adept.epub", "lcp.epub"} {
		t.Run(name, func(t *testing.T) {
			requireRefused(t, e.importBook(t, cookie, fixture(t, name)), http.StatusUnprocessableEntity, "DRM is not supported")
			e.requireOnly(t, earlier)
		})
	}

	obfuscated := fixture(t, "font-obfuscated.epub")
	requireStatus(t, e.importBook(t, cookie, obfuscated), http.StatusCreated)
	e.requireOnly(t, earlier, obfuscated)
}

func TestABrokenFileIsRefusedWithTheParserError(t *testing.T) {
	e := newEnv(t, buildFS())
	cookie := e.setup(t)
	earlier := fixture(t, "epub2.epub")
	requireStatus(t, e.importBook(t, cookie, earlier), http.StatusCreated)

	res := e.importBook(t, cookie, fixture(t, "broken.epub"))
	requireStatus(t, res, http.StatusUnprocessableEntity)
	msg := jsonError(t, res)
	if !strings.HasPrefix(msg, "The file could not be read as an EPUB: ") || !strings.Contains(msg, "XML syntax error") {
		t.Errorf("error = %q, want the parser's XML syntax error", msg)
	}
	e.requireOnly(t, earlier)
}

// countingReader counts the bytes read through it.
type countingReader struct {
	r io.Reader
	n atomic.Int64
}

func (c *countingReader) Read(p []byte) (int, error) {
	n, err := c.r.Read(p)
	c.n.Add(int64(n))
	return n, err
}

func TestFilesOverTheCapAreRefusedBeforeTheyAreStored(t *testing.T) {
	const maxBytes = 64 << 10
	e := openEnv(t, buildFS(), envOptions{maxBookBytes: maxBytes})
	cookie := e.setup(t)
	earlier := fixture(t, "epub2.epub")
	requireStatus(t, e.importBook(t, cookie, earlier), http.StatusCreated)
	big := fixture(t, "h-g-wells_the-time-machine.epub")

	t.Run("declared Content-Length", func(t *testing.T) {
		body := &countingReader{r: bytes.NewReader(big)}
		req := importRequest(body, cookie)
		req.ContentLength = int64(len(big))
		requireRefused(t, e.do(t, req), http.StatusRequestEntityTooLarge, "larger than")
		if n := body.n.Load(); n != 0 {
			t.Errorf("read %d bytes of a body declared over the cap, want 0", n)
		}
		e.requireOnly(t, earlier)
	})

	t.Run("unknown length", func(t *testing.T) {
		body := &countingReader{r: bytes.NewReader(big)}
		req := importRequest(body, cookie)
		req.ContentLength = -1
		requireRefused(t, e.do(t, req), http.StatusRequestEntityTooLarge, "larger than")
		if n := body.n.Load(); n >= int64(len(big)) {
			t.Errorf("read the whole %d-byte body, want the read to stop near the %d-byte cap", n, maxBytes)
		}
		e.requireOnly(t, earlier)
	})
}

// cancellingReader cancels the request's context after the first read.
type cancellingReader struct {
	r      io.Reader
	cancel context.CancelFunc
}

func (c *cancellingReader) Read(p []byte) (int, error) {
	n, err := c.r.Read(p[:min(len(p), 512)])
	c.cancel()
	return n, err
}

func TestACancelledImportLeavesNothingBehind(t *testing.T) {
	e := newEnv(t, buildFS())
	cookie := e.setup(t)
	earlier := fixture(t, "epub2.epub")
	requireStatus(t, e.importBook(t, cookie, earlier), http.StatusCreated)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	book := fixture(t, "h-g-wells_the-time-machine.epub")
	req := importRequest(&cancellingReader{r: bytes.NewReader(book), cancel: cancel}, cookie).WithContext(ctx)
	if res := e.do(t, req); res.StatusCode == http.StatusCreated {
		t.Fatalf("a cancelled import answered 201")
	}
	e.requireOnly(t, earlier)
}

func TestAFailedRenameLeavesNothingAndARetrySucceeds(t *testing.T) {
	e := newEnv(t, buildFS())
	cookie := e.setup(t)
	earlier := fixture(t, "epub2.epub")
	requireStatus(t, e.importBook(t, cookie, earlier), http.StatusCreated)
	book := fixture(t, "epub3.epub")

	// A non-empty directory where the original goes makes the rename fail.
	blocker := filepath.Join(e.dataDir, "books", sha(book)+".epub")
	if err := os.MkdirAll(filepath.Join(blocker, "in-the-way"), 0o700); err != nil {
		t.Fatal(err)
	}
	requireStatus(t, e.importBook(t, cookie, book), http.StatusInternalServerError)
	e.requireOnly(t, earlier)

	if err := os.RemoveAll(blocker); err != nil {
		t.Fatal(err)
	}
	requireStatus(t, e.importBook(t, cookie, book), http.StatusCreated)
	e.requireOnly(t, earlier, book)
}

// failingInsert fails the next AddBook while fail is set.
type failingInsert struct {
	*store.Store
	fail *atomic.Bool
}

func (f failingInsert) AddBook(ctx context.Context, username string, b store.Book) (store.Book, error) {
	if f.fail.Swap(false) {
		return store.Book{}, errors.New("injected insert failure")
	}
	return f.Store.AddBook(ctx, username, b)
}

func TestAFailedInsertLeavesAtMostTheOrphanOriginalAndARetrySucceeds(t *testing.T) {
	fail := &atomic.Bool{}
	e := openEnv(t, buildFS(), envOptions{books: func(st *store.Store) library.Store {
		return failingInsert{Store: st, fail: fail}
	}})
	cookie := e.setup(t)
	earlier := fixture(t, "epub2.epub")
	requireStatus(t, e.importBook(t, cookie, earlier), http.StatusCreated)
	book := fixture(t, "epub3.epub")

	fail.Store(true)
	requireStatus(t, e.importBook(t, cookie, book), http.StatusInternalServerError)
	if n := e.count(t, "books"); n != 1 {
		t.Errorf("books rows = %d, want 1", n)
	}
	if got := e.files(t, "tmp"); len(got) != 0 {
		t.Errorf("tmp/ = %v, want empty", got)
	}
	allowed := []string{sha(earlier) + ".epub", sha(book) + ".epub"}
	for _, name := range e.files(t, "books") {
		if !slices.Contains(allowed, name) {
			t.Errorf("books/ has %s, want only the earlier original and the orphan", name)
		}
	}
	if got := e.original(t, earlier); !bytes.Equal(got, earlier) {
		t.Error("the earlier original changed")
	}

	requireStatus(t, e.importBook(t, cookie, book), http.StatusCreated)
	e.requireOnly(t, earlier, book)
}

func TestSignedOutImportAndListAnswer401AndStoreNothing(t *testing.T) {
	e := newEnv(t, buildFS())
	check := func(t *testing.T) {
		t.Helper()
		body := &countingReader{r: bytes.NewReader(fixture(t, "epub3.epub"))}
		requireJSONError(t, e.do(t, importRequest(body, nil)), http.StatusUnauthorized)
		if n := body.n.Load(); n != 0 {
			t.Errorf("read %d bytes of a signed-out upload, want 0", n)
		}
		requireJSONError(t, e.get(t, "/api/books"), http.StatusUnauthorized)
		requireJSONError(t, e.get(t, "/api/books", &http.Cookie{Name: "tomeshelf_session", Value: "forged"}), http.StatusUnauthorized)
		e.requireOnly(t)
	}
	t.Run("before setup", check)
	e.setup(t)
	t.Run("after setup", check)
}
