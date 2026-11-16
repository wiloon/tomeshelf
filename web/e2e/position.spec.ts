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
  // Well inside the 500 ms debounce: the departing save goes out at once.
  await expect.poll(() => puts.length, { timeout: 300 }).toBeGreaterThan(0);
  const last = puts.at(-1)?.postDataJSON() as { href: string } | undefined;
  expect(last?.href).toContain("book.xhtml");
});

// Records the keepalive flag of every position PUT the page sends.
async function recordKeepalive(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { __keepalive: boolean[] };
    w.__keepalive = [];
    const original = window.fetch.bind(window);
    window.fetch = (input, init) => {
      if (init?.method === "PUT" && String(input).endsWith("/position")) {
        w.__keepalive.push(init.keepalive === true);
      }
      return original(input, init);
    };
  });
}

// Lets the scroll events of an earlier scroll reach the page's listeners.
function settleFrames(page: Page) {
  return page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
}

function hidePage(page: Page, mode: "hidden" | "pagehide" = "hidden") {
  return page.evaluate((m) => {
    if (m === "pagehide") {
      window.dispatchEvent(new Event("pagehide"));
      return;
    }
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "hidden",
    });
    document.dispatchEvent(new Event("visibilitychange"));
  }, mode);
}

test("hiding the page sends a pending position at once, as keepalive", async ({
  page,
}) => {
  await recordKeepalive(page);
  await setUp(page, "scroll");
  await importChapters(page);
  await openFromLibrary(page);
  const puts = positionPuts(page);

  await page.evaluate(() => window.scrollTo(0, 500));
  await settleFrames(page);
  await expect
    .poll(() => page.evaluate(() => window.scrollY))
    .toBeGreaterThan(0);
  await hidePage(page);
  // Inside the 500 ms debounce, so only the hide can have sent it.
  await expect.poll(() => puts.length, { timeout: 300 }).toBeGreaterThan(0);
  expect(
    await page.evaluate(
      () => (window as unknown as { __keepalive: boolean[] }).__keepalive,
    ),
  ).toEqual([true]);
});

test("pagehide sends a pending position as keepalive while still visible", async ({
  page,
}) => {
  await recordKeepalive(page);
  await setUp(page, "scroll");
  await importChapters(page);
  await openFromLibrary(page);
  const puts = positionPuts(page);

  await page.evaluate(() => window.scrollTo(0, 500));
  await expect
    .poll(() => page.evaluate(() => window.scrollY))
    .toBeGreaterThan(0);
  await settleFrames(page);
  await hidePage(page, "pagehide");
  await expect.poll(() => puts.length, { timeout: 300 }).toBeGreaterThan(0);
  expect(
    await page.evaluate(
      () => (window as unknown as { __keepalive: boolean[] }).__keepalive,
    ),
  ).toEqual([true]);
});

test("hiding the page without a move since the last save sends nothing", async ({
  page,
}) => {
  await setUp(page, "scroll");
  await importChapters(page);
  await openFromLibrary(page);
  const puts = positionPuts(page);

  await page.evaluate(() => window.scrollTo(0, 500));
  await expect.poll(() => puts.length).toBe(1);
  await page.waitForTimeout(300);
  await hidePage(page);
  await hidePage(page, "pagehide");
  await page.waitForTimeout(800);
  expect(puts).toHaveLength(1);
});

test("a failed position save is sent again on hide", async ({ page }) => {
  await setUp(page, "scroll");
  await importChapters(page);
  await openFromLibrary(page);
  let failing = true;
  await page.route("**/api/books/*/position", async (route) => {
    if (route.request().method() === "PUT" && failing) {
      await route.fulfill({ status: 500, body: '{"error":"boom"}' });
      return;
    }
    await route.continue();
  });
  const puts = positionPuts(page);
  await page.evaluate(() => window.scrollTo(0, 500));
  await expect.poll(() => puts.length).toBe(1);
  await page.waitForTimeout(300);
  failing = false;
  await hidePage(page);
  await expect.poll(() => puts.length, { timeout: 2000 }).toBe(2);
});

test("a resize after restoring or after moving saves nothing", async ({
  page,
}) => {
  await setUp(page, "scroll");
  await importChapters(page);
  const id = await openFromLibrary(page);
  const puts = positionPuts(page);

  await page.evaluate(() => window.scrollTo(0, 800));
  await expect.poll(() => puts.length).toBe(1);
  const stored = puts[0]?.postDataJSON().locations.cssSelector;

  await page.setViewportSize({ width: 600, height: 700 });
  await page.waitForTimeout(1200);
  await page.setViewportSize({ width: 1100, height: 800 });
  await page.waitForTimeout(1200);
  expect(puts).toHaveLength(1);
  expect(puts[0]?.postDataJSON().locations.cssSelector).toBe(stored);

  // Reopen (restore), resize, and nothing is sent.
  await page.goto("/");
  await page.getByRole("link", { name: new RegExp(chapters) }).click();
  await expect(page).toHaveURL(new RegExp(`/books/${id}/read/1$`));
  await expect
    .poll(() => page.evaluate(() => window.scrollY))
    .toBeGreaterThan(100);
  const after = positionPuts(page);
  await page.setViewportSize({ width: 700, height: 600 });
  await page.waitForTimeout(1200);
  expect(after).toHaveLength(0);
});

test("pages layout: a resize saves nothing", async ({ page }) => {
  await setUp(page, "pages");
  await importChapters(page);
  await openFromLibrary(page);
  const puts = positionPuts(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page
    .getByRole("navigation", { name: "Reading order" })
    .getByRole("button", { name: "Next" })
    .click();
  await expect.poll(() => puts.length).toBe(1);
  await page.waitForTimeout(700);
  await page.setViewportSize({ width: 700, height: 800 });
  await page.waitForTimeout(1200);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.waitForTimeout(1200);
  expect(puts).toHaveLength(1);
});

test("pages layout: an extension's scrollIntoView is a move that is saved", async ({
  page,
}) => {
  await setUp(page, "pages");
  await importChapters(page);
  await openFromLibrary(page);
  const puts = positionPuts(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.waitForTimeout(500);

  const target = await page.evaluate(() => {
    const el = document.getElementById("tomeshelf-content");
    if (!(el instanceof HTMLElement)) return null;
    const box = el.getBoundingClientRect();
    for (const block of el.querySelectorAll("[data-tomeshelf-block]")) {
      if (block.getBoundingClientRect().left - box.left > box.width) {
        block.scrollIntoView({ inline: "start" });
        return block.getAttribute("data-tomeshelf-block");
      }
    }
    return null;
  });
  expect(target).not.toBeNull();
  await expect.poll(() => puts.length).toBeGreaterThan(0);
  const saved = puts.at(-1)?.postDataJSON().locations.cssSelector as string;
  // The saved block is on the spread that the scroll settled on.
  const shown = await page.evaluate((selector) => {
    const el = document.getElementById("tomeshelf-content");
    const block = el?.querySelector(selector);
    if (!el || !block) return false;
    const box = el.getBoundingClientRect();
    const at = block.getBoundingClientRect();
    return at.right > box.left && at.left < box.right;
  }, saved);
  expect(shown).toBe(true);
});

test("arriving at the next document saves the arrival without any scrolling", async ({
  page,
}) => {
  await setUp(page, "scroll");
  await importChapters(page);
  const id = await openFromLibrary(page);
  const puts = positionPuts(page);
  await page.waitForTimeout(500);
  expect(puts).toHaveLength(0);

  await page
    .getByRole("navigation", { name: "Reading order" })
    .getByRole("link", { name: "Next" })
    .click();
  await expect(page).toHaveURL(new RegExp(`/books/${id}/read/2$`));
  await expect.poll(() => puts.length).toBe(1);
  const stored = await page.request.get(`/api/books/${id}/position`);
  expect((await stored.json()).href).toBe(puts[0]?.postDataJSON().href);
});

test("pages layout: a position saved at two pages restores at one page and after leaving and returning", async ({
  page,
}) => {
  await setUp(page, "pages");
  await importChapters(page);
  const id = await openFromLibrary(page);
  const puts = positionPuts(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  const next = page
    .getByRole("navigation", { name: "Reading order" })
    .getByRole("button", { name: "Next" });
  await next.click();
  await next.click();
  await expect.poll(() => puts.length).toBeGreaterThan(0);
  await page.waitForTimeout(700);
  const saved = puts.at(-1)?.postDataJSON().locations.cssSelector as string;

  await page.setViewportSize({ width: 420, height: 800 });
  await page.goto("/");
  await page.getByRole("link", { name: new RegExp(chapters) }).click();
  await expect(page).toHaveURL(new RegExp(`/books/${id}/read/1$`));
  await expect(article(page)).toContainText("CHAPTER");
  // The page shown at one-page width holds the saved block.
  await expect
    .poll(() =>
      page.evaluate((selector) => {
        const el = document.getElementById("tomeshelf-content");
        const block = el?.querySelector(selector);
        if (!el || !block) return false;
        const box = el.getBoundingClientRect();
        const at = block.getBoundingClientRect();
        return at.right > box.left && at.left < box.right;
      }, saved),
    )
    .toBe(true);
});

test("choosing the current contents entry, then switching layout, saves nothing", async ({
  page,
}) => {
  await setUp(page, "scroll");
  await page
    .getByLabel("Import an EPUB")
    .setInputFiles(path.join(books, "toc.epub"));
  await expect(page.getByRole("status")).toHaveText(
    "Imported A Hand-Made Book With Contents.",
  );
  await page
    .getByRole("link", { name: /A Hand-Made Book With Contents/ })
    .click();
  await expect(article(page)).toContainText("CHAPTER I.");
  const puts = positionPuts(page);

  await page.getByRole("button", { name: "Contents" }).click();
  const panel = page.getByRole("navigation", { name: "Table of contents" });
  await panel.getByRole("link", { name: "The Book" }).click();
  await page.waitForTimeout(500);
  puts.length = 0;

  await page.getByRole("button", { name: "Settings" }).click();
  const settings = page.getByRole("dialog", { name: "Reading settings" });
  await settings.getByRole("radio", { name: "Pages" }).check();
  await page.waitForTimeout(1200);
  expect(puts).toHaveLength(0);
});

test("restore falls back when the quote then the block are missing", async ({
  page,
}) => {
  await setUp(page, "scroll");
  await importChapters(page);
  const id = await openFromLibrary(page);

  await page.request.put(`/api/books/${id}/position`, {
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
