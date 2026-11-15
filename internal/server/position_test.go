package server_test

import (
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"net/http/httptest"
	"testing"
)

func positionPath(id int64) string {
	return fmt.Sprintf("/api/books/%d/position", id)
}

func (e env) putPosition(t *testing.T, id int64, c *http.Cookie, body string) *http.Response {
	t.Helper()
	req := jsonRequest(http.MethodPut, positionPath(id), body)
	if c != nil {
		req.AddCookie(c)
	}
	return e.do(t, req)
}

func (e env) getPosition(t *testing.T, id int64, c *http.Cookie) *http.Response {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, positionPath(id), nil)
	if c != nil {
		req.AddCookie(c)
	}
	return e.do(t, req)
}

func readingOrderHref(t *testing.T, e env, id int64, c *http.Cookie, index int) string {
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

	requireStatus(t, e.putPosition(t, id, c, saveBody("tab-a", 1, href0, 0.5, "")), http.StatusNoContent)
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
	if !(first.Locations.TotalProgression < second.Locations.TotalProgression) {
		t.Errorf("total at mid doc0 = %v, at start doc1 = %v; want the second larger",
			first.Locations.TotalProgression, second.Locations.TotalProgression)
	}
	if second.Locations.TotalProgression <= 0 || second.Locations.TotalProgression >= 1 {
		t.Errorf("total at start of last doc = %v, want in (0,1)", second.Locations.TotalProgression)
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
	otherID := e.importedID(t, other, book)
	href := readingOrderHref(t, e, adminID, admin, 0)
	requireStatus(t, e.putPosition(t, adminID, admin, saveBody("tab-a", 1, href, 0.3, "")), http.StatusNoContent)

	requireJSONError(t, e.getPosition(t, adminID, other), http.StatusNotFound)
	requireJSONError(t, e.putPosition(t, adminID, other, saveBody("tab-b", 1, href, 0.9, "")), http.StatusNotFound)

	requireStatus(t, e.getPosition(t, adminID, admin), http.StatusOK)
	requireJSONError(t, e.getPosition(t, otherID, other), http.StatusNotFound)
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
