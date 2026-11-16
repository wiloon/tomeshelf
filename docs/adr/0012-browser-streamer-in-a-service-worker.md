---
status: accepted
---

# A browser Streamer in TypeScript, served by a Service Worker

On a public instance (ADR-0011) the Streamer runs in the browser. It is our own TypeScript EPUB parser that produces the same Readium Web Publication Manifest as go-toolkit, using `@readium/shared`'s models, and a Service Worker that answers the Streamer's addresses from the EPUB in browser storage. ADR-0002 already made the RWPM the boundary so that the Streamer could be replaced without touching the Navigator; this uses that boundary.

- **No Readium parser exists for the browser.** `readium/ts-toolkit` publishes only models (`@readium/shared`), an HTTP fetcher and an iframe navigator; it expects a server-side Streamer. `readium/r2-streamer-js` is a Node.js server. So we write the parser: ZIP reading (a small library such as zip.js or fflate), `META-INF/container.xml`, the OPF's metadata, manifest and spine, the EPUB 3 nav document and the EPUB 2 NCX, the cover, the reading order's document sizes, refusal of DRM-encrypted books and de-obfuscation of obfuscated fonts (ADR-0007). go-toolkit and r2-streamer-js are its reference implementations.
- **Same addresses, same headers.** The Service Worker answers `GET /api/books/{id}/manifest`, `.../package/{path...}` and `.../thumbnail` for books in browser storage, where `{id}` is the book's SHA-256. Package files carry `Content-Security-Policy: sandbox` and `X-Content-Type-Options: nosniff` as the Go Streamer sends them (ADR-0004). Images keep same-origin URLs, so the app's CSP needs no `blob:` source and the Navigator does not change.
- **The parser runs where the book is.** Parsing happens on import (for the library's title, author and cover, kept in browser storage) and on open; the Service Worker caches the parsed manifest per book.
- **A page must be controlled before it reads.** A hard reload bypasses the Service Worker, and its requests reach the server, which answers 404 on a public instance (ADR-0011). The reader checks `navigator.serviceWorker.controller` and reloads once under it before opening a book.

## Considered Options

- **go-toolkit compiled to WebAssembly.** Rejected: one parser for both instances is attractive, but the go-toolkit binary is 15 to 40 MB (ADR-0002), a Service Worker is stopped and restarted by the browser at will and would load it again each time, and TinyGo does not compile go-toolkit's dependencies as they stand. The parser itself is small; keeping it in TypeScript keeps one toolchain in the browser.
- **Blob URLs instead of a Service Worker.** Rejected: every image and stylesheet in a document would have to be rewritten to a `blob:` URL by the Navigator, the CSP would have to allow `blob:`, and the sandbox headers on package files could not be set.

## Consequences

- Two parsers must agree, or the same book gets different document addresses and Locators on the two kinds of instance. A contract test runs both over every book in `testdata/` and requires identical reading order, `href`s, document sizes, table of contents and the metadata the library shows. A book that the two parse differently is a bug in one of them.
- The Streamer's work that the server did in ADR-0005, computing total progression from document sizes, is done by the browser Streamer on a public instance.
