import { useEffect } from "react";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { useAtomValue } from "jotai";
import { needsCompletionAtom } from "@/atoms/session";

/** Where an incomplete session is allowed to be. */
const ALLOWED_WITHOUT_HANDLE = new Set(["/welcome", "/privacy", "/terms", "/mentions-legales"]);

/**
 * Holds a signed-in account at `/welcome` until it finishes the missing half
 * of its sign-up — a handle and/or a date of birth.
 *
 * Mounted once in `__root.tsx`, so it covers every route rather than the
 * handful that happen to remember to check. See `needsCompletionAtom`
 * (`atoms/session.ts`) for why an incomplete session is treated as an
 * incomplete sign-up rather than a state to render around: without a handle
 * there is no profile URL to link to, and much of the app's navigation is
 * built from one; without a date of birth the account cannot stand against
 * the 15+ rule.
 *
 * The legal pages are exempt because a sign-up gate that will not let someone
 * read the terms they are being asked to accept is its own problem. `/welcome`
 * is exempt for the obvious reason — gating it on having a handle would trap
 * the session in a redirect loop.
 *
 * The check is on the pathname prefix rather than the route id because this
 * runs above the router's matched route; `useLocation` is what re-runs it on
 * navigation, and leaving it out would let the first client-side navigation
 * after sign-up escape the gate.
 *
 * A hook rather than an `atomEffect`, for the same reason as
 * `use-redirect-when-signed-in.ts`: it needs the router's `navigate`, and an
 * atom that imported the router would cycle through `main.tsx`.
 */
export function useRequireHandle(): void {
  const navigate = useNavigate();
  const needsCompletion = useAtomValue(needsCompletionAtom);
  const { pathname } = useLocation();

  useEffect(() => {
    if (!needsCompletion) return;
    if (ALLOWED_WITHOUT_HANDLE.has(pathname)) return;

    // `replace` so the back button doesn't bounce between the gate and the
    // page that triggered it.
    void navigate({ to: "/welcome", replace: true });
  }, [needsCompletion, pathname, navigate]);
}
