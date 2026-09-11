import type { Auth, OutgoingEmail } from "@my-tuums/auth";
import type { Database } from "@my-tuums/db";
import type { LinkFetchTransport } from "./link-card-http.js";
import type { RateLimiter } from "./rate-limit.js";
import type { ObjectStorage } from "./object-storage.js";
import type { VideoUploads } from "./video-uploads.js";

import type { AppealTokenSigner } from "./appeal-token.js";

type Session = Awaited<ReturnType<Auth["api"]["getSession"]>>;

/** The session user shared by the procedure authorization middleware. */
export type SessionUser = NonNullable<Session>["user"];

export interface EmailSender {
  send: (email: OutgoingEmail) => Promise<void>;
}

/** Environment dependencies are bound by the HTTP entrypoint, never at import time. */
export interface ApiServices {
  db: Database;
  rateLimiter: RateLimiter;
  storage: ObjectStorage | null;
  videoUploads: VideoUploads | null;
  linkTransport: LinkFetchTransport;
  emailSender: EmailSender;
  webOrigin: string;
  appealToken: AppealTokenSigner;
}

export interface Context extends ApiServices {
  session: Session;
  /** Set by procedure middleware after checking its authorization requirements. */
  user?: SessionUser;
  requestId: string;
  /** The HTTP boundary must establish trusted client identity before passing these headers. */
  headers?: Headers;
}

export async function createContext({
  auth,
  headers,
  requestId,
  ...services
}: ApiServices & { auth: Auth; headers: Headers; requestId: string }): Promise<Context> {
  const session = await auth.api.getSession({ headers });
  return { ...services, session, requestId, headers };
}
