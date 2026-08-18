import { useAtomValue } from "jotai";
import { roleAtLeast, type UserRole } from "@my-tuums/api/roles";
import { viewerRoleAtom } from "@/atoms/session";

/**
 * True when the signed-in viewer's role is at least `min` — the client half
 * of the moderation route gate (used by `routes/moderation.tsx` and the
 * header's Moderation nav item).
 *
 * The server is the real enforcement: every moderation procedure checks the
 * role on the session, so a client that gets this wrong only misdraws a
 * page whose data calls all 403. This hook exists purely so a route can
 * decide what to render (queue vs forbidden page, staff-only tabs) before
 * its first query fires.
 *
 * Mirrors the shape of the other gates in this directory: a pure read of
 * the atom graph, no navigation. Routes that gate on this render
 * `RoleForbiddenPage` themselves rather than redirecting — a moderator
 * reaching a staff tab should see "you can't", not a loop.
 */
export function useRequireRole(min: UserRole): boolean {
  return roleAtLeast(useAtomValue(viewerRoleAtom), min);
}
