import { expect, type Locator } from "@playwright/test";

// Assert the accessible value and actual rendered fill through the library UI.
export async function expectCoverProgress(card: Locator, value: number) {
  const track = card.getByRole("progressbar");
  await expect(track).toHaveAttribute("aria-valuenow", String(value));
  await expect(track).toHaveAttribute("aria-valuemin", "0");
  await expect(track).toHaveAttribute("aria-valuemax", "100");
  await expect(track).toHaveAccessibleName(/Reading progress/);
  const geometry = await track.evaluate((el) => {
    const box = el.getBoundingClientRect();
    const fill = el.firstElementChild?.getBoundingClientRect();
    const cover = el.parentElement?.getBoundingClientRect();
    return {
      width: box.width,
      height: box.height,
      fill: fill?.width,
      bottom: box.bottom,
      coverBottom: cover?.bottom,
    };
  });
  expect(geometry.width).toBeGreaterThan(0);
  expect(geometry.height).toBeGreaterThan(0);
  expect(geometry.fill).toBeDefined();
  expect(
    Math.abs((geometry.fill ?? -1) - (geometry.width * value) / 100),
  ).toBeLessThanOrEqual(1);
  expect(geometry.bottom).toBe(geometry.coverBottom);
}
