import { QueryClient } from "@tanstack/react-query";

/**
 * The single `QueryClient` for the app. Pulled out of `main.tsx` so
 * `src/lib/store.ts` can hydrate `queryClientAtom` with this exact instance
 * before React renders — see the comment there for why that matters.
 *
 * No config changes from the inline `new QueryClient()` this replaces.
 */
export const queryClient = new QueryClient();
