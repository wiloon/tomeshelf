---
status: accepted
---

# Reading position is a Readium Locator; one URL per document; no CFI

Each document in a book's reading order has its own URL, e.g. `/books/:id/read/:n`. A table of contents entry that points inside a document opens that URL and scrolls to the fragment. The URL is per document, not per chapter, because one Gutenberg document holds several chapters while Standard Ebooks has one chapter per document.

tomeshelf stores each user's reading position on the server, shaped as a Readium Locator: the document's `href`, progression within the document, total progression, a CSS selector for the block (the Navigator numbers blocks) with a character offset inside it, and a text quote (`before`, `highlight`, `after`). Restoring tries the text quote first, then the block and offset, then the progression. Several redundant ways of locating are the established practice (Readium's Locator; the W3C Web Annotation selectors that Hypothesis uses), because any single one breaks when the content or layout changes.

## Considered Options

- **EPUB CFI**, used by epub.js, Calibre and Apple Books. Rejected for v1: it is a path of child indexes through the DOM. The Navigator rewrites the DOM, so a CFI computed on the rendered document doesn't match the original file. It breaks when the content changes, cannot carry over to another edition, and is complex to implement fully. CFI is needed only to exchange data with other readers, which is not a goal. If that changes, it is one more field in the Locator.
- **W3C Web Annotation.** It models annotations, not where the reader is. If highlights or notes come later, they can use its format, since its selectors map onto the Locator's.
- **Scroll percentage only.** It drifts when font size or window width changes. Kept only as the last fallback.

## Consequences

- The text quote has the same shape as ENX's sentence anchor (ADR-081 in the enx repo: the sentence plus 32 characters before and after). A later version can take ENX's last-looked-up sentence as the reading position with little conversion.
- Block numbers are stable only for the same book file and the same version of the Navigator's numbering rules. A change to those rules must keep old Locators resolvable through the text quote.
