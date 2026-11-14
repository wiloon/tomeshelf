# AI Agents

tomeshelf is a self-hosted EPUB reader. It renders book text into the main document, with no iframe and no shadow DOM, so word-lookup extensions such as ENX work on it (ADR-0001). Every change keeps the book text there. The DOM contract (ADR-0006) is a public API: changing it is a breaking change.

## Taking an issue

1. Pick a `ready-for-agent` issue with no open blockers (`docs/agents/issue-tracker.md`, **Count open blockers**). Read its body and comments, and the ADRs it cites.
2. Work in a git worktree branched from `origin/main`, on a `feat/…`, `fix/…` or `docs/…` branch. Other agent sessions may be working in the main checkout at the same time.
3. Build it test-first with the matching skill (table below).
4. Open a PR with the `pr` skill. Its body says `Closes #<n>` and names every check you did not run.

The work is done when every acceptance criterion in the issue is checked off and `task ci` passes on your committed changes. `task ci` runs the CI checks locally; `task e2e` runs the Playwright tests against the built binary.

## Tests

- **Red, green, refactor.** Each behaviour the issue adds gets a test that fails on the old code before the code that passes it. A bug fix starts with a test that reproduces the bug.
- Tests assert on outputs and visible effects, so a refactor that keeps the behaviour keeps them green.
- jsdom covers logic only. Layout, overflow, scrolling, phone and desktop widths, and anything an extension sees in a real page need Playwright.
- Test books are public domain or CC0 only (hand-made fixtures, Standard Ebooks). Large books stay out of the repo.
- E2E tests create their own admin through first-run setup on a fresh data directory, so they need no secrets.

## Conventions

- **English** for code, comments, docs, ADRs, issues and UI copy.
- **Commits** are conventional (`feat: …`, `fix: …`, `docs(adr): …`) and signed off with `git commit -s`; the DCO check rejects unsigned commits.
- **Book HTML is untrusted** (ADR-0004): it reaches the DOM only through the DOMPurify Trusted Types policy.
- **Vocabulary** comes from `GLOSSARY.md`. Use *document*, not *chapter*, for one file in the reading order.
- **Decisions.** When work contradicts an ADR, say so in the issue and stop for the owner. A new decision that is hard to reverse goes through `domain-modeling` as an ADR.

## Skills

| Work | Skill |
| --- | --- |
| A feature or bug fix | `tdd` |
| Something broken, throwing or slow, cause unknown | `diagnosing-bugs` |
| A glossary term or an ADR | `domain-modeling` |
| A module's interface, or where a seam goes | `codebase-design` |
| Answering a design question with throwaway code | `prototype` |
| Reviewing a branch or PR | `code-review` |
| Writing a PR body | `pr` |
| Editing this file or any doc agents read | `writing-for-agents` |

## Agent skills

### Issue tracker

Issues are tracked in GitHub Issues for `wiloon/tomeshelf`, via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five default labels: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one root `GLOSSARY.md` and ADRs in `docs/adr/`. See `docs/agents/domain.md`.
