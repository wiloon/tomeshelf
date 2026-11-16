---
status: accepted
---

# Local accounts managed by the admin; no self-registration, no email

tomeshelf keeps its own accounts, as Kavita, Audiobookshelf, Jellyfin and Immich do. The first start creates the admin. When multiple users arrive, the admin creates accounts or sends invite links; nobody can sign up on their own. tomeshelf sends no email: there is no verification mail and no reset mail. A forgotten password is reset by the admin, or from the command line on the server. Many self-hosters have no working SMTP, and an instance on a home network has no strangers to keep out.

People who already run an identity provider (Authelia, Authentik, Pocket ID, Keycloak) can sign in through it later, by OIDC or a trusted reverse-proxy header (ADR-0008). Local accounts stay available beside it, so an instance never depends on another service to let its admin in.

## Considered Options

- **A hosted identity service such as Clerk**, as ENX uses. Rejected: a self-hosted app must run offline and without a third-party account.
- **Bundling or requiring a self-hosted identity server** (Ory Kratos, Zitadel, Logto, Authentik). Rejected: every self-hoster would have to deploy a second service just to read books. These stay optional OIDC providers.
- **A full Go auth framework** (authboss) or **an all-in-one backend** (PocketBase). Rejected: authboss is built around email flows; PocketBase takes over routing and the database, which conflicts with ADR-0008.

## Consequences

- The account code tomeshelf owns stays small: users, sessions, first-run setup, and later user management by the admin. It uses established pieces: argon2id from `golang.org/x/crypto`, server-side sessions stored in SQLite, the standard library's `http.CrossOriginProtection` against CSRF, and later `coreos/go-oidc` for OIDC.
- Without email, account recovery depends on whoever runs the server.

## Revisions

- 2026-11-16, ADR-0013: this ADR applies to private instances. A public instance has self-registration through Clerk, since strangers sign up there and the offline and no-third-party-account reasons above do not apply to an instance that is a public website.
