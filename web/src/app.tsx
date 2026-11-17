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
        {/* Keep the position queue inside SettingsProvider: sign-out re-keys
            the settings session, recreating the queue and dropping failed saves.
            Moving it outside lets a failed save follow the next user. */}
        <PositionQueueProvider>
          <RouterProvider router={router} />
        </PositionQueueProvider>
      </SettingsProvider>
    </QueryClientProvider>
  );
}
