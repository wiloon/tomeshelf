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
  await expect(article(page)).toContainText("Document One");
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
  await expect(panel).toBeHidden();
  // Close returns focus to Settings; blur so arrow keys turn again (ADR-0010).
  await page.evaluate(() => {
    const active = document.activeElement;
    if (active instanceof HTMLElement) {
      active.blur();
    }
  });
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

const semanticsTitle = "A Hand-Made Book of Semantics";

async function openSemanticsCommon(page: Page): Promise<string> {
  const setup = await page.request.post("/api/setup", {
    data: { username: "reader", password: "reader password" },
  });
  expect(setup.status()).toBe(201);
  await saveSettings(page);
  await page.goto("/");
  await page
    .getByLabel("Import an EPUB")
    .setInputFiles(path.join(books, "semantics.epub"));
  await expect(page.getByRole("status")).toHaveText(
    `Imported ${semanticsTitle}.`,
  );
  await page.getByRole("link", { name: new RegExp(semanticsTitle) }).click();
  await expect(page).toHaveURL(/\/books\/\d+\/read\/1$/);
  const id = new URL(page.url()).pathname.split("/")[2];
  await page.goto(`/books/${id}/read/5`);
  await expect(article(page)).toContainText("Common Elements");
  return id;
}

async function swipeArticle(page: Page, dx: number) {
  await article(page).evaluate((el, delta) => {
    const rect = el.getBoundingClientRect();
    const y = rect.top + Math.min(80, rect.height / 2);
    const startX = rect.left + rect.width / 2;
    const endX = startX + delta;
    const fire = (type: string, x: number) => {
      const touch = new Touch({
        identifier: 1,
        target: el,
        clientX: x,
        clientY: y,
        pageX: x,
        pageY: y,
        screenX: x,
        screenY: y,
      });
      el.dispatchEvent(
        new TouchEvent(type, {
          bubbles: true,
          cancelable: true,
          touches: type === "touchend" ? [] : [touch],
          targetTouches: type === "touchend" ? [] : [touch],
          changedTouches: [touch],
        }),
      );
    };
    fire("touchstart", startX);
    fire("touchend", endX);
  }, dx);
}

test("native touch movement turns only one spread after momentum", async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 800 });
  await openBook(page);
  const client = await page.context().newCDPSession(page);
  await client.send("Emulation.setTouchEmulationEnabled", { enabled: true });
  const box = (await article(page).boundingBox())!;
  const x = box.x + box.width - 20;
  const y = box.y + 80;
  const before = (await pagesGeometry(page))!.articleScrollLeft;
  await client.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x, y }],
  });
  for (let i = 1; i <= 6; i++) {
    await client.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x: x - i * 45, y }],
    });
  }
  await client.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });
  await page.waitForTimeout(800);
  const after = (await pagesGeometry(page))!.articleScrollLeft;
  await control(page, "Previous").click();
  expect((await pagesGeometry(page))!.articleScrollLeft).toBe(before);
  expect(after).toBeGreaterThan(before);
});

test("a horizontal swipe turns one spread; a click on the text does not", async ({
  page,
}) => {
  await openBook(page);
  for (const width of [375, 900, 1280]) {
    await page.setViewportSize({ width, height: 800 });
    await page.reload();
    await expect(article(page)).toContainText("Document One");
    const before = (await pagesGeometry(page))?.articleScrollLeft ?? 0;
    await article(page).click({ position: { x: 20, y: 40 } });
    expect(
      (await pagesGeometry(page))?.articleScrollLeft,
      `click at ${width}`,
    ).toBe(before);

    await swipeArticle(page, -80);
    await expect
      .poll(async () => (await pagesGeometry(page))?.articleScrollLeft ?? 0)
      .toBeGreaterThan(before);
    const mid = (await pagesGeometry(page))?.articleScrollLeft ?? 0;
    await swipeArticle(page, 80);
    await expect
      .poll(async () => (await pagesGeometry(page))?.articleScrollLeft ?? 0)
      .toBe(before);
    expect(mid, `swipe turned at ${width}`).toBeGreaterThan(before);
  }
});

test("native touch keeps table ownership through its edge", async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 800 });
  await openSemanticsCommon(page);
  const table = page.locator("#wide-table");
  await table.evaluate((el) => el.scrollIntoView({ inline: "nearest" }));
  await page.waitForTimeout(200);
  await table.evaluate((el) => {
    el.scrollLeft = el.scrollWidth - el.clientWidth - 30;
  });
  const before = (await pagesGeometry(page))?.articleScrollLeft;
  const box = await table.boundingBox();
  if (!box) throw new Error("table has no box");
  const client = await page.context().newCDPSession(page);
  await client.send("Emulation.setTouchEmulationEnabled", { enabled: true });
  const x = Math.min(box.x + box.width - 10, 350);
  const y = box.y + box.height / 2;
  async function swipe() {
    await client.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x, y }],
    });
    for (let i = 1; i <= 4; i++) {
      await client.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ x: x - i * 35, y }],
      });
    }
    await client.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
    await page.waitForTimeout(600);
  }
  await swipe();
  expect(
    await table.evaluate(
      (el) => el.scrollLeft + el.clientWidth >= el.scrollWidth - 1,
    ),
  ).toBe(true);
  expect((await pagesGeometry(page))?.articleScrollLeft).toBe(before);
  await swipe();
  expect((await pagesGeometry(page))?.articleScrollLeft).toBeGreaterThan(
    before ?? 0,
  );
});

test("a wheel over a wide table scrolls the table until its edge turns a spread", async ({
  page,
}) => {
  await openSemanticsCommon(page);
  for (const width of [375, 900, 1280]) {
    await page.setViewportSize({ width, height: 800 });
    await page.reload();
    await expect(article(page)).toContainText("Common Elements");
    await article(page).evaluate((el) => {
      el.scrollLeft = 0;
    });
    const table = page.locator("#wide-table");
    await table.evaluate((el) => {
      el.scrollIntoView({ inline: "nearest", block: "nearest" });
    });
    const canScroll = await table.evaluate(
      (el) => el.scrollWidth > el.clientWidth + 1,
    );
    expect(canScroll, `wide table at ${width}`).toBe(true);

    await table.evaluate((el) => {
      el.scrollLeft = 0;
    });
    const start = (await pagesGeometry(page))?.articleScrollLeft ?? 0;
    await table.evaluate((el) => {
      el.dispatchEvent(
        new WheelEvent("wheel", {
          deltaX: 40,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    expect(
      (await pagesGeometry(page))?.articleScrollLeft,
      `mid-table wheel at ${width}`,
    ).toBe(start);

    await table.evaluate((el) => {
      el.scrollLeft = el.scrollWidth;
    });
    await page.waitForTimeout(350);
    await table.evaluate((el) => {
      el.dispatchEvent(
        new WheelEvent("wheel", {
          deltaX: 40,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    await expect
      .poll(async () => (await pagesGeometry(page))?.articleScrollLeft ?? 0)
      .toBeGreaterThan(start);

    // A swipe over the table while it can still scroll is left to the table.
    const afterEdge = (await pagesGeometry(page))?.articleScrollLeft ?? 0;
    await table.evaluate((el) => {
      el.scrollLeft = 0;
    });
    await table.evaluate((el) => {
      const rect = el.getBoundingClientRect();
      const y = rect.top + rect.height / 2;
      const startX = rect.left + Math.min(120, rect.width - 10);
      const fire = (type: string, x: number) => {
        const touch = new Touch({
          identifier: 2,
          target: el,
          clientX: x,
          clientY: y,
          pageX: x,
          pageY: y,
          screenX: x,
          screenY: y,
        });
        el.dispatchEvent(
          new TouchEvent(type, {
            bubbles: true,
            cancelable: true,
            touches: type === "touchend" ? [] : [touch],
            targetTouches: type === "touchend" ? [] : [touch],
            changedTouches: [touch],
          }),
        );
      };
      fire("touchstart", startX);
      fire("touchend", startX - 80);
    });
    expect(
      (await pagesGeometry(page))?.articleScrollLeft,
      `mid-table swipe at ${width}`,
    ).toBe(afterEdge);
  }
});

test("a fitting figure stays on one page; a tall caption keeps its image whole", async ({
  page,
}) => {
  await openSemanticsCommon(page);
  for (const width of [375, 900, 1280]) {
    await page.setViewportSize({ width, height: 800 });
    await page.reload();
    await expect(article(page)).toContainText("Common Elements");
    const at = `at ${width}`;

    await page.locator("#small-figure").evaluate((el) => {
      el.scrollIntoView({ inline: "nearest", block: "nearest" });
    });
    const small = await page.evaluate(() => {
      const root = document
        .getElementById("tomeshelf-content")!
        .getBoundingClientRect();
      const img = document
        .querySelector("#small-figure img")!
        .getBoundingClientRect();
      const cap = document
        .querySelector("#small-figure figcaption")!
        .getBoundingClientRect();
      const samePage =
        img.left < root.right &&
        img.right > root.left &&
        cap.left < root.right &&
        cap.right > root.left &&
        Math.floor(
          (img.left - root.left) /
            (Number.parseFloat(
              getComputedStyle(document.getElementById("tomeshelf-content")!)
                .columnWidth,
            ) +
              Number.parseFloat(
                getComputedStyle(document.getElementById("tomeshelf-content")!)
                  .columnGap,
              )),
        ) ===
          Math.floor(
            (cap.left - root.left) /
              (Number.parseFloat(
                getComputedStyle(document.getElementById("tomeshelf-content")!)
                  .columnWidth,
              ) +
                Number.parseFloat(
                  getComputedStyle(
                    document.getElementById("tomeshelf-content")!,
                  ).columnGap,
                )),
          );
      return {
        samePage,
        breakInside: getComputedStyle(document.querySelector("#small-figure")!)
          .breakInside,
      };
    });
    expect(small.breakInside, at).toMatch(/avoid/);
    expect(small.samePage, at).toBe(true);

    await page.locator("#tall-caption-image").evaluate((el) => {
      (el as HTMLElement).style.height = "2000px";
      (el as HTMLElement).style.width = "auto";
    });
    await page.locator("#tall-caption-figure").evaluate((el) => {
      el.scrollIntoView({ inline: "start", block: "nearest" });
    });
    await page.waitForTimeout(100);
    const first = await page.evaluate(() => {
      const articleEl = document.getElementById("tomeshelf-content")!;
      const root = articleEl.getBoundingClientRect();
      const img = document.getElementById("tall-caption-image")!;
      const imgBox = img.getBoundingClientRect();
      return {
        windowScrollY: window.scrollY,
        windowOverflowY:
          document.documentElement.scrollHeight -
          document.documentElement.clientHeight,
        imgHeight: imgBox.height,
        pageHeight: articleEl.clientHeight,
        imgVisible:
          imgBox.left < root.right &&
          imgBox.right > root.left &&
          imgBox.top >= root.top - 1 &&
          imgBox.bottom <= root.bottom + 1,
        scrollLeft: articleEl.scrollLeft,
      };
    });
    expect(first.windowScrollY, at).toBe(0);
    expect(first.windowOverflowY, at).toBe(0);
    expect(first.imgHeight, at).toBeLessThanOrEqual(first.pageHeight + 1);
    expect(first.imgVisible, at).toBe(true);

    const seen = new Set<number>();
    for (let i = 0; i < 40; i++) {
      const visible = await page.evaluate(() => {
        const root = document
          .getElementById("tomeshelf-content")!
          .getBoundingClientRect();
        const lines: number[] = [];
        for (const el of document.querySelectorAll(
          "#tall-caption [id^='tall-caption-line-']",
        )) {
          const box = el.getBoundingClientRect();
          if (
            box.left >= root.left - 1 &&
            box.right <= root.right + 1 &&
            box.top >= root.top - 1 &&
            box.bottom <= root.bottom + 1
          ) {
            const n = Number(el.id.replace("tall-caption-line-", ""));
            if (n) lines.push(n);
          }
        }
        return {
          lines,
          windowScrollY: window.scrollY,
          atEnd:
            document.getElementById("tomeshelf-content")!.scrollLeft >=
            document.getElementById("tomeshelf-content")!.scrollWidth -
              document.getElementById("tomeshelf-content")!.clientWidth -
              1,
        };
      });
      expect(visible.windowScrollY, at).toBe(0);
      for (const n of visible.lines) seen.add(n);
      if (seen.has(60)) break;
      if (visible.atEnd) break;
      await control(page, "Next").click();
    }
    expect(
      [...seen].sort((a, b) => a - b),
      `all caption lines ${at}`,
    ).toEqual(Array.from({ length: 60 }, (_, i) => i + 1));
  }

  // A heading is not left alone at the foot of a page (ADR-0010 Breaks).
  await page.setViewportSize({ width: 900, height: 800 });
  await article(page).evaluate((el) => {
    el.scrollLeft = 0;
    el.replaceChildren();
    const filler = document.createElement("div");
    filler.style.height = "calc(100% - 2.5em)";
    filler.textContent = "Filler that leaves only a heading's worth of room.";
    const heading = document.createElement("h2");
    heading.id = "orphan-heading";
    heading.textContent = "Should not sit alone";
    const following = document.createElement("p");
    following.id = "after-heading";
    following.textContent =
      "The paragraph that must travel with the heading onto the next page.";
    el.append(filler, heading, following);
  });
  await page.waitForTimeout(50);
  const orphan = await page.evaluate(() => {
    const root = document
      .getElementById("tomeshelf-content")!
      .getBoundingClientRect();
    const h = document
      .getElementById("orphan-heading")!
      .getBoundingClientRect();
    const p = document.getElementById("after-heading")!.getBoundingClientRect();
    const sameColumn = Math.abs(h.left - p.left) < 2;
    const headingAloneAtFoot =
      h.bottom > root.bottom - 40 && p.left >= root.right - 2;
    return { sameColumn, headingAloneAtFoot };
  });
  expect(orphan.headingAloneAtFoot).toBe(false);
  expect(orphan.sameColumn).toBe(true);
});
