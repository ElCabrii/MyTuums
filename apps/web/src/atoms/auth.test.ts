import { beforeEach, describe, expect, it, vi } from "vitest";
import { createStore } from "jotai";
import { installTestAuthClient } from "@/lib/auth-client";

type AuthClientResult = { data: unknown; error: unknown };

const { signInEmail, signInUsername, signInPasskey, signUpEmail, sendVerificationEmail } =
  vi.hoisted(() => ({
    signInEmail: vi.fn((): Promise<AuthClientResult> => Promise.resolve({ data: {}, error: null })),
    signInUsername: vi.fn((): Promise<AuthClientResult> =>
      Promise.resolve({ data: {}, error: null }),
    ),
    signInPasskey: vi.fn((): Promise<AuthClientResult> =>
      Promise.resolve({ data: {}, error: null }),
    ),
    signUpEmail: vi.fn((): Promise<AuthClientResult> => Promise.resolve({ data: {}, error: null })),
    sendVerificationEmail: vi.fn((): Promise<AuthClientResult> =>
      Promise.resolve({ data: { status: true }, error: null }),
    ),
  }));

// SAFETY: the recording fakes resolve the { data, error } shapes the app reads
// from the real client; the seam swaps only what each suite needs.
installTestAuthClient({
  authClient: {
    signIn: {
      email: signInEmail,
      username: signInUsername,
      passkey: signInPasskey,
    },
    signUp: {
      email: signUpEmail,
    },
    sendVerificationEmail,
  },
});

import {
  authErrorAtom,
  resendVerificationEmailAtom,
  signInAtom,
  signInWithPasskeyAtom,
  signUpAtom,
  verifyEmailAtom,
  verifyEmailSentAtom,
} from "@/atoms/auth";
import { LEGAL_VERSION } from "@my-tuums/auth/rules";

beforeEach(() => {
  vi.clearAllMocks();
});

/**
 * The admin plugin's `session.create.before` hook throws this code — never a
 * message a test should pattern-match on, since the i18n plugin may have
 * translated it (see `errorCodeOf`'s docblock in atoms/auth.ts).
 */
const bannedError = {
  code: "BANNED_USER",
  message:
    "You have been banned from this application. Please contact support if you believe this is an error.",
};

describe("signInAtom", () => {
  it('reports "banned" and leaves the banner unset on BANNED_USER — issue #74', async () => {
    const store = createStore();
    signInEmail.mockResolvedValueOnce({ data: null, error: bannedError });

    const outcome = await store.set(signInAtom, {
      identifier: "banned@example.com",
      password: "whatever1",
    });

    expect(outcome).toEqual({ status: "banned" });
    // The whole point: a banned account does not get the generic sign-in
    // banner, because the caller navigates to `/banned` on this outcome
    // instead (see login.tsx) — a set banner here would mean both paths fire.
    expect(store.get(authErrorAtom)).toBeNull();
  });

  it("still sets the banner for an ordinary sign-in failure", async () => {
    const store = createStore();
    signInEmail.mockResolvedValueOnce({
      data: null,
      error: { code: "INVALID_CREDENTIALS", message: "Invalid email or password" },
    });

    const outcome = await store.set(signInAtom, {
      identifier: "alice@example.com",
      password: "wrong",
    });

    expect(outcome).toEqual({ status: "failed" });
    expect(store.get(authErrorAtom)).toBe("Invalid email or password");
  });

  it('reports "verify-email" and remembers the address on EMAIL_NOT_VERIFIED — issue #172', async () => {
    const store = createStore();
    signInEmail.mockResolvedValueOnce({
      data: null,
      error: { code: "EMAIL_NOT_VERIFIED", message: "Email not verified" },
    });

    const outcome = await store.set(signInAtom, {
      identifier: "  Pending@example.com  ",
      password: "correct-password",
    });

    expect(outcome).toEqual({ status: "verify-email" });
    // The route navigates to /verify-email on this outcome, so a banner here
    // would mean both the redirect and a "try again" message fire.
    expect(store.get(authErrorAtom)).toBeNull();
    // Trimmed, so the pending screen's resend button targets the address the
    // person actually signed in with.
    expect(store.get(verifyEmailAtom)).toBe("Pending@example.com");
  });

  it("leaves the address unknown when an unverified account signs in by username", async () => {
    const store = createStore();
    signInUsername.mockResolvedValueOnce({
      data: null,
      error: { code: "EMAIL_NOT_VERIFIED", message: "Email not verified" },
    });

    const outcome = await store.set(signInAtom, { identifier: "pending", password: "whatever1" });

    expect(outcome).toEqual({ status: "verify-email" });
    // A username is not an address: the pending screen shows the copy without
    // a resend button rather than mailing something derived from a handle.
    // `sendOnSignIn` has already re-sent the link server-side.
    expect(store.get(verifyEmailAtom)).toBeNull();
  });

  it("clears a previous account's address when a different one signs in by username", async () => {
    const store = createStore();
    // Signed up as A, came back to /login without a reload, now signing in as
    // B by handle. Leaving A's address behind would put a resend button on the
    // pending screen that mails the wrong person.
    store.set(verifyEmailAtom, "account-a@example.com");
    signInUsername.mockResolvedValueOnce({
      data: null,
      error: { code: "EMAIL_NOT_VERIFIED", message: "Email not verified" },
    });

    await store.set(signInAtom, { identifier: "account-b", password: "whatever1" });

    expect(store.get(verifyEmailAtom)).toBeNull();
  });

  it("sends no callbackURL, so a successful sign-in is never hard-redirected", async () => {
    const store = createStore();
    signInEmail.mockResolvedValueOnce({ data: { user: { id: "u1" } }, error: null });

    await store.set(signInAtom, { identifier: "alice@example.com", password: "whatever1" });

    // better-auth echoes `callbackURL` back as `{ redirect: true, url }` on the
    // SUCCESS path, and its always-on `redirectPlugin` assigns
    // `window.location.href` to it. Passing one to buy a nicer landing page for
    // the `sendOnSignIn` resend link would therefore send every ordinary
    // sign-in to `/verify-email` and blow away the SPA's own redirect.
    // SAFETY: Vitest's asymmetric matcher is passed through `unknown` on
    // purpose — `not.objectContaining` recognizes it by shape at runtime, and
    // the surrounding assertion is what verifies the call actually happened.
    const anyString: unknown = expect.any(String) as unknown;
    expect(signInEmail).toHaveBeenCalledWith(
      expect.not.objectContaining({ callbackURL: anyString }),
    );
    expect(signInUsername).not.toHaveBeenCalled();
  });

  it('resolves "signed-in" and touches nothing on success', async () => {
    const store = createStore();
    signInUsername.mockResolvedValueOnce({ data: { user: { id: "u1" } }, error: null });

    const outcome = await store.set(signInAtom, { identifier: "alice", password: "whatever1" });

    expect(outcome).toEqual({ status: "signed-in" });
    expect(store.get(authErrorAtom)).toBeNull();
  });
});

describe("signInWithPasskeyAtom", () => {
  it('resolves "banned" and leaves the banner unset on BANNED_USER — issue #74', async () => {
    const store = createStore();
    signInPasskey.mockResolvedValueOnce({ data: null, error: bannedError });

    await expect(store.set(signInWithPasskeyAtom)).resolves.toBe("banned");
    expect(store.get(authErrorAtom)).toBeNull();
  });

  it("stays silent on a cancelled ceremony, same as before this issue", async () => {
    const store = createStore();
    signInPasskey.mockResolvedValueOnce({
      data: null,
      error: { code: "AUTH_CANCELLED", message: "cancelled" },
    });

    await expect(store.set(signInWithPasskeyAtom)).resolves.toBe("failed");
    expect(store.get(authErrorAtom)).toBeNull();
  });

  it('resolves "signed-in" on success', async () => {
    const store = createStore();
    signInPasskey.mockResolvedValueOnce({ data: { user: { id: "u1" } }, error: null });

    await expect(store.set(signInWithPasskeyAtom)).resolves.toBe("signed-in");
  });
});

describe("signUpAtom", () => {
  it("sends legal acceptance evidence only when the box is checked", async () => {
    const store = createStore();

    await store.set(signUpAtom, {
      username: "alice",
      name: "Alice",
      email: "alice@example.com",
      password: "password1",
      dateOfBirth: "1995-01-01",
      legalAccepted: true,
    });

    // SAFETY: Vitest's asymmetric matcher is intentionally passed through
    // `unknown`; `objectContaining` recognizes it at runtime by shape.
    const isoDateMatcher: unknown = expect.stringMatching(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    ) as unknown;
    expect(signUpEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        legalVersion: LEGAL_VERSION,
        legalAcceptedAt: isoDateMatcher,
      }),
    );
  });

  it("omits legal acceptance evidence when the box is unchecked", async () => {
    const store = createStore();

    await store.set(signUpAtom, {
      username: "alice",
      name: "Alice",
      email: "alice@example.com",
      password: "password1",
      dateOfBirth: "1995-01-01",
      legalAccepted: false,
    });

    expect(signUpEmail).toHaveBeenCalledWith(
      expect.not.objectContaining({
        legalAcceptedAt: undefined,
        legalVersion: undefined,
      }),
    );
  });
});

describe("signUpAtom, after email verification landed (issue #172)", () => {
  it("holds onto the address so /verify-email can offer a resend", async () => {
    const store = createStore();

    await store.set(signUpAtom, {
      username: "alice",
      name: "Alice",
      email: "  Alice@Example.com  ",
      password: "password1",
      dateOfBirth: "1995-01-01",
      legalAccepted: true,
    });

    // The trimmed address the sign-up was actually sent with — the resend
    // button targets the same one rather than the raw field value.
    expect(store.get(verifyEmailAtom)).toBe("Alice@Example.com");
  });

  it("asks for the verification link to land back on /verify-email", async () => {
    const store = createStore();

    await store.set(signUpAtom, {
      username: "alice",
      name: "Alice",
      email: "alice@example.com",
      password: "password1",
      dateOfBirth: "1995-01-01",
      legalAccepted: true,
    });

    // Absolute, and pointed at the web origin: Better Auth resolves a relative
    // callbackURL against the API origin, which serves no HTML in dev.
    expect(signUpEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        callbackURL: `${window.location.origin}/verify-email`,
      }),
    );
  });

  it("remembers nothing when the sign-up itself failed", async () => {
    const store = createStore();
    signUpEmail.mockResolvedValueOnce({
      data: null,
      error: { code: "USER_ALREADY_EXISTS", message: "User already exists" },
    });

    await expect(
      store.set(signUpAtom, {
        username: "alice",
        name: "Alice",
        email: "alice@example.com",
        password: "password1",
        dateOfBirth: "1995-01-01",
        legalAccepted: true,
      }),
    ).resolves.toBe(false);

    // No account is pending verification, so the route must not send anyone to
    // the check-your-email screen with a stale address in hand.
    expect(store.get(verifyEmailAtom)).toBeNull();
  });
});

describe("resendVerificationEmailAtom", () => {
  it("requests a fresh link for the address and flags the generic confirmation", async () => {
    const store = createStore();

    await expect(
      store.set(resendVerificationEmailAtom, { email: "pending@example.com" }),
    ).resolves.toBe(true);

    expect(sendVerificationEmail).toHaveBeenCalledWith({
      email: "pending@example.com",
      callbackURL: `${window.location.origin}/verify-email`,
    });
    expect(store.get(verifyEmailSentAtom)).toBe(true);
    expect(store.get(authErrorAtom)).toBeNull();
  });

  it("bakes the pre-login destination into the verification link", async () => {
    const store = createStore();

    await store.set(resendVerificationEmailAtom, {
      email: "pending@example.com",
      redirect: "/settings/account",
    });

    // Inside the callbackURL, not merely in the SPA's history: a link opened
    // in a different browser has no atom or history entry to remember where
    // the person was headed.
    expect(sendVerificationEmail).toHaveBeenCalledWith({
      email: "pending@example.com",
      callbackURL: `${window.location.origin}/verify-email?redirect=%2Fsettings%2Faccount`,
    });
  });

  it("drops an unsafe destination rather than emailing it", async () => {
    const store = createStore();

    await store.set(resendVerificationEmailAtom, {
      email: "pending@example.com",
      redirect: "https://evil.example.com/phish",
    });

    // `?redirect=` arrives from a URL and would otherwise be baked into an
    // emailed link — `sanitizeRedirect` is what stops that becoming an open
    // redirect with our own domain's credibility behind it.
    expect(sendVerificationEmail).toHaveBeenCalledWith({
      email: "pending@example.com",
      callbackURL: `${window.location.origin}/verify-email`,
    });
  });

  it("surfaces a rejected resend in the banner instead of claiming it was sent", async () => {
    const store = createStore();
    sendVerificationEmail.mockResolvedValueOnce({
      data: null,
      error: { code: "TOO_MANY_REQUESTS", message: "Too many requests" },
    });

    await expect(
      store.set(resendVerificationEmailAtom, { email: "pending@example.com" }),
    ).resolves.toBe(false);

    // The rate limit is the abuse control for this endpoint, and being told the
    // link was re-sent when it was not is worse than the error.
    expect(store.get(verifyEmailSentAtom)).toBe(false);
    expect(store.get(authErrorAtom)).toBe("Too many requests");
  });
});
