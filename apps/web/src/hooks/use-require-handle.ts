import { useEffect } from "react";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { useAtomValue } from "jotai";
import { needsHandleAtom } from "@/atoms/session";

/** Where a handle-less session is allowed to be. */
const ALLOWED_WITHOUT_HANDLE = new Set(["/welcome", "/privacy", "/terms", "/mentions-legales"]);

/**
 * Holds a signed-in account with no handle at `/welcome` until it claims one.
 *
 * Mounted once in `__root.tsx`, so it covers every route rather than the
 * handful that happen to remember to check. See `needsHandleAtom`
 * (`atoms/session.ts`) for why a handle-less session is treated as an
 * incomplete sign-up rather than a state to render around: without a handle
 * there is no profile URL to link to, and much of the app's navigation is
 * built from one.
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
  const needsHandle = useAtomValue(needsHandleAtom);
  const { pathname } = useLocation();

  useEffect(() => {
    if (!needsHandle) return;
    if (ALLOWED_WITHOUT_HANDLE.has(pathname)) return;

    // `replace` so the back button doesn't bounce between the gate and the
    // page that triggered it.
    void navigate({ to: "/welcome", replace: true });
  }, [needsHandle, pathname, navigate]);
}
