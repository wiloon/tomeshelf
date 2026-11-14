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

// Creates the admin, imports a fixture, chooses it in the library and
// returns its book id once its first document shows.
async function openBook(
  page: Page,
  book = { file: "reader.epub", title, text: "Document One" },
): Promise<string> {
  const setup = await page.request.post("/api/setup", {
    data: { username: "reader", password: "reader password" },
  });
  expect(setup.status()).toBe(201);
  await page.goto("/");
  await page
    .getByLabel("Import an EPUB")
    .setInputFiles(path.join(books, book.file));
  await expect(page.getByRole("status")).toHaveText(`Imported ${book.title}.`);
  await page.getByRole("link", { name: new RegExp(book.title) }).click();
  await expect(page).toHaveURL(/\/books\/\d+\/read\/1$/);
  await expect(article(page)).toContainText(book.text);
  const id = new URL(page.url()).pathname.split("/")[2];
  return id;
}

function article(page: Page) {
  return page.locator("article#tomeshelf-content");
}

const contentsBook = {
  file: "toc.epub",
  title: "A Hand-Made Book With Contents",
  text: "CHAPTER I.",
};

// Opens the table of contents panel and returns it.
async function openContents(page: Page) {
  await page.getByRole("button", { name: "Contents" }).click();
  const panel = page.getByRole("navigation", { name: "Table of contents" });
  await expect(panel).toBeVisible();
  return panel;
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

test("a book with a translated title opens in the reader", async ({ page }) => {
  expect(
    (
      await page.request.post("/api/setup", {
        data: { username: "reader", password: "reader password" },
      })
    ).status(),
  ).toBe(201);
  await page.goto("/");
  await page
    .getByLabel("Import an EPUB")
    .setInputFiles(path.join(books, "translated-title.epub"));
  await expect(page.getByRole("status")).toContainText("Imported");
  await page.getByRole("link", { name: /A Hand-Made Reading Book/ }).click();
  const manifest = await page.request.get(
    new URL(page.url()).pathname
      .replace(/read\/1$/, "manifest")
      .replace("/books/", "/api/books/"),
  );
  expect(typeof (await manifest.json()).metadata.title).toBe("object");
  await expect(
    page.getByRole("heading", {
      name: /A Hand-Made Reading Book|Un livre artisanal/,
    }),
  ).toBeVisible();
  await expect(article(page)).toContainText("Document One");
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
  await expect(article(page).locator("img#fragment")).toHaveAttribute(
    "src",
    `/api/books/${id}/package/OEBPS/images/wide.png#detail`,
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
  expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
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

function box(page: Page, selector: string) {
  return page
    .locator(selector)
    .evaluate((el) => el.getBoundingClientRect().toJSON() as DOMRect);
}

test("the text column keeps its width and left edge on every document", async ({
  page,
}) => {
  const id = await openBook(page);
  for (const width of [1280, 375]) {
    await page.setViewportSize({ width, height: 800 });
    const columns: { n: number; left: number; width: number }[] = [];
    for (const n of [1, 2, 3]) {
      await page.goto(`/books/${id}/read/${n}`);
      await expect(article(page)).toContainText(
        `Document ${["One", "Two", "Three"][n - 1]}`,
      );
      const { left, width: w } = await box(page, "article#tomeshelf-content");
      columns.push({ n, left, width: w });
    }
    for (const column of columns) {
      expect(column, `document ${column.n} at ${width} px`).toEqual({
        ...columns[0],
        n: column.n,
      });
    }
  }
});

test("previous/next align with the text column", async ({ page }) => {
  const id = await openBook(page);
  for (const width of [1280, 375]) {
    await page.setViewportSize({ width, height: 800 });
    await page.goto(`/books/${id}/read/2`);
    await expect(article(page)).toContainText("Document Two");
    const text = await box(page, "article#tomeshelf-content");
    const previous = await control(page, "Previous").evaluate((el) =>
      el.getBoundingClientRect().toJSON(),
    );
    const next = await control(page, "Next").evaluate((el) =>
      el.getBoundingClientRect().toJSON(),
    );
    expect(Math.abs(previous.left - text.left), `at ${width} px`).toBeLessThan(
      1,
    );
    expect(Math.abs(next.right - text.right), `at ${width} px`).toBeLessThan(1);
    expect(previous.left).toBeGreaterThan(0);
    expect(next.right).toBeLessThan(width);
  }
});

test("a Gutenberg-style document holding several chapters renders as one scroll", async ({
  page,
}) => {
  const id = await openBook(page, {
    file: "chapters.epub",
    title: "A Hand-Made Book of Chapters",
    text: "CHAPTER I.",
  });
  await expect(article(page).locator("h2")).toHaveText([
    "CHAPTER I.",
    "CHAPTER II.",
    "CHAPTER III.",
    "CHAPTER IV.",
  ]);
  const last = article(page).getByText("Chapter IV ends.");
  await expect(last).not.toBeInViewport();
  const scroll = await page.evaluate(() => {
    const root = document.documentElement;
    const content = document.getElementById("tomeshelf-content");
    return {
      pageScrolls: root.scrollHeight > root.clientHeight,
      articleClips: content
        ? content.scrollHeight > content.clientHeight + 1
        : true,
    };
  });
  expect(scroll).toEqual({ pageScrolls: true, articleClips: false });

  await page.evaluate(() =>
    window.scrollTo(0, document.documentElement.scrollHeight),
  );
  await expect(last).toBeInViewport();
  await expect(page).toHaveURL(new RegExp(`/books/${id}/read/1$`));
  await control(page, "Next").click();
  await expect(article(page)).toContainText("A short note.");
});

test("a malicious book runs nothing and leaves nothing dangerous in the article", async ({
  page,
  context,
}) => {
  const dialogs: string[] = [];
  page.on("dialog", (dialog) => {
    dialogs.push(dialog.message());
    void dialog.dismiss();
  });
  const popups: string[] = [];
  context.on("page", (popup) => popups.push(popup.url()));

  const id = await openBook(page, {
    file: "malicious.epub",
    title: "A Hand-Made Malicious Book",
    text: "Malicious Document One",
  });
  const documents = [
    { n: 1, text: "Malicious Document One" },
    { n: 2, text: "Malicious Document Two" },
  ];
  for (const { n, text } of documents) {
    if (n > 1) {
      await control(page, "Next").click();
    }
    await expect(page).toHaveURL(new RegExp(`/books/${id}/read/${n}$`));
    await expect(article(page)).toContainText(text);

    // Activate whatever the payloads hang on.
    for (const target of await article(page).locator("a, p, details").all()) {
      await target.hover();
    }
    for (const name of [
      "js-link",
      "js-entity",
      "js-upper",
      "data-link",
      "js-tab",
    ]) {
      const link = article(page).locator(`a#${name}`);
      if ((await link.count()) > 0) {
        await link.click();
      }
    }
    await page.waitForTimeout(300);
    await expect(page).toHaveURL(new RegExp(`/books/${id}/read/${n}$`));

    const found = await page.evaluate(() => {
      const content = document.getElementById("tomeshelf-content");
      const elements = content ? [...content.querySelectorAll("*")] : [];
      return {
        pwned: (window as { __pwned?: string }).__pwned ?? null,
        dangerous: elements
          .filter((el) =>
            el.matches(
              "script, iframe, frame, object, embed, form, input, button, textarea, select, meta, base, link, style, animate, set",
            ),
          )
          .map((el) => el.localName),
        handlers: elements.flatMap((el) =>
          el.getAttributeNames().filter((name) => name.startsWith("on")),
        ),
        scriptURLs: elements.flatMap((el) =>
          el
            .getAttributeNames()
            .map((name) => el.getAttribute(name) ?? "")
            .filter((value) =>
              /^(javascript|data|vbscript):/i.test(
                // biome-ignore lint/suspicious/noControlCharactersInRegex: URL parsers drop these characters.
                value.replace(/[\u0000-\u0020]/g, ""),
              ),
            ),
        ),
        forged: {
          containers: document.querySelectorAll("#tomeshelf-content").length,
          blocks: elements
            .filter((el) => el.hasAttribute("data-tomeshelf-block"))
            .map((el) => el.getAttribute("data-tomeshelf-block")),
        },
      };
    });
    expect(found.pwned).toBeNull();
    expect(found.dangerous).toEqual([]);
    expect(found.handlers).toEqual([]);
    expect(found.scriptURLs).toEqual([]);
    expect(found.forged.containers).toBe(1);
    expect(found.forged.blocks).toEqual(
      found.forged.blocks.map((_, i) => String(i + 1)),
    );
  }

  // Reloaded documents parse the book afresh; nothing runs then either.
  for (const { n, text } of documents) {
    await page.goto(`/books/${id}/read/${n}`);
    await expect(article(page)).toContainText(text);
  }
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => "__pwned" in window)).toBe(false);
  expect(dialogs).toEqual([]);
  expect(popups).toEqual([]);
});

test("the table of contents lists the book's entries, nested, at phone and desktop widths", async ({
  page,
}) => {
  const id = await openBook(page, contentsBook);
  for (const width of [375, 1280]) {
    await page.setViewportSize({ width, height: 800 });
    await page.goto(`/books/${id}/read/1`);
    await expect(article(page)).toContainText("CHAPTER I.");
    const panel = await openContents(page);
    const top = panel.getByRole("list").first();
    await expect(top.locator(":scope > li")).toHaveCount(3);
    const book = top.locator(":scope > li").first();
    await expect(book.getByRole("link", { name: "The Book" })).toBeVisible();
    await expect(book.getByRole("list").getByRole("link")).toHaveText([
      "Chapter I",
      "Chapter II",
      "Chapter III",
      "Chapter IV",
    ]);
    await expect(
      panel.getByRole("link", { name: "Chapter IV" }),
    ).toBeInViewport();
    const overflow = await page.evaluate(
      () =>
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
    );
    expect(overflow, `overflow at ${width} px`).toBe(0);
    const right = await panel.evaluate(
      (el) => el.getBoundingClientRect().right,
    );
    expect(right, `panel at ${width} px`).toBeLessThanOrEqual(width);
  }
});

test("a table of contents entry opens its document at the entry's fragment", async ({
  page,
}) => {
  const id = await openBook(page, contentsBook);
  await control(page, "Next").click();
  await expect(article(page)).toContainText("The notes begin.");

  const panel = await openContents(page);
  await panel.getByRole("link", { name: "Chapter III" }).click();
  await expect(page).toHaveURL(new RegExp(`/books/${id}/read/1#chapter-3$`));
  await expect(panel).toBeHidden();
  const heading = article(page).locator("h2#chapter-3");
  await expect(heading).toBeInViewport();
  await expect(article(page).locator("h1")).not.toBeInViewport();
  expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
});

test("a book with no table of contents says so", async ({ page }) => {
  await openBook(page, {
    file: "no-toc.epub",
    title: "A Hand-Made Book Without Contents",
    text: "A book with no table of contents.",
  });
  const panel = await openContents(page);
  await expect(panel).toHaveText("This book has no table of contents.");
  await expect(panel.getByRole("link")).toHaveCount(0);
});

test("an entry outside the reading order is plain text, and its child and sibling still open", async ({
  page,
}) => {
  const id = await openBook(page, contentsBook);
  let panel = await openContents(page);
  const plates = panel.getByText("Plates", { exact: true });
  await expect(plates).toBeVisible();
  await expect(panel.getByRole("link", { name: "Plates" })).toHaveCount(0);
  expect(await plates.evaluate((el) => el.closest("a"))).toBeNull();

  await panel.getByRole("link", { name: "Notes" }).click();
  await expect(page).toHaveURL(new RegExp(`/books/${id}/read/2$`));
  await expect(article(page)).toContainText("The notes begin.");

  panel = await openContents(page);
  await panel.getByRole("link", { name: "Afterword" }).click();
  await expect(page).toHaveURL(new RegExp(`/books/${id}/read/3$`));
  await expect(article(page)).toContainText("The afterword closes the book.");
});

test("a note reference opens the endnote, and Back returns to the reference", async ({
  page,
}) => {
  const id = await openBook(page, contentsBook);
  const reference = article(page).locator("a#ref-1");
  await expect(reference).toHaveAttribute("href", `/books/${id}/read/2#note-1`);
  await reference.scrollIntoViewIfNeeded();
  await page.waitForTimeout(200);
  const before = await page.evaluate(() => window.scrollY);
  expect(before).toBeGreaterThan(0);

  await reference.click();
  await expect(page).toHaveURL(new RegExp(`/books/${id}/read/2#note-1$`));
  await expect(article(page)).toContainText("The first note, on the lantern.");
  await expect(article(page).locator("#note-1")).toBeInViewport();
  await expect(article(page).locator("h1")).not.toBeInViewport();

  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`/books/${id}/read/1$`));
  await expect(article(page)).toContainText("CHAPTER I.");
  await expect(reference).toBeInViewport();
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(before);
});
