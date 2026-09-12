import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { promoteUser } from "@my-tuums/db/promote";
import { createTestDatabase } from "@my-tuums/db/testing/d1";
import { user } from "@my-tuums/db/schema";

describe("D1 moderation bootstrap", () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  beforeAll(async () => {
    database = await createTestDatabase();
  });
  afterAll(async () => {
    await database?.dispose();
  });

  it("allows one concurrent admin appointment and refuses every later out-of-band role change", async () => {
    const db = database.db;
    await db.insert(user).values(
      ["first", "second", "third"].map((username) => ({
        id: crypto.randomUUID(),
        username,
        name: username,
        email: `${username}@example.invalid`,
      })),
    );
    await expect(promoteUser(db, "first", "owner")).rejects.toThrow(/Unknown role/);
    await expect(promoteUser(db, "missing", "admin")).rejects.toThrow(/No user/);
    await expect(promoteUser(db, "third", "moderator")).resolves.toContain("is now moderator");
    const attempts = await Promise.allSettled([
      promoteUser(db, "first", "admin"),
      promoteUser(db, "second", "admin"),
    ]);
    expect(attempts.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(await db.select().from(user).where(eq(user.role, "admin"))).toHaveLength(1);
    await expect(promoteUser(db, "third", "staff")).rejects.toThrow(/Bootstrap is complete/);
    expect(
      await db.select({ role: user.role }).from(user).where(eq(user.username, "third")),
    ).toEqual([{ role: "moderator" }]);
  });
});
