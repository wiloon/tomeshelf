import { createMemoryHistory } from "@tanstack/react-router";
import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { App } from "./app";
import { createAppRouter } from "./router";

test("the shell renders the tomeshelf heading", async () => {
  const router = createAppRouter(
    createMemoryHistory({ initialEntries: ["/"] }),
  );
  render(<App router={router} />);

  expect(
    await screen.findByRole("heading", { level: 1, name: "tomeshelf" }),
  ).toBeVisible();
});
