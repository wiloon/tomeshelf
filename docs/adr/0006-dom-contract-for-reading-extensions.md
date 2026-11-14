---
status: accepted
---

# A public DOM contract for reading extensions

tomeshelf doesn't depend on ENX or call it. Its reading pages make promises about their markup instead, so any extension can recognise them, whatever the hostname. Every self-hosted instance has its own domain, so URL rules cannot work.

Each reading page carries:

- `<meta name="generator" content="tomeshelf <version>">`, the signal that this is a tomeshelf page.
- `<meta name="tomeshelf:book" content="<book id>">`, the same value on every document of a book, so an extension can treat the documents as one book.
- `<meta name="tomeshelf:restores-position" content="true">`, which declares that tomeshelf itself reopens a book at its reading position. An extension that also tracks reading positions should not offer its own "continue reading" jump on these pages.
- One `<article id="tomeshelf-content">` holding the document's text, in the main DOM (ADR-0001).
- `data-tomeshelf-block="<n>"` on each block.

The meta tags are updated when the Navigator moves to another document within the single-page app.

The contract is documented for extension authors and pinned by Playwright contract tests: a fixture book is opened and the test checks every item above, plus the absence of iframes and shadow roots around the text. A change that breaks a test is a breaking change for extensions.

## Consequences

- ENX needs a small change: a platform rule matching the generator, the book key read from `tomeshelf:book`, and its resume hint suppressed when `tomeshelf:restores-position` is present. This is tracked in wiloon/enx#907 and is to be specified once tomeshelf is stable.
- A later version may listen for a DOM event that ENX dispatches with the sentence it looked up, and store that as the reading position (ADR-0005). That event would be added to this contract when it is designed.
