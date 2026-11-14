package server_test

import (
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"

	"github.com/wiloon/tomeshelf/internal/server"
)

const shellHTML = `<!doctype html><html><head><title>tomeshelf</title></head><body><div id="root"></div></body></html>`

func buildFS() fstest.MapFS {
	return fstest.MapFS{
		"index.html":             {Data: []byte(shellHTML)},
		"assets/index-abc123.js": {Data: []byte(`console.log("app")`)},
		"assets/index-def456.css": {
			Data: []byte(`body{margin:0}`),
		},
	}
}

func get(t *testing.T, h http.Handler, path string) *http.Response {
	t.Helper()
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))
	return rec.Result()
}

func body(t *testing.T, res *http.Response) string {
	t.Helper()
	b, err := io.ReadAll(res.Body)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func newHandler(t *testing.T, build fstest.MapFS) http.Handler {
	t.Helper()
	return server.New(build, slog.New(slog.DiscardHandler))
}

func TestRootServesShell(t *testing.T) {
	res := get(t, newHandler(t, buildFS()), "/")
	if res.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", res.StatusCode)
	}
	if ct := res.Header.Get("Content-Type"); !strings.HasPrefix(ct, "text/html") {
		t.Errorf("Content-Type = %q, want text/html", ct)
	}
	if got := body(t, res); got != shellHTML {
		t.Errorf("body = %q, want the shell's index.html", got)
	}
}

func TestHashedAssetIsServedWithItsContentType(t *testing.T) {
	cases := map[string]struct{ ctype, body string }{
		"/assets/index-abc123.js":  {"text/javascript", `console.log("app")`},
		"/assets/index-def456.css": {"text/css", `body{margin:0}`},
	}
	h := newHandler(t, buildFS())
	for path, want := range cases {
		res := get(t, h, path)
		if res.StatusCode != http.StatusOK {
			t.Fatalf("%s: status = %d, want 200", path, res.StatusCode)
		}
		if ct := res.Header.Get("Content-Type"); !strings.HasPrefix(ct, want.ctype) {
			t.Errorf("%s: Content-Type = %q, want %s", path, ct, want.ctype)
		}
		if got := body(t, res); got != want.body {
			t.Errorf("%s: body = %q, want %q", path, got, want.body)
		}
	}
}

func TestUnknownNonAssetPathFallsBackToShell(t *testing.T) {
	res := get(t, newHandler(t, buildFS()), "/library")
	if res.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", res.StatusCode)
	}
	if ct := res.Header.Get("Content-Type"); !strings.HasPrefix(ct, "text/html") {
		t.Errorf("Content-Type = %q, want text/html", ct)
	}
	if got := body(t, res); got != shellHTML {
		t.Errorf("body = %q, want the shell's index.html", got)
	}
}

func TestMissingAssetIsNotFound(t *testing.T) {
	res := get(t, newHandler(t, buildFS()), "/assets/missing-000.js")
	if res.StatusCode != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", res.StatusCode)
	}
}

func TestHealthz(t *testing.T) {
	res := get(t, newHandler(t, fstest.MapFS{}), "/healthz")
	if res.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", res.StatusCode)
	}
	if got := body(t, res); got != "ok" {
		t.Errorf("body = %q, want ok", got)
	}
}

func TestReadyzWithBuild(t *testing.T) {
	res := get(t, newHandler(t, buildFS()), "/readyz")
	if res.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", res.StatusCode)
	}
	if got := body(t, res); got != "ok" {
		t.Errorf("body = %q, want ok", got)
	}
}

func TestReadyzWithoutIndexHTML(t *testing.T) {
	build := fstest.MapFS{"assets/index-abc123.js": {Data: []byte("x")}}
	res := get(t, newHandler(t, build), "/readyz")
	if res.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", res.StatusCode)
	}
}

func parseCSP(header string) map[string][]string {
	directives := map[string][]string{}
	for part := range strings.SplitSeq(header, ";") {
		fields := strings.Fields(part)
		if len(fields) == 0 {
			continue
		}
		directives[strings.ToLower(fields[0])] = fields[1:]
	}
	return directives
}

func TestShellResponsesCarryCSP(t *testing.T) {
	h := newHandler(t, buildFS())
	for _, path := range []string{"/", "/library"} {
		header := get(t, h, path).Header.Values("Content-Security-Policy")
		if len(header) != 1 {
			t.Fatalf("%s: got %d Content-Security-Policy headers, want 1", path, len(header))
		}
		csp := parseCSP(header[0])
		for name, want := range map[string]string{
			"default-src": "'self'",
			"script-src":  "'self'",
			"object-src":  "'none'",
			"base-uri":    "'none'",
		} {
			sources, ok := csp[name]
			if !ok {
				t.Errorf("%s: CSP has no %s directive: %q", path, name, header[0])
				continue
			}
			if len(sources) != 1 || sources[0] != want {
				t.Errorf("%s: %s = %v, want exactly [%s]", path, name, sources, want)
			}
		}
		for _, name := range []string{"script-src-elem", "script-src-attr"} {
			if _, ok := csp[name]; ok {
				t.Errorf("%s: CSP has %s directive, want none: %q", path, name, header[0])
			}
		}
	}
}
