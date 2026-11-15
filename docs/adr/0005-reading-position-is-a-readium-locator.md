---
status: accepted
---

# Reading position is a Readium Locator; one URL per document; no CFI

Each document in a book's reading order has its own URL, e.g. `/books/:id/read/:n`. A table of contents entry that points inside a document opens that URL and scrolls to the fragment. The URL is per document, not per chapter, because one Gutenberg document holds several chapters while Standard Ebooks has one chapter per document.

tomeshelf stores each user's reading position on the server, shaped as a Readium Locator: the document's `href`, progression within the document, total progression, a CSS selector for the block (the Navigator numbers blocks) with a character offset inside it, and a text quote (`before`, `highlight`, `after`). Restoring tries the text quote first, then the block and offset, then the progression. Several redundant ways of locating are the established practice (Readium's Locator; the W3C Web Annotation selectors that Hypothesis uses), because any single one breaks when the content or layout changes.

The fields are measured like this, so that every device computes and resolves them the same way:

- **Anchor.** The position is the first visible character: the first non-whitespace character of the article, in document order, whose box reaches below the top of the viewport and starts above its bottom. The block is the innermost numbered block containing that character (a `p` inside an `li` is the `p`; text of the `li` outside the `p` is the `li`), and the character offset is that character's offset within the block. Text in no numbered block stores no block and offset, only the quote and the progressions. When no character is visible (an image fills the viewport, or the document has no text), the position is the progressions alone. Restoring skips the methods whose fields are missing and puts the anchored character at the top of the viewport. When the page cannot scroll that far (the anchor is near the end of the document, or the document fits in the viewport), restoring scrolls as far as the page allows, so the anchored character is visible below the top; the reader adds no trailing space, since that would change the layout extensions see and the progression measure. Restoring does not count as the reader moving, so it saves nothing and the stored position stays as it was until the reader scrolls.
- **Text.** Character offsets count UTF-16 code units of the block's `textContent`: every descendant text node in document order, whatever markup nests it, with whitespace kept as it is.
- **Quote.** `highlight` is up to 64 characters of the article's `textContent` starting at the anchor; `before` and `after` are up to 32 characters on each side. When the quote occurs more than once in the document, restoring picks one deterministically: first the occurrence whose block is fewest block numbers away from the stored block (when a block is stored; an occurrence outside any numbered block counts as farthest); among those still tied, or when no block is stored, the occurrence whose progression (where restoring it would scroll, by the Progression measure) is nearest the stored progression; and among those still tied, the first in document order.
- **Progression** within the document is how far it is scrolled, from 0 at its top to 1 when its end is in view: the scroll offset past the article's top divided by the article's height minus the viewport's height, clamped to 0..1 (1 when the article fits in the viewport).
- **Total progression** weights each document of the reading order by its uncompressed size in the EPUB, so a short cover document doesn't count as much as a long one. The server computes it from the `href` and the progression when it stores a position, since only the Streamer knows those sizes.

The library reaches a book through a resume address, `/books/:id/read`, which opens the stored document's address at the stored position, or the first document's top when there is none. A document's own address always opens that document as addressed, at its top or its fragment, and never jumps to the stored position: following Previous, Next, a table of contents entry or a link is the reader's explicit choice.

Each user has one reading position per book. The last save the server accepts wins, across tabs and devices. Within one tab, saves carry an increasing sequence number. The server keeps, per user, book and tab, the highest sequence number it has accepted, apart from the stored position, and ignores a save whose sequence number is no greater than its tab's highest, so a slow request cannot overwrite a newer position, even after another tab has saved in between.

## Considered Options

- **EPUB CFI**, used by epub.js, Calibre and Apple Books. Rejected for v1: it is a path of child indexes through the DOM. The Navigator rewrites the DOM, so a CFI computed on the rendered document doesn't match the original file. It breaks when the content changes, cannot carry over to another edition, and is complex to implement fully. CFI is needed only to exchange data with other readers, which is not a goal. If that changes, it is one more field in the Locator.
- **W3C Web Annotation.** It models annotations, not where the reader is. If highlights or notes come later, they can use its format, since its selectors map onto the Locator's.
- **Scroll percentage only.** It drifts when font size or window width changes. Kept only as the last fallback.

## Consequences

- The text quote has the same shape as ENX's sentence anchor (ADR-081 in the enx repo: the sentence plus 32 characters before and after). A later version can take ENX's last-looked-up sentence as the reading position with little conversion.
- Block numbers are stable only for the same book file and the same version of the Navigator's numbering rules. A change to those rules must keep old Locators resolvable through the text quote.
- Last save wins, so a device left open on an old page could overwrite a newer position from another device. A tab therefore saves only after its reader has moved; it sends nothing when it is merely hidden or closed without having moved since its last save.

## Revisions

- 2026-11-14, issue #10: defined how the anchor, character offset, quote and progressions are measured, weighted total progression by document size, added the resume address that is the only way a stored position is applied, and chose last-save-wins with per-tab ordering, since these decide what is stored and what every device restores.
- 2026-11-14, issue #10 (spec review round 2): the anchor is now the first visible character and its innermost numbered block, since an enclosing `li` can start far above the visible text, and text outside numbered blocks or a viewport with no text stores fewer fields; the server tracks each tab's highest accepted sequence number separately from the stored position, since comparing only with the stored position let a delayed save overwrite newer ones once another tab had saved.
- 2026-11-14, issue #10 (spec review round 3): a repeated quote is resolved by block distance, then progression, then document order, since a quote can be stored without a block and two occurrences can be equally near; at the scroll limit restoring scrolls as far as it can instead of adding trailing space, and does not save, since the anchored character cannot always reach the top.
