import path from "node:path";
import { test as base, expect } from "@playwright/test";
import { startServer, type TestServer } from "./server";

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

for (const width of [390, 1280]) {
  test.describe(`${width}px`, () => {
    test.use({ viewport: { width, height: 800 } });

    test("account menu supports pointer and keyboard in the library and reader", async ({
      page,
    }) => {
      await page.request.post("/api/setup", {
        data: { username: "reader", password: "reader password" },
      });
      await page.goto("/");
      const button = page.getByRole("button", { name: "reader", exact: true });
      const menu = page.getByRole("menu");
      const signOut = page.getByRole("menuitem", { name: "Sign out" });
      await expect(
        page.locator("main").getByRole("heading").first(),
      ).toHaveText("Library");
      await expect(page.getByText(/Signed in as/)).toHaveCount(0);
      await expect(button).toHaveAttribute("aria-haspopup", "menu");
      await button.click();
      await expect(signOut).toBeFocused();
      await page
        .getByRole("heading", { name: "tomeshelf", exact: true })
        .click();
      await expect(menu).toBeHidden();
      await expect(button).toBeFocused();
      for (const key of ["Enter", "Space", "ArrowDown"]) {
        await button.focus();
        await button.press(key);
        await expect(button).toHaveAttribute("aria-expanded", "true");
        await expect(signOut).toBeFocused();
        await page.keyboard.press("Escape");
        await expect(menu).toBeHidden();
        await expect(button).toBeFocused();
      }
      await button.press("Enter");
      await page.keyboard.press("Tab");
      await expect(button).toHaveAttribute("aria-expanded", "false");
      await expect(menu).toBeHidden();
      await page
        .getByLabel("Import an EPUB")
        .setInputFiles(
          path.resolve(import.meta.dirname, "../../testdata/books/reader.epub"),
        );
      await page
        .getByRole("link", { name: /A Hand-Made Reading Book/ })
        .click();
      await expect(page.locator("article#tomeshelf-content")).toBeVisible();
      await expect(button).toBeVisible();
      await button.focus();
      await button.press("Enter");
      await expect(signOut).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(page).toHaveURL(/\/signin$/);
      await expect(button).toHaveCount(0);
    });

    test("long username and sign-out error fit a single-line header", async ({
      page,
    }) => {
      const username = "u".repeat(200);
      await page.request.post("/api/setup", {
        data: { username, password: "reader password" },
      });
      await page.goto("/");
      const button = page.getByRole("button", { name: username, exact: true });
      const headerHeight = await page
        .locator("header")
        .evaluate((el) => el.clientHeight);
      await expect(button).toBeVisible();
      await page.route("**/api/session", (route) =>
        route.fulfill({ status: 500 }),
      );
      await button.click();
      await page.getByRole("menuitem", { name: "Sign out" }).click();
      await expect(page.getByRole("menu").getByRole("alert")).toHaveText(
        "Could not sign out (500). Please try again.",
      );
      expect(
        await page.evaluate(
          () =>
            document.documentElement.scrollWidth <=
            document.documentElement.clientWidth,
        ),
      ).toBe(true);
      expect(
        await page.locator("header").evaluate((el) => el.clientHeight),
      ).toBe(headerHeight);
      expect(headerHeight).toBeLessThan(70);
      expect(
        await button.evaluate((el) => el.scrollWidth > el.clientWidth),
      ).toBe(true);
    });
  });
}
