---
status: accepted
---

# Drop the book's CSS in v1

With no iframe (ADR-0001), a book's stylesheets would apply to the whole page, including tomeshelf's own UI and any overlay an extension draws. In v1 the Navigator therefore drops the book's stylesheets and `style` attributes. tomeshelf's own typography styles the document instead. It covers common HTML elements and the semantic `epub:type` values Standard Ebooks uses (poetry, letters, epigraphs), and the reader can change font size, line height, width and theme. Emphasis, headings and quotations survive, because they come from the markup, not the CSS.

When a later version keeps the book's CSS, it scopes it with CSS `@scope` to the content container and puts it in a lower `@layer` than tomeshelf's styles. It does not use a shadow DOM: a shadow DOM would hide the text from extensions again. Any technique used here must leave the book text in the main DOM.

## Considered Options

- **Keep the book's CSS, scoped and filtered, from v1.** Deferred, not rejected: it costs little with `@scope` and `@layer`, but v1 has no book that needs it yet.
- **Evaluate ReadiumCSS as the typography base.** Open: it is designed for a document inside an iframe, so it needs scoping to the container. A spike decides; v1 does not depend on it.
