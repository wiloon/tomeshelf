import { readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import {
  test as base,
  expect,
  type Locator,
  type Page,
  type Request,
} from "@playwright/test";
import { startServer, type TestServer } from "./server";

// Each attempt gets its own server, so the library starts empty.
const test = base.extend<{ server: TestServer }>({
  // biome-ignore lint/correctness/noEmptyPattern: Playwright requires a destructured first argument.
  server: async ({}, use) => {
    const server = await startServer();
    await use(server);
    await server.stop();
  },
  baseURL: async ({ server }, use) => use(server.url),
  storageState: { cookies: [], origins: [] },
});

const books = path.resolve(import.meta.dirname, "../../testdata/books");

const withCover = "The Time Machine";
const withoutCover = "A Hand-Made EPUB 3";
const corruptCover = "A Book With A Corrupt Cover";

const thumbnailURL = /\/api\/books\/[^/]+\/thumbnail$/;

function entry(page: Page, title: string): Locator {
  return page
    .getByRole("list", { name: "All books" })
    .getByRole("listitem")
    .filter({ hasText: title });
}

// Waits for the entry's cover image to load and returns its natural width.
async function loadedCoverWidth(page: Page, title: string): Promise<number> {
  const img = entry(page, title).locator("img");
  await expect(img).toHaveCount(1);
  await expect
    .poll(() => img.evaluate((el: HTMLImageElement) => el.naturalWidth))
    .toBeGreaterThan(0);
  return img.evaluate((el: HTMLImageElement) => el.naturalWidth);
}

async function expectPlaceholder(page: Page, title: string) {
  const book = entry(page, title);
  await expect(book.getByTestId("cover-placeholder")).toHaveText(title);
  await expect(book.locator("img")).toHaveCount(0);
}

// Lists the regular, non-empty files under dir; a missing dir has none.
async function nonEmptyFiles(dir: string): Promise<string[]> {
  const names = await readdir(dir, { recursive: true }).catch(() => []);
  const files: string[] = [];
  for (const name of names) {
    const info = await stat(path.join(dir, name));
    if (info.isFile() && info.size > 0) {
      files.push(name);
    }
  }
  return files;
}

test("the library shows cover thumbnails, or the title when there is no usable cover", async ({
  page,
  server,
  browser,
}) => {
  const setup = await page.request.post("/api/setup", {
    data: { username: "reader", password: "covers password" },
  });
  expect(setup.status()).toBe(201);
  await page.goto("/");
  const importControl = page.getByLabel("Import an EPUB");
  for (const [file, title] of [
    ["h-g-wells_the-time-machine.epub", withCover],
    ["epub3.epub", withoutCover],
    ["cover-corrupt.epub", corruptCover],
  ]) {
    await importControl.setInputFiles(path.join(books, file));
    await expect(page.getByRole("status")).toHaveText(`Imported ${title}.`);
  }

  const requests: Request[] = [];
  page.on("request", (request) => requests.push(request));
  for (const width of [390, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await page.reload();
    const coverWidth = await loadedCoverWidth(page, withCover);
    expect(coverWidth).toBeLessThanOrEqual(400);
    await expectPlaceholder(page, withoutCover);
    await expectPlaceholder(page, corruptCover);
    const overflow = await page.evaluate(() => {
      const root = document.documentElement;
      const list = document.querySelector("ul");
      return {
        page: root.scrollWidth - root.clientWidth,
        list: list ? list.scrollWidth - list.clientWidth : -1,
      };
    });
    expect(overflow, `overflow at ${width} px`).toEqual({ page: 0, list: 0 });
  }
  const loaded = requests.map((r) => new URL(r.url()).pathname);
  expect(
    loaded.filter((p) => /\.epub$|\.(jpe?g|png|gif|svg)$/.test(p)),
  ).toEqual([]);
  const images = requests.filter((r) => r.resourceType() === "image");
  expect(images.length).toBeGreaterThan(0);
  for (const image of images) {
    expect(new URL(image.url()).pathname).toMatch(thumbnailURL);
  }

  // A deleted cache is regenerated from the originals.
  await rm(path.join(server.dataDir, "cache"), {
    recursive: true,
    force: true,
  });
  expect(await nonEmptyFiles(path.join(server.dataDir, "cache"))).toEqual([]);
  const fresh = await browser.newContext({
    baseURL: server.url,
    storageState: await page.context().storageState(),
  });
  const freshPage = await fresh.newPage();
  const regenerated = freshPage.waitForResponse(
    (r) => thumbnailURL.test(new URL(r.url()).pathname) && r.status() === 200,
  );
  await freshPage.goto("/");
  await regenerated;
  expect(await loadedCoverWidth(freshPage, withCover)).toBeLessThanOrEqual(400);
  expect(
    await nonEmptyFiles(path.join(server.dataDir, "cache")),
  ).not.toHaveLength(0);
  await fresh.close();

  // After sign-out the browser asks the server again and is refused.
  const src = await entry(page, withCover)
    .locator("img")
    .evaluate((el: HTMLImageElement) => el.src);
  const signOut = await page.request.delete("/api/session");
  expect(signOut.ok()).toBe(true);
  const before = requests.length;
  const status = await page.evaluate(
    async (url) => (await fetch(url)).status,
    src,
  );
  expect(status).toBe(401);
  expect(requests.slice(before).map((r) => r.url())).toContain(src);
});
