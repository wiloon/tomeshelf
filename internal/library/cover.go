package library

import (
	"archive/zip"
	"bytes"
	"compress/flate"
	"context"
	"errors"
	"fmt"
	"image"
	"image/color"
	_ "image/gif"
	"image/jpeg"
	_ "image/png"
	"io"
	"io/fs"
	"os"
	"path/filepath"

	"github.com/readium/go-toolkit/pkg/util/url"

	"github.com/wiloon/tomeshelf/internal/store"
)

// Cover images are untrusted (ADR-0004): only these formats are decoded, the
// extracted bytes and the header's dimensions are capped before decoding,
// and only a re-encoded JPEG is ever served.
const (
	thumbnailWidth = 400
	maxCoverBytes  = 10 << 20
	maxCoverPixels = 40_000_000
	maxCoverSide   = 10_000
)

var coverFormats = map[string]bool{"jpeg": true, "png": true, "gif": true}

// ErrNoCover means the book has no cover a thumbnail can be made from: it
// names none, or the cover is missing, unsupported, too large or corrupt.
// It is a verdict on the original's content, never a failure to read it.
var ErrNoCover = errors.New("the book has no usable cover")

// noCover marks err, a reason found in the original's content, as ErrNoCover.
func noCover(err error) error {
	return fmt.Errorf("%w: %w", ErrNoCover, err)
}

// Thumbnail returns the JPEG cover thumbnail, at most thumbnailWidth pixels
// wide, of the book with the id in the user's library. It returns
// store.ErrUnknownBook, having read no file, when the user's library has no
// such book, and an ErrNoCover when the book has no usable cover. A thumbnail
// missing from the cache is made from the original and cached under its
// SHA-256's lock, once a row is known to still name it; any other failure
// caches nothing, so the next call tries again.
func (l *Library) Thumbnail(ctx context.Context, username string, id string) ([]byte, error) {
	book, err := l.store.Book(ctx, username, id)
	if err != nil {
		return nil, err
	}
	if thumb, err := l.cachedThumbnail(book.ID); thumb != nil || err != nil {
		return thumb, err
	}

	unlock := l.locks.lock(book.ID)
	defer unlock()
	named, err := l.store.BookFileNamed(ctx, book.ID)
	if err != nil {
		return nil, err
	}
	if !named {
		return nil, store.ErrUnknownBook
	}
	if thumb, err := l.cachedThumbnail(book.ID); thumb != nil || err != nil {
		return thumb, err
	}
	original := filepath.Join(l.booksDir, book.ID+".epub")
	if _, err := os.Stat(original); err != nil {
		return nil, err
	}
	thumb, err := l.makeThumbnail(ctx, original)
	if cerr := ctx.Err(); cerr != nil {
		return nil, cerr
	}
	if errors.Is(err, ErrNoCover) {
		if err := l.writeCache(filepath.Join(l.coversDir, book.ID+".none"), nil); err != nil {
			return nil, err
		}
		return nil, err
	}
	if err != nil {
		return nil, err
	}
	if err := l.writeCache(filepath.Join(l.coversDir, book.ID+".jpg"), thumb); err != nil {
		return nil, err
	}
	return thumb, nil
}

// cachedThumbnail returns the cached thumbnail of the original with the
// SHA-256, ErrNoCover when the cache says it has no usable cover, and
// neither when the cache has no answer.
func (l *Library) cachedThumbnail(sum string) ([]byte, error) {
	thumb, err := os.ReadFile(filepath.Join(l.coversDir, sum+".jpg"))
	if err == nil {
		return thumb, nil
	}
	if !errors.Is(err, fs.ErrNotExist) {
		return nil, err
	}
	if _, err := os.Stat(filepath.Join(l.coversDir, sum+".none")); err == nil {
		return nil, ErrNoCover
	} else if !errors.Is(err, fs.ErrNotExist) {
		return nil, err
	}
	return nil, nil
}

// writeCache writes data to path in cache/covers/ through a rename, so a
// concurrent reader never sees a partial file.
func (l *Library) writeCache(path string, data []byte) error {
	if err := os.MkdirAll(l.coversDir, 0o700); err != nil {
		return err
	}
	f, err := os.CreateTemp(l.coversDir, "write-*.tmp")
	if err != nil {
		return err
	}
	_, err = f.Write(data)
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err == nil {
		err = os.Rename(f.Name(), path)
	}
	if err != nil {
		_ = os.Remove(f.Name())
	}
	return err
}

// makeThumbnail reads the cover of the EPUB at path and returns it scaled
// down to thumbnailWidth and encoded as a JPEG.
func (l *Library) makeThumbnail(ctx context.Context, path string) ([]byte, error) {
	name, err := coverEntry(ctx, path)
	if err != nil {
		return nil, err
	}
	data, err := l.readEntry(path, name, maxCoverBytes)
	if errors.Is(err, errBadEntry) {
		return nil, noCover(err)
	}
	if err != nil {
		return nil, err
	}
	cfg, format, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil {
		return nil, noCover(err)
	}
	if !coverFormats[format] {
		return nil, noCover(fmt.Errorf("cover format %s is not supported", format))
	}
	if cfg.Width < 1 || cfg.Height < 1 || cfg.Width > maxCoverSide || cfg.Height > maxCoverSide ||
		cfg.Width*cfg.Height > maxCoverPixels {
		return nil, noCover(fmt.Errorf("cover is %dx%d, over the size limit", cfg.Width, cfg.Height))
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	img, _, err := image.Decode(bytes.NewReader(data))
	if err != nil {
		return nil, noCover(err)
	}
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, scaleToWidth(img, thumbnailWidth), &jpeg.Options{Quality: 85}); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

// coverEntry returns the ZIP entry name of the cover the EPUB's package
// document names, or an ErrNoCover when it names none in the package. Import
// parsed the package already, so a failure to parse it now is not about its
// content and is returned as is.
func coverEntry(ctx context.Context, path string) (string, error) {
	publication, err := open(ctx, path)
	if err != nil {
		return "", err
	}
	defer publication.Close()
	link := publication.Manifest.LinkWithRel("cover")
	if link == nil {
		return "", noCover(errors.New("the package names no cover"))
	}
	href, ok := link.URL(nil, nil).(url.RelativeURL)
	if !ok {
		return "", noCover(errors.New("the cover is not in the package"))
	}
	return href.Path(), nil
}

// errBadEntry marks a readEntry failure that the ZIP's content causes, as
// opposed to a failure to open or read the file.
var errBadEntry = errors.New("bad ZIP entry")

func badEntry(err error) error {
	return fmt.Errorf("%w: %w", errBadEntry, err)
}

// readEntry returns the named entry of the ZIP at path, reading at most limit
// extracted bytes whatever size the entry declares. A directory is reported
// as fs.ErrNotExist. A missing, oversized, corrupt or unsupported entry is
// an errBadEntry; failures to open or read the file are returned as is.
func (l *Library) readEntry(path, name string, limit int64) ([]byte, error) {
	r, size, err := l.openOriginal(path)
	if err != nil {
		return nil, err
	}
	defer r.Close()
	zr, err := zip.NewReader(r, size)
	if err != nil {
		return nil, entryError(err)
	}
	f, err := zr.Open(name)
	if err != nil {
		return nil, entryError(err)
	}
	defer f.Close()
	if info, err := f.Stat(); err != nil {
		return nil, entryError(err)
	} else if info.IsDir() {
		return nil, badEntry(&fs.PathError{Op: "open", Path: name, Err: fs.ErrNotExist})
	}
	data, err := io.ReadAll(io.LimitReader(f, limit+1))
	if err != nil {
		return nil, entryError(err)
	}
	if int64(len(data)) > limit {
		return nil, badEntry(fmt.Errorf("%s is larger than %d bytes", name, limit))
	}
	return data, nil
}

// entryError marks err as an errBadEntry when the ZIP's content causes it:
// a missing entry, an unsupported compression method or corrupt data.
func entryError(err error) error {
	var corrupt flate.CorruptInputError
	if errors.Is(err, fs.ErrNotExist) || errors.Is(err, zip.ErrFormat) || errors.Is(err, zip.ErrChecksum) ||
		errors.Is(err, zip.ErrAlgorithm) || errors.As(err, &corrupt) {
		return badEntry(err)
	}
	return err
}

// scaleToWidth returns src scaled down to width pixels wide, keeping its
// aspect ratio, by averaging the source pixels under each destination pixel.
// A narrower src keeps its size. Transparency is flattened onto white.
func scaleToWidth(src image.Image, width int) *image.RGBA {
	b := src.Bounds()
	sw, sh := b.Dx(), b.Dy()
	w := min(width, sw)
	h := max(1, (sh*w+sw/2)/sw)
	dst := image.NewRGBA(image.Rect(0, 0, w, h))
	for y := range h {
		y0, y1 := y*sh/h, max((y+1)*sh/h, y*sh/h+1)
		for x := range w {
			x0, x1 := x*sw/w, max((x+1)*sw/w, x*sw/w+1)
			var r, g, bl, n uint64
			for sy := y0; sy < y1; sy++ {
				for sx := x0; sx < x1; sx++ {
					cr, cg, cb, ca := src.At(b.Min.X+sx, b.Min.Y+sy).RGBA()
					r += uint64(cr + 0xffff - ca)
					g += uint64(cg + 0xffff - ca)
					bl += uint64(cb + 0xffff - ca)
					n++
				}
			}
			dst.SetRGBA(x, y, color.RGBA{
				R: uint8(r / n >> 8),
				G: uint8(g / n >> 8),
				B: uint8(bl / n >> 8),
				A: 0xff,
			})
		}
	}
	return dst
}
