package web

import (
	"embed"
	"io/fs"
)

// BundledFonts are the reading typefaces shipped with tomeshelf: each
// family directory holds four woff2 faces and a license file.
//
//go:embed all:public/fonts
var BundledFonts embed.FS

// Fonts returns the bundled font files, rooted at the family directories
// (literata/, charter/, source-serif-4/).
func Fonts() fs.FS {
	fonts, err := fs.Sub(BundledFonts, "public/fonts")
	if err != nil {
		panic(err)
	}
	return fonts
}
