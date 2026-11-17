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

function entry(page: Page, bookTitle = title): Locator {
  return page
    .getByRole("list", { name: "Library" })
    .getByRole("listitem")
    .filter({ hasText: bookTitle });
}

function isDelete(request: Request): boolean {
  return (
    request.method() === "DELETE" &&
    /\/api\/books\/[^/]+$/.test(new URL(request.url()).pathname)
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
async function askToDelete(
  page: Page,
  keyboard = false,
  bookTitle = title,
): Promise<Locator> {
  const button = entry(page, bookTitle).getByRole("button", {
    name: `More actions for ${bookTitle}`,
  });
  if (keyboard) {
    await expect(button).toBeFocused();
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");
  } else {
    await entry(page, bookTitle).hover();
    await button.click();
    await page.getByRole("menuitem", { name: "Delete", exact: true }).click();
  }
  const dialog = page.getByRole("dialog", { name: "Delete book" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText(bookTitle);
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
  await expect(dialog.getByRole("checkbox")).toHaveCount(0);
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
  await page.route(/\/api\/books\/[^/]+$/, (route) =>
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
    .evaluate((a: HTMLAnchorElement) => /\/books\/([^/]+)\//.exec(a.href)?.[1]);
  const gone = await page.request.delete(`/api/books/${id}`);
  expect(gone.status()).toBe(204);

  const dialog = await askToDelete(page);
  const answered = page.waitForResponse((res) => isDelete(res.request()));
  await dialog.getByRole("button", { name: "Delete", exact: true }).click();
  expect((await answered).status()).toBe(404);
  await expect(entry(page)).toHaveCount(0);
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("a book imported after another was deleted never shows the deleted book's text", async ({
  page,
}) => {
  await signedIn(page);
  const a = { file: "chapters.epub", title: "A Hand-Made Book of Chapters" };
  const b = { file: "reader.epub", title: "A Hand-Made Reading Book" };
  const item = (t: string) =>
    page
      .getByRole("list", { name: "Library" })
      .getByRole("listitem")
      .filter({ hasText: t });
  const importFile = async (book: { file: string; title: string }) => {
    await page
      .getByLabel("Import an EPUB")
      .setInputFiles(path.join(books, book.file));
    await expect(page.getByRole("status")).toHaveText(
      `Imported ${book.title}.`,
    );
  };
  const article = page.locator("article#tomeshelf-content");

  await importFile(a);
  await page.getByRole("link", { name: new RegExp(a.title) }).click();
  await expect(article).toContainText("CHAPTER I.");
  const idA = new URL(page.url()).pathname.split("/")[2];
  await page.getByRole("link", { name: "Library", exact: true }).click();

  await item(a.title).hover();
  await item(a.title)
    .getByRole("button", { name: `More actions for ${a.title}` })
    .click();
  await page.getByRole("menuitem", { name: "Delete", exact: true }).click();
  await page
    .getByRole("dialog", { name: "Delete book" })
    .getByRole("button", { name: "Delete", exact: true })
    .click();
  await expect(item(a.title)).toHaveCount(0);

  await importFile(b);
  await page.getByRole("link", { name: new RegExp(b.title) }).click();
  await expect(article).toContainText("Document One");
  await expect(article).not.toContainText("CHAPTER I.");
  const idB = new URL(page.url()).pathname.split("/")[2];
  expect(idB).not.toBe(idA);
});

for (const keep of [true, false]) {
  test(`deleting with keep position ${keep} controls progress and resume after reimport`, async ({
    page,
  }) => {
    await signedIn(page);
    const bookTitle = "A Hand-Made Book of Chapters";
    const importBook = async () => {
      await page
        .getByLabel("Import an EPUB")
        .setInputFiles(path.join(books, "chapters.epub"));
      await expect(page.getByRole("status")).toHaveText(
        `Imported ${bookTitle}.`,
      );
    };
    await importBook();
    await entry(page, bookTitle).getByRole("link").click();
    await expect(page).toHaveURL(/\/read\/1$/);
    const id = new URL(page.url()).pathname.split("/")[2];
    const saved = page.waitForResponse(
      (res) =>
        res.request().method() === "PUT" && res.url().endsWith("/position"),
    );
    await page
      .getByRole("navigation", { name: "Reading order" })
      .getByRole("button", { name: "Next" })
      .click();
    expect((await saved).status()).toBe(204);
    const position = await (
      await page.request.get(`/api/books/${id}/position`)
    ).json();
    expect(position.locations.progression).toBeGreaterThan(0);
    await page.getByRole("link", { name: "Library", exact: true }).click();
    const progress = entry(page, bookTitle).getByRole("progressbar");
    const value = await progress.getAttribute("aria-valuenow");
    await expect(
      page.getByRole("region", { name: "Continue reading" }),
    ).toBeVisible();
    let dialog = await askToDelete(page, false, bookTitle);
    let checkbox = dialog.getByRole("checkbox", {
      name: "Keep my reading position for when I import this book again",
    });
    await expect(checkbox).not.toBeChecked();
    await checkbox.focus();
    await page.keyboard.press("Space");
    await expect(checkbox).toBeChecked();
    const deletes: Request[] = [];
    page.on("request", (req) => {
      if (isDelete(req)) deletes.push(req);
    });
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toBeHidden();
    await expect(entry(page, bookTitle)).toHaveCount(1);
    expect(deletes).toHaveLength(0);
    dialog = await askToDelete(page, false, bookTitle);
    checkbox = dialog.getByRole("checkbox");
    await expect(checkbox).not.toBeChecked();
    if (keep) await checkbox.check();
    const deleted = page.waitForResponse((res) => isDelete(res.request()));
    await dialog.getByRole("button", { name: "Delete", exact: true }).click();
    expect((await deleted).status()).toBe(204);
    expect(new URL(deletes[0].url()).search).toBe(
      keep ? "?keepPosition=true" : "",
    );
    await expect(entry(page, bookTitle)).toHaveCount(0);
    await expect(
      page.getByRole("region", { name: "Continue reading" }),
    ).toHaveCount(0);
    await importBook();
    if (keep) {
      await expect(progress).toHaveAttribute("aria-valuenow", value ?? "");
      await expect(
        page.getByRole("region", { name: "Continue reading" }),
      ).toBeVisible();
    } else {
      await expect(progress).toHaveCount(0);
      await expect(
        page.getByRole("region", { name: "Continue reading" }),
      ).toHaveCount(0);
    }
    await entry(page, bookTitle).getByRole("link").click();
    await expect(page).toHaveURL(new RegExp(`/books/${id}/read/1$`));
    const offset = () =>
      page.locator("#tomeshelf-content").evaluate((el) => el.scrollLeft);
    if (keep) await expect.poll(offset).toBeGreaterThan(0);
    else await expect.poll(offset).toBe(0);
    if (keep) {
      const visible = await page
        .locator("#tomeshelf-content")
        .evaluate((el, selector) => {
          const block = el.querySelector(selector);
          if (!block) return false;
          const box = el.getBoundingClientRect();
          const at = block.getBoundingClientRect();
          return at.right > box.left && at.left < box.right;
        }, position.locations.cssSelector);
      expect(visible).toBe(true);
    }
  });
}
