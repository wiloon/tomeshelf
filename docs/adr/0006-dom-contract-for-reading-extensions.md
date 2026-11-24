---
status: accepted
---

# A public DOM contract for reading extensions

Tomeshelf doesn't depend on ENX or call it. Its reading pages make promises about their markup instead, so any extension can recognise them, whatever the hostname. Every self-hosted instance has its own domain, so URL rules cannot work.

Each reading page carries:

- `<meta name="generator" content="tomeshelf <version>">`, the signal that this is a Tomeshelf page.
- `<meta name="tomeshelf:book" content="<book id>">`, the same value on every document of a book, so an extension can treat the documents as one book. The id is an opaque string and never names a different book (ADR-0015).
- `<meta name="tomeshelf:restores-position" content="true">`, which declares that Tomeshelf itself reopens a book at its reading position. An extension that also tracks reading positions should not offer its own "continue reading" jump on these pages. The tag is a promise, so it ships with the work that saves and restores reading positions (ADR-0005), not before: until then reading pages carry no such tag.
- One `<article id="tomeshelf-content">` holding the document's text, in the main DOM (ADR-0001).
- `data-tomeshelf-block="<n>"` on each block. Blocks are the `p`, `h1` to `h6` and `li` elements inside the article, after sanitizing. They are numbered per document, from 1, in document order (pre-order, so an `li` comes before a `p` nested in it). Only the Navigator writes the contract's markup: the book's own `data-tomeshelf-*` attributes, `id="tomeshelf-content"` and `meta` elements are removed before numbering.

The meta tags are updated when the Navigator moves to another document within the single-page app.

The contract is documented for extension authors and pinned by Playwright contract tests: a fixture book is opened and the test checks every item above, plus the absence of iframes and shadow roots around the text. A change that breaks a test is a breaking change for extensions.

## Consequences

- ENX needs a small change: a platform rule matching the generator, the book key read from `tomeshelf:book`, and its resume hint suppressed when `tomeshelf:restores-position` is present. This is tracked in wiloon/enx#907 and is to be specified once Tomeshelf is stable.
- In the pages layout the article may hold one empty `<span data-tomeshelf-page-start>`, and a text node may be split where a spread starts and merged again when the spread start moves (ADR-0010). Neither is part of the contract: the element holds no text and is not a block, and the article's `textContent` and block numbers stay the same. An extension should locate text by block and offset or by quote, not by keeping text nodes across spread turns.
- A later version may listen for a DOM event that ENX dispatches with the sentence it looked up, and store that as the reading position (ADR-0005). That event would be added to this contract when it is designed.

## Revisions

- 2026-11-14, issue #7: defined which elements are blocks and how they are numbered, since the numbers are a public selector. The `tomeshelf:restores-position` tag now ships with position restoration, so a reading page never promises what it does not yet do.
- 2026-11-17, ADR-0015: the book id is an opaque string that never names a different book. Its value changes from an integer to the original's SHA-256, so an extension's data keyed by an old integer id no longer matches.
- 2026-11-23, ADR-0010 (issue #138): noted the pages layout's empty spread-start marker and split text nodes, which are outside the contract, so extension authors don't depend on text node identity.
