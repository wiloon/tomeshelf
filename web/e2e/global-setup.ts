import { spawn } from "node:child_process";
import path from "node:path";
import { createInterface } from "node:readline";

// Starts the built tomeshelf binary on a free port and exposes its URL to the
// tests as TOMESHELF_URL. Returns the teardown that stops it.
export default async function globalSetup() {
  const bin =
    process.env.TOMESHELF_BIN ??
    path.resolve(import.meta.dirname, "../../bin/tomeshelf");
  const child = spawn(bin, ["-addr", "127.0.0.1:0"], {
    stdio: ["ignore", "inherit", "pipe"],
  });

  const addr = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${bin} did not report its address in time`)),
      15_000,
    );
    child.once("error", reject);
    child.once("exit", (code) =>
      reject(new Error(`${bin} exited early with code ${code}`)),
    );
    const lines = createInterface({ input: child.stderr });
    lines.on("line", (line) => {
      process.stderr.write(`${line}\n`);
      try {
        const entry = JSON.parse(line);
        if (entry.msg === "listening" && typeof entry.addr === "string") {
          clearTimeout(timer);
          resolve(entry.addr);
        }
      } catch {
        // Not a log entry; already echoed above.
      }
    });
  });

  process.env.TOMESHELF_URL = `http://${addr}`;

  return async () => {
    child.kill("SIGTERM");
  };
}
