import path from "node:path";
import { test as base, expect, type Page } from "@playwright/test";
import { startServer, type TestServer } from "./server";

// The clicked character and the reading mark (ADR-0005 Clicked character,
// ADR-0010 Reading mark, issue #129), on a hand-made book with short lines,
// a link, a named anchor, a picture, a table, a pre and a repeated refrain.

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
const title = "A Hand-Made Book of Clicked Lines";

type Settings = {
  fontSize: number;
  lineHeight: number;
  width: number;
  theme: "light" | "dark" | "sepia";
  layout: "pages" | "scroll";
  wheelTurnsPages: boolean;
  repeatedLines: number;
  font: "default" | "literata" | "charter" | "source-serif-4";
};

const defaults: Settings = {
  fontSize: 18,
  lineHeight: 1.6,
  width: 38,
  theme: "light",
  layout: "pages",
  font: "default",
  wheelTurnsPages: true,
  repeatedLines: 1,
};

async function saveSettings(page: Page, settings: Partial<Settings> = {}) {
  const res = await page.request.put("/api/settings", {
    data: { ...defaults, ...settings },
  });
  expect(res.status()).toBe(204);
}

// Signs in, imports the book and opens its first document. Returns its id.
async function openBook(
  page: Page,
  settings: Partial<Settings> = {},
  viewport = { width: 1280, height: 800 },
): Promise<string> {
  await page.setViewportSize(viewport);
  const setup = await page.request.post("/api/setup", {
    data: { username: "reader", password: "reader password" },
  });
  expect(setup.status()).toBe(201);
  await saveSettings(page, settings);
  await page.goto("/");
  await page
    .getByLabel("Import an EPUB")
    .setInputFiles(path.join(books, "clicked-line.epub"));
  await expect(page.getByRole("status")).toHaveText(`Imported ${title}.`);
  await page.getByRole("link", { name: new RegExp(title) }).click();
  await expect(page).toHaveURL(/\/books\/[^/]+\/read\/1$/);
  await expect(article(page)).toContainText("Clicked Lines");
  return new URL(page.url()).pathname.split("/")[2];
}

function article(page: Page) {
  return page.locator("article#tomeshelf-content");
}

function mark(page: Page) {
  return page.locator("[data-tomeshelf-reading-mark]");
}

type Box = { left: number; right: number; top: number; bottom: number };

type Saved = {
  href: string;
  locations: { progression: number };
  text?: { highlight?: string };
  clicked?: {
    cssSelector?: string;
    characterOffset?: number;
    text?: { highlight?: string };
  };
};

// Every position save the page sends, parsed.
function positionSaves(page: Page): Saved[] {
  const saves: Saved[] = [];
  page.on("request", (req) => {
    if (
      req.method() === "PUT" &&
      /\/api\/books\/[^/]+\/position$/.test(req.url())
    ) {
      saves.push(req.postDataJSON() as Saved);
    }
  });
  return saves;
}

// The article's box and its pages' boxes on the shown spread.
async function spreadBoxes(page: Page) {
  return article(page).evaluate((el) => {
    const box = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    const pageWidth = Number.parseFloat(
      style.getPropertyValue("--reading-page-width"),
    );
    const gap = Number.parseFloat(style.getPropertyValue("--reading-column-gap"));
    const two = box.width > pageWidth * 1.5;
    const pages = [
      { left: box.left, right: box.left + pageWidth },
      ...(two
        ? [{ left: box.left + pageWidth + gap, right: box.right }]
        : []),
    ];
    return {
      article: {
        left: box.left,
        right: box.right,
        top: box.top,
        bottom: box.bottom,
      },
      pages,
      gap,
    };
  });
}

// The box of a token's first character in the article.
async function charBox(page: Page, token: string, nth = 0): Promise<Box> {
  const box = await article(page).evaluate(
    (el, { token, nth }) => {
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      let seen = 0;
      for (let n = walker.nextNode() as Text | null; n; ) {
        const i = n.data.indexOf(token);
        if (i >= 0 && seen++ === nth) {
          const range = document.createRange();
          range.setStart(n, i);
          range.setEnd(n, i + 1);
          const r = range.getBoundingClientRect();
          return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
        }
        n = walker.nextNode() as Text | null;
      }
      return null;
    },
    { token, nth },
  );
  if (!box) {
    throw new Error(`no ${token} in the article`);
  }
  return box;
}

// The first K-numbered sentence token whose first character is shown on the
// given page of the spread.
async function tokenOnPage(page: Page, index: 0 | 1): Promise<string> {
  const { pages, article: a } = await spreadBoxes(page);
  const target = pages[index];
  const token = await article(page).evaluate(
    (el, { target, a }) => {
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode() as Text | null; n; ) {
        for (const m of n.data.matchAll(/K\d{3}/g)) {
          const range = document.createRange();
          range.setStart(n, m.index);
          range.setEnd(n, m.index + 1);
          const r = range.getBoundingClientRect();
          if (
            r.left >= target.left &&
            r.right <= target.right &&
            r.top > a.top + 40 &&
            r.bottom < a.bottom - 40
          ) {
            return m[0];
          }
        }
        n = walker.nextNode() as Text | null;
      }
      return null;
    },
    { target, a },
  );
  if (!token) {
    throw new Error(`no token on page ${index}`);
  }
  return token;
}

async function markBox(page: Page): Promise<Box & { side: string | null }> {
  await expect(mark(page)).toBeVisible();
  const handle = mark(page);
  const side = await handle.getAttribute("data-side");
  const b = await handle.boundingBox();
  if (!b) {
    throw new Error("the reading mark has no box");
  }
  return {
    left: b.x,
    right: b.x + b.width,
    top: b.y,
    bottom: b.y + b.height,
    side,
  };
}

// The reading mark sits beside the character's line, on the given side of
// the spread, outside the pages' text.
async function expectMarkBeside(
  page: Page,
  char: Box,
  side: "left" | "right",
) {
  await expect
    .poll(async () => {
      const m = await markBox(page);
      const { article: a } = await spreadBoxes(page);
      const middle = (m.top + m.bottom) / 2;
      return {
        side: m.side,
        level: middle >= char.top - 1 && middle <= char.bottom + 1,
        outside: side === "left" ? m.right <= a.left : m.left >= a.right,
      };
    })
    .toEqual({ side, level: true, outside: true });
}

const center = (b: Box) => ({
  x: (b.left + b.right) / 2,
  y: (b.top + b.bottom) / 2,
});

test("a click on a word marks its line on the matching side and saves it as the clicked character", async ({
  page,
}) => {
  await openBook(page);
  const saves = positionSaves(page);

  const left = await tokenOnPage(page, 0);
  const leftBox = await charBox(page, left);
  await page.mouse.click(center(leftBox).x, center(leftBox).y);
  await expectMarkBeside(page, leftBox, "left");
  await expect
    .poll(() => saves.at(-1)?.clicked?.text?.highlight ?? "")
    .toMatch(new RegExp(`^${left}`));
  expect(saves.at(-1)?.clicked?.cssSelector).toMatch(
    /^\[data-tomeshelf-block="\d+"\]$/,
  );

  const right = await tokenOnPage(page, 1);
  const rightBox = await charBox(page, right);
  await page.mouse.click(center(rightBox).x, center(rightBox).y);
  await expectMarkBeside(page, rightBox, "right");
  await expect
    .poll(() => saves.at(-1)?.clicked?.text?.highlight ?? "")
    .toMatch(new RegExp(`^${right}`));
  await expect(mark(page)).toHaveCount(1);
});
