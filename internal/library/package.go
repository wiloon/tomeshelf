package library

import (
	"context"
	"encoding/json"
	"errors"
	"io/fs"
	"path/filepath"
	"strings"

	"github.com/readium/go-toolkit/pkg/manifest"
	"github.com/readium/go-toolkit/pkg/util/url"
)

// maxPackageFileBytes caps how much of one package file is extracted, whatever
// size its ZIP entry declares.
const maxPackageFileBytes = 64 << 20

// ErrNoFile means the path names no file in the book's package.
var ErrNoFile = errors.New("no such file in the package")

// Manifest returns the RWPM manifest, as JSON, of the book with the id in the
// user's library. It returns store.ErrUnknownBook, having read no file, when
// the user's library has no such book.
func (l *Library) Manifest(ctx context.Context, username string, id int64) ([]byte, error) {
	original, err := l.original(ctx, username, id)
	if err != nil {
		return nil, err
	}
	publication, err := open(ctx, original)
	if err != nil {
		return nil, err
	}
	defer publication.Close()
	return json.Marshal(publication.Manifest)
}

// PackageFile returns the bytes of the file at path in the package of the
// book with the id in the user's library, as stored, and its media type from
// the manifest, or application/octet-stream when the manifest does not list
// it. path is slash-separated from the package root. It returns
// store.ErrUnknownBook, having read no file, when the user's library has no
// such book, and ErrNoFile, having read nothing outside the EPUB, when path
// is not a file in the package.
func (l *Library) PackageFile(ctx context.Context, username string, id int64, path string) ([]byte, string, error) {
	if !fs.ValidPath(path) || path == "." || strings.Contains(path, `\`) {
		return nil, "", ErrNoFile
	}
	original, err := l.original(ctx, username, id)
	if err != nil {
		return nil, "", err
	}
	data, err := readEntry(original, path, maxPackageFileBytes)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, "", ErrNoFile
	}
	if err != nil {
		return nil, "", err
	}
	publication, err := open(ctx, original)
	if err != nil {
		return nil, "", err
	}
	defer publication.Close()
	return data, mediaType(publication.Manifest, path), nil
}

// original returns the path of the original EPUB of the book with the id in
// the user's library.
func (l *Library) original(ctx context.Context, username string, id int64) (string, error) {
	book, err := l.store.Book(ctx, username, id)
	if err != nil {
		return "", err
	}
	return filepath.Join(l.booksDir, book.SHA256+".epub"), nil
}

// mediaType returns the media type the manifest gives the file at path, or
// application/octet-stream.
func mediaType(m manifest.Manifest, path string) string {
	for _, links := range []manifest.LinkList{m.ReadingOrder, m.Resources, m.Links} {
		for _, link := range links.Flatten() {
			href, ok := link.URL(nil, nil).(url.RelativeURL)
			if ok && href.Path() == path && link.MediaType != nil {
				return link.MediaType.String()
			}
		}
	}
	return "application/octet-stream"
}
