import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createSaveQueue, type SaveStatus } from "./save-queue";

type Sent = { value: string; succeed: () => void; fail: () => void };

// A queue whose saves wait until the test lets them succeed or fail.
function queue() {
  const sent: Sent[] = [];
  const statuses: SaveStatus[] = [];
  let inFlight = 0;
  let mostInFlight = 0;
  const q = createSaveQueue<string>({
    delay: 500,
    send: (value) => {
      inFlight++;
      mostInFlight = Math.max(mostInFlight, inFlight);
      return new Promise<void>((resolve, reject) => {
        sent.push({
          value,
          succeed: () => {
            inFlight--;
            resolve();
          },
          fail: () => {
            inFlight--;
            reject(new Error("save failed"));
          },
        });
      });
    },
    onStatus: (status) => statuses.push(status),
  });
  return {
    q,
    sent,
    values: () => sent.map((s) => s.value),
    statuses,
    mostInFlight: () => mostInFlight,
  };
}

// Lets the promise callbacks of finished saves run.
const settle = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

test("a change is saved once the debounce has passed", async () => {
  const { q, values } = queue();
  q.change("A");
  await vi.advanceTimersByTimeAsync(499);
  expect(values()).toEqual([]);
  q.change("B");
  await vi.advanceTimersByTimeAsync(499);
  expect(values()).toEqual([]);
  await vi.advanceTimersByTimeAsync(1);
  expect(values()).toEqual(["B"]);
});

test("with a slow first save, the last save carries the latest settings and one save at most is in flight", async () => {
  const { q, sent, values, mostInFlight } = queue();
  q.change("A");
  await vi.advanceTimersByTimeAsync(500);
  q.change("B");
  await vi.advanceTimersByTimeAsync(500);
  q.change("C");
  await vi.advanceTimersByTimeAsync(5000);
  expect(values()).toEqual(["A"]);

  sent[0].succeed();
  await settle();
  expect(values()).toEqual(["A", "C"]);
  sent[1].succeed();
  await vi.advanceTimersByTimeAsync(5000);
  expect(values()).toEqual(["A", "C"]);
  expect(mostInFlight()).toBe(1);
  expect(q.status()).toBe("saved");
});

test("a hidden page sends a pending save at once when nothing is in flight", async () => {
  const { q, values } = queue();
  q.change("A");
  q.hidden();
  expect(values()).toEqual(["A"]);
  await vi.advanceTimersByTimeAsync(5000);
  expect(values()).toEqual(["A"]);
});

test("a hidden page with a save in flight sends the pending save only after it", async () => {
  const { q, sent, values, mostInFlight } = queue();
  q.change("A");
  await vi.advanceTimersByTimeAsync(500);
  q.change("B");
  q.hidden();
  q.hidden();
  await settle();
  expect(values()).toEqual(["A"]);
  sent[0].succeed();
  await settle();
  expect(values()).toEqual(["A", "B"]);
  expect(mostInFlight()).toBe(1);
});

test("pagehide sends a pending save at once, even with a save in flight", async () => {
  const { q, values } = queue();
  q.change("A");
  await vi.advanceTimersByTimeAsync(500);
  q.change("B");
  q.pagehide();
  expect(values()).toEqual(["A", "B"]);
});

for (const [name, finish] of [
  ["the older first", (a: Sent, b: Sent) => [a.succeed, b.succeed]],
  ["the newer first", (a: Sent, b: Sent) => [b.succeed, a.succeed]],
  ["the older failing", (a: Sent, b: Sent) => [b.succeed, a.fail]],
  ["the newer failing", (a: Sent, b: Sent) => [a.succeed, b.fail]],
] as const) {
  test(`after two saves overlap at pagehide and finish (${name}), one more save sends the current settings`, async () => {
    const { q, sent, values } = queue();
    q.change("A");
    await vi.advanceTimersByTimeAsync(500);
    q.change("B");
    q.pagehide();
    q.change("C");
    await vi.advanceTimersByTimeAsync(500);
    expect(values()).toEqual(["A", "B"]);

    const [first, second] = finish(sent[0], sent[1]);
    first();
    await vi.advanceTimersByTimeAsync(500);
    expect(values()).toEqual(["A", "B"]);
    second();
    await settle();
    expect(values()).toEqual(["A", "B", "C"]);
    expect(q.status()).toBe("saving");

    sent[2].succeed();
    await vi.advanceTimersByTimeAsync(5000);
    expect(values()).toEqual(["A", "B", "C"]);
    expect(q.status()).toBe("saved");
  });
}

test("after a pagehide with no overlap, no more saves are sent", async () => {
  const { q, sent, values } = queue();
  q.pagehide();
  expect(values()).toEqual([]);
  q.change("A");
  q.pagehide();
  expect(values()).toEqual(["A"]);
  sent[0].succeed();
  await vi.advanceTimersByTimeAsync(5000);
  expect(values()).toEqual(["A"]);
});

test("a failed save shows as failed until a retry succeeds", async () => {
  const { q, sent, values, statuses } = queue();
  expect(q.status()).toBe("saved");
  q.change("A");
  expect(q.status()).toBe("saving");
  await vi.advanceTimersByTimeAsync(500);
  sent[0].fail();
  await settle();
  expect(q.status()).toBe("failed");
  await vi.advanceTimersByTimeAsync(5000);
  expect(values()).toEqual(["A"]);

  q.retry();
  expect(values()).toEqual(["A", "A"]);
  expect(q.status()).toBe("saving");
  sent[1].succeed();
  await settle();
  expect(q.status()).toBe("saved");
  expect(statuses).toEqual(["saving", "failed", "saving", "saved"]);
});

test("a change after a failed save saves the new settings", async () => {
  const { q, sent, values } = queue();
  q.change("A");
  await vi.advanceTimersByTimeAsync(500);
  sent[0].fail();
  await settle();
  q.change("B");
  expect(q.status()).toBe("saving");
  await vi.advanceTimersByTimeAsync(500);
  expect(values()).toEqual(["A", "B"]);
  sent[1].succeed();
  await settle();
  expect(q.status()).toBe("saved");
});

test("a failed save stays pending and is resent on hidden", async () => {
  const { q, sent, values } = queue();
  q.change("A");
  await vi.advanceTimersByTimeAsync(500);
  sent[0].fail();
  await settle();
  expect(q.status()).toBe("failed");
  expect(values()).toEqual(["A"]);

  q.hidden();
  expect(values()).toEqual(["A", "A"]);
  expect(q.status()).toBe("saving");
  sent[1].succeed();
  await settle();
  expect(q.status()).toBe("saved");
});

test("a failed save stays pending and is resent on pagehide", async () => {
  const { q, sent, values } = queue();
  q.change("A");
  await vi.advanceTimersByTimeAsync(500);
  sent[0].fail();
  await settle();
  expect(q.status()).toBe("failed");

  q.pagehide();
  expect(values()).toEqual(["A", "A"]);
  sent[1].succeed();
  await settle();
  expect(q.status()).toBe("saved");
});
