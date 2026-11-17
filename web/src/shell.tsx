import { Outlet, useLocation } from "@tanstack/react-router";

import { AccountMenu } from "./auth";

export function Shell() {
  const { pathname } = useLocation();
  return (
    <div className="reading-shell min-h-dvh bg-(--page-bg) text-(--page-fg)">
      <header className="flex items-center justify-between gap-4 shrink-0 border-b border-(--page-rule) px-4 py-3">
        <h1 className="text-xl font-semibold tracking-tight">tomeshelf</h1>
        {pathname !== "/signin" && pathname !== "/setup" && <AccountMenu />}
      </header>
      <main className="px-4 py-6">
        <Outlet />
      </main>
    </div>
  );
}
