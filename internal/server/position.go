package server

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"

	"github.com/wiloon/tomeshelf/internal/library"
	"github.com/wiloon/tomeshelf/internal/store"
)

type locationsJSON struct {
	Progression      *float64 `json:"progression"`
	TotalProgression *float64 `json:"totalProgression,omitempty"`
	CSSSelector      *string  `json:"cssSelector,omitempty"`
	CharacterOffset  *int64   `json:"characterOffset,omitempty"`
}

type textJSON struct {
	Before    *string `json:"before,omitempty"`
	Highlight *string `json:"highlight,omitempty"`
	After     *string `json:"after,omitempty"`
}

// clickedJSON is the character the user last clicked or selected on the
// spread (ADR-0005 Clicked character): its block and offset, its quote, or
// both.
type clickedJSON struct {
	CSSSelector     *string   `json:"cssSelector,omitempty"`
	CharacterOffset *int64    `json:"characterOffset,omitempty"`
	Text            *textJSON `json:"text,omitempty"`
}

type locatorJSON struct {
	Href      string         `json:"href"`
	Locations *locationsJSON `json:"locations"`
	Text      *textJSON      `json:"text,omitempty"`
	Clicked   *clickedJSON   `json:"clicked,omitempty"`
}

type savePositionJSON struct {
	TabID     string         `json:"tabId"`
	Sequence  *int64         `json:"sequence"`
	Href      string         `json:"href"`
	Locations *locationsJSON `json:"locations"`
	Text      *textJSON      `json:"text,omitempty"`
	Clicked   *clickedJSON   `json:"clicked,omitempty"`
}

// validClicked reports whether a clicked character locates something: a
// block selector with a character offset, both or neither, and a quote with a
// highlight when it has one.
func validClicked(c *clickedJSON) bool {
	hasSelector, hasOffset := c.CSSSelector != nil, c.CharacterOffset != nil
	if hasSelector != hasOffset {
		return false
	}
	if hasSelector && (*c.CSSSelector == "" || *c.CharacterOffset < 0) {
		return false
	}
	if c.Text != nil && (c.Text.Highlight == nil || *c.Text.Highlight == "") {
		return false
	}
	return hasSelector || c.Text != nil
}

func toClicked(c *clickedJSON) *store.ClickedCharacter {
	if c == nil {
		return nil
	}
	out := &store.ClickedCharacter{
		CSSSelector:     c.CSSSelector,
		CharacterOffset: c.CharacterOffset,
	}
	if c.Text != nil {
		out.TextBefore = c.Text.Before
		out.TextHighlight = c.Text.Highlight
		out.TextAfter = c.Text.After
	}
	return out
}

func toLocatorJSON(p store.ReadingPosition) locatorJSON {
	loc := &locationsJSON{
		Progression:      &p.Progression,
		TotalProgression: &p.TotalProgression,
		CSSSelector:      p.CSSSelector,
		CharacterOffset:  p.CharacterOffset,
	}
	out := locatorJSON{Href: p.Href, Locations: loc}
	if c := p.Clicked; c != nil {
		out.Clicked = &clickedJSON{CSSSelector: c.CSSSelector, CharacterOffset: c.CharacterOffset}
		if c.TextBefore != nil || c.TextHighlight != nil || c.TextAfter != nil {
			out.Clicked.Text = &textJSON{Before: c.TextBefore, Highlight: c.TextHighlight, After: c.TextAfter}
		}
	}
	if p.TextBefore != nil || p.TextHighlight != nil || p.TextAfter != nil {
		out.Text = &textJSON{
			Before:    p.TextBefore,
			Highlight: p.TextHighlight,
			After:     p.TextAfter,
		}
	}
	return out
}

// getPosition answers the signed-in user's stored reading position for a book.
func (s *site) getPosition(w http.ResponseWriter, r *http.Request) {
	user, ok := s.requireUser(w, r)
	if !ok {
		return
	}
	id, ok := bookID(w, r)
	if !ok {
		return
	}
	p, err := s.books.ReadingPosition(r.Context(), user, id)
	switch {
	case err == nil:
		writeJSON(w, http.StatusOK, toLocatorJSON(p))
	case errors.Is(err, store.ErrUnknownBook):
		writeError(w, http.StatusNotFound, "not found")
	default:
		s.apiError(w, err)
	}
}

// putPosition stores a reading position for the signed-in user. The server
// computes total progression and rejects an href outside the reading order.
// A sequence no newer than the tab's highest is ignored (ADR-0005).
func (s *site) putPosition(w http.ResponseWriter, r *http.Request) {
	user, ok := s.requireUser(w, r)
	if !ok {
		return
	}
	id, ok := bookID(w, r)
	if !ok {
		return
	}
	var body savePositionJSON
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10))
	dec.DisallowUnknownFields()
	err := dec.Decode(&body)
	if err == nil {
		var extra any
		if end := dec.Decode(&extra); end != io.EOF {
			err = io.ErrUnexpectedEOF
		}
	}
	if err != nil || body.TabID == "" || body.Sequence == nil || *body.Sequence < 1 ||
		body.Href == "" || body.Locations == nil || body.Locations.Progression == nil ||
		*body.Locations.Progression < 0 || *body.Locations.Progression > 1 {
		writeError(w, http.StatusBadRequest, "the body must be a JSON object with tabId, sequence ≥ 1, href and locations.progression in 0..1")
		return
	}
	if (body.Locations.CSSSelector == nil) != (body.Locations.CharacterOffset == nil) {
		writeError(w, http.StatusBadRequest, "cssSelector and characterOffset must both be set or both omitted")
		return
	}
	if body.Clicked != nil && !validClicked(body.Clicked) {
		writeError(w, http.StatusBadRequest, "clicked needs a non-empty cssSelector with characterOffset ≥ 0, a text.highlight, or both")
		return
	}

	total, err := s.books.TotalProgression(r.Context(), user, id, body.Href, *body.Locations.Progression)
	switch {
	case err == nil:
	case errors.Is(err, store.ErrUnknownBook):
		writeError(w, http.StatusNotFound, "not found")
		return
	case errors.Is(err, library.ErrBadHref):
		writeError(w, http.StatusBadRequest, "href is not in the reading order")
		return
	default:
		s.apiError(w, err)
		return
	}

	p := store.ReadingPosition{
		Href:             body.Href,
		Progression:      *body.Locations.Progression,
		TotalProgression: total,
		CSSSelector:      body.Locations.CSSSelector,
		CharacterOffset:  body.Locations.CharacterOffset,
		Clicked:          toClicked(body.Clicked),
	}
	if body.Text != nil {
		p.TextBefore = body.Text.Before
		p.TextHighlight = body.Text.Highlight
		p.TextAfter = body.Text.After
	}
	_, err = s.books.SaveReadingPosition(r.Context(), user, id, body.TabID, *body.Sequence, p)
	switch {
	case err == nil:
		w.WriteHeader(http.StatusNoContent)
	case errors.Is(err, store.ErrUnknownBook):
		writeError(w, http.StatusNotFound, "not found")
	default:
		s.apiError(w, err)
	}
}
