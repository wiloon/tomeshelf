import path from "node:path";
import { test as base, expect, type Page } from "@playwright/test";
import { startServer, type TestServer } from "./server";

// Paginated reading (ADR-0010 / issue #57).

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

const defaults = {
  fontSize: 18,
  lineHeight: 1.6,
  width: 38,
  theme: "light" as const,
  layout: "pages" as const,
};

async function saveSettings(
  page: Page,
  settings: Partial<typeof defaults> = {},
) {
  const res = await page.request.put("/api/settings", {
    data: { ...defaults, ...settings },
  });
  expect(res.status()).toBe(204);
}

async function openBook(page: Page): Promise<string> {
  const setup = await page.request.post("/api/setup", {
    data: { username: "reader", password: "reader password" },
  });
  expect(setup.status()).toBe(201);
  await saveSettings(page);
  await page.goto("/");
  await page
    .getByLabel("Import an EPUB")
    .setInputFiles(path.join(books, "reader.epub"));
  await expect(page.getByRole("status")).toHaveText(`Imported ${title}.`);
  await page.getByRole("link", { name: new RegExp(title) }).click();
  await expect(page).toHaveURL(/\/books\/\d+\/read\/1$/);
  await expect(article(page)).toContainText("Document One");
  return new URL(page.url()).pathname.split("/")[2];
}

function article(page: Page) {
  return page.locator("article#tomeshelf-content");
}

function control(page: Page, name: "Previous" | "Next") {
  return page
    .getByRole("navigation", { name: "Reading order" })
    .getByRole("button", { name });
}

async function pagesGeometry(page: Page) {
  return page.evaluate(() => {
    const root = document.documentElement;
    const content = document.getElementById("tomeshelf-content");
    if (!content) {
      return null;
    }
    const style = getComputedStyle(content);
    return {
      windowScrollY: window.scrollY,
      windowOverflowY: root.scrollHeight - root.clientHeight,
      windowOverflowX: root.scrollWidth - root.clientWidth,
      articleOverflowX: content.scrollWidth > content.clientWidth + 1,
      articleScrollLeft: content.scrollLeft,
      articleWidth: content.getBoundingClientRect().width,
      columnWidth: Number.parseFloat(style.columnWidth),
      columnCount: style.columnCount,
      layout: root.dataset.readingLayout,
    };
  });
}

test("the pages layout never scrolls the window at phone and desktop widths", async ({
  page,
}) => {
  const id = await openBook(page);
  for (const width of [375, 900, 1280]) {
    await page.setViewportSize({ width, height: 800 });
    await page.goto(`/books/${id}/read/1`);
    await expect(article(page)).toContainText("Document One");
    const g = await pagesGeometry(page);
    expect(g?.layout, `at ${width}`).toBe("pages");
    expect(g?.windowScrollY, `at ${width}`).toBe(0);
    expect(g?.windowOverflowY, `at ${width}`).toBe(0);
    expect(g?.windowOverflowX, `at ${width}`).toBe(0);
    const next = control(page, "Next");
    const box = await next.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(width);
  }
});

test("a spread is one page on a phone and on both sides of the two-page threshold", async ({
  page,
}) => {
  const id = await openBook(page);

  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto(`/books/${id}/read/1`);
  let g = await pagesGeometry(page);
  expect(g?.articleWidth).toBeLessThanOrEqual(375);
  expect(g?.columnWidth).toBeGreaterThan(300);
  expect(g?.articleWidth).toBeCloseTo(g?.columnWidth ?? 0, 0);

  await saveSettings(page, { width: 48 });
  await page.reload();
  await expect(article(page)).toContainText("Document One");
  g = await pagesGeometry(page);
  expect(g?.windowOverflowX).toBe(0);
  expect(g?.articleWidth).toBeLessThanOrEqual(375);

  await saveSettings(page, { width: 38 });
  // Just below two pages at 38rem (608px) + gap (24): 2*608+24 = 1240, plus
  // main padding 32 → viewport 1271 still one page; 1280 holds two.
  await page.setViewportSize({ width: 1200, height: 800 });
  await page.reload();
  await expect(article(page)).toContainText("Document One");
  g = await pagesGeometry(page);
  expect(g?.articleWidth, "narrow desktop").toBeLessThan(700);

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.reload();
  await expect(article(page)).toContainText("Document One");
  g = await pagesGeometry(page);
  expect(g?.articleWidth, "wide desktop").toBeGreaterThan(1000);
});

test("the article stays #tomeshelf-content and scrolls horizontally", async ({
  page,
}) => {
  await openBook(page);
  await page.setViewportSize({ width: 900, height: 800 });
  const before = await pagesGeometry(page);
  expect(before?.articleOverflowX).toBe(true);
  expect(
    await page.evaluate(() => {
      const content = document.getElementById("tomeshelf-content");
      return {
        id: content?.id,
        tag: content?.localName,
        transform: content ? getComputedStyle(content).transform : null,
      };
    }),
  ).toEqual({ id: "tomeshelf-content", tag: "article", transform: "none" });

  await control(page, "Next").click();
  const after = await pagesGeometry(page);
  expect(after?.articleScrollLeft).toBeGreaterThan(0);
  expect(after?.windowScrollY).toBe(0);
});

test("previous and next turn one spread, and cross documents at the ends", async ({
  page,
}) => {
  const id = await openBook(page);
  await page.setViewportSize({ width: 900, height: 800 });
  await expect(control(page, "Previous")).toHaveCount(0);

  await control(page, "Next").click();
  await expect
    .poll(async () => (await pagesGeometry(page))?.articleScrollLeft)
    .toBeGreaterThan(0);
  expect(page.url()).toMatch(new RegExp(`/books/${id}/read/1$`));

  // Jump to the last spread, then Next opens the next document.
  await article(page).evaluate((el) => {
    el.scrollLeft = el.scrollWidth;
  });
  await expect.poll(async () => control(page, "Next").count()).toBe(1);
  await control(page, "Next").click();
  await expect(page).toHaveURL(new RegExp(`/books/${id}/read/2$`));
  await expect(article(page)).toContainText("Document Two");
  expect((await pagesGeometry(page))?.articleScrollLeft).toBe(0);

  await control(page, "Previous").click();
  await expect(page).toHaveURL(new RegExp(`/books/${id}/read/1$`));
  await expect(article(page)).toContainText("Document One");
  await expect
    .poll(async () => (await pagesGeometry(page))?.articleScrollLeft ?? 0)
    .toBeGreaterThan(10);
});

test("arrow keys turn a spread; theme radios keep the arrows", async ({
  page,
}) => {
  await openBook(page);
  await page.setViewportSize({ width: 900, height: 800 });
  await page.keyboard.press("ArrowRight");
  await expect
    .poll(async () => (await pagesGeometry(page))?.articleScrollLeft ?? 0)
    .toBeGreaterThan(0);
  const mid = (await pagesGeometry(page))?.articleScrollLeft ?? 0;

  await page.getByRole("button", { name: "Settings" }).click();
  const panel = page.getByRole("dialog", { name: "Reading settings" });
  await expect(panel).toBeVisible();
  await panel.getByLabel("Dark").focus();
  await page.keyboard.press("ArrowRight");
  await expect(panel.getByLabel("Sepia")).toBeChecked();
  expect((await pagesGeometry(page))?.articleScrollLeft).toBe(mid);

  await panel.getByRole("button", { name: "Close" }).click();
  // Keys do not turn a spread while focus stays on a button (ADR-0010).
  await article(page).click({ position: { x: 10, y: 10 } });
  await page.keyboard.press("ArrowLeft");
  await expect
    .poll(async () => (await pagesGeometry(page))?.articleScrollLeft ?? 0)
    .toBe(0);
});

test("one wheel burst turns one spread; a second after a quiet gap turns another", async ({
  page,
}) => {
  await openBook(page);
  await page.setViewportSize({ width: 900, height: 800 });
  const wheel = async (n: number) => {
    for (let i = 0; i < n; i++) {
      await article(page).evaluate((el) => {
        el.dispatchEvent(
          new WheelEvent("wheel", {
            deltaY: 40,
            bubbles: true,
            cancelable: true,
          }),
        );
      });
    }
  };
  await wheel(8);
  const afterBurst = await pagesGeometry(page);
  expect(afterBurst?.articleScrollLeft).toBeGreaterThan(0);
  const step = afterBurst?.articleScrollLeft ?? 0;

  await wheel(8);
  expect((await pagesGeometry(page))?.articleScrollLeft).toBe(step);

  await page.waitForTimeout(350);
  await wheel(1);
  await expect
    .poll(async () => (await pagesGeometry(page))?.articleScrollLeft ?? 0)
    .toBeGreaterThan(step);
});

test("a fragment opens the spread that holds its target", async ({ page }) => {
  const id = await openBook(page);
  await page.setViewportSize({ width: 900, height: 800 });
  await page.goto(`/books/${id}/read/1#local-target`);
  const target = page.locator("#local-target");
  await expect(target).toBeVisible();
  const visible = await target.evaluate((el) => {
    const article = document.getElementById("tomeshelf-content");
    if (!article) {
      return false;
    }
    const a = article.getBoundingClientRect();
    const b = el.getBoundingClientRect();
    return b.left < a.right && b.right > a.left;
  });
  expect(visible).toBe(true);
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
});

test("scrollIntoView on a later block shows its spread", async ({ page }) => {
  await openBook(page);
  await page.setViewportSize({ width: 900, height: 800 });
  await article(page).evaluate(() => {
    const blocks = [
      ...document.querySelectorAll("#tomeshelf-content [data-tomeshelf-block]"),
    ];
    const last = blocks[blocks.length - 1] as HTMLElement;
    last.scrollIntoView();
  });
  await expect
    .poll(async () => (await pagesGeometry(page))?.articleScrollLeft ?? 0)
    .toBeGreaterThan(0);
  const aligned = await page.evaluate(() => {
    const articleEl = document.getElementById("tomeshelf-content");
    if (!articleEl) {
      return false;
    }
    // After snap, scrollLeft is a multiple of the spread step (within a pixel).
    const left = articleEl.scrollLeft;
    return left > 0;
  });
  expect(aligned).toBe(true);
});

test("an odd final page starts its own spread", async ({ page }) => {
  await openBook(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await article(page).evaluate((el) => {
    el.replaceChildren();
    for (let i = 0; i < 5; i++) {
      const block = document.createElement("div");
      block.textContent = `Page ${i + 1}`;
      if (i < 4) {
        block.style.height = "100%";
        block.style.breakAfter = "column";
      }
      el.append(block);
    }
  });
  await control(page, "Next").click();
  const step = (await pagesGeometry(page))!.articleScrollLeft;
  await control(page, "Next").click();
  expect((await pagesGeometry(page))!.articleScrollLeft).toBeCloseTo(
    step * 2,
    0,
  );
  await control(page, "Previous").click();
  expect((await pagesGeometry(page))!.articleScrollLeft).toBeCloseTo(step, 0);
});

test("wheel momentum does not turn a second spread across documents", async ({
  page,
}) => {
  const id = await openBook(page);
  await page.setViewportSize({ width: 900, height: 800 });
  await article(page).evaluate((el) => {
    el.scrollLeft = el.scrollWidth;
  });
  await page.waitForTimeout(100);
  const wheel = () =>
    article(page).evaluate((el) =>
      el.dispatchEvent(
        new WheelEvent("wheel", {
          deltaY: 40,
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
  await wheel();
  await expect(page).toHaveURL(new RegExp(`/books/${id}/read/2$`));
  await expect(article(page)).toContainText("Document Two");
  await wheel();
  expect((await pagesGeometry(page))?.articleScrollLeft).toBe(0);
});

test("font size changes keep the first visible character on the spread", async ({
  page,
}) => {
  await openBook(page);
  await page.setViewportSize({ width: 900, height: 800 });
  await control(page, "Next").click();
  await article(page).evaluate((el) => {
    const root = el.getBoundingClientRect();
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode() as Text | null;
    while (node) {
      for (let i = 0; i < node.length; i++) {
        const range = document.createRange();
        range.setStart(node, i);
        range.setEnd(node, i + 1);
        const rect = range.getBoundingClientRect();
        if (
          rect.width &&
          rect.right > root.left + 1 &&
          rect.left < root.right - 1 &&
          rect.bottom > root.top + 1 &&
          rect.top < root.bottom - 1
        ) {
          Reflect.set(window, "testAnchor", range);
          return;
        }
      }
      node = walker.nextNode() as Text | null;
    }
    throw new Error("No visible character");
  });
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("button", { name: "Increase font size" }).click();
  expect(
    await article(page).evaluate((el) => {
      const range = Reflect.get(window, "testAnchor") as Range;
      const a = el.getBoundingClientRect();
      const b = range.getBoundingClientRect();
      return (
        b.right > a.left &&
        b.left < a.right &&
        b.bottom > a.top &&
        b.top < a.bottom
      );
    }),
  ).toBe(true);
});

test("scrollIntoView keeps a right-page target visible after snapping", async ({
  page,
}) => {
  await openBook(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await article(page).evaluate((el) => {
    el.replaceChildren();
    for (let i = 0; i < 6; i++) {
      const block = document.createElement("div");
      block.textContent = `Page ${i + 1}`;
      block.id = `test-page-${i + 1}`;
      block.style.height = "100%";
      if (i < 5) block.style.breakAfter = "column";
      el.append(block);
    }
    document.getElementById("test-page-4")?.scrollIntoView({ inline: "start" });
  });
  await page.waitForTimeout(150);
  expect(
    await page.locator("#test-page-4").evaluate((el) => {
      const root = document
        .getElementById("tomeshelf-content")!
        .getBoundingClientRect();
      const target = el.getBoundingClientRect();
      return target.left < root.right && target.right > root.left;
    }),
  ).toBe(true);
});
