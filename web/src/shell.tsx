import { Outlet } from "@tanstack/react-router";

export function Shell() {
  return (
    <div className="min-h-dvh bg-stone-50 text-stone-900">
      <header className="border-b border-stone-200 px-4 py-3">
        <h1 className="text-xl font-semibold tracking-tight">tomeshelf</h1>
      </header>
      <main className="px-4 py-6">
        <Outlet />
      </main>
    </div>
  );
}
