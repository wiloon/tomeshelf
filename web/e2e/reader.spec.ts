import path from "node:path";
import { test as base, expect, type Page } from "@playwright/test";
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
const title = "A Hand-Made Reading Book";

// Creates the admin, imports the reading fixture, chooses it in the library
// and returns its book id once its first document shows.
async function openBook(page: Page): Promise<string> {
  const setup = await page.request.post("/api/setup", {
    data: { username: "reader", password: "reader password" },
  });
  expect(setup.status()).toBe(201);
  await page.goto("/");
  await page
    .getByLabel("Import an EPUB")
    .setInputFiles(path.join(books, "reader.epub"));
  await expect(page.getByRole("status")).toHaveText(`Imported ${title}.`);
  await page.getByRole("link", { name: new RegExp(title) }).click();
  await expect(page).toHaveURL(/\/books\/\d+\/read\/1$/);
  await expect(article(page)).toContainText("Document One");
  const id = new URL(page.url()).pathname.split("/")[2];
  return id;
}

function article(page: Page) {
  return page.locator("article#tomeshelf-content");
}

function control(page: Page, name: "Previous" | "Next") {
  return page
    .getByRole("navigation", { name: "Reading order" })
    .getByRole("link", { name });
}

async function expectNotFound(page: Page) {
  await expect(page.getByRole("alert")).toHaveText(/not found/i);
  await expect(
    page.getByRole("link", { name: "Back to the library" }),
  ).toHaveAttribute("href", "/");
  await expect(article(page)).toHaveCount(0);
}

test("a book opens at its first document and previous/next walk its reading order", async ({
  page,
  browser,
  server,
}) => {
  const id = await openBook(page);
  await expect(page.getByRole("heading", { name: title })).toBeVisible();
  await expect(control(page, "Previous")).toHaveCount(0);

  await control(page, "Next").click();
  await expect(page).toHaveURL(new RegExp(`/books/${id}/read/2$`));
  await expect(article(page)).toContainText("Document Two");
  await expect(article(page)).not.toContainText("Document One");
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  await expect(control(page, "Previous")).toBeVisible();

  await control(page, "Next").click();
  await expect(page).toHaveURL(new RegExp(`/books/${id}/read/3$`));
  await expect(article(page)).toContainText("Document Three");
  await expect(control(page, "Next")).toHaveCount(0);

  await page.goBack();
  await expect(page).toHaveURL(/\/read\/2$/);
  await expect(article(page)).toContainText("Document Two");
  await page.goBack();
  await expect(article(page)).toContainText("Document One");
  await page.goForward();
  await expect(article(page)).toContainText("Document Two");

  await page.reload();
  await expect(article(page)).toContainText("Document Two");
  await page.goto(`/books/${id}/read/3`);
  await expect(article(page)).toContainText("Document Three");

  // The text is in the page's own DOM.
  expect(
    await page.evaluate(() => ({
      iframes: document.querySelectorAll("iframe").length,
      shadowRoots: [...document.querySelectorAll("*")].filter(
        (el) => el.shadowRoot,
      ).length,
    })),
  ).toEqual({ iframes: 0, shadowRoots: 0 });

  // Signed out, a reading URL goes through sign-in.
  const signedOut = await browser.newContext({ baseURL: server.url });
  const anonymous = await signedOut.newPage();
  await anonymous.goto(`/books/${id}/read/2`);
  await expect(anonymous).toHaveURL(/\/signin$/);
  await signedOut.close();
});

test("unknown books and documents show not found", async ({ page }) => {
  const id = await openBook(page);
  for (const url of [
    "/books/999/read/1",
    `/books/${id}/read/0`,
    `/books/${id}/read/4`,
    `/books/${id}/read/abc`,
    `/books/${id}/read/1.5`,
    `/books/${id}/read/-1`,
  ]) {
    await page.goto(url);
    await expectNotFound(page);
  }

  await page.goto("/");
  await page
    .getByLabel("Import an EPUB")
    .setInputFiles(path.join(books, "empty-reading-order.epub"));
  await expect(page.getByRole("status")).toHaveText(
    "Imported A Book With No Reading Order.",
  );
  await page
    .getByRole("link", { name: /A Book With No Reading Order/ })
    .click();
  await expectNotFound(page);
});

test("a failed fetch shows an error, and a late response is discarded", async ({
  page,
}) => {
  const id = await openBook(page);
  await page.route("**/package/OEBPS/text/two.xhtml", (route) =>
    route.fulfill({ status: 500, body: "boom" }),
  );
  await control(page, "Next").click();
  await expect(page).toHaveURL(/\/read\/2$/);
  await expect(page.getByRole("alert")).toContainText("could not be loaded");
  await expect(
    page.getByRole("link", { name: "Back to the library" }),
  ).toHaveAttribute("href", "/");
  await expect(article(page)).toHaveCount(0);
  await expect(page.getByText("Document One")).toHaveCount(0);
  await page.unroute("**/package/OEBPS/text/two.xhtml");

  // Document one answers only after the reader has moved on to document two.
  let release = () => {};
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/package/OEBPS/text/one.xhtml", async (route) => {
    await released;
    await route.continue();
  });
  await page.goto(`/books/${id}/read/1`);
  await expect(page.getByRole("status")).toHaveText(/loading/i);
  await control(page, "Next").click();
  await expect(article(page)).toContainText("Document Two");
  const late = page.waitForResponse("**/package/OEBPS/text/one.xhtml");
  release();
  await late;
  await page.waitForTimeout(200);
  await expect(page).toHaveURL(/\/read\/2$/);
  await expect(article(page)).toContainText("Document Two");
  await expect(article(page)).not.toContainText("Document One");
});

test("the book's CSS is dropped, Trusted Types guard the article, and no CSP rule is broken", async ({
  page,
}) => {
  const violations: string[] = [];
  page.on("console", (message) => {
    if (/content security policy|trusted type/i.test(message.text())) {
      violations.push(message.text());
    }
  });
  await openBook(page);
  const styling = await page.evaluate(() => {
    const content = document.getElementById("tomeshelf-content");
    const p = content?.querySelector("p");
    return {
      bookStyles: content?.querySelectorAll("link, style, [style]").length,
      bookSheets: [...document.styleSheets].filter((s) =>
        s.href?.includes("book.css"),
      ).length,
      pFont: p ? getComputedStyle(p).fontFamily : "",
      pColor: p ? getComputedStyle(p).color : "",
      pSize: p ? getComputedStyle(p).fontSize : "",
      articleFont: content ? getComputedStyle(content).fontFamily : "",
    };
  });
  expect(styling.bookStyles).toBe(0);
  expect(styling.bookSheets).toBe(0);
  expect(styling.pFont).toBe(styling.articleFont);
  expect(styling.articleFont).toMatch(/serif/);
  expect(styling.pFont).not.toMatch(/Comic Sans|monospace/);
  expect(styling.pColor).not.toBe("rgb(255, 0, 0)");
  expect(styling.pSize).not.toBe("40px");
  expect(violations).toEqual([]);

  const assignment = await page.evaluate(() => {
    const content = document.getElementById("tomeshelf-content");
    if (!content) {
      return "no article";
    }
    const before = content.innerHTML;
    try {
      content.innerHTML = "<p>Injected</p>";
      return "assigned";
    } catch (err) {
      return content.innerHTML === before
        ? (err as Error).name
        : "changed and threw";
    }
  });
  expect(assignment).toBe("TypeError");
  await expect(article(page)).not.toContainText("Injected");
});

test("links and images resolve against the document's path in the package", async ({
  page,
}) => {
  const id = await openBook(page);
  const wide = article(page).locator("img#wide");
  await expect(wide).toHaveAttribute(
    "src",
    `/api/books/${id}/package/OEBPS/images/wide.png`,
  );
  await expect(wide).not.toHaveAttribute("srcset", /./);
  await expect
    .poll(() => wide.evaluate((img: HTMLImageElement) => img.naturalWidth))
    .toBe(1600);
  await expect(article(page).locator("img#outside")).not.toHaveAttribute(
    "src",
    /./,
  );

  const link = (name: string) => article(page).locator(`a#${name}`);
  await expect(link("to-two")).toHaveAttribute(
    "href",
    `/books/${id}/read/2#second-target`,
  );
  await expect(link("to-local")).toHaveAttribute("href", "#local-target");
  for (const name of ["to-nav", "other-scheme"]) {
    await expect(link(name)).not.toHaveAttribute("href", /./);
    await expect(link(name)).toBeVisible();
  }
  for (const [name, href] of [
    ["external", "https://example.com/"],
    ["mail", "mailto:reader@example.com"],
  ]) {
    await expect(link(name)).toHaveAttribute("href", href);
    await expect(link(name)).toHaveAttribute("target", "_blank");
    await expect(link(name)).toHaveAttribute("rel", "noopener noreferrer");
  }

  await link("to-local").click();
  await expect(page).toHaveURL(new RegExp(`/books/${id}/read/1#local-target$`));
  await expect(page.locator("#local-target")).toBeInViewport();

  // A marker on window survives only if the moves stay inside the app.
  await page.evaluate(() => Object.assign(window, { __samePage: true }));
  await link("to-two").click();
  await expect(page).toHaveURL(
    new RegExp(`/books/${id}/read/2#second-target$`),
  );
  await expect(article(page)).toContainText("Document Two");
  await expect(page.locator("#second-target")).toBeInViewport();
  await link("back-to-one").click();
  await expect(page).toHaveURL(new RegExp(`/books/${id}/read/1$`));
  await expect(article(page)).toContainText("Document One");
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  expect(await page.evaluate(() => "__samePage" in window)).toBe(true);
});

test("reading fits phone and desktop widths", async ({ page }) => {
  const id = await openBook(page);
  for (const width of [375, 1280]) {
    await page.setViewportSize({ width, height: 800 });
    await page.goto(`/books/${id}/read/1`);
    const wide = article(page).locator("img#wide");
    await expect
      .poll(() => wide.evaluate((img: HTMLImageElement) => img.naturalWidth))
      .toBe(1600);
    const box = await page.evaluate(() => {
      const root = document.documentElement;
      const content = document.getElementById("tomeshelf-content");
      const img = document.getElementById("wide");
      return {
        overflow: root.scrollWidth - root.clientWidth,
        article: content?.getBoundingClientRect().width ?? 0,
        image: img?.getBoundingClientRect().width ?? Infinity,
      };
    });
    expect(box.overflow, `overflow at ${width} px`).toBe(0);
    expect(box.image).toBeLessThanOrEqual(box.article);
    if (width === 1280) {
      expect(box.article).toBeLessThanOrEqual(720);
    } else {
      expect(box.article).toBeGreaterThan(300);
    }
  }
});
