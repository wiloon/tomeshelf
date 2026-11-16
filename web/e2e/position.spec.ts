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
  font: "default" as const,
};

async function saveSettings(
  page: Page,
  settings: {
    fontSize?: number;
    lineHeight?: number;
    width?: number;
    theme?: "light" | "dark" | "sepia";
    layout?: "pages" | "scroll";
    font?: "default" | "literata" | "charter" | "source-serif-4";
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
  const savedBlock = body?.locations.cssSelector;
  expect(savedBlock).toMatch(/^\[data-tomeshelf-block="\d+"\]$/);
  // The saved block is the one that holds the first visible character.
  const visible = await page.evaluate((selector) => {
    const el = document.getElementById("tomeshelf-content");
    const block = el?.querySelector(selector ?? "");
    if (!el || !(block instanceof Element)) return false;
    const box = el.getBoundingClientRect();
    const at = block.getBoundingClientRect();
    return at.right > box.left && at.left < box.right;
  }, savedBlock);
  expect(visible).toBe(true);

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

test("opening Next in another tab then switching layout saves nothing", async ({
  page,
}) => {
  await setUp(page, "scroll");
  await importChapters(page);
  await openFromLibrary(page);
  const next = page
    .getByRole("navigation", { name: "Reading order" })
    .getByRole("link", { name: "Next" });
  const puts = positionPuts(page);
  await next.dispatchEvent("click", { ctrlKey: true });
  await page.getByRole("button", { name: "Settings" }).click();
  await page
    .getByRole("dialog", { name: "Reading settings" })
    .getByRole("radio", { name: "Pages" })
    .check();
  await page.waitForTimeout(1200);
  expect(puts).toHaveLength(0);
});

function blockOnScreen(page: Page, selector: string) {
  return page.evaluate((sel) => {
    const el = document.getElementById("tomeshelf-content");
    const block = el?.querySelector(sel);
    if (!el || !block) return false;
    const box = el.getBoundingClientRect();
    const at = block.getBoundingClientRect();
    return at.right > box.left + 1 && at.left < box.right - 1;
  }, selector);
}

async function importToc(page: Page) {
  await page
    .getByLabel("Import an EPUB")
    .setInputFiles(path.join(books, "toc.epub"));
  await expect(page.getByRole("status")).toHaveText(
    "Imported A Hand-Made Book With Contents.",
  );
}

async function importReader(page: Page) {
  await page
    .getByLabel("Import an EPUB")
    .setInputFiles(path.join(books, "reader.epub"));
  await expect(page.getByRole("status")).toHaveText(
    "Imported A Hand-Made Reading Book.",
  );
}

test("pages layout at one-page width: turning a spread saves the visible block", async ({
  page,
}) => {
  await setUp(page, "pages");
  await importChapters(page);
  await openFromLibrary(page);
  const puts = positionPuts(page);
  await page.setViewportSize({ width: 420, height: 800 });
  await page
    .getByRole("navigation", { name: "Reading order" })
    .getByRole("button", { name: "Next" })
    .click();
  await expect.poll(() => puts.length).toBeGreaterThan(0);
  const saved = puts.at(-1)?.postDataJSON().locations.cssSelector as string;
  expect(saved).toMatch(/^\[data-tomeshelf-block="\d+"\]$/);
  expect(await blockOnScreen(page, saved)).toBe(true);
});

test("an anchor on the right page of a spread restores to that spread", async ({
  page,
}) => {
  await setUp(page, "pages");
  await importChapters(page);
  const id = await openFromLibrary(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.waitForTimeout(500);

  // Pick a block that sits on the right half after a turn, store it, restore.
  await page
    .getByRole("navigation", { name: "Reading order" })
    .getByRole("button", { name: "Next" })
    .click();
  await page.waitForTimeout(300);
  const right = await page.evaluate(() => {
    const el = document.getElementById("tomeshelf-content");
    if (!(el instanceof HTMLElement)) return null;
    const box = el.getBoundingClientRect();
    const mid = box.left + box.width / 2;
    for (const block of el.querySelectorAll("[data-tomeshelf-block]")) {
      const at = block.getBoundingClientRect();
      if (at.left >= mid && at.left < box.right && at.top < box.bottom) {
        return {
          n: block.getAttribute("data-tomeshelf-block"),
          text: (block.textContent ?? "").trim().slice(0, 32),
        };
      }
    }
    return null;
  });
  expect(right?.n).toBeTruthy();
  const rightN = right?.n ?? "";
  const rightText = right?.text ?? "";
  const sel = `[data-tomeshelf-block="${rightN}"]`;
  await page.request.put(`/api/books/${id}/position`, {
    data: {
      tabId: "e2e-right",
      sequence: 1,
      href: "OEBPS/text/book.xhtml",
      locations: {
        progression: 0.2,
        cssSelector: sel,
        characterOffset: 0,
      },
      text: { before: "", highlight: rightText, after: "" },
    },
  });

  await page.goto(`/books/${id}/read`);
  await expect(page).toHaveURL(new RegExp(`/books/${id}/read/1$`));
  await expect.poll(() => blockOnScreen(page, sel)).toBe(true);
  const onRight = await page.evaluate((selector) => {
    const el = document.getElementById("tomeshelf-content");
    const block = el?.querySelector(selector);
    if (!el || !block) return false;
    const box = el.getBoundingClientRect();
    return block.getBoundingClientRect().left >= box.left + box.width / 2 - 2;
  }, sel);
  expect(onRight).toBe(true);
});

test("a nested p in an li is the saved and restored block", async ({
  page,
}) => {
  await setUp(page, "scroll");
  await importChapters(page);
  const id = await openFromLibrary(page);
  const puts = positionPuts(page);

  const nestedN = await page.evaluate(() => {
    const p = [...document.querySelectorAll("#tomeshelf-content p")].find(
      (el) => (el.textContent ?? "").includes("Nested two paragraph"),
    );
    if (!(p instanceof HTMLElement)) return null;
    p.scrollIntoView({ block: "start" });
    return p.getAttribute("data-tomeshelf-block");
  });
  expect(nestedN).not.toBeNull();
  await expect.poll(() => puts.length).toBeGreaterThan(0);
  const nested = puts.at(-1)?.postDataJSON() as {
    locations: { cssSelector?: string };
    text?: { highlight?: string };
  };
  expect(nested.text?.highlight).toMatch(/Nested two/);
  expect(nested.locations.cssSelector).toBe(
    `[data-tomeshelf-block="${nestedN}"]`,
  );

  await page.waitForTimeout(700);
  await page.goto("/");
  await page.getByRole("link", { name: new RegExp(chapters) }).click();
  await expect(page).toHaveURL(new RegExp(`/books/${id}/read/1$`));
  await expect
    .poll(() =>
      page.evaluate((n) => {
        const block = document.querySelector(`[data-tomeshelf-block="${n}"]`);
        if (!block) return false;
        const box = block.getBoundingClientRect();
        return box.bottom > 0 && box.top < window.innerHeight;
      }, nestedN),
    )
    .toBe(true);
  await expect(page.getByText("Nested two paragraph")).toBeInViewport();
});

test("scroll layout: text outside any numbered block stores no block", async ({
  page,
}) => {
  await setUp(page, "scroll");
  await importChapters(page);
  await openFromLibrary(page);
  const puts = positionPuts(page);

  await page.evaluate(() => {
    const d = [...document.querySelectorAll("#tomeshelf-content div")].find(
      (el) => (el.textContent ?? "").trim() === "A loose div",
    );
    d?.scrollIntoView({ block: "start" });
  });
  await expect.poll(() => puts.length).toBeGreaterThan(0);
  const loose = puts.at(-1)?.postDataJSON() as {
    locations: { cssSelector?: string };
    text?: { highlight?: string };
  };
  expect(loose.locations.cssSelector).toBeUndefined();
  expect(loose.text?.highlight).toMatch(/loose div/i);
});

test("pages layout: a progression-only position restores on an odd-page document", async ({
  page,
}) => {
  await setUp(page, "pages");
  await importChapters(page);
  const id = await openFromLibrary(page);
  const puts = positionPuts(page);
  await page.setViewportSize({ width: 1280, height: 800 });

  // Walk to the last spreads so the document's odd page count has been
  // extended; then save and restore with progression alone.
  for (let i = 0; i < 8; i++) {
    const end = await page.evaluate(() => {
      const el = document.getElementById("tomeshelf-content");
      if (!(el instanceof HTMLElement)) return true;
      return el.scrollLeft + el.clientWidth >= el.scrollWidth - 2;
    });
    if (end) break;
    await page
      .getByRole("navigation", { name: "Reading order" })
      .getByRole("button", { name: "Next" })
      .click();
    await page.waitForTimeout(100);
  }
  await expect.poll(() => puts.length).toBeGreaterThan(0);
  const late = puts.at(-1)?.postDataJSON() as {
    href: string;
    locations: { progression: number };
  };
  const progression = late.locations.progression;
  await page.request.put(`/api/books/${id}/position`, {
    data: {
      tabId: "e2e-prog",
      sequence: 99,
      href: late.href,
      locations: { progression },
    },
  });
  await page.goto(`/books/${id}/read`);
  await expect(page).toHaveURL(new RegExp(`/books/${id}/read/1$`));
  await expect
    .poll(async () =>
      page.evaluate(() => {
        const el = document.getElementById("tomeshelf-content");
        if (!(el instanceof HTMLElement)) return -1;
        const range = el.scrollWidth - el.clientWidth;
        return range <= 0 ? 1 : el.scrollLeft / range;
      }),
    )
    .toBeCloseTo(progression, 1);
});

test("a contents jump saves the arrival without further moves", async ({
  page,
}) => {
  await setUp(page, "scroll");
  await importToc(page);
  await page
    .getByRole("link", { name: /A Hand-Made Book With Contents/ })
    .click();
  await expect(article(page)).toContainText("CHAPTER I.");
  const id = new URL(page.url()).pathname.split("/")[2];
  const puts = positionPuts(page);

  await page.getByRole("button", { name: "Contents" }).click();
  await page
    .getByRole("navigation", { name: "Table of contents" })
    .getByRole("link", { name: "Chapter III" })
    .click();
  await expect(page).toHaveURL(new RegExp(`/books/${id}/read/1#chapter-3$`));
  await expect.poll(() => puts.length).toBeGreaterThan(0);
  const afterContents = puts.at(-1)?.postDataJSON() as {
    text?: { highlight?: string };
  };
  expect(afterContents.text?.highlight).toMatch(/CHAPTER III|Chapter III/i);
});

test("an in-book link saves the arrival without further moves", async ({
  page,
}) => {
  await setUp(page, "scroll");
  await importReader(page);
  await page.getByRole("link", { name: /A Hand-Made Reading Book/ }).click();
  await expect(article(page)).toContainText("Document One");
  const id = new URL(page.url()).pathname.split("/")[2];
  const puts = positionPuts(page);
  await page.waitForTimeout(500);

  await article(page).locator("a#to-two").click();
  await expect(page).toHaveURL(
    new RegExp(`/books/${id}/read/2#second-target$`),
  );
  await expect(article(page)).toContainText("Document Two");
  await expect
    .poll(() => {
      const last = puts.at(-1)?.postDataJSON() as { href?: string } | undefined;
      return last?.href ?? "";
    })
    .toMatch(/two\.xhtml/);
  const stored = await page.request.get(`/api/books/${id}/position`);
  expect((await stored.json()).href).toMatch(/two\.xhtml/);
});

test("a same-document contents jump resumes at that fragment from the library", async ({
  page,
}) => {
  await setUp(page, "scroll");
  await importToc(page);
  await page
    .getByRole("link", { name: /A Hand-Made Book With Contents/ })
    .click();
  await expect(article(page)).toContainText("CHAPTER I.");
  const id = new URL(page.url()).pathname.split("/")[2];
  const puts = positionPuts(page);

  await page.getByRole("button", { name: "Contents" }).click();
  await page
    .getByRole("navigation", { name: "Table of contents" })
    .getByRole("link", { name: "Chapter IV" })
    .click();
  await expect(page).toHaveURL(new RegExp(`/books/${id}/read/1#chapter-4$`));
  await expect.poll(() => puts.length).toBeGreaterThan(0);
  await page.waitForTimeout(700);

  await page.goto("/");
  await page
    .getByRole("link", { name: /A Hand-Made Book With Contents/ })
    .click();
  await expect(page).toHaveURL(new RegExp(`/books/${id}/read/1$`));
  await expect
    .poll(() =>
      page.evaluate(() => {
        const h = document.getElementById("chapter-4");
        if (!h) return false;
        const box = h.getBoundingClientRect();
        return box.top >= -2 && box.top < window.innerHeight / 2;
      }),
    )
    .toBe(true);
});

test("reload then move stores a fresh tab id and sequence", async ({
  page,
}) => {
  await setUp(page, "scroll");
  await importChapters(page);
  await openFromLibrary(page);
  const puts = positionPuts(page);
  await page.evaluate(() => window.scrollTo(0, 500));
  await expect.poll(() => puts.length).toBe(1);
  const first = puts[0]?.postDataJSON() as {
    tabId: string;
    sequence: number;
  };

  await page.reload();
  await expect(article(page)).toContainText("CHAPTER I.");
  const after = positionPuts(page);
  await page.evaluate(() => window.scrollTo(0, 900));
  await expect.poll(() => after.length).toBeGreaterThan(0);
  const second = after.at(-1)?.postDataJSON() as {
    tabId: string;
    sequence: number;
  };
  expect(second.tabId).not.toBe(first.tabId);
  expect(second.sequence).toBeGreaterThanOrEqual(1);
});

test("fresh context resumes in pages layout at the stored text", async ({
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
  const saved = puts.at(-1)?.postDataJSON().locations.cssSelector as string;

  const other = await browser.newContext({
    baseURL: server.url,
    storageState: await page.context().storageState(),
  });
  const fresh = await other.newPage();
  await fresh.setViewportSize({ width: 1280, height: 800 });
  await fresh.goto("/");
  await fresh.getByRole("link", { name: new RegExp(chapters) }).click();
  await expect(fresh).toHaveURL(new RegExp(`/books/${id}/read/1$`));
  await expect.poll(() => blockOnScreen(fresh, saved)).toBe(true);
  await other.close();
});

test("pages layout: restore falls back when the quote then the block are missing", async ({
  page,
}) => {
  await setUp(page, "pages");
  await importChapters(page);
  const id = await openFromLibrary(page);
  await page.setViewportSize({ width: 1280, height: 800 });

  await page.request.put(`/api/books/${id}/position`, {
    data: {
      tabId: "e2e-pages",
      sequence: 1,
      href: "OEBPS/text/book.xhtml",
      locations: {
        progression: 0.15,
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
  await expect
    .poll(() => blockOnScreen(page, '[data-tomeshelf-block="3"]'))
    .toBe(true);

  await page.request.put(`/api/books/${id}/position`, {
    data: {
      tabId: "e2e-pages",
      sequence: 2,
      href: "OEBPS/text/book.xhtml",
      locations: {
        progression: 0.4,
        cssSelector: '[data-tomeshelf-block="999"]',
        characterOffset: 0,
      },
    },
  });
  await page.goto(`/books/${id}/read`);
  await expect
    .poll(async () =>
      page.evaluate(() => {
        const el = document.getElementById("tomeshelf-content");
        if (!(el instanceof HTMLElement)) return 0;
        const range = el.scrollWidth - el.clientWidth;
        return range <= 0 ? 1 : el.scrollLeft / range;
      }),
    )
    .toBeGreaterThan(0.2);
});

test("a position saved at two pages restores at a larger font size", async ({
  page,
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
  const saved = puts.at(-1)?.postDataJSON().locations.cssSelector as string;

  await saveSettings(page, { fontSize: 24 });
  await page.goto("/");
  await page.getByRole("link", { name: new RegExp(chapters) }).click();
  await expect(page).toHaveURL(new RegExp(`/books/${id}/read/1$`));
  await expect.poll(() => blockOnScreen(page, saved)).toBe(true);
});

test("a pages position restores the same text after switching to scroll and back", async ({
  page,
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
  await page.waitForTimeout(700);
  const saved = puts.at(-1)?.postDataJSON() as {
    locations: { cssSelector?: string };
    text?: { highlight?: string };
  };
  const sel = saved.locations.cssSelector ?? "";
  expect(sel).toMatch(/^\[data-tomeshelf-block="\d+"\]$/);
  const quote = (saved.text?.highlight ?? "").slice(0, 24);

  // Leave and resume in scroll so restore runs after settings settle.
  await saveSettings(page, { layout: "scroll" });
  await page.goto("/");
  await page.getByRole("link", { name: new RegExp(chapters) }).click();
  await expect(page).toHaveURL(new RegExp(`/books/${id}/read/1$`));
  await expect
    .poll(() =>
      page.evaluate((s) => {
        const block = document.querySelector(s);
        if (!block) return false;
        const box = block.getBoundingClientRect();
        return box.bottom > 0 && box.top < window.innerHeight;
      }, sel),
    )
    .toBe(true);
  if (quote) {
    await expect(article(page)).toContainText(quote);
  }

  await saveSettings(page, { layout: "pages" });
  await page.goto("/");
  await page.getByRole("link", { name: new RegExp(chapters) }).click();
  await expect(page).toHaveURL(new RegExp(`/books/${id}/read/1$`));
  await expect.poll(() => blockOnScreen(page, sel)).toBe(true);
});

test("scroll layout: end of a long document and a short document save nothing after restore", async ({
  page,
}) => {
  await setUp(page, "scroll");
  await importChapters(page);
  const id = await openFromLibrary(page);
  const puts = positionPuts(page);

  await page.evaluate(() =>
    window.scrollTo(0, document.documentElement.scrollHeight),
  );
  await expect.poll(() => puts.length).toBeGreaterThan(0);
  await page.waitForTimeout(700);

  await page.goto("/");
  const afterLong = positionPuts(page);
  await page.getByRole("link", { name: new RegExp(chapters) }).click();
  await expect
    .poll(() => page.evaluate(() => window.scrollY))
    .toBeGreaterThan(100);
  await page.waitForTimeout(1000);
  expect(afterLong).toHaveLength(0);

  // Short notes document that fits the viewport.
  await page
    .getByRole("navigation", { name: "Reading order" })
    .getByRole("link", { name: "Next" })
    .click();
  await expect(page).toHaveURL(new RegExp(`/books/${id}/read/2$`));
  await expect(article(page)).toContainText("A short note");
  const shortPuts = positionPuts(page);
  await page.waitForTimeout(1000);
  // Arrival saved the short document; restoring it later must not re-save.
  expect(shortPuts.length).toBeGreaterThan(0);
  await page.waitForTimeout(700);
  await page.goto("/");
  const afterShort = positionPuts(page);
  await page.getByRole("link", { name: new RegExp(chapters) }).click();
  await expect(page).toHaveURL(new RegExp(`/books/${id}/read/2$`));
  await page.waitForTimeout(1000);
  expect(afterShort).toHaveLength(0);
});

test("a document address in pages never restores; reload and contents stay put", async ({
  page,
}) => {
  await setUp(page, "pages");
  await importToc(page);
  await page
    .getByRole("link", { name: /A Hand-Made Book With Contents/ })
    .click();
  await expect(article(page)).toContainText("CHAPTER I.");
  const id = new URL(page.url()).pathname.split("/")[2];
  const puts = positionPuts(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page
    .getByRole("navigation", { name: "Reading order" })
    .getByRole("button", { name: "Next" })
    .click();
  await expect.poll(() => puts.length).toBeGreaterThan(0);
  await page.waitForTimeout(700);

  await page.goto(`/books/${id}/read/1`);
  await expect(article(page)).toContainText("CHAPTER I.");
  await expect
    .poll(async () =>
      page.evaluate(() => {
        const el = document.getElementById("tomeshelf-content");
        return el instanceof HTMLElement ? el.scrollLeft : -1;
      }),
    )
    .toBe(0);

  await page.reload();
  await expect(article(page)).toContainText("CHAPTER I.");
  await expect
    .poll(async () =>
      page.evaluate(() => {
        const el = document.getElementById("tomeshelf-content");
        return el instanceof HTMLElement ? el.scrollLeft : -1;
      }),
    )
    .toBe(0);

  await page.getByRole("button", { name: "Contents" }).click();
  await page
    .getByRole("navigation", { name: "Table of contents" })
    .getByRole("link", { name: "Chapter I", exact: true })
    .click();
  await expect(page).toHaveURL(new RegExp(`/books/${id}/read/1#chapter-1$`));
  await expect
    .poll(async () =>
      page.evaluate(() => {
        const el = document.getElementById("tomeshelf-content");
        return el instanceof HTMLElement ? el.scrollLeft : -1;
      }),
    )
    .toBe(0);
});

test("a cached document navigation flushes the departure before saving the arrival", async ({
  page,
}) => {
  await setUp(page, "scroll");
  await importReader(page);
  await page.getByRole("link", { name: /A Hand-Made Reading Book/ }).click();
  await expect(article(page)).toContainText("Document One");
  await article(page).locator("a#to-two").click();
  await expect(article(page)).toContainText("Document Two");
  await page.goBack();
  await expect(article(page)).toContainText("Document One");
  await page.waitForTimeout(800);
  const puts = positionPuts(page);
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(150);
  await article(page).locator("a#to-two").click();
  await expect(article(page)).toContainText("Document Two");
  await expect.poll(() => puts.length).toBeGreaterThanOrEqual(2);
  const hrefs = puts.map(
    (req) => (req.postDataJSON() as { href: string }).href,
  );
  expect(hrefs[0]).toMatch(/one\.xhtml/);
  expect(hrefs[1]).toMatch(/two\.xhtml/);
});

test("clicking the current fragment then changing layout does not save", async ({
  page,
}) => {
  await setUp(page, "scroll");
  await importReader(page);
  await page.getByRole("link", { name: /A Hand-Made Reading Book/ }).click();
  const id = new URL(page.url()).pathname.split("/")[2];
  await page.goto(`/books/${id}/read/2#second-target`);
  await expect(article(page)).toContainText("Document Two");
  await page.waitForTimeout(600);
  await article(page).evaluate((el) => {
    const link = document.createElement("a");
    link.setAttribute("href", "#second-target");
    link.textContent = "Current fragment";
    el.querySelector("#second-target")?.append(link);
  });
  const puts = positionPuts(page);
  await article(page).getByRole("link", { name: "Current fragment" }).click();
  await page.waitForTimeout(700);
  expect(puts).toHaveLength(0);
  // Playwright scrolls a control into view before acting on it. The window
  // is scrolled down to #second-target and the layout is still scroll, so
  // that scroll is a reading move that saves the document's top. Dispatch
  // the Settings click and force the radio to keep the window where it is.
  await page.getByRole("button", { name: "Settings" }).dispatchEvent("click");
  await page.getByRole("radio", { name: "Pages" }).check({ force: true });
  await page.waitForTimeout(900);
  expect(puts).toHaveLength(0);
});

test("Back/Forward into a document address never restores", async ({
  page,
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
  const saved = puts.at(-1)?.postDataJSON() as {
    locations: { progression: number };
  };
  expect(saved.locations.progression).toBeGreaterThan(0);

  await page.goto(`/books/${id}/read/1`);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const el = document.getElementById("tomeshelf-content");
        return el instanceof HTMLElement ? el.scrollLeft : -1;
      }),
    )
    .toBe(0);
  await page.goto(`/books/${id}/read/2`);
  await expect(article(page)).toContainText("Notes");
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`/books/${id}/read/1$`));
  // A restore would advance scrollLeft to the stored progression (> 0).
  await expect
    .poll(() =>
      page.evaluate(() => {
        const el = document.getElementById("tomeshelf-content");
        return el instanceof HTMLElement ? el.scrollLeft : -1;
      }),
    )
    .toBe(0);
});

test("a stored href outside the reading order opens document 1 at its start", async ({
  page,
}) => {
  await setUp(page, "scroll");
  await importChapters(page);
  const id = await openFromLibrary(page);
  // The server rejects a PUT with an href outside the reading order; a
  // position whose href later leaves the order is served as a GET body.
  await page.route(/\/api\/books\/\d+\/position$/, async (route) => {
    if (route.request().method() !== "GET") {
      await route.continue();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        href: "OEBPS/text/gone.xhtml",
        locations: { progression: 0.9 },
        text: { before: "", highlight: "nowhere", after: "" },
      }),
    });
  });
  await page.goto(`/books/${id}/read`);
  await expect(page).toHaveURL(new RegExp(`/books/${id}/read/1$`));
  await expect(article(page)).toContainText("CHAPTER I.");
  await expect.poll(async () => page.evaluate(() => window.scrollY)).toBe(0);
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("a position saved at two pages restores after a font change", async ({
  page,
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
  const saved = puts.at(-1)?.postDataJSON().locations.cssSelector as string;

  await saveSettings(page, { font: "literata" });
  await page.goto("/");
  await page.getByRole("link", { name: new RegExp(chapters) }).click();
  await expect(page).toHaveURL(new RegExp(`/books/${id}/read/1$`));
  await expect.poll(() => blockOnScreen(page, saved)).toBe(true);
});

test("an image-only odd-page document saves and restores its last spread", async ({
  page,
}) => {
  await setUp(page, "pages");
  await page.setViewportSize({ width: 1280, height: 800 });
  await page
    .getByLabel("Import an EPUB")
    .setInputFiles(path.join(books, "image-only.epub"));
  await page.getByRole("link", { name: /A Hand-Made Image Book/ }).click();
  await expect(article(page).locator("img")).toHaveCount(5);
  const imagePages = await article(page)
    .locator("img")
    .evaluateAll((images) =>
      images.map((image) => Math.round((image as HTMLElement).offsetLeft)),
    );
  expect(new Set(imagePages).size).toBe(5);
  const id = new URL(page.url()).pathname.split("/")[2];
  const puts = positionPuts(page);
  const next = page
    .getByRole("navigation", { name: "Reading order" })
    .getByRole("button", { name: "Next" });
  await next.click();
  await next.click();
  await expect.poll(() => puts.length).toBeGreaterThan(0);
  const saved = puts.at(-1)?.postDataJSON() as {
    locations: { progression: number };
    text?: unknown;
  };
  expect(saved.locations.progression).toBeGreaterThan(0);
  expect(saved.text).toBeUndefined();
  await page.goto(`/books/${id}/read`);
  await expect(article(page).locator("img")).toHaveCount(5);
  await expect
    .poll(() => article(page).evaluate((el) => el.scrollLeft))
    .toBeGreaterThan(0);
});
