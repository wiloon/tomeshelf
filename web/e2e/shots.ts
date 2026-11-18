// Helpers for throwaway screenshot scripts run with `task shots`; see
// docs/agents/screenshots.md. Node runs those scripts without a bundler, so
// relative imports here keep their .ts extension.
import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { type Browser, chromium, type Page } from "@playwright/test";
import { startServer, type TestServer } from "./server.ts";

export type Shots = {
  server: TestServer;
  browser: Browser;
  page: Page;
  close: () => Promise<void>;
};

export type ShootOptions = {
  // Shoot the whole page instead of the viewport.
  fullPage?: boolean;
  // Scroll to the bottom of the page first, where previous/next live.
  scrollToBottom?: boolean;
  // Wait for every <img> to load or fail. Fonts are always awaited.
  waitForImages?: boolean;
  imageTimeoutMs?: number;
};

const viewports = [
  { width: 390, height: 844 },
  { width: 1280, height: 800 },
];

const books = path.resolve(import.meta.dirname, "../../testdata/books");

function shotsDir(): string {
  return (
    process.env.SHOTS_DIR ||
    path.resolve(import.meta.dirname, "../../tmp/shots")
  );
}

// Starts the built binary on a fresh data directory, opens a browser page
// at device scale 2, and signs it in as an admin created through first-run
// setup. close stops the browser and the server.
export async function openShots(): Promise<Shots> {
  const server = await startServer();
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch();
    const context = await browser.newContext({
      baseURL: server.url,
      viewport: viewports[0],
      deviceScaleFactor: 2,
    });
    const page = await context.newPage();
    const setup = await page.request.post("/api/setup", {
      data: { username: "admin", password: randomBytes(24).toString("hex") },
    });
    if (setup.status() !== 201) {
      throw new Error(`setup answered ${setup.status()}`);
    }
    await page.goto("/");
    const opened = browser;
    return {
      server,
      browser: opened,
      page,
      close: async () => {
        await opened.close();
        await server.stop();
      },
    };
  } catch (err) {
    await browser?.close();
    await server.stop();
    throw err;
  }
}

// Imports the named files from testdata/books through the library's import
// control, one at a time, and waits for each to show in the library.
export async function importBooks(page: Page, ...files: string[]) {
  if (new URL(page.url()).pathname !== "/") {
    await page.goto("/");
  }
  for (const file of files) {
    const answered = page.waitForResponse(
      (res) =>
        new URL(res.url()).pathname === "/api/books" &&
        res.request().method() === "POST",
    );
    await page
      .getByLabel("Import an EPUB")
      .setInputFiles(path.join(books, file));
    await answered;
    const outcome = page.getByRole("status").or(page.getByRole("alert"));
    await outcome.first().waitFor();
    const text = (await outcome.first().textContent()) ?? "";
    const title = /^Imported (.+)\.$/.exec(text)?.[1];
    if (!title) {
      throw new Error(`importing ${file}: ${text}`);
    }
    await page
      .getByRole("list", { name: "All books" })
      .getByRole("listitem")
      .filter({ hasText: title })
      .first()
      .waitFor();
  }
}

// Waits until every <img> on the page has loaded or failed, then one more
// frame so a replacement for a failed image renders. Returns the URLs of
// the images still pending after timeoutMs.
async function settleImages(page: Page, timeoutMs: number): Promise<string[]> {
  return page.evaluate(async (timeoutMs) => {
    const frame = () =>
      new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const pending = () =>
      Array.from(document.images)
        .filter((img) => !img.complete)
        .map((img) => img.currentSrc || img.src);
    const deadline = performance.now() + timeoutMs;
    for (;;) {
      await frame();
      if (pending().length === 0) {
        await frame();
        if (pending().length === 0) {
          return [];
        }
      }
      if (performance.now() >= deadline) {
        return pending();
      }
    }
  }, timeoutMs);
}

// Shoots the page's current state at 390 and 1280 px and writes
// `<name>-390.png` and `<name>-1280.png` to $SHOTS_DIR (default tmp/shots),
// only once both are captured.
export async function shoot(
  page: Page,
  name: string,
  options: ShootOptions = {},
): Promise<string[]> {
  const {
    fullPage = false,
    scrollToBottom = false,
    waitForImages = true,
    imageTimeoutMs = 10_000,
  } = options;
  const scale = await page.evaluate(() => window.devicePixelRatio);
  if (scale !== 2) {
    throw new Error(`shoot needs device scale 2, the page has ${scale}`);
  }
  const original = page.viewportSize();
  const captured: { file: string; png: Buffer }[] = [];
  try {
    for (const viewport of viewports) {
      await page.setViewportSize(viewport);
      await page.evaluate(async () => {
        await document.fonts.ready;
      });
      if (waitForImages) {
        const pending = await settleImages(page, imageTimeoutMs);
        if (pending.length > 0) {
          throw new Error(
            `${name} at ${viewport.width} px: images still loading after ${imageTimeoutMs} ms: ${pending.join(", ")}`,
          );
        }
      }
      if (scrollToBottom) {
        await page.evaluate(() =>
          window.scrollTo(0, document.documentElement.scrollHeight),
        );
      }
      captured.push({
        file: path.join(shotsDir(), `${name}-${viewport.width}.png`),
        png: await page.screenshot({ fullPage }),
      });
    }
  } finally {
    if (original) {
      await page.setViewportSize(original);
    }
  }
  await mkdir(shotsDir(), { recursive: true });
  for (const { file, png } of captured) {
    await writeFile(file, png);
  }
  return captured.map(({ file }) => file);
}
