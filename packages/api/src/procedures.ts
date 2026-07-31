import { ORPCError, os } from "@orpc/server";
import type { createContext } from "./context.js";

const base = os.$context<Awaited<ReturnType<typeof createContext>>>();

export const publicProcedure = base;

export const protectedProcedure = base.use(({ context, next }) => {
  if (!context.session?.user) throw new ORPCError("UNAUTHORIZED");
  return next({ context: { ...context, user: context.session.user } });
});
