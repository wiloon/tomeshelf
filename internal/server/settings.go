package server

import (
	"context"
	"encoding/json"
	"io"
	"math"
	"net/http"
	"slices"

	"github.com/wiloon/tomeshelf/internal/store"
)

// Settings is the storage of each user's reading settings. *store.Store
// implements it.
type Settings interface {
	ReadingSettings(ctx context.Context, username string) (store.ReadingSettings, bool, error)
	SaveReadingSettings(ctx context.Context, username string, rs store.ReadingSettings) error
}

// defaultSettings are the reading settings of a user who saved none: the
// reading page's look before settings existed.
var defaultSettings = store.ReadingSettings{FontSize: 18, LineHeight: 1.6, Width: 38, Theme: "light"}

var themes = []string{"light", "dark", "sepia"}

type settingsJSON struct {
	FontSize   *float64 `json:"fontSize"`
	LineHeight *float64 `json:"lineHeight"`
	Width      *float64 `json:"width"`
	Theme      *string  `json:"theme"`
}

// stepped reports whether v is one of min, min+step, … up to max.
func stepped(v *float64, low, high, step float64) bool {
	if v == nil || *v < low-1e-9 || *v > high+1e-9 {
		return false
	}
	n := (*v - low) / step
	return math.Abs(n-math.Round(n)) < 1e-6
}

// validSettings checks a complete settings object against the settings
// contract.
func validSettings(s settingsJSON) (store.ReadingSettings, bool) {
	if !stepped(s.FontSize, 14, 28, 1) ||
		!stepped(s.LineHeight, 1.2, 2, 0.1) ||
		!stepped(s.Width, 28, 48, 2) ||
		s.Theme == nil || !slices.Contains(themes, *s.Theme) {
		return store.ReadingSettings{}, false
	}
	return store.ReadingSettings{
		FontSize:   int64(math.Round(*s.FontSize)),
		LineHeight: math.Round(*s.LineHeight*10) / 10,
		Width:      int64(math.Round(*s.Width)),
		Theme:      *s.Theme,
	}, true
}

// getSettings answers the signed-in user's reading settings, or the defaults
// when the user saved none.
func (s *site) getSettings(w http.ResponseWriter, r *http.Request) {
	user, ok := s.requireUser(w, r)
	if !ok {
		return
	}
	rs, saved, err := s.settings.ReadingSettings(r.Context(), user)
	if err != nil {
		s.apiError(w, err)
		return
	}
	if !saved {
		rs = defaultSettings
	}
	fontSize, lineHeight, width := float64(rs.FontSize), rs.LineHeight, float64(rs.Width)
	writeJSON(w, http.StatusOK, settingsJSON{FontSize: &fontSize, LineHeight: &lineHeight, Width: &width, Theme: &rs.Theme})
}

// putSettings replaces the signed-in user's reading settings with the
// complete settings object in the body, or stores nothing and answers 400.
func (s *site) putSettings(w http.ResponseWriter, r *http.Request) {
	user, ok := s.requireUser(w, r)
	if !ok {
		return
	}
	var body settingsJSON
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10))
	dec.DisallowUnknownFields()
	err := dec.Decode(&body)
	if err == nil {
		var extra any
		if end := dec.Decode(&extra); end != io.EOF {
			err = io.ErrUnexpectedEOF
		}
	}
	rs, valid := validSettings(body)
	if err != nil || !valid {
		writeError(w, http.StatusBadRequest, "the body must be a JSON object with fontSize 14–28, lineHeight 1.2–2.0 in steps of 0.1, width 28–48 in steps of 2 and theme light, dark or sepia")
		return
	}
	if err := s.settings.SaveReadingSettings(r.Context(), user, rs); err != nil {
		s.apiError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
