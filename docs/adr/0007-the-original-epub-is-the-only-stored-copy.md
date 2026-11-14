---
status: accepted
---

# The original EPUB is the only stored copy

The data volume keeps each imported book once, as its original EPUB file named by its SHA-256 (`/data/books/<sha256>.epub`). Importing the same file again yields the same book. The SQLite database (`/data/tomeshelf.db`) holds metadata, users, settings and reading positions. Everything else, such as cover thumbnails, lives under `/data/cache/` and can be deleted and rebuilt from the originals. Documents are never extracted to disk: the Streamer reads single entries from the ZIP on request (ADR-0002).

Import refuses DRM-encrypted books (Adobe ADEPT, Readium LCP) with a message saying so. It accepts font obfuscation. It reports parse failures with the parser's error. Files are capped at 200 MB by default, and the cap can be configured.

An upload is staged under `/data/tmp/` (on the same filesystem as `/data/books/`) and removed there on any failure; `/data/tmp/` is emptied at startup. A book that passes the checks is renamed into `/data/books/` before its metadata row is inserted, and the row is unique per SHA-256, so the database never names a missing file, concurrent imports of one file yield one book, and a failed insert leaves only an original that a retry reuses.

Each user's library has its own metadata row per book, but users who import the same file share one original. Deleting a book deletes the user's row first; data that belongs to the book in one user's library (reading positions, once they are stored) references that row with `ON DELETE CASCADE` and goes with it. Only when no row names the SHA-256 any more are the original and its cache files (`cache/covers/<sha256>.jpg` and `.none`) removed. The row is the commit point: a file that cannot be removed afterwards is logged and left behind, unreferenced, where a later import of the same file reuses it. A per-SHA-256 lock in the single process (ADR-0008) serialises an import's rename and insert, a deletion's row delete, reference check and file removal, and a thumbnail's cache write, which rechecks under the lock that a row still names the SHA-256; so a deletion never leaves a row naming a missing original, and no cache file is written for a book that is gone.

## Considered Options

- **Extract and normalize each book at import** and serve the result. Rejected: it keeps two copies of every book, and every change to the processing rules means reprocessing the library.

## Revisions

- 2026-11-14, issue #5: added the `/data/tmp/` staging area and the file-then-row commit order, so failed and concurrent imports are defined.
- 2026-11-14, issue #12: added book deletion: row first, shared originals and cache removed only when unreferenced, and a per-SHA-256 lock shared with import and thumbnail cache writes.
