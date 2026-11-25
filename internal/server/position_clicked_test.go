package server_test

import (
	"encoding/json"
	"fmt"
	"net/http"
	"testing"
)

func clickedBody(href string, seq int64, clicked string) string {
	return fmt.Sprintf(
		`{"tabId":"tab-a","sequence":%d,"href":%q,"locations":{"progression":0.5}%s}`,
		seq, href, clicked,
	)
}

func getClicked(t *testing.T, e env, id string, c *http.Cookie) (map[string]any, bool) {
	t.Helper()
	res := e.getPosition(t, id, c)
	requireStatus(t, res, http.StatusOK)
	var got map[string]any
	if err := json.Unmarshal([]byte(body(t, res)), &got); err != nil {
		t.Fatal(err)
	}
	v, ok := got["clicked"].(map[string]any)
	return v, ok
}

func TestPutAcceptsAClickedCharacterAndGetReturnsIt(t *testing.T) {
	e := newEnv(t, buildFS())
	c := e.setup(t)
	id := e.importedID(t, c, fixture(t, "chapters.epub"))
	href := readingOrderHref(t, e, id, c, 0)
	text := `{"before":"a ","highlight":"b","after":" c"}`
	quote := map[string]any{"before": "a ", "highlight": "b", "after": " c"}
	sel := `[data-tomeshelf-block="3"]`
	cases := []struct {
		name    string
		clicked string
		want    map[string]any
	}{
		{"block pair", `"cssSelector":"[data-tomeshelf-block=\"3\"]","characterOffset":7`,
			map[string]any{"cssSelector": sel, "characterOffset": float64(7)}},
		{"text only", `"text":` + text,
			map[string]any{"text": quote}},
		{"both", `"cssSelector":"[data-tomeshelf-block=\"3\"]","characterOffset":0,"text":` + text,
			map[string]any{"cssSelector": sel, "characterOffset": float64(0), "text": quote}},
	}
	for i, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			req := clickedBody(href, int64(i+1), `,"clicked":{`+tc.clicked+`}`)
			requireStatus(t, e.putPosition(t, id, c, req), http.StatusNoContent)
			got, ok := getClicked(t, e, id, c)
			if !ok {
				t.Fatal("clicked missing")
			}
			if fmt.Sprint(got) != fmt.Sprint(tc.want) {
				t.Errorf("clicked = %v, want %v", got, tc.want)
			}
		})
	}
}

func TestPutRejectsAMalformedClickedCharacter(t *testing.T) {
	e := newEnv(t, buildFS())
	c := e.setup(t)
	id := e.importedID(t, c, fixture(t, "chapters.epub"))
	href := readingOrderHref(t, e, id, c, 0)
	for name, clicked := range map[string]string{
		"empty":              `{}`,
		"selector only":      `{"cssSelector":"[data-tomeshelf-block=\"1\"]"}`,
		"offset only":        `{"characterOffset":3}`,
		"selector no offset": `{"cssSelector":"[data-tomeshelf-block=\"1\"]","text":{"highlight":"x"}}`,
		"negative offset":    `{"cssSelector":"[data-tomeshelf-block=\"1\"]","characterOffset":-1}`,
		"empty selector":     `{"cssSelector":"","characterOffset":1}`,
		"text without quote": `{"text":{"before":"a"}}`,
		"empty highlight":    `{"text":{"highlight":""}}`,
		"unknown field":      `{"text":{"highlight":"x"},"extra":1}`,
		"unknown text field": `{"text":{"highlight":"x","extra":1}}`,
	} {
		t.Run(name, func(t *testing.T) {
			req := clickedBody(href, 1, `,"clicked":`+clicked)
			requireStatus(t, e.putPosition(t, id, c, req), http.StatusBadRequest)
		})
	}
}

func TestPutWithoutClickedClearsItAndGetOmitsIt(t *testing.T) {
	e := newEnv(t, buildFS())
	c := e.setup(t)
	id := e.importedID(t, c, fixture(t, "chapters.epub"))
	href := readingOrderHref(t, e, id, c, 0)
	requireStatus(t, e.putPosition(t, id, c, saveBody("tab-a", 1, href, 0.5, "")), http.StatusNoContent)
	if _, ok := getClicked(t, e, id, c); ok {
		t.Fatal("clicked present on a position saved without it")
	}
	req := clickedBody(href, 2, `,"clicked":{"text":{"highlight":"x"}}`)
	requireStatus(t, e.putPosition(t, id, c, req), http.StatusNoContent)
	if _, ok := getClicked(t, e, id, c); !ok {
		t.Fatal("clicked missing after save")
	}
	requireStatus(t, e.putPosition(t, id, c, saveBody("tab-a", 3, href, 0.6, "")), http.StatusNoContent)
	if _, ok := getClicked(t, e, id, c); ok {
		t.Fatal("clicked kept after a save without it")
	}
}
