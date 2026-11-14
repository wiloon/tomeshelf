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

  await page.getByLabel("Username").fill(admin.username);
  await page.getByLabel("Password").fill(admin.password);
  await page.getByRole("button", { name: "Create admin" }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByText(`Signed in as ${admin.username}`)).toBeVisible();

  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/signin$/);
  await page.goto("/");
  await expect(page).toHaveURL(/\/signin$/);

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
    page.getByRole("heading", { level: 1, name: "tomeshelf" }),
  ).toBeVisible();
  await expect(page.getByText(`Signed in as ${admin.username}`)).toBeVisible();
});
