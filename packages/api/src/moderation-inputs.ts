import { z } from "zod";
import {
  MODERATION_NOTE_MAX_LENGTH,
  MODERATION_PAGE_SIZE,
  MODERATION_PAGE_SIZE_MAX,
} from "./constants.js";

/**
 * The two input schemas the moderation router files share.
 *
 * They live in their own leaf module so the router files never import each
 * other: `moderation.ts` assembles the router from `moderation-queue.ts` and
 * `moderation-appeals.ts`, so a shared schema imported from `moderation.ts`
 * would make those files import the module that imports them — a cycle that
 * fails at module evaluation (imports are hoisted, so the shared `const`
 * would still be in the temporal dead zone when the importing file's body
 * runs).
 */

/** A moderator's stated reason or note on an action. */
export const noteInput = z.string().trim().max(MODERATION_NOTE_MAX_LENGTH).optional();

/** The cursor + limit pair every paginated moderation list takes. */
export const queueInput = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(MODERATION_PAGE_SIZE_MAX).default(MODERATION_PAGE_SIZE),
});
