import path from "node:path";
import {
  test as base,
  expect,
  type Locator,
  type Page,
  type Request,
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
    .getByRole("list", { name: "Library" })
    .getByRole("listitem")
    .filter({ hasText: title });
}

function isDelete(request: Request): boolean {
  return (
    request.method() === "DELETE" &&
    /\/api\/books\/\d+$/.test(new URL(request.url()).pathname)
  );
}

async function importTimeMachine(page: Page) {
  await page
    .getByLabel("Import an EPUB")
    .setInputFiles(path.join(books, "h-g-wells_the-time-machine.epub"));
  await expect(page.getByRole("status")).toHaveText(`Imported ${title}.`);
  await expect(entry(page)).toHaveCount(1);
}

async function expectCover(page: Page) {
  const img = entry(page).locator("img");
  await expect(img).toHaveCount(1);
  await expect
    .poll(() => img.evaluate((el: HTMLImageElement) => el.naturalWidth))
    .toBeGreaterThan(0);
}

// Opens the confirmation for the book and returns the dialog.
async function askToDelete(page: Page, keyboard = false): Promise<Locator> {
  const button = entry(page).getByRole("button", {
    name: `More actions for ${title}`,
  });
  if (keyboard) {
    await expect(button).toBeFocused();
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");
  } else {
    await entry(page).hover();
    await button.click();
    await page.getByRole("menuitem", { name: "Delete", exact: true }).click();
  }
  const dialog = page.getByRole("dialog", { name: "Delete book" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText(title);
  return dialog;
}

async function signedIn(page: Page) {
  const setup = await page.request.post("/api/setup", {
    data: { username: "reader", password: "delete password" },
  });
  expect(setup.status()).toBe(201);
  await page.goto("/");
}

test("a book is deleted after confirming, and cancelling keeps it", async ({
  page,
}) => {
  await signedIn(page);
  await importTimeMachine(page);
  await expectCover(page);
  const deletes: Request[] = [];
  page.on("request", (request) => {
    if (isDelete(request)) {
      deletes.push(request);
    }
  });

  let dialog = await askToDelete(page);
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();
  await expect(entry(page)).toHaveCount(1);
  dialog = await askToDelete(page, true);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(entry(page)).toHaveCount(1);
  expect(deletes).toEqual([]);

  dialog = await askToDelete(page, true);
  const answered = page.waitForResponse((res) => isDelete(res.request()));
  await dialog.getByRole("button", { name: "Delete", exact: true }).click();
  expect((await answered).status()).toBe(204);
  await expect(dialog).toBeHidden();
  await expect(entry(page)).toHaveCount(0);
  await expect(
    page.getByText("No books yet. Import an EPUB to start reading."),
  ).toBeVisible();
  await expect(page.getByRole("status")).toHaveText(`Deleted ${title}.`);
  expect(deletes).toHaveLength(1);

  await page.reload();
  await expect(
    page.getByText("No books yet. Import an EPUB to start reading."),
  ).toBeVisible();

  await importTimeMachine(page);
  await expectCover(page);
});

test("a failed delete keeps the book listed and says so", async ({ page }) => {
  await signedIn(page);
  await importTimeMachine(page);
  await page.route(/\/api\/books\/\d+$/, (route) =>
    route.request().method() === "DELETE"
      ? route.fulfill({ status: 500, json: { error: "internal server error" } })
      : route.fallback(),
  );

  const dialog = await askToDelete(page);
  await dialog.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveText(
    `${title} could not be deleted (500). Please try again.`,
  );
  await expect(entry(page)).toHaveCount(1);
  await page.reload();
  await expect(entry(page)).toHaveCount(1);
});

test("a book the server no longer has leaves the library", async ({ page }) => {
  await signedIn(page);
  await importTimeMachine(page);
  const id = await entry(page)
    .getByRole("link")
    .evaluate((a: HTMLAnchorElement) => /\/books\/(\d+)\//.exec(a.href)?.[1]);
  const gone = await page.request.delete(`/api/books/${id}`);
  expect(gone.status()).toBe(204);

  const dialog = await askToDelete(page);
  const answered = page.waitForResponse((res) => isDelete(res.request()));
  await dialog.getByRole("button", { name: "Delete", exact: true }).click();
  expect((await answered).status()).toBe(404);
  await expect(entry(page)).toHaveCount(0);
  await expect(page.getByRole("alert")).toHaveCount(0);
});
