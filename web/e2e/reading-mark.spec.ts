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
    const gap = Number.parseFloat(
      style.getPropertyValue("--reading-column-gap"),
    );
    const two = box.width > pageWidth * 1.5;
    const pages = [
      { left: box.left, right: box.left + pageWidth },
      ...(two ? [{ left: box.left + pageWidth + gap, right: box.right }] : []),
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

// The box of a token's first character in the article, or of the character
// `at` after it.
async function charBox(page: Page, token: string, at = 0): Promise<Box> {
  const box = await article(page).evaluate(
    (el, { token, at }) => {
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode() as Text | null; n; ) {
        const i = n.data.indexOf(token);
        if (i >= 0) {
          const range = document.createRange();
          range.setStart(n, i + at);
          range.setEnd(n, i + at + 1);
          const r = range.getBoundingClientRect();
          return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
        }
        n = walker.nextNode() as Text | null;
      }
      return null;
    },
    { token, at },
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
async function expectMarkBeside(page: Page, char: Box, side: "left" | "right") {
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

// The last non-whitespace character on the visual line of a token's first
// character: its box and the quote a capture would store from it.
async function lineEnd(page: Page, token: string) {
  return article(page).evaluate((el, token) => {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const range = document.createRange();
    const box = (n: Text, i: number) => {
      range.setStart(n, i);
      range.setEnd(n, i + 1);
      return range.getBoundingClientRect();
    };
    let key = 0;
    let top: number | null = null;
    let last: { key: number; rect: DOMRect } | null = null;
    for (let n = walker.nextNode() as Text | null; n; ) {
      const from = top === null ? n.data.indexOf(token) : 0;
      if (from >= 0) {
        for (let i = from; i < n.length; i++) {
          if (/\s/.test(n.data[i])) {
            continue;
          }
          const r = box(n, i);
          if (r.width === 0 && r.height === 0) {
            continue;
          }
          top ??= r.top;
          if (Math.abs(r.top - top) > 2) {
            break;
          }
          last = { key: key + i, rect: r };
        }
        if (last && top !== null && last.key < key + n.length - 1) {
          // The line ended inside this node.
          const rest = n.data.slice(last.key - key + 1);
          if (/\S/.test(rest)) {
            break;
          }
        }
      }
      key += n.length;
      n = walker.nextNode() as Text | null;
    }
    if (!last) {
      return null;
    }
    const r = last.rect;
    return {
      highlight: (el.textContent ?? "").slice(last.key, last.key + 64),
      box: { left: r.left, right: r.right, top: r.top, bottom: r.bottom },
    };
  }, token);
}

// Turns spreads until the element is shown whole on the spread.
async function turnTo(page: Page, selector: string) {
  for (let i = 0; i < 30; i++) {
    const shown = await article(page).evaluate((el, selector) => {
      const target = el.querySelector(selector);
      if (!target) {
        return false;
      }
      const a = el.getBoundingClientRect();
      const r = target.getBoundingClientRect();
      return (
        r.left >= a.left - 1 &&
        r.right <= a.right + 1 &&
        r.top >= a.top - 1 &&
        r.bottom <= a.bottom + 1
      );
    }, selector);
    if (shown) {
      return;
    }
    await page.getByRole("button", { name: "Next" }).click();
  }
  throw new Error(`${selector} never showed`);
}

// The mark's box and the number of saves, settled; later checks compare to it.
async function settledState(page: Page, saves: Saved[]) {
  await page.waitForTimeout(800);
  return { mark: await markBox(page), saves: saves.length };
}

async function expectNothingStored(
  page: Page,
  saves: Saved[],
  before: { mark: Box & { side: string | null }; saves: number },
  what: string,
) {
  await page.waitForTimeout(800);
  expect(saves.length, `${what} saved a position`).toBe(before.saves);
  expect(await markBox(page), `${what} moved the mark`).toEqual(before.mark);
}

test("a click in the blank space beside a line marks that line's last character", async ({
  page,
}) => {
  await openBook(page);
  const saves = positionSaves(page);
  const { article: a, pages, gap } = await spreadBoxes(page);
  expect(pages).toHaveLength(2);
  const scrolled = () => article(page).evaluate((el) => el.scrollLeft);
  const spread = await scrolled();

  // The left margin beside a left-page line.
  const left = await tokenOnPage(page, 0);
  const leftEnd = await lineEnd(page, left);
  const leftChar = await charBox(page, left);
  await page.mouse.click(a.left - 8, center(leftChar).y);
  await expectMarkBeside(page, leftChar, "left");
  await expect
    .poll(() => saves.at(-1)?.clicked?.text?.highlight)
    .toBe(leftEnd?.highlight);

  // The right margin beside a right-page line.
  const right = await tokenOnPage(page, 1);
  const rightEnd = await lineEnd(page, right);
  const rightChar = await charBox(page, right);
  await page.mouse.click(a.right + 8, center(rightChar).y);
  await expectMarkBeside(page, rightChar, "right");
  await expect
    .poll(() => saves.at(-1)?.clicked?.text?.highlight)
    .toBe(rightEnd?.highlight);

  // The gap between the pages belongs to the nearer page.
  await page.mouse.click(pages[0].right + gap / 4, center(leftChar).y);
  await expectMarkBeside(page, leftChar, "left");
  await expect
    .poll(() => saves.at(-1)?.clicked?.text?.highlight)
    .toBe(leftEnd?.highlight);
  await page.mouse.click(pages[1].left - gap / 4, center(rightChar).y);
  await expectMarkBeside(page, rightChar, "right");

  // A space between two words is on the line's text: the character nearest
  // the pointer, the end of one word or the start of the next.
  const space = await charBox(page, left, left.length);
  await page.mouse.click(center(space).x, center(space).y);
  const around = await article(page).evaluate((el, token) => {
    const text = el.textContent ?? "";
    const i = text.indexOf(token) + token.length;
    return [text.slice(i - 1, i + 63), text.slice(i + 1, i + 65)];
  }, left);
  await expect
    .poll(() => around.includes(saves.at(-1)?.clicked?.text?.highlight ?? ""))
    .toBe(true);
  expect(await scrolled(), "no click turns the spread").toBe(spread);
});

test("a click after a short line marks it, and paragraph spacing marks the nearer line", async ({
  page,
}) => {
  await openBook(page);
  const saves = positionSaves(page);
  await turnTo(page, "#short");
  const short = await charBox(page, "Short line.");
  await page.mouse.click(short.right + 200, center(short).y);
  await expect
    .poll(() => saves.at(-1)?.clicked?.text?.highlight ?? "")
    .toMatch(/^\.\s*K\d{3}/);

  // Just below the short line and just above the next line.
  const next = await article(page).evaluate((el) => {
    const p = el.querySelector("#short")?.nextElementSibling;
    return p?.textContent?.slice(0, 4) ?? "";
  });
  const nextBox = await charBox(page, next);
  const between = (short.bottom + nextBox.top) / 2;
  expect(nextBox.top - short.bottom, "a gap between the lines").toBeGreaterThan(
    2,
  );
  await page.mouse.click(
    short.left + 2,
    between - (between - short.bottom) / 2,
  );
  await expect
    .poll(() => saves.at(-1)?.clicked?.text?.highlight ?? "")
    .toMatch(/^\.\s*K\d{3}/);
  await page.mouse.click(short.left + 2, between + (nextBox.top - between) / 2);
  await expect
    .poll(() => saves.at(-1)?.clicked?.text?.highlight ?? "")
    .toMatch(new RegExp(`^${next}`));
});

test("clicks above the first line, below the last, beside a picture, on a link, with a modifier or another button mark nothing", async ({
  page,
}) => {
  await openBook(page);
  const saves = positionSaves(page);
  const first = await tokenOnPage(page, 0);
  const firstBox = await charBox(page, first);
  await page.mouse.click(center(firstBox).x, center(firstBox).y);
  const before = await settledState(page, saves);
  const { article: a, pages } = await spreadBoxes(page);

  await page.mouse.click(pages[0].left + 40, a.top + 1);
  await expectNothingStored(
    page,
    saves,
    before,
    "a click above the first line",
  );

  const lowest = await article(page).evaluate((el, right) => {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const range = document.createRange();
    let bottom = 0;
    for (let n = walker.nextNode() as Text | null; n; ) {
      for (let i = 0; i < n.length; i++) {
        range.setStart(n, i);
        range.setEnd(n, i + 1);
        const r = range.getBoundingClientRect();
        if (r.right <= right && r.width > 0) {
          bottom = Math.max(bottom, r.bottom);
        }
      }
      n = walker.nextNode() as Text | null;
    }
    return bottom;
  }, pages[0].right);
  if (lowest < a.bottom - 3) {
    await page.mouse.click(pages[0].left + 40, a.bottom - 2);
    await expectNothingStored(
      page,
      saves,
      before,
      "a click below the last line",
    );
  }

  for (const modifier of ["Shift", "Alt", "Control", "Meta"] as const) {
    // No caret to extend: a Shift+click that makes a selection counts as
    // one (see the Shift+click test).
    await page.evaluate(() => getSelection()?.removeAllRanges());
    await page.keyboard.down(modifier);
    await page.mouse.click(a.left - 8, center(firstBox).y + 30);
    await page.keyboard.up(modifier);
    await expectNothingStored(page, saves, before, `a ${modifier} click`);
  }
  await page.mouse.click(a.left - 8, center(firstBox).y + 30, {
    button: "middle",
  });
  await expectNothingStored(page, saves, before, "a middle click");
  await page.mouse.click(a.left - 8, center(firstBox).y + 30, {
    button: "right",
  });
  await page.keyboard.press("Escape");
  await expectNothingStored(page, saves, before, "a right click");

  // An element placed over the reading band, as an extension's popup is.
  await page.evaluate(
    ({ x, y }) => {
      const popup = document.createElement("div");
      popup.id = "extension-popup";
      popup.textContent = "A looked-up word";
      Object.assign(popup.style, {
        position: "fixed",
        left: `${x}px`,
        top: `${y}px`,
        width: "200px",
        height: "60px",
        background: "white",
        zIndex: "10",
      });
      document.body.append(popup);
    },
    { x: pages[0].left + 20, y: center(firstBox).y + 40 },
  );
  await page.locator("#extension-popup").click();
  await expectNothingStored(page, saves, before, "a click in a popup");
  await page.evaluate(() =>
    document.getElementById("extension-popup")?.remove(),
  );

  // The settings panel, a dialog.
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("heading", { name: "Reading settings" }).click();
  await expectNothingStored(page, saves, before, "a click in the settings");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);

  // A picture.
  await turnTo(page, "#picture");
  const pictureState = await settledState(page, saves);
  const picture = await page.locator("#picture img").boundingBox();
  if (!picture) {
    throw new Error("no picture");
  }
  const { article: a2 } = await spreadBoxes(page);
  const besideX =
    picture.x < (a2.left + a2.right) / 2 ? a2.left - 8 : a2.right + 8;
  await page.mouse.click(besideX, picture.y + picture.height / 2);
  await expectNothingStored(
    page,
    saves,
    pictureState,
    "a click beside a picture",
  );
  await page.mouse.click(
    picture.x + picture.width / 2,
    picture.y + picture.height / 2,
  );
  await expectNothingStored(page, saves, pictureState, "a click on a picture");
});

test("a click between two pictures in a row marks nothing", async ({
  page,
}) => {
  await openBook(page);
  const saves = positionSaves(page);
  const token = await tokenOnPage(page, 1);
  const box = await charBox(page, token);
  await page.mouse.click(center(box).x, center(box).y);
  await expect.poll(() => saves.at(-1)?.clicked).toBeTruthy();
  const state = await settledState(page, saves);

  const first = await page.locator("#pair-a img").boundingBox();
  const second = await page.locator("#pair-b img").boundingBox();
  if (!first || !second || second.y <= first.y + first.height) {
    throw new Error("the pair is not one picture above the other");
  }
  const between = {
    x: first.x + first.width / 2,
    y: (first.y + first.height + second.y) / 2,
  };
  await page.mouse.click(between.x, between.y);
  await expectNothingStored(page, saves, state, "a click between two pictures");
  const { article: a } = await spreadBoxes(page);
  await page.mouse.click(a.left - 8, between.y);
  await expectNothingStored(
    page,
    saves,
    state,
    "a click in the margin between two pictures",
  );
});

test("a link is followed and marks nothing; a named anchor without href is text", async ({
  page,
}) => {
  await openBook(page);
  const saves = positionSaves(page);
  await turnTo(page, "#linked");
  const named = await charBox(page, "a named anchor");
  await page.mouse.click(center(named).x, center(named).y);
  await expect
    .poll(() => saves.at(-1)?.clicked?.text?.highlight ?? "")
    .toMatch(/^a named anchor/);
  const state = await settledState(page, saves);

  await page.getByRole("link", { name: "the tail link" }).click();
  await expect(page).toHaveURL(/#tail$/);
  await expect.poll(() => saves.length).toBeGreaterThan(state.saves);
  await page.waitForTimeout(800);
  expect(
    saves.at(-1)?.clicked,
    "the link's arrival has no clicked character",
  ).toBeUndefined();
  await expectMarkBeside(page, await spreadStartBox(page), "left");
});

// Drags the mouse from one point to another, as a selection is made.
async function drag(
  page: Page,
  from: { x: number; y: number },
  to: { x: number; y: number },
) {
  await page.mouse.click(5, 5);
  // Whole pixels: a press at a fractional position did not start a
  // selection in headless Chromium.
  from = { x: Math.round(from.x), y: Math.round(from.y) };
  to = { x: Math.round(to.x), y: Math.round(to.y) };
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  // Steps of about 6 px: Chrome does not start a selection on smaller ones.
  const steps = Math.max(
    2,
    Math.round(Math.hypot(to.x - from.x, to.y - from.y) / 6),
  );
  await page.mouse.move(to.x, to.y, { steps });
  await page.mouse.up();
}

// The quote of the selection's last non-whitespace character, read from
// the browser's own selection, and whether the selection ends in whitespace.
async function selectionEnd(page: Page) {
  return article(page).evaluate((el) => {
    const selection = getSelection();
    if (!selection || selection.isCollapsed) {
      return null;
    }
    const range = selection.getRangeAt(0);
    const before = document.createRange();
    before.setStart(el, 0);
    before.setEnd(range.endContainer, range.endOffset);
    const upTo = before.toString();
    const key = upTo.search(/\S\s*$/);
    return {
      highlight: (el.textContent ?? "").slice(key, key + 64),
      trailingSpace: /\s$/.test(selection.toString()),
    };
  });
}

test("a selection marks its last non-whitespace character, dragged either way", async ({
  page,
}) => {
  await openBook(page);
  const saves = positionSaves(page);
  const left = await tokenOnPage(page, 0);
  // From inside the token's line to the start of a word further on, so the
  // selection ends with the space before that word.
  const from = await charBox(page, left, left.length + 3);
  const to = await charBox(page, left, left.length + 1);
  const later = await article(page).evaluate((el, token) => {
    const text = el.textContent ?? "";
    const i = text.indexOf(token);
    // The second space after the token's word.
    const first = text.indexOf(" ", i + token.length + 1);
    return text.indexOf(" ", first + 1) + 1 - i;
  }, left);
  const end = await charBox(page, left, later);
  expect(Math.abs(end.top - to.top), "one line").toBeLessThan(2);

  await drag(page, center(from), { x: end.left + 1, y: center(end).y });
  const forward = await selectionEnd(page);
  expect(forward?.trailingSpace, "the selection ends in a space").toBe(true);
  await expect
    .poll(() => saves.at(-1)?.clicked?.text?.highlight)
    .toBe(forward?.highlight);

  // Backward: from the right page back into the left page.
  const right = await tokenOnPage(page, 1);
  const rightFrom = await charBox(page, right, right.length + 3);
  await drag(page, center(rightFrom), center(from));
  const backward = await selectionEnd(page);
  await expect
    .poll(() => saves.at(-1)?.clicked?.text?.highlight)
    .toBe(backward?.highlight);
  await expectMarkBeside(
    page,
    await lineEndBox(page, backward?.highlight ?? ""),
    "right",
  );
});

// The box of the character a quote starts at.
async function lineEndBox(page: Page, quote: string): Promise<Box> {
  const box = await article(page).evaluate((el, quote) => {
    const text = el.textContent ?? "";
    let key = text.indexOf(quote);
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode() as Text | null; n; ) {
      if (key < n.length) {
        const range = document.createRange();
        range.setStart(n, key);
        range.setEnd(n, key + 1);
        const r = range.getBoundingClientRect();
        return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
      }
      key -= n.length;
      n = walker.nextNode() as Text | null;
    }
    return null;
  }, quote);
  if (!box) {
    throw new Error("quote not found");
  }
  return box;
}

test("a double-click marks the selected word's last character", async ({
  page,
}) => {
  await openBook(page);
  const saves = positionSaves(page);
  const token = await tokenOnPage(page, 0);
  // The word after the token, double-clicked on its first character.
  const word = await charBox(page, token, token.length + 1);
  await page.mouse.dblclick(center(word).x, center(word).y);
  const expected = await article(page).evaluate((el, token) => {
    const text = el.textContent ?? "";
    const start = text.indexOf(token) + token.length + 1;
    const end = text.slice(start).search(/[\s.]/) + start - 1;
    return text.slice(end, end + 64);
  }, token);
  await expect
    .poll(() => saves.at(-1)?.clicked?.text?.highlight)
    .toBe(expected);
});

test("Select All marks nothing, and a selection collapsed on an unmarkable place keeps the clicked character", async ({
  page,
}) => {
  await openBook(page);
  const saves = positionSaves(page);
  const token = await tokenOnPage(page, 1);
  const box = await charBox(page, token);
  await page.mouse.click(center(box).x, center(box).y);
  const before = await settledState(page, saves);

  await page.keyboard.press("ControlOrMeta+a");
  const { article: a, pages } = await spreadBoxes(page);
  // A click above the first line collapses the selection and marks nothing.
  await page.mouse.click(pages[0].left + 40, a.top + 1);
  await expectNothingStored(
    page,
    saves,
    before,
    "Select All then a click above the text",
  );

  await page.keyboard.press("ControlOrMeta+a");
  // A click outside the reading band (the book title).
  await page.getByRole("heading", { name: title }).click();
  await expectNothingStored(
    page,
    saves,
    before,
    "Select All then a click on the title",
  );
});

test("clicking the same character again, or beside its line on either side, saves nothing new", async ({
  page,
}) => {
  await openBook(page);
  const saves = positionSaves(page);
  const { article: a } = await spreadBoxes(page);
  const token = await tokenOnPage(page, 0);
  const box = await charBox(page, token);
  await page.mouse.click(a.left - 8, center(box).y);
  const before = await settledState(page, saves);
  await page.mouse.click(a.left - 8, center(box).y);
  await expectNothingStored(page, saves, before, "the same margin click");
  // The left margin and the gap's left half both mean the line's last
  // character.
  const { pages, gap } = await spreadBoxes(page);
  await page.mouse.click(pages[0].right + gap / 4, center(box).y);
  await expectNothingStored(
    page,
    saves,
    before,
    "the gap beside the same line",
  );
});

// The line-end box of the shown spread's first line.
async function spreadStartBox(page: Page): Promise<Box> {
  const quote = await article(page).evaluate((el) => {
    const a = el.getBoundingClientRect();
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const range = document.createRange();
    let key = 0;
    for (let n = walker.nextNode() as Text | null; n; ) {
      for (let i = 0; i < n.length; i++) {
        if (/\s/.test(n.data[i])) continue;
        range.setStart(n, i);
        range.setEnd(n, i + 1);
        const r = range.getBoundingClientRect();
        if (r.left >= a.left - 1 && r.left < a.right && r.width > 0) {
          return (el.textContent ?? "").slice(key + i, key + i + 64);
        }
      }
      key += n.length;
      n = walker.nextNode() as Text | null;
    }
    return "";
  });
  return lineEndBox(page, quote);
}

test("a turn, a contents entry and an outside scroll clear the clicked character and move the mark to the spread start", async ({
  page,
}) => {
  await openBook(page);
  const saves = positionSaves(page);
  const token = await tokenOnPage(page, 1);
  const box = await charBox(page, token);
  await page.mouse.click(center(box).x, center(box).y);
  await expect.poll(() => saves.at(-1)?.clicked).toBeTruthy();

  await page.getByRole("button", { name: "Next" }).click();
  await expectMarkBeside(page, await spreadStartBox(page), "left");
  await expect.poll(() => saves.at(-1)?.clicked).toBeUndefined();

  // An outside scroll (find-in-page, scrollIntoView) is aligned and clears it.
  const again = await tokenOnPage(page, 1);
  const againBox = await charBox(page, again);
  await page.mouse.click(center(againBox).x, center(againBox).y);
  await expect
    .poll(() => saves.at(-1)?.clicked?.text?.highlight ?? "")
    .toMatch(new RegExp(`^${again}`));
  await page.evaluate(() => document.querySelector("#tail")?.scrollIntoView());
  await expect.poll(() => saves.at(-1)?.clicked).toBeUndefined();
  await expectMarkBeside(page, await spreadStartBox(page), "left");

  // A contents entry.
  const third = await tokenOnPage(page, 0);
  const thirdBox = await charBox(page, third);
  await page.mouse.click(center(thirdBox).x, center(thirdBox).y);
  await expect.poll(() => saves.at(-1)?.clicked).toBeTruthy();
  await page.getByRole("button", { name: "Contents" }).click();
  await page.getByRole("link", { name: "The Tail", exact: true }).click();
  await expect(page).toHaveURL(/#tail$/);
  await expect.poll(() => saves.at(-1)?.clicked).toBeUndefined();
});

// Where a quote's first character shows: whether it is on the shown spread,
// and how many lines are above its line on its page (a picture counts as a
// line).
async function placeOf(page: Page, quote: string) {
  return article(page).evaluate((el, quote) => {
    const a = el.getBoundingClientRect();
    const text = el.textContent ?? "";
    let key = text.indexOf(quote);
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const range = document.createRange();
    let target: DOMRect | null = null;
    for (let n = walker.nextNode() as Text | null; n && !target; ) {
      if (key < n.length) {
        range.setStart(n, key);
        range.setEnd(n, key + 1);
        target = range.getBoundingClientRect();
      }
      key -= n.length;
      n = walker.nextNode() as Text | null;
    }
    if (!target) {
      return null;
    }
    const t = target;
    const onSpread =
      t.left >= a.left - 1 &&
      t.right <= a.right + 1 &&
      t.top >= a.top - 1 &&
      t.bottom <= a.bottom + 1;
    // The page holding it: the same column band.
    const style = getComputedStyle(el);
    const pageWidth = Number.parseFloat(
      style.getPropertyValue("--reading-page-width"),
    );
    const gap = Number.parseFloat(
      style.getPropertyValue("--reading-column-gap"),
    );
    const pageIndex = Math.floor((t.left - a.left) / (pageWidth + gap));
    const left = a.left + pageIndex * (pageWidth + gap);
    const right = left + pageWidth;
    const tops = new Set<number>();
    const all = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n = all.nextNode() as Text | null; n; ) {
      for (let i = 0; i < n.length; i++) {
        if (/\s/.test(n.data[i])) continue;
        range.setStart(n, i);
        range.setEnd(n, i + 1);
        const r = range.getBoundingClientRect();
        if (
          r.width > 0 &&
          r.left >= left - 1 &&
          r.right <= right + 1 &&
          r.top >= a.top - 1 &&
          r.bottom <= t.top + 1 &&
          r.top < t.top - 2
        ) {
          tops.add(Math.round(r.top));
        }
      }
      n = all.nextNode() as Text | null;
    }
    // Lines whose tops differ by a pixel or two are one line.
    const sorted = [...tops].sort((x, y) => x - y);
    let lines = 0;
    let last = Number.NEGATIVE_INFINITY;
    for (const top of sorted) {
      if (top - last > 3) {
        lines++;
      }
      last = top;
    }
    for (const img of el.querySelectorAll("img")) {
      const r = img.getBoundingClientRect();
      if (
        r.left >= left - 1 &&
        r.right <= right + 1 &&
        r.bottom <= t.top + 1 &&
        r.top >= a.top - 1
      ) {
        lines++;
      }
    }
    return {
      onSpread,
      linesAbove: lines,
      page: pageIndex,
      box: { left: t.left, right: t.right, top: t.top, bottom: t.bottom },
    };
  }, quote);
}

// The quote of the first character of the shown spread.
async function spreadStartQuote(page: Page) {
  return article(page).evaluate((el) => {
    const a = el.getBoundingClientRect();
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const range = document.createRange();
    let key = 0;
    for (let n = walker.nextNode() as Text | null; n; ) {
      for (let i = 0; i < n.length; i++) {
        if (/\s/.test(n.data[i])) continue;
        range.setStart(n, i);
        range.setEnd(n, i + 1);
        const r = range.getBoundingClientRect();
        if (
          r.width > 0 &&
          r.left >= a.left - 1 &&
          r.right <= a.right + 1 &&
          r.top >= a.top - 1
        ) {
          return (el.textContent ?? "").slice(key + i, key + i + 64);
        }
      }
      key += n.length;
      n = walker.nextNode() as Text | null;
    }
    return "";
  });
}

test("on a one-page spread there is one mark, left of the page, beside the spread start and then the clicked line", async ({
  page,
}) => {
  await openBook(page, {}, { width: 700, height: 800 });
  const { pages } = await spreadBoxes(page);
  expect(pages, "one page").toHaveLength(1);
  await page.getByRole("button", { name: "Next" }).click();
  await expect(mark(page)).toHaveCount(1);
  await expectMarkBeside(page, await spreadStartBox(page), "left");

  const token = await tokenOnPage(page, 0);
  const box = await charBox(page, token);
  await page.mouse.click(center(box).x, center(box).y);
  await expectMarkBeside(page, box, "left");
  await expect(mark(page)).toHaveCount(1);
});

test("a resize that keeps the clicked line on the spread keeps the spread start", async ({
  page,
}) => {
  await openBook(page);
  await page.getByRole("button", { name: "Next" }).click();
  const token = await tokenOnPage(page, 0);
  const box = await charBox(page, token);
  await page.mouse.click(center(box).x, center(box).y);
  await page.waitForTimeout(800);
  const start = await spreadStartQuote(page);
  await page.setViewportSize({ width: 1270, height: 780 });
  await expect.poll(() => spreadStartQuote(page)).toBe(start);
  const quote = (await lineEndBox(page, token)) && token;
  expect((await placeOf(page, quote))?.onSpread).toBe(true);
});

for (const repeated of [0, 1, 3]) {
  test(`two pages to one after clicking the right page keeps the clicked line with ${repeated} lines above it, and saves nothing`, async ({
    page,
  }) => {
    await openBook(page, { repeatedLines: repeated });
    const saves = positionSaves(page);
    await page.getByRole("button", { name: "Next" }).click();
    const token = await tokenOnPage(page, 1);
    const box = await charBox(page, token);
    await page.mouse.click(center(box).x, center(box).y);
    await expect
      .poll(() => saves.at(-1)?.clicked?.text?.highlight ?? "")
      .toMatch(new RegExp(`^${token}`));
    await page.waitForTimeout(800);
    const count = saves.length;

    await page.setViewportSize({ width: 900, height: 800 });
    await expect
      .poll(async () => {
        const place = await placeOf(page, token);
        return (
          place && { onSpread: place.onSpread, linesAbove: place.linesAbove }
        );
      })
      .toEqual({ onSpread: true, linesAbove: repeated });
    const place = await placeOf(page, token);
    await expectMarkBeside(page, place?.box ?? box, "left");
    await page.waitForTimeout(800);
    expect(saves.length, "re-layout saved a position").toBe(count);
  });
}

test("when a page-tall picture before the clicked line would hide it, the spread start steps forward to show it", async ({
  page,
}) => {
  await openBook(page);
  await turnTo(page, "#after-tall");
  const line = await charBox(page, "Right after the tall picture");
  await page.mouse.click(center(line).x, center(line).y);
  await page.waitForTimeout(800);
  await page.setViewportSize({ width: 900, height: 800 });
  await expect
    .poll(
      async () =>
        (await placeOf(page, "Right after the tall picture"))?.onSpread,
    )
    .toBe(true);
});

test("reopening the book restores the clicked line and its mark, at the same width and narrower", async ({
  page,
}) => {
  const id = await openBook(page);
  const saves = positionSaves(page);
  await page.getByRole("button", { name: "Next" }).click();
  const token = await tokenOnPage(page, 1);
  const box = await charBox(page, token);
  await page.mouse.click(center(box).x, center(box).y);
  await expect
    .poll(() => saves.at(-1)?.clicked?.text?.highlight ?? "")
    .toMatch(new RegExp(`^${token}`));
  await page.waitForTimeout(800);
  const start = await spreadStartQuote(page);

  await page.goto("/");
  await page.goto(`/books/${id}/read`);
  await expect(article(page)).toContainText("Clicked Lines");
  await expect.poll(() => spreadStartQuote(page)).toBe(start);
  await expectMarkBeside(page, await charBox(page, token), "right");

  await page.setViewportSize({ width: 900, height: 800 });
  await page.goto("/");
  await page.goto(`/books/${id}/read`);
  await expect(article(page)).toContainText("Clicked Lines");
  await expect
    .poll(async () => {
      const place = await placeOf(page, token);
      return (
        place && { onSpread: place.onSpread, linesAbove: place.linesAbove }
      );
    })
    .toEqual({ onSpread: true, linesAbove: 1 });
  await expectMarkBeside(page, await charBox(page, token), "left");
});

test("a clicked character that does not resolve leaves the spread start and its mark", async ({
  page,
}) => {
  const id = await openBook(page);
  await page.getByRole("button", { name: "Next" }).click();
  await page.waitForTimeout(800);
  const start = await spreadStartQuote(page);
  const href = await page.evaluate(async (id) => {
    const res = await fetch(`/api/books/${id}/position`);
    return (await res.json()).href as string;
  }, id);
  const put = await page.request.put(`/api/books/${id}/position`, {
    data: {
      tabId: "elsewhere",
      sequence: 1,
      href,
      locations: { progression: 0.2 },
      text: { highlight: start },
      clicked: {
        cssSelector: '[data-tomeshelf-block="9999"]',
        characterOffset: 3,
        text: { highlight: "words this book does not have" },
      },
    },
  });
  expect(put.status()).toBe(204);
  await page.goto("/");
  await page.goto(`/books/${id}/read`);
  await expect.poll(() => spreadStartQuote(page)).toBe(start);
  await expectMarkBeside(page, await lineEndBox(page, start), "left");
});

test("in a table a margin click marks the row's last character, and in a pre the mark sits at the clicked line's height", async ({
  page,
}) => {
  await openBook(page);
  const saves = positionSaves(page);
  await turnTo(page, "#grid");
  const row = await charBox(page, "Row 2 first cell");
  const rowEnd = await lineEnd(page, "Row 2 first cell");
  expect(rowEnd?.highlight).toMatch(/^l\s*Row 3/);
  const { article: a } = await spreadBoxes(page);
  const side = row.left < (a.left + a.right) / 2 ? "left" : "right";
  await page.mouse.click(
    side === "left" ? a.left - 8 : a.right + 8,
    center(row).y,
  );
  await expect
    .poll(() => saves.at(-1)?.clicked?.text?.highlight)
    .toBe(rowEnd?.highlight);
  await expectMarkBeside(page, row, side);

  await turnTo(page, "#code");
  const second = await charBox(page, "second pre line");
  await page.mouse.click(center(second).x, center(second).y);
  await expect
    .poll(() => saves.at(-1)?.clicked?.text?.highlight ?? "")
    .toMatch(/^second pre line/);
  const { article: b } = await spreadBoxes(page);
  const preSide = second.left < (b.left + b.right) / 2 ? "left" : "right";
  await expectMarkBeside(page, second, preSide);
});

// The quote of the last non-whitespace character of a pre's visual line at
// height y that its box shows, clipped overflow left out.
async function shownLineEnd(page: Page, selector: string, y: number) {
  return article(page).evaluate(
    (el, { selector, y }) => {
      const pre = el.querySelector(selector);
      if (!pre) {
        return null;
      }
      const clip = pre.getBoundingClientRect();
      const range = document.createRange();
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      let key = 0;
      let last: number | null = null;
      for (let n = walker.nextNode() as Text | null; n; ) {
        if (pre.contains(n)) {
          for (let i = 0; i < n.length; i++) {
            if (/\s/.test(n.data[i])) {
              continue;
            }
            range.setStart(n, i);
            range.setEnd(n, i + 1);
            const r = range.getBoundingClientRect();
            if (
              y >= r.top &&
              y <= r.bottom &&
              r.right > clip.left &&
              r.left < clip.right
            ) {
              last = key + i;
            }
          }
        }
        key += n.length;
        n = walker.nextNode() as Text | null;
      }
      return last === null
        ? null
        : (el.textContent ?? "").slice(last, last + 64);
    },
    { selector, y },
  );
}

test("beside a pre line wider than the page, a click marks the last character its box shows, scrolled or not", async ({
  page,
}) => {
  await openBook(page);
  const saves = positionSaves(page);
  await turnTo(page, "#code");
  const wide = await charBox(page, "third pre line");
  const y = center(wide).y;
  const { article: a, pages, gap } = await spreadBoxes(page);
  const onLeft = wide.left < pages[0].right;
  const outer = onLeft ? a.left - 8 : a.right + 8;
  const inner = onLeft ? pages[0].right + gap / 4 : pages[1].left - gap / 4;

  // The highlight of the latest save once there are more than count.
  const savedAfter = (count: number) => () =>
    saves.length > count
      ? saves.at(-1)?.clicked?.text?.highlight
      : "(no save yet)";

  const shown = await shownLineEnd(page, "#code", y);
  expect(shown, "the line overflows its box").not.toMatch(/^x\s/);
  let count = saves.length;
  await page.mouse.click(outer, y);
  await expect.poll(savedAfter(count)).toBe(shown);
  count = saves.length;
  await page.mouse.click(center(wide).x, center(wide).y);
  await expect.poll(savedAfter(count)).toMatch(/^third pre line/);
  count = saves.length;
  await page.mouse.click(inner, y);
  await expect.poll(savedAfter(count)).toBe(shown);

  // Scrolled sideways, the box shows a later part of the line.
  await page.locator("#code").evaluate((el) => {
    el.scrollLeft = 160;
  });
  const scrolled = await shownLineEnd(page, "#code", y);
  expect(scrolled).not.toBe(shown);
  count = saves.length;
  await page.mouse.click(outer, y);
  await expect.poll(savedAfter(count)).toBe(scrolled);
});

test("a Shift+click that extends a selection marks the selection's last character", async ({
  page,
}) => {
  await openBook(page);
  const saves = positionSaves(page);
  const token = await tokenOnPage(page, 0);
  const from = await charBox(page, token);
  await page.mouse.click(Math.round(from.left) + 1, Math.round(center(from).y));
  const next = `K${String(Number(token.slice(1)) + 1).padStart(3, "0")}`;
  const to = await charBox(page, next, 2);
  await page.keyboard.down("Shift");
  await page.mouse.click(Math.round(to.right) - 1, Math.round(center(to).y));
  await page.keyboard.up("Shift");
  const end = await selectionEnd(page);
  expect(end, "Shift+click made a selection").not.toBeNull();
  await expect
    .poll(() => saves.at(-1)?.clicked?.text?.highlight)
    .toBe(end?.highlight);
});

test("a press inside a popup released just outside it marks nothing", async ({
  page,
}) => {
  await openBook(page);
  const saves = positionSaves(page);
  const token = await tokenOnPage(page, 1);
  const box = await charBox(page, token);
  await page.mouse.click(center(box).x, center(box).y);
  await expect.poll(() => saves.at(-1)?.clicked).toBeTruthy();
  const state = await settledState(page, saves);

  const { pages } = await spreadBoxes(page);
  // Over the right page's text, below the clicked line.
  const popup = {
    x: Math.round(pages[1].left + 80),
    y: Math.round(box.bottom + 150),
  };
  await page.evaluate(({ x, y }) => {
    const el = document.createElement("div");
    el.id = "extension-popup";
    el.textContent = "A looked-up word";
    Object.assign(el.style, {
      position: "fixed",
      left: `${x}px`,
      top: `${y}px`,
      width: "200px",
      height: "60px",
      background: "white",
      zIndex: "10",
      // A press that moves inside it selects nothing, as in most popups.
      userSelect: "none",
    });
    document.body.append(el);
  }, popup);
  await page.mouse.move(popup.x + 2, popup.y + 30);
  await page.mouse.down();
  await page.mouse.move(popup.x - 2, popup.y + 30);
  await page.mouse.up();
  await expectNothingStored(
    page,
    saves,
    state,
    "a press in a popup released beside it",
  );
});

// The quote of the last non-whitespace character of the element's text
// whose box overlaps the band from top to bottom: the end of a visual line.
async function bandEnd(
  page: Page,
  selector: string,
  band: { top: number; bottom: number },
) {
  return article(page).evaluate(
    (el, { selector, band }) => {
      const block = el.querySelector(selector);
      const range = document.createRange();
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      let key = 0;
      let last: number | null = null;
      for (let n = walker.nextNode() as Text | null; n; ) {
        if (block?.contains(n)) {
          for (let i = 0; i < n.length; i++) {
            if (/\s/.test(n.data[i])) {
              continue;
            }
            range.setStart(n, i);
            range.setEnd(n, i + 1);
            const r = range.getBoundingClientRect();
            if (r.top < band.bottom - 2 && r.bottom > band.top + 2) {
              last = key + i;
            }
          }
        }
        key += n.length;
        n = walker.nextNode() as Text | null;
      }
      return last === null
        ? null
        : (el.textContent ?? "").slice(last, last + 64);
    },
    { selector, band },
  );
}

test("level with a floated picture, a margin click marks the text line beside it", async ({
  page,
}) => {
  const id = await openBook(page);
  await page.goto(`/books/${id}/read/2`);
  await expect(article(page)).toContainText("The End");
  const saves = positionSaves(page);
  const { article: a } = await spreadBoxes(page);

  // A floated picture beside several lines: level with the second line.
  const picture = await page.locator("#floated img").boundingBox();
  const second = await article(page).evaluate((el) => {
    const p = el.querySelector("#floated");
    const range = document.createRange();
    const tops: { top: number; bottom: number }[] = [];
    const walker = document.createTreeWalker(p ?? el, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode() as Text | null; n; ) {
      for (let i = 0; i < n.length; i++) {
        range.setStart(n, i);
        range.setEnd(n, i + 1);
        const r = range.getBoundingClientRect();
        if (r.height > 0 && !tops.some((t) => Math.abs(t.top - r.top) < 2)) {
          tops.push({ top: r.top, bottom: r.bottom });
        }
      }
      n = walker.nextNode() as Text | null;
    }
    return tops[1] ?? null;
  });
  if (!picture || !second || second.bottom > picture.y + picture.height) {
    throw new Error("the second line is not beside the picture");
  }
  const secondEnd = await bandEnd(page, "#floated", second);
  const count = saves.length;
  await page.mouse.click(a.left - 8, (second.top + second.bottom) / 2);
  await expect
    .poll(() =>
      saves.length > count ? saves.at(-1)?.clicked?.text?.highlight : null,
    )
    .toBe(secondEnd);
});

test("a drag selection is read at release, with no click after it", async ({
  page,
}) => {
  await openBook(page);
  const saves = positionSaves(page);
  // A release outside the window sends no click. Headless Chromium cannot
  // release outside it, so a listener that runs first swallows the click.
  await page.evaluate(() =>
    window.addEventListener("click", (e) => e.stopImmediatePropagation(), {
      capture: true,
    }),
  );
  const token = await tokenOnPage(page, 0);
  const from = await charBox(page, token);
  const to = await charBox(page, token, 3);
  await drag(page, center(from), { x: to.right + 30, y: center(to).y });
  const end = await selectionEnd(page);
  expect(end, "the drag made a selection").not.toBeNull();
  await expect
    .poll(() => saves.at(-1)?.clicked?.text?.highlight)
    .toBe(end?.highlight);
});

test("a selection made without the pointer marks nothing", async ({ page }) => {
  await openBook(page);
  const saves = positionSaves(page);
  const token = await tokenOnPage(page, 0);
  const box = await charBox(page, token);
  await page.mouse.click(center(box).x, center(box).y);
  await expect.poll(() => saves.at(-1)?.clicked).toBeTruthy();
  const state = await settledState(page, saves);
  // As the keyboard or a script selects: no press, no release. Read-only
  // text has no caret for Shift+arrow keys, so the Selection API stands in.
  await article(page).evaluate((el, token) => {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode() as Text | null; n; ) {
      const i = n.data.indexOf(token);
      if (i >= 0) {
        getSelection()?.setBaseAndExtent(n, i, n, Math.min(n.length, i + 40));
        return;
      }
      n = walker.nextNode() as Text | null;
    }
  }, token);
  expect(await selectionEnd(page), "a selection was made").not.toBeNull();
  await expectNothingStored(
    page,
    saves,
    state,
    "a selection made without the pointer",
  );
});

test("on a spread whose right page is empty, clicks on that page or its margin mark nothing", async ({
  page,
}) => {
  const id = await openBook(page);
  await page.goto(`/books/${id}/read/2`);
  await expect(article(page)).toContainText("The End");
  const saves = positionSaves(page);
  const { article: a, pages } = await spreadBoxes(page);
  expect(pages).toHaveLength(2);
  const end = await charBox(page, "The last short");
  await page.mouse.click(center(end).x, center(end).y);
  await expect.poll(() => saves.at(-1)?.clicked).toBeTruthy();
  const before = await settledState(page, saves);
  await page.mouse.click((pages[1].left + pages[1].right) / 2, center(end).y);
  await expectNothingStored(
    page,
    saves,
    before,
    "a click on the empty right page",
  );
  await page.mouse.click(a.right + 8, center(end).y);
  await expectNothingStored(
    page,
    saves,
    before,
    "a click in the empty page's margin",
  );
});

test("a lookup extension that stops the click and prevents its default does not hide it", async ({
  page,
}) => {
  await openBook(page);
  const saves = positionSaves(page);
  await article(page).evaluate((el) => {
    for (const type of ["mousedown", "mouseup", "click"]) {
      el.addEventListener(type, (event) => {
        event.preventDefault();
        event.stopPropagation();
      });
    }
  });
  const token = await tokenOnPage(page, 1);
  const box = await charBox(page, token);
  await page.mouse.click(center(box).x, center(box).y);
  await expect
    .poll(() => saves.at(-1)?.clicked?.text?.highlight ?? "")
    .toMatch(new RegExp(`^${token}`));
  await expectMarkBeside(page, box, "right");
});

test("at the two-page breakpoint the mark fits the margin, and it keeps 3:1 contrast in every theme", async ({
  page,
}) => {
  // 2 × 38rem pages + the gap, plus main's 16 px padding on each side.
  await openBook(page, {}, { width: 2 * 608 + 24 + 32, height: 800 });
  const { article: a, pages } = await spreadBoxes(page);
  expect(pages, "two pages at the breakpoint").toHaveLength(2);
  for (const index of [0, 1] as const) {
    const token = await tokenOnPage(page, index);
    const box = await charBox(page, token);
    await page.mouse.click(center(box).x, center(box).y);
    await expectMarkBeside(page, box, index === 0 ? "left" : "right");
    const m = await markBox(page);
    expect(m.left, "inside the window").toBeGreaterThanOrEqual(0);
    expect(m.right, "inside the window").toBeLessThanOrEqual(2 * 608 + 24 + 32);
    expect(
      index === 0 ? m.right <= a.left : m.left >= a.right,
      "covers no text",
    ).toBe(true);
  }

  for (const theme of ["light", "sepia", "dark"] as const) {
    await saveSettings(page, { theme });
    await page.reload();
    await expect(mark(page)).toBeVisible();
    const ratio = await mark(page).evaluate((el) => {
      // Any CSS colour (Tailwind's are oklch) as sRGB, through a canvas.
      const canvas = document.createElement("canvas").getContext("2d");
      const parse = (c: string) => {
        if (!canvas) {
          return [0, 0, 0];
        }
        canvas.clearRect(0, 0, 1, 1);
        canvas.fillStyle = c;
        canvas.fillRect(0, 0, 1, 1);
        return [...canvas.getImageData(0, 0, 1, 1).data.slice(0, 3)];
      };
      const style = getComputedStyle(el);
      const fg = parse(style.color);
      const alpha = Number(style.opacity);
      let bgEl: Element | null = el.parentElement;
      let bg = [255, 255, 255];
      while (bgEl) {
        const c = getComputedStyle(bgEl).backgroundColor;
        if (c && c !== "rgba(0, 0, 0, 0)" && c !== "transparent") {
          bg = parse(c);
          break;
        }
        bgEl = bgEl.parentElement;
      }
      const shown = fg.map((v, i) => v * alpha + bg[i] * (1 - alpha));
      const lum = (rgb: number[]) => {
        const [r, g, b] = rgb.map((v) => {
          const s = v / 255;
          return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
        });
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
      };
      const l1 = lum(shown);
      const l2 = lum(bg);
      return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
    });
    expect(ratio, `contrast in ${theme}`).toBeGreaterThanOrEqual(3);
  }
});

test("the scroll layout stores no clicked character, shows no mark and ignores a stored one", async ({
  page,
}) => {
  const id = await openBook(page, { layout: "scroll" });
  const saves = positionSaves(page);
  const word = await charBox(page, "K003");
  await page.mouse.click(center(word).x, center(word).y);
  await page.mouse.wheel(0, 600);
  await expect.poll(() => saves.length).toBeGreaterThan(0);
  expect(saves.at(-1)?.clicked).toBeUndefined();
  await expect(mark(page)).toHaveCount(0);

  const stored = saves.at(-1) as Saved;
  const put = await page.request.put(`/api/books/${id}/position`, {
    data: {
      tabId: "elsewhere",
      sequence: 1,
      href: stored.href,
      locations: stored.locations,
      text: stored.text,
      clicked: { text: { highlight: "K020" } },
    },
  });
  expect(put.status()).toBe(204);
  await page.goto("/");
  await page.goto(`/books/${id}/read`);
  await expect(article(page)).toContainText("Clicked Lines");
  await expect(mark(page)).toHaveCount(0);
  await page.mouse.wheel(0, 400);
  await expect
    .poll(() => saves.at(-1)?.clicked === undefined && saves.length > 1)
    .toBe(true);
});
