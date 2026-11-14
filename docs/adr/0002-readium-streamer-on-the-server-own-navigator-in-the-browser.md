---
status: accepted
---

# Readium Streamer on the server, our own Navigator in the browser

We split the reader the way Readium does. The server is a Streamer built on `readium/go-toolkit`. It opens the EPUB, describes the book as a Readium Web Publication Manifest (RWPM), and serves any file inside the package as-is by its path. The browser holds the Navigator. It fetches one document, sanitizes it, rewrites resource URLs, numbers its blocks and renders it (ADR-0001). The RWPM is the API between the two, so the Streamer behind it could be replaced without touching the browser. The browser can use Readium's own TypeScript models (`@readium/shared`).

We use Readium's parts wherever they don't force an iframe: go-toolkit, RWPM, and the Locator (ADR-0005). Only Readium's TypeScript Navigator is left out, because it renders into iframes.

## Considered Options

- **All in the server** (parse, sanitize and rewrite each document in Go, as Kavita does). Rejected: the HTML would be sanitized by Go's parser and then parsed again by the browser's. When the two disagree, mutation XSS can slip through. It would also put the "ENX-friendly markup" rules in Go, away from the code that renders them.
- **All in the browser** (download the whole EPUB, as epub.js does). Rejected: a phone downloads the whole book (Gutenberg's illustrated *Pride and Prejudice* is 24 MB) to read one document, and the library list still needs the server to read metadata and covers.
- **Our own EPUB parser on Go's standard library.** Rejected: go-toolkit parsed both test books correctly (Standard Ebooks and Gutenberg *Pride and Prejudice*, EPUB 3, 2 to 7 ms to open, under 1 ms per document), and the owner prefers not to rebuild it.

## Consequences

- We pin go-toolkit at its latest release, v0.16.1. That release pulls in the AWS and Google Cloud SDKs, so the binary is about 57 MB, or 40 MB stripped. The `readium_nocloud` build tag drops them (14.8 MB), but it exists only on the unreleased `develop` branch. Upgrade when a release ships it. go-toolkit is pre-1.0, so its API may change between releases.
- A reading-order document can hold several chapters (Gutenberg's file holds about seven), so the Navigator's unit is the document, not the chapter (ADR-0005).
