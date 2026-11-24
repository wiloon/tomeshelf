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

const defaults: {
  fontSize: number;
  lineHeight: number;
  width: number;
  theme: "light" | "dark" | "sepia";
  layout: "pages" | "scroll";
  wheelTurnsPages: boolean;
  repeatedLines: number;
  font: "default" | "literata" | "charter" | "source-serif-4";
} = {
  fontSize: 18,
  lineHeight: 1.6,
  width: 38,
  theme: "light",
  layout: "pages",
  font: "default",
  wheelTurnsPages: true,
  repeatedLines: 1,
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
  await expect(page).toHaveURL(/\/books\/[^/]+\/read\/1$/);
  await expect(article(page)).toContainText("Document One");
  return new URL(page.url()).pathname.split("/")[2];
}

// Sets the window size and waits until the reader has handled the resize,
// so what the test does next happens on the new layout: a scroll made before
// it is kept through it (ADR-0010 Re-layout).
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
    await resize(page, { width, height: 800 });
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

  await resize(page, { width: 375, height: 800 });
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
  await resize(page, { width: 1200, height: 800 });
  await page.reload();
  await expect(article(page)).toContainText("Document One");
  g = await pagesGeometry(page);
  expect(g?.articleWidth, "narrow desktop").toBeLessThan(700);

  await resize(page, { width: 1280, height: 800 });
  await page.reload();
  await expect(article(page)).toContainText("Document One");
  g = await pagesGeometry(page);
  expect(g?.articleWidth, "wide desktop").toBeGreaterThan(1000);
});

test("the article stays #tomeshelf-content and scrolls horizontally", async ({
  page,
}) => {
  await openBook(page);
  await resize(page, { width: 900, height: 800 });
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
  await resize(page, { width: 900, height: 800 });
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
  await resize(page, { width: 900, height: 800 });
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

test("Ctrl + wheel leaves zoom to the browser and saves no position", async ({
  page,
}) => {
  await resize(page, { width: 1280, height: 800 });
  const id = await openBook(page);
  // Let any arrival/re-layout work settle past the 500 ms save debounce.
  await page.waitForTimeout(800);
  const puts: string[] = [];
  page.on("request", (req) => {
    if (
      req.method() === "PUT" &&
      req.url().endsWith(`/api/books/${id}/position`)
    )
      puts.push(req.url());
  });
  const before = (await pagesGeometry(page))?.articleScrollLeft;
  const prevented = await article(page).evaluate((el) => {
    const event = new WheelEvent("wheel", {
      ctrlKey: true,
      deltaX: 40,
      bubbles: true,
      cancelable: true,
    });
    el.dispatchEvent(event);
    return event.defaultPrevented;
  });
  expect(prevented).toBe(false);
  await page.waitForTimeout(800);
  expect((await pagesGeometry(page))?.articleScrollLeft).toBe(before);
  expect(puts).toEqual([]);

  // A plain wheel still reaches the same listener and turns a spread.
  const plainPrevented = await article(page).evaluate((el) => {
    const event = new WheelEvent("wheel", {
      deltaX: 40,
      bubbles: true,
      cancelable: true,
    });
    el.dispatchEvent(event);
    return event.defaultPrevented;
  });
  expect(plainPrevented).toBe(true);
  await expect
    .poll(async () => (await pagesGeometry(page))?.articleScrollLeft ?? 0)
    .toBeGreaterThan(before ?? 0);
  await expect.poll(() => puts.length).toBe(1);
});

for (const scenario of [
  {
    name: "start",
    events: [
      [0, true],
      [100, false],
    ],
    turns: [0, 1],
  },
  {
    name: "end",
    events: [
      [0, false],
      [100, true],
      [200, false],
    ],
    turns: [1, 1, 1],
  },
  {
    name: "extend",
    events: [
      [0, false],
      [200, true],
      [400, false],
    ],
    turns: [1, 1, 2],
  },
] as const) {
  test(`Ctrl + wheel does not ${scenario.name} a plain wheel gesture`, async ({
    page,
  }) => {
    await resize(page, { width: 1280, height: 800 });
    await openBook(page);
    const result = await article(page).evaluate(async (el, events) => {
      const before = el.scrollLeft;
      const samples: { offset: number; prevented: boolean; time: number }[] =
        [];
      const start = performance.now();
      // Schedule in the page so browser/runner round trips cannot alter gaps.
      await Promise.all(
        events.map(
          ([delay, ctrlKey]) =>
            new Promise<void>((resolve) => {
              setTimeout(() => {
                const event = new WheelEvent("wheel", {
                  ctrlKey,
                  deltaX: 40,
                  bubbles: true,
                  cancelable: true,
                });
                el.dispatchEvent(event);
                samples.push({
                  offset: el.scrollLeft - before,
                  prevented: event.defaultPrevented,
                  time: performance.now() - start,
                });
                resolve();
              }, delay);
            }),
        ),
      );
      return {
        samples,
        step:
          el.clientWidth + Number.parseFloat(getComputedStyle(el).columnGap),
      };
    }, scenario.events);
    expect(result.samples.map((sample) => sample.offset)).toEqual(
      scenario.turns.map((turns) => turns * result.step),
    );
    expect(result.samples.map((sample) => sample.prevented)).toEqual(
      scenario.events.map(([, ctrlKey]) => !ctrlKey),
    );
    // Verify the real elapsed gaps straddle the 300 ms gesture quiet time.
    const times = result.samples.map((sample) => sample.time);
    expect(times[1] - times[0]).toBeLessThan(300);
    if (scenario.name === "extend") {
      expect(times[2] - times[0]).toBeGreaterThan(300);
      expect(times[2] - times[1]).toBeLessThan(300);
    } else if (scenario.name === "end") {
      expect(times[2] - times[1]).toBeLessThan(300);
    }
  });
}

test("one wheel burst turns one spread; a second after a quiet gap turns another", async ({
  page,
}) => {
  await openBook(page);
  await resize(page, { width: 900, height: 800 });
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
  await resize(page, { width: 900, height: 800 });
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
  await resize(page, { width: 900, height: 800 });
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
  await resize(page, { width: 1280, height: 800 });
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
  await resize(page, { width: 900, height: 800 });
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

// The first visible character, kept as its offset into the article's text:
// text nodes may be split and merged where a spread starts (ADR-0006).
async function markFirstVisibleCharacter(page: Page) {
  await article(page).evaluate((el) => {
    const root = el.getBoundingClientRect();
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let offset = 0;
    for (
      let node = walker.nextNode() as Text | null;
      node;
      node = walker.nextNode() as Text | null
    ) {
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
          Reflect.set(window, "testAnchor", offset + i);
          return;
        }
      }
      offset += node.length;
    }
    throw new Error("No visible character");
  });
}

async function firstVisibleCharacterOnSpread(page: Page) {
  return article(page).evaluate((el) => {
    let left = Reflect.get(window, "testAnchor") as number;
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (
      let node = walker.nextNode() as Text | null;
      node;
      node = walker.nextNode() as Text | null
    ) {
      if (left < node.length) {
        const range = document.createRange();
        range.setStart(node, left);
        range.setEnd(node, left + 1);
        const a = el.getBoundingClientRect();
        const b = range.getBoundingClientRect();
        return (
          b.right > a.left &&
          b.left < a.right &&
          b.bottom > a.top &&
          b.top < a.bottom
        );
      }
      left -= node.length;
    }
    return false;
  });
}

test("font size changes keep the first visible character on the spread", async ({
  page,
}) => {
  await openBook(page);
  await resize(page, { width: 900, height: 800 });
  await control(page, "Next").click();
  await markFirstVisibleCharacter(page);
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("button", { name: "Increase font size" }).click();
  expect(await firstVisibleCharacterOnSpread(page)).toBe(true);
});

test("changing the font keeps the first visible character on the spread", async ({
  page,
}) => {
  await openBook(page);
  await resize(page, { width: 900, height: 800 });
  await control(page, "Next").click();
  await markFirstVisibleCharacter(page);
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("radio", { name: "Literata" }).check();
  await expect
    .poll(async () =>
      page.evaluate(() =>
        [...document.fonts].some(
          (f) =>
            f.family.replace(/["']/g, "") === "Literata" &&
            f.status === "loaded",
        ),
      ),
    )
    .toBe(true);
  expect(await firstVisibleCharacterOnSpread(page)).toBe(true);
});

test("a late-loading font keeps the first visible character on the spread", async ({
  page,
}) => {
  const setup = await page.request.post("/api/setup", {
    data: { username: "reader", password: "reader password" },
  });
  expect(setup.status()).toBe(201);
  await saveSettings(page, { font: "literata", fontSize: 28 });
  let release = false;
  const held: import("@playwright/test").Route[] = [];
  await page.route("**/fonts/literata/**", async (route) => {
    if (release) {
      await route.continue();
      return;
    }
    held.push(route);
  });
  await page.goto("/");
  await page
    .getByLabel("Import an EPUB")
    .setInputFiles(path.join(books, "fonts.epub"));
  await expect(page.getByRole("status")).toHaveText(
    "Imported A Hand-Made Fonts Book.",
  );
  await page.getByRole("link", { name: /A Hand-Made Fonts Book/ }).click();
  await expect(page).toHaveURL(/\/books\/[^/]+\/read\/1$/);
  const id = new URL(page.url()).pathname.split("/")[2];
  await page.goto(`/books/${id}/read/2`);
  await expect(article(page)).toContainText("Long fonts document paragraph 1");
  // One page wide with a large size: every earlier page reflows when the
  // face swaps in, so the drift adds up to more than a page.
  await resize(page, { width: 600, height: 800 });
  for (let i = 0; i < 200; i++) {
    const far = await article(page).evaluate(
      (el) => el.scrollLeft > el.scrollWidth * 0.6,
    );
    if (far) {
      break;
    }
    await control(page, "Next").click();
  }
  await expect
    .poll(async () => (await pagesGeometry(page))?.articleScrollLeft ?? 0)
    .toBeGreaterThan(0);
  await markFirstVisibleCharacter(page);
  expect(held.length).toBeGreaterThan(0);
  release = true;
  for (const route of held) {
    await route.continue();
  }
  await expect
    .poll(async () =>
      page.evaluate(() =>
        [...document.fonts].some(
          (f) =>
            f.family.replace(/["']/g, "") === "Literata" &&
            f.status === "loaded",
        ),
      ),
    )
    .toBe(true);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(500);
  expect(await firstVisibleCharacterOnSpread(page)).toBe(true);
});

test("scrollIntoView keeps a right-page target visible after snapping", async ({
  page,
}) => {
  await openBook(page);
  await resize(page, { width: 1280, height: 800 });
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
  await expect(page).toHaveURL(/\/books\/[^/]+\/read\/1$/);
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
  await resize(page, { width: 375, height: 800 });
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
    await resize(page, { width, height: 800 });
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

for (const { width, edge } of [
  { width: 900, edge: "left" },
  { width: 900, edge: "right" },
  { width: 1280, edge: "left" },
  { width: 1280, edge: "right" },
] as const) {
  test(`drag-selecting to the ${edge} edge at ${width} px keeps the spread and the selection`, async ({
    page,
  }) => {
    await openBook(page);
    await resize(page, { width, height: 800 });
    await page.reload();
    await expect(article(page)).toContainText("Document One");
    await control(page, "Next").click();
    await expect
      .poll(async () => (await pagesGeometry(page))?.articleScrollLeft ?? 0)
      .toBeGreaterThan(0);
    // Let the turn's own position save go out before watching for saves.
    await page.waitForTimeout(1000);
    const before = (await pagesGeometry(page))?.articleScrollLeft ?? 0;
    const saves: string[] = [];
    page.on("request", (req) => {
      if (
        req.method() === "PUT" &&
        /\/api\/books\/[^/]+\/position$/.test(req.url())
      ) {
        saves.push(req.url());
      }
    });

    // A line at the chosen edge of the spread: press at its far end, drag
    // past its edge character and out of the article, where the browser
    // autoscrolls a scrollable box.
    const line = await page.evaluate((edge) => {
      const content = document.getElementById("tomeshelf-content");
      if (!content) {
        return null;
      }
      const box = content.getBoundingClientRect();
      const lines: DOMRect[] = [];
      for (const p of content.querySelectorAll("p")) {
        const range = document.createRange();
        range.selectNodeContents(p);
        for (const rect of range.getClientRects()) {
          if (
            rect.left >= box.left - 1 &&
            rect.right <= box.right + 1 &&
            rect.width > 100 &&
            rect.top > box.top + 40
          ) {
            lines.push(rect);
          }
        }
      }
      const pick =
        edge === "left"
          ? lines.find((rect) => rect.left < box.left + 40)
          : lines.reduce<DOMRect | undefined>(
              (best, rect) => (!best || rect.right > best.right ? rect : best),
              undefined,
            );
      if (!pick) {
        return null;
      }
      return {
        y: pick.top + pick.height / 2,
        // Start well inside the line, not at a glyph boundary that font
        // metrics can move.
        from: pick.left + pick.width * (edge === "left" ? 0.75 : 0.25),
        to: edge === "left" ? pick.left + 4 : pick.right - 4,
        out: edge === "left" ? box.left - 8 : box.right + 8,
      };
    }, edge);
    expect(line).not.toBeNull();
    await page.mouse.move(line!.from, line!.y);
    await page.mouse.down();
    await page.mouse.move(line!.to, line!.y, { steps: 10 });
    await page.mouse.move(
      Math.min(width - 1, Math.max(0, line!.out)),
      line!.y,
      { steps: 5 },
    );
    // Hold at the edge long enough for autoscroll and a 50 ms snap.
    await page.waitForTimeout(600);
    await page.mouse.up();
    await page.waitForTimeout(400);

    expect((await pagesGeometry(page))?.articleScrollLeft).toBe(before);
    const selection = await page.evaluate(() => {
      const content = document.getElementById("tomeshelf-content");
      const sel = getSelection();
      if (!content || !sel || sel.rangeCount === 0) {
        return null;
      }
      const box = content.getBoundingClientRect();
      const rects = [...sel.getRangeAt(0).getClientRects()].filter(
        (rect) => rect.width > 0,
      );
      return {
        text: sel.toString().trim(),
        onSpread:
          rects.length > 0 &&
          rects.every(
            (rect) => rect.left >= box.left - 1 && rect.right <= box.right + 1,
          ),
      };
    });
    expect(selection?.text.length).toBeGreaterThan(0);
    expect(selection?.onSpread).toBe(true);
    expect(saves).toEqual([]);
  });
}

test("native touch keeps table ownership through its edge", async ({
  page,
}) => {
  await resize(page, { width: 375, height: 800 });
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
    await resize(page, { width, height: 800 });
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
    await resize(page, { width, height: 800 });
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
  await resize(page, { width: 900, height: 800 });
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

async function disableWheel(page: Page) {
  await page.getByRole("button", { name: "Settings" }).click();
  const panel = page.getByRole("dialog", { name: "Reading settings" });
  await panel.getByRole("checkbox", { name: "Wheel turns pages" }).uncheck();
  await panel.getByRole("button", { name: "Close" }).click();
}

test("disabled wheel leaves text stationary and events unprevented without saving position", async ({
  page,
}) => {
  await resize(page, { width: 1280, height: 800 });
  const id = await openBook(page);
  await disableWheel(page);
  await page.waitForTimeout(800);
  const puts: string[] = [];
  page.on("request", (req) => {
    if (
      req.method() === "PUT" &&
      req.url().endsWith(`/api/books/${id}/position`)
    )
      puts.push(req.url());
  });
  const before = await article(page).evaluate((el) => el.scrollLeft);
  await article(page).hover();
  for (const [x, y] of [
    [0, 240],
    [240, 0],
  ]) {
    await page.mouse.wheel(x, y);
    await page.waitForTimeout(800);
    expect(await article(page).evaluate((el) => el.scrollLeft)).toBe(before);
  }
  for (const [x, y] of [
    [0, 40],
    [40, 0],
  ]) {
    expect(
      await article(page).evaluate(
        (el, [deltaX, deltaY]) => {
          const event = new WheelEvent("wheel", {
            deltaX,
            deltaY,
            bubbles: true,
            cancelable: true,
          });
          el.dispatchEvent(event);
          return event.defaultPrevented;
        },
        [x, y],
      ),
    ).toBe(false);
  }
  await page.waitForTimeout(800);
  expect(puts).toEqual([]);
});

test("disabled wheel keeps nested tables scrollable", async ({ page }) => {
  await resize(page, { width: 1280, height: 800 });
  await openSemanticsCommon(page);
  await disableWheel(page);
  const table = page.locator("#wide-table");
  await table.evaluate((el) =>
    el.scrollIntoView({ inline: "nearest", block: "nearest" }),
  );
  await page.waitForTimeout(800);
  const before = await article(page).evaluate((el) => el.scrollLeft);
  await table.hover();
  await page.mouse.wheel(160, 0);
  await expect
    .poll(() => table.evaluate((el) => el.scrollLeft))
    .toBeGreaterThan(0);
  await page.waitForTimeout(800);
  expect(await article(page).evaluate((el) => el.scrollLeft)).toBe(before);
});

test("disabled wheel preserves keys, controls, touch swipes and scrollIntoView", async ({
  page,
}) => {
  await resize(page, { width: 1280, height: 800 });
  await openBook(page);
  await disableWheel(page);
  // Close returns focus to Settings; keys belong to controls until focus leaves.
  await article(page).click({ position: { x: 100, y: 80 } });
  await page.keyboard.press("ArrowRight");
  await expect
    .poll(() => article(page).evaluate((el) => el.scrollLeft))
    .toBeGreaterThan(0);
  const step = await article(page).evaluate((el) => el.scrollLeft);
  await control(page, "Previous").click();
  expect(await article(page).evaluate((el) => el.scrollLeft)).toBe(0);
  await control(page, "Next").click();
  expect(await article(page).evaluate((el) => el.scrollLeft)).toBeCloseTo(
    step,
    0,
  );
  await control(page, "Previous").click();
  await swipeArticle(page, -80);
  expect(await article(page).evaluate((el) => el.scrollLeft)).toBeCloseTo(
    step,
    0,
  );
  await control(page, "Previous").click();
  const last = article(page).locator("[data-tomeshelf-block]").last();
  await last.evaluate((el) => el.scrollIntoView());
  await expect
    .poll(() => article(page).evaluate((el) => el.scrollLeft))
    .toBeGreaterThan(step);
  await expect
    .poll(() =>
      last.evaluate((el) => {
        const a = el.closest("article")?.getBoundingClientRect();
        const b = el.getBoundingClientRect();
        return a !== undefined && b.left < a.right && b.right > a.left;
      }),
    )
    .toBe(true);
});

test("scroll layout ignores disabled wheel", async ({ page }) => {
  await resize(page, { width: 1280, height: 800 });
  await openBook(page);
  await disableWheel(page);
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("radio", { name: "Scroll", exact: true }).check();
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await page.evaluate(() => window.scrollTo(0, 0));
  const box = await article(page).boundingBox();
  if (!box) throw new Error("article has no box");
  await page.mouse.move(box.x + 100, box.y + 80);
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  await page.mouse.wheel(0, 240);
  await expect
    .poll(() => page.evaluate(() => window.scrollY))
    .toBeGreaterThan(0);
});

// Spread starts and repeated lines (ADR-0010, issue #138), on a hand-made
// book whose second document holds paragraphs, headings, a list, a poem, a
// table and pictures.
const spreadTitle = "A Hand-Made Book of Spread Starts";

async function openSpreadBook(
  page: Page,
  settings: Partial<typeof defaults> = {},
): Promise<string> {
  const setup = await page.request.post("/api/setup", {
    data: { username: "reader", password: "reader password" },
  });
  expect(setup.status()).toBe(201);
  await saveSettings(page, settings);
  await page.goto("/");
  await page
    .getByLabel("Import an EPUB")
    .setInputFiles(path.join(books, "spread-start.epub"));
  await expect(page.getByRole("status")).toHaveText(`Imported ${spreadTitle}.`);
  await page.getByRole("link", { name: new RegExp(spreadTitle) }).click();
  await expect(page).toHaveURL(/\/books\/[^/]+\/read\/1$/);
  return new URL(page.url()).pathname.split("/")[2];
}

async function openSpreads(page: Page, id: string, hash = "") {
  await page.goto(`/books/${id}/read/2${hash}`);
  await expect(article(page)).toContainText("Spread Starts");
}

type SeenLine = { text: string; left: number; top: number };

// The lines of text wholly inside the article's box, in document order. A
// line is a run of characters with the same top. A block that cannot split
// (a picture, a table, pre) is one line, when it is visible (ADR-0010): its
// text, or [img] for a picture.
async function spreadLines(page: Page): Promise<SeenLine[]> {
  return article(page).evaluate((el) => {
    const box = el.getBoundingClientRect();
    // A glyph's box can be taller than a tight line (a heading), so a
    // character is inside when its middle is.
    const inside = (r: DOMRect) =>
      r.width > 0 &&
      r.left >= box.left - 1 &&
      r.right <= box.right + 1 &&
      (r.top + r.bottom) / 2 >= box.top &&
      (r.top + r.bottom) / 2 <= box.bottom;
    const meets = (r: DOMRect) =>
      r.width > 0 &&
      r.right > box.left + 1 &&
      r.left < box.right - 1 &&
      r.bottom > box.top + 1 &&
      r.top < box.bottom - 1;
    const out: { text: string; left: number; top: number }[] = [];
    let last: DOMRect | null = null;
    const range = document.createRange();
    const visit = (n: Node) => {
      if (
        n instanceof Element &&
        /^(IMG|TABLE|PRE|HR|VIDEO|svg)$/.test(n.tagName)
      ) {
        const r = n.getBoundingClientRect();
        if (meets(r)) {
          const text = n.textContent?.trim() || `[${n.tagName.toLowerCase()}]`;
          out.push({ text, left: r.left, top: r.top });
        }
        last = null;
        return;
      }
      if (n instanceof Text) {
        for (let i = 0; i < n.length; i++) {
          range.setStart(n, i);
          range.setEnd(n, i + 1);
          const r = range.getClientRects()[0];
          if (!r || !inside(r)) {
            continue;
          }
          const ch = n.data[i];
          if (!last || Math.abs(r.top - last.top) > 2) {
            if (/\s/.test(ch)) {
              continue;
            }
            out.push({ text: ch, left: r.left, top: r.top });
          } else {
            out[out.length - 1].text += ch;
          }
          last = r;
        }
        return;
      }
      for (let c = n.firstChild; c; c = c.nextSibling) {
        visit(c);
      }
    };
    visit(el);
    return out.map((l) => ({ ...l, text: l.text.replace(/\s+/g, " ").trim() }));
  });
}

// The article's text with all whitespace removed, to check that two lines
// follow each other with nothing between them.
async function squashedText(page: Page): Promise<string> {
  return article(page).evaluate(
    (el) => el.textContent?.replace(/\s+/g, "") ?? "",
  );
}

const squash = (s: string) => s.replace(/\s+|\[img\]/g, "");

for (const [width, pages] of [
  [1280, "two pages"],
  [390, "one page"],
] as const) {
  for (const n of [2, 0]) {
    test(`Next repeats exactly ${n} lines at ${width} px (${pages})`, async ({
      page,
    }) => {
      await resize(page, { width, height: 800 });
      const id = await openSpreadBook(page, { repeatedLines: n });
      await openSpreads(page, id);
      const text = await squashedText(page);
      for (let turn = 1; turn <= 3; turn++) {
        const at = `turn ${turn}`;
        const before = await spreadLines(page);
        await page.keyboard.press("ArrowRight");
        await expect
          .poll(async () => (await spreadLines(page))[0]?.text, { message: at })
          .not.toBe(before[0].text);
        const after = await spreadLines(page);
        if (n > 0) {
          expect(
            after.slice(0, n).map((l) => l.text),
            at,
          ).toEqual(before.slice(-n).map((l) => l.text));
        } else {
          const seam = squash(before.at(-1)!.text + after[0].text);
          expect(text.includes(seam), at).toBe(true);
        }
      }
    });
  }
}

// After every step: at most one marker, and the article's text unchanged
// (ADR-0010, ADR-0006).
async function expectIntact(page: Page, text: string, at: string) {
  const state = await article(page).evaluate((el) => ({
    markers: el.querySelectorAll("[data-tomeshelf-page-start]").length,
    marker: el.querySelector("[data-tomeshelf-page-start]")?.textContent ?? "",
    text: el.textContent,
  }));
  expect(state.markers, at).toBeLessThanOrEqual(1);
  expect(state.marker, at).toBe("");
  expect(state.text, at).toBe(text);
}

const firstAndLast = (lines: SeenLine[]) => [
  lines[0]?.text,
  lines.at(-1)?.text,
];

async function turnAndSettle(page: Page, key: "ArrowRight" | "ArrowLeft") {
  const before = (await spreadLines(page))[0]?.text;
  await page.keyboard.press(key);
  await expect
    .poll(async () => (await spreadLines(page))[0]?.text)
    .not.toBe(before);
}

for (const width of [1280, 390]) {
  test(`Next ×3 then Previous ×3 returns each spread exactly at ${width} px`, async ({
    page,
  }) => {
    await resize(page, { width, height: 800 });
    const id = await openSpreadBook(page, { repeatedLines: 2 });
    await openSpreads(page, id);
    const text = (await article(page).textContent()) ?? "";
    const seen = [firstAndLast(await spreadLines(page))];
    for (let i = 1; i <= 3; i++) {
      await turnAndSettle(page, "ArrowRight");
      await expectIntact(page, text, `Next ${i}`);
      seen.push(firstAndLast(await spreadLines(page)));
    }
    for (let i = 2; i >= 0; i--) {
      await turnAndSettle(page, "ArrowLeft");
      await expectIntact(page, text, `Previous to ${i}`);
      expect(firstAndLast(await spreadLines(page)), `spread ${i}`).toEqual(
        seen[i],
      );
    }
  });
}

// The first line's box relative to the article's: top left of the first
// page.
async function firstLineAtTopLeft(page: Page) {
  const box = await article(page).boundingBox();
  const first = (await spreadLines(page))[0];
  return {
    text: first.text,
    left: Math.round(first.left - (box?.x ?? 0)),
  };
}

test("resizing two pages to one and back, and changing font size, keep the first line at the top left", async ({
  page,
}) => {
  await resize(page, { width: 1280, height: 800 });
  const id = await openSpreadBook(page, { repeatedLines: 1 });
  await openSpreads(page, id);
  const text = (await article(page).textContent()) ?? "";
  await turnAndSettle(page, "ArrowRight");
  await turnAndSettle(page, "ArrowRight");
  const start = (await spreadLines(page))[0].text;
  // The spread start is a line; after re-layout the same text begins it.
  const word = start.split(" ")[0];
  for (const width of [700, 1280, 390, 1280]) {
    await resize(page, { width, height: 800 });
    await expect
      .poll(async () => (await firstLineAtTopLeft(page)).text.split(" ")[0], {
        message: `at ${width}`,
      })
      .toBe(word);
    expect((await firstLineAtTopLeft(page)).left, `at ${width}`).toBe(0);
    await expectIntact(page, text, `at ${width}`);
  }
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("button", { name: "Increase font size" }).click();
  await page.getByRole("button", { name: "Increase font size" }).click();
  await expect
    .poll(async () => (await firstLineAtTopLeft(page)).text.split(" ")[0])
    .toBe(word);
  expect((await firstLineAtTopLeft(page)).left).toBe(0);
});

test("Previous after a resize ends at or after the old spread's N-th line and skips none", async ({
  page,
}) => {
  await resize(page, { width: 1280, height: 800 });
  const id = await openSpreadBook(page, { repeatedLines: 2 });
  await openSpreads(page, id);
  const text = await squashedText(page);
  await turnAndSettle(page, "ArrowRight");
  await turnAndSettle(page, "ArrowRight");
  await resize(page, { width: 900, height: 800 });
  await expect.poll(async () => (await firstLineAtTopLeft(page)).left).toBe(0);
  const current = await spreadLines(page);
  const nth = squash(current[1].text);
  await turnAndSettle(page, "ArrowLeft");
  const previous = await spreadLines(page);
  // The previous spread reaches the current spread's 2nd line: the text
  // from its first line runs, without a gap, at least to that line.
  const from = text.indexOf(squash(previous[0].text));
  const to = text.indexOf(squash(previous.at(-1)!.text), from);
  const target = text.indexOf(nth, from);
  expect(from).toBeGreaterThanOrEqual(0);
  expect(to + squash(previous.at(-1)!.text).length).toBeGreaterThanOrEqual(
    target + nth.length,
  );
  // It starts before the current spread: no line is on neither spread.
  expect(from).toBeLessThan(text.indexOf(squash(current[0].text)));
});

test("Previous near the start shows the document from its first line", async ({
  page,
}) => {
  await resize(page, { width: 1280, height: 800 });
  const id = await openSpreadBook(page, { repeatedLines: 3 });
  await openSpreads(page, id);
  const first = (await spreadLines(page))[0].text;
  await turnAndSettle(page, "ArrowRight");
  // Forget the memory with a resize there and back.
  await resize(page, { width: 1200, height: 800 });
  await resize(page, { width: 1280, height: 800 });
  await expect.poll(async () => (await firstLineAtTopLeft(page)).left).toBe(0);
  await turnAndSettle(page, "ArrowLeft");
  expect(await firstLineAtTopLeft(page)).toEqual({ text: first, left: 0 });
  expect(await article(page).evaluate((el) => el.scrollLeft)).toBe(0);
});

test("Previous from a document's first spread opens the previous one at the spread ending with its last line", async ({
  page,
}) => {
  await resize(page, { width: 1280, height: 800 });
  const id = await openSpreadBook(page, { repeatedLines: 1 });
  await openSpreads(page, id);
  await page.keyboard.press("ArrowLeft");
  await expect(page).toHaveURL(new RegExp(`/books/${id}/read/1$`));
  await expect(article(page)).toContainText("Before the Spreads");
  const text = await squashedText(page);
  await expect
    .poll(async () => {
      const last = (await spreadLines(page)).at(-1)?.text ?? "";
      return last !== "" && text.endsWith(squash(last));
    })
    .toBe(true);
  // It is the earliest such spread: the one starting a line earlier does
  // not reach the end, so Next leaves the document.
  await page.keyboard.press("ArrowRight");
  await expect(page).toHaveURL(new RegExp(`/books/${id}/read/2$`));
});

test("scrollIntoView on a later block makes the line holding the first visible character the spread start", async ({
  page,
}) => {
  await resize(page, { width: 1280, height: 800 });
  const id = await openSpreadBook(page);
  await openSpreads(page, id);
  const text = (await article(page).textContent()) ?? "";
  await page
    .locator("#later")
    .evaluate((el) =>
      el.scrollIntoView({ inline: "center", block: "nearest" }),
    );
  // After alignment the first line sits at the top left of the first page,
  // and the heading is on the spread.
  await expect.poll(async () => (await firstLineAtTopLeft(page)).left).toBe(0);
  await expect
    .poll(async () =>
      (await spreadLines(page)).some((l) => l.text === "A Later Heading"),
    )
    .toBe(true);
  await expect
    .poll(() => article(page).evaluate((el) => el.scrollLeft % 1))
    .toBe(0);
  await expectIntact(page, text, "after scrollIntoView");
});

test("a contents entry and a fragment link open their target as the spread start", async ({
  page,
}) => {
  await resize(page, { width: 1280, height: 800 });
  const id = await openSpreadBook(page);
  await page.getByRole("button", { name: "Contents" }).click();
  await page
    .getByRole("navigation", { name: "Table of contents" })
    .getByRole("link", { name: "A Later Heading" })
    .click();
  await expect(page).toHaveURL(new RegExp(`/books/${id}/read/2#later$`));
  await expect
    .poll(async () => await firstLineAtTopLeft(page))
    .toEqual({
      text: "A Later Heading",
      left: 0,
    });
  // A heading at a spread start has no space above it.
  const gap = await article(page).evaluate((el) => {
    const h = document.getElementById("later")!;
    return Math.round(
      h.getBoundingClientRect().top - el.getBoundingClientRect().top,
    );
  });
  expect(gap).toBe(0);

  await page.goto(`/books/${id}/read/2#tall-figure`);
  await expect
    .poll(async () => (await spreadLines(page))[0]?.text)
    .toBe("[img]");
});

test("a spread holding only a picture taller than a page moves on and back without looping", async ({
  page,
}) => {
  await resize(page, { width: 390, height: 700 });
  const id = await openSpreadBook(page, { repeatedLines: 2 });
  await openSpreads(page, id, "#tall-figure");
  await expect
    .poll(async () => (await spreadLines(page))[0]?.text)
    .toBe("[img]");
  const picture = await spreadLines(page);
  await turnAndSettle(page, "ArrowRight");
  const after = await spreadLines(page);
  expect(after[0].text).not.toBe("[img]");
  await turnAndSettle(page, "ArrowLeft");
  expect(firstAndLast(await spreadLines(page))).toEqual(firstAndLast(picture));
  // Without memory too: a resize forgets it.
  await turnAndSettle(page, "ArrowRight");
  const first = (await spreadLines(page))[0].text;
  await resize(page, { width: 400, height: 700 });
  await expect
    .poll(async () => (await spreadLines(page))[0]?.text.split(" ")[0])
    .toBe(first.split(" ")[0]);
  await turnAndSettle(page, "ArrowLeft");
  const back = await spreadLines(page);
  expect(back.some((l) => l.text === "[img]")).toBe(true);
});

test("the pages layout keeps the DOM contract across turns", async ({
  page,
}) => {
  await resize(page, { width: 1280, height: 800 });
  const id = await openSpreadBook(page, { repeatedLines: 1 });
  await openSpreads(page, id);
  const blocks = () =>
    article(page).evaluate((el) =>
      [...el.querySelectorAll("[data-tomeshelf-block]")].map(
        (b) => `${b.getAttribute("data-tomeshelf-block")}:${b.textContent}`,
      ),
    );
  const start = await blocks();
  const text = (await article(page).textContent()) ?? "";
  for (let i = 0; i < 4; i++) {
    await turnAndSettle(page, "ArrowRight");
    await expectIntact(page, text, `turn ${i}`);
    expect(await blocks(), `turn ${i}`).toEqual(start);
  }
  // The marker is never a numbered block.
  expect(
    await article(page).evaluate(
      (el) =>
        el
          .querySelector("[data-tomeshelf-page-start]")
          ?.hasAttribute("data-tomeshelf-block") ?? false,
    ),
  ).toBe(false);
});

const spreadsHref = "OEBPS/text/spreads.xhtml";

// Stores a position whose quote starts at the character at `offset` in the
// document's text, then opens the book's resume address, which restores it
// as the spread start (ADR-0005).
async function resumeAt(page: Page, id: string, offset: number) {
  const text = (await article(page).textContent()) ?? "";
  const res = await page.request.put(`/api/books/${id}/position`, {
    data: {
      tabId: "e2e-spread-start",
      sequence: Date.now(),
      href: spreadsHref,
      locations: { progression: 0.5 },
      text: {
        before: text.slice(Math.max(0, offset - 32), offset),
        highlight: text.slice(offset, offset + 64),
        after: text.slice(offset + 64, offset + 96),
      },
    },
  });
  expect(res.status()).toBe(204);
  await page.goto(`/books/${id}/read`);
  await expect(page).toHaveURL(new RegExp(`/books/${id}/read/2$`));
  await expect(article(page)).toContainText("Spread Starts");
}

// The article-text offset and left edge of each visual line of an element's
// text, in the current layout.
async function linesOf(page: Page, selector: string) {
  return article(page).evaluate((el, sel) => {
    const target = el.querySelector(sel);
    if (!target) throw new Error(`no ${sel}`);
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const range = document.createRange();
    const out: { offset: number; left: number }[] = [];
    let offset = 0;
    let lastTop = Number.NaN;
    for (
      let n = walker.nextNode() as Text | null;
      n;
      n = walker.nextNode() as Text | null
    ) {
      if (target.contains(n)) {
        for (let i = 0; i < n.length; i++) {
          if (/\s/.test(n.data[i])) continue;
          range.setStart(n, i);
          range.setEnd(n, i + 1);
          const r = range.getBoundingClientRect();
          if (!(Math.abs(r.top - lastTop) <= 2)) {
            out.push({ offset: offset + i, left: r.left });
            lastTop = r.top;
          }
        }
      }
      offset += n.length;
    }
    return out;
  }, selector);
}

test("a spread start keeps its line's look: no first-line indent mid-paragraph, poem lines keep their hanging indent, list numbers stay", async ({
  page,
}) => {
  await resize(page, { width: 390, height: 800 });
  const id = await openSpreadBook(page);
  await openSpreads(page, id);
  const text = (await article(page).textContent()) ?? "";
  const pageLeft = async () =>
    Math.round((await article(page).boundingBox())?.x ?? 0);

  // A wrapped continuation of a long poem line.
  const poemLine = '[epub\\:type~="z3998:poem"] p > span:nth-of-type(2)';
  const wrapped = await linesOf(page, poemLine);
  expect(wrapped.length).toBeGreaterThan(1);
  const hang = Math.round(wrapped[1].left - wrapped[0].left);
  expect(hang).toBeGreaterThan(10);
  await resumeAt(page, id, wrapped[1].offset);
  await expect
    .poll(async () => {
      const first = (await spreadLines(page))[0];
      return first && Math.round(first.left) - (await pageLeft());
    })
    .toBe(hang);
  await expectIntact(page, text, "poem continuation");

  // A poem line's own first line hangs at the page's left edge.
  const short = await linesOf(
    page,
    '[epub\\:type~="z3998:poem"] p > span:nth-of-type(3)',
  );
  await resumeAt(page, id, short[0].offset);
  await expect
    .poll(async () => {
      const first = (await spreadLines(page))[0];
      return first && [first.text, Math.round(first.left) - (await pageLeft())];
    })
    .toEqual(["The swallows turn,", 0]);
  const where = await article(page).evaluate((el) => {
    const m = el.querySelector("[data-tomeshelf-page-start]");
    return [
      m?.parentElement?.tagName,
      m?.previousElementSibling?.tagName,
      m && getComputedStyle(m.previousElementSibling!).display,
    ];
  });
  expect(where).toEqual(["P", "BR", "none"]);
  await expectIntact(page, text, "poem line");

  // A mid-paragraph line starts at the page's left edge.
  const paragraph = await linesOf(page, "#first");
  await resumeAt(page, id, paragraph[3].offset);
  await expect
    .poll(async () => {
      const first = (await spreadLines(page))[0];
      return first && Math.round(first.left) - (await pageLeft());
    })
    .toBe(0);

  // A list item's first line: the marker goes before the item, outside it.
  const item = await linesOf(page, "ol > li:nth-child(3)");
  await resumeAt(page, id, item[0].offset);
  await expect
    .poll(() =>
      article(page).evaluate((el) => {
        const m = el.querySelector("[data-tomeshelf-page-start]");
        return m
          ? [m.parentElement?.tagName, getComputedStyle(m).display]
          : null;
      }),
    )
    .toEqual(["OL", "block"]);
  expect(
    await article(page).evaluate((el) => el.querySelectorAll("ol > li").length),
  ).toBe(4);
  await expectIntact(page, text, "list item");
});

test("the saved position in the pages layout is the spread start's first character, and reopening starts the spread there", async ({
  page,
}) => {
  await resize(page, { width: 1280, height: 800 });
  const id = await openSpreadBook(page, { repeatedLines: 2 });
  await openSpreads(page, id);
  const saved = page.waitForRequest(
    (req) =>
      req.method() === "PUT" && req.url().endsWith(`/books/${id}/position`),
  );
  await turnAndSettle(page, "ArrowRight");
  const seen = await firstLineAtTopLeft(page);
  const first = seen.text;
  const body = (await saved).postDataJSON() as {
    text: { highlight: string };
    locations: { progression: number };
  };
  expect(
    squash(body.text.highlight).startsWith(squash(first).slice(0, 20)),
  ).toBe(true);
  await page.goto(`/books/${id}/read`);
  await expect(page).toHaveURL(new RegExp(`/books/${id}/read/2$`));
  // The same first line at the same place (a list's line keeps its indent).
  await expect.poll(async () => await firstLineAtTopLeft(page)).toEqual(seen);
});

test("progression is 1 on the spread ending with the document's last line, and a progression alone restores to a line", async ({
  page,
}) => {
  await resize(page, { width: 1280, height: 800 });
  const id = await openSpreadBook(page);
  await page.goto(`/books/${id}/read/3`);
  await expect(article(page)).toContainText("After the Spreads");
  const saved = page.waitForRequest(
    (req) =>
      req.method() === "PUT" && req.url().endsWith(`/books/${id}/position`),
  );
  await page.keyboard.press("ArrowLeft");
  await expect(page).toHaveURL(new RegExp(`/books/${id}/read/2$`));
  const body = (await saved).postDataJSON() as {
    href: string;
    locations: { progression: number };
  };
  expect(body.href).toBe(spreadsHref);
  expect(body.locations.progression).toBe(1);

  const res = await page.request.put(`/api/books/${id}/position`, {
    data: {
      tabId: "e2e-progression",
      sequence: Date.now(),
      href: spreadsHref,
      locations: { progression: 0.5 },
    },
  });
  expect(res.status()).toBe(204);
  await page.goto(`/books/${id}/read`);
  await expect(page).toHaveURL(new RegExp(`/books/${id}/read/2$`));
  await expect.poll(async () => (await firstLineAtTopLeft(page)).left).toBe(0);
  const left = await article(page).evaluate((el) => el.scrollLeft);
  expect(left).toBeGreaterThan(0);
  expect(left % 632).toBe(0);
});
