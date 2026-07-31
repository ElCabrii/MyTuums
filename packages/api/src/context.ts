import { auth } from "@my-tuums/auth";
import { db } from "@my-tuums/db";

export async function createContext({ headers }: { headers: Headers }) {
  const session = await auth.api.getSession({ headers });
  return { db, session };
}
