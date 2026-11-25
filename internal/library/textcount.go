package library

import (
	"io"

	"golang.org/x/net/html"
)

// countText counts a document's characters and pictures for page-number
// estimates (ADR-0010 Page numbers). Characters are the non-whitespace UTF-16
// code units of the body's text, leaving out script and style; pictures are
// the img, svg and video elements not inside an svg. The browser Streamer
// must count the same way (ADR-0012).
func countText(r io.Reader) (characters, pictures int) {
	z := html.NewTokenizer(r)
	inBody := false
	skip := 0
	svg := 0
	for {
		tt := z.Next()
		switch tt {
		case html.ErrorToken:
			return characters, pictures
		case html.StartTagToken, html.SelfClosingTagToken:
			name, _ := z.TagName()
			self := tt == html.SelfClosingTagToken
			if self {
				// XHTML allows <script/>: it holds no raw text.
				z.NextIsNotRawText()
			}
			switch string(name) {
			case "body":
				inBody = true
			case "script", "style":
				if !self {
					skip++
				}
			case "img", "video":
				if inBody && svg == 0 {
					pictures++
				}
			case "svg":
				if inBody && svg == 0 {
					pictures++
				}
				if !self {
					svg++
				}
			}
		case html.EndTagToken:
			name, _ := z.TagName()
			switch string(name) {
			case "body":
				inBody = false
			case "script", "style":
				if skip > 0 {
					skip--
				}
			case "svg":
				if svg > 0 {
					svg--
				}
			}
		case html.TextToken:
			if !inBody || skip > 0 {
				continue
			}
			for _, c := range string(z.Text()) {
				if isJSSpace(c) {
					continue
				}
				if c >= 0x10000 {
					characters += 2
				} else {
					characters++
				}
			}
		}
	}
}

// isJSSpace matches JavaScript's \s, which the browser counts with.
func isJSSpace(c rune) bool {
	switch c {
	case '\t', '\n', '\v', '\f', '\r', ' ', 0x00a0, 0x1680, 0x2028, 0x2029,
		0x202f, 0x205f, 0x3000, 0xfeff:
		return true
	}
	return c >= 0x2000 && c <= 0x200a
}
