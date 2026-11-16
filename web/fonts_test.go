package web_test

import (
	"io/fs"
	"path"
	"strings"
	"testing"

	"github.com/wiloon/tomeshelf/web"
)

func TestBundledFontsHaveFourWoff2FacesAndALicense(t *testing.T) {
	fonts := web.Fonts()
	for _, family := range []string{"literata", "charter", "source-serif-4"} {
		t.Run(family, func(t *testing.T) {
			entries, err := fs.ReadDir(fonts, family)
			if err != nil {
				t.Fatal(err)
			}
			var woff2, licenses []string
			for _, e := range entries {
				name := e.Name()
				switch {
				case strings.HasSuffix(name, ".woff2"):
					woff2 = append(woff2, name)
				case name == "OFL.txt" || name == "LICENSE.txt":
					licenses = append(licenses, name)
				}
			}
			if len(woff2) != 4 {
				t.Errorf("%s has %d woff2 files %v, want 4", family, len(woff2), woff2)
			}
			for _, face := range []string{"Regular", "Italic", "Bold", "BoldItalic"} {
				found := false
				for _, name := range woff2 {
					if strings.HasSuffix(name, "-"+face+".woff2") {
						found = true
						break
					}
				}
				if !found {
					t.Errorf("%s has no %s face among %v", family, face, woff2)
				}
			}
			if len(licenses) != 1 {
				t.Errorf("%s has license files %v, want one OFL.txt or LICENSE.txt", family, licenses)
			}
			for _, name := range woff2 {
				info, err := fs.Stat(fonts, path.Join(family, name))
				if err != nil {
					t.Fatal(err)
				}
				if info.Size() == 0 {
					t.Errorf("%s/%s is empty", family, name)
				}
			}
		})
	}
}
