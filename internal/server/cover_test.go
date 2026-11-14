package server_test

import (
	"archive/zip"
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"io/fs"
	"maps"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

// cover is an EPUB's cover image: its file name in the package and its bytes.
type cover struct {
	name      string
	mediaType string
	data      []byte
}

// coverEPUB returns a hand-made EPUB 3 titled title whose manifest names c
// as the cover image; with c nil it has no cover.
func coverEPUB(t *testing.T, title string, c *cover) []byte {
	t.Helper()
	coverItem := ""
	if c != nil {
		coverItem = fmt.Sprintf(`<item id="cover" href="%s" media-type="%s" properties="cover-image"/>`, c.name, c.mediaType)
	}
	files := []struct {
		name string
		data []byte
	}{
		{"mimetype", []byte("application/epub+zip")},
		{"META-INF/container.xml", []byte(`<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`)},
		{"OEBPS/content.opf", fmt.Appendf(nil, `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="uid">urn:uuid:5e0b2c7a-0001-4000-8000-000000000000</dc:identifier>
    <dc:title>%s</dc:title>
    <dc:language>en</dc:language>
    <meta property="dcterms:modified">2026-11-14T00:00:00Z</meta>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="text" href="text.xhtml" media-type="application/xhtml+xml"/>
    %s
  </manifest>
  <spine><itemref idref="text"/></spine>
</package>`, title, coverItem)},
		{"OEBPS/nav.xhtml", []byte(`<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Contents</title></head>
<body><nav epub:type="toc"><ol><li><a href="text.xhtml">Text</a></li></ol></nav></body></html>`)},
		{"OEBPS/text.xhtml", []byte(`<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Text</title></head><body><p>CC0 test text.</p></body></html>`)},
	}
	if c != nil {
		files = append(files, struct {
			name string
			data []byte
		}{"OEBPS/" + c.name, c.data})
	}
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for _, f := range files {
		method := zip.Deflate
		if f.name == "mimetype" {
			method = zip.Store
		}
		w, err := zw.CreateHeader(&zip.FileHeader{Name: f.name, Method: method})
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

// gradient is a w×h test image whose colours vary across both axes.
func gradient(w, h int) image.Image {
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for y := range h {
		for x := range w {
			img.Set(x, y, color.RGBA{R: uint8(x * 255 / w), G: uint8(y * 255 / h), B: 128, A: 255})
		}
	}
	return img
}

func jpegImage(t *testing.T, w, h int) []byte {
	t.Helper()
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, gradient(w, h), nil); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func pngImage(t *testing.T, w, h int) []byte {
	t.Helper()
	var buf bytes.Buffer
	if err := png.Encode(&buf, gradient(w, h)); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

// grayPNG is a uniform w×h grayscale PNG, which compresses to a few bytes
// per row whatever its size.
func grayPNG(t *testing.T, w, h int) []byte {
	t.Helper()
	var buf bytes.Buffer
	if err := png.Encode(&buf, image.NewGray(image.Rect(0, 0, w, h))); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

// importedID imports book and returns its id.
func (e env) importedID(t *testing.T, cookie *http.Cookie, book []byte) int64 {
	t.Helper()
	res := e.importBook(t, cookie, book)
	requireStatus(t, res, http.StatusCreated)
	var got listedBook
	if err := json.Unmarshal([]byte(body(t, res)), &got); err != nil {
		t.Fatal(err)
	}
	return got.ID
}

func thumbnailPath(id int64) string {
	return fmt.Sprintf("/api/books/%d/thumbnail", id)
}

// thumbnail requests the book's thumbnail, with If-None-Match when etag is
// not empty.
func (e env) thumbnail(t *testing.T, id int64, cookie *http.Cookie, etag string) *http.Response {
	t.Helper()
	req, err := http.NewRequest(http.MethodGet, thumbnailPath(id), nil)
	if err != nil {
		t.Fatal(err)
	}
	if cookie != nil {
		req.AddCookie(cookie)
	}
	if etag != "" {
		req.Header.Set("If-None-Match", etag)
	}
	return e.do(t, req)
}

// requireThumbnail checks that res is a JPEG thumbnail with revalidation
// headers whose size is the srcW×srcH source scaled to at most 400 px wide,
// and returns its ETag and body.
func requireThumbnail(t *testing.T, res *http.Response, srcW, srcH int) (string, string) {
	t.Helper()
	requireStatus(t, res, http.StatusOK)
	for header, want := range map[string]string{
		"Content-Type":           "image/jpeg",
		"X-Content-Type-Options": "nosniff",
		"Cache-Control":          "private, no-cache",
	} {
		if got := res.Header.Get(header); got != want {
			t.Errorf("%s = %q, want %q", header, got, want)
		}
	}
	etag := res.Header.Get("ETag")
	if etag == "" {
		t.Error("no ETag")
	}
	thumb := body(t, res)
	img, err := jpeg.Decode(strings.NewReader(thumb))
	if err != nil {
		t.Fatalf("thumbnail is not a JPEG: %v", err)
	}
	wantW := min(srcW, 400)
	wantH := srcH * wantW / srcW
	got := img.Bounds().Size()
	if got.X != wantW || got.Y < wantH-1 || got.Y > wantH+1 {
		t.Errorf("thumbnail is %dx%d, want %dx%d (±1 px height)", got.X, got.Y, wantW, wantH)
	}
	return etag, thumb
}

func TestACoverIsServedAsARevalidatedJPEGThumbnail(t *testing.T) {
	cases := []struct {
		name       string
		cover      cover
		srcW, srcH int
	}{
		{"large JPEG", cover{"cover.jpg", "image/jpeg", jpegImage(t, 1200, 1800)}, 1200, 1800},
		{"small PNG", cover{"cover.png", "image/png", pngImage(t, 300, 200)}, 300, 200},
	}
	e := newEnv(t, buildFS())
	cookie := e.setup(t)
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			id := e.importedID(t, cookie, coverEPUB(t, tc.name, &tc.cover))
			etag, _ := requireThumbnail(t, e.thumbnail(t, id, cookie, ""), tc.srcW, tc.srcH)

			res := e.thumbnail(t, id, cookie, etag)
			requireStatus(t, res, http.StatusNotModified)
			if b := body(t, res); b != "" {
				t.Errorf("304 body = %d bytes, want none", len(b))
			}
		})
	}
}

// cacheFiles returns the contents of every regular file under the data
// directory's cache/, by path.
func (e env) cacheFiles(t *testing.T) map[string]string {
	t.Helper()
	files := map[string]string{}
	err := filepath.WalkDir(filepath.Join(e.dataDir, "cache"), func(path string, d fs.DirEntry, err error) error {
		if errors.Is(err, fs.ErrNotExist) {
			return nil
		}
		if err != nil || !d.Type().IsRegular() {
			return err
		}
		b, err := os.ReadFile(path)
		files[path] = string(b)
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	return files
}

// otherUser creates a user besides the admin, which only the database can
// do so far, signs it in through the store and returns its session cookie.
func (e env) otherUser(t *testing.T, username string) *http.Cookie {
	t.Helper()
	db, err := sql.Open("sqlite", e.dbPath)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	const hash = "not a real hash"
	var id int64
	if err := db.QueryRow("INSERT INTO users (username, password_hash) VALUES (?, ?) RETURNING id", username, hash).Scan(&id); err != nil {
		t.Fatal(err)
	}
	sess, err := e.store.CreateSession(context.Background(), id, hash)
	if err != nil {
		t.Fatal(err)
	}
	return &http.Cookie{Name: "tomeshelf_session", Value: sess.Token}
}

// requireNoImage checks that res is a JSON error with status, not an image.
func requireNoImage(t *testing.T, res *http.Response, status int) {
	t.Helper()
	requireJSONError(t, res, status)
	if etag := res.Header.Get("ETag"); etag != "" {
		t.Errorf("ETag = %q on a %d, want none", etag, status)
	}
}

func TestThumbnailsAreServedOnlyToTheSignedInOwner(t *testing.T) {
	e := newEnv(t, buildFS())
	admin := e.setup(t)
	other := e.otherUser(t, "other")
	id := e.importedID(t, admin, coverEPUB(t, "The Admin's Book", &cover{"cover.jpg", "image/jpeg", jpegImage(t, 600, 900)}))
	othersID := e.importedID(t, other, coverEPUB(t, "The Other's Book", &cover{"cover.jpg", "image/jpeg", jpegImage(t, 600, 900)}))
	forged := &http.Cookie{Name: "tomeshelf_session", Value: "forged"}

	t.Run("before a thumbnail exists", func(t *testing.T) {
		requireNoImage(t, e.thumbnail(t, id, nil, ""), http.StatusUnauthorized)
		requireNoImage(t, e.thumbnail(t, id, forged, ""), http.StatusUnauthorized)
		requireNoImage(t, e.thumbnail(t, othersID, admin, ""), http.StatusNotFound)
		requireNoImage(t, e.thumbnail(t, 9999, admin, ""), http.StatusNotFound)
		requireNoImage(t, e.get(t, "/api/books/abc/thumbnail", admin), http.StatusNotFound)
		if files := e.cacheFiles(t); len(files) != 0 {
			t.Errorf("cache/ = %v, want no thumbnail made for a refused request", slices.Collect(maps.Keys(files)))
		}
	})

	t.Run("once the thumbnail is cached", func(t *testing.T) {
		etag, _ := requireThumbnail(t, e.thumbnail(t, id, admin, ""), 600, 900)
		cached := e.cacheFiles(t)
		if len(cached) != 1 {
			t.Fatalf("cache/ has %d files after one thumbnail, want 1", len(cached))
		}
		for _, inm := range []string{"", etag} {
			requireNoImage(t, e.thumbnail(t, id, nil, inm), http.StatusUnauthorized)
			requireNoImage(t, e.thumbnail(t, id, forged, inm), http.StatusUnauthorized)
			requireNoImage(t, e.thumbnail(t, id, other, inm), http.StatusNotFound)
		}
		if got := e.cacheFiles(t); !maps.Equal(got, cached) {
			t.Error("cache/ changed after refused requests")
		}
		requireStatus(t, e.thumbnail(t, id, admin, etag), http.StatusNotModified)
	})
}

func TestADeletedCacheIsRegeneratedFromTheOriginal(t *testing.T) {
	e := newEnv(t, buildFS())
	cookie := e.setup(t)
	book := coverEPUB(t, "Regenerated", &cover{"cover.jpg", "image/jpeg", jpegImage(t, 800, 1200)})
	id := e.importedID(t, cookie, book)
	_, first := requireThumbnail(t, e.thumbnail(t, id, cookie, ""), 800, 1200)
	listed := e.books(t, cookie)

	if err := os.RemoveAll(filepath.Join(e.dataDir, "cache")); err != nil {
		t.Fatal(err)
	}
	if _, again := requireThumbnail(t, e.thumbnail(t, id, cookie, ""), 800, 1200); again != first {
		t.Error("the regenerated thumbnail differs from the first")
	}
	files := e.cacheFiles(t)
	if len(files) != 1 {
		t.Errorf("cache/ has %d files after regenerating, want the thumbnail", len(files))
	}
	for _, f := range files {
		if f != first {
			t.Error("the cached file is not the thumbnail served")
		}
	}
	if got := e.books(t, cookie); !slices.EqualFunc(got, listed, func(a, b listedBook) bool {
		return a.ID == b.ID && a.Title == b.Title && slices.Equal(a.Authors, b.Authors)
	}) {
		t.Errorf("list after regenerating = %+v, want %+v", got, listed)
	}
	e.requireOnly(t, book)
}

// requireNoCover checks that res is the "no cover" answer.
func requireNoCover(t *testing.T, res *http.Response) {
	t.Helper()
	requireStatus(t, res, http.StatusNotFound)
	if got, want := jsonError(t, res), "This book has no cover."; got != want {
		t.Errorf("error = %q, want %q", got, want)
	}
}

func TestBooksWithoutAUsableCoverAnswerNoCoverAndStayListed(t *testing.T) {
	padded := append(jpegImage(t, 100, 150), make([]byte, 11<<20)...)
	books := map[string][]byte{
		"no cover":            coverEPUB(t, "No Cover", nil),
		"SVG cover":           coverEPUB(t, "SVG Cover", &cover{"cover.svg", "image/svg+xml", []byte(`<svg xmlns="http://www.w3.org/2000/svg" width="400" height="600"><rect width="400" height="600"/></svg>`)}),
		"corrupt cover":       fixture(t, "cover-corrupt.epub"),
		"side over 10,000 px": coverEPUB(t, "Wide Cover", &cover{"cover.png", "image/png", grayPNG(t, 10_001, 2)}),
		"over 40 megapixels":  coverEPUB(t, "Huge Cover", &cover{"cover.png", "image/png", grayPNG(t, 6_400, 6_300)}),
		"over 10 MiB":         coverEPUB(t, "Padded Cover", &cover{"cover.jpg", "image/jpeg", padded}),
	}
	if n := len(books["over 10 MiB"]); n > 1<<20 {
		t.Fatalf("the padded cover's EPUB is %d bytes, want a small ZIP entry that expands past 10 MiB", n)
	}
	e := newEnv(t, buildFS())
	cookie := e.setup(t)
	for name, book := range books {
		t.Run(name, func(t *testing.T) {
			id := e.importedID(t, cookie, book)
			requireNoCover(t, e.thumbnail(t, id, cookie, ""))
			requireNoCover(t, e.thumbnail(t, id, cookie, ""))
			if !slices.ContainsFunc(e.books(t, cookie), func(b listedBook) bool { return b.ID == id }) {
				t.Errorf("book %d is not listed", id)
			}
		})
	}
}
