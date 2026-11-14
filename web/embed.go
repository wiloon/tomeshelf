// Package web embeds the browser app's static build. Run the frontend build
// (task build:web) before compiling, so dist exists.
package web

import (
	"embed"
	"io/fs"
)

//go:embed all:dist
var dist embed.FS

// Build returns the static build, rooted at its index.html.
func Build() fs.FS {
	build, err := fs.Sub(dist, "dist")
	if err != nil {
		panic(err)
	}
	return build
}
