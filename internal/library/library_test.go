package library

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"image"
	"image/color"
	"image/jpeg"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"testing"

	"github.com/wiloon/tomeshelf/internal/store"
)

const reader = "reader"

type testLibrary struct {
	*Library
	st      *store.Store
	dataDir string
}

// newLibrary opens a library on a fresh data directory with one user,
// reader; wrap, when not nil, wraps the store the library uses.
func newLibrary(t *testing.T, wrap func(*store.Store) Store) testLibrary {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, "tomeshelf.db")
	st, err := store.Open(context.Background(), path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	if _, err := st.CreateAdmin(context.Background(), reader, "hash"); err != nil {
		t.Fatal(err)
	}
	var s Store = st
	if wrap != nil {
		s = wrap(st)
	}
	l, err := Open(dir, s)
	if err != nil {
		t.Fatal(err)
	}
	return testLibrary{Library: l, st: st, dataDir: dir}
}

// addUser creates another user, which only the database can do so far.
func (tl testLibrary) addUser(t *testing.T, username string) {
	t.Helper()
	db, err := sql.Open("sqlite", filepath.Join(tl.dataDir, "tomeshelf.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err := db.Exec("INSERT INTO users (username, password_hash) VALUES (?, 'hash')", username); err != nil {
		t.Fatal(err)
	}
}

func (tl testLibrary) path(sum, ext string) string {
	if ext == ".epub" {
		return filepath.Join(tl.dataDir, "books", sum+ext)
	}
	return filepath.Join(tl.dataDir, "cache", "covers", sum+ext)
}

func (tl testLibrary) exists(t *testing.T, sum, ext string) bool {
	t.Helper()
	_, err := os.Stat(tl.path(sum, ext))
	if errors.Is(err, os.ErrNotExist) {
		return false
	}
	if err != nil {
		t.Fatal(err)
	}
	return true
}

func sha(b []byte) string {
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

const coverName = "OEBPS/cover.jpg"

// coverEPUB returns a hand-made EPUB 3 whose cover is a w×h JPEG. The cover
// is stored uncompressed and is followed by more than a kilobyte of other
// entries, so opening the ZIP reads none of the cover's data.
func coverEPUB(t *testing.T, w, h int) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for y := range h {
		for x := range w {
			img.Set(x, y, color.RGBA{R: uint8(x * 255 / w), G: uint8(y * 255 / h), B: 128, A: 255})
		}
	}
	var jpg bytes.Buffer
	if err := jpeg.Encode(&jpg, img, nil); err != nil {
		t.Fatal(err)
	}
	files := []struct {
		name string
		data []byte
	}{
		{"mimetype", []byte("application/epub+zip")},
		{coverName, jpg.Bytes()},
		{"META-INF/container.xml", []byte(`<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`)},
		{"OEBPS/content.opf", []byte(`<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="uid">urn:uuid:5e0b2c7a-0012-4000-8000-000000000000</dc:identifier>
    <dc:title>A Book With A Cover</dc:title>
    <dc:language>en</dc:language>
    <meta property="dcterms:modified">2026-11-14T00:00:00Z</meta>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="text" href="text.xhtml" media-type="application/xhtml+xml"/>
    <item id="cover" href="cover.jpg" media-type="image/jpeg" properties="cover-image"/>
  </manifest>
  <spine><itemref idref="text"/></spine>
</package>`)},
		{"OEBPS/nav.xhtml", []byte(`<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Contents</title></head>
<body><nav epub:type="toc"><ol><li><a href="text.xhtml">Text</a></li></ol></nav></body></html>`)},
		{"OEBPS/text.xhtml", []byte(`<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Text</title></head><body><p>` +
			strings.Repeat("CC0 test text. ", 200) + `</p></body></html>`)},
	}
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for _, f := range files {
		w, err := zw.CreateHeader(&zip.FileHeader{Name: f.name, Method: zip.Store})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := w.Write(f.data); err != nil {
			t.Fatal(err)
		}
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func (tl testLibrary) importBook(t *testing.T, username string, book []byte) store.Book {
	t.Helper()
	b, err := tl.Import(context.Background(), username, bytes.NewReader(book))
	if err != nil {
		t.Fatal(err)
	}
	return b
}

// requireThumbnail checks that Thumbnail returns a JPEG and caches it, with
// no .none.
func (tl testLibrary) requireThumbnail(t *testing.T, username string, b store.Book) {
	t.Helper()
	thumb, err := tl.Thumbnail(context.Background(), username, b.ID)
	if err != nil {
		t.Fatalf("Thumbnail: %v", err)
	}
	if _, err := jpeg.Decode(bytes.NewReader(thumb)); err != nil {
		t.Fatalf("thumbnail is not a JPEG: %v", err)
	}
	if !tl.exists(t, b.ID, ".jpg") || tl.exists(t, b.ID, ".none") {
		t.Error("want .jpg cached and no .none")
	}
}

// requireNoCache checks that a failed Thumbnail was not taken for "no cover"
// and cached nothing.
func (tl testLibrary) requireNoCache(t *testing.T, sum string, err error) {
	t.Helper()
	if err == nil || errors.Is(err, ErrNoCover) {
		t.Errorf("Thumbnail err = %v, want an error that is not ErrNoCover", err)
	}
	for _, ext := range []string{".jpg", ".none"} {
		if tl.exists(t, sum, ext) {
			t.Errorf("%s is cached after a read failure", ext)
		}
	}
}

// failingInsert fails the next AddBook while fail is set.
type failingInsert struct {
	*store.Store
	fail *atomic.Bool
}

func (f failingInsert) AddBook(ctx context.Context, username string, b store.Book) (store.Book, error) {
	if f.fail.Swap(false) {
		return store.Book{}, errInjected
	}
	return f.Store.AddBook(ctx, username, b)
}

var errInjected = errors.New("injected insert failure")

func TestAFailedInsertLeavesTheOriginalWhichARetryReuses(t *testing.T) {
	fail := &atomic.Bool{}
	tl := newLibrary(t, func(st *store.Store) Store { return failingInsert{Store: st, fail: fail} })
	book := coverEPUB(t, 600, 900)

	fail.Store(true)
	if _, err := tl.Import(context.Background(), reader, bytes.NewReader(book)); !errors.Is(err, errInjected) {
		t.Fatalf("Import err = %v, want the insert's error", err)
	}
	if books, err := tl.Books(context.Background(), reader); err != nil || len(books) != 0 {
		t.Fatalf("Books = %v, %v; want none", books, err)
	}
	if !tl.exists(t, sha(book), ".epub") {
		t.Fatal("the original was removed after the failed insert")
	}

	b := tl.importBook(t, reader, book)
	if b.ID != sha(book) {
		t.Errorf("SHA256 = %s, want %s", b.ID, sha(book))
	}
	if got, err := os.ReadFile(tl.path(b.ID, ".epub")); err != nil || !bytes.Equal(got, book) {
		t.Errorf("the original differs from the imported file: %v", err)
	}
	tl.requireThumbnail(t, reader, b)
}

func TestAnUnreadableOriginalCachesNothingUntilItIsReadable(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root reads files whatever their mode")
	}
	tl := newLibrary(t, nil)
	b := tl.importBook(t, reader, coverEPUB(t, 600, 900))
	original := tl.path(b.ID, ".epub")
	if err := os.Chmod(original, 0); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(original, 0o600) })

	_, err := tl.Thumbnail(context.Background(), reader, b.ID)
	tl.requireNoCache(t, b.ID, err)

	if err := os.Chmod(original, 0o600); err != nil {
		t.Fatal(err)
	}
	tl.requireThumbnail(t, reader, b)
}

// failingReads fails the first read that overlaps [from, to) with EIO.
type failingReads struct {
	readerAtCloser
	from, to int64
	fail     *atomic.Bool
}

func (f failingReads) ReadAt(p []byte, off int64) (int, error) {
	if off < f.to && off+int64(len(p)) > f.from && f.fail.Swap(false) {
		return 0, syscall.EIO
	}
	return f.readerAtCloser.ReadAt(p, off)
}

func TestAReadErrorOnTheCoverCachesNothingAndTheNextRequestMakesIt(t *testing.T) {
	tl := newLibrary(t, nil)
	book := coverEPUB(t, 600, 900)
	b := tl.importBook(t, reader, book)

	zr, err := zip.NewReader(bytes.NewReader(book), int64(len(book)))
	if err != nil {
		t.Fatal(err)
	}
	var from, to int64
	for _, f := range zr.File {
		if f.Name == coverName {
			if from, err = f.DataOffset(); err != nil {
				t.Fatal(err)
			}
			to = from + int64(f.CompressedSize64)
		}
	}
	if to == 0 {
		t.Fatal("no cover entry")
	}
	fail := &atomic.Bool{}
	fail.Store(true)
	tl.openOriginal = func(path string) (readerAtCloser, int64, error) {
		f, size, err := openFile(path)
		if err != nil {
			return nil, 0, err
		}
		return failingReads{readerAtCloser: f, from: from, to: to, fail: fail}, size, nil
	}

	_, err = tl.Thumbnail(context.Background(), reader, b.ID)
	if fail.Load() {
		t.Fatal("the cover's data was never read")
	}
	if !errors.Is(err, syscall.EIO) {
		t.Errorf("Thumbnail err = %v, want it to wrap EIO", err)
	}
	tl.requireNoCache(t, b.ID, err)

	tl.requireThumbnail(t, reader, b)
}

// requireConsistent checks that the original of sum exists exactly when a
// row names it, and that no cache file outlives the rows.
func (tl testLibrary) requireConsistent(t *testing.T, sum string, users ...string) {
	t.Helper()
	named := false
	for _, u := range users {
		books, err := tl.Books(context.Background(), u)
		if err != nil {
			t.Fatal(err)
		}
		for _, b := range books {
			named = named || b.ID == sum
		}
	}
	if got := tl.exists(t, sum, ".epub"); got != named {
		t.Fatalf("original exists = %v, row names it = %v", got, named)
	}
	if !named && (tl.exists(t, sum, ".jpg") || tl.exists(t, sum, ".none")) {
		t.Fatal("a cache file is left with no row naming its original")
	}
}

func TestDeletionsRacingImportsAndThumbnailsKeepRowsAndFilesTogether(t *testing.T) {
	tl := newLibrary(t, nil)
	tl.addUser(t, "other")
	users := []string{reader, "other"}
	book := coverEPUB(t, 300, 450)
	ctx := context.Background()
	for round := range 40 {
		var wg sync.WaitGroup
		for _, u := range users {
			b, err := tl.Import(ctx, u, bytes.NewReader(book))
			if errors.Is(err, store.ErrBookExists) {
				books, berr := tl.Books(ctx, u)
				if berr != nil || len(books) != 1 {
					t.Fatalf("Books = %v, %v", books, berr)
				}
				b, err = books[0], nil
			}
			if err != nil {
				t.Fatal(err)
			}
			wg.Go(func() {
				if err := tl.Delete(ctx, u, b.ID, false); err != nil && !errors.Is(err, store.ErrUnknownBook) {
					t.Errorf("Delete: %v", err)
				}
			})
			wg.Go(func() {
				_, err := tl.Thumbnail(ctx, u, b.ID)
				if err != nil && !errors.Is(err, store.ErrUnknownBook) {
					t.Errorf("Thumbnail: %v", err)
				}
			})
			if round%2 == 0 {
				wg.Go(func() {
					_, err := tl.Import(ctx, u, bytes.NewReader(book))
					if err != nil && !errors.Is(err, store.ErrBookExists) {
						t.Errorf("Import: %v", err)
					}
				})
			}
		}
		wg.Wait()
		if t.Failed() {
			t.FailNow()
		}
		tl.requireConsistent(t, sha(book), users...)
		if tl.exists(t, sha(book), ".none") {
			t.Fatal(".none is cached for a book with a usable cover")
		}
	}
}

// heldBook holds the first Book call armed by hold until release is closed,
// after the store has answered it.
type heldBook struct {
	*store.Store
	hold     *atomic.Bool
	entered  chan struct{}
	released chan struct{}
}

func (h heldBook) Book(ctx context.Context, username string, id string) (store.Book, error) {
	b, err := h.Store.Book(ctx, username, id)
	if h.hold.Swap(false) {
		close(h.entered)
		<-h.released
	}
	return b, err
}

func TestAThumbnailRacingADeleteAndReimportCachesTheCover(t *testing.T) {
	h := heldBook{hold: &atomic.Bool{}, entered: make(chan struct{}), released: make(chan struct{})}
	tl := newLibrary(t, func(st *store.Store) Store {
		h.Store = st
		return h
	})
	book := coverEPUB(t, 600, 900)
	b := tl.importBook(t, reader, book)

	h.hold.Store(true)
	done := make(chan error, 1)
	go func() {
		_, err := tl.Thumbnail(context.Background(), reader, b.ID)
		done <- err
	}()
	<-h.entered
	if err := tl.Delete(context.Background(), reader, b.ID, false); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	if tl.exists(t, b.ID, ".epub") {
		t.Fatal("the original is left after the deletion")
	}
	again := tl.importBook(t, reader, book)
	close(h.released)
	if err := <-done; err != nil && !errors.Is(err, store.ErrUnknownBook) {
		t.Fatalf("Thumbnail: %v", err)
	}
	if tl.exists(t, b.ID, ".none") {
		t.Fatal(".none is cached for a book with a usable cover")
	}
	tl.requireThumbnail(t, reader, again)
	tl.requireConsistent(t, sha(book), reader)
}

func TestDeleteRemovesTheOriginalAndCacheOnlyWhenNoRowNamesThem(t *testing.T) {
	tl := newLibrary(t, nil)
	tl.addUser(t, "other")
	book := coverEPUB(t, 600, 900)
	mine := tl.importBook(t, reader, book)
	if err := tl.Delete(context.Background(), "other", mine.ID, false); !errors.Is(err, store.ErrUnknownBook) {
		t.Fatalf("Delete of another user's book err = %v, want ErrUnknownBook", err)
	}
	theirs := tl.importBook(t, "other", book)
	tl.requireThumbnail(t, reader, mine)

	if err := tl.Delete(context.Background(), reader, mine.ID, false); err != nil {
		t.Fatal(err)
	}
	if !tl.exists(t, mine.ID, ".epub") || !tl.exists(t, mine.ID, ".jpg") {
		t.Fatal("the shared original or cache was removed while a row names it")
	}
	if err := tl.Delete(context.Background(), "other", theirs.ID, false); err != nil {
		t.Fatal(err)
	}
	for _, ext := range []string{".epub", ".jpg", ".none"} {
		if tl.exists(t, mine.ID, ext) {
			t.Errorf("%s is left after the last row went", ext)
		}
	}
	if err := tl.Delete(context.Background(), "other", theirs.ID, false); !errors.Is(err, store.ErrUnknownBook) {
		t.Errorf("second Delete err = %v, want ErrUnknownBook", err)
	}
}
