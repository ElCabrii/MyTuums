import { ORPCError } from "@orpc/server";
import { and, eq, ne, or, sql } from "drizzle-orm";
import { z } from "zod";
import { pushSubscription, session } from "@my-tuums/db/schema";
import { protectedProcedure, rateLimit } from "./procedures.js";
import { RATE_LIMITS } from "./rate-limit.js";
import { pushEndpoint, webPushPublicKey } from "./web-push.js";

export const pushRouter = {
  status: protectedProcedure
    .use(rateLimit(RATE_LIMITS.read))
    .input(z.object({}))
    .handler(async ({ context }) => {
      if (!context.session) throw new ORPCError("UNAUTHORIZED");
      const [subscription] = await context.db
        .select({ endpoint: pushSubscription.endpoint, key: pushSubscription.applicationServerKey })
        .from(pushSubscription)
        .where(eq(pushSubscription.sessionId, context.session.session.id));
      return {
        publicKey: context.webPushPublicKey ?? null,
        endpoint:
          subscription && subscription.key === context.webPushPublicKey
            ? subscription.endpoint
            : null,
      };
    }),
  subscribe: protectedProcedure
    .use(rateLimit(RATE_LIMITS.markRead))
    .input(
      z.object({
        endpoint: pushEndpoint,
        applicationServerKey: webPushPublicKey,
      }),
    )
    .handler(async ({ input, context }) => {
      if (!context.session) throw new ORPCError("UNAUTHORIZED");
      if (!context.webPushPublicKey || input.applicationServerKey !== context.webPushPublicKey)
        throw new ORPCError("PRECONDITION_FAILED");
      const sessionId = context.session.session.id;
      // A unique session bounds fan-out to one device per login. No old events are replayed.
      const [existing] = await context.db
        .select({ id: pushSubscription.id })
        .from(pushSubscription)
        .where(
          and(
            eq(pushSubscription.endpoint, input.endpoint),
            sql`${pushSubscription.sessionId} <> ${sessionId}`,
          ),
        );
      if (existing) throw new ORPCError("CONFLICT");
      const [active] = await context.db
        .select({ id: session.id })
        .from(session)
        .where(
          and(
            eq(session.id, sessionId),
            eq(session.userId, context.user.id),
            sql`${session.expiresAt} > cast(unixepoch('subsec') * 1000 as integer)`,
          ),
        );
      if (!active) throw new ORPCError("UNAUTHORIZED");
      // Replacing an endpoint discards its queued work; retrying the same opt-in preserves it.
      await context.db.batch([
        context.db
          .delete(pushSubscription)
          .where(
            and(
              eq(pushSubscription.sessionId, sessionId),
              or(
                ne(pushSubscription.endpoint, input.endpoint),
                ne(pushSubscription.applicationServerKey, input.applicationServerKey),
              ),
            ),
          ),
        context.db
          .insert(pushSubscription)
          .values({ id: crypto.randomUUID(), userId: context.user.id, sessionId, ...input })
          .onConflictDoNothing({ target: pushSubscription.sessionId }),
      ]);
      return { enabled: true };
    }),
  unsubscribe: protectedProcedure
    .use(rateLimit(RATE_LIMITS.markRead))
    .input(z.object({}))
    .handler(async ({ context }) => {
      if (!context.session) throw new ORPCError("UNAUTHORIZED");
      await context.db
        .delete(pushSubscription)
        .where(eq(pushSubscription.sessionId, context.session.session.id));
      return { enabled: false };
    }),
};
