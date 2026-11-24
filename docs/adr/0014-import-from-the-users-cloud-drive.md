---
status: accepted
---

# Import from the user's cloud drive, downloaded by the browser

On a public instance (ADR-0011) a user can import a book from their own Google Drive or OneDrive as well as from their computer. The browser app opens the provider's file picker, and the browser downloads the chosen EPUB straight from the provider into browser storage. The book never passes through Tomeshelf's server, and the provider's access token stays in the browser. The cloud drive is then the book's lasting copy and browser storage a cache, so a book lost to cleared site data or a new computer can be loaded again from the cloud drive.

- **Google Drive.** Google Picker with the `drive.file` scope, which grants access only to files the user picks in the picker, and download through the Drive API (`files.get?alt=media`). `drive.file` is a non-sensitive scope, so Google's app verification stays light.
- **OneDrive.** The OneDrive File Picker and Microsoft Graph, with the narrowest scope that lets the browser read the picked file.
- **Tokens.** Each provider's OAuth runs in the browser and its token is kept in memory or browser storage, never sent to Tomeshelf's server. Signing in to Tomeshelf (ADR-0013) and granting access to a cloud drive are separate steps, even when both use Google, so no drive token passes through Clerk or Tomeshelf's server.
- **What the server keeps.** Per user and book SHA-256: the provider and the provider's file ID, so another computer can offer "Load from Google Drive" for a book with a reading position. Never the file's name or folder path: they often contain the title, they change when the user renames or moves the file, and the file ID does not.
- A file whose content no longer matches the SHA-256 (the user replaced it) is imported as a different book.

## Considered Options

- **Download through the server** to avoid CORS or token handling in the browser. Rejected: the book would pass through the server, which ADR-0011 rules out.
- **Store the path** instead of the file ID. Rejected for the reasons above.
- **Broader scopes** (`drive.readonly`, reading the whole drive to list every EPUB). Rejected: they are restricted scopes needing a security assessment, and Tomeshelf has no need to see files the user did not pick.

## Consequences

- Each provider's OAuth client, consent screen and allowed origins belong to whoever runs the public instance.
- Users in mainland China cannot reach Google Drive or OneDrive; a China edition would need other providers.
