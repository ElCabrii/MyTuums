import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { createTestDatabase } from "@my-tuums/db/testing/d1";
import { follow, post, postLike, session, user } from "@my-tuums/db/schema";
import { createAuth, type OutgoingEmail } from "@my-tuums/auth";
import { LEGAL_VERSION } from "@my-tuums/auth/rules";
import { createCursorCodec } from "./cursor.js";
import { keysetPage } from "./pagination.js";

describe("D1 relational and atomicity contracts", () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  beforeAll(async () => {
    database = await createTestDatabase();
  });
  afterAll(async () => {
    await database?.dispose();
  });

  it("round-trips millisecond timestamps and supplies SQL timestamp defaults", async () => {
    const db = database.db;
    const id = crypto.randomUUID();
    await db.insert(user).values({ id, name: "Author", email: `${id}@example.invalid` });
    const instant = new Date("2026-09-10T12:34:56.789Z");
    const [created] = await db
      .insert(post)
      .values({ authorId: id, content: "Post", createdAt: instant })
      .returning();
    const [stored] = await db.select().from(post).where(eq(post.id, created.id));
    expect(stored.createdAt.toISOString()).toBe(instant.toISOString());
    const [author] = await db.select().from(user).where(eq(user.id, id));
    expect(author.createdAt.getTime()).toBeGreaterThan(Date.now() - 60_000);
  });

  it("rolls back the whole batch when a later statement violates a foreign key", async () => {
    const db = database.db;
    const id = crypto.randomUUID();
    await expect(
      db.batch([
        db.insert(user).values({ id, name: "Rollback", email: `${id}@example.invalid` }),
        db.insert(follow).values({ followerId: id, followingId: "missing-user" }),
      ]),
    ).rejects.toThrow();
    expect(await db.select().from(user).where(eq(user.id, id))).toEqual([]);
  });

  it("normalizes direct handle writes and refuses case-folded collisions", async () => {
    const db = database.db;
    const id = crypto.randomUUID();
    const handle = `u${id.replaceAll("-", "").slice(0, 12)}`;
    await db.insert(user).values({
      id,
      name: "Handle",
      email: `${id}@example.invalid`,
      username: handle.toUpperCase(),
      displayUsername: "different",
    });
    const [stored] = await db.select().from(user).where(eq(user.id, id));
    expect([stored.username, stored.displayUsername]).toEqual([handle, handle]);
    await expect(
      db.insert(user).values({
        id: crypto.randomUUID(),
        name: "Collision",
        email: `other-${id}@example.invalid`,
        username: handle.toUpperCase(),
      }),
    ).rejects.toThrow();
    await db.update(user).set({ username: null }).where(eq(user.id, id));
    const [cleared] = await db.select().from(user).where(eq(user.id, id));
    expect(cleared.displayUsername).toBeNull();
  });

  it("walks tied millisecond cursor boundaries without skipping or repeating rows", async () => {
    const db = database.db;
    const authorId = crypto.randomUUID();
    await db
      .insert(user)
      .values({ id: authorId, name: "Cursor", email: `${authorId}@example.invalid` });
    const instant = new Date("2026-09-10T12:34:56.789Z");
    const inserted = await db
      .insert(post)
      .values(
        Array.from({ length: 7 }, () => ({
          authorId,
          content: "Tied timestamp",
          createdAt: instant,
        })),
      )
      .returning({ id: post.id });
    const codec = createCursorCodec(z.uuid());
    const selection = { id: post.id, createdAt: post.createdAt };
    const ids: string[] = [];
    let cursor: string | undefined;
    for (let pageNumber = 0; pageNumber < 5; pageNumber++) {
      const page = await keysetPage({
        codec,
        cursor,
        limit: 2,
        selection,
        createdAt: post.createdAt,
        createdAtField: "createdAt",
        id: post.id,
        idField: "id",
        fetchPage: (filter) =>
          db
            .select(selection)
            .from(post)
            .where(and(eq(post.authorId, authorId), filter))
            .orderBy(desc(post.createdAt), desc(post.id))
            .limit(3),
      });
      ids.push(...page.items.map((item) => item.id));
      if (page.nextCursor === null) break;
      cursor = page.nextCursor;
    }
    expect(ids).toEqual(
      inserted
        .map((item) => item.id)
        .sort()
        .reverse(),
    );
  });

  it("makes concurrent duplicate reactions idempotent through the composite key", async () => {
    const db = database.db;
    const id = crypto.randomUUID();
    await db.insert(user).values({ id, name: "Reactor", email: `${id}@example.invalid` });
    const [created] = await db
      .insert(post)
      .values({ authorId: id, content: "Reaction target" })
      .returning();
    await Promise.all(
      Array.from({ length: 8 }, () =>
        db.insert(postLike).values({ userId: id, postId: created.id }).onConflictDoNothing(),
      ),
    );
    expect(await db.select().from(postLike).where(eq(postLike.postId, created.id))).toHaveLength(1);
    await db.delete(user).where(eq(user.id, id));
    expect(await db.select().from(post).where(eq(post.id, created.id))).toEqual([]);
    expect(await db.select().from(postLike).where(eq(postLike.postId, created.id))).toEqual([]);
  });

  it("deletes deep reply trees with an account without deleting unrelated posts or quotes", async () => {
    const db = database.db;
    const authorId = crypto.randomUUID();
    const replierId = crypto.randomUUID();
    await db.insert(user).values([
      { id: authorId, name: "Root author", email: `${authorId}@example.invalid` },
      { id: replierId, name: "Replier", email: `${replierId}@example.invalid` },
    ]);
    const rootId = crypto.randomUUID();
    await db.insert(post).values({ id: rootId, authorId, content: "Root" });
    let parentId = rootId;
    for (let depth = 0; depth < 120; depth++) {
      const id = crypto.randomUUID();
      await db.insert(post).values({ id, authorId: replierId, parentId, content: "Deep reply" });
      parentId = id;
    }
    const [quote] = await db
      .insert(post)
      .values({
        authorId: replierId,
        quotedPostId: rootId,
        content: "Surviving quote",
      })
      .returning();
    const [unrelated] = await db
      .insert(post)
      .values({ authorId: replierId, content: "Unrelated" })
      .returning();
    await db.delete(user).where(eq(user.id, authorId));
    expect(await db.select({ id: post.id }).from(post).where(eq(post.authorId, replierId))).toEqual(
      expect.arrayContaining([{ id: quote.id }, { id: unrelated.id }]),
    );
    expect(await db.select().from(post).where(eq(post.authorId, replierId))).toHaveLength(2);
    expect(await db.select().from(user).where(eq(user.id, replierId))).toHaveLength(1);
  });

  it("requires verification and stops authenticating a revoked session immediately", async () => {
    const db = database.db;
    const messages: OutgoingEmail[] = [];
    const auth = createAuth({
      db,
      origin: "http://localhost:8787",
      secret: "d1-integration-only-secret-at-least-32-chars",
      rateLimitEnabled: false,
      sendEmail: (message) => {
        messages.push(message);
        return Promise.resolve();
      },
    });
    const email = `${crypto.randomUUID()}@example.com`;
    const password = `test-only-${crypto.randomUUID()}`;
    const created = await auth.api.signUpEmail({
      body: {
        email,
        password,
        name: "D1 auth",
        username: `d1${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`,
        legalAcceptedAt: new Date(),
        legalVersion: LEGAL_VERSION,
      },
    });
    expect(created.token).toBeNull();
    expect(messages.some((message) => message.to === email)).toBe(true);
    await expect(auth.api.signInEmail({ body: { email, password } })).rejects.toThrow();
    await db.update(user).set({ emailVerified: true }).where(eq(user.id, created.user.id));
    const signedIn = await auth.api.signInEmail({ body: { email, password }, returnHeaders: true });
    const headers = new Headers({
      cookie: signedIn.headers
        .getSetCookie()
        .map((cookie) => cookie.split(";")[0])
        .join("; "),
    });
    expect((await auth.api.getSession({ headers }))?.user.id).toBe(created.user.id);
    await db.delete(session).where(eq(session.userId, created.user.id));
    expect(await auth.api.getSession({ headers })).toBeNull();
  });
});
