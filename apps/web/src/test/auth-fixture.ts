import { afterEach, vi } from "vitest";
import { LEGAL_VERSION } from "@my-tuums/auth/rules";
import {
  installTestAuthClient,
  type SocialProviderId,
  type UseSessionHook,
} from "@/lib/auth-client";

/**
 * The BetterAuth fake and the session-driving calls. The fake is installed by
 * `installTestAuthFixture()`, which both Vitest setups (`setup-node.ts` for
 * the node project, `setup-dom.ts` for the dom project) call during the setup
 * phase — before any test module is evaluated. That is what removes the
 * import-order hazard: `atoms/session.ts` seeds `sessionAtom` from
 * `sessionStore.get()` at its own import time, and the setup phase runs before
 * any test file's static imports are collected, so the fake store is always in
 * place before that capture. A test author never has to remember to import
 * this module before the component under test.
 *
 * The domain factories and QueryClient tuning live in `./factories.ts` (no
 * side effects); the router stand-in lives in `./route-tree.tsx`.
 */

export interface TestSessionUser {
  id: string;
  name: string;
  email?: string | null;
  username?: string | null;
  displayUsername?: string | null;
  image?: string | null;
  /** The untouched original's /media path (issue #246's re-crop offer reads it). */
  imageOriginal?: string | null;
  /** A Date, as the session store reports it. Omit it to simulate a session that never declared one. */
  dateOfBirth?: Date | null;
  bio?: string | null;
  bannerImage?: string | null;
  /**
   * The account's stored defaults. Null in the default fixture, which is the
   * "never chose" state `atoms/theme.ts` and `atoms/locale.ts` fall back from —
   * pass one to exercise the fallback actually applying.
   */
  themePreference?: string | null;
  localePreference?: string | null;
  legalAcceptedAt?: Date | string | null;
  legalVersion?: string | null;
  /** Account privacy (issue #328): null reads as public. Omit for public. */
  isPrivate?: boolean | null;
  /** Read by `/settings/account`'s two-factor section to decide on/off. */
  twoFactorEnabled?: boolean | null;
  /**
   * The moderation role (issue #38): "user" (the default), "moderator",
   * "staff" or "admin" — `atoms/session.ts`'s `viewerRoleAtom` sanitises
   * anything else down to "user". Omit it (the default) to exercise a plain
   * signed-in viewer; pass one of the other three to test role-gated UI.
   */
  role?: string | null;
}

export interface TestSessionValue {
  data: { user: TestSessionUser } | null;
  isPending: boolean;
  isRefetching: boolean;
  /**
   * The last settled failure, when there was one. Only `.status` is read —
   * `sessionErrorAtom` feeds the signed-in gate's 401 carve-out. Null until a
   * fetch settles on an error, which is what every fixture ships.
   */
  error: { status: number } | null;
  /** The store value's own refetch — what `lib/session-sync.ts`'s `refreshSession` calls. */
  refetch: (queryParams?: { query?: { disableCookieCache?: boolean } }) => Promise<void>;
}

/**
 * `atoms/session.ts` seeds `sessionAtom` from `sessionStore.get()` and then
 * re-syncs it from `sessionStore.subscribe` the instant anything mounts the
 * atom — nanostores' `subscribe` calls its listener immediately with the
 * current value, by design (see that file's comment on avoiding a
 * null-then-real-value flash). That immediate re-sync is exactly why
 * `store.set(sessionAtom, ...)` on a test store doesn't stick: the next
 * mount overwrites it with whatever the real nanostore currently holds.
 * Mocking `sessionStore` itself is the only lever that actually reaches the
 * atom, so this is a module mock, not a store write.
 */
// Starts PENDING, matching BetterAuth's real session store's cold-start value
// (`session-atom.mjs` seeds `{ data: null, isPending: true }`). This is what
// makes the signed-in gate's cold-load guard testable: the atom's initial
// value — captured at module import — is what the first render sees, and if it
// read "resolved signed-out" here, a signed-in/pending test would redirect
// before the immediate-fire subscription below delivers the real value. The
// same trap is documented in `session.dom.test.ts`.
let currentSession: TestSessionValue = {
  data: null,
  isPending: true,
  isRefetching: false,
  error: null,
  refetch: vi.fn(() => Promise.resolve()),
};
const sessionListeners = new Set<(value: TestSessionValue) => void>();

type TestSocialProvider = { id: SocialProviderId; label: string };
const testSocialProviders: TestSocialProvider[] = [];

const fakeSessionStore = {
  get: () => currentSession,
  subscribe: (listener: (value: TestSessionValue) => void) => {
    sessionListeners.add(listener);
    listener(currentSession); // mirrors nanostores' "fire immediately" contract
    return () => sessionListeners.delete(listener);
  },
};

const fakeAuthClient = {
  /**
   * The full client surface the auth atoms reach for.
   *
   * This used to be `{}`, which was fine while only `atoms/session.ts` went
   * through this module — it reads `sessionStore` and nothing else. The auth
   * hardening changed that: `atoms/auth.ts`, `atoms/two-factor.ts`,
   * `atoms/passkey.ts`, `atoms/handle-claim.ts` and `atoms/linked-accounts.ts`
   * all call `authClient.*` namespaces directly, and an empty object turns any
   * component that renders one of them into a "cannot read properties of
   * undefined" at call time rather than a readable failure.
   *
   * Every stub resolves `{ data, error }` rather than rejecting, matching how
   * BetterAuth's client actually reports failure. A test that cares overrides
   * the specific one with `vi.mocked(...).mockResolvedValue(...)`.
   */
  signIn: {
    email: vi.fn(() => Promise.resolve({ data: {}, error: null })),
    username: vi.fn(() => Promise.resolve({ data: {}, error: null })),
    social: vi.fn(() => Promise.resolve({ data: {}, error: null })),
    passkey: vi.fn(() => Promise.resolve({ data: {}, error: null })),
  },
  signUp: { email: vi.fn(() => Promise.resolve({ data: {}, error: null })) },
  signOut: vi.fn(() => Promise.resolve({ data: {}, error: null })),
  // The `/verify-email` resend (issue #172). Answers `{ status: true }` for an
  // unknown address too, exactly as the server does — the endpoint must not
  // become an account-existence oracle, and the fixture should not tempt a
  // test into asserting otherwise.
  sendVerificationEmail: vi.fn(() => Promise.resolve({ data: { status: true }, error: null })),
  requestPasswordReset: vi.fn(() => Promise.resolve({ data: { status: true }, error: null })),
  resetPassword: vi.fn(() => Promise.resolve({ data: { status: true }, error: null })),
  updateUser: vi.fn(() => Promise.resolve({ data: {}, error: null })),
  // `/settings/account`'s password section. Like every other namespace here,
  // its absence would be a "cannot read properties of undefined" at click
  // time rather than a type error.
  changePassword: vi.fn(() => Promise.resolve({ data: {}, error: null })),
  listAccounts: vi.fn(() => Promise.resolve({ data: [], error: null })),
  linkSocial: vi.fn(() => Promise.resolve({ data: {}, error: null })),
  unlinkAccount: vi.fn(() => Promise.resolve({ data: {}, error: null })),
  twoFactor: {
    enable: vi.fn(() => Promise.resolve({ data: { totpURI: "", backupCodes: [] }, error: null })),
    disable: vi.fn(() => Promise.resolve({ data: {}, error: null })),
    verifyTotp: vi.fn(() => Promise.resolve({ data: {}, error: null })),
    verifyOtp: vi.fn(() => Promise.resolve({ data: {}, error: null })),
    verifyBackupCode: vi.fn(() => Promise.resolve({ data: {}, error: null })),
    sendOtp: vi.fn(() => Promise.resolve({ data: {}, error: null })),
  },
  passkey: {
    addPasskey: vi.fn(() => Promise.resolve({ data: {}, error: null })),
    listUserPasskeys: vi.fn(() => Promise.resolve({ data: [], error: null })),
    updatePasskey: vi.fn(() => Promise.resolve({ data: {}, error: null })),
    deletePasskey: vi.fn(() => Promise.resolve({ data: {}, error: null })),
  },
  getLastUsedLoginMethod: vi.fn(() => null),
};

const fakeUseSession = () => currentSession;

/**
 * Installs the fake auth client. Called once from each Vitest setup
 * (`setup-node.ts`, `setup-dom.ts`) during the setup phase, before any test
 * module is evaluated — so
 * `atoms/session.ts`'s import-time `sessionStore.get()` always reads the fake
 * store, regardless of what a test file imports first. It is idempotent by
 * design: the fake is a module-level singleton, and re-installing it just
 * re-points the same live bindings at the same fakes.
 */
export function installTestAuthFixture(): void {
  // SAFETY: the fake covers the client surface the app reaches for; vi.fn
  // members resolve the same { data, error } shapes better-auth reports.
  installTestAuthClient({
    sessionStore: fakeSessionStore,
    authClient: fakeAuthClient,
    useSession: fakeUseSession as UseSessionHook,
    shouldOfferOneTap: false,
    socialProviders: testSocialProviders,
  });
}

/** Configures the OAuth buttons exposed by the mocked auth client for one test. */
export function setTestSocialProviders(providers: readonly TestSocialProvider[]): void {
  testSocialProviders.splice(0, testSocialProviders.length, ...providers);
}

afterEach(() => {
  testSocialProviders.splice(0);
});

/**
 * Pushes a value into the mocked session store and notifies every subscriber
 * — how a test drives a session change mid-render, mirroring a live
 * `/get-session` settling.
 */
export function setTestSession(next: TestSessionValue): void {
  currentSession = next;
  sessionListeners.forEach((listener) => listener(currentSession));
}

export function signedOutSession(): TestSessionValue {
  return {
    data: null,
    isPending: false,
    isRefetching: false,
    error: null,
    refetch: vi.fn(() => Promise.resolve()),
  };
}

/** Transitions the mocked session store to its settled signed-out state. */
export function setTestSignedOut(): void {
  setTestSession(signedOutSession());
}

/** Merges fields into the current signed-in user and notifies every session observer. */
export function patchTestSessionUser(patch: Partial<TestSessionUser>): void {
  if (!currentSession.data) throw new Error("patchTestSessionUser requires a signed-in session");
  setTestSession({
    ...currentSession,
    data: { user: { ...currentSession.data.user, ...patch } },
  });
}

export function signedInSession(user: Partial<TestSessionUser> = {}): TestSessionValue {
  return {
    data: {
      user: {
        id: crypto.randomUUID(),
        name: "Alex Mercer",
        email: "alex@example.com",
        username: "alexmercer",
        displayUsername: "AlexMercer",
        image: null,
        imageOriginal: null,
        // The editable profile and the stored preferences, all unset — the
        // state a fresh account is in, and the one the theme/locale fallbacks
        // in atoms/theme.ts and atoms/locale.ts are written against. A test
        // that wants a stored preference passes it through `signedInAs`.
        bio: null,
        bannerImage: null,
        themePreference: null,
        localePreference: null,
        legalAcceptedAt: new Date("2026-08-02T00:00:00.000Z"),
        legalVersion: LEGAL_VERSION,
        isPrivate: null,
        // The unprivileged default every account starts at — see the
        // `role` field's doc comment above.
        role: "user",
        // A complete sign-up by default — the state components assume when
        // they render a generic signed-in viewer. Omit it (or set username
        // null) to build an incomplete session on purpose.
        dateOfBirth: new Date("1995-01-01T00:00:00.000Z"),
        ...user,
      },
    },
    isPending: false,
    isRefetching: false,
    error: null,
    refetch: vi.fn(() => Promise.resolve()),
  };
}

export function pendingSession(): TestSessionValue {
  // The cold-load state: BetterAuth's first /get-session still in flight.
  // `sessionPendingAtom` reads true and `isSignedInAtom` reads false — the
  // exact combination the signed-in gate must not redirect on.
  return {
    data: null,
    isPending: true,
    isRefetching: false,
    error: null,
    refetch: vi.fn(() => Promise.resolve()),
  };
}
