package library

import (
	"archive/zip"
	"context"
	"errors"
	"path"

	"github.com/readium/go-toolkit/pkg/util/url"

	"github.com/wiloon/tomeshelf/internal/store"
)

// ReadingPosition returns the user's stored position for the book.
func (l *Library) ReadingPosition(ctx context.Context, username string, bookID string) (store.ReadingPosition, error) {
	return l.store.ReadingPosition(ctx, username, bookID)
}

// SaveReadingPosition stores a reading position for the book.
func (l *Library) SaveReadingPosition(ctx context.Context, username string, bookID string, tabID string, sequence int64, p store.ReadingPosition) (store.SaveReadingPositionResult, error) {
	return l.store.SaveReadingPosition(ctx, username, bookID, tabID, sequence, p)
}

// ErrBadHref means the href is not in the book's reading order.
var ErrBadHref = errors.New("href is not in the reading order")

// TotalProgression returns the book-wide progression for a document href and
// its within-document progression, weighted by each reading-order document's
// uncompressed size in the EPUB (ADR-0005). It returns store.ErrUnknownBook
// when the user's library has no such book, and ErrBadHref when href names no
// reading-order document.
func (l *Library) TotalProgression(ctx context.Context, username string, id string, href string, progression float64) (float64, error) {
	original, err := l.original(ctx, username, id)
	if err != nil {
		return 0, err
	}
	publication, err := open(ctx, original)
	if err != nil {
		return 0, err
	}
	defer publication.Close()

	submitted, err := url.RelativeURLFromString(href)
	if err != nil {
		return 0, ErrBadHref
	}
	index := -1
	hrefs := make([]string, 0, len(publication.Manifest.ReadingOrder))
	for i, link := range publication.Manifest.ReadingOrder {
		h, ok := link.URL(nil, nil).(url.RelativeURL)
		if !ok {
			continue
		}
		p := h.Path()
		hrefs = append(hrefs, p)
		if pathsEqual(p, submitted.Path()) {
			index = i
		}
	}
	if index < 0 {
		return 0, ErrBadHref
	}

	sizes, err := l.entrySizes(original, hrefs)
	if err != nil {
		return 0, err
	}
	return weightedProgression(sizes, index, progression), nil
}

func pathsEqual(a, b string) bool {
	return path.Clean("/"+a) == path.Clean("/"+b)
}

func weightedProgression(sizes []int64, index int, progression float64) float64 {
	if progression < 0 {
		progression = 0
	}
	if progression > 1 {
		progression = 1
	}
	var total, before int64
	for i, size := range sizes {
		total += size
		if i < index {
			before += size
		}
	}
	if total == 0 {
		n := float64(len(sizes))
		if n == 0 {
			return 0
		}
		return (float64(index) + progression) / n
	}
	return (float64(before) + progression*float64(sizes[index])) / float64(total)
}

func (l *Library) entrySizes(epubPath string, names []string) ([]int64, error) {
	r, size, err := l.openOriginal(epubPath)
	if err != nil {
		return nil, err
	}
	defer r.Close()
	zr, err := zip.NewReader(r, size)
	if err != nil {
		return nil, err
	}
	byName := make(map[string]int64, len(zr.File))
	for _, f := range zr.File {
		byName[path.Clean("/"+f.Name)] = int64(f.UncompressedSize64)
	}
	sizes := make([]int64, len(names))
	for i, name := range names {
		sizes[i] = byName[path.Clean("/"+name)]
	}
	return sizes, nil
}
