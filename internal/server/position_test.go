package server_test

import (
	"archive/zip"
	"bytes"
	"database/sql"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func positionPath(id string) string {
	return fmt.Sprintf("/api/books/%s/position", id)
}

func (e env) putPosition(t *testing.T, id string, c *http.Cookie, body string) *http.Response {
	t.Helper()
	req := jsonRequest(http.MethodPut, positionPath(id), body)
	if c != nil {
		req.AddCookie(c)
	}
	return e.do(t, req)
}

func (e env) getPosition(t *testing.T, id string, c *http.Cookie) *http.Response {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, positionPath(id), nil)
	if c != nil {
		req.AddCookie(c)
	}
	return e.do(t, req)
}

func readingOrderHref(t *testing.T, e env, id string, c *http.Cookie, index int) string {
	t.Helper()
	res := e.get(t, manifestPath(id), c)
	requireStatus(t, res, http.StatusOK)
	var manifest struct {
		ReadingOrder []struct {
			Href string `json:"href"`
		} `json:"readingOrder"`
	}
	if err := json.Unmarshal([]byte(body(t, res)), &manifest); err != nil {
		t.Fatal(err)
	}
	if index < 0 || index >= len(manifest.ReadingOrder) {
		t.Fatalf("reading order has %d entries, need index %d", len(manifest.ReadingOrder), index)
	}
	return manifest.ReadingOrder[index].Href
}

func saveBody(tab string, seq int64, href string, progression float64, extra string) string {
	base := fmt.Sprintf(
		`{"tabId":%q,"sequence":%d,"href":%q,"locations":{"progression":%g%s}`,
		tab, seq, href, progression, extra,
	)
	return base + `}`
}

func TestPositionAcceptsPercentEncodedDocumentHref(t *testing.T) {
	e := newEnv(t, buildFS())
	c := e.setup(t)
	original := coverEPUB(t, "Encoded", nil)
	zr, err := zip.NewReader(bytes.NewReader(original), int64(len(original)))
	if err != nil {
		t.Fatal(err)
	}
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for _, f := range zr.File {
		r, err := f.Open()
		if err != nil {
			t.Fatal(err)
		}
		data, err := io.ReadAll(r)
		if err != nil {
			t.Fatal(err)
		}
		r.Close()
		name := f.Name
		if name == "OEBPS/text.xhtml" {
			name = "OEBPS/my document.xhtml"
		}
		if name == "OEBPS/content.opf" || name == "OEBPS/nav.xhtml" {
			data = bytes.ReplaceAll(data, []byte("text.xhtml"), []byte("my%20document.xhtml"))
		}
		w, err := zw.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err = w.Write(data); err != nil {
			t.Fatal(err)
		}
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	id := e.importedID(t, c, buf.Bytes())
	href := readingOrderHref(t, e, id, c, 0)
	if !strings.Contains(href, "my%20document.xhtml") {
		t.Fatalf("href = %q", href)
	}
	requireStatus(t, e.putPosition(t, id, c, saveBody("tab-a", 1, href, 0.5, "")), http.StatusNoContent)
	res := e.getPosition(t, id, c)
	requireStatus(t, res, http.StatusOK)
	var got struct {
		Href string `json:"href"`
	}
	if err := json.Unmarshal([]byte(body(t, res)), &got); err != nil {
		t.Fatal(err)
	}
	if got.Href != href {
		t.Errorf("href = %q, want %q", got.Href, href)
	}
}

func TestPositionNeedsASession(t *testing.T) {
	e := newEnv(t, buildFS())
	c := e.setup(t)
	id := e.importedID(t, c, fixture(t, "chapters.epub"))
	href := readingOrderHref(t, e, id, c, 0)
	body := saveBody("tab-a", 1, href, 0.5, "")
	forged := &http.Cookie{Name: "tomeshelf_session", Value: "forged"}
	for _, cookie := range []*http.Cookie{nil, forged} {
		requireJSONError(t, e.getPosition(t, id, cookie), http.StatusUnauthorized)
		requireJSONError(t, e.putPosition(t, id, cookie, body), http.StatusUnauthorized)
	}
}

func TestSavingAndLoadingAPositionRoundTripsEveryLocatorField(t *testing.T) {
	e := newEnv(t, buildFS())
	c := e.setup(t)
	id := e.importedID(t, c, fixture(t, "chapters.epub"))
	href := readingOrderHref(t, e, id, c, 0)
	sel := `[data-tomeshelf-block="2"]`
	before, highlight, after := "before text ", "highlight text", " after text"
	req := fmt.Sprintf(
		`{"tabId":"tab-a","sequence":1,"href":%q,"locations":{"progression":0.25,"cssSelector":%q,"characterOffset":4},"text":{"before":%q,"highlight":%q,"after":%q}}`,
		href, sel, before, highlight, after,
	)
	requireStatus(t, e.putPosition(t, id, c, req), http.StatusNoContent)

	res := e.getPosition(t, id, c)
	requireStatus(t, res, http.StatusOK)
	var got map[string]any
	if err := json.Unmarshal([]byte(body(t, res)), &got); err != nil {
		t.Fatal(err)
	}
	if got["href"] != href {
		t.Errorf("href = %v, want %q", got["href"], href)
	}
	loc := got["locations"].(map[string]any)
	if loc["progression"] != 0.25 {
		t.Errorf("progression = %v, want 0.25", loc["progression"])
	}
	if loc["cssSelector"] != sel {
		t.Errorf("cssSelector = %v, want %q", loc["cssSelector"], sel)
	}
	if loc["characterOffset"] != float64(4) {
		t.Errorf("characterOffset = %v, want 4", loc["characterOffset"])
	}
	if _, ok := loc["totalProgression"].(float64); !ok {
		t.Errorf("totalProgression missing: %v", loc)
	}
	text := got["text"].(map[string]any)
	if text["before"] != before || text["highlight"] != highlight || text["after"] != after {
		t.Errorf("text = %v", text)
	}
}

func TestALocatorWithoutBlockAndQuoteRoundTrips(t *testing.T) {
	e := newEnv(t, buildFS())
	c := e.setup(t)
	id := e.importedID(t, c, fixture(t, "chapters.epub"))
	href := readingOrderHref(t, e, id, c, 1)
	requireStatus(t, e.putPosition(t, id, c, saveBody("tab-a", 1, href, 0.8, "")), http.StatusNoContent)

	res := e.getPosition(t, id, c)
	requireStatus(t, res, http.StatusOK)
	var got struct {
		Href      string `json:"href"`
		Locations struct {
			Progression      float64 `json:"progression"`
			TotalProgression float64 `json:"totalProgression"`
			CSSSelector      *string `json:"cssSelector"`
			CharacterOffset  *int64  `json:"characterOffset"`
		} `json:"locations"`
		Text *struct{} `json:"text"`
	}
	if err := json.Unmarshal([]byte(body(t, res)), &got); err != nil {
		t.Fatal(err)
	}
	if got.Href != href || got.Locations.Progression != 0.8 {
		t.Errorf("got %+v", got)
	}
	if got.Locations.CSSSelector != nil || got.Locations.CharacterOffset != nil || got.Text != nil {
		t.Errorf("optional fields present: %+v", got)
	}
}

func TestTotalProgressionIsComputedFromDocumentSizes(t *testing.T) {
	e := newEnv(t, buildFS())
	c := e.setup(t)
	book := fixture(t, "chapters.epub")
	id := e.importedID(t, c, book)
	href0 := readingOrderHref(t, e, id, c, 0)
	href1 := readingOrderHref(t, e, id, c, 1)

	requireStatus(t, e.putPosition(t, id, c, saveBody("tab-a", 1, href0, 0.5, `,"totalProgression":0.99`)), http.StatusNoContent)
	res := e.getPosition(t, id, c)
	requireStatus(t, res, http.StatusOK)
	var first struct {
		Locations struct {
			TotalProgression float64 `json:"totalProgression"`
		} `json:"locations"`
	}
	if err := json.Unmarshal([]byte(body(t, res)), &first); err != nil {
		t.Fatal(err)
	}

	requireStatus(t, e.putPosition(t, id, c, saveBody("tab-a", 2, href1, 0, "")), http.StatusNoContent)
	res = e.getPosition(t, id, c)
	requireStatus(t, res, http.StatusOK)
	var second struct {
		Locations struct {
			TotalProgression float64 `json:"totalProgression"`
		} `json:"locations"`
	}
	if err := json.Unmarshal([]byte(body(t, res)), &second); err != nil {
		t.Fatal(err)
	}
	// The fixture's reading-order documents are 10022 and 234 bytes.
	for _, tc := range []struct{ got, want float64 }{
		{first.Locations.TotalProgression, 5011.0 / 10256},
		{second.Locations.TotalProgression, 10022.0 / 10256},
	} {
		if math.Abs(tc.got-tc.want) > 1e-9 {
			t.Errorf("totalProgression = %v, want %v", tc.got, tc.want)
		}
	}
}

func TestAnHrefOutsideTheReadingOrderIsRejected(t *testing.T) {
	e := newEnv(t, buildFS())
	c := e.setup(t)
	id := e.importedID(t, c, fixture(t, "chapters.epub"))
	requireJSONError(t, e.putPosition(t, id, c, saveBody("tab-a", 1, "OEBPS/missing.xhtml", 0.1, "")), http.StatusBadRequest)
	requireJSONError(t, e.getPosition(t, id, c), http.StatusNotFound)
}

func TestAnotherUserCannotReadOrOverwriteAPosition(t *testing.T) {
	e := newEnv(t, buildFS())
	admin := e.setup(t)
	other := e.otherUser(t, "other")
	book := fixture(t, "chapters.epub")
	adminID := e.importedID(t, admin, book)
	stranger := e.otherUser(t, "stranger")
	href := readingOrderHref(t, e, adminID, admin, 0)
	requireStatus(t, e.putPosition(t, adminID, admin, saveBody("tab-a", 1, href, 0.3, "")), http.StatusNoContent)

	// A user without the book can neither read nor write a position for it.
	requireJSONError(t, e.getPosition(t, adminID, stranger), http.StatusNotFound)
	requireJSONError(t, e.putPosition(t, adminID, stranger, saveBody("tab-b", 1, href, 0.9, "")), http.StatusNotFound)

	// A user who imported the same file has the same id and no position yet.
	otherID := e.importedID(t, other, book)
	if otherID != adminID {
		t.Fatalf("same file got ids %s and %s", adminID, otherID)
	}
	requireJSONError(t, e.getPosition(t, otherID, other), http.StatusNotFound)
	requireStatus(t, e.putPosition(t, otherID, other, saveBody("tab-a", 1, href, 0.9, "")), http.StatusNoContent)

	progression := func(c *http.Cookie) float64 {
		t.Helper()
		res := e.getPosition(t, adminID, c)
		requireStatus(t, res, http.StatusOK)
		var loc struct {
			Locations struct {
				Progression float64 `json:"progression"`
			} `json:"locations"`
		}
		if err := json.Unmarshal([]byte(body(t, res)), &loc); err != nil {
			t.Fatal(err)
		}
		return loc.Locations.Progression
	}
	if got := progression(admin); got != 0.3 {
		t.Errorf("admin progression = %g, want 0.3 untouched by the other user's save", got)
	}
	if got := progression(other); got != 0.9 {
		t.Errorf("other progression = %g, want 0.9", got)
	}
}

func TestAnOlderSequenceFromTheSameTabIsIgnoredAndAnotherTabWins(t *testing.T) {
	e := newEnv(t, buildFS())
	c := e.setup(t)
	id := e.importedID(t, c, fixture(t, "chapters.epub"))
	href0 := readingOrderHref(t, e, id, c, 0)
	href1 := readingOrderHref(t, e, id, c, 1)

	requireStatus(t, e.putPosition(t, id, c, saveBody("tab-a", 2, href0, 0.2, "")), http.StatusNoContent)
	requireStatus(t, e.putPosition(t, id, c, saveBody("tab-a", 1, href1, 0.9, "")), http.StatusNoContent)

	res := e.getPosition(t, id, c)
	requireStatus(t, res, http.StatusOK)
	var got struct {
		Href string `json:"href"`
	}
	if err := json.Unmarshal([]byte(body(t, res)), &got); err != nil {
		t.Fatal(err)
	}
	if got.Href != href0 {
		t.Errorf("href = %q, want tab-a's seq 2 position %q", got.Href, href0)
	}

	requireStatus(t, e.putPosition(t, id, c, saveBody("tab-b", 1, href1, 0.4, "")), http.StatusNoContent)
	res = e.getPosition(t, id, c)
	requireStatus(t, res, http.StatusOK)
	if err := json.Unmarshal([]byte(body(t, res)), &got); err != nil {
		t.Fatal(err)
	}
	if got.Href != href1 {
		t.Errorf("href = %q, want tab-b's position %q", got.Href, href1)
	}
}

func TestInterleavedTabSequencesLeaveTheNewerTabsPosition(t *testing.T) {
	// tab A seq 2, tab B seq 1, then tab A's delayed seq 1 leaves tab B's position.
	e := newEnv(t, buildFS())
	c := e.setup(t)
	id := e.importedID(t, c, fixture(t, "chapters.epub"))
	href0 := readingOrderHref(t, e, id, c, 0)
	href1 := readingOrderHref(t, e, id, c, 1)

	requireStatus(t, e.putPosition(t, id, c, saveBody("tab-a", 2, href0, 0.1, "")), http.StatusNoContent)
	requireStatus(t, e.putPosition(t, id, c, saveBody("tab-b", 1, href1, 0.5, "")), http.StatusNoContent)
	requireStatus(t, e.putPosition(t, id, c, saveBody("tab-a", 1, href0, 0.9, "")), http.StatusNoContent)

	res := e.getPosition(t, id, c)
	requireStatus(t, res, http.StatusOK)
	var got struct {
		Href      string `json:"href"`
		Locations struct {
			Progression float64 `json:"progression"`
		} `json:"locations"`
	}
	if err := json.Unmarshal([]byte(body(t, res)), &got); err != nil {
		t.Fatal(err)
	}
	if got.Href != href1 || got.Locations.Progression != 0.5 {
		t.Errorf("got %+v, want tab B's position", got)
	}
}

func TestGetAPIBooksReportsEachBooksProgress(t *testing.T) {
	e := newEnv(t, buildFS())
	c := e.setup(t)
	withPos := e.importedID(t, c, fixture(t, "chapters.epub"))
	without := e.importedID(t, c, fixture(t, "epub3.epub"))
	href := readingOrderHref(t, e, withPos, c, 0)
	requireStatus(t, e.putPosition(t, withPos, c, saveBody("tab-a", 1, href, 0.5, "")), http.StatusNoContent)

	res := e.getPosition(t, withPos, c)
	requireStatus(t, res, http.StatusOK)
	var loc struct {
		Locations struct {
			TotalProgression float64 `json:"totalProgression"`
		} `json:"locations"`
	}
	if err := json.Unmarshal([]byte(body(t, res)), &loc); err != nil {
		t.Fatal(err)
	}
	wantProgress := int(math.Floor(loc.Locations.TotalProgression * 100))

	books := e.books(t, c)
	var foundWith, foundWithout bool
	for _, b := range books {
		switch b.ID {
		case withPos:
			foundWith = true
			if b.Progress == nil || *b.Progress != wantProgress {
				t.Errorf("book with position: progress = %v, want %d", b.Progress, wantProgress)
			}
		case without:
			foundWithout = true
			if b.Progress != nil {
				t.Errorf("book without position: progress = %v, want none", *b.Progress)
			}
		}
	}
	if !foundWith || !foundWithout {
		t.Fatalf("library listing missing books: %+v", books)
	}
}

func TestBooksReportAcceptedSaveTimesInMilliseconds(t *testing.T) {
	e := newEnv(t, buildFS())
	c := e.setup(t)
	a := e.importedID(t, c, fixture(t, "chapters.epub"))
	b := e.importedID(t, c, fixture(t, "epub3.epub"))
	hrefA := readingOrderHref(t, e, a, c, 0)
	hrefB := readingOrderHref(t, e, b, c, 0)
	now := time.UnixMilli(1700000000123)
	e.store.Now = func() time.Time { return now }
	check := func(id string, want *int64) {
		t.Helper()
		for _, book := range e.books(t, c) {
			if book.ID == id {
				if want == nil {
					if book.SavedAt != nil {
						t.Fatalf("book %s savedAt = %d, want absent", id, *book.SavedAt)
					}
					return
				}
				if book.SavedAt == nil || *book.SavedAt != *want {
					t.Fatalf("book %s savedAt = %v, want %d", id, book.SavedAt, *want)
				}
				return
			}
		}
		t.Fatalf("missing book %s", id)
	}
	check(a, nil)
	check(b, nil)
	requireStatus(t, e.putPosition(t, a, c, saveBody("tab", 2, hrefA, 0.5, "")), http.StatusNoContent)
	first := now.UnixMilli()
	check(a, &first)
	now = now.Add(time.Millisecond)
	requireStatus(t, e.putPosition(t, b, c, saveBody("tab", 1, hrefB, 0.2, "")), http.StatusNoContent)
	second := now.UnixMilli()
	check(a, &first)
	check(b, &second)
	now = now.Add(time.Second)
	for _, seq := range []int64{2, 1} {
		requireStatus(t, e.putPosition(t, a, c, saveBody("tab", seq, hrefA, 0.9, "")), http.StatusNoContent)
		check(a, &first)
		res := e.getPosition(t, a, c)
		requireStatus(t, res, http.StatusOK)
		var loc struct {
			Locations struct {
				Progression float64 `json:"progression"`
			} `json:"locations"`
		}
		if err := json.Unmarshal([]byte(body(t, res)), &loc); err != nil {
			t.Fatal(err)
		}
		if loc.Locations.Progression != 0.5 {
			t.Fatalf("stale save changed progression: %g", loc.Locations.Progression)
		}
	}
	requireStatus(t, e.putPosition(t, a, c, saveBody("tab", 3, hrefA, 0.8, "")), http.StatusNoContent)
	latest := now.UnixMilli()
	check(a, &latest)
	now = now.Add(time.Second)
	other := e.otherUser(t, "other")
	otherID := e.importedID(t, other, fixture(t, "chapters.epub"))
	requireStatus(t, e.putPosition(t, otherID, other, saveBody("tab", 1, hrefA, 0.9, "")), http.StatusNoContent)
	check(a, &latest)
	check(b, &second)
	if books := e.books(t, c); len(books) != 2 {
		t.Fatalf("admin library = %+v", books)
	}
	if books := e.books(t, other); len(books) != 1 || books[0].ID != otherID {
		t.Fatalf("other library = %+v", books)
	}
}

func TestMigratedReadingPositionHasNoSaveTimeUntilAcceptedSave(t *testing.T) {
	e := newEnv(t, buildFS())
	c := e.setup(t)
	id := e.importedID(t, c, fixture(t, "chapters.epub"))
	href := readingOrderHref(t, e, id, c, 0)
	requireStatus(t, e.putPosition(t, id, c, saveBody("tab", 1, href, 0.5, "")), http.StatusNoContent)
	if err := e.store.Close(); err != nil {
		t.Fatal(err)
	}
	raw, err := sql.Open("sqlite", e.dbPath)
	if err != nil {
		t.Fatal(err)
	}
	// Positions saved before migration 7 have no save time. Migration 9 cannot
	// be undone, so a missing time is set directly.
	if _, err := raw.Exec("UPDATE reading_positions SET saved_at = NULL"); err != nil {
		t.Fatal(err)
	}
	if err := raw.Close(); err != nil {
		t.Fatal(err)
	}
	e = openEnv(t, buildFS(), envOptions{dataDir: e.dataDir})
	books := e.books(t, c)
	if len(books) != 1 || books[0].SavedAt != nil || books[0].Progress == nil {
		t.Fatalf("migrated library = %+v, want position with progress but no save time", books)
	}
	requireStatus(t, e.putPosition(t, id, c, saveBody("tab", 1, href, 0.9, "")), http.StatusNoContent)
	if e.books(t, c)[0].SavedAt != nil {
		t.Fatal("stale save gave migrated position a time")
	}
	requireStatus(t, e.putPosition(t, id, c, saveBody("tab", 2, href, 0.6, "")), http.StatusNoContent)
	if e.books(t, c)[0].SavedAt == nil {
		t.Fatal("accepted save has no time")
	}
}
