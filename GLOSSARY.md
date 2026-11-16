# tomeshelf

A reader for EPUB books, self-hosted or public, built so that word-lookup extensions such as ENX can work on the book text.

## Library

**Book**:
One EPUB publication imported into the library, identified by the content of its original file.
_Avoid_: Ebook file, title, publication (except when quoting Readium)

**Library**:
The books a user has imported: held by the server on a private instance, and by the user's own browser on a public instance.
_Avoid_: Collection, shelf

**Import**:
Adding a book to the library from an EPUB file the user supplies, from their computer or their cloud drive.
_Avoid_: Upload (the transport, not the act), ingest

**Cloud drive**:
The user's own file storage at a provider such as Google Drive or OneDrive, which a public instance's browser app reads books from on the user's behalf.
_Avoid_: Cloud storage, netdisk, sync

## Instances

**Private instance**:
A tomeshelf instance for one household or person, which keeps imported books on its own server.
_Avoid_: HomeLab mode, self-hosted mode

**Public instance**:
A tomeshelf instance open to anyone, whose server never receives a book's content; each user's books stay in their own browser.
_Avoid_: Cloud mode, SaaS, online mode

## Reading

**Document**:
One XHTML file in a book's reading order, shown at its own address.
_Avoid_: Chapter (a document may hold several chapters, or part of one), page, spine item

**Layout**:
How the reader arranges a document on screen: as pages, or as one continuous scroll.
_Avoid_: Mode, view

**Page**:
One column of a document's text in the pages layout, as tall as the window allows.
_Avoid_: Screen, column; never a synonym for document

**Spread**:
The one or two pages shown at the same time.
_Avoid_: Screen, view, two-page view

**Table of contents entry**:
A named point in a book that the user can jump to; it points into a document, not necessarily at its start.
_Avoid_: Chapter link

**Block**:
A block-level piece of a document's text (a paragraph, heading or list item) that tomeshelf numbers so it can be found again.
_Avoid_: Paragraph (too narrow), node

**Reading position**:
Where the user last was in a book, kept by tomeshelf for that user so the book reopens there.
_Avoid_: Bookmark (a deliberate mark), progress (a percentage only)

**Locator**:
The record that describes a reading position in several redundant ways, so it survives when one way fails.
_Avoid_: CFI, anchor

## Architecture

**Streamer**:
The part that understands the EPUB package and hands out the book's description and its files: on the server in a private instance, in the user's browser in a public instance.
_Avoid_: Parser, backend

**Navigator**:
The browser part that turns a document into readable page content and keeps track of the reading position.
_Avoid_: Renderer, viewer

**DOM contract**:
The promises tomeshelf's reading pages make about their markup, so that a browser extension can recognise them and find the book text.
_Avoid_: ENX API, integration
