import { ORPCError } from "@orpc/server";
import { z } from "zod";
import type { Context } from "./context.js";
import { VIDEO_INPUT_TYPES, VIDEO_MAX_BYTES } from "./constants.js";
import { protectedProcedure, rateLimit } from "./procedures.js";
import { RATE_LIMITS } from "./rate-limit.js";
import { VideoLifecycleError } from "./video-lifecycle.js";

export function requireVideoUploads(context: Pick<Context, "videoUploads">) {
  if (!context.videoUploads)
    throw new ORPCError("SERVICE_UNAVAILABLE", { message: "Video uploads are unavailable." });
  return context.videoUploads;
}

/** Expected state refusals are safe to show; storage/SQL details stay private. */
export async function videoAction<T>(action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    if (error instanceof VideoLifecycleError)
      throw new ORPCError(error.reason === "not_found" ? "NOT_FOUND" : "BAD_REQUEST", {
        message:
          error.reason === "not_ready"
            ? "The video upload is not complete."
            : "This video is no longer available.",
      });
    if (error instanceof ORPCError) throw error;
    throw new ORPCError("SERVICE_UNAVAILABLE", {
      message: "Video upload was interrupted. Please try again.",
    });
  }
}

const uploadId = z.object({ videoId: z.uuid() });
const read = protectedProcedure.use(rateLimit(RATE_LIMITS.read));
const write = protectedProcedure.use(rateLimit(RATE_LIMITS.write));
export const videoRouter = {
  begin: write
    .input(
      z.object({
        byteSize: z.number().int().min(1).max(VIDEO_MAX_BYTES),
        contentType: z.enum(VIDEO_INPUT_TYPES),
      }),
    )
    .handler(({ input, context }) =>
      videoAction(() => requireVideoUploads(context).begin(context.user.id, input.byteSize)),
    ),
  status: read
    .input(uploadId)
    .handler(({ input, context }) =>
      videoAction(() => requireVideoUploads(context).status(input.videoId, context.user.id)),
    ),
  finish: write
    .input(uploadId)
    .handler(({ input, context }) =>
      videoAction(() => requireVideoUploads(context).finish(input.videoId, context.user.id)),
    ),
  cancel: write.input(uploadId).handler(async ({ input, context }) => {
    await videoAction(() => requireVideoUploads(context).cancel(input.videoId, context.user.id));
    return { videoId: input.videoId };
  }),
  pending: read
    .input(z.object({}))
    .handler(({ context }) =>
      videoAction(() => requireVideoUploads(context).pending(context.user.id)),
    ),
};
