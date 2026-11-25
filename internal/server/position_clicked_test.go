package server_test

import (
	"encoding/json"
	"fmt"
	"net/http"
	"reflect"
	"testing"
)

// clickedBody is a save whose Locator carries the given clicked JSON.
func clickedBody(tab string, seq int64, href string, clicked string) string {
	return fmt.Sprintf(
		`{"tabId":%q,"sequence":%d,"href":%q,"locations":{"progression":0.5,"cssSelector":"[data-tomeshelf-block=\"1\"]","characterOffset":0},"text":{"highlight":"spread start"},"clicked":%s}`,
		tab, seq, href, clicked,
	)
}

// storedClicked is the clicked object GET answers, or nil when it is absent.
func storedClicked(t *testing.T, e env, id string, c *http.Cookie) map[string]any {
	t.Helper()
	res := e.getPosition(t, id, c)
	requireStatus(t, res, http.StatusOK)
	var got map[string]any
	if err := json.Unmarshal([]byte(body(t, res)), &got); err != nil {
		t.Fatal(err)
	}
	clicked, present := got["clicked"]
	if !present {
		return nil
	}
	m, ok := clicked.(map[string]any)
	if !ok {
		t.Fatalf("clicked = %v, want an object", clicked)
	}
	return m
}

func TestAClickedCharacterRoundTrips(t *testing.T) {
	e := newEnv(t, buildFS())
	c := e.setup(t)
	id := e.importedID(t, c, fixture(t, "chapters.epub"))
	href := readingOrderHref(t, e, id, c, 0)

	cases := []struct {
		name    string
		clicked string
		want    map[string]any
	}{
		{
			name:    "block, offset and quote",
			clicked: `{"cssSelector":"[data-tomeshelf-block=\"7\"]","characterOffset":12,"text":{"before":"we ","highlight":"read here","after":" on"}}`,
			want: map[string]any{
				"cssSelector":     `[data-tomeshelf-block="7"]`,
				"characterOffset": float64(12),
				"text":            map[string]any{"before": "we ", "highlight": "read here", "after": " on"},
			},
		},
		{
			name:    "block and offset only",
			clicked: `{"cssSelector":"[data-tomeshelf-block=\"3\"]","characterOffset":0}`,
			want: map[string]any{
				"cssSelector":     `[data-tomeshelf-block="3"]`,
				"characterOffset": float64(0),
			},
		},
		{
			name:    "quote only, outside any numbered block",
			clicked: `{"text":{"highlight":"loose text"}}`,
			want: map[string]any{
				"text": map[string]any{"highlight": "loose text"},
			},
		},
	}
	for i, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			requireStatus(t, e.putPosition(t, id, c, clickedBody("tab-a", int64(i+1), href, tc.clicked)), http.StatusNoContent)
			if got := storedClicked(t, e, id, c); !reflect.DeepEqual(got, tc.want) {
				t.Errorf("clicked = %v, want %v", got, tc.want)
			}
		})
	}
}

func TestASaveWithoutClickedClearsTheStoredOne(t *testing.T) {
	e := newEnv(t, buildFS())
	c := e.setup(t)
	id := e.importedID(t, c, fixture(t, "chapters.epub"))
	href := readingOrderHref(t, e, id, c, 0)

	requireStatus(t, e.putPosition(t, id, c, saveBody("tab-a", 1, href, 0.5, "")), http.StatusNoContent)
	if got := storedClicked(t, e, id, c); got != nil {
		t.Fatalf("a position saved without clicked answers clicked = %v", got)
	}

	clicked := `{"cssSelector":"[data-tomeshelf-block=\"7\"]","characterOffset":12,"text":{"highlight":"read here"}}`
	requireStatus(t, e.putPosition(t, id, c, clickedBody("tab-a", 2, href, clicked)), http.StatusNoContent)
	if storedClicked(t, e, id, c) == nil {
		t.Fatal("clicked was not stored")
	}

	requireStatus(t, e.putPosition(t, id, c, saveBody("tab-a", 3, href, 0.6, "")), http.StatusNoContent)
	if got := storedClicked(t, e, id, c); got != nil {
		t.Errorf("after a save without clicked, clicked = %v, want none", got)
	}
}

func TestAMalformedClickedCharacterIsRejected(t *testing.T) {
	e := newEnv(t, buildFS())
	c := e.setup(t)
	id := e.importedID(t, c, fixture(t, "chapters.epub"))
	href := readingOrderHref(t, e, id, c, 0)
	requireStatus(t, e.putPosition(t, id, c, saveBody("tab-a", 1, href, 0.5, "")), http.StatusNoContent)

	for name, clicked := range map[string]string{
		"empty object":         `{}`,
		"null text only":       `{"text":{}}`,
		"empty highlight":      `{"text":{"highlight":""}}`,
		"selector alone":       `{"cssSelector":"[data-tomeshelf-block=\"1\"]"}`,
		"offset alone":         `{"characterOffset":3}`,
		"negative offset":      `{"cssSelector":"[data-tomeshelf-block=\"1\"]","characterOffset":-1}`,
		"empty selector":       `{"cssSelector":"","characterOffset":0}`,
		"unknown field":        `{"cssSelector":"[data-tomeshelf-block=\"1\"]","characterOffset":0,"progression":0.5}`,
		"unknown text field":   `{"text":{"highlight":"x","extra":"y"}}`,
		"not an object":        `"somewhere"`,
		"pair with empty text": `{"cssSelector":"[data-tomeshelf-block=\"1\"]","characterOffset":0,"text":{"before":"a"}}`,
	} {
		t.Run(name, func(t *testing.T) {
			requireJSONError(t, e.putPosition(t, id, c, clickedBody("tab-a", 2, href, clicked)), http.StatusBadRequest)
		})
	}
	if got := storedClicked(t, e, id, c); got != nil {
		t.Errorf("a rejected save stored clicked = %v", got)
	}
}
