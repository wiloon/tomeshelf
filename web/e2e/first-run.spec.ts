import { test as base, expect } from "@playwright/test";
import { startServer, type TestServer } from "./server";

// Every attempt, retries included, gets its own server before setup.
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

const admin = { username: "first-admin", password: "first-run password" };

test("first run: setup, sign out, sign in", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/setup$/);
  await expect(page.locator("[aria-haspopup=menu]")).toHaveCount(0);

  await page.getByLabel("Username").fill(admin.username);
  await page.getByLabel("Password").fill(admin.password);
  await page.getByRole("button", { name: "Create admin" }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(
    page.getByRole("button", { name: admin.username, exact: true }),
  ).toBeVisible();

  await page.getByRole("button", { name: admin.username, exact: true }).click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/signin$/);
  await page.goto("/");
  await expect(page).toHaveURL(/\/signin$/);
  await expect(page.locator("[aria-haspopup=menu]")).toHaveCount(0);

  await page.getByLabel("Username").fill(admin.username);
  await page.getByLabel("Password").fill("wrong password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("alert")).toHaveText(
    "Wrong username or password.",
  );
  await expect(page).toHaveURL(/\/signin$/);

  await page.getByLabel("Password").fill(admin.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(
    page.getByRole("heading", { level: 1, name: "Tomeshelf", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: admin.username, exact: true }),
  ).toBeVisible();
});

test("a failed sign-out stays signed in and shows the error", async ({
  page,
}) => {
  await page.goto("/setup");
  await page.getByLabel("Username").fill(admin.username);
  await page.getByLabel("Password").fill(admin.password);
  await page.getByRole("button", { name: "Create admin" }).click();
  await expect(
    page.getByRole("button", { name: admin.username, exact: true }),
  ).toBeVisible();

  await page.route("**/api/session", (route) =>
    route.request().method() === "DELETE"
      ? route.fulfill({ status: 500 })
      : route.continue(),
  );
  await page.getByRole("button", { name: admin.username, exact: true }).click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  await expect(page.getByRole("menu").getByRole("alert")).toHaveText(
    "Could not sign out (500). Please try again.",
  );
  await expect(page).toHaveURL(/\/$/);
  await expect(
    page.getByRole("button", { name: admin.username, exact: true }),
  ).toBeVisible();
});
