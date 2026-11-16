---
status: proposed
---

# Private and public instances; a public instance never receives a book's content

ADR-0008 ruled out a public instance because hosting other people's uploads carries copyright risk that a takedown policy cannot remove. We now want one anyway, so we remove the cause instead: on a public instance, books stay in the user's own browser and the server never receives a byte of them. One binary serves both kinds of instance, chosen at start by `--instance=private|public` (`TOMESHELF_INSTANCE`, default `private`).

- **Private instance.** Everything decided so far applies unchanged: the server imports and stores books (ADR-0007), runs the Streamer (ADR-0002) and keeps local accounts (ADR-0009).
- **Public instance.** The server serves the browser app, accounts (ADR-0013), reading settings and reading positions (ADR-0013). Imported books are stored by the browser (IndexedDB or the Origin Private File System, with `navigator.storage.persist()` requested) and opened by the browser Streamer (ADR-0012). Books come from the user's computer or their cloud drive (ADR-0014).
- **Enforced by the server, not hidden by the UI.** A public instance does not register the routes that receive or serve book content (`POST /api/books`, `GET /api/books`, `DELETE /api/books/{id}`, `.../manifest`, `.../package/...`, `.../thumbnail`). It has no `books/`, `tmp/` or `cache/` directories, and its database holds no book metadata. A request to those addresses that reaches the server answers 404.
- **What the server may hold about a book** on a public instance: its SHA-256, the user's reading position without text (ADR-0013), and the cloud drive provider and file ID it was imported from (ADR-0014). Never its title, author, cover, file name, folder path or any of its text.
- **The browser app is one build.** It learns the kind of instance from the server at start and switches the library, import and Streamer accordingly.
- Phones are out of scope for a public instance for now: a phone's browser storage is small and evicted more readily.

## Considered Options

- **The server parses uploaded books in memory and never writes them to disk.** Rejected: the book still reaches the server, the server's memory grows with every open book, and the whole EPUB must be uploaded again on each open, because the Streamer reads single entries on request (ADR-0002). "Received but not stored" is a weaker position than "never received".
- **A separate public product or fork.** Rejected: the reader, the Navigator and the DOM contract (ADR-0006) are the same; only where books live and who parses them differ.
- **Independent switches** (storage location, Streamer location, auth provider). Rejected: most combinations are meaningless or unsafe, such as a public instance that accepts uploads. One switch selects a coherent set.

## Consequences

- Leaving the browser's storage loses the book on that browser. The user re-imports it; a book from a cloud drive is offered for reloading from there (ADR-0014). The library says plainly that books live only in this browser.
- Every server-side feature that reads book content (thumbnails, the Streamer's total progression in ADR-0005, metadata) needs a browser-side counterpart on a public instance.
- tomeshelf the project may now run a public instance. Whether that is lawful where it runs is still the operator's question; this design minimises what the server touches, it is not legal advice.
