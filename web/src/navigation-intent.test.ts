import { afterEach, expect, test } from "vitest";
import { setNavigationIntent, takeNavigationIntent } from "./navigation-intent";

afterEach(() => {
  window.history.replaceState(null, "", "/");
  takeNavigationIntent();
});

test("a cross-document link with a fragment is still a move when the hash has not landed yet", () => {
  window.history.replaceState(null, "", "/books/1/read/1");
  setNavigationIntent("move", "/books/1/read/2#second-target");
  window.history.replaceState(null, "", "/books/1/read/2");
  expect(takeNavigationIntent()).toBe("move");
});

test("force keeps a move when the router has already updated the address", () => {
  window.history.replaceState(null, "", "/books/1/read/2#second-target");
  setNavigationIntent("move", "/books/1/read/2#second-target", {
    force: true,
  });
  expect(takeNavigationIntent()).toBe("move");
});

test("a placement on another document leaves the move mark for later", () => {
  window.history.replaceState(null, "", "/books/1/read/1");
  setNavigationIntent("move", "/books/1/read/2");
  expect(takeNavigationIntent()).toBe("address");
  window.history.replaceState(null, "", "/books/1/read/2");
  expect(takeNavigationIntent()).toBe("move");
});

test("a placement on a third document still leaves the mark until the target", () => {
  window.history.replaceState(null, "", "/books/1/read/1");
  setNavigationIntent("move", "/books/1/read/2");
  window.history.replaceState(null, "", "/books/1/read/3");
  expect(takeNavigationIntent()).toBe("address");
  window.history.replaceState(null, "", "/books/1/read/2");
  expect(takeNavigationIntent()).toBe("move");
});
