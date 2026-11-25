package library

import (
	"archive/zip"
	"context"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"path"
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
func (l *Library) Manifest(ctx context.Context, username string, id string) ([]byte, error) {
	original, err := l.original(ctx, username, id)
	if err != nil {
		return nil, err
	}
	publication, err := open(ctx, original)
	if err != nil {
		return nil, err
	}
	defer publication.Close()
	if err := l.addTextCounts(original, publication.Manifest.ReadingOrder); err != nil {
		return nil, err
	}
	return json.Marshal(publication.Manifest)
}

// addTextCounts gives each reading-order link its document's characters and
// pictures as the properties tomeshelf:characters and tomeshelf:pictures,
// counted on each request (ADR-0010 Page numbers). A document missing from
// the archive counts nothing.
func (l *Library) addTextCounts(epubPath string, links manifest.LinkList) error {
	r, size, err := l.openOriginal(epubPath)
	if err != nil {
		return err
	}
	defer r.Close()
	zr, err := zip.NewReader(r, size)
	if err != nil {
		return err
	}
	byName := make(map[string]*zip.File, len(zr.File))
	for _, f := range zr.File {
		byName[path.Clean("/"+f.Name)] = f
	}
	for i := range links {
		characters, pictures := 0, 0
		if href, ok := links[i].URL(nil, nil).(url.RelativeURL); ok {
			if f := byName[path.Clean("/"+href.Path())]; f != nil {
				if rc, err := f.Open(); err == nil {
					characters, pictures = countText(io.LimitReader(rc, maxPackageFileBytes))
					rc.Close()
				}
			}
		}
		if links[i].Properties == nil {
			links[i].Properties = manifest.Properties{}
		}
		links[i].Properties["tomeshelf:characters"] = characters
		links[i].Properties["tomeshelf:pictures"] = pictures
	}
	return nil
}

// PackageFile returns the bytes of the file at path in the package of the
// book with the id in the user's library, as stored, and its media type from
// the manifest, or application/octet-stream when the manifest does not list
// it. path is slash-separated from the package root. It returns
// store.ErrUnknownBook, having read no file, when the user's library has no
// such book, and ErrNoFile, having read nothing outside the EPUB, when path
// is not a file in the package.
func (l *Library) PackageFile(ctx context.Context, username string, id string, path string) ([]byte, string, error) {
	if !fs.ValidPath(path) || path == "." || strings.Contains(path, `\`) {
		return nil, "", ErrNoFile
	}
	original, err := l.original(ctx, username, id)
	if err != nil {
		return nil, "", err
	}
	data, err := l.readEntry(original, path, maxPackageFileBytes)
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
func (l *Library) original(ctx context.Context, username string, id string) (string, error) {
	book, err := l.store.Book(ctx, username, id)
	if err != nil {
		return "", err
	}
	return filepath.Join(l.booksDir, book.ID+".epub"), nil
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
