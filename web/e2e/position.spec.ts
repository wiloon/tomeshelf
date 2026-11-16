import path from "node:path";
import {
  test as base,
  expect,
  type Page,
  type Request,
} from "@playwright/test";
import { startServer, type TestServer } from "./server";

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
const chapters = "A Hand-Made Book of Chapters";

const defaults = {
  fontSize: 18,
  lineHeight: 1.6,
  width: 38,
  theme: "light" as const,
  layout: "pages" as const,
};

async function saveSettings(
  page: Page,
  settings: {
    fontSize?: number;
    lineHeight?: number;
    width?: number;
    theme?: "light" | "dark" | "sepia";
    layout?: "pages" | "scroll";
  } = {},
) {
  const res = await page.request.put("/api/settings", {
    data: { ...defaults, ...settings },
  });
  expect(res.status()).toBe(204);
}

async function setUp(page: Page, layout: "pages" | "scroll" = "pages") {
  const setup = await page.request.post("/api/setup", {
    data: { username: "reader", password: "reader password" },
  });
  expect(setup.status()).toBe(201);
  await saveSettings(page, { layout });
  await page.goto("/");
}

async function importChapters(page: Page) {
  await page
    .getByLabel("Import an EPUB")
    .setInputFiles(path.join(books, "chapters.epub"));
  await expect(page.getByRole("status")).toHaveText(`Imported ${chapters}.`);
}

async function openFromLibrary(page: Page) {
  await page.getByRole("link", { name: new RegExp(chapters) }).click();
  await expect(page).toHaveURL(/\/books\/\d+\/read\/1$/);
  await expect(article(page)).toContainText("CHAPTER I.");
  return new URL(page.url()).pathname.split("/")[2];
}

function article(page: Page) {
  return page.locator("article#tomeshelf-content");
}

function positionPuts(page: Page) {
  const puts: Request[] = [];
  page.on("request", (req) => {
    if (
      req.method() === "PUT" &&
      /\/api\/books\/\d+\/position$/.test(req.url())
    ) {
      puts.push(req);
    }
  });
  return puts;
}

test("turning a spread saves a debounced position and the library resumes there", async ({
  page,
  browser,
  server,
}) => {
  await setUp(page, "pages");
  await importChapters(page);
  const id = await openFromLibrary(page);
  const puts = positionPuts(page);

  await page.setViewportSize({ width: 1280, height: 800 });
  await page
    .getByRole("navigation", { name: "Reading order" })
    .getByRole("button", { name: "Next" })
    .click();
  await expect.poll(() => puts.length).toBeGreaterThan(0);
  const body = puts.at(-1)?.postDataJSON() as
    | {
        href: string;
        sequence: number;
        tabId: string;
        locations: { progression: number; cssSelector?: string };
      }
    | undefined;
  expect(body?.sequence).toBeGreaterThanOrEqual(1);
  expect(body?.tabId).toBeTruthy();
  expect(body?.locations.progression).toBeGreaterThan(0);
  expect(body?.locations.cssSelector).toMatch(
    /^\[data-tomeshelf-block="\d+"\]$/,
  );

  await page.getByRole("link", { name: "Library", exact: true }).click();
  await expect(
    page.locator("li").filter({ hasText: chapters }).getByText(/%/),
  ).toBeVisible();

  const other = await browser.newContext({
    baseURL: server.url,
    storageState: await page.context().storageState(),
  });
  const fresh = await other.newPage();
  await fresh.goto("/");
  await fresh.getByRole("link", { name: new RegExp(chapters) }).click();
  await expect(fresh).toHaveURL(new RegExp(`/books/${id}/read/1$`));
  await expect(article(fresh)).toContainText("CHAPTER");
  await expect
    .poll(async () =>
      fresh.evaluate(() => {
        const el = document.getElementById("tomeshelf-content");
        return el instanceof HTMLElement ? el.scrollLeft : 0;
      }),
    )
    .toBeGreaterThan(0);
  await other.close();
});

test("scroll layout saves and restores to the stored text", async ({
  page,
  browser,
  server,
}) => {
  await setUp(page, "scroll");
  await importChapters(page);
  const id = await openFromLibrary(page);
  const puts = positionPuts(page);

  await page.evaluate(() => window.scrollTo(0, 800));
  await expect.poll(() => puts.length).toBeGreaterThan(0);

  await page.getByRole("link", { name: "Library", exact: true }).click();
  const other = await browser.newContext({
    baseURL: server.url,
    storageState: await page.context().storageState(),
  });
  const fresh = await other.newPage();
  await fresh.goto("/");
  await fresh.getByRole("link", { name: new RegExp(chapters) }).click();
  await expect(fresh).toHaveURL(new RegExp(`/books/${id}/read/1$`));
  await expect
    .poll(async () => fresh.evaluate(() => window.scrollY))
    .toBeGreaterThan(100);
  await other.close();
});

test("a document address never jumps to the stored position", async ({
  page,
}) => {
  await setUp(page, "scroll");
  await importChapters(page);
  const id = await openFromLibrary(page);
  const puts = positionPuts(page);
  await page.evaluate(() => window.scrollTo(0, 1200));
  await expect.poll(() => puts.length).toBeGreaterThan(0);

  await page.goto(`/books/${id}/read/1`);
  await expect(article(page)).toContainText("CHAPTER I.");
  await expect.poll(async () => page.evaluate(() => window.scrollY)).toBe(0);
});

test("leaving a document flushes its pending position", async ({ page }) => {
  await setUp(page, "scroll");
  await importChapters(page);
  const id = await openFromLibrary(page);
  const puts = positionPuts(page);

  await page.evaluate(() => window.scrollTo(0, 600));
  await page
    .getByRole("navigation", { name: "Reading order" })
    .getByRole("link", { name: "Next" })
    .click();
  await expect(page).toHaveURL(new RegExp(`/books/${id}/read/2$`));
  await expect.poll(() => puts.length).toBeGreaterThan(0);
  const last = puts.at(-1)?.postDataJSON() as { href: string } | undefined;
  expect(last?.href).toContain("book.xhtml");
});

test("hiding the page sends a pending position", async ({ page }) => {
  await setUp(page, "scroll");
  await importChapters(page);
  await openFromLibrary(page);
  const puts = positionPuts(page);

  await page.evaluate(() => window.scrollTo(0, 500));
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "hidden",
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect.poll(() => puts.length).toBeGreaterThan(0);
});

test("restore falls back when the quote then the block are missing", async ({
  page,
}) => {
  await setUp(page, "scroll");
  await importChapters(page);
  const id = await openFromLibrary(page);

  const save = await page.request.put(`/api/books/${id}/position`, {
    data: {
      tabId: "e2e-tab",
      sequence: 1,
      href: "OEBPS/text/book.xhtml",
      locations: {
        progression: 0.2,
        cssSelector: '[data-tomeshelf-block="3"]',
        characterOffset: 0,
      },
      text: {
        before: "",
        highlight: "Chapter I begins.",
        after: " The traveller",
      },
    },
  });
  expect(save.status()).toBe(204);

  await page.request.put(`/api/books/${id}/position`, {
    data: {
      tabId: "e2e-tab",
      sequence: 2,
      href: "OEBPS/text/book.xhtml",
      locations: {
        progression: 0.2,
        cssSelector: '[data-tomeshelf-block="3"]',
        characterOffset: 0,
      },
      text: {
        before: "",
        highlight: "no-such-quote-anywhere-in-the-book",
        after: "",
      },
    },
  });

  await page.goto(`/books/${id}/read`);
  await expect(page).toHaveURL(new RegExp(`/books/${id}/read/1$`));
  await expect(article(page)).toContainText("Chapter I begins.");
  const topText = await page.evaluate(() => {
    const articleEl = document.getElementById("tomeshelf-content");
    if (!articleEl) return "";
    const edge = 8;
    for (const el of articleEl.querySelectorAll("[data-tomeshelf-block]")) {
      const box = el.getBoundingClientRect();
      if (box.bottom > edge && box.top < window.innerHeight) {
        return (el.textContent ?? "").trim().slice(0, 18);
      }
    }
    return "";
  });
  expect(topText.startsWith("Chapter I begins")).toBe(true);

  await page.request.put(`/api/books/${id}/position`, {
    data: {
      tabId: "e2e-tab",
      sequence: 3,
      href: "OEBPS/text/book.xhtml",
      locations: {
        progression: 0.35,
        cssSelector: '[data-tomeshelf-block="999"]',
        characterOffset: 0,
      },
    },
  });
  await page.goto(`/books/${id}/read`);
  await expect(page).toHaveURL(new RegExp(`/books/${id}/read/1$`));
  await expect
    .poll(async () => page.evaluate(() => window.scrollY))
    .toBeGreaterThan(50);
});

test("restoring a position does not save until the reader moves", async ({
  page,
}) => {
  await setUp(page, "scroll");
  await importChapters(page);
  const id = await openFromLibrary(page);
  const saved = page.waitForResponse(
    (response) =>
      response.request().method() === "PUT" &&
      /\/position$/.test(response.url()),
  );
  await page.evaluate(() =>
    window.scrollTo(0, document.documentElement.scrollHeight),
  );
  await saved;
  await page.goto("/");
  const puts = positionPuts(page);
  await page.getByRole("link", { name: new RegExp(chapters) }).click();
  await expect(page).toHaveURL(new RegExp(`/books/${id}/read/1$`));
  await expect
    .poll(() => page.evaluate(() => window.scrollY))
    .toBeGreaterThan(100);
  await page.waitForTimeout(1000);
  expect(puts).toHaveLength(0);
});

test("a position 404 opens document 1 with no message; a 5xx shows the message", async ({
  page,
}) => {
  await setUp(page, "pages");
  await importChapters(page);
  await page.route("**/api/books/*/position", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({ status: 404, body: '{"error":"not found"}' });
      return;
    }
    await route.continue();
  });
  await page.getByRole("link", { name: new RegExp(chapters) }).click();
  await expect(page).toHaveURL(/\/books\/\d+\/read\/1$/);
  await expect(article(page)).toContainText("CHAPTER I.");
  await expect(
    page.getByText("The reading position could not be loaded."),
  ).toHaveCount(0);

  await page.getByRole("link", { name: "Library", exact: true }).click();
  await page.unroute("**/api/books/*/position");
  await page.route("**/api/books/*/position", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({ status: 500, body: '{"error":"boom"}' });
      return;
    }
    await route.continue();
  });
  await page.getByRole("link", { name: new RegExp(chapters) }).click();
  await expect(page).toHaveURL(/\/books\/\d+\/read\/1$/);
  await expect(
    page.getByText("The reading position could not be loaded."),
  ).toBeVisible();
});
