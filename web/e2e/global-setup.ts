import { request } from "@playwright/test";
import { adminStorageState } from "../playwright.config";
import { startServer } from "./server";

const admin = { username: "admin", password: "e2e admin password" };

// Starts the shared server for the signed-in specs, creates its admin, and
// saves the admin's session as their storageState. Exposes the server's URL
// as TOMESHELF_URL and returns the teardown that stops it.
export default async function globalSetup() {
  const server = await startServer();
  try {
    const api = await request.newContext({ baseURL: server.url });
    const res = await api.post("/api/setup", { data: admin });
    if (res.status() !== 201) {
      throw new Error(`setup answered ${res.status()}: ${await res.text()}`);
    }
    await api.storageState({ path: adminStorageState });
    await api.dispose();
  } catch (err) {
    await server.stop();
    throw err;
  }

  process.env.TOMESHELF_URL = server.url;
  return server.stop;
}
