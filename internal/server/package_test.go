package server_test

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestOversizedPackageFileIsRejected(t *testing.T) {
	book := coverEPUB(t, "Oversized Package File", nil)
	zr, err := zip.NewReader(bytes.NewReader(book), int64(len(book)))
	if err != nil {
		t.Fatal(err)
	}
	var archive bytes.Buffer
	zw := zip.NewWriter(&archive)
	for _, entry := range zr.File {
		if err := zw.Copy(entry); err != nil {
			t.Fatal(err)
		}
	}
	w, err := zw.Create("OEBPS/oversized.bin")
	if err != nil {
		t.Fatal(err)
	}
	chunk := bytes.Repeat([]byte("oversized-file-data"), 1024)
	for written := 0; written <= 64<<20; written += len(chunk) {
		if _, err := w.Write(chunk); err != nil {
			t.Fatal(err)
		}
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	e := newEnv(t, buildFS())
	cookie := e.setup(t)
	id := e.importedID(t, cookie, archive.Bytes())
	res := e.get(t, packagePath(id, "OEBPS/oversized.bin"), cookie)
	if res.StatusCode != http.StatusInternalServerError {
		t.Errorf("status = %d, want %d", res.StatusCode, http.StatusInternalServerError)
	}
	if got := body(t, res); strings.Contains(got, "oversized-file-data") {
		t.Error("response contains package file bytes")
	}
}

const coverEPUBText = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Text</title></head><body><p>CC0 test text.</p></body></html>`

func manifestPath(id string) string {
	return fmt.Sprintf("/api/books/%s/manifest", id)
}

func packagePath(id string, path string) string {
	return fmt.Sprintf("/api/books/%s/package/%s", id, path)
}

// conditionalGet requests target, with If-None-Match when etag is not empty.
func (e env) conditionalGet(t *testing.T, target string, cookie *http.Cookie, etag string) *http.Response {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, target, nil)
	if cookie != nil {
		req.AddCookie(cookie)
	}
	if etag != "" {
		req.Header.Set("If-None-Match", etag)
	}
	return e.do(t, req)
}

// requireRevalidated checks that res is a 200 with contentType and the
// revalidation headers, and returns its ETag and body.
func requireRevalidated(t *testing.T, res *http.Response, contentType string) (string, string) {
	t.Helper()
	requireStatus(t, res, http.StatusOK)
	for header, want := range map[string]string{
		"Content-Type":           contentType,
		"X-Content-Type-Options": "nosniff",
		"Cache-Control":          "private, no-cache",
	} {
		if got := res.Header.Get(header); got != want {
			t.Errorf("%s: %s = %q, want %q", res.Request.URL.Path, header, got, want)
		}
	}
	etag := res.Header.Get("ETag")
	if etag == "" {
		t.Errorf("%s: no ETag", res.Request.URL.Path)
	}
	return etag, body(t, res)
}

func requireNotModified(t *testing.T, res *http.Response) {
	t.Helper()
	requireStatus(t, res, http.StatusNotModified)
	if b := body(t, res); b != "" {
		t.Errorf("304 body = %d bytes, want none", len(b))
	}
}

func TestTheManifestDescribesTheBookAsRWPM(t *testing.T) {
	e := newEnv(t, buildFS())
	cookie := e.setup(t)
	id := e.importedID(t, cookie, coverEPUB(t, "The Manifest Book", &cover{"cover.jpg", "image/jpeg", jpegImage(t, 60, 90)}))

	etag, raw := requireRevalidated(t, e.conditionalGet(t, manifestPath(id), cookie, ""), "application/webpub+json")
	var manifest struct {
		Metadata struct {
			Title string `json:"title"`
		} `json:"metadata"`
		ReadingOrder []struct {
			Href string `json:"href"`
			Type string `json:"type"`
		} `json:"readingOrder"`
	}
	if err := json.Unmarshal([]byte(raw), &manifest); err != nil {
		t.Fatalf("manifest is not JSON: %v", err)
	}
	if manifest.Metadata.Title != "The Manifest Book" {
		t.Errorf("title = %q, want %q", manifest.Metadata.Title, "The Manifest Book")
	}
	if len(manifest.ReadingOrder) != 1 || manifest.ReadingOrder[0].Href != "OEBPS/text.xhtml" || manifest.ReadingOrder[0].Type != "application/xhtml+xml" {
		t.Errorf("readingOrder = %+v, want OEBPS/text.xhtml as application/xhtml+xml", manifest.ReadingOrder)
	}

	requireNotModified(t, e.conditionalGet(t, manifestPath(id), cookie, etag))
}

func TestPackageFilesAreServedAsIsWithTheirMediaTypeAndSandboxed(t *testing.T) {
	jpg := jpegImage(t, 60, 90)
	e := newEnv(t, buildFS())
	cookie := e.setup(t)
	id := e.importedID(t, cookie, coverEPUB(t, "The Package Book", &cover{"cover.jpg", "image/jpeg", jpg}))

	cases := []struct {
		path, mediaType, data string
	}{
		{"OEBPS/text.xhtml", "application/xhtml+xml", coverEPUBText},
		{"OEBPS/cover.jpg", "image/jpeg", string(jpg)},
		{"mimetype", "application/octet-stream", "application/epub+zip"},
	}
	for _, tc := range cases {
		t.Run(tc.path, func(t *testing.T) {
			res := e.conditionalGet(t, packagePath(id, tc.path), cookie, "")
			etag, got := requireRevalidated(t, res, tc.mediaType)
			if got != tc.data {
				t.Errorf("body = %q, want the package file as-is", got)
			}
			if csp := res.Header.Get("Content-Security-Policy"); csp != "sandbox" {
				t.Errorf("Content-Security-Policy = %q, want sandbox", csp)
			}
			requireNotModified(t, e.conditionalGet(t, packagePath(id, tc.path), cookie, etag))
		})
	}
}

func TestManifestAndPackageFilesAreServedOnlyToTheSignedInOwner(t *testing.T) {
	e := newEnv(t, buildFS())
	admin := e.setup(t)
	other := e.otherUser(t, "other")
	id := e.importedID(t, admin, coverEPUB(t, "The Admin's Book", nil))
	othersID := e.importedID(t, other, coverEPUB(t, "The Other's Book", nil))
	forged := &http.Cookie{Name: "tomeshelf_session", Value: "forged"}

	targets := map[string]func(string) string{
		"manifest": manifestPath,
		"package":  func(id string) string { return packagePath(id, "OEBPS/text.xhtml") },
	}
	for name, target := range targets {
		t.Run(name, func(t *testing.T) {
			etag, _ := requireRevalidated(t, e.conditionalGet(t, target(id), admin, ""), map[string]string{
				"manifest": "application/webpub+json",
				"package":  "application/xhtml+xml",
			}[name])
			for _, inm := range []string{"", etag} {
				requireNoImage(t, e.conditionalGet(t, target(id), nil, inm), http.StatusUnauthorized)
				requireNoImage(t, e.conditionalGet(t, target(id), forged, inm), http.StatusUnauthorized)
				requireNoImage(t, e.conditionalGet(t, target(id), other, inm), http.StatusNotFound)
				requireNoImage(t, e.conditionalGet(t, target(othersID), admin, inm), http.StatusNotFound)
				requireNoImage(t, e.conditionalGet(t, target(absentID), admin, inm), http.StatusNotFound)
			}
			requireNotModified(t, e.conditionalGet(t, target(id), admin, etag))
		})
	}
	requireNoImage(t, e.get(t, "/api/books/abc/manifest", admin), http.StatusNotFound)
	requireNoImage(t, e.get(t, "/api/books/abc/package/OEBPS/text.xhtml", admin), http.StatusNotFound)
}

func TestPackagePathsAreConfinedToThePackage(t *testing.T) {
	e := newEnv(t, buildFS())
	cookie := e.setup(t)
	id := e.importedID(t, cookie, coverEPUB(t, "The Confined Book", nil))
	const secret = "a file outside the EPUB"
	if err := os.WriteFile(filepath.Join(e.dataDir, "secret.txt"), []byte(secret), 0o600); err != nil {
		t.Fatal(err)
	}
	base := fmt.Sprintf("/api/books/%s/package/", id)

	for _, target := range []string{
		base + "OEBPS/missing.xhtml",
		base + "OEBPS",
		base + "OEBPS/",
		base,
		base + "../../../secret.txt",
		base + "OEBPS/../OEBPS/text.xhtml",
		base + "%2e%2e/%2e%2e/%2e%2e/secret.txt",
		base + "OEBPS/%2e%2e/OEBPS/text.xhtml",
		base + "..%2F..%2F..%2Fsecret.txt",
		base + "/" + filepath.Join(e.dataDir, "secret.txt"),
		base + "%2F" + strings.ReplaceAll(filepath.Join(e.dataDir, "secret.txt"), "/", "%2F"),
		base + `OEBPS\text.xhtml`,
		base + "OEBPS%5Ctext.xhtml",
		base + `..\..\..\secret.txt`,
		base + "OEBPS/./text.xhtml",
	} {
		t.Run(target, func(t *testing.T) {
			res := e.get(t, target, cookie)
			requireNoImage(t, res, http.StatusNotFound)
		})
	}
	requireNoImage(t, e.get(t, base+"../../../secret.txt"), http.StatusUnauthorized)
}

// withText replaces the text document of a coverEPUB book.
func withText(t *testing.T, book []byte, xhtml string) []byte {
	t.Helper()
	zr, err := zip.NewReader(bytes.NewReader(book), int64(len(book)))
	if err != nil {
		t.Fatal(err)
	}
	var archive bytes.Buffer
	zw := zip.NewWriter(&archive)
	for _, entry := range zr.File {
		if entry.Name != "OEBPS/text.xhtml" {
			if err := zw.Copy(entry); err != nil {
				t.Fatal(err)
			}
			continue
		}
		w, err := zw.Create(entry.Name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := w.Write([]byte(xhtml)); err != nil {
			t.Fatal(err)
		}
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	return archive.Bytes()
}

// ADR-0010 Page numbers: characters are the non-whitespace UTF-16 code units
// of the body's text without script and style; pictures are img, svg and
// video not inside an svg.
func TestTheManifestCountsEachDocumentsCharactersAndPictures(t *testing.T) {
	e := newEnv(t, buildFS())
	cookie := e.setup(t)
	text := `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Not counted</title><style>p { color: red }</style><script src="a.js"/></head>
<body>
  <p>Héllo  wörld <em>😀</em></p>
  <script>var notCounted = 1;</script>
  <style>p { margin: 0 }</style>
  <p><img src="a.png" alt="not counted"/></p>
  <svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><image xlink:href="a.png"/></svg>
  <video src="v.mp4"></video>
</body></html>`
	id := e.importedID(t, cookie, withText(t, coverEPUB(t, "Counted Book", nil), text))

	res := e.get(t, manifestPath(id), cookie)
	requireStatus(t, res, http.StatusOK)
	var manifest struct {
		ReadingOrder []struct {
			Properties map[string]any `json:"properties"`
		} `json:"readingOrder"`
	}
	if err := json.Unmarshal([]byte(body(t, res)), &manifest); err != nil {
		t.Fatal(err)
	}
	if len(manifest.ReadingOrder) != 1 {
		t.Fatalf("readingOrder has %d entries, want 1", len(manifest.ReadingOrder))
	}
	props := manifest.ReadingOrder[0].Properties
	// "Héllo" 5 + "wörld" 5 + one emoji as 2 UTF-16 code units.
	if got := props["tomeshelf:characters"]; got != float64(12) {
		t.Errorf("tomeshelf:characters = %v, want 12", got)
	}
	if got := props["tomeshelf:pictures"]; got != float64(3) {
		t.Errorf("tomeshelf:pictures = %v, want 3", got)
	}
}
