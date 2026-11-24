---
status: accepted
---

# Public instance: Clerk accounts, and reading positions without book text

A public instance (ADR-0011) has strangers signing up, which ADR-0009's admin-managed accounts were never meant for. It uses Clerk, as ENX does (ENX ADR-015): Clerk proves who is signed in, and tomeshelf maps the Clerk user ID to its own local user ID, which keys all of tomeshelf's data. The browser app signs in with `@clerk/clerk-react`; the server verifies Clerk's session JWT against its JWKS. Sign-in is a seam chosen by the kind of instance: a private instance keeps local accounts exactly as ADR-0009 describes, and never needs a third-party account or network access.

Reading positions are stored on the server, so a book resumes on another computer once the same file is imported there. To keep book text off the server, a public instance stores a position without the Locator's text quote:

- **Key.** Local user ID and the book's SHA-256. The server knows no title, and cannot check an `href` against a reading order it has never seen, so it stores the `href` as given.
- **Fields stored.** `href`, progression, total progression (computed by the browser Streamer, ADR-0012), the block selector and character offset, the clicked character's block selector and character offset when there is one, and the per-tab sequence number (ADR-0005). The `text` field (`before`, `highlight`, `after`), the anchor's and the clicked character's alike, is dropped by the browser before sending and rejected by the server if present. A clicked character outside any numbered block has only its quote, so none is sent.
- **The quote stays local.** The browser keeps the full Locator of its own last save. When the server's position has the same `href`, block and offset, restoring uses the local quote as ADR-0005 describes; otherwise it restores by block and offset, then progression. The clicked character's local quote is used likewise only when its own `href`, block and offset match, since clicking another line of the same spread leaves the anchor unchanged. Block numbers are stable for the same file and Navigator version (ADR-0005), and the key is the file's hash, so block and offset are reliable across computers.
- Reading positions and the books they name are personal data. A public instance needs a privacy notice, and lets a user export and delete their data, including deleting their account.

## Considered Options

- **Keep reading positions only in the browser.** Rejected: nothing then follows the user to another computer, which is most of what an account is for on a public instance.
- **Store the text quote too.** Rejected: up to 128 characters of the book per position is small, but it is the book's text on the server, which ADR-0011 rules out. Block and offset on an identical file do the quote's job across computers.
- **Self-registration in tomeshelf's own account code.** Rejected: it needs email verification and password reset, which ADR-0009 deliberately avoided, plus abuse protection. Clerk provides them; Google and GitHub sign-in are switches.
- **Logto, self-hosted.** Kept in reserve: ENX chose it for its China edition (ENX ADR-036), where identity data must stay in the country and Clerk cannot be used. The seam makes it a later option for tomeshelf too.

## Consequences

- ADR-0009's rejection of a hosted identity service still holds for private instances; it does not cover public ones.
- A public instance depends on Clerk being up for sign-in, and on Clerk's pricing past its free tier.

## Revisions

- 2026-11-24, issue #129: a position may carry a clicked character (ADR-0005); its block and offset are stored and its quote stays in the browser like the anchor's, matched by its own `href`, block and offset.
