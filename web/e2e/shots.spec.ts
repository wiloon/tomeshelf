import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test as base, expect, type Page, type Route } from "@playwright/test";
import { importBooks, openShots, type Shots, shoot } from "./shots";

const test = base.extend<{ shotsDir: string; shots: Shots }>({
  // biome-ignore lint/correctness/noEmptyPattern: Playwright requires a destructured first argument.
  shotsDir: async ({}, use) => {
    const dir = await mkdtemp(path.join(tmpdir(), "tomeshelf-shots-"));
    process.env.SHOTS_DIR = dir;
    await use(dir);
    delete process.env.SHOTS_DIR;
    await rm(dir, { recursive: true, force: true });
  },
  shots: async ({ shotsDir: _ }, use) => {
    const shots = await openShots();
    await use(shots);
    await shots.page.unrouteAll({ behavior: "ignoreErrors" });
    await shots.close();
  },
});

const thumbnailURL = /\/api\/books\/[^/]+\/thumbnail$/;

async function pngs(dir: string): Promise<string[]> {
  const names = await readdir(dir).catch(() => []);
  return names.filter((name) => name.endsWith(".png")).sort();
}

// Decodes each PNG in a blank page and expects it at the device-scale-2
// width of its shot width.
async function expectShots(page: Page, dir: string, slug: string) {
  const names = (await pngs(dir)).filter((name) => name.startsWith(slug));
  expect(names).toEqual([`${slug}-1280.png`, `${slug}-390.png`]);
  const blank = await page.context().newPage();
  for (const [name, width] of [
    [`${slug}-390.png`, 780],
    [`${slug}-1280.png`, 2560],
  ] as const) {
    const data = (await readFile(path.join(dir, name))).toString("base64");
    const decoded = await blank.evaluate(async (src) => {
      const img = new Image();
      img.src = src;
      await img.decode();
      return img.naturalWidth;
    }, `data:image/png;base64,${data}`);
    expect(decoded, name).toBe(width);
  }
  await blank.close();
}

// Holds every request matching url until release is called, and reports
// the first held request's URL.
async function hold(page: Page, url: string | RegExp) {
  let release = () => {};
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let seen: (url: string) => void = () => {};
  const firstURL = new Promise<string>((resolve) => {
    seen = resolve;
  });
  await page.route(url, async (route: Route) => {
    seen(route.request().url());
    await released;
    await route.continue().catch(() => {});
  });
  return { release, firstURL };
}

test("shoots the reader at 390 and 1280 px", async ({ shots, shotsDir }) => {
  const { page } = shots;
  const settings = await page.request.put("/api/settings", {
    data: {
      fontSize: 18,
      lineHeight: 1.6,
      width: 38,
      theme: "light",
      layout: "scroll",
      font: "default",
      wheelTurnsPages: true,
      repeatedLines: 1,
    },
  });
  expect(settings.status()).toBe(204);
  await importBooks(page, "reader.epub");
  await page.getByRole("link", { name: /A Hand-Made Reading Book/ }).click();
  await expect(page.locator("article#tomeshelf-content")).toContainText(
    "Document One",
  );

  await shoot(page, "01-reader");
  await expectShots(page, shotsDir, "01-reader");

  await shoot(page, "02-reader-bottom", {
    fullPage: true,
    scrollToBottom: true,
  });
  await expectShots(page, shotsDir, "02-reader-bottom");
});

test("waits for a held image before shooting", async ({ shots, shotsDir }) => {
  const { page } = shots;
  await importBooks(page, "h-g-wells_the-time-machine.epub");
  const thumbnail = await hold(page, thumbnailURL);
  await page.reload();
  await thumbnail.firstURL;

  let settled = false;
  const shot = shoot(page, "01-library").finally(() => {
    settled = true;
  });
  await page.waitForTimeout(1500);
  expect(settled).toBe(false);
  expect(await pngs(shotsDir)).toEqual([]);

  thumbnail.release();
  await shot;
  await expectShots(page, shotsDir, "01-library");
});

test("captures the bottom after a held image expands the page", async ({
  shots,
  shotsDir,
}) => {
  const { page } = shots;
  let release = () => {};
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let seen = () => {};
  const requested = new Promise<void>((resolve) => {
    seen = resolve;
  });
  await page.route("**/expanding-image.svg", async (route) => {
    seen();
    await released;
    await route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="2000"></svg>',
    });
  });
  await page.evaluate(() => {
    const img = document.createElement("img");
    img.src = "/expanding-image.svg";
    const marker = document.createElement("div");
    marker.style.cssText = "height: 100px; background: rgb(255, 0, 0)";
    document.body.replaceChildren(img, marker);
  });
  await requested;
  const shot = shoot(page, "bottom-after-image", { scrollToBottom: true });
  await page.waitForTimeout(300);
  release();
  await shot;

  const blank = await page.context().newPage();
  for (const width of [390, 1280]) {
    const data = (
      await readFile(path.join(shotsDir, `bottom-after-image-${width}.png`))
    ).toString("base64");
    const pixel = await blank.evaluate(async (src) => {
      const img = new Image();
      img.src = src;
      await img.decode();
      const canvas = document.createElement("canvas");
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("Canvas context unavailable");
      ctx.drawImage(img, 0, 0);
      return Array.from(
        ctx.getImageData(canvas.width / 2, canvas.height - 40, 1, 1).data,
      );
    }, `data:image/png;base64,${data}`);
    expect(pixel, `${width} px bottom marker`).toEqual([255, 0, 0, 255]);
  }
  await blank.close();
});

test("shoots a failed image's placeholder", async ({ shots, shotsDir }) => {
  const { page } = shots;
  await importBooks(page, "epub3.epub");
  await expect(page.getByTestId("cover-placeholder")).toBeVisible();

  await shoot(page, "01-placeholder");
  await expectShots(page, shotsDir, "01-placeholder");
});

test("rejects naming the image still pending after the timeout", async ({
  shots,
  shotsDir,
}) => {
  const { page } = shots;
  await importBooks(page, "h-g-wells_the-time-machine.epub");
  const thumbnail = await hold(page, thumbnailURL);
  await page.reload();
  const url = await thumbnail.firstURL;

  await expect(
    shoot(page, "01-timeout", { imageTimeoutMs: 1000 }),
  ).rejects.toThrow(url);
  expect(await pngs(shotsDir)).toEqual([]);
});

test("writes nothing when the timeout hits at the second width", async ({
  shots,
  shotsDir,
}) => {
  const { page } = shots;
  const held = await hold(page, "**/held-by-test.png");
  await page.evaluate(() => {
    const wide = matchMedia("(min-width: 1000px)");
    wide.addEventListener("change", (event) => {
      if (event.matches) {
        const img = document.createElement("img");
        img.src = "/held-by-test.png";
        document.body.append(img);
      }
    });
  });

  await expect(
    shoot(page, "01-second-width", { imageTimeoutMs: 1000 }),
  ).rejects.toThrow("/held-by-test.png");
  expect(await held.firstURL).toMatch(/\/held-by-test\.png$/);
  expect(await pngs(shotsDir)).toEqual([]);
});

test("shoots without waiting for images when told to", async ({
  shots,
  shotsDir,
}) => {
  const { page } = shots;
  await importBooks(page, "h-g-wells_the-time-machine.epub");
  const thumbnail = await hold(page, thumbnailURL);
  await page.reload();
  await thumbnail.firstURL;

  await shoot(page, "01-held", { waitForImages: false });
  await expectShots(page, shotsDir, "01-held");
});
