// Package library imports EPUB files into the library, deletes them, and
// makes their cover thumbnails. Each book's original is the only stored copy, at
// books/<sha256>.epub under the data directory; uploads are staged in tmp/ on
// the same filesystem, and thumbnails are a cache under cache/ (ADR-0007).
package library

import (
	"archive/zip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"

	"github.com/readium/go-toolkit/pkg/archive"
	"github.com/readium/go-toolkit/pkg/asset"
	"github.com/readium/go-toolkit/pkg/mediatype"
	"github.com/readium/go-toolkit/pkg/parser/epub"
	"github.com/readium/go-toolkit/pkg/pub"
	"github.com/readium/go-toolkit/pkg/util/url"

	"github.com/wiloon/tomeshelf/internal/store"
)

// ErrDRM means the book is DRM-encrypted (Adobe ADEPT or Readium LCP).
var ErrDRM = errors.New("the book is DRM-encrypted")

// ParseError is the parser's reason for refusing a file.
type ParseError struct{ Err error }

func (e *ParseError) Error() string { return e.Err.Error() }
func (e *ParseError) Unwrap() error { return e.Err }

// Store keeps the library's metadata. *store.Store implements it.
type Store interface {
	AddBook(ctx context.Context, username string, b store.Book) (store.Book, error)
	Books(ctx context.Context, username string) ([]store.Book, error)
	Book(ctx context.Context, username string, id int64) (store.Book, error)
	DeleteBook(ctx context.Context, username string, id int64) (string, error)
	BookFileNamed(ctx context.Context, sha256 string) (bool, error)
}

// Library is the books in a data directory. Its methods are safe for
// concurrent use.
type Library struct {
	booksDir  string
	tmpDir    string
	coversDir string
	store     Store
	locks     shaLocks
	// openOriginal opens an original for reading its ZIP entries.
	openOriginal func(path string) (readerAtCloser, int64, error)
}

// readerAtCloser is an opened original.
type readerAtCloser interface {
	io.ReaderAt
	io.Closer
}

func openFile(path string) (readerAtCloser, int64, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, 0, err
	}
	info, err := f.Stat()
	if err != nil {
		_ = f.Close()
		return nil, 0, err
	}
	return f, info.Size(), nil
}

// Open prepares books/ and tmp/ in dataDir and empties tmp/, which only
// holds uploads an earlier process did not finish. Cover thumbnails are
// cached in cache/covers/, which is created when a thumbnail is first made.
func Open(dataDir string, st Store) (*Library, error) {
	l := &Library{
		booksDir:     filepath.Join(dataDir, "books"),
		tmpDir:       filepath.Join(dataDir, "tmp"),
		coversDir:    filepath.Join(dataDir, "cache", "covers"),
		store:        st,
		openOriginal: openFile,
	}
	if err := os.RemoveAll(l.tmpDir); err != nil {
		return nil, err
	}
	for _, dir := range []string{l.booksDir, l.tmpDir} {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			return nil, err
		}
	}
	return l, nil
}

// Books returns the user's library.
func (l *Library) Books(ctx context.Context, username string) ([]store.Book, error) {
	return l.store.Books(ctx, username)
}

// Import stages the EPUB read from r, reads its metadata and adds it to the
// user's library. The original is renamed into books/ before its row is
// inserted, both under its SHA-256's lock, which Delete also takes, so a row
// never names a missing file. It returns a *ParseError,
// ErrDRM or store.ErrBookExists for files it refuses, and the reader's or
// ctx's error when the upload does not arrive. Only a book that passed the
// checks leaves its original behind, even when the insert then fails.
func (l *Library) Import(ctx context.Context, username string, r io.Reader) (store.Book, error) {
	staged, sum, err := l.stage(ctx, r)
	if err != nil {
		return store.Book{}, err
	}
	renamed := false
	defer func() {
		if !renamed {
			_ = os.Remove(staged)
		}
	}()

	book, err := parse(ctx, staged)
	if err != nil {
		return store.Book{}, err
	}
	if err := checkDRM(staged); err != nil {
		return store.Book{}, err
	}
	book.SHA256 = sum
	if err := ctx.Err(); err != nil {
		return store.Book{}, err
	}
	unlock := l.locks.lock(sum)
	defer unlock()
	if err := os.Rename(staged, filepath.Join(l.booksDir, sum+".epub")); err != nil {
		return store.Book{}, err
	}
	renamed = true
	return l.store.AddBook(ctx, username, book)
}

// LeftoverError means Delete deleted the book's row but could not remove
// its original or a cache file, which is left behind unreferenced for a
// later import of the same file to reuse (ADR-0007).
type LeftoverError struct{ Err error }

func (e *LeftoverError) Error() string { return "book deleted, files left behind: " + e.Err.Error() }
func (e *LeftoverError) Unwrap() error { return e.Err }

// Delete deletes the book with the id from the user's library. Once no row
// names its original any more, it removes the original and its cache
// files. It returns store.ErrUnknownBook, and changes nothing, when the
// user's library has no such book, and a *LeftoverError when the row is gone
// but a file could not be removed.
func (l *Library) Delete(ctx context.Context, username string, id int64) error {
	book, err := l.store.Book(ctx, username, id)
	if err != nil {
		return err
	}
	unlock := l.locks.lock(book.SHA256)
	defer unlock()
	if _, err := l.store.DeleteBook(ctx, username, id); err != nil {
		return err
	}
	ctx = context.WithoutCancel(ctx)
	named, err := l.store.BookFileNamed(ctx, book.SHA256)
	if err != nil {
		return &LeftoverError{Err: err}
	}
	if named {
		return nil
	}
	var errs []error
	for _, path := range []string{
		filepath.Join(l.coversDir, book.SHA256+".jpg"),
		filepath.Join(l.coversDir, book.SHA256+".none"),
		filepath.Join(l.booksDir, book.SHA256+".epub"),
	} {
		if err := os.Remove(path); err != nil && !errors.Is(err, fs.ErrNotExist) {
			errs = append(errs, err)
		}
	}
	if len(errs) > 0 {
		return &LeftoverError{Err: errors.Join(errs...)}
	}
	return nil
}

// stage copies r into a new file in tmp/ and returns its path and SHA-256.
// The file is removed when the copy fails.
func (l *Library) stage(ctx context.Context, r io.Reader) (string, string, error) {
	f, err := os.CreateTemp(l.tmpDir, "import-*.epub")
	if err != nil {
		return "", "", err
	}
	h := sha256.New()
	_, err = io.Copy(io.MultiWriter(f, h), ctxReader{ctx: ctx, r: r})
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		_ = os.Remove(f.Name())
		return "", "", err
	}
	return f.Name(), hex.EncodeToString(h.Sum(nil)), nil
}

// open parses the EPUB at path with go-toolkit's EPUB parser (ADR-0002). It
// returns a *ParseError for a file the parser refuses.
func open(ctx context.Context, path string) (*pub.Publication, error) {
	u, err := url.FromFilepath(path)
	if err != nil {
		return nil, err
	}
	a := asset.FileWithMediaType(u, &mediatype.EPUB)
	f, err := a.CreateFetcher(ctx, asset.Dependencies{ArchiveFactory: archive.NewArchiveFactory()}, "")
	if err != nil {
		return nil, &ParseError{Err: err}
	}
	builder, err := epub.NewParser(nil).Parse(ctx, a, f)
	if err != nil {
		f.Close()
		return nil, &ParseError{Err: err}
	}
	return builder.Build(), nil
}

// parse reads the title and authors.
func parse(ctx context.Context, path string) (store.Book, error) {
	publication, err := open(ctx, path)
	if err != nil {
		return store.Book{}, err
	}
	defer publication.Close()
	meta := publication.Manifest.Metadata
	book := store.Book{Title: meta.Title(), Authors: []string{}}
	for _, author := range meta.Authors {
		book.Authors = append(book.Authors, author.Name())
	}
	return book, nil
}

// fontObfuscation holds the encryption algorithms that only obfuscate
// embedded fonts: IDPF's and Adobe's. Any other algorithm is DRM.
var fontObfuscation = map[string]bool{
	"http://www.idpf.org/2008/embedding": true,
	"http://ns.adobe.com/pdf/enc#RC":     true,
}

// checkDRM returns ErrDRM when the EPUB at path has a Readium LCP license or
// an encryption.xml entry that is more than font obfuscation, as Adobe ADEPT
// and Readium LCP entries are.
func checkDRM(path string) error {
	zr, err := zip.OpenReader(path)
	if err != nil {
		return &ParseError{Err: err}
	}
	defer zr.Close()
	if _, err := zr.Open("META-INF/license.lcpl"); err == nil {
		return ErrDRM
	}
	f, err := zr.Open("META-INF/encryption.xml")
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return &ParseError{Err: err}
	}
	defer f.Close()
	var enc struct {
		Data []struct {
			Method struct {
				Algorithm string `xml:"Algorithm,attr"`
			} `xml:"EncryptionMethod"`
		} `xml:"EncryptedData"`
	}
	if err := xml.NewDecoder(f).Decode(&enc); err != nil {
		return &ParseError{Err: fmt.Errorf("META-INF/encryption.xml: %w", err)}
	}
	for _, d := range enc.Data {
		if !fontObfuscation[d.Method.Algorithm] {
			return ErrDRM
		}
	}
	return nil
}

// ctxReader stops reading once ctx is done.
type ctxReader struct {
	ctx context.Context
	r   io.Reader
}

func (c ctxReader) Read(p []byte) (int, error) {
	if err := c.ctx.Err(); err != nil {
		return 0, err
	}
	return c.r.Read(p)
}
