---
status: accepted
---

# One Go binary with the SPA embedded, one replica, SQLite

tomeshelf ships as one Go binary built with ko. It serves the API, the Streamer and the browser app, whose static build is embedded with `go:embed`. The browser app is a Vite single-page app, not Next.js: the reader sits behind a login, so server rendering and SEO buy nothing, and Next.js would add a Node runtime beside Go.

Data lives in SQLite (WAL mode) on one block volume, so exactly one replica runs. On Kubernetes the Deployment uses `strategy: Recreate`, so two pods never write the database at once. Replicated storage such as Longhorn protects against a node failure, not against deletion or corruption. Operators must back up the data volume; tomeshelf documents this rather than shipping its own backup.

Stack: Go with `net/http` routing, `log/slog`, sqlc on `modernc.org/sqlite` and goose migrations embedded in the binary. The browser app uses React 19, TypeScript, TanStack Router and Query, Tailwind CSS 4 and DOMPurify. Tests use Go's testing package, Vitest and Playwright, and Biome checks the code. Images are published to GHCR for amd64 and arm64, with a `docker-compose.yml` example and a minimal Kubernetes manifest. There is no Helm chart in v1.

## Scope

- v1 has one user per instance, with a built-in username and password. Tables carry `user_id`, so more users can be added without a schema rewrite. Trusted reverse-proxy headers and OIDC are later upgrades.
- tomeshelf is open source for people to self-host. The project does not run a public instance: hosting other people's uploads, even when restricted to public-domain books, carries copyright risk that a notice-and-takedown policy cannot remove.

## Revisions

- 2026-11-16, ADR-0011: a public instance is now possible, because on one the server never receives a book's content. The reason above still rules out hosting uploads, which a public instance does not do. One replica and SQLite hold for both kinds of instance.
