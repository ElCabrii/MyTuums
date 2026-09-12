import { createAppealTokenSigner } from "../appeal-token.js";
import { afterAll } from "vitest";
import { createTestDatabase } from "@my-tuums/db/testing/d1";
import { createAuth, type OutgoingEmail } from "@my-tuums/auth";
import { createTestAuth, testHelpers as resolveTestHelpers } from "@my-tuums/auth/testing";

// Each Vitest file gets an ephemeral database. This module has no route to a
// remote binding, even if a developer's shell contains production credentials.
const local = await createTestDatabase();
export const db = local.db;
export const webOrigin = "http://localhost:3001";
const secret = "vitest-integration-secret-at-least-32-chars";
export const appealToken = createAppealTokenSigner(secret);
export const authEmails: OutgoingEmail[] = [];
export const auth = createAuth({
  db,
  origin: webOrigin,
  secret,
  sendEmail: (email) => {
    authEmails.push(email);
    return Promise.resolve();
  },
});
export const authTest = createTestAuth(db, webOrigin, secret);
export const testHelpers = () => resolveTestHelpers(authTest);

let closing: Promise<void> | undefined;
export function closeDb(): Promise<void> {
  closing ??= local.dispose();
  return closing;
}
afterAll(closeDb);
