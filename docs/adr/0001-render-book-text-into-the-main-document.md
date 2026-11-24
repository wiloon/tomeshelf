---
status: accepted
---

# Render book text into the main document, not an iframe

Tomeshelf exists so that word-lookup browser extensions, ENX first, work on the books a person hosts. Mainstream web readers (Calibre-Web and Audiobookshelf with epub.js, Komga and Stump with Readium, BookLore with foliate-js) put each document in an iframe, and BookLore adds a shadow DOM on top. ENX injects into and talks to the top-level frame only, so it never sees the book text there. We decided that the Navigator renders each document straight into the page's own DOM: no iframe, no shadow DOM, no canvas.

For a general-purpose reader the iframe is the right call: it isolates the publisher's CSS and scripts, gives CSS-column pagination its own document, and keeps relative URLs and CFIs valid. Tomeshelf ranks ENX compatibility above showing the publisher's layout as-is, so it gives that up. The isolation the iframe would have provided comes from elsewhere: sanitizing (ADR-0004) and dropping the book's CSS (ADR-0003).

## Considered Options

- **Readium's TypeScript Navigator in iframes, and teach ENX to reach into iframes.** This is the least Tomeshelf code and keeps the publisher's layout. Rejected: ENX would need frame-aware injection and messaging across its background worker, side panel and content script. Paginated iframe readers would still conflict with ENX: they own the scroll position (so ENX's "jump back to the sentence" fights the navigator), preload hidden documents, and take clicks for page turns. ENX supporting third-party iframe readers stays a possible, separate ENX project.
- **Use Kavita**, which already renders into the main DOM. Rejected: its EPUB reader isn't built around Readium, and the owner wants a Go and React codebase they control.

## Consequences

- v1 scrolls; it has no pagination. Pagination uses CSS columns on the article itself, not an iframe (ADR-0010).
- Any later change that moves book text out of the main document breaks ENX. ADR-0006's contract tests guard against this.

## Revisions

- 2026-11-14, ADR-0010: pagination is now decided, with CSS columns on the article.
