import { expect, test } from "@playwright/test";

const longTitle =
  "A very long title about journeys through distant lands and extraordinary adventures beyond the edge of the known world";
const manyAuthors = [
  "Alexandra Longname",
  "Benjamin Anothername",
  "Charlotte Thirdname",
  "Dominic Fourthname",
];

const books = Array.from({ length: 12 }, (_, i) => ({
  id: i + 1,
  title: i === 0 ? longTitle : i === 1 ? "山と海の物語" : `Book ${i + 1}`,
  authors: i === 0 ? manyAuthors : ["A. Writer"],
  ...(i === 2 ? { progress: 37 } : {}),
}));

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
    page.getByRole("list", { name: "Library" }).getByRole("listitem"),
  ).toHaveCount(12);
});

test("the library fits more bounded covers on wide screens and stays centred", async ({
  page,
}) => {
  const list = page.getByRole("list", { name: "Library" });
  const counts: number[] = [];
  for (const width of [390, 1280, 2000]) {
    await page.setViewportSize({ width, height: 900 });
    const boxes = await list.getByRole("listitem").evaluateAll((items) =>
      items.map((item) => {
        const box = item.getBoundingClientRect();
        return {
          y: box.y,
          width: item.querySelector("img")?.getBoundingClientRect().width ?? 0,
        };
      }),
    );
    counts.push(boxes.filter((box) => Math.abs(box.y - boxes[0].y) < 1).length);
    for (const box of boxes) {
      expect(box.width).toBeGreaterThan(0);
      expect(box.width).toBeLessThanOrEqual(180);
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
  expect(counts[2]).toBeGreaterThan(counts[1]);
  const container = await list.locator("..").boundingBox();
  expect(container).not.toBeNull();
  if (!container) throw new Error("Library container missing");
  expect(container.width).toBeLessThanOrEqual(1536);
  expect(
    Math.abs(container.x - (2000 - container.x - container.width)),
  ).toBeLessThanOrEqual(1);
});

test("book links retain their full accessible names", async ({ page }) => {
  const links = page.getByRole("list", { name: "Library" }).getByRole("link");
  await expect(links.nth(2)).toHaveAccessibleName("Book 3 by A. Writer 37%");
  await expect(links.nth(1)).toHaveAccessibleName("山と海の物語 by A. Writer");
});

for (const width of [390, 1280, 2000]) {
  test(`long book metadata is ellipsized with full hover text and a hidden by prefix at ${width} px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const link = page
      .getByRole("list", { name: "Library" })
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
