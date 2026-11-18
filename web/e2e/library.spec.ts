import path from "node:path";
import { expect, test } from "@playwright/test";
import { expectCoverProgress } from "./cover-progress";
import { startServer, type TestServer } from "./server";

const longTitle =
  "A very long title about journeys through distant lands and extraordinary adventures beyond the edge of the known world";
const manyAuthors = [
  "Alexandra Longname",
  "Benjamin Anothername",
  "Charlotte Thirdname",
  "Dominic Fourthname",
];

const books = Array.from({ length: 12 }, (_, i) => ({
  id: (i + 1).toString(16).padStart(64, "0"),
  title: i === 0 ? longTitle : i === 1 ? "山と海の物語" : `Book ${i + 1}`,
  authors: i === 0 ? manyAuthors : ["A. Writer"],
  ...(i === 2 ? { progress: 37 } : {}),
}));

test.describe("library layout", () => {
  test.beforeEach(async ({ page }) => {
    await page.route("**/api/books", (route) => route.fulfill({ json: books }));
    await page.route("**/api/books/*/thumbnail", (route) =>
      route.fulfill({
        contentType: "image/svg+xml",
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="300"><rect width="200" height="300" fill="#987654"/></svg>',
      }),
    );
    await page.goto("/");
    await expect(
      page.getByRole("list", { name: "All books" }).getByRole("listitem"),
    ).toHaveCount(12);
  });

  test("the grid is headed and labelled All books only when books exist", async ({
    page,
  }) => {
    await expect(
      page.getByRole("heading", { name: "All books", level: 2 }),
    ).toBeVisible();
    await expect(
      page.getByRole("list", { name: "All books" }).getByRole("listitem"),
    ).toHaveCount(12);
    await page.route("**/api/books", (route) => route.fulfill({ json: [] }));
    await page.reload();
    await expect(
      page.getByText("No books yet. Import an EPUB to start reading."),
    ).toBeVisible();
    await expect(page.getByRole("heading", { name: "All books" })).toHaveCount(
      0,
    );
  });

  test("the library has bounded covers and equal centred columns on wide screens", async ({
    page,
  }) => {
    const list = page.getByRole("list", { name: "All books" });
    const counts: number[] = [];
    for (const width of [390, 1280, 2000]) {
      await page.setViewportSize({ width, height: 900 });
      const boxes = await list.getByRole("listitem").evaluateAll((items) =>
        items.map((item) => {
          const box = item.getBoundingClientRect();
          return {
            y: box.y,
            width:
              item.querySelector("img")?.getBoundingClientRect().width ?? 0,
          };
        }),
      );
      counts.push(
        boxes.filter((box) => Math.abs(box.y - boxes[0].y) < 1).length,
      );
      for (const box of boxes) {
        expect(box.width).toBeGreaterThan(0);
        expect(box.width).toBeLessThanOrEqual(180);
      }
      if (width >= 1280) {
        const container = await list.locator("..").boundingBox();
        if (!container) throw new Error("Library container missing");
        expect(container.width).toBeLessThanOrEqual(1152);
        expect(
          Math.abs(container.x - (width - container.x - container.width)),
        ).toBeLessThanOrEqual(1);
      }
      if (width === 390) {
        expect(
          await page.evaluate(
            () =>
              document.documentElement.scrollWidth <=
              document.documentElement.clientWidth,
          ),
        ).toBe(true);
      }
    }
    expect(counts[0]).toBeGreaterThanOrEqual(2);
    expect(counts[0]).toBeLessThanOrEqual(3);
    expect(counts[1]).toBeGreaterThanOrEqual(6);
    expect(counts[2]).toBe(counts[1]);
  });

  test("cover bars expose progress without visible percentages on light and dark covers", async ({
    page,
  }) => {
    await page.route("**/api/books", (route) =>
      route.fulfill({
        json: [
          {
            id: "1".padStart(64, "0"),
            title: "Unread",
            authors: ["A. Writer"],
          },
          {
            id: "2".padStart(64, "0"),
            title: "Start",
            authors: ["A. Writer"],
            progress: 0,
          },
          {
            id: "3".padStart(64, "0"),
            title: "Middle",
            authors: ["A. Writer"],
            progress: 37,
            savedAt: 1000,
          },
          {
            id: "4".padStart(64, "0"),
            title: "End",
            authors: ["A. Writer"],
            progress: 100,
          },
        ],
      }),
    );
    await page.route("**/api/books/*/thumbnail", (route) =>
      route.fulfill({
        contentType: "image/svg+xml",
        body: `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="300"><rect width="200" height="300" fill="${route.request().url().includes("/2/") ? "#fff" : "#111"}"/></svg>`,
      }),
    );
    await page.reload();
    const grid = page.getByRole("list", { name: "All books" });
    const unread = grid.getByRole("link", { name: /Unread/ });
    await expect(unread.getByRole("progressbar")).toHaveCount(0);
    await expect(unread).toHaveAccessibleName("Unread by A. Writer");
    for (const width of [390, 1280]) {
      await page.setViewportSize({ width, height: 844 });
      for (const [title, value] of [
        ["Start", 0],
        ["Middle", 37],
        ["End", 100],
      ] as const) {
        await expectCoverProgress(
          grid.getByRole("link", { name: new RegExp(title) }),
          value,
        );
      }
      await expectCoverProgress(
        page.getByRole("region", { name: "Continue reading" }),
        37,
      );
    }
    await expect(page.getByText(/^\d+%$/)).toHaveCount(0);
  });

  test("book links retain their full accessible names", async ({ page }) => {
    const links = page
      .getByRole("list", { name: "All books" })
      .getByRole("link");
    await expect(links.nth(2)).toHaveAccessibleName("37% Book 3 by A. Writer");
    await expect(links.nth(1)).toHaveAccessibleName(
      "山と海の物語 by A. Writer",
    );
  });

  for (const progress of [23, undefined]) {
    test(`continue reading shows saved time with progress ${progress}`, async ({
      page,
    }) => {
      const now = Date.UTC(2026, 10, 17, 12);
      await page.clock.setFixedTime(now);
      await page.route("**/api/books", (route) =>
        route.fulfill({
          json: [{ ...books[0], progress, savedAt: now - 172_800_000 }],
        }),
      );
      await page.reload();
      await expect(
        page
          .getByRole("region", { name: "Continue reading" })
          .getByText(
            progress === undefined ? "2 days ago" : "23% · 2 days ago",
            { exact: true },
          ),
      ).toBeVisible();
    });
  }

  test("continue reading wraps its content and features a cover at least as wide as grid covers", async ({
    page,
  }) => {
    await page.route("**/api/books", (route) =>
      route.fulfill({
        json: books.map((book, i) => ({
          ...book,
          savedAt: i === 0 ? 1000 : undefined,
        })),
      }),
    );
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.reload();
    const card = page.getByRole("region", { name: "Continue reading" });
    await expect(card).toBeVisible();
    const cardBox = await card.boundingBox();
    const gridBox = await page
      .getByRole("list", { name: "All books" })
      .boundingBox();
    if (!cardBox || !gridBox) throw new Error("Library boxes missing");
    expect(cardBox.width).toBeLessThan(gridBox.width);
    expect(cardBox.width).toBeLessThanOrEqual(576);
    const cover = await card.locator("img").boundingBox();
    const gridCover = await page
      .getByRole("list", { name: "All books" })
      .locator("img")
      .first()
      .boundingBox();
    if (!cover || !gridCover) throw new Error("Cover boxes missing");
    expect(cover.width).toBeGreaterThanOrEqual(gridCover.width);
  });

  for (const width of [390, 1280, 2000]) {
    test(`long book metadata is ellipsized with full hover text and a hidden by prefix at ${width} px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      const link = page
        .getByRole("list", { name: "All books" })
        .getByRole("link")
        .first();
      const title = link.getByText(longTitle, { exact: true });
      const authors = link.getByText(manyAuthors.join(", "), { exact: false });
      await expect(title).toHaveAttribute("title", longTitle);
      await expect(authors).toHaveAttribute("title", manyAuthors.join(", "));
      const titleStyle = await title.evaluate((el) => {
        const style = getComputedStyle(el);
        return {
          lines: el.clientHeight / parseFloat(style.lineHeight),
          overflowing: el.scrollHeight > el.clientHeight,
          clamp: style.webkitLineClamp,
          display: style.display,
          orient: style.webkitBoxOrient,
          overflow: style.overflow,
        };
      });
      // Chromium 159 serializes a clamped -webkit-box as flow-root.
      expect(["-webkit-box", "flow-root"]).toContain(titleStyle.display);
      expect(titleStyle).toMatchObject({
        lines: 2,
        overflowing: true,
        clamp: "2",
        orient: "vertical",
        overflow: "hidden",
      });
      const authorStyle = await authors.evaluate((el) => {
        const style = getComputedStyle(el);
        return {
          lines: el.clientHeight / parseFloat(style.lineHeight),
          overflowing: el.scrollWidth > el.clientWidth,
          ellipsis: style.textOverflow,
          whitespace: style.whiteSpace,
          overflow: style.overflow,
        };
      });
      expect(authorStyle).toEqual({
        lines: 1,
        overflowing: true,
        ellipsis: "ellipsis",
        whitespace: "nowrap",
        overflow: "hidden",
      });
      await expect(authors.getByText("by", { exact: true })).toHaveClass(
        "sr-only",
      );
      const prefix = authors.getByText("by", { exact: true });
      await expect(prefix).toHaveCSS("position", "absolute");
      await expect(prefix).toHaveCSS("clip-path", "inset(50%)");
    });
  }

  test("continue reading selects the newest import on tied saves and fits above the grid on a phone", async ({
    page,
  }) => {
    await page.route("**/api/books", (route) =>
      route.fulfill({
        json: books.map((book, i) => ({
          ...book,
          savedAt: i < 2 ? 1000 : undefined,
          importedAt: i === 0 ? 2000 : 1000,
        })),
      }),
    );
    await page.reload();
    const card = page.getByRole("region", { name: "Continue reading" });
    await expect(card.getByRole("heading", { name: longTitle })).toBeVisible();
    await expect(
      card.getByRole("link", { name: "Resume", exact: true }),
    ).toHaveAttribute("href", `/books/${books[0].id}/read`);
    await expect(
      card.getByRole("link", { name: "Resume from cover" }),
    ).toHaveAttribute("href", `/books/${books[0].id}/read`);
    await page.setViewportSize({ width: 390, height: 844 });
    expect(
      await page.evaluate(
        () =>
          document.documentElement.scrollWidth <=
          document.documentElement.clientWidth,
      ),
    ).toBe(true);
    const first = await page
      .getByRole("list", { name: "All books" })
      .getByRole("listitem")
      .first()
      .boundingBox();
    expect(first?.y).toBeLessThan(844);
    await expect(
      page.getByRole("list", { name: "All books" }).getByRole("listitem"),
    ).toHaveCount(12);
  });
});

const readingTest = test.extend<{ server: TestServer }>({
  // biome-ignore lint/correctness/noEmptyPattern: Playwright requires a destructured first argument.
  server: async ({}, use) => {
    const server = await startServer();
    try {
      await use(server);
    } finally {
      await server.stop();
    }
  },
  baseURL: async ({ server }, use) => use(server.url),
  storageState: { cookies: [], origins: [] },
});

readingTest(
  "continue reading follows the departing save and both card links restore it",
  async ({ page }) => {
    const setup = await page.request.post("/api/setup", {
      data: { username: "reader", password: "reader password" },
    });
    expect(setup.status()).toBe(201);
    await page.goto("/");
    const card = page.getByRole("region", { name: "Continue reading" });
    await expect(card).toHaveCount(0);
    for (const file of ["reader.epub", "chapters.epub"]) {
      await page
        .getByLabel("Import an EPUB")
        .setInputFiles(
          path.resolve(import.meta.dirname, "../../testdata/books", file),
        );
      await expect(page.getByRole("status")).toContainText("Imported");
    }
    const grid = page.getByRole("list", { name: "All books" });
    await expect(grid.getByRole("listitem")).toHaveCount(2);
    await expect(card).toHaveCount(0);
    for (const title of [
      /A Hand-Made Reading Book/,
      /A Hand-Made Book of Chapters/,
    ]) {
      const link = grid.getByRole("link", { name: title });
      await expect(link.getByRole("progressbar")).toHaveCount(0);
      await expect(link).not.toHaveAccessibleName(/%/);
    }
    await grid.getByRole("link", { name: /A Hand-Made Reading Book/ }).click();
    await expect(page.locator("article#tomeshelf-content")).toBeVisible();
    await page
      .getByRole("navigation", { name: "Reading order" })
      .getByRole("button", { name: "Next" })
      .click();
    await page.getByRole("link", { name: "Library", exact: true }).click();
    await expect(
      card.getByRole("heading", {
        name: "A Hand-Made Reading Book",
        exact: true,
      }),
    ).toBeVisible();
    await grid
      .getByRole("link", { name: /A Hand-Made Book of Chapters/ })
      .click();
    await expect(page.locator("article#tomeshelf-content")).toContainText(
      "CHAPTER I.",
    );
    await page
      .getByRole("navigation", { name: "Reading order" })
      .getByRole("button", { name: "Next" })
      .click();
    // Leave inside the debounce so this exercises the departing save and refetch.
    await page.getByRole("link", { name: "Library", exact: true }).click();
    await expect(
      card.getByRole("heading", {
        name: "A Hand-Made Book of Chapters",
        exact: true,
      }),
    ).toBeVisible();
    await expect(card.getByText("Ada Fixture", { exact: true })).toBeVisible();
    await expect(
      grid.getByRole("link", { name: /A Hand-Made Book of Chapters/ }),
    ).toBeVisible();
    const address = await card
      .getByRole("link", { name: "Resume", exact: true })
      .getAttribute("href");
    const id = address?.split("/")[2];
    const res = await page.request.get(`/api/books/${id}/position`);
    expect(res.status()).toBe(200);
    const saved = (await res.json()) as {
      locations: { cssSelector: string; totalProgression: number };
    };
    const expected = Math.max(
      0,
      Math.min(100, Math.floor(saved.locations.totalProgression * 100)),
    );
    expect(expected).toBeGreaterThan(0);
    await expectCoverProgress(
      grid.getByRole("link", { name: /A Hand-Made Book of Chapters/ }),
      expected,
    );
    await expectCoverProgress(card, expected);
    for (const name of ["Resume", "Resume from cover"]) {
      await card.getByRole("link", { name, exact: true }).click();
      await expect(page).toHaveURL(new RegExp(`/books/${id}/read/1$`));
      await expect
        .poll(() =>
          page.evaluate((selector) => {
            const article = document.getElementById("tomeshelf-content");
            const block = article?.querySelector(selector);
            if (!article || !block) return false;
            const visible = article.getBoundingClientRect();
            const anchor = block.getBoundingClientRect();
            return (
              article.scrollLeft > 0 &&
              anchor.right > visible.left &&
              anchor.left < visible.right
            );
          }, saved.locations.cssSelector),
        )
        .toBe(true);
      await page.getByRole("link", { name: "Library", exact: true }).click();
      await expect(card).toBeVisible();
    }
  },
);
