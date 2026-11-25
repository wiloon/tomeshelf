import path from "node:path";
import { test as base, expect, type Page } from "@playwright/test";
import { startServer, type TestServer } from "./server";

// Estimated page numbers below the spread (ADR-0010 Page numbers, issue #128).

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
const title = "A Hand-Made Reading Book";
const hint =
  "Page numbers are estimates and change with window size and reading settings.";

async function openBook(page: Page, layout: "pages" | "scroll" = "pages") {
  const setup = await page.request.post("/api/setup", {
    data: { username: "reader", password: "reader password" },
  });
  expect(setup.status()).toBe(201);
  const res = await page.request.put("/api/settings", {
    data: {
      fontSize: 18,
      lineHeight: 1.6,
      width: 38,
      theme: "light",
      layout,
      font: "default",
      wheelTurnsPages: true,
      repeatedLines: 1,
    },
  });
  expect(res.status()).toBe(204);
  await page.goto("/");
  await page
    .getByLabel("Import an EPUB")
    .setInputFiles(path.join(books, "reader.epub"));
  await expect(page.getByRole("status")).toHaveText(`Imported ${title}.`);
  await page.getByRole("link", { name: new RegExp(title) }).click();
  await expect(page).toHaveURL(/\/books\/[^/]+\/read\/1$/);
  await expect(article(page)).toContainText("Document One");
}

async function resize(page: Page, size: { width: number; height: number }) {
  await page.setViewportSize(size);
  await page.evaluate(
    () =>
      new Promise((done) =>
        requestAnimationFrame(() => requestAnimationFrame(done)),
      ),
  );
}

function article(page: Page) {
  return page.locator("article#tomeshelf-content");
}

function nav(page: Page) {
  return page.getByRole("navigation", { name: "Reading order" });
}

function pageNumbers(page: Page) {
  return nav(page).getByTitle(hint);
}

// The shown numbers: the spread's first and last page and the page count.
async function numbers(page: Page) {
  await expect(pageNumbers(page)).toHaveText(/^\d+(–\d+)? of \d+$/);
  const text = (await pageNumbers(page).textContent()) ?? "";
  const [, first, last, total] =
    text.match(/^(\d+)(?:–(\d+))? of (\d+)$/) ?? [];
  return {
    first: Number(first),
    last: Number(last ?? first),
    total: Number(total),
  };
}

test("page numbers count the spread's pages and move with each turn", async ({
  page,
}) => {
  await openBook(page);
  await resize(page, { width: 1280, height: 800 });
  await expect(pageNumbers(page)).toHaveText(/^1–2 of \d+$/);
  const before = await numbers(page);
  await nav(page).getByRole("button", { name: "Next" }).click();
  await expect(pageNumbers(page)).toHaveText(/^3–4 of \d+$/);
  expect((await numbers(page)).total).toBeGreaterThanOrEqual(before.total - 2);
});

test("reading forward, the next document's first page follows the last page shown", async ({
  page,
}) => {
  await openBook(page);
  await resize(page, { width: 1280, height: 800 });
  let last = 0;
  for (let turns = 0; turns < 60; turns++) {
    const shown = await numbers(page);
    expect(shown.last).toBeLessThanOrEqual(shown.total);
    last = shown.last;
    await nav(page).getByRole("button", { name: "Next" }).click();
    if (/\/read\/2$/.test(page.url())) {
      break;
    }
  }
  await expect(page).toHaveURL(/\/read\/2$/);
  await expect(article(page)).toContainText("Document Two");
  await expect(pageNumbers(page)).toHaveText(
    new RegExp(`^${last + 1}–${last + 2} of \\d+$`),
  );
});

test("resizing to one page and a larger font change the numbers", async ({
  page,
}) => {
  await openBook(page);
  await resize(page, { width: 1280, height: 800 });
  const wide = await numbers(page);
  expect(wide.last).toBe(wide.first + 1);

  // A phone shows one page, narrower than the text width: more pages.
  await resize(page, { width: 390, height: 800 });
  await expect(pageNumbers(page)).toHaveText(/^1 of \d+$/);
  const narrow = await numbers(page);
  expect(narrow.total).toBeGreaterThan(wide.total);

  await page.getByRole("button", { name: "Settings" }).click();
  for (let i = 0; i < 3; i++) {
    await page.getByRole("button", { name: "Increase font size" }).click();
  }
  await expect
    .poll(async () => (await numbers(page)).total)
    .toBeGreaterThan(narrow.total);
});

for (const size of [
  { width: 390, height: 844 },
  { width: 1280, height: 800 },
]) {
  test(`page numbers sit below the article without covering it at ${size.width} px`, async ({
    page,
  }) => {
    await openBook(page);
    await resize(page, size);
    await expect(pageNumbers(page)).toBeVisible();
    const text = await article(page).boundingBox();
    const indicator = await pageNumbers(page).boundingBox();
    expect(text && indicator).toBeTruthy();
    if (text && indicator) {
      expect(indicator.y).toBeGreaterThanOrEqual(text.y + text.height - 1);
      expect(indicator.y + indicator.height).toBeLessThanOrEqual(size.height);
    }
  });
}

// Turns Next until the address names document n.
async function readTo(page: Page, n: number) {
  for (let turns = 0; turns < 120; turns++) {
    if (new RegExp(`/read/${n}$`).test(page.url())) {
      return;
    }
    await nav(page).getByRole("button", { name: "Next" }).click();
  }
  throw new Error(`never reached document ${n}`);
}

// A late-loading picture in the shown document: the controller re-lays it
// out as it does for a real load event.
async function lateImageLoad(page: Page, append?: string) {
  await article(page).evaluate((el, html) => {
    if (html) {
      const pre = document.createElement("pre");
      pre.textContent = html;
      el.append(pre);
    }
    const img = document.createElement("img");
    img.alt = "";
    el.prepend(img);
    img.dispatchEvent(new Event("load"));
  }, append);
  await page.evaluate(
    () =>
      new Promise((done) =>
        requestAnimationFrame(() => requestAnimationFrame(done)),
      ),
  );
}

test("a picture loading late keeps the counts of documents read before", async ({
  page,
}) => {
  await openBook(page);
  await resize(page, { width: 1280, height: 800 });
  await readTo(page, 3);
  await expect(article(page)).toContainText("Document Three");
  // The last document's only page is the book's last page.
  await expect(pageNumbers(page)).toHaveText(/^(\d+) of \1$/);
  const before = await pageNumbers(page).textContent();
  await lateImageLoad(page);
  await expect(pageNumbers(page)).toHaveText(before ?? "");
});

test("a document ending with a wide pre counts only the pages it shows", async ({
  page,
}) => {
  await openBook(page);
  await resize(page, { width: 1280, height: 800 });
  await readTo(page, 3);
  await expect(article(page)).toContainText("Document Three");
  // One line far wider than a page: its box scrolls inside its column.
  await lateImageLoad(page, `${"wide ".repeat(400)}end`);
  // The last document's only page is the book's last page.
  await expect(pageNumbers(page)).toHaveText(/^(\d+) of \1$/);
});

test("the scroll layout shows no page numbers", async ({ page }) => {
  await openBook(page, "scroll");
  await expect(nav(page)).toBeVisible();
  await expect(pageNumbers(page)).toHaveCount(0);
});
