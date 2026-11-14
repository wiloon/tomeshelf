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

const thumbnailURL = /\/api\/books\/\d+\/thumbnail$/;

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
