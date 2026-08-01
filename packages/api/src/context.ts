import { auth } from "@my-tuums/auth";
import { db, type Database } from "@my-tuums/db";

type Session = Awaited<ReturnType<typeof auth.api.getSession>>;

export interface Context {
  db: Database;
  session: Session;
  /**
   * The caller's IP, as resolved by the transport (see
   * apps/server/src/client-ip.ts). It is the rate limiter's fallback identity
   * for anonymous callers, who have no user id to key on.
   *
   * Optional because it is transport-specific: `call()` in tests, and any
   * future in-process caller, have no socket behind them. A missing IP is
   * treated as one shared bucket rather than as "unlimited" — see
   * ./procedures.ts.
   */
  clientIp?: string;
}

export async function createContext({
  headers,
  clientIp,
}: {
  headers: Headers;
  clientIp?: string;
}): Promise<Context> {
  const session = await auth.api.getSession({ headers });
  return { db, session, clientIp };
}
