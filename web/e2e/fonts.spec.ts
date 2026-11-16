import { execFileSync } from "node:child_process";
import path from "node:path";
import {
  test as base,
  expect,
  type Page,
  type Request,
} from "@playwright/test";
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

const books = path.resolve(import.meta.dirname, "../../testdata/books");
const title = "A Hand-Made Fonts Book";

const bundled = [
  {
    id: "literata" as const,
    label: "Literata",
    family: "Literata",
    pathPart: "/fonts/literata/",
  },
  {
    id: "charter" as const,
    label: "Charter",
    family: "Charter",
    pathPart: "/fonts/charter/",
  },
  {
    id: "source-serif-4" as const,
    label: "Source Serif 4",
    family: "Source Serif 4",
    pathPart: "/fonts/source-serif-4/",
  },
];

const defaults = {
  fontSize: 18,
  lineHeight: 1.6,
  width: 38,
  theme: "light" as const,
  layout: "pages" as const,
  font: "default" as const,
};

function article(page: Page) {
  return page.locator("article#tomeshelf-content");
}

function isFontRequest(request: Request) {
  const url = request.url();
  return (
    url.includes("/fonts/") &&
    (url.endsWith(".woff2") ||
      url.endsWith(".woff") ||
      url.endsWith(".ttf") ||
      url.endsWith(".otf"))
  );
}

function cjkFamiliesCoveringFixture(): string[] {
  let out: string;
  try {
    out = execFileSync("fc-list", [":charset=4f60 597d 4e16 754c", "family"], {
      encoding: "utf8",
    });
  } catch (err) {
    throw new Error(
      `fc-list failed while checking CJK coverage for 你好世界: ${err}`,
    );
  }
  const families = new Set<string>();
  for (const line of out.split("\n")) {
    for (const part of line.split(",")) {
      const name = part.trim();
      if (name) {
        families.add(name);
      }
    }
  }
  const noto = [...families].filter(
    (name) => name.includes("Noto Sans CJK") || name.includes("Noto Serif CJK"),
  );
  if (noto.length === 0) {
    throw new Error(
      "no CJK system font covering 你好世界 installed (fc-list ':charset=4f60 597d 4e16 754c' family must list a Noto Sans CJK or Noto Serif CJK family)",
    );
  }
  return noto;
}

async function setupReader(page: Page, font: string = "default") {
  const setup = await page.request.post("/api/setup", {
    data: { username: "reader", password: "reader password" },
  });
  expect(setup.status()).toBe(201);
  const saved = await page.request.put("/api/settings", {
    data: { ...defaults, font },
  });
  expect(saved.status()).toBe(204);
  await page.goto("/");
  await page
    .getByLabel("Import an EPUB")
    .setInputFiles(path.join(books, "fonts.epub"));
  await expect(page.getByRole("status")).toHaveText(`Imported ${title}.`);
  await page.getByRole("link", { name: new RegExp(title) }).click();
  await expect(page).toHaveURL(/\/books\/\d+\/read\/1$/);
  await expect(article(page)).toContainText("A regular paragraph");
  return new URL(page.url()).pathname.split("/")[2];
}

async function openSettings(page: Page) {
  await page.getByRole("button", { name: "Settings" }).click();
  return page.getByRole("dialog", { name: "Reading settings" });
}

async function waitForFamilyFaces(page: Page, family: string) {
  await page.evaluate(async (name) => {
    await Promise.all([
      document.fonts.load(`400 18px "${name}"`),
      document.fonts.load(`italic 400 18px "${name}"`),
      document.fonts.load(`700 18px "${name}"`),
      document.fonts.load(`italic 700 18px "${name}"`),
    ]);
  }, family);
  await expect
    .poll(async () =>
      page.evaluate((name) => {
        const faces = [...document.fonts].filter(
          (f) =>
            f.family.replace(/["']/g, "") === name && f.status === "loaded",
        );
        const key = (f: FontFace) => {
          const weight =
            f.weight === "normal" || f.weight === "400"
              ? "400"
              : f.weight === "bold" || f.weight === "700"
                ? "700"
                : String(f.weight);
          return `${f.style}/${weight}`;
        };
        const have = new Set(faces.map(key));
        return (
          have.has("normal/400") &&
          have.has("italic/400") &&
          have.has("normal/700") &&
          have.has("italic/700")
        );
      }, family),
    )
    .toBe(true);
}

async function platformFonts(page: Page, selector: string) {
  const client = await page.context().newCDPSession(page);
  await client.send("DOM.enable");
  await client.send("CSS.enable");
  const doc = await client.send("DOM.getDocument");
  const { nodeId } = await client.send("DOM.querySelector", {
    nodeId: doc.root.nodeId,
    selector,
  });
  if (!nodeId) {
    throw new Error(`DOM.querySelector missed ${selector}`);
  }
  const result = await client.send("CSS.getPlatformFontsForNode", { nodeId });
  return result.fonts as {
    familyName: string;
    glyphCount: number;
    isCustomFont: boolean;
  }[];
}

for (const face of bundled) {
  test(`bundled ${face.label} loads all four faces through the Font control`, async ({
    browser,
    server,
  }) => {
    const context = await browser.newContext({ baseURL: server.url });
    const page = await context.newPage();
    await setupReader(page);
    const panel = await openSettings(page);
    await panel.getByRole("radio", { name: face.label }).check();
    await waitForFamilyFaces(page, face.family);
    const family = await article(page).evaluate(
      (el) => getComputedStyle(el).fontFamily,
    );
    expect(
      family.startsWith(`"${face.family}"`) || family.startsWith(face.family),
    ).toBe(true);
    await context.close();
  });
}

test("Default fetches no font files; a bundled choice fetches only its own woff2", async ({
  browser,
  server,
}) => {
  const boot = await browser.newContext({ baseURL: server.url });
  const bootPage = await boot.newPage();
  const id = await setupReader(bootPage, "default");
  const storageState = await boot.storageState();
  await boot.close();

  async function openWithFont(font: string) {
    const context = await browser.newContext({
      baseURL: server.url,
      storageState,
    });
    const page = await context.newPage();
    const fontReqs: string[] = [];
    page.on("request", (req) => {
      if (isFontRequest(req)) {
        fontReqs.push(req.url());
      }
    });
    const saved = await page.request.put("/api/settings", {
      data: { ...defaults, font },
    });
    expect(saved.status()).toBe(204);
    await page.goto(`/books/${id}/read/1`);
    await expect(article(page)).toContainText("你好世界");
    return { context, page, fontReqs };
  }

  {
    const { context, page, fontReqs } = await openWithFont("default");
    // Give the browser a beat with Default before asserting no font fetches.
    await page.waitForTimeout(500);
    expect(fontReqs, `Default fetched fonts: ${fontReqs.join(", ")}`).toEqual(
      [],
    );
    await context.close();
  }

  for (const face of bundled) {
    const { context, page, fontReqs } = await openWithFont(face.id);
    await waitForFamilyFaces(page, face.family);
    expect(fontReqs.length).toBeGreaterThan(0);
    for (const url of fontReqs) {
      expect(url.startsWith(server.url)).toBe(true);
      expect(url.endsWith(".woff2")).toBe(true);
      expect(url).toContain(face.pathPart);
      for (const other of bundled) {
        if (other.id === face.id) {
          continue;
        }
        expect(url).not.toContain(other.pathPart);
      }
    }
    await context.close();
  }
});

test("CJK characters use the same system font under Default and each bundled face", async ({
  browser,
  server,
}) => {
  const covering = cjkFamiliesCoveringFixture();
  const context = await browser.newContext({ baseURL: server.url });
  const page = await context.newPage();
  await setupReader(page, "default");
  await expect(page.locator("#cjk")).toHaveText("你好世界");
  const underDefault = await platformFonts(page, "#cjk");
  expect(underDefault).toHaveLength(1);
  expect(covering).toContain(underDefault[0].familyName);
  expect(underDefault[0].glyphCount).toBe(4);

  for (const face of bundled) {
    const panel = await openSettings(page);
    await panel.getByRole("radio", { name: face.label }).check();
    await waitForFamilyFaces(page, face.family);
    await panel.getByRole("button", { name: "Close" }).click();
    const latinFamily = await page.locator("#regular").evaluate((el) => {
      const family = getComputedStyle(el).fontFamily;
      return family.split(",")[0].replace(/["']/g, "").trim();
    });
    expect(latinFamily).toBe(face.family);
    const underBundled = await platformFonts(page, "#cjk");
    expect(underBundled).toHaveLength(1);
    expect(underBundled[0].familyName).toBe(underDefault[0].familyName);
    expect(underBundled[0].glyphCount).toBe(4);
    expect(covering).toContain(underBundled[0].familyName);
  }
  await context.close();
});
