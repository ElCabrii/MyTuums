import type { ReactElement } from "react";
import { act, render, type RenderResult } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createStore, Provider } from "jotai";
import { queryClientAtom } from "jotai-tanstack-query";
import { RouterProvider } from "@tanstack/react-router";
import { buildTestRouter } from "@/test/route-tree";
import { createTestQueryClient } from "@/test/factories";
import {
  pendingSession,
  setTestSession,
  signedInSession,
  signedOutSession,
  type TestSessionUser,
} from "@/test/auth-fixture";

/**
 * The shared harness every component test in this directory renders through:
 * a Jotai store wired up the way `src/lib/store.ts` wires the real one, and a
 * memory router standing in for `src/routeTree.gen.ts` (generated, git-ignored,
 * so tests can't depend on it).
 *
 * The auth fake and session fixtures live in `./auth-fixture.ts` (installed by
 * `src/test/setup.ts` during the Vitest setup phase, before any test module
 * evaluates); the domain factories and QueryClient tuning live in
 * `./factories.ts`; the router stand-in lives in `./route-tree.ts`. This module
 * re-exports what component tests need so their call sites stay stable.
 */

export { queryFixtures } from "@/test/query-fixtures";
export { createTestQueryClient } from "@/test/factories";
export {
  makeAuthor,
  makeAuditEntry,
  makeModerationCase,
  makeModerationCaseDetail,
  makeModerationReport,
  makePost,
  makePostPreview,
  makeProfile,
  makeTeamMember,
  makeThread,
  makeUserModerationCaseDetail,
  makeUserPreview,
  makeUserSummary,
} from "@/test/factories";
export {
  patchTestSessionUser,
  setTestSession,
  setTestSignedOut,
  setTestSocialProviders,
  type TestSessionUser,
  type TestSessionValue,
} from "@/test/auth-fixture";

/** jotai doesn't re-export a `Store` type from its package root at this version — derive it instead. */
type JotaiStore = ReturnType<typeof createStore>;

/**
 * jsdom doesn't implement `window.scrollTo`, and TanStack Router's
 * scroll-restoration listener is registered unconditionally on every router
 * (not gated behind the `scrollRestoration` option, which only controls
 * whether a *previous* position is restored — the reset-to-top scroll on
 * every navigation fires regardless). Left unstubbed, jsdom's
 * "not implemented" surfaces inside a passive effect during commit, which
 * React has no error boundary to catch here, and the whole render aborts —
 * RTL ends up looking at an empty `<div/>` with no indication why.
 */
// jsdom *does* define `window.scrollTo` — as a stub that reports "not
// implemented" when called — so a `typeof` check wouldn't catch it. Just
// replace it outright.
window.scrollTo = () => {};

export interface RenderWithProvidersOptions {
  /** Fresh by default. Pass one you built yourself to inspect/seed atoms before asserting. */
  store?: JotaiStore;
  /** Fresh by default. Pass one you built yourself to seed the query cache before render. */
  queryClient?: QueryClient;
  /** Where the memory router starts. Defaults to "/". */
  initialPath?: string;
  /**
   * `false` (default): signed out. `true`: a generic signed-in viewer.
   * An object: signed in as a viewer with these fields.
   */
  signedInAs?: boolean | Partial<TestSessionUser>;
  /**
   * `true`: the cold-load state — session in flight, reads as signed out for
   * one tick. The signed-in gate must NOT redirect on this.
   */
  sessionPending?: boolean;
}

export interface RenderWithProvidersResult extends RenderResult {
  store: JotaiStore;
  queryClient: QueryClient;
  router: ReturnType<typeof buildTestRouter>;
}

export async function renderWithProviders(
  ui: ReactElement,
  options: RenderWithProvidersOptions = {},
): Promise<RenderWithProvidersResult> {
  const {
    store = createStore(),
    queryClient = createTestQueryClient(),
    initialPath = "/",
    signedInAs = false,
    sessionPending = false,
  } = options;

  // Mirrors src/lib/store.ts: queryClientAtom must be hydrated before
  // anything reads it, or jotai locks in its own default QueryClient and
  // every atom-driven query silently talks to a client nothing renders with.
  store.set(queryClientAtom, queryClient);

  setTestSession(
    sessionPending
      ? pendingSession()
      : signedInAs === false
        ? signedOutSession()
        : signedInSession(signedInAs === true ? {} : signedInAs),
  );

  const router = buildTestRouter(ui, initialPath);

  const result = render(
    <Provider store={store}>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </Provider>,
  );

  // `RouterProvider` resolves its initial match asynchronously even with no
  // loaders anywhere in the stub tree — without awaiting it, the first
  // synchronous paint is empty and every query in a test would be racing an
  // unresolved promise. TanStack Router's own test suite awaits the same
  // thing (render, then await the initial load) rather than asserting
  // straight after `render()`.
  await act(async () => {
    await router.load();
  });

  return { ...result, store, queryClient, router };
}
