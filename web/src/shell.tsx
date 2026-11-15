import { Outlet } from "@tanstack/react-router";

export function Shell() {
  return (
    <div className="reading-shell min-h-dvh bg-(--page-bg) text-(--page-fg)">
      <header className="shrink-0 border-b border-(--page-rule) px-4 py-3">
        <h1 className="text-xl font-semibold tracking-tight">tomeshelf</h1>
      </header>
      <main className="px-4 py-6">
        <Outlet />
      </main>
    </div>
  );
}
