package server_test

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

const defaultSettings = `{"fontSize":18,"lineHeight":1.6,"width":38,"theme":"light","layout":"pages","wheelTurnsPages":true,"font":"default","repeatedLines":1}`

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
		`{"fontSize":24,"lineHeight":1.9,"width":30,"theme":"dark","layout":"scroll","wheelTurnsPages":false,"font":"literata","repeatedLines":0}`,
		`{"fontSize":14,"lineHeight":1.2,"width":48,"theme":"sepia","layout":"pages","wheelTurnsPages":true,"font":"charter","repeatedLines":3}`,
		`{"fontSize":28,"lineHeight":2,"width":28,"theme":"light","layout":"scroll","wheelTurnsPages":true,"font":"source-serif-4","repeatedLines":2}`,
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
	requireSettings(t, e, c, `{"fontSize":20,"lineHeight":1.8,"width":40,"theme":"sepia","layout":"pages","wheelTurnsPages":true,"font":"default","repeatedLines":1}`)
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
	requireSettings(t, e, c, `{"fontSize":20,"lineHeight":1.8,"width":40,"theme":"sepia","layout":"scroll","wheelTurnsPages":true,"font":"default","repeatedLines":1}`)
}

// A row saved without the repeated-lines column gets the migration default
// of 1 (ADR-0010).
func TestARowWithoutRepeatedLinesAnswersOne(t *testing.T) {
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
		`INSERT INTO reading_settings (user_id, font_size, line_height, width, theme, layout, font, wheel_turns_pages)
		 VALUES (?, 20, 1.8, 40, 'sepia', 'pages', 'default', FALSE)`,
		userID,
	); err != nil {
		t.Fatal(err)
	}
	requireSettings(t, e, c, `{"fontSize":20,"lineHeight":1.8,"width":40,"theme":"sepia","layout":"pages","wheelTurnsPages":false,"font":"default","repeatedLines":1}`)
}

// A row saved without the wheel column gets the migration default of on.
func TestARowWithoutWheelTurnsPagesAnswersOn(t *testing.T) {
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
		 VALUES (?, 20, 1.8, 40, 'sepia', 'scroll', 'default')`,
		userID,
	); err != nil {
		t.Fatal(err)
	}
	requireSettings(t, e, c, `{"fontSize":20,"lineHeight":1.8,"width":40,"theme":"sepia","layout":"scroll","wheelTurnsPages":true,"font":"default","repeatedLines":1}`)
}

func TestInvalidSettingsAreRefusedAndStoreNothing(t *testing.T) {
	e := newEnv(t, buildFS())
	c := e.setup(t)
	saved := `{"fontSize":20,"lineHeight":1.8,"width":40,"theme":"sepia","layout":"scroll","wheelTurnsPages":true,"font":"literata","repeatedLines":1}`
	requireStatus(t, e.putSettings(t, c, saved), http.StatusNoContent)

	for name, body := range map[string]string{
		"not JSON":                  `font size 20`,
		"trailing bracket":          saved + `]`,
		"trailing brace":            saved + `}`,
		"not an object":             `[20, 1.8, 40, "sepia"]`,
		"missing wheel setting":     `{"fontSize":20,"lineHeight":1.8,"width":40,"theme":"sepia","layout":"pages","font":"default","repeatedLines":1}`,
		"non-boolean wheel setting": `{"fontSize":20,"lineHeight":1.8,"width":40,"theme":"sepia","layout":"pages","font":"default","wheelTurnsPages":"false"}`,
		"null wheel setting":        `{"fontSize":20,"lineHeight":1.8,"width":40,"theme":"sepia","layout":"pages","font":"default","wheelTurnsPages":null,"repeatedLines":1}`,
		"missing font size":         `{"lineHeight":1.8,"width":40,"theme":"sepia","layout":"pages","wheelTurnsPages":true,"font":"default","repeatedLines":1}`,
		"missing line height":       `{"fontSize":20,"width":40,"theme":"sepia","layout":"pages","wheelTurnsPages":true,"font":"default","repeatedLines":1}`,
		"missing width":             `{"fontSize":20,"lineHeight":1.8,"theme":"sepia","layout":"pages","wheelTurnsPages":true,"font":"default","repeatedLines":1}`,
		"missing theme":             `{"fontSize":20,"lineHeight":1.8,"width":40,"layout":"pages","wheelTurnsPages":true,"font":"default","repeatedLines":1}`,
		"missing layout":            `{"fontSize":20,"lineHeight":1.8,"width":40,"theme":"sepia","wheelTurnsPages":true,"font":"default","repeatedLines":1}`,
		"missing font":              `{"fontSize":20,"lineHeight":1.8,"width":40,"theme":"sepia","layout":"pages","wheelTurnsPages":true,"repeatedLines":1}`,
		"null font size":            `{"fontSize":null,"lineHeight":1.8,"width":40,"theme":"sepia","layout":"pages","wheelTurnsPages":true,"font":"default","repeatedLines":1}`,
		"font size too small":       `{"fontSize":13,"lineHeight":1.8,"width":40,"theme":"sepia","layout":"pages","wheelTurnsPages":true,"font":"default","repeatedLines":1}`,
		"font size too large":       `{"fontSize":29,"lineHeight":1.8,"width":40,"theme":"sepia","layout":"pages","wheelTurnsPages":true,"font":"default","repeatedLines":1}`,
		"font size off step":        `{"fontSize":18.5,"lineHeight":1.8,"width":40,"theme":"sepia","layout":"pages","wheelTurnsPages":true,"font":"default","repeatedLines":1}`,
		"font size as text":         `{"fontSize":"18","lineHeight":1.8,"width":40,"theme":"sepia","layout":"pages","wheelTurnsPages":true,"font":"default","repeatedLines":1}`,
		"line height too small":     `{"fontSize":20,"lineHeight":1.1,"width":40,"theme":"sepia","layout":"pages","wheelTurnsPages":true,"font":"default","repeatedLines":1}`,
		"line height too large":     `{"fontSize":20,"lineHeight":2.1,"width":40,"theme":"sepia","layout":"pages","wheelTurnsPages":true,"font":"default","repeatedLines":1}`,
		"line height off step":      `{"fontSize":20,"lineHeight":1.65,"width":40,"theme":"sepia","layout":"pages","wheelTurnsPages":true,"font":"default","repeatedLines":1}`,
		"width too small":           `{"fontSize":20,"lineHeight":1.8,"width":26,"theme":"sepia","layout":"pages","wheelTurnsPages":true,"font":"default","repeatedLines":1}`,
		"width too large":           `{"fontSize":20,"lineHeight":1.8,"width":50,"theme":"sepia","layout":"pages","wheelTurnsPages":true,"font":"default","repeatedLines":1}`,
		"width off step":            `{"fontSize":20,"lineHeight":1.8,"width":39,"theme":"sepia","layout":"pages","wheelTurnsPages":true,"font":"default","repeatedLines":1}`,
		"unknown theme":             `{"fontSize":20,"lineHeight":1.8,"width":40,"theme":"blue","layout":"pages","wheelTurnsPages":true,"font":"default","repeatedLines":1}`,
		"theme in capitals":         `{"fontSize":20,"lineHeight":1.8,"width":40,"theme":"Dark","layout":"pages","wheelTurnsPages":true,"font":"default","repeatedLines":1}`,
		"unknown layout":            `{"fontSize":20,"lineHeight":1.8,"width":40,"theme":"sepia","layout":"columns","wheelTurnsPages":true,"font":"default","repeatedLines":1}`,
		"layout in capitals":        `{"fontSize":20,"lineHeight":1.8,"width":40,"theme":"sepia","layout":"Pages","wheelTurnsPages":true,"font":"default","repeatedLines":1}`,
		"unknown font":              `{"fontSize":20,"lineHeight":1.8,"width":40,"theme":"sepia","layout":"pages","wheelTurnsPages":true,"font":"comic-sans","repeatedLines":1}`,
		"font in capitals":          `{"fontSize":20,"lineHeight":1.8,"width":40,"theme":"sepia","layout":"pages","wheelTurnsPages":true,"font":"Default","repeatedLines":1}`,
		"missing repeated lines":    `{"fontSize":20,"lineHeight":1.8,"width":40,"theme":"sepia","layout":"pages","wheelTurnsPages":true,"font":"default"}`,
		"repeated lines below 0":    `{"fontSize":20,"lineHeight":1.8,"width":40,"theme":"sepia","layout":"pages","wheelTurnsPages":true,"font":"default","repeatedLines":-1}`,
		"repeated lines above 3":    `{"fontSize":20,"lineHeight":1.8,"width":40,"theme":"sepia","layout":"pages","wheelTurnsPages":true,"font":"default","repeatedLines":4}`,
		"repeated lines fraction":   `{"fontSize":20,"lineHeight":1.8,"width":40,"theme":"sepia","layout":"pages","wheelTurnsPages":true,"font":"default","repeatedLines":1.5}`,
		"repeated lines as text":    `{"fontSize":20,"lineHeight":1.8,"width":40,"theme":"sepia","layout":"pages","wheelTurnsPages":true,"font":"default","repeatedLines":"1"}`,
		"null repeated lines":       `{"fontSize":20,"lineHeight":1.8,"width":40,"theme":"sepia","layout":"pages","wheelTurnsPages":true,"font":"default","repeatedLines":null}`,
		"unknown field":             `{"fontSize":20,"lineHeight":1.8,"width":40,"theme":"sepia","layout":"pages","wheelTurnsPages":true,"font":"default","serif":true}`,
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
	adminSettings := `{"fontSize":26,"lineHeight":1.4,"width":32,"theme":"dark","layout":"scroll","wheelTurnsPages":false,"font":"charter","repeatedLines":1}`
	requireStatus(t, e.putSettings(t, admin, adminSettings), http.StatusNoContent)
	requireSettings(t, e, other, defaultSettings)

	otherSettings := `{"fontSize":15,"lineHeight":2,"width":46,"theme":"sepia","layout":"pages","wheelTurnsPages":true,"font":"literata","repeatedLines":1}`
	requireStatus(t, e.putSettings(t, other, otherSettings), http.StatusNoContent)
	requireSettings(t, e, admin, adminSettings)
	requireSettings(t, e, other, otherSettings)
}
