package server_test

import (
	"context"
	"database/sql"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"testing/fstest"
	"time"

	"github.com/wiloon/tomeshelf/internal/library"
	"github.com/wiloon/tomeshelf/internal/password"
	"github.com/wiloon/tomeshelf/internal/server"
	"github.com/wiloon/tomeshelf/internal/store"
)

const shellHTML = `<!doctype html><html><head><title>tomeshelf</title></head><body><div id="root"></div></body></html>`

const (
	adminName     = "admin"
	adminPassword = "correct horse battery staple"
)

func buildFS() fstest.MapFS {
	return fstest.MapFS{
		"index.html":             {Data: []byte(shellHTML)},
		"assets/index-abc123.js": {Data: []byte(`console.log("app")`)},
		"assets/index-def456.css": {
			Data: []byte(`body{margin:0}`),
		},
	}
}

type env struct {
	h       http.Handler
	store   *store.Store
	dbPath  string
	dataDir string
}

type envOptions struct {
	accounts     func(*store.Store) server.Accounts
	books        func(*store.Store) library.Store
	maxBookBytes int64
	dataDir      string
}

const defaultMaxBookBytes = 200 << 20

func openEnv(t *testing.T, build fstest.MapFS, opts envOptions) env {
	t.Helper()
	if opts.dataDir == "" {
		opts.dataDir = t.TempDir()
	}
	if opts.maxBookBytes == 0 {
		opts.maxBookBytes = defaultMaxBookBytes
	}
	path := filepath.Join(opts.dataDir, "tomeshelf.db")
	st, err := store.Open(context.Background(), path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	var accounts server.Accounts = st
	if opts.accounts != nil {
		accounts = opts.accounts(st)
	}
	var books library.Store = st
	if opts.books != nil {
		books = opts.books(st)
	}
	lib, err := library.Open(opts.dataDir, books)
	if err != nil {
		t.Fatal(err)
	}
	h := server.New(build, slog.New(slog.DiscardHandler), accounts, st, lib, opts.maxBookBytes)
	return env{h: h, store: st, dbPath: path, dataDir: opts.dataDir}
}

func newEnvWith(t *testing.T, build fstest.MapFS, wrap func(*store.Store) server.Accounts) env {
	t.Helper()
	return openEnv(t, build, envOptions{accounts: wrap})
}

func newEnv(t *testing.T, build fstest.MapFS) env {
	t.Helper()
	return newEnvWith(t, build, nil)
}

func (e env) do(t *testing.T, req *http.Request) *http.Response {
	t.Helper()
	rec := httptest.NewRecorder()
	e.h.ServeHTTP(rec, req)
	res := rec.Result()
	res.Request = req
	return res
}

func (e env) get(t *testing.T, path string, cookies ...*http.Cookie) *http.Response {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, path, nil)
	for _, c := range cookies {
		req.AddCookie(c)
	}
	return e.do(t, req)
}

func credentials(username, pw string) string {
	b, _ := json.Marshal(map[string]string{"username": username, "password": pw})
	return string(b)
}

func jsonRequest(method, path, body string) *http.Request {
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	return req
}

func (e env) setup(t *testing.T) *http.Cookie {
	t.Helper()
	res := e.do(t, jsonRequest(http.MethodPost, "/api/setup", credentials(adminName, adminPassword)))
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("setup status = %d, want 201", res.StatusCode)
	}
	return sessionCookie(t, res)
}

func (e env) count(t *testing.T, table string) int {
	t.Helper()
	db, err := sql.Open("sqlite", e.dbPath)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	var n int
	if err := db.QueryRow("SELECT count(*) FROM " + table).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func sessionCookie(t *testing.T, res *http.Response) *http.Cookie {
	t.Helper()
	cookies := res.Cookies()
	if len(cookies) != 1 || cookies[0].Value == "" {
		t.Fatalf("Set-Cookie = %v, want one session cookie", res.Header.Values("Set-Cookie"))
	}
	return cookies[0]
}

func requireNoCookie(t *testing.T, res *http.Response) {
	t.Helper()
	if sc := res.Header.Values("Set-Cookie"); len(sc) != 0 {
		t.Errorf("Set-Cookie = %v, want none", sc)
	}
}

func requireStatus(t *testing.T, res *http.Response, want int) {
	t.Helper()
	if res.StatusCode != want {
		t.Fatalf("%s %s: status = %d, want %d", res.Request.Method, res.Request.URL.Path, res.StatusCode, want)
	}
}

func requireRedirect(t *testing.T, res *http.Response, location string) {
	t.Helper()
	requireStatus(t, res, http.StatusSeeOther)
	if got := res.Header.Get("Location"); got != location {
		t.Errorf("%s: Location = %q, want %q", res.Request.URL.Path, got, location)
	}
}

func requireJSONError(t *testing.T, res *http.Response, want int) {
	t.Helper()
	requireStatus(t, res, want)
	if ct := res.Header.Get("Content-Type"); !strings.HasPrefix(ct, "application/json") {
		t.Errorf("Content-Type = %q, want application/json", ct)
	}
	var e struct{ Error string }
	if err := json.Unmarshal([]byte(body(t, res)), &e); err != nil || e.Error == "" {
		t.Errorf("body is not a JSON error: %v", err)
	}
}

func me(t *testing.T, e env, c *http.Cookie) string {
	t.Helper()
	res := e.get(t, "/api/me", c)
	requireStatus(t, res, http.StatusOK)
	var got struct{ Username string }
	if err := json.Unmarshal([]byte(body(t, res)), &got); err != nil {
		t.Fatal(err)
	}
	return got.Username
}

func signIn(t *testing.T, e env, username, pw string) *http.Response {
	t.Helper()
	return e.do(t, jsonRequest(http.MethodPost, "/api/session", credentials(username, pw)))
}

func body(t *testing.T, res *http.Response) string {
	t.Helper()
	b, err := io.ReadAll(res.Body)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func TestBeforeSetupPagesLeadToSetupAndPublicRoutesStayReachable(t *testing.T) {
	e := newEnv(t, buildFS())
	requireRedirect(t, e.get(t, "/"), "/setup")
	requireRedirect(t, e.get(t, "/library"), "/setup")
	requireJSONError(t, e.get(t, "/api/me"), http.StatusUnauthorized)
	requireJSONError(t, e.get(t, "/api/books"), http.StatusUnauthorized)
	for _, path := range []string{"/healthz", "/readyz", "/assets/index-abc123.js", "/setup", "/signin"} {
		requireStatus(t, e.get(t, path), http.StatusOK)
	}
	if got := body(t, e.get(t, "/setup")); got != shellHTML {
		t.Errorf("/setup body = %q, want the shell", got)
	}
}

func TestSetupCreatesTheAdminAndSignsIn(t *testing.T) {
	e := newEnv(t, buildFS())
	cookie := e.setup(t)
	if got := me(t, e, cookie); got != adminName {
		t.Errorf("/api/me username = %q, want %q", got, adminName)
	}

	_, hash, err := e.store.PasswordHash(context.Background(), adminName)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(hash, "$argon2id$") || strings.Contains(hash, adminPassword) {
		t.Errorf("stored password = %q, want an argon2id hash without the password", hash)
	}

	res := e.do(t, jsonRequest(http.MethodPost, "/api/setup", credentials(adminName, "another password")))
	requireJSONError(t, res, http.StatusConflict)
	requireNoCookie(t, res)
	if _, after, _ := e.store.PasswordHash(context.Background(), adminName); after != hash {
		t.Errorf("second setup changed the stored hash")
	}
}

func TestSetupNeedsUsernameAndPassword(t *testing.T) {
	e := newEnv(t, buildFS())
	for _, b := range []string{credentials("", "pw"), credentials("admin", ""), `not json`} {
		res := e.do(t, jsonRequest(http.MethodPost, "/api/setup", b))
		requireJSONError(t, res, http.StatusBadRequest)
		requireNoCookie(t, res)
	}
	if n := e.count(t, "users"); n != 0 {
		t.Errorf("users = %d, want 0", n)
	}
}

func TestConcurrentSetupCreatesExactlyOneAdmin(t *testing.T) {
	e := newEnv(t, buildFS())
	const n = 8
	results := make([]*http.Response, n)
	var wg sync.WaitGroup
	for i := range n {
		wg.Go(func() {
			rec := httptest.NewRecorder()
			e.h.ServeHTTP(rec, jsonRequest(http.MethodPost, "/api/setup", credentials("admin"+string(rune('a'+i)), "pw")))
			results[i] = rec.Result()
		})
	}
	wg.Wait()

	created, conflicts := 0, 0
	for _, res := range results {
		switch res.StatusCode {
		case http.StatusCreated:
			created++
		case http.StatusConflict:
			conflicts++
			requireNoCookie(t, res)
		default:
			t.Errorf("setup status = %d, want 201 or 409", res.StatusCode)
		}
	}
	if created != 1 || conflicts != n-1 {
		t.Errorf("created = %d, conflicts = %d; want 1 and %d", created, conflicts, n-1)
	}
	if users := e.count(t, "users"); users != 1 {
		t.Errorf("users = %d, want 1", users)
	}
}

func TestAfterSetupSignedOutPagesLeadToSignIn(t *testing.T) {
	e := newEnv(t, buildFS())
	cookie := e.setup(t)

	requireRedirect(t, e.get(t, "/"), "/signin")
	requireRedirect(t, e.get(t, "/books/1/read/1"), "/signin")
	requireRedirect(t, e.get(t, "/books/1/read/1.5"), "/signin")
	requireRedirect(t, e.get(t, "/setup"), "/signin")
	requireJSONError(t, e.get(t, "/api/me"), http.StatusUnauthorized)
	requireStatus(t, e.get(t, "/signin"), http.StatusOK)

	requireRedirect(t, e.get(t, "/setup", cookie), "/")
	requireRedirect(t, e.get(t, "/signin", cookie), "/")
	requireJSONError(t, e.get(t, "/api/nothing-here", cookie), http.StatusNotFound)
}

func TestSignIn(t *testing.T) {
	e := newEnv(t, buildFS())
	setupCookie := e.setup(t)

	req := jsonRequest(http.MethodPost, "/api/session", credentials(adminName, adminPassword))
	req.AddCookie(setupCookie)
	res := e.do(t, req)
	requireStatus(t, res, http.StatusNoContent)
	cookie := sessionCookie(t, res)
	if cookie.Value == setupCookie.Value {
		t.Error("sign-in reused the session token the request sent")
	}
	if got := me(t, e, cookie); got != adminName {
		t.Errorf("/api/me username = %q, want %q", got, adminName)
	}

	for name, res := range map[string]*http.Response{
		"wrong password": signIn(t, e, adminName, "wrong"),
		"unknown user":   signIn(t, e, "nobody", adminPassword),
	} {
		t.Run(name, func(t *testing.T) {
			requireJSONError(t, res, http.StatusUnauthorized)
			requireNoCookie(t, res)
		})
	}
}

func TestSessionCookieAttributes(t *testing.T) {
	e := newEnv(t, buildFS())
	setupRes := e.do(t, jsonRequest(http.MethodPost, "/api/setup", credentials(adminName, adminPassword)))
	requireStatus(t, setupRes, http.StatusCreated)

	httpsReq := jsonRequest(http.MethodPost, "/api/session", credentials(adminName, adminPassword))
	httpsReq.Header.Set("X-Forwarded-Proto", "https")

	for name, tc := range map[string]struct {
		res    *http.Response
		secure bool
	}{
		"setup":                {setupRes, false},
		"sign-in":              {signIn(t, e, adminName, adminPassword), false},
		"sign-in behind https": {e.do(t, httpsReq), true},
	} {
		t.Run(name, func(t *testing.T) {
			c := sessionCookie(t, tc.res)
			if !c.HttpOnly {
				t.Error("cookie is not HttpOnly")
			}
			if c.SameSite != http.SameSiteLaxMode {
				t.Errorf("SameSite = %v, want Lax", c.SameSite)
			}
			if c.Path != "/" {
				t.Errorf("Path = %q, want /", c.Path)
			}
			if c.Secure != tc.secure {
				t.Errorf("Secure = %v, want %v", c.Secure, tc.secure)
			}
		})
	}
}

func TestSignOutEndsTheSessionOnTheServer(t *testing.T) {
	e := newEnv(t, buildFS())
	cookie := e.setup(t)

	req := httptest.NewRequest(http.MethodDelete, "/api/session", nil)
	req.AddCookie(cookie)
	requireStatus(t, e.do(t, req), http.StatusNoContent)
	requireJSONError(t, e.get(t, "/api/me", cookie), http.StatusUnauthorized)

	requireStatus(t, e.do(t, httptest.NewRequest(http.MethodDelete, "/api/session", nil)), http.StatusNoContent)
}

func TestSessionExpiresAfterThirtyDays(t *testing.T) {
	e := newEnv(t, buildFS())
	now := time.Date(2026, 1, 1, 12, 0, 0, 0, time.UTC)
	e.store.Now = func() time.Time { return now }
	cookie := e.setup(t)

	now = now.Add(30*24*time.Hour - time.Second)
	if got := me(t, e, cookie); got != adminName {
		t.Fatalf("/api/me just before expiry = %q, want %q", got, adminName)
	}
	now = now.Add(time.Second)
	requireJSONError(t, e.get(t, "/api/me", cookie), http.StatusUnauthorized)
	requireRedirect(t, e.get(t, "/", cookie), "/signin")
}

func TestCrossOriginBrowserRequestsAreRejected(t *testing.T) {
	crossSite := func(req *http.Request) *http.Request {
		req.Header.Set("Sec-Fetch-Site", "cross-site")
		return req
	}
	otherOrigin := func(req *http.Request) *http.Request {
		req.Header.Set("Origin", "http://evil.example")
		return req
	}
	sameSite := func(req *http.Request) *http.Request {
		req.Header.Set("Sec-Fetch-Site", "same-origin")
		return req
	}
	sameOrigin := func(req *http.Request) *http.Request {
		req.Header.Set("Origin", "http://"+req.Host)
		return req
	}

	e := newEnv(t, buildFS())
	for name, mark := range map[string]func(*http.Request) *http.Request{"Sec-Fetch-Site": crossSite, "Origin": otherOrigin} {
		res := e.do(t, mark(jsonRequest(http.MethodPost, "/api/setup", credentials(adminName, adminPassword))))
		requireStatus(t, res, http.StatusForbidden)
		requireNoCookie(t, res)
		if n := e.count(t, "users"); n != 0 {
			t.Fatalf("cross-origin setup by %s: users = %d, want 0", name, n)
		}
	}
	res := e.do(t, sameSite(jsonRequest(http.MethodPost, "/api/setup", credentials(adminName, adminPassword))))
	requireStatus(t, res, http.StatusCreated)
	cookie := sessionCookie(t, res)

	sessions := e.count(t, "sessions")
	for name, mark := range map[string]func(*http.Request) *http.Request{"Sec-Fetch-Site": crossSite, "Origin": otherOrigin} {
		res := e.do(t, mark(jsonRequest(http.MethodPost, "/api/session", credentials(adminName, adminPassword))))
		requireStatus(t, res, http.StatusForbidden)
		requireNoCookie(t, res)
		if n := e.count(t, "sessions"); n != sessions {
			t.Fatalf("cross-origin sign-in by %s: sessions = %d, want %d", name, n, sessions)
		}
	}
	for _, mark := range []func(*http.Request) *http.Request{sameSite, sameOrigin} {
		res := e.do(t, mark(jsonRequest(http.MethodPost, "/api/session", credentials(adminName, adminPassword))))
		requireStatus(t, res, http.StatusNoContent)
	}

	signOut := httptest.NewRequest(http.MethodDelete, "/api/session", nil)
	signOut.AddCookie(cookie)
	requireStatus(t, e.do(t, crossSite(signOut)), http.StatusForbidden)
	if got := me(t, e, cookie); got != adminName {
		t.Fatalf("session after cross-site sign-out = %q, want it still valid", got)
	}
	signOut = httptest.NewRequest(http.MethodDelete, "/api/session", nil)
	signOut.AddCookie(cookie)
	requireStatus(t, e.do(t, sameOrigin(signOut)), http.StatusNoContent)
	requireJSONError(t, e.get(t, "/api/me", cookie), http.StatusUnauthorized)
}

// resetBeforeSessionInsert resets the password after sign-in has verified it
// against the hash it read, and before sign-in inserts the session.
type resetBeforeSessionInsert struct {
	*store.Store
	t *testing.T
}

func (r resetBeforeSessionInsert) CreateSession(ctx context.Context, userID int64, passwordHash string) (store.Session, error) {
	newHash, err := password.Hash("a new password")
	if err != nil {
		r.t.Fatal(err)
	}
	if err := r.ResetPassword(ctx, adminName, newHash); err != nil {
		r.t.Fatal(err)
	}
	return r.Store.CreateSession(ctx, userID, passwordHash)
}

func TestSignInRacingAResetAnswers401WithoutCookie(t *testing.T) {
	e := newEnvWith(t, buildFS(), func(st *store.Store) server.Accounts {
		return resetBeforeSessionInsert{Store: st, t: t}
	})
	e.setup(t)

	res := signIn(t, e, adminName, adminPassword)
	requireJSONError(t, res, http.StatusUnauthorized)
	requireNoCookie(t, res)
	if n := e.count(t, "sessions"); n != 0 {
		t.Errorf("sessions = %d, want 0", n)
	}
}

func TestResetAfterSetupEndsTheSetupSession(t *testing.T) {
	e := newEnv(t, buildFS())
	cookie := e.setup(t)
	if err := e.store.ResetPassword(context.Background(), adminName, "new-hash"); err != nil {
		t.Fatal(err)
	}
	requireJSONError(t, e.get(t, "/api/me", cookie), http.StatusUnauthorized)
}

func TestSignedInRootServesShell(t *testing.T) {
	e := newEnv(t, buildFS())
	cookie := e.setup(t)
	// The Navigator answers every reading URL, even one whose n looks like
	// a file name.
	for _, path := range []string{"/", "/library", "/books/1/read/2", "/books/1/read/1.5", "/books/x/read/a.xhtml"} {
		res := e.get(t, path, cookie)
		requireStatus(t, res, http.StatusOK)
		if ct := res.Header.Get("Content-Type"); !strings.HasPrefix(ct, "text/html") {
			t.Errorf("%s: Content-Type = %q, want text/html", path, ct)
		}
		if got := body(t, res); got != shellHTML {
			t.Errorf("%s: body = %q, want the shell's index.html", path, got)
		}
	}
}

func TestHashedAssetIsServedWithItsContentType(t *testing.T) {
	cases := map[string]struct{ ctype, body string }{
		"/assets/index-abc123.js":  {"text/javascript", `console.log("app")`},
		"/assets/index-def456.css": {"text/css", `body{margin:0}`},
	}
	e := newEnv(t, buildFS())
	for path, want := range cases {
		res := e.get(t, path)
		requireStatus(t, res, http.StatusOK)
		if ct := res.Header.Get("Content-Type"); !strings.HasPrefix(ct, want.ctype) {
			t.Errorf("%s: Content-Type = %q, want %s", path, ct, want.ctype)
		}
		if got := body(t, res); got != want.body {
			t.Errorf("%s: body = %q, want %q", path, got, want.body)
		}
	}
}

func TestMissingAssetIsNotFound(t *testing.T) {
	requireStatus(t, newEnv(t, buildFS()).get(t, "/assets/missing-000.js"), http.StatusNotFound)
}

func TestHealthz(t *testing.T) {
	res := newEnv(t, fstest.MapFS{}).get(t, "/healthz")
	requireStatus(t, res, http.StatusOK)
	if got := body(t, res); got != "ok" {
		t.Errorf("body = %q, want ok", got)
	}
}

func TestReadyzWithBuild(t *testing.T) {
	res := newEnv(t, buildFS()).get(t, "/readyz")
	requireStatus(t, res, http.StatusOK)
	if got := body(t, res); got != "ok" {
		t.Errorf("body = %q, want ok", got)
	}
}

func TestReadyzWithoutIndexHTML(t *testing.T) {
	build := fstest.MapFS{"assets/index-abc123.js": {Data: []byte("x")}}
	requireStatus(t, newEnv(t, build).get(t, "/readyz"), http.StatusServiceUnavailable)
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
	e := newEnv(t, buildFS())
	cookie := e.setup(t)
	for _, res := range []*http.Response{e.get(t, "/", cookie), e.get(t, "/library", cookie), e.get(t, "/signin")} {
		path := res.Request.URL.Path
		header := res.Header.Values("Content-Security-Policy")
		if len(header) != 1 {
			t.Fatalf("%s: got %d Content-Security-Policy headers, want 1", path, len(header))
		}
		csp := parseCSP(header[0])
		for name, want := range map[string]string{
			"default-src": "'self'",
			"script-src":  "'self'",
			"object-src":  "'none'",
			"base-uri":    "'none'",
			// Trusted Types guard every script sink, and only the
			// Navigator's policy may create TrustedHTML (ADR-0004).
			"require-trusted-types-for": "'script'",
			"trusted-types":             "tomeshelf",
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
