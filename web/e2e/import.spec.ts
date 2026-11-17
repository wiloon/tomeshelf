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

  await expect(
    page.getByText("No books yet. Import an EPUB to start reading."),
  ).toBeVisible();
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

for (const activation of ["pointer", "Enter", "Space"]) {
  test(`Import EPUB opens the chooser with ${activation}`, async ({ page }) => {
    await page.request.post("/api/setup", {
      data: { username: "reader", password: "import password" },
    });
    await page.goto("/");
    const button = page.getByRole("button", {
      name: "Import EPUB",
      exact: true,
    });
    await expect(button).toBeVisible();
    const chooserOpened = page.waitForEvent("filechooser");
    if (activation === "pointer") {
      await button.click();
    } else {
      await button.focus();
      await button.press(activation);
    }
    const chooser = await chooserOpened;
    expect(await chooser.element().getAttribute("accept")).toBe(
      ".epub,application/epub+zip",
    );
    await chooser.setFiles(path.join(books, "epub3.epub"));
    await expect(page.getByRole("status")).toHaveText(
      "Imported A Hand-Made EPUB 3.",
    );
  });
}

test("Import EPUB reports busy state and recovers after success and refusal", async ({
  page,
}) => {
  await page.request.post("/api/setup", {
    data: { username: "reader", password: "import password" },
  });
  await page.goto("/");
  for (const file of ["epub3.epub", "broken.epub"]) {
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route("**/api/books", async (route) => {
      if (route.request().method() === "POST") await held;
      await route.continue();
    });
    await page
      .getByLabel("Import an EPUB")
      .setInputFiles(path.join(books, file));
    const busy = page.getByRole("button", { name: /importing/i });
    await expect(busy).toBeDisabled();
    await expect(busy).toHaveText(/importing/i);
    release();
    await expect(
      page.getByRole("button", { name: "Import EPUB", exact: true }),
    ).toBeEnabled();
    if (file === "epub3.epub") {
      await expect(page.getByRole("status")).toHaveText(
        "Imported A Hand-Made EPUB 3.",
      );
    } else {
      await expect(page.getByRole("alert")).toContainText(
        "The file could not be read as an EPUB:",
      );
    }
    await page.unroute("**/api/books");
  }
});

test("library heading has an accessible primary action without mobile overflow", async ({
  page,
}) => {
  await page.request.post("/api/setup", {
    data: { username: "reader", password: "import password" },
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  const button = page.getByRole("button", { name: "Import EPUB", exact: true });
  const input = page.getByLabel("Import an EPUB");
  // The labelled native control remains available, but is visually clipped.
  await expect(input).toHaveCSS("position", "absolute");
  await expect(input).toHaveCSS("clip-path", "inset(50%)");
  await expect(input).not.toHaveCSS("display", "none");
  for (const populated of [false, true]) {
    if (populated) {
      await input.setInputFiles(path.join(books, "epub3.epub"));
      await expect(page.getByRole("list", { name: "Library" })).toBeVisible();
    }
    expect(
      await page.evaluate(
        () =>
          document.documentElement.scrollWidth <=
          document.documentElement.clientWidth,
      ),
    ).toBe(true);
    const heading = await page
      .getByRole("heading", { name: "Library", exact: true })
      .boundingBox();
    const action = await button.boundingBox();
    expect(heading).not.toBeNull();
    expect(action).not.toBeNull();
    if (!heading || !action)
      throw new Error("Missing library heading or action");
    expect(action.x).toBeGreaterThan(heading.x + heading.width);
    expect(heading.y).toBeGreaterThanOrEqual(action.y);
    expect(heading.y + heading.height).toBeLessThanOrEqual(
      action.y + action.height,
    );
  }
  for (const theme of ["light", "dark", "sepia"]) {
    await page.evaluate((value) => {
      document.documentElement.dataset.readingTheme = value;
    }, theme);
    const ratio = await button.evaluate((element) => {
      const style = getComputedStyle(element);
      const luminance = (color: string) => {
        // Canvas resolves CSS colours (including oklch) into sRGB bytes.
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = 1;
        const context = canvas.getContext("2d");
        if (!context) throw new Error("No canvas context");
        context.fillStyle = color;
        context.fillRect(0, 0, 1, 1);
        const channels = [...context.getImageData(0, 0, 1, 1).data]
          .slice(0, 3)
          .map((byte) => {
            const value = byte / 255;
            return value <= 0.04045
              ? value / 12.92
              : ((value + 0.055) / 1.055) ** 2.4;
          });
        return (
          channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722
        );
      };
      const fg = luminance(style.color);
      const bg = luminance(style.backgroundColor);
      return (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05);
    });
    console.log(`${theme} import button contrast: ${ratio.toFixed(2)}:1`);
    expect(ratio).toBeGreaterThanOrEqual(4.5);
  }
});
