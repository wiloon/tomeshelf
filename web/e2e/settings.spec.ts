import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  type APIRequestContext,
  test as base,
  expect,
  type Page,
  type Request,
  type Route,
} from "@playwright/test";
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
const title = "A Hand-Made Book of Semantics";

// The semantics fixture's documents, by their position in the reading order.
const documents = {
  poetry: { n: 1, text: "The Owl and the Pussy-cat went to sea" },
  letter: { n: 2, text: "My dear Lanyon," },
  epigraph: { n: 3, text: "Something will come of this." },
  dedication: { n: 4, text: "To the reader who reads to the end." },
  common: { n: 5, text: "Common Elements" },
  long: { n: 6, text: "Long document paragraph 80." },
  short: { n: 7, text: "Short document paragraph 12." },
};

// Creates the admin, imports the semantics fixture and returns its book id.
async function importSemantics(page: Page): Promise<string> {
  const setup = await page.request.post("/api/setup", {
    data: { username: "reader", password: "reader password" },
  });
  expect(setup.status()).toBe(201);
  await page.goto("/");
  await page
    .getByLabel("Import an EPUB")
    .setInputFiles(path.join(books, "semantics.epub"));
  await expect(page.getByRole("status")).toHaveText(`Imported ${title}.`);
  const settingsLoaded = page.waitForResponse((res) =>
    isSettings(res.request(), "GET"),
  );
  await page.getByRole("link", { name: new RegExp(title) }).click();
  await expect(page).toHaveURL(/\/books\/\d+\/read\/1$/);
  await expect(article(page)).toContainText(documents.poetry.text);
  await settingsLoaded;
  return new URL(page.url()).pathname.split("/")[2];
}

async function openDocument(
  page: Page,
  id: string,
  doc: { n: number; text: string },
) {
  await page.goto(`/books/${id}/read/${doc.n}`);
  await expect(article(page)).toContainText(doc.text);
}

function article(page: Page) {
  return page.locator("article#tomeshelf-content");
}

type Rect = { left: number; right: number; top: number; bottom: number };

// The boxes of the element's text, one per line it covers.
async function textLines(page: Page, selector: string): Promise<Rect[]> {
  return page.locator(selector).evaluate((el) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    const lines: Rect[] = [];
    for (const r of range.getClientRects()) {
      if (r.width === 0) {
        continue;
      }
      const line = lines.find((l) => Math.abs(l.top - r.top) < 1);
      if (line) {
        line.left = Math.min(line.left, r.left);
        line.right = Math.max(line.right, r.right);
      } else {
        lines.push({
          left: r.left,
          right: r.right,
          top: r.top,
          bottom: r.bottom,
        });
      }
    }
    return lines;
  });
}

async function box(page: Page, selector: string): Promise<Rect> {
  return page
    .locator(selector)
    .evaluate((el) => el.getBoundingClientRect().toJSON() as Rect);
}

async function fontSize(page: Page, selector: string): Promise<number> {
  return page
    .locator(selector)
    .evaluate((el) => Number.parseFloat(getComputedStyle(el).fontSize));
}

test("the typography styles headings, emphasis, quotes, lists, tables and figures", async ({
  page,
}) => {
  const id = await importSemantics(page);
  for (const width of [375, 1280]) {
    await page.setViewportSize({ width, height: 800 });
    await openDocument(page, id, documents.common);
    const at = `at ${width} px`;
    const text = await box(page, "article#tomeshelf-content");
    const body = await fontSize(page, "#emphasis");

    const styles = await page.evaluate(() => {
      const style = (selector: string) => {
        const el = document.querySelector(`#tomeshelf-content ${selector}`);
        return el ? getComputedStyle(el) : null;
      };
      return {
        h1: Number.parseFloat(style("h1")?.fontSize ?? "0"),
        h2: Number.parseFloat(style("h2")?.fontSize ?? "0"),
        h1Weight: Number(style("h1")?.fontWeight),
        em: style("em")?.fontStyle,
        i: style("i")?.fontStyle,
        strong: Number(style("strong")?.fontWeight),
        b: Number(style("b")?.fontWeight),
        bullets: style("#bullets")?.listStyleType,
        numbers: style("#numbers")?.listStyleType,
        cellPadding: Number.parseFloat(style("td")?.paddingInlineStart ?? "0"),
        overflow: document.documentElement.scrollWidth - window.innerWidth,
      };
    });
    expect(styles.h1, at).toBeGreaterThan(styles.h2);
    expect(styles.h2, at).toBeGreaterThan(body);
    expect(styles.h1Weight, at).toBeGreaterThanOrEqual(600);
    expect([styles.em, styles.i], at).toEqual(["italic", "italic"]);
    expect(styles.strong, at).toBeGreaterThanOrEqual(600);
    expect(styles.b, at).toBeGreaterThanOrEqual(600);
    expect([styles.bullets, styles.numbers], at).toEqual(["disc", "decimal"]);
    expect(styles.cellPadding, at).toBeGreaterThan(0);
    expect(styles.overflow, `page overflow ${at}`).toBe(0);

    const quote = await box(page, "#quote");
    expect(quote.left - text.left, at).toBeGreaterThanOrEqual(body);
    expect(text.right - quote.right, at).toBeGreaterThanOrEqual(body);

    const table = await page
      .locator("#wide-table")
      .evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth }));
    if (width === 375) {
      expect(table.scroll, at).toBeGreaterThan(table.client);
    }

    const figure = await box(page, "#small-figure");
    const image = await box(page, "#small-figure img");
    const caption = await box(page, "#small-figure figcaption");
    const captionText = (await textLines(page, "#small-figure figcaption"))[0];
    const middle = (r: Rect) => (r.left + r.right) / 2;
    expect(Math.abs(middle(image) - middle(figure)), at).toBeLessThan(1);
    expect(Math.abs(middle(captionText) - middle(figure)), at).toBeLessThan(1);
    expect(caption.top, at).toBeGreaterThanOrEqual(image.bottom);
    expect(await fontSize(page, "#small-figure figcaption"), at).toBeLessThan(
      body,
    );
  }
});

test("poetry keeps its line breaks, indentation and hanging lines at phone and desktop widths", async ({
  page,
}) => {
  const id = await importSemantics(page);
  for (const width of [375, 1280]) {
    await page.setViewportSize({ width, height: 800 });
    await openDocument(page, id, documents.poetry);
    const at = `at ${width} px`;
    const em = await fontSize(page, "#line-1");

    for (const container of [
      "#the-owl-and-the-pussy-cat",
      "#crossing",
      "#song",
    ]) {
      const stanzas = await page
        .locator(`${container} p`)
        .evaluateAll((ps) =>
          ps.map((p) => p.querySelectorAll(":scope > span").length),
        );
      for (const [s, count] of stanzas.entries()) {
        let previous: Rect | null = null;
        for (let l = 1; l <= count; l++) {
          const lines = await textLines(
            page,
            `${container} p:nth-of-type(${s + 1}) > span:nth-of-type(${l})`,
          );
          if (previous) {
            expect(
              lines[0].top,
              `${container} stanza ${s + 1} line ${l} ${at}`,
            ).toBeGreaterThanOrEqual(previous.bottom - 0.5);
          }
          previous = lines[lines.length - 1];
        }
      }
    }

    const start = (await textLines(page, "#line-1"))[0].left;
    const i1 = (await textLines(page, "#line-2"))[0].left;
    const i2 = (await textLines(page, "#line-9"))[0].left;
    expect(Math.abs(i1 - start - em), `i1 ${at}`).toBeLessThan(1);
    expect(Math.abs(i2 - start - 2 * em), `i2 ${at}`).toBeLessThan(1);

    const long = await textLines(page, "#long-line");
    expect(long.length, `the long line wraps ${at}`).toBeGreaterThan(1);
    expect(Math.abs(long[1].left - long[0].left - em), at).toBeLessThan(1);

    const stanzaEnd = await textLines(
      page,
      "#the-owl-and-the-pussy-cat p:nth-of-type(1) > span:last-of-type",
    );
    const nextStanza = await textLines(
      page,
      "#the-owl-and-the-pussy-cat p:nth-of-type(2) > span:first-of-type",
    );
    expect(
      nextStanza[0].top - stanzaEnd[stanzaEnd.length - 1].bottom,
      `blank line between stanzas ${at}`,
    ).toBeGreaterThanOrEqual(em);

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    expect(overflow, `page overflow ${at}`).toBe(0);
  }
});

test("letters, epigraphs and dedications are set apart as their semantics say", async ({
  page,
}) => {
  const id = await importSemantics(page);
  for (const width of [375, 1280]) {
    await page.setViewportSize({ width, height: 800 });
    const at = `at ${width} px`;

    await openDocument(page, id, documents.letter);
    let text = await box(page, "article#tomeshelf-content");
    let em = await fontSize(page, "#the-letter");
    const letter = await box(page, "#the-letter");
    expect(letter.left - text.left, at).toBeGreaterThanOrEqual(em);
    expect(text.right - letter.right, at).toBeGreaterThanOrEqual(em);
    const salutation = await textLines(
      page,
      "[epub\\:type~='z3998:salutation']",
    );
    const body = await textLines(page, "#the-letter > p");
    const valediction = await textLines(
      page,
      "[epub\\:type~='z3998:valediction']",
    );
    const signature = await textLines(page, "[epub\\:type~='z3998:signature']");
    expect(body[0].top, at).toBeGreaterThan(salutation[0].bottom - 0.5);
    expect(valediction[0].top, at).toBeGreaterThan(
      body[body.length - 1].bottom - 0.5,
    );
    expect(signature[0].top, at).toBeGreaterThan(valediction[0].bottom - 0.5);
    const footer = await box(page, "#the-letter footer p");
    expect(Math.abs(signature[0].right - footer.right), at).toBeLessThan(1);

    await openDocument(page, id, documents.epigraph);
    text = await box(page, "article#tomeshelf-content");
    em = await fontSize(page, "#the-epigraph");
    const epigraph = await box(page, "#the-epigraph");
    expect(epigraph.left - text.left, at).toBeGreaterThanOrEqual(em);
    expect(text.right - epigraph.right, at).toBeGreaterThanOrEqual(em);
    const quote = await textLines(page, "#the-epigraph p");
    const cite = await textLines(page, "#the-epigraph cite");
    expect(cite[0].top, at).toBeGreaterThan(
      quote[quote.length - 1].bottom - 0.5,
    );
    expect(Math.abs(cite[0].right - epigraph.right), at).toBeLessThan(1);

    await openDocument(page, id, documents.dedication);
    text = await box(page, "article#tomeshelf-content");
    em = await fontSize(page, "#dedication p");
    for (const line of await textLines(page, "#dedication p")) {
      expect(
        Math.abs((line.left + line.right) / 2 - (text.left + text.right) / 2),
        at,
      ).toBeLessThan(1);
    }
    const space = await page.locator("#dedication").evaluate((el) => {
      const style = getComputedStyle(el);
      return [
        Number.parseFloat(style.marginBlockStart),
        Number.parseFloat(style.marginBlockEnd),
      ];
    });
    for (const margin of space) {
      expect(margin, at).toBeGreaterThanOrEqual(2 * em);
    }
  }
});

async function openSettings(page: Page) {
  await page.getByRole("button", { name: "Settings" }).click();
  const panel = page.getByRole("dialog", { name: "Reading settings" });
  await expect(panel).toBeVisible();
  return panel;
}

function scrollY(page: Page): Promise<number> {
  return page.evaluate(() => window.scrollY);
}

// Scrolls so that the top edge of the viewport is the given fraction of the
// way into the element, and returns the fraction the browser settled on.
async function scrollInto(
  page: Page,
  selector: string,
  fraction: number,
): Promise<number> {
  return page.locator(selector).evaluate((el, f) => {
    const box = el.getBoundingClientRect();
    window.scrollTo({
      top: window.scrollY + box.top + f * box.height,
      behavior: "instant",
    });
    const after = el.getBoundingClientRect();
    return -after.top / after.height;
  }, fraction);
}

// Expects the element to cross the top edge at the fraction, within a pixel
// or two of rounding.
async function expectAtTop(page: Page, selector: string, fraction: number) {
  const { top, height } = await box(page, selector).then((r) => ({
    top: r.top,
    height: r.bottom - r.top,
  }));
  expect(Math.abs(top + fraction * height), selector).toBeLessThan(2);
}

test("each setting changes the reading page through its control, and other pages keep their colours", async ({
  page,
}) => {
  await importSemantics(page);
  await page.goto("/");
  await page
    .getByLabel("Import an EPUB")
    .setInputFiles(path.join(books, "reader.epub"));
  await expect(page.getByRole("status")).toHaveText(
    "Imported A Hand-Made Reading Book.",
  );
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.getByRole("link", { name: /A Hand-Made Reading Book/ }).click();
  await expect(article(page)).toContainText("Document One");
  const looks = () =>
    page.evaluate(() => {
      const style = (el: Element | null | undefined) =>
        el ? getComputedStyle(el) : null;
      const query = (selector: string) => document.querySelector(selector);
      const width = (selector: string) =>
        query(selector)?.getBoundingClientRect().width;
      return {
        fontSize: style(query("#tomeshelf-content"))?.fontSize,
        lineHeight: style(query("#tomeshelf-content"))?.lineHeight,
        width: width("#tomeshelf-content"),
        controls: width("nav[aria-label='Reading order']"),
        page: style(query("header")?.parentElement)?.backgroundColor,
        header: style(query("header"))?.borderBottomColor,
        text: style(query("#tomeshelf-content"))?.color,
        link: style(query("#tomeshelf-content a[href]"))?.color,
        panel: style(query("dialog[aria-label='Reading settings']"))
          ?.backgroundColor,
      };
    });
  const panel = await openSettings(page);
  const value = (name: string) => panel.getByRole("status", { name });
  const light = await looks();
  expect(light).toMatchObject({
    fontSize: "18px",
    lineHeight: "28.8px",
    width: 608,
    controls: 608,
  });

  await panel.getByRole("button", { name: "Increase font size" }).click();
  await panel.getByRole("button", { name: "Increase font size" }).click();
  await expect(value("Font size")).toHaveText("20 px");
  await panel.getByRole("button", { name: "Increase line height" }).click();
  await expect(value("Line height")).toHaveText("1.7");
  await panel.getByRole("button", { name: "Decrease text width" }).click();
  await panel.getByRole("button", { name: "Decrease text width" }).click();
  await expect(value("Text width")).toHaveText("34 rem");
  expect(await looks()).toMatchObject({
    fontSize: "20px",
    lineHeight: "34px",
    width: 544,
    controls: 544,
  });

  const colours = (l: Awaited<ReturnType<typeof looks>>) => [
    l.page,
    l.header,
    l.text,
    l.link,
    l.panel,
  ];
  await panel.getByRole("radio", { name: "Dark" }).check();
  const dark = await looks();
  await panel.getByRole("radio", { name: "Sepia" }).check();
  const sepia = await looks();
  for (const [i, part] of [
    "page",
    "header",
    "text",
    "link",
    "panel",
  ].entries()) {
    const seen = [light, dark, sepia].map((l) => colours(l)[i]);
    expect(new Set(seen).size, `${part} colour per theme`).toBe(3);
  }

  await page.getByRole("link", { name: "Library" }).click();
  await expect(page).toHaveURL(/\/$/);
  expect(
    await page
      .locator("header")
      .evaluate(
        (el) =>
          el.parentElement &&
          getComputedStyle(el.parentElement).backgroundColor,
      ),
  ).toBe(light.page);
});

test("a font size, line height or width change keeps the block at the top edge, and a theme change does not scroll", async ({
  page,
}) => {
  const id = await importSemantics(page);
  await page.setViewportSize({ width: 1280, height: 720 });
  await openDocument(page, id, documents.long);
  const panel = await openSettings(page);
  const block = "#long > p:nth-of-type(20)";
  const fraction = await scrollInto(page, block, 0.4);

  // Narrowing to 28 rem rewraps the paragraphs above the block.
  for (const [name, clicks] of [
    ["Increase font size", 1],
    ["Increase line height", 1],
    ["Decrease text width", 5],
  ] as const) {
    const before = await scrollY(page);
    for (let i = 0; i < clicks; i++) {
      await panel.getByRole("button", { name }).click();
      await expectAtTop(page, block, fraction);
    }
    expect(await scrollY(page), name).not.toBe(before);
  }

  const before = await scrollY(page);
  await panel.getByRole("radio", { name: "Dark" }).check();
  await expect(page.locator("html")).toHaveAttribute(
    "data-reading-theme",
    "dark",
  );
  expect(await scrollY(page)).toBe(before);
});

test("the anchor is the image, the table or the next block at the top edge, and the header keeps its offset", async ({
  page,
}) => {
  const id = await importSemantics(page);
  await page.setViewportSize({ width: 1280, height: 720 });
  await openDocument(page, id, documents.long);
  await expect
    .poll(() =>
      page
        .locator("#tall")
        .evaluate((img: HTMLImageElement) => img.complete && img.naturalHeight),
    )
    .toBeGreaterThan(0);
  const panel = await openSettings(page);
  const larger = panel.getByRole("button", { name: "Increase font size" });

  let fraction = await scrollInto(page, "#tall", 0.3);
  await larger.click();
  await expectAtTop(page, "#tall", fraction);

  const cell = "#tall-table tr:nth-of-type(5) td:nth-of-type(1) p";
  await scrollInto(page, cell, 0.5);
  const table = await box(page, "#tall-table");
  fraction = -table.top / (table.bottom - table.top);
  await larger.click();
  await expectAtTop(page, "#tall-table", fraction);

  const next = "#long > p:nth-of-type(11)";
  await page.locator(next).evaluate((el) => {
    const gap =
      el.getBoundingClientRect().top -
      (el.previousElementSibling as Element).getBoundingClientRect().bottom;
    window.scrollTo({
      top: window.scrollY + el.getBoundingClientRect().top - gap / 2,
      behavior: "instant",
    });
  });
  expect((await box(page, next)).top).toBeGreaterThan(0);
  await larger.click();
  await expectAtTop(page, next, 0);

  await page.evaluate(() => window.scrollTo({ top: 5, behavior: "instant" }));
  await larger.click();
  await expect(article(page)).toHaveCSS("font-size", "22px");
  expect(await scrollY(page)).toBe(5);
  expect((await box(page, "header")).bottom).toBeGreaterThan(0);

  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
  await larger.click();
  await expect(article(page)).toHaveCSS("font-size", "23px");
  expect(await scrollY(page)).toBe(0);
});

test("near the end of a short document, the page stops at its last offset with the anchor still visible", async ({
  page,
}) => {
  const id = await importSemantics(page);
  await page.setViewportSize({ width: 1280, height: 720 });
  await openDocument(page, id, documents.short);
  const panel = await openSettings(page);
  const bottom = () =>
    page.evaluate(
      () => document.documentElement.scrollHeight - window.innerHeight,
    );
  await page.evaluate(() =>
    window.scrollTo({
      top: document.documentElement.scrollHeight,
      behavior: "instant",
    }),
  );
  expect(await scrollY(page)).toBe(await bottom());
  const anchor = await page.evaluate(() =>
    [...document.querySelectorAll("#short > p")].findIndex(
      (p) => p.getBoundingClientRect().bottom > 0,
    ),
  );
  expect(anchor).toBeGreaterThan(0);

  await panel.getByRole("button", { name: "Decrease font size" }).click();
  await expect(article(page)).toHaveCSS("font-size", "17px");
  expect(await bottom()).toBeGreaterThan(0);
  expect(await scrollY(page)).toBe(await bottom());
  await expect(page.locator("#short > p").nth(anchor)).toBeInViewport();
});

test("the settings panel fits and works by click and keyboard at phone and desktop widths", async ({
  page,
}) => {
  const id = await importSemantics(page);
  for (const width of [375, 1280]) {
    const at = `at ${width} px`;
    await page.setViewportSize({ width, height: 800 });
    await openDocument(page, id, documents.common);
    await page.getByRole("button", { name: "Settings" }).focus();
    await page.keyboard.press("Enter");
    const panel = page.getByRole("dialog", { name: "Reading settings" });
    await expect(panel, at).toBeVisible();
    const fit = await panel.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return {
        inside:
          r.left >= 0 &&
          r.top >= 0 &&
          r.right <= window.innerWidth &&
          r.bottom <= window.innerHeight,
        overflow: document.documentElement.scrollWidth - window.innerWidth,
      };
    });
    expect(fit, at).toEqual({ inside: true, overflow: 0 });

    for (const [setting, start, up, down] of [
      ["font size", "18 px", "19 px", "18 px"],
      ["line height", "1.6", "1.7", "1.6"],
      ["text width", "38 rem", "40 rem", "38 rem"],
    ]) {
      const value = panel.getByRole("status", { name: setting });
      await expect(value, at).toHaveText(start);
      await panel.getByRole("button", { name: `Increase ${setting}` }).click();
      await expect(value, at).toHaveText(up);
      await panel.getByRole("button", { name: `Decrease ${setting}` }).focus();
      await page.keyboard.press("Enter");
      await expect(value, at).toHaveText(down);
    }

    await panel.getByRole("radio", { name: "Sepia" }).click();
    await expect(page.locator("html"), at).toHaveAttribute(
      "data-reading-theme",
      "sepia",
    );
    await page.keyboard.press("ArrowLeft");
    await expect(panel.getByRole("radio", { name: "Dark" }), at).toBeChecked();
    await page.keyboard.press("ArrowLeft");
    await expect(panel.getByRole("radio", { name: "Light" }), at).toBeChecked();
    await expect(page.locator("html"), at).toHaveAttribute(
      "data-reading-theme",
      "light",
    );

    await page.keyboard.press("Escape");
    await expect(panel, at).toBeHidden();
    await openSettings(page);
    await panel.getByRole("button", { name: "Close" }).click();
    await expect(panel, at).toBeHidden();
  }
});

test("returning to a cached document scrolls its fragment after retained settings apply", async ({
  page,
}) => {
  const id = await importSemantics(page);
  await page.goto(`/books/${id}/read/6#tall-table`);
  const target = page.locator("#tall-table");
  await expect(target).toBeVisible();
  await page.getByRole("button", { name: "Settings" }).click();
  const increase = page.getByRole("button", { name: "Increase font size" });
  for (let i = 0; i < 10; i++) await increase.click();
  await page.evaluate(() => {
    history.scrollRestoration = "manual";
    document.documentElement.style.overflowAnchor = "none";
  });
  await page.getByRole("link", { name: "Library" }).click();
  await expect(page.getByLabel("Import an EPUB")).toBeVisible();
  await expect(page.locator("html")).not.toHaveAttribute("data-reading-theme");
  await page.evaluate(() => {
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (...args) {
      if (
        this.id === "tall-table" &&
        !document.documentElement.dataset.fragmentScrollFont
      ) {
        document.documentElement.dataset.fragmentScrollFont =
          getComputedStyle(this).fontSize;
      }
      original.apply(this, args);
    };
  });
  await page.evaluate((url) => {
    history.pushState({}, "", url);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, `/books/${id}/read/6#tall-table`);
  await expect(target).toBeVisible();
  expect(await fontSize(page, "#tomeshelf-content")).toBe(28);
  await expect(page.locator("html")).toHaveAttribute(
    "data-fragment-scroll-font",
    "28px",
  );
  await expect
    .poll(async () => Math.abs((await target.boundingBox())?.y ?? 999))
    .toBeLessThan(2);
});

type Settings = {
  fontSize: number;
  lineHeight: number;
  width: number;
  theme: string;
  layout: string;
};

const defaults: Settings = {
  fontSize: 18,
  lineHeight: 1.6,
  width: 38,
  theme: "light",
  layout: "pages",
};

async function saved(api: APIRequestContext): Promise<Settings> {
  const res = await api.get("/api/settings");
  expect(res.status()).toBe(200);
  return res.json();
}

async function save(api: APIRequestContext, settings: Partial<Settings>) {
  const res = await api.put("/api/settings", {
    data: { ...defaults, ...settings },
  });
  expect(res.status()).toBe(204);
}

function isSettings(request: Request, method: string) {
  return (
    new URL(request.url()).pathname === "/api/settings" &&
    request.method() === method
  );
}

// Holds every settings request with the method until the test lets it
// through.
async function hold(page: Page, method: "GET" | "PUT"): Promise<Route[]> {
  const held: Route[] = [];
  await page.route("**/api/settings", (route) => {
    if (route.request().method() !== method) {
      return route.fallback();
    }
    held.push(route);
  });
  return held;
}

function sentFontSizes(routes: Route[]) {
  return routes.map((r) => r.request().postDataJSON().fontSize);
}

// Adds a user with a session straight to the database, as only the admin
// can be created through the app, and returns the session's token.
function addReader(server: TestServer, username: string): string {
  const db = new DatabaseSync(path.join(server.dataDir, "tomeshelf.db"));
  try {
    db.exec("PRAGMA busy_timeout = 10000");
    const user = db
      .prepare(
        "INSERT INTO users (username, password_hash) VALUES (?, 'not a real hash') RETURNING id",
      )
      .get(username) as { id: number };
    const token = randomBytes(32).toString("base64url");
    db.prepare(
      "INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)",
    ).run(
      createHash("sha256").update(token).digest(),
      user.id,
      Math.floor(Date.now() / 1000) + 3600,
    );
    return token;
  } finally {
    db.close();
  }
}

test("a change survives a reload and opens on another device, while another user keeps the defaults", async ({
  page,
  browser,
  server,
}) => {
  const id = await importSemantics(page);
  await openDocument(page, id, documents.common);
  const panel = await openSettings(page);
  await panel.getByRole("button", { name: "Increase font size" }).click();
  await panel.getByRole("button", { name: "Increase font size" }).click();
  await panel.getByRole("radio", { name: "Dark" }).check();
  await panel.getByRole("radio", { name: "Scroll" }).check();
  await expect
    .poll(() => saved(page.request))
    .toEqual({ ...defaults, fontSize: 20, theme: "dark", layout: "scroll" });

  await page.reload();
  await expect(article(page)).toContainText(documents.common.text);
  await expect(article(page)).toHaveCSS("font-size", "20px");
  await expect(page.locator("html")).toHaveAttribute(
    "data-reading-theme",
    "dark",
  );
  await expect(page.locator("html")).toHaveAttribute(
    "data-reading-layout",
    "scroll",
  );

  const device = await browser.newContext({
    baseURL: server.url,
    storageState: await page.context().storageState(),
  });
  const second = await device.newPage();
  await openDocument(second, id, documents.common);
  await expect(article(second)).toHaveCSS("font-size", "20px");
  await expect(second.locator("html")).toHaveAttribute(
    "data-reading-theme",
    "dark",
  );
  await expect(second.locator("html")).toHaveAttribute(
    "data-reading-layout",
    "scroll",
  );
  await device.close();

  const other = await browser.newContext({ baseURL: server.url });
  await other.addCookies([
    {
      name: "tomeshelf_session",
      value: addReader(server, "other"),
      url: server.url,
    },
  ]);
  const imported = await other.request.post("/api/books", {
    data: await readFile(path.join(books, "semantics.epub")),
    headers: { "Content-Type": "application/epub+zip" },
  });
  expect(imported.status()).toBe(201);
  const othersPage = await other.newPage();
  const loaded = othersPage.waitForResponse((res) =>
    isSettings(res.request(), "GET"),
  );
  await openDocument(
    othersPage,
    String((await imported.json()).id),
    documents.common,
  );
  expect((await loaded).status()).toBe(200);
  await expect(article(othersPage)).toHaveCSS("font-size", "18px");
  await expect(othersPage.locator("html")).toHaveAttribute(
    "data-reading-theme",
    "light",
  );
  await expect(othersPage.locator("html")).toHaveAttribute(
    "data-reading-layout",
    "pages",
  );
  await other.close();
});

test("a change made just before moving within the app, or before closing the page, is stored", async ({
  page,
  context,
}) => {
  const id = await importSemantics(page);
  await openDocument(page, id, documents.letter);
  let panel = await openSettings(page);
  await panel.getByRole("button", { name: "Increase font size" }).click();
  await page.keyboard.press("Escape");
  await page.getByRole("link", { name: "Next" }).click();
  await expect(article(page)).toContainText(documents.epigraph.text);
  await page.getByRole("link", { name: "Library" }).click();
  await expect(page.getByLabel("Import an EPUB")).toBeVisible();
  await expect.poll(() => saved(page.request)).toMatchObject({ fontSize: 19 });

  await openDocument(page, id, documents.letter);
  await expect(article(page)).toHaveCSS("font-size", "19px");
  panel = await openSettings(page);
  await panel.getByRole("button", { name: "Increase font size" }).click();
  await expect(article(page)).toHaveCSS("font-size", "20px");
  await page.close({ runBeforeUnload: true });
  await expect
    .poll(() => saved(context.request))
    .toMatchObject({ fontSize: 20 });
});

test("a hidden page sends its pending save only after the save in flight", async ({
  page,
}) => {
  const id = await importSemantics(page);
  await openDocument(page, id, documents.common);
  const puts = await hold(page, "PUT");
  const panel = await openSettings(page);
  const larger = panel.getByRole("button", { name: "Increase font size" });
  await larger.click();
  await expect.poll(() => puts.length).toBe(1);
  await larger.click();
  await page.evaluate(() => {
    for (const state of ["hidden", "visible"]) {
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get: () => state,
      });
      document.dispatchEvent(new Event("visibilitychange"));
    }
  });
  await page.waitForTimeout(1000);
  expect(puts.length).toBe(1);

  await puts[0].continue();
  await expect.poll(() => puts.length).toBe(2);
  expect(sentFontSizes(puts)).toEqual([19, 20]);
  await puts[1].continue();
  await expect.poll(() => saved(page.request)).toMatchObject({ fontSize: 20 });
});

test("a page resumed after pagehide ends with its latest settings stored, even when the overlapping saves finish out of order", async ({
  page,
}) => {
  const id = await importSemantics(page);
  await openDocument(page, id, documents.common);
  const puts = await hold(page, "PUT");
  const panel = await openSettings(page);
  const larger = panel.getByRole("button", { name: "Increase font size" });
  await larger.click();
  await expect.poll(() => puts.length).toBe(1);
  await larger.click();
  await page.evaluate(() =>
    window.dispatchEvent(
      new PageTransitionEvent("pagehide", { persisted: true }),
    ),
  );
  await expect.poll(() => puts.length).toBe(2);
  expect(sentFontSizes(puts)).toEqual([19, 20]);

  await puts[1].fulfill({ response: await puts[1].fetch() });
  await puts[0].fulfill({ response: await puts[0].fetch() });
  expect(await saved(page.request)).toMatchObject({ fontSize: 19 });
  await page.evaluate(() =>
    window.dispatchEvent(
      new PageTransitionEvent("pageshow", { persisted: true }),
    ),
  );
  await expect.poll(() => puts.length).toBe(3);
  expect(sentFontSizes(puts)).toEqual([19, 20, 20]);
  await puts[2].continue();
  await expect.poll(() => saved(page.request)).toMatchObject({ fontSize: 20 });
});

test("a failed save shows Not saved with Retry, and quick changes end with the latest settings stored", async ({
  page,
}) => {
  const id = await importSemantics(page);
  await openDocument(page, id, documents.common);
  await page.route("**/api/settings", (route) =>
    route.request().method() === "PUT"
      ? route.fulfill({ status: 500, json: { error: "internal server error" } })
      : route.fallback(),
  );
  const panel = await openSettings(page);
  const larger = panel.getByRole("button", { name: "Increase font size" });
  await larger.click();
  await expect(panel.getByText("Saving…")).toBeVisible();
  await expect(panel.getByText("Not saved")).toBeVisible();
  const retry = panel.getByRole("button", { name: "Retry" });
  await expect(article(page)).toHaveCSS("font-size", "19px");
  await page.unrouteAll();
  await retry.click();
  await expect(retry).toBeHidden();
  await expect(panel.getByText("Not saved")).toBeHidden();
  await expect.poll(() => saved(page.request)).toMatchObject({ fontSize: 19 });

  const puts = await hold(page, "PUT");
  await larger.click();
  await expect.poll(() => puts.length).toBe(1);
  for (let i = 0; i < 3; i++) {
    await larger.click();
  }
  await page.waitForTimeout(1000);
  expect(puts.length).toBe(1);
  await puts[0].continue();
  await expect.poll(() => puts.length).toBe(2);
  expect(sentFontSizes(puts)).toEqual([20, 23]);
  await puts[1].continue();
  await expect(panel.getByText("Saving…")).toBeHidden();
  await page.unrouteAll();
  await page.reload();
  await expect(article(page)).toContainText(documents.common.text);
  await expect(article(page)).toHaveCSS("font-size", "23px");
});

test("when the saved settings cannot be loaded, the defaults apply, the panel says so, and a change is still saved", async ({
  page,
}) => {
  const id = await importSemantics(page);
  await save(page.request, { fontSize: 24 });
  await page.route("**/api/settings", (route) =>
    route.request().method() === "GET"
      ? route.fulfill({ status: 500, json: { error: "internal server error" } })
      : route.fallback(),
  );
  const loaded = page.waitForResponse((res) =>
    isSettings(res.request(), "GET"),
  );
  await openDocument(page, id, documents.common);
  await loaded;
  const panel = await openSettings(page);
  await expect(
    panel.getByText("Your saved settings could not be loaded."),
  ).toBeVisible();
  await expect(article(page)).toHaveCSS("font-size", "18px");
  await panel.getByRole("button", { name: "Increase font size" }).click();
  await expect.poll(() => saved(page.request)).toMatchObject({ fontSize: 19 });
});

test("saved settings that arrive after the document apply with the anchor rule", async ({
  page,
}) => {
  const id = await importSemantics(page);
  await save(page.request, { fontSize: 24 });
  await page.setViewportSize({ width: 1280, height: 720 });
  const gets = await hold(page, "GET");
  await openDocument(page, id, documents.long);
  await expect.poll(() => gets.length).toBe(1);
  await expect(article(page)).toHaveCSS("font-size", "18px");
  const block = "#long > p:nth-of-type(20)";
  const fraction = await scrollInto(page, block, 0.4);
  const before = await scrollY(page);

  await gets[0].continue();
  await expect(article(page)).toHaveCSS("font-size", "24px");
  await expectAtTop(page, block, fraction);
  expect(await scrollY(page)).not.toBe(before);
});

test("a change the user makes before the saved settings arrive wins over them", async ({
  page,
}) => {
  const id = await importSemantics(page);
  await save(page.request, { fontSize: 24 });
  const gets = await hold(page, "GET");
  await openDocument(page, id, documents.common);
  await expect.poll(() => gets.length).toBe(1);
  const panel = await openSettings(page);
  await panel.getByRole("button", { name: "Increase font size" }).click();
  await expect(article(page)).toHaveCSS("font-size", "19px");

  const answered = page.waitForResponse((res) =>
    isSettings(res.request(), "GET"),
  );
  await gets[0].continue();
  expect(await (await answered).json()).toMatchObject({ fontSize: 24 });
  await page.waitForTimeout(200);
  await expect(article(page)).toHaveCSS("font-size", "19px");
  await expect.poll(() => saved(page.request)).toMatchObject({ fontSize: 19 });

  await page.unrouteAll();
  await page.reload();
  await expect(article(page)).toContainText(documents.common.text);
  await expect(article(page)).toHaveCSS("font-size", "19px");
});

test("saved settings that arrive before the document are there on its first render, before the fragment scroll", async ({
  page,
}) => {
  const id = await importSemantics(page);
  await save(page.request, { fontSize: 24 });
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.addInitScript(() => {
    new MutationObserver((_, observer) => {
      const content = document.getElementById("tomeshelf-content");
      if (content?.querySelector("[data-tomeshelf-block]")) {
        document.documentElement.dataset.firstRenderFont =
          getComputedStyle(content).fontSize;
        observer.disconnect();
      }
    }).observe(document, { childList: true, subtree: true });
  });
  const documentFiles: Route[] = [];
  await page.route("**/api/books/*/package/**", (route) => {
    if (!route.request().url().endsWith(".xhtml")) {
      return route.fallback();
    }
    documentFiles.push(route);
  });
  const loaded = page.waitForResponse((res) =>
    isSettings(res.request(), "GET"),
  );
  await page.goto(`/books/${id}/read/${documents.long.n}#tall-table`);
  await loaded;
  await expect.poll(() => documentFiles.length).toBe(1);
  await documentFiles[0].continue();

  await expect(article(page)).toContainText(documents.long.text);
  await expect(page.locator("html")).toHaveAttribute(
    "data-first-render-font",
    "24px",
  );
  await expect
    .poll(async () =>
      Math.abs((await page.locator("#tall-table").boundingBox())?.y ?? 999),
    )
    .toBeLessThan(2);
});

test("a load started during a save cannot overwrite the saved choice", async ({
  page,
}) => {
  await importSemantics(page);
  const puts = await hold(page, "PUT");
  const panel = await openSettings(page);
  await panel.getByRole("button", { name: "Increase font size" }).click();
  await expect.poll(() => puts.length).toBe(1);
  const gets = await hold(page, "GET");
  await page.getByRole("link", { name: "Library" }).click();
  await page.getByRole("link", { name: new RegExp(title) }).click();
  await expect.poll(() => gets.length).toBe(1);
  const old = await gets[0].fetch();
  await puts[0].continue();
  await expect.poll(() => saved(page.request)).toMatchObject({ fontSize: 19 });
  await gets[0].fulfill({ response: old });
  await page.waitForTimeout(200);
  await expect(article(page)).toHaveCSS("font-size", "19px");
});

test("a failed save cannot follow a different user into their session", async ({
  page,
  server,
}) => {
  await importSemantics(page);
  await page.route("**/api/settings", (route) =>
    route.request().method() === "PUT"
      ? route.fulfill({ status: 500 })
      : route.fallback(),
  );
  const panel = await openSettings(page);
  await panel.getByRole("button", { name: "Increase font size" }).click();
  await expect(panel.getByText("Not saved")).toBeVisible();
  await page.getByRole("link", { name: "Library" }).click();
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await page.context().addCookies([
    {
      name: "tomeshelf_session",
      value: addReader(server, "other"),
      url: server.url,
    },
  ]);
  await page.unrouteAll();
  await page.evaluate(() => {
    history.pushState({}, "", "/");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  await page
    .getByLabel("Import an EPUB")
    .setInputFiles(path.join(books, "semantics.epub"));
  await expect(page.getByRole("status")).toHaveText(`Imported ${title}.`);
  await page.getByRole("link", { name: new RegExp(title) }).click();
  await expect(article(page)).toContainText(documents.poetry.text);
  const otherPanel = await openSettings(page);
  await expect(
    otherPanel.getByRole("status", { name: "Font size" }),
  ).toHaveText("18 px");
  await expect(otherPanel.getByRole("button", { name: "Retry" })).toHaveCount(
    0,
  );
  expect(await saved(page.request)).toEqual(defaults);
});

test("signing out discards saves waiting behind an in-flight save", async ({
  page,
  server,
}) => {
  await importSemantics(page);
  const puts = await hold(page, "PUT");
  const panel = await openSettings(page);
  const increase = panel.getByRole("button", { name: "Increase font size" });
  await increase.click();
  await expect.poll(() => puts.length).toBe(1);
  await increase.click();
  await page.getByRole("link", { name: "Library" }).click();
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await page.context().addCookies([
    {
      name: "tomeshelf_session",
      value: addReader(server, "other"),
      url: server.url,
    },
  ]);
  await puts[0].fulfill({ status: 204 });
  await page.waitForTimeout(800);
  expect(puts).toHaveLength(1);
  expect(await saved(page.request)).toEqual(defaults);
});
