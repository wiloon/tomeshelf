---
status: accepted
---

# A book's id is the SHA-256 of its original

A book's id is the SHA-256 of its original EPUB file, written as 64 lowercase hex characters, on private and public instances alike. The same file is the same book: importing it again, after deleting it or into another user's library, gives the same id. An id therefore never names a different book.

Until now a private instance used SQLite's integer row id. SQLite gives a deleted highest id to the next insert, so after the newest book was deleted the next import took its id (#51). The reader caches a book's manifest and documents by id, so the new book opened showing the deleted book's text, and the DOM contract's `tomeshelf:book` (ADR-0006) named two books, so an extension could merge their data. A public instance already identifies books by SHA-256 (ADR-0012, ADR-0013); the private instance now does the same, so the client handles one id format.

- **Per-user library, shared original.** `books` keeps one row per user and book, keyed `(user_id, id)`. Two users who import the same file share its id and its original (ADR-0007).
- **Reading positions are keyed by user and book.** `reading_positions` is keyed `(user_id, book_id)` and the per-tab sequences of ADR-0005 `(user_id, book_id, tab_id)`. Both reference `users`, not `books`, so a reading position can outlive the book in the user's library. A position is shown and applied only while its book is in the user's library.
- **Deleting a book can keep its reading position.** The delete confirmation offers a checkbox, unchecked by default, to keep the reading position for when the same file is imported again. Unchecked, the reading position and its tab sequences are deleted with the book. Checked, both stay, and importing the same file again resumes there. The checkbox is shown only when the book has a reading position.
- **Ids in addresses are checked exactly.** A book address whose id is not `^[0-9a-f]{64}$` answers 404, with no case folding. The id names files on disk (ADR-0007), so it is never used before this check.
- **Existing installs are converted in place.** The migration makes each book's stored SHA-256 its id and carries reading positions over, in one transaction. On data it cannot convert, it rolls back and the server does not start; the error says how to recover (delete the books and reading positions, then import again). The migration never deletes data on its own. Old `/books/<integer>/…` addresses and extension data keyed by integer ids stop working; there is no redirect.

## Considered Options

- **A random UUID per import.** Never reused, but importing the same file again makes a new book, and private and public instances would keep two id formats.
- **Integers that are never reused (`AUTOINCREMENT`).** The smallest change, keeping addresses short, but it leaves the two instances' formats apart and still makes a re-imported file a new book.

## Consequences

- Addresses carry 64 hex characters (`/books/<sha256>/read/3`).
- An id is derived from content, so a cached manifest or document for an id is correct for as long as the id exists.
- An extension keeps its data for a book across deleting and re-importing the same file, by design.
- Where the library breaks ties by recency, it compares `imported_at`; ids carry no order.
