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
const title = "A Hand-Made Book of Semantics";

// The semantics fixture's documents, by their position in the reading order.
const documents = {
  poetry: { n: 1, text: "The Owl and the Pussy-cat went to sea" },
  letter: { n: 2, text: "My dear Lanyon," },
  epigraph: { n: 3, text: "Something will come of this." },
  dedication: { n: 4, text: "To the reader who reads to the end." },
  common: { n: 5, text: "Common Elements" },
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
  await page.getByRole("link", { name: new RegExp(title) }).click();
  await expect(page).toHaveURL(/\/books\/\d+\/read\/1$/);
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
