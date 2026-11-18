import path from "node:path";
import {
  test as base,
  expect,
  type Locator,
  type Page,
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
const title = "The Time Machine";

function entry(page: Page): Locator {
  return page
    .getByRole("list", { name: "All books" })
    .getByRole("listitem")
    .filter({ hasText: title });
}

test.use({ viewport: { width: 1280, height: 800 } });

test.beforeEach(async ({ page }) => {
  await page.request.post("/api/setup", {
    data: { username: "reader", password: "menu password" },
  });
  await page.goto("/");
  await page
    .getByLabel("Import an EPUB")
    .setInputFiles(path.join(books, "h-g-wells_the-time-machine.epub"));
  await expect(entry(page)).toHaveCount(1);
  await page.mouse.move(1200, 0);
});

function menuButton(page: Page) {
  return entry(page).getByRole("button", { name: `More actions for ${title}` });
}

test("card actions appear on hover without Delete at rest", async ({
  page,
}) => {
  await expect(entry(page).getByText("Delete", { exact: true })).toBeHidden();
  await expect(menuButton(page)).toHaveCount(1);
  await expect(menuButton(page)).toHaveCSS("opacity", "0");
  await entry(page).hover();
  await expect(menuButton(page)).toHaveCSS("opacity", "1");
});

async function tabToBook(page: Page) {
  const link = entry(page).getByRole("link");
  for (let i = 0; i < 20; i++) {
    await page.keyboard.press("Tab");
    if (await link.evaluate((el) => el === document.activeElement)) return link;
  }
  throw new Error("Book link was not reachable by Tab");
}

test("keyboard focus reveals actions and outlines the book in the accent colour", async ({
  page,
}) => {
  const link = await tabToBook(page);
  await expect(menuButton(page)).toHaveCSS("opacity", "1");
  const outline = await link.evaluate((el) => {
    const style = getComputedStyle(el);
    const probe = document.createElement("span");
    probe.style.color = "var(--action-accent)";
    el.append(probe);
    const accent = getComputedStyle(probe).color;
    probe.remove();
    return { style: style.outlineStyle, color: style.outlineColor, accent };
  });
  expect(outline.style).not.toBe("none");
  expect(outline.color).toBe(outline.accent);
  await page.keyboard.press("Tab");
  await expect(menuButton(page)).toBeFocused();
  await expect(menuButton(page)).toHaveCSS("opacity", "1");
});

test("hover raises the cover", async ({ page }) => {
  const cover = entry(page).getByRole("link").locator("div").first();
  const elevation = () =>
    cover.evaluate((el) => {
      const style = getComputedStyle(el);
      return `${style.boxShadow} ${style.transform}`;
    });
  const rest = await elevation();
  await entry(page).hover();
  await expect.poll(elevation).not.toBe(rest);
});

for (const dismissal of ["Escape", "outside click"]) {
  test(`${dismissal} dismisses the menu and restores its trigger`, async ({
    page,
  }) => {
    await entry(page).hover();
    await menuButton(page).click();
    await expect(page.getByRole("menuitem", { name: "Delete" })).toBeFocused();
    if (dismissal === "Escape") {
      await page.keyboard.press("Escape");
    } else {
      await page.getByRole("heading", { name: "Library", exact: true }).click();
    }
    await expect(page.getByRole("menu")).toBeHidden();
    await expect(menuButton(page)).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("menu")).toBeVisible();
  });
}

test("opening another card's menu leaves focus in that menu", async ({
  page,
}) => {
  await page
    .getByLabel("Import an EPUB")
    .setInputFiles(
      path.join(
        books,
        "robert-louis-stevenson_the-strange-case-of-dr-jekyll-and-mr-hyde.epub",
      ),
    );
  const items = page
    .getByRole("list", { name: "All books" })
    .getByRole("listitem");
  await expect(items).toHaveCount(2);
  const triggers = page.getByRole("button", { name: /^More actions for / });
  await triggers.nth(0).click();
  await expect(page.getByRole("menu")).toHaveCount(1);
  await triggers.nth(1).click();
  await expect(page.getByRole("menu")).toHaveCount(1);
  await expect(page.getByRole("menuitem", { name: "Delete" })).toBeFocused();
  await expect(triggers.nth(0)).toHaveAttribute("aria-expanded", "false");
  await expect(triggers.nth(1)).toHaveAttribute("aria-expanded", "true");
});

test.describe("touch-only device", () => {
  test.use({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  });

  test("actions stay visible and tapping Delete asks for confirmation", async ({
    page,
  }) => {
    expect(await page.evaluate(() => matchMedia("(hover: none)").matches)).toBe(
      true,
    );
    await expect(menuButton(page)).toHaveCSS("opacity", "1");
    await menuButton(page).tap();
    await page.getByRole("menuitem", { name: "Delete" }).tap();
    await expect(page.getByRole("menu")).toBeHidden();
    await expect(
      page.getByRole("dialog", { name: "Delete book" }),
    ).toBeVisible();
  });
});
