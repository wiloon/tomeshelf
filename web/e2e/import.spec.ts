import path from "node:path";
import { test as base, expect } from "@playwright/test";
import { maxBookMB, startServer, type TestServer } from "./server";

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

test("import EPUBs into the library and see the refusals", async ({ page }) => {
  const setup = await page.request.post("/api/setup", {
    data: { username: "reader", password: "import password" },
  });
  expect(setup.status()).toBe(201);
  await page.goto("/");

  const importControl = page.getByLabel("Import an EPUB");
  const library = page.getByRole("list", { name: "Library" });
  const entries = library.getByRole("listitem");
  const expectOneEntry = async () => {
    await expect(entries).toHaveCount(1);
    await expect(entries).toContainText("A Hand-Made EPUB 3");
    await expect(entries).toContainText("Ada Fixture, Bo Example");
  };

  await expect(page.getByText("No books yet.")).toBeVisible();
  await importControl.setInputFiles(path.join(books, "epub3.epub"));
  await expect(page.getByRole("status")).toHaveText(
    "Imported A Hand-Made EPUB 3.",
  );
  await expectOneEntry();

  await page.reload();
  await expectOneEntry();

  await importControl.setInputFiles(path.join(books, "epub3.epub"));
  await expect(page.getByRole("alert")).toHaveText(
    "This book is already in the library.",
  );
  await expectOneEntry();

  await importControl.setInputFiles(path.join(books, "adept.epub"));
  await expect(page.getByRole("alert")).toHaveText(
    "This book is DRM-encrypted, and DRM is not supported.",
  );
  await expectOneEntry();

  await importControl.setInputFiles(path.join(books, "broken.epub"));
  await expect(page.getByRole("alert")).toContainText(
    "The file could not be read as an EPUB: ",
  );
  await expect(page.getByRole("alert")).toContainText("XML syntax error");
  await expectOneEntry();

  await importControl.setInputFiles({
    name: "too-big.epub",
    mimeType: "application/epub+zip",
    buffer: Buffer.alloc(maxBookMB * 1024 * 1024 + 1),
  });
  await expect(page.getByRole("alert")).toHaveText(
    `The file is larger than the ${maxBookMB} MB limit.`,
  );
  await expectOneEntry();
});
