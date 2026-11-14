import {
  createRootRoute,
  createRoute,
  createRouter,
  type RouterHistory,
} from "@tanstack/react-router";
import { SetupPage, SignInPage } from "./auth";
import { LibraryPage } from "./library";
import { ReaderPage } from "./reader";
import { Shell } from "./shell";

const rootRoute = createRootRoute({ component: Shell });

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: LibraryPage,
});

const setupRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/setup",
  component: SetupPage,
});

const signInRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/signin",
  component: SignInPage,
});

// One URL per document in the reading order, n counting from 1 (ADR-0005).
const readRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/books/$id/read/$n",
  component: ReaderPage,
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  setupRoute,
  signInRoute,
  readRoute,
]);

export function createAppRouter(history?: RouterHistory) {
  return createRouter({ routeTree, history });
}

export type AppRouter = ReturnType<typeof createAppRouter>;

declare module "@tanstack/react-router" {
  interface Register {
    router: AppRouter;
  }
}
