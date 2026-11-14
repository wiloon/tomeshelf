---
status: accepted
---

# The original EPUB is the only stored copy

The data volume keeps each imported book once, as its original EPUB file named by its SHA-256 (`/data/books/<sha256>.epub`). Importing the same file again yields the same book. The SQLite database (`/data/tomeshelf.db`) holds metadata, users, settings and reading positions. Everything else, such as cover thumbnails, lives under `/data/cache/` and can be deleted and rebuilt from the originals. Documents are never extracted to disk: the Streamer reads single entries from the ZIP on request (ADR-0002).

Import refuses DRM-encrypted books (Adobe ADEPT, Readium LCP) with a message saying so. It accepts font obfuscation. It reports parse failures with the parser's error. Files are capped at 200 MB by default, and the cap can be configured.

## Considered Options

- **Extract and normalize each book at import** and serve the result. Rejected: it keeps two copies of every book, and every change to the processing rules means reprocessing the library.
