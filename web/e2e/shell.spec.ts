import { expect, test } from "@playwright/test";

test("the binary serves the shell with no CSP violation", async ({ page }) => {
  await page.addInitScript(() => {
    const violations: string[] = [];
    Object.assign(window, { __cspViolations: violations });
    document.addEventListener("securitypolicyviolation", (event) => {
      violations.push(`${event.violatedDirective} ${event.blockedURI}`);
    });
  });
  const cspConsoleErrors: string[] = [];
  page.on("console", (message) => {
    if (/content security policy/i.test(message.text())) {
      cspConsoleErrors.push(message.text());
    }
  });

  const response = await page.goto("/");
  expect(response?.headers()["content-security-policy"]).toContain(
    "script-src 'self'",
  );

  await expect(
    page.getByRole("heading", { level: 1, name: "tomeshelf" }),
  ).toBeVisible();
  await expect(page.getByRole("main")).toBeAttached();
  await page.waitForLoadState("networkidle");

  const violations = await page.evaluate(
    () => (window as unknown as { __cspViolations: string[] }).__cspViolations,
  );
  expect(violations).toEqual([]);
  expect(cspConsoleErrors).toEqual([]);
});
