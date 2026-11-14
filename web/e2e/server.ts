import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";

export type TestServer = {
  url: string;
  stop: () => Promise<void>;
};

// Starts the built tomeshelf binary on a free port with a fresh data
// directory. stop ends the binary and removes the directory.
export async function startServer(): Promise<TestServer> {
  const bin =
    process.env.TOMESHELF_BIN ??
    path.resolve(import.meta.dirname, "../../bin/tomeshelf");
  const dataDir = await mkdtemp(path.join(tmpdir(), "tomeshelf-e2e-"));
  const child = spawn(bin, ["-addr", "127.0.0.1:0", "-data", dataDir], {
    stdio: ["ignore", "inherit", "pipe"],
  });
  const exited = new Promise<void>((resolve) => child.once("exit", resolve));

  try {
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
    return {
      url: `http://${addr}`,
      stop: async () => {
        child.kill("SIGTERM");
        await exited;
        await rm(dataDir, { recursive: true, force: true });
      },
    };
  } catch (err) {
    child.kill("SIGTERM");
    await rm(dataDir, { recursive: true, force: true });
    throw err;
  }
}
