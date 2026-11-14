# Screenshots for manual checks

Every PR whose `## Manual checks` is not `none` comes with screenshots of each item, so a reviewer can look without running the branch.

## How

Write a throwaway script in `tmp/` (git-ignored) with the helpers in `web/e2e/shots.ts`, and run it with `task shots`. It builds the binary, then runs the script with Node. The PNGs land in `$SHOTS_DIR`, which defaults to `tmp/shots`.

```ts
// tmp/shots.ts
import { importBooks, openShots, shoot } from "../web/e2e/shots.ts";

const { page, close } = await openShots();
try {
  await importBooks(page, "reader.epub", "epub3.epub");
  await shoot(page, "01-library");

  await page.getByRole("link", { name: /A Hand-Made Reading Book/ }).click();
  await page.getByRole("heading", { name: "Document One" }).waitFor();
  await shoot(page, "02-reader-top");
  await shoot(page, "03-reader-bottom", { scrollToBottom: true });
} finally {
  await close();
}
```

```sh
task shots -- tmp/shots.ts
SHOTS_DIR=/path/from/the/runner task shots -- tmp/shots.ts
```

- `openShots()` starts the built binary on a fresh data directory and returns a `page` signed in as a new admin. Its password is random per run and never shown.
- `importBooks(page, ...files)` imports fixtures from `testdata/books` through the library's import control.
- `shoot(page, "NN-slug", options)` shoots the current state at 390 and 1280 px, device scale 2, and writes `NN-slug-390.png` and `NN-slug-1280.png`. Options:
  - `fullPage: true` shoots the whole page instead of the viewport.
  - `scrollToBottom: true` scrolls to the bottom first.
  - `waitForImages: false` skips the image wait, for a deliberately held image. Fonts are still awaited.
  - `imageTimeoutMs` changes the 10 s image timeout.

`shoot` waits for fonts and for every `<img>` to load or fail, so a broken image or its placeholder is a legitimate shot. An image still pending after the timeout makes `shoot` reject, naming its URL, and that call writes no PNG at either width.

Make states the server cannot produce on demand (loading, a failed fetch, a held request) with `page.route` in the script, as the specs in `web/e2e/` do.

## Coverage

- One `shoot` per manual-check item, in the list's order.
- The error, loading and empty states the PR adds or changes. Shoot a held image with `waitForImages: false`.
- Both ends of anything that scrolls.

## Naming

`NN-<slug>-<width>.png`: `NN` is the item's two-digit position in `## Manual checks`, and `shoot` adds the width.

## Cleanup

Delete the script and `tmp/shots` once the PNGs are copied where the runner wants them, or point `SHOTS_DIR` there directly. `close()` stops the browser and the server. Finish with `git status` clean.
