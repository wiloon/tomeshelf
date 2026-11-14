import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

export const adminStorageState = path.join(
  import.meta.dirname,
  "e2e/.auth/admin.json",
);

export default defineConfig({
  testDir: "./e2e",
  globalSetup: "./e2e/global-setup.ts",
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: process.env.TOMESHELF_URL,
    storageState: adminStorageState,
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
