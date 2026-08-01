import { ORPCError } from "@orpc/server";
import { eq } from "drizzle-orm";
import { user } from "@my-tuums/db/schema";
import { z } from "zod";
import { publicProcedure, rateLimit } from "./procedures.js";
import { RATE_LIMITS } from "./rate-limit.js";

/**
 * The public shape of a user — deliberately not `select()`-all.
 *
 * `email` is the reason this is an explicit list: `appRouter.me` returns the
 * caller's own session user and can include it, but this procedure is public
 * and serves *anyone's* profile, so returning the whole row would hand out
 * every user's email address to any unauthenticated caller. Same for
 * `emailVerified` and `updatedAt`, which are nobody else's business.
 */
const publicUserColumns = {
  id: user.id,
  name: user.name,
  username: user.username,
  displayUsername: user.displayUsername,
  image: user.image,
  createdAt: user.createdAt,
};

export const userRouter = {
  byUsername: publicProcedure
    .use(rateLimit(RATE_LIMITS.read))
    .input(
      z.object({
        // Bounds match the BetterAuth username plugin's own rules (see
        // packages/auth/src/index.ts) so an obviously-invalid handle is
        // rejected at the edge instead of costing a query.
        username: z.string().trim().min(3).max(20),
      }),
    )
    .handler(async ({ input, context }) => {
      // The username plugin stores a normalised (lower-cased) `username`
      // alongside the `displayUsername` the person actually typed, so
      // `/@AlexMercer` and `/@alexmercer` have to resolve to the same
      // profile. Matching on the normalised column is what makes that work
      // — and it keeps the lookup on the unique index rather than forcing a
      // sequential scan the way `lower(username) = ...` would.
      const [found] = await context.db
        .select(publicUserColumns)
        .from(user)
        .where(eq(user.username, input.username.toLowerCase()))
        .limit(1);

      if (!found) {
        throw new ORPCError("NOT_FOUND", { message: "No such user." });
      }

      return found;
    }),
};
