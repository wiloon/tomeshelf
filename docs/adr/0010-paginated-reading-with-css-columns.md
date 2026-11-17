---
status: proposed
---

# Paginated reading with CSS columns on the article

The reader shows a document as pages that fit the window, one or two at a time, with no scrollbar, as print-like web readers do (WeChat Read, Kindle Cloud Reader). Long scrolls make it hard to keep one's place and to judge how much is left. We decided to lay the article out in CSS columns and move through it by its horizontal scroll position, keeping the text in the main document (ADR-0001). The scroll layout stays as a reading setting until the paginated layout has proven itself; it may then be removed.

- **Layout.** A reading setting, next to font size, line spacing and text width, with two values: *pages* (the default) and *scroll* (today's reader). It is stored per user on the server like the other reading settings, so it follows the reader across devices. Saved settings without a layout read as *pages*.
- **Page and spread.** In the pages layout the article is as tall as the window minus the reader's controls, and its text flows into columns. Each column is a page, as wide as the text width setting, or as wide as the space available when that is narrower (a phone): the text width setting stays a maximum, as in the scroll layout. A spread is the pages shown at once: two when the space available holds two pages at the text width setting plus the gap between them, otherwise one. The document page itself never scrolls; only the article does, horizontally, with its scrollbar hidden.
- **Moving by scroll position, not by transform.** The visible spread is the article's `scrollLeft`. Because the article is an ordinary scroll container, `element.scrollIntoView()`, the browser's find-in-page, fragment links and a word-lookup extension jumping back to a sentence all bring the text into view without knowing about pages. When something scrolls the article to an offset that is not a spread's start, the reader aligns it to the spread holding the first visible character once the scroll ends.
- **Turning spreads.** The Previous and Next controls, the Left/Right arrow keys, Page Up/Page Down, Space and Shift+Space, a horizontal swipe on touch screens, and one wheel or trackpad gesture each turn one spread. Clicking or tapping the text never turns a spread: clicks on the text belong to the reader and to extensions (ENX looks a word up on click). Input that belongs to something else is left to it:
  - Keys do not turn a spread when focus is in a form control, button, link, radio group or editable element (the settings panel's theme radios use the arrow keys), or when Ctrl, Alt or Meta is held, or Shift with any key but Space, so browser shortcuts and selection keys keep working.
  - Ctrl + wheel, including trackpad pinch gestures reported as Ctrl + wheel, is left to the browser for zooming. It neither turns a spread nor changes the wheel gesture's quiet interval.
  - A wheel or swipe over a nested scroll area (a wide table or `pre`) that can still scroll in the gesture's direction scrolls that area; at its edge, or in a direction it cannot scroll, the gesture turns a spread.
  - One gesture turns at most one spread. A swipe is one touch from start to end, horizontal and long enough to be deliberate. Wheel events, including trackpad momentum, belong to one gesture until the wheel has been quiet for a short interval (about 300 ms); a burst turns one spread, however long it lasts, and so cannot cross into a second document.
  - The reading setting *Wheel turns pages* (on by default) can switch the wheel off, for readers whose resting hand or momentum turns spreads by accident. When it is off, wheel and trackpad gestures over the text turn no spread and are not default-prevented, and the article takes `overflow-x: hidden`, so the browser does not scroll it natively either. It stays a scroll container: `scrollIntoView()`, find-in-page, fragment links, keys, the controls and swipes still move it, and nested scroll areas still scroll under the wheel. The setting is stored per user on the server like the other reading settings; saved settings without it read as on.
- **Ends of a document.** Next on the last spread opens the next document at its first spread; Previous on the first spread opens the previous document at its last spread. The address stays one per document (ADR-0005); arriving at the last spread is navigation state, not part of the address.
- **Re-layout.** A change of window size, a reading setting or a late-loading font changes where pages break. The reader keeps the first visible character on the visible spread.
- **Breaks.** Images are scaled to be no taller than a page and are never split across pages. A figure stays on one page when it fits; a figure taller than a page (a long caption) keeps its image whole on one page and lets its caption continue on the next, so nothing is clipped or needs a vertical scroll. A heading is not left alone at the foot of a page.

How the reading position is measured in the pages layout is in ADR-0005.

## Considered Options

- **Transform the article (`translateX`) inside a clipping box**, as foliate-js and Readium do inside their iframes. Rejected: a transform is invisible to `scrollIntoView`, find-in-page and extensions, so ENX's jump back to a sentence would land on a hidden page.
- **Compute page breaks in JavaScript** by measuring blocks and moving them into page elements. Rejected: it rewrites the DOM the contract numbers (ADR-0006) and is slow on long documents; CSS columns break inside paragraphs for free.
- **An iframe per spread**, the usual paginated reader. Rejected by ADR-0001.
- **Keep scrolling only.** Rejected by the owner after trying v0.1.0: the scroll is the reason the reader feels unlike a book.

## Consequences

- The article becomes a horizontal scroll container in the pages layout. Text on other pages is in the DOM but outside the article's visible box. The DOM contract (`docs/dom-contract.md`) tells extension authors to bring text into view with `scrollIntoView()` and to measure visibility against the article's box, not the window; a Playwright test pins that `scrollIntoView()` on a block on a later page shows that page.
- The reading position work (issue #10) is redone for the pages layout, following ADR-0005 as revised with this ADR.
- If the scroll layout is removed later, the scroll measures in ADR-0005 go with it.

## Revisions

- Issue #57 spec review: the layout setting is stored per user on the server, as the other reading settings already are (it had wrongly said per browser); the page width is capped by the space available; keys, nested scroll areas and gesture momentum are defined for turning spreads; a figure taller than a page keeps its image whole and lets its caption continue.
- Issue #96 spec review: the wheel can be switched off by the *Wheel turns pages* setting; when off, the article takes `overflow-x: hidden` so an unprevented horizontal gesture cannot scroll it natively and be snapped into a turn.
