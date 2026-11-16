import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { useState } from "react";
import { PositionQueueProvider } from "./position-queue";
import type { AppRouter } from "./router";
import { SettingsProvider } from "./settings";

export function App({ router }: { router: AppRouter }) {
  const [queryClient] = useState(() => new QueryClient());
  return (
    <QueryClientProvider client={queryClient}>
      <SettingsProvider>
        <PositionQueueProvider>
          <RouterProvider router={router} />
        </PositionQueueProvider>
      </SettingsProvider>
    </QueryClientProvider>
  );
}
