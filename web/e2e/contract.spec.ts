import path from "node:path";
import { test as base, expect, type Page } from "@playwright/test";
import { startServer, type TestServer } from "./server";

// The DOM contract for reading extensions (ADR-0006). A test that breaks
// here is a breaking change for extensions.

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

async function setUp(page: Page) {
  const setup = await page.request.post("/api/setup", {
    data: { username: "reader", password: "reader password" },
  });
  expect(setup.status()).toBe(201);
  // Contract tests walk documents with the scroll layout's document links.
  await saveScrollLayout(page);
  await page.goto("/");
}

async function importBook(page: Page, file: string, title: string) {
  await page.getByLabel("Import an EPUB").setInputFiles(path.join(books, file));
  await expect(page.getByRole("status")).toHaveText(`Imported ${title}.`);
}

// Chooses the book in the library and returns its id once its first
// document shows.
async function chooseBook(page: Page, title: string, text: string) {
  await page.getByRole("link", { name: new RegExp(title) }).click();
  await expect(page).toHaveURL(/\/books\/[^/]+\/read\/1$/);
  await expect(article(page)).toContainText(text);
  return new URL(page.url()).pathname.split("/")[2];
}

function article(page: Page) {
  return page.locator("article#tomeshelf-content");
}

function meta(page: Page, name: string) {
  return page.locator(`head meta[name="${name}"]`);
}

// Where the text lives: one article in the main DOM, with no iframe or
// shadow root anywhere on the page.
function containers(page: Page) {
  return page.evaluate(() => ({
    articles: document.querySelectorAll("#tomeshelf-content").length,
    inMainDocument:
      document.getElementById("tomeshelf-content")?.localName ?? null,
    iframes: document.querySelectorAll("iframe").length,
    shadowRoots: [...document.querySelectorAll("*")].filter(
      (el) => el.shadowRoot,
    ).length,
  }));
}

const inMainDom = {
  articles: 1,
  inMainDocument: "article",
  iframes: 0,
  shadowRoots: 0,
};

async function saveScrollLayout(page: Page) {
  const res = await page.request.put("/api/settings", {
    data: {
      fontSize: 18,
      lineHeight: 1.6,
      width: 38,
      theme: "light",
      layout: "scroll",
      font: "default",
      wheelTurnsPages: true,
    },
  });
  expect(res.status()).toBe(204);
}

function nextDocument(page: Page) {
  return page
    .getByRole("navigation", { name: "Reading order" })
    .getByRole("link", { name: "Next" })
    .click();
}

function blocks(page: Page) {
  return page.evaluate(() =>
    [
      ...document.querySelectorAll(
        "#tomeshelf-content :is(p, h1, h2, h3, h4, h5, h6, li), [data-tomeshelf-block]",
      ),
    ].map((el) => ({
      tag: el.localName,
      n: el.getAttribute("data-tomeshelf-block"),
      text: (el.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 21),
    })),
  );
}

const chapters = "A Hand-Made Book of Chapters";

// The blocks of the Gutenberg-style document, numbered by hand from the
// fixture: pre-order, so each li comes before the p nested in it.
const chapterBlocks = [
  ["h1", "A Book of Chapters"],
  ["h2", "CHAPTER I."],
  ["p", "Chapter I begins. The"],
  ["p", "Chapter I ends. The t"],
  ["h2", "CHAPTER II."],
  ["p", "Chapter II begins. Th"],
  ["li", "First item Nested one"],
  ["li", "Nested one"],
  ["li", "Nested two paragraph"],
  ["p", "Nested two paragraph"],
  ["li", "Second item paragraph"],
  ["p", "Second item paragraph"],
  ["p", "A quoted paragraph"],
  ["h3", "A small heading"],
  ["p", "Chapter II ends. The "],
  ["h2", "CHAPTER III."],
  ["p", "Chapter III begins. T"],
  ["p", "Chapter III ends. The"],
  ["h2", "CHAPTER IV."],
  ["p", "Chapter IV begins. Th"],
  ["p", "Chapter IV ends. The "],
].map(([tag, text], i) => ({ tag, n: String(i + 1), text }));

test("reading pages carry the generator and book meta tags, updated on every move", async ({
  page,
}) => {
  await setUp(page);
  await importBook(page, "chapters.epub", chapters);
  await importBook(page, "reader.epub", "A Hand-Made Reading Book");
  await expect(meta(page, "tomeshelf:book")).toHaveCount(0);

  const id = await chooseBook(page, chapters, "CHAPTER I.");
  await expect(meta(page, "generator")).toHaveCount(1);
  await expect(meta(page, "generator")).toHaveAttribute(
    "content",
    /^tomeshelf \S+$/,
  );
  await expect(meta(page, "tomeshelf:book")).toHaveCount(1);
  await expect(meta(page, "tomeshelf:book")).toHaveAttribute("content", id);
  await expect(meta(page, "tomeshelf:restores-position")).toHaveCount(1);
  await expect(meta(page, "tomeshelf:restores-position")).toHaveAttribute(
    "content",
    "true",
  );

  await nextDocument(page);
  await expect(article(page)).toContainText("A short note.");
  await expect(meta(page, "generator")).toHaveCount(1);
  await expect(meta(page, "generator")).toHaveAttribute(
    "content",
    /^tomeshelf \S+$/,
  );
  await expect(meta(page, "tomeshelf:book")).toHaveCount(1);
  await expect(meta(page, "tomeshelf:book")).toHaveAttribute("content", id);
  await expect(meta(page, "tomeshelf:restores-position")).toHaveCount(1);

  await page.getByRole("link", { name: "Library", exact: true }).click();
  await expect(meta(page, "tomeshelf:book")).toHaveCount(0);
  await expect(meta(page, "generator")).toHaveCount(0);
  await expect(meta(page, "tomeshelf:restores-position")).toHaveCount(0);
  const other = await chooseBook(
    page,
    "A Hand-Made Reading Book",
    "Document One",
  );
  expect(other).not.toBe(id);
  await expect(meta(page, "tomeshelf:book")).toHaveCount(1);
  await expect(meta(page, "tomeshelf:book")).toHaveAttribute("content", other);
  await expect(meta(page, "generator")).toHaveCount(1);
  await expect(meta(page, "tomeshelf:restores-position")).toHaveCount(1);
});

test("one article holds the text in the main DOM, with blocks numbered per document", async ({
  page,
}) => {
  await setUp(page);
  await importBook(page, "chapters.epub", chapters);
  const id = await chooseBook(page, chapters, "CHAPTER I.");

  expect(await containers(page)).toEqual(inMainDom);
  expect(await blocks(page)).toEqual(chapterBlocks);

  await page.reload();
  await expect(article(page)).toContainText("CHAPTER I.");
  expect(await blocks(page)).toEqual(chapterBlocks);

  const noteBlocks = [
    { tag: "h1", n: "1", text: "Notes" },
    { tag: "p", n: "2", text: "A short note." },
  ];
  await nextDocument(page);
  await expect(page).toHaveURL(new RegExp(`/books/${id}/read/2$`));
  await expect(article(page)).toContainText("A short note.");
  expect(await containers(page)).toEqual(inMainDom);
  expect(await blocks(page)).toEqual(noteBlocks);

  await page.goto(`/books/${id}/read/2`);
  await expect(article(page)).toContainText("A short note.");
  expect(await containers(page)).toEqual(inMainDom);
  expect(await blocks(page)).toEqual(noteBlocks);
});

test("the book's own contract markup never survives", async ({ page }) => {
  await setUp(page);
  await importBook(page, "malicious.epub", "A Hand-Made Malicious Book");
  const id = await chooseBook(
    page,
    "A Hand-Made Malicious Book",
    "Malicious Document One",
  );
  for (const n of [1, 2]) {
    await page.goto(`/books/${id}/read/${n}`);
    await expect(article(page)).toContainText(
      n === 1 ? "Malicious Document One" : "Malicious Document Two",
    );
    const forged = await page.evaluate(() => ({
      containers: document.querySelectorAll("#tomeshelf-content").length,
      metasInArticle: document.querySelectorAll("#tomeshelf-content meta")
        .length,
      books: [...document.querySelectorAll('meta[name="tomeshelf:book"]')].map(
        (el) => el.getAttribute("content"),
      ),
      generators: [...document.querySelectorAll('meta[name="generator"]')].map(
        (el) => el.getAttribute("content"),
      ),
      otherContractAttributes: [
        ...document.querySelectorAll("#tomeshelf-content *"),
      ].flatMap((el) =>
        [...el.attributes]
          .map((attr) => attr.name)
          .filter(
            (name) =>
              name.startsWith("data-tomeshelf-") &&
              name !== "data-tomeshelf-block",
          ),
      ),
    }));
    expect(forged.containers).toBe(1);
    expect(forged.metasInArticle).toBe(0);
    expect(forged.books).toEqual([id]);
    expect(forged.generators).toHaveLength(1);
    expect(forged.generators[0]).toMatch(/^tomeshelf \S+$/);
    expect(forged.otherContractAttributes).toEqual([]);

    const numbered = await blocks(page);
    expect(numbered.length).toBeGreaterThan(0);
    expect(numbered.map((block) => block.n)).toEqual(
      numbered.map((_, i) => String(i + 1)),
    );
    expect(numbered.every((block) => /^(p|h[1-6]|li)$/.test(block.tag))).toBe(
      true,
    );
  }
});
