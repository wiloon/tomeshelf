---
status: accepted
---

# Book HTML is untrusted: sanitize in the browser, enforce with Trusted Types

Without an iframe sandbox (ADR-0001), a book's markup runs in tomeshelf's origin next to the user's session. Any EPUB is untrusted input. The baseline:

- The Navigator sanitizes every document with DOMPurify before it reaches the DOM. Scripts, event handlers, forms, embedded frames and objects are removed. Sanitizing happens in the browser, with the same parser that renders the result (ADR-0002).
- Trusted Types are enforced: the only way to put HTML into the content container is through the DOMPurify policy.
- The app's CSP forbids inline and third-party scripts.
- The Streamer serves raw package files with `Content-Security-Policy: sandbox` and `X-Content-Type-Options: nosniff`. A document opened directly by its URL cannot run script in tomeshelf's origin; it is only data for the Navigator to fetch.
- Book links to other documents become tomeshelf reading URLs. External links open in a new tab with `rel="noopener noreferrer"`. Images point at the Streamer's resource URLs.

When the browser Sanitizer API (`setHTML`) is widely available, evaluate it as a replacement for DOMPurify.
