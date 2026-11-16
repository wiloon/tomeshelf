package server_test

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

const defaultSettings = `{"fontSize":18,"lineHeight":1.6,"width":38,"theme":"light","layout":"pages","font":"default"}`

func (e env) putSettings(t *testing.T, c *http.Cookie, body string) *http.Response {
	t.Helper()
	req := jsonRequest(http.MethodPut, "/api/settings", body)
	if c != nil {
		req.AddCookie(c)
	}
	return e.do(t, req)
}

// requireSettings checks that GET /api/settings answers want for the cookie's
// user.
func requireSettings(t *testing.T, e env, c *http.Cookie, want string) {
	t.Helper()
	res := e.get(t, "/api/settings", c)
	requireStatus(t, res, http.StatusOK)
	var got, expected map[string]any
	if err := json.Unmarshal([]byte(body(t, res)), &got); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal([]byte(want), &expected); err != nil {
		t.Fatal(err)
	}
	gotJSON, _ := json.Marshal(got)
	wantJSON, _ := json.Marshal(expected)
	if string(gotJSON) != string(wantJSON) {
		t.Errorf("GET /api/settings = %s, want %s", gotJSON, wantJSON)
	}
}

func TestSettingsNeedASession(t *testing.T) {
	e := newEnv(t, buildFS())
	e.setup(t)
	forged := &http.Cookie{Name: "tomeshelf_session", Value: "forged"}
	for _, c := range []*http.Cookie{nil, forged} {
		req := httptest.NewRequest(http.MethodGet, "/api/settings", nil)
		if c != nil {
			req.AddCookie(c)
		}
		requireJSONError(t, e.do(t, req), http.StatusUnauthorized)
		requireJSONError(t, e.putSettings(t, c, defaultSettings), http.StatusUnauthorized)
	}
	if n := e.count(t, "reading_settings"); n != 0 {
		t.Errorf("reading_settings has %d rows after refused saves, want 0", n)
	}
}

func TestANewUserGetsTheDefaultSettings(t *testing.T) {
	e := newEnv(t, buildFS())
	requireSettings(t, e, e.setup(t), defaultSettings)
}

func TestSavedSettingsAreReadBackAndReplaced(t *testing.T) {
	e := newEnv(t, buildFS())
	c := e.setup(t)
	for _, s := range []string{
		`{"fontSize":24,"lineHeight":1.9,"width":30,"theme":"dark","layout":"scroll","font":"literata"}`,
		`{"fontSize":14,"lineHeight":1.2,"width":48,"theme":"sepia","layout":"pages","font":"charter"}`,
		`{"fontSize":28,"lineHeight":2,"width":28,"theme":"light","layout":"scroll","font":"source-serif-4"}`,
	} {
		requireStatus(t, e.putSettings(t, c, s), http.StatusNoContent)
		requireSettings(t, e, c, s)
	}
	if n := e.count(t, "reading_settings"); n != 1 {
		t.Errorf("reading_settings has %d rows for one user, want 1", n)
	}
}

// A row stored before layout existed (empty layout) is read as pages.
func TestARowWithoutALayoutAnswersPages(t *testing.T) {
	e := newEnv(t, buildFS())
	c := e.setup(t)
	db, err := sql.Open("sqlite", e.dbPath)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	var userID int64
	if err := db.QueryRow(`SELECT id FROM users WHERE username = ?`, adminName).Scan(&userID); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(
		`INSERT INTO reading_settings (user_id, font_size, line_height, width, theme, layout, font)
		 VALUES (?, 20, 1.8, 40, 'sepia', '', 'default')`,
		userID,
	); err != nil {
		t.Fatal(err)
	}
	requireSettings(t, e, c, `{"fontSize":20,"lineHeight":1.8,"width":40,"theme":"sepia","layout":"pages","font":"default"}`)
}

// A row stored before font existed (empty font) is read as default.
func TestARowWithoutAFontAnswersDefault(t *testing.T) {
	e := newEnv(t, buildFS())
	c := e.setup(t)
	db, err := sql.Open("sqlite", e.dbPath)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	var userID int64
	if err := db.QueryRow(`SELECT id FROM users WHERE username = ?`, adminName).Scan(&userID); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(
		`INSERT INTO reading_settings (user_id, font_size, line_height, width, theme, layout, font)
		 VALUES (?, 20, 1.8, 40, 'sepia', 'scroll', '')`,
		userID,
	); err != nil {
		t.Fatal(err)
	}
	requireSettings(t, e, c, `{"fontSize":20,"lineHeight":1.8,"width":40,"theme":"sepia","layout":"scroll","font":"default"}`)
}

func TestInvalidSettingsAreRefusedAndStoreNothing(t *testing.T) {
	e := newEnv(t, buildFS())
	c := e.setup(t)
	saved := `{"fontSize":20,"lineHeight":1.8,"width":40,"theme":"sepia","layout":"scroll","font":"literata"}`
	requireStatus(t, e.putSettings(t, c, saved), http.StatusNoContent)

	for name, body := range map[string]string{
		"not JSON":              `font size 20`,
		"trailing bracket":      saved + `]`,
		"trailing brace":        saved + `}`,
		"not an object":         `[20, 1.8, 40, "sepia"]`,
		"missing font size":     `{"lineHeight":1.8,"width":40,"theme":"sepia","layout":"pages","font":"default"}`,
		"missing line height":   `{"fontSize":20,"width":40,"theme":"sepia","layout":"pages","font":"default"}`,
		"missing width":         `{"fontSize":20,"lineHeight":1.8,"theme":"sepia","layout":"pages","font":"default"}`,
		"missing theme":         `{"fontSize":20,"lineHeight":1.8,"width":40,"layout":"pages","font":"default"}`,
		"missing layout":        `{"fontSize":20,"lineHeight":1.8,"width":40,"theme":"sepia","font":"default"}`,
		"missing font":          `{"fontSize":20,"lineHeight":1.8,"width":40,"theme":"sepia","layout":"pages"}`,
		"null font size":        `{"fontSize":null,"lineHeight":1.8,"width":40,"theme":"sepia","layout":"pages","font":"default"}`,
		"font size too small":   `{"fontSize":13,"lineHeight":1.8,"width":40,"theme":"sepia","layout":"pages","font":"default"}`,
		"font size too large":   `{"fontSize":29,"lineHeight":1.8,"width":40,"theme":"sepia","layout":"pages","font":"default"}`,
		"font size off step":    `{"fontSize":18.5,"lineHeight":1.8,"width":40,"theme":"sepia","layout":"pages","font":"default"}`,
		"font size as text":     `{"fontSize":"18","lineHeight":1.8,"width":40,"theme":"sepia","layout":"pages","font":"default"}`,
		"line height too small": `{"fontSize":20,"lineHeight":1.1,"width":40,"theme":"sepia","layout":"pages","font":"default"}`,
		"line height too large": `{"fontSize":20,"lineHeight":2.1,"width":40,"theme":"sepia","layout":"pages","font":"default"}`,
		"line height off step":  `{"fontSize":20,"lineHeight":1.65,"width":40,"theme":"sepia","layout":"pages","font":"default"}`,
		"width too small":       `{"fontSize":20,"lineHeight":1.8,"width":26,"theme":"sepia","layout":"pages","font":"default"}`,
		"width too large":       `{"fontSize":20,"lineHeight":1.8,"width":50,"theme":"sepia","layout":"pages","font":"default"}`,
		"width off step":        `{"fontSize":20,"lineHeight":1.8,"width":39,"theme":"sepia","layout":"pages","font":"default"}`,
		"unknown theme":         `{"fontSize":20,"lineHeight":1.8,"width":40,"theme":"blue","layout":"pages","font":"default"}`,
		"theme in capitals":     `{"fontSize":20,"lineHeight":1.8,"width":40,"theme":"Dark","layout":"pages","font":"default"}`,
		"unknown layout":        `{"fontSize":20,"lineHeight":1.8,"width":40,"theme":"sepia","layout":"columns","font":"default"}`,
		"layout in capitals":    `{"fontSize":20,"lineHeight":1.8,"width":40,"theme":"sepia","layout":"Pages","font":"default"}`,
		"unknown font":          `{"fontSize":20,"lineHeight":1.8,"width":40,"theme":"sepia","layout":"pages","font":"comic-sans"}`,
		"font in capitals":      `{"fontSize":20,"lineHeight":1.8,"width":40,"theme":"sepia","layout":"pages","font":"Default"}`,
		"unknown field":         `{"fontSize":20,"lineHeight":1.8,"width":40,"theme":"sepia","layout":"pages","font":"default","serif":true}`,
	} {
		t.Run(name, func(t *testing.T) {
			requireJSONError(t, e.putSettings(t, c, body), http.StatusBadRequest)
			requireSettings(t, e, c, saved)
		})
	}
}

func TestOneUsersSettingsNeverShowForAnother(t *testing.T) {
	e := newEnv(t, buildFS())
	admin := e.setup(t)
	other := e.otherUser(t, "other")
	adminSettings := `{"fontSize":26,"lineHeight":1.4,"width":32,"theme":"dark","layout":"scroll","font":"charter"}`
	requireStatus(t, e.putSettings(t, admin, adminSettings), http.StatusNoContent)
	requireSettings(t, e, other, defaultSettings)

	otherSettings := `{"fontSize":15,"lineHeight":2,"width":46,"theme":"sepia","layout":"pages","font":"literata"}`
	requireStatus(t, e.putSettings(t, other, otherSettings), http.StatusNoContent)
	requireSettings(t, e, admin, adminSettings)
	requireSettings(t, e, other, otherSettings)
}
