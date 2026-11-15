# The DOM contract for reading extensions

This page is for authors of browser extensions, such as word-lookup tools, that read the book text on tomeshelf's reading pages. It describes the markup tomeshelf promises on those pages. The decision behind it is ADR-0006 (`docs/adr/0006-dom-contract-for-reading-extensions.md`).

Every tomeshelf instance is self-hosted on its own domain, so match the markup below, not URLs. URL paths are not part of the contract.

## What a reading page carries

A reading page shows one document of a book: one XHTML file in the book's reading order.

- **`<meta name="generator" content="tomeshelf <version>">`** in the `head`. It marks the page as a tomeshelf reading page. The version is free text without spaces (a release tag, a commit, or `dev`), so match the `tomeshelf ` prefix rather than a version.
- **`<meta name="tomeshelf:book" content="<book id>">`** in the `head`. The book id is an opaque string, the same on every document of a book and different for every other book in the same instance. Use it to treat the documents of a book as one book.
- **One `<article id="tomeshelf-content">`** that holds the document's text. It is in the page's main DOM: no iframe and no shadow root holds the text (ADR-0001).
- **`data-tomeshelf-block="<n>"`** on each block. Blocks are the `p`, `h1` to `h6` and `li` elements inside the article. They are numbered per document, from 1, in document order (pre-order, so an `li` comes before a `p` nested in it).

Only tomeshelf writes this markup. A book's own `data-tomeshelf-*` attributes, `id="tomeshelf-content"` and `meta` elements are removed before the document is shown, so a book cannot forge any of it.

## Moving between documents

tomeshelf is a single-page app. When the reader moves to another document, the page does not reload:

- The article's content is replaced by the new document, and its blocks are numbered again from 1. Look the article up by its id after a move rather than keeping a reference to it.
- The meta tags stay correct: `tomeshelf:book` keeps the book's id within a book and changes when another book is opened.
- Pages that are not reading pages, such as the library, carry none of these meta tags.

Watch the page (for example with a `MutationObserver`) to notice a move.

## Pages and scrolling

A reader can show a document as one scroll or as pages (ADR-0010). In the pages layout the article itself scrolls horizontally, one spread of one or two pages at a time, and the window does not scroll. Text on other pages is in the DOM but outside the article's visible box.

- To bring an element into view, call `element.scrollIntoView()`. It works in both layouts; tomeshelf then aligns the article to the spread holding it.
- To tell whether text is visible, compare its box with the article's box (`getBoundingClientRect()`), not with the window.

The layout is not part of the contract: do not depend on the article's CSS.

## Reserved: `tomeshelf:restores-position`

`<meta name="tomeshelf:restores-position" content="true">` is reserved. It will declare that tomeshelf itself reopens a book at its reading position, so an extension that also tracks reading positions should not offer its own "continue reading" jump on these pages.

The tag is a promise, so it is added only when tomeshelf saves and restores reading positions (ADR-0005). Until then, reading pages carry no such tag.

## Stability

Each item above is a public API. Changing any of them (renaming, removing or moving a tag or attribute, changing what counts as a block or how blocks are numbered, or moving the text out of the main DOM) is a breaking change for extensions. Playwright contract tests in `web/e2e/contract.spec.ts` pin every item.
