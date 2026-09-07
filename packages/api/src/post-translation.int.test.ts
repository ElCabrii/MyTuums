import { call } from "@orpc/server";
import { eq } from "drizzle-orm";
import { closeDb, db } from "@my-tuums/db";
import { post, postTranslation } from "@my-tuums/db/schema";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Context } from "./context.js";
import { GoogleTranslationTimeoutError, type Translator } from "./google-translation.js";
import type { TranslationObserver } from "./post-translation.js";
import { appRouter } from "./router.js";
import { contextFor, createTestUser, truncateAll, type TestUser } from "./testing/harness.js";

beforeAll(async () => {
  await truncateAll();
});

afterAll(async () => {
  await truncateAll();
  await closeDb();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function translatingContext(
  user: TestUser,
  translator: Translator,
  observeTranslation?: TranslationObserver,
): Context {
  const context = { ...contextFor(user), translator };
  if (observeTranslation) context.observeTranslation = observeTranslation;
  return context;
}

async function createPost(
  authorId: string,
  content: string,
  quotedPostId?: string,
): Promise<string> {
  const [created] = await db
    .insert(post)
    .values({ authorId, content, quotedPostId })
    .returning({ id: post.id });
  if (!created) throw new Error("Post fixture was not created.");
  return created.id;
}

function fakeTranslator(
  translate: Translator["translate"],
  model = "test-nmt-v1",
): Translator & { translateMock: ReturnType<typeof vi.fn<Translator["translate"]>> } {
  const translateMock = vi.fn(translate);
  return {
    model,
    translate: (...args) => translateMock(...args),
    translateMock,
  };
}

describe("post translation cache (#310)", () => {
  it("translates a cache miss once while preserving authored tokens and line breaks", async () => {
    const author = await createTestUser();
    const viewer = await createTestUser();
    const content = "Hello @alice https://example.com/a #Game\n😀";
    const postId = await createPost(author.id, content);
    const translator = fakeTranslator((contents) =>
      Promise.resolve(
        contents.map((value) => ({
          content: value.replace("Hello", "Bonjour"),
          detectedSourceLocale: "en-US",
        })),
      ),
    );
    const context = translatingContext(viewer, translator);

    const first = await call(
      appRouter.post.list,
      { authorId: author.id, targetLocale: "fr" },
      { context },
    );
    const second = await call(
      appRouter.post.list,
      { authorId: author.id, targetLocale: "fr" },
      { context },
    );

    expect(first.items[0]?.translation).toEqual({
      content: "Bonjour @alice https://example.com/a #Game\n😀",
      sourceLocale: "en",
    });
    expect(second.items[0]?.translation).toEqual(first.items[0]?.translation);
    expect(translator.translateMock).toHaveBeenCalledOnce();
    expect(
      await db.select().from(postTranslation).where(eq(postTranslation.postId, postId)),
    ).toEqual([
      expect.objectContaining({
        targetLocale: "fr",
        providerModel: "test-nmt-v1",
        detectedSourceLocale: "en",
      }),
    ]);
  });

  it("coalesces simultaneous identical cache misses into one provider request", async () => {
    const author = await createTestUser();
    const viewer = await createTestUser();
    await createPost(author.id, "Hello simultaneous readers");
    const translator = fakeTranslator(async (contents) => {
      await new Promise((resolve) => setTimeout(resolve, 25));
      return contents.map((content) => ({
        content: content.replace("Hello", "Bonjour"),
        detectedSourceLocale: "en",
      }));
    });
    const context = translatingContext(viewer, translator);

    const [first, second] = await Promise.all([
      call(appRouter.post.list, { authorId: author.id, targetLocale: "fr" }, { context }),
      call(appRouter.post.list, { authorId: author.id, targetLocale: "fr" }, { context }),
    ]);

    expect(first.items[0]?.translation?.content).toBe("Bonjour simultaneous readers");
    expect(second.items[0]?.translation?.content).toBe("Bonjour simultaneous readers");
    expect(translator.translateMock).toHaveBeenCalledOnce();
  });

  it("observes cache and provider activity without recording post text", async () => {
    const author = await createTestUser();
    const viewer = await createTestUser();
    const content = "Hello metrics";
    await createPost(author.id, content);
    const translator = fakeTranslator((contents) =>
      Promise.resolve(
        contents.map((value) => ({
          content: value.replace("Hello", "Bonjour"),
          detectedSourceLocale: "en",
        })),
      ),
    );
    const observer = vi.fn<TranslationObserver>();
    const context = translatingContext(viewer, translator, observer);

    await call(appRouter.post.list, { authorId: author.id, targetLocale: "fr" }, { context });
    await call(appRouter.post.list, { authorId: author.id, targetLocale: "fr" }, { context });

    expect(observer).toHaveBeenCalledTimes(2);
    const firstObservation = observer.mock.calls[0]?.[0];
    expect(firstObservation).toMatchObject({
      type: "translation",
      requestId: "test-request-id",
      targetLocale: "fr",
      providerModel: "test-nmt-v1",
      cacheHits: 0,
      cacheMisses: 1,
      providerRequests: 1,
      translatedCharacters: 13,
      timeouts: 0,
      providerFailures: 0,
      invalidResults: 0,
      cacheFailures: 0,
    });
    expect(firstObservation?.durationMs).toBeGreaterThanOrEqual(0);
    expect(observer.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({
        cacheHits: 1,
        cacheMisses: 0,
        providerRequests: 0,
        translatedCharacters: 0,
      }),
    );
    expect(JSON.stringify(observer.mock.calls)).not.toContain(content);
  });

  it("counts submitted Unicode code points rather than UTF-16 code units", async () => {
    const author = await createTestUser();
    const viewer = await createTestUser();
    await createPost(author.id, "Go 𐍈");
    const translator = fakeTranslator((contents) =>
      Promise.resolve(
        contents.map((content) => ({
          content: content.replace("Go", "Va"),
          detectedSourceLocale: "en",
        })),
      ),
    );
    const observer = vi.fn<TranslationObserver>();

    await call(
      appRouter.post.list,
      { authorId: author.id, targetLocale: "fr" },
      { context: translatingContext(viewer, translator, observer) },
    );

    expect(observer).toHaveBeenCalledWith(expect.objectContaining({ translatedCharacters: 4 }));
  });

  it("keeps a valid fresh translation when its cache write fails", async () => {
    const author = await createTestUser();
    const viewer = await createTestUser();
    const postId = await createPost(author.id, "Hello cache outage");
    const translator = fakeTranslator((contents) =>
      Promise.resolve(
        contents.map((content) => ({
          content: content.replace("Hello", "Bonjour"),
          detectedSourceLocale: "en",
        })),
      ),
    );
    const observer = vi.fn<TranslationObserver>();
    vi.spyOn(db, "transaction").mockRejectedValueOnce(new Error("cache unavailable"));

    const page = await call(
      appRouter.post.list,
      { authorId: author.id, targetLocale: "fr" },
      { context: translatingContext(viewer, translator, observer) },
    );

    expect(page.items[0]?.translation?.content).toBe("Bonjour cache outage");
    expect(observer).toHaveBeenCalledWith(expect.objectContaining({ cacheFailures: 1 }));
    expect(
      await db.select().from(postTranslation).where(eq(postTranslation.postId, postId)),
    ).toEqual([]);
  });

  it("caches a same-language detection as a non-translation", async () => {
    const author = await createTestUser();
    const viewer = await createTestUser();
    const postId = await createPost(author.id, "Bonjour tout le monde");
    const translator = fakeTranslator((contents) =>
      Promise.resolve(contents.map((content) => ({ content, detectedSourceLocale: "fr" }))),
    );
    const context = translatingContext(viewer, translator);

    const first = await call(
      appRouter.post.list,
      { authorId: author.id, targetLocale: "fr" },
      { context },
    );
    const second = await call(
      appRouter.post.list,
      { authorId: author.id, targetLocale: "fr" },
      { context },
    );

    expect(first.items[0]?.translation).toBeNull();
    expect(second.items[0]?.translation).toBeNull();
    expect(translator.translateMock).toHaveBeenCalledOnce();
    expect(
      await db.select().from(postTranslation).where(eq(postTranslation.postId, postId)),
    ).toEqual([expect.objectContaining({ translatedContent: null, detectedSourceLocale: "fr" })]);
  });

  it("batches a quoted post with its surrounding post without mixing the results", async () => {
    const originalAuthor = await createTestUser();
    const quoter = await createTestUser();
    const viewer = await createTestUser();
    const originalId = await createPost(originalAuthor.id, "Hello original");
    await createPost(quoter.id, "Hello quote", originalId);
    const translator = fakeTranslator((contents) =>
      Promise.resolve(
        contents.map((content) => ({
          content: content.replace("Hello", "Bonjour"),
          detectedSourceLocale: "en",
        })),
      ),
    );

    const page = await call(
      appRouter.post.list,
      { authorId: quoter.id, targetLocale: "fr" },
      { context: translatingContext(viewer, translator) },
    );

    expect(page.items[0]?.translation?.content).toBe("Bonjour quote");
    expect(page.items[0]?.quoted?.translation?.content).toBe("Bonjour original");
    expect(translator.translateMock).toHaveBeenCalledOnce();
    expect(translator.translateMock.mock.calls[0]?.[0]).toHaveLength(2);
  });

  it("runs independent bounded batches concurrently so deadlines do not stack", async () => {
    const originalAuthor = await createTestUser();
    const quoter = await createTestUser();
    const viewer = await createTestUser();
    const content = `Hello ${"x".repeat(494)}`;
    for (let index = 0; index < 26; index += 1) {
      const originalId = await createPost(originalAuthor.id, content);
      await createPost(quoter.id, content, originalId);
    }

    let activeRequests = 0;
    let maximumActiveRequests = 0;
    const translator = fakeTranslator(async (contents) => {
      activeRequests += 1;
      maximumActiveRequests = Math.max(maximumActiveRequests, activeRequests);
      await new Promise((resolve) => setTimeout(resolve, 25));
      activeRequests -= 1;
      return contents.map((value) => ({
        content: value.replace("Hello", "Bonjour"),
        detectedSourceLocale: "en",
      }));
    });

    const page = await call(
      appRouter.post.list,
      { authorId: quoter.id, limit: 50, targetLocale: "fr" },
      { context: translatingContext(viewer, translator) },
    );

    expect(page.items).toHaveLength(26);
    expect(translator.translateMock).toHaveBeenCalledTimes(2);
    expect(maximumActiveRequests).toBe(2);
  });

  it("does not cache a provider result when the post changes in flight", async () => {
    const author = await createTestUser();
    const viewer = await createTestUser();
    const postId = await createPost(author.id, "Hello before edit");
    let requestCount = 0;
    const translator = fakeTranslator(async (contents) => {
      requestCount += 1;
      if (requestCount === 1) {
        await db.update(post).set({ content: "Hello after edit" }).where(eq(post.id, postId));
      }
      return contents.map((content) => ({
        content: content.replace("Hello", "Bonjour"),
        detectedSourceLocale: "en",
      }));
    });
    const context = translatingContext(viewer, translator);

    const first = await call(
      appRouter.post.list,
      { authorId: author.id, targetLocale: "fr" },
      { context },
    );
    expect(first.items[0]?.translation?.content).toBe("Bonjour before edit");
    expect(
      await db.select().from(postTranslation).where(eq(postTranslation.postId, postId)),
    ).toEqual([]);

    const second = await call(
      appRouter.post.list,
      { authorId: author.id, targetLocale: "fr" },
      { context },
    );
    expect(second.items[0]?.translation?.content).toBe("Bonjour after edit");
    expect(translator.translateMock).toHaveBeenCalledTimes(2);
  });

  it("falls back to the original and caches nothing when the provider fails", async () => {
    const author = await createTestUser();
    const viewer = await createTestUser();
    const postId = await createPost(author.id, "Hello failure");
    const translator = fakeTranslator(() => Promise.reject(new Error("quota exhausted")));

    const page = await call(
      appRouter.post.list,
      { authorId: author.id, targetLocale: "fr" },
      { context: translatingContext(viewer, translator) },
    );

    expect(page.items[0]?.content).toBe("Hello failure");
    expect(page.items[0]?.translation).toBeNull();
    expect(
      await db.select().from(postTranslation).where(eq(postTranslation.postId, postId)),
    ).toEqual([]);
  });

  it("counts provider deadlines separately while preserving the original", async () => {
    const author = await createTestUser();
    const viewer = await createTestUser();
    await createPost(author.id, "Hello timeout");
    const translator = fakeTranslator(() => Promise.reject(new GoogleTranslationTimeoutError()));
    const observer = vi.fn<TranslationObserver>();

    const page = await call(
      appRouter.post.list,
      { authorId: author.id, targetLocale: "fr" },
      { context: translatingContext(viewer, translator, observer) },
    );

    expect(page.items[0]?.translation).toBeNull();
    expect(observer).toHaveBeenCalledWith(
      expect.objectContaining({ timeouts: 1, providerFailures: 0 }),
    );
  });

  it("invalidates every cached target locale in the post edit transaction", async () => {
    const author = await createTestUser();
    const postId = await createPost(author.id, "Hello before edit");
    await db.insert(postTranslation).values([
      {
        postId,
        targetLocale: "fr",
        providerModel: "test-nmt-v1",
        translatedContent: "Bonjour avant modification",
        detectedSourceLocale: "en",
      },
      {
        postId,
        targetLocale: "en",
        providerModel: "test-nmt-v1",
        translatedContent: null,
        detectedSourceLocale: "en",
      },
    ]);

    await call(
      appRouter.post.edit,
      { postId, content: "Hello after edit" },
      { context: contextFor(author) },
    );

    expect(
      await db.select().from(postTranslation).where(eq(postTranslation.postId, postId)),
    ).toEqual([]);
  });

  it("never sends tombstoned post text to the provider", async () => {
    const author = await createTestUser();
    const viewer = await createTestUser();
    const postId = await createPost(author.id, "Hidden moderation evidence");
    await db.update(post).set({ removedAt: new Date() }).where(eq(post.id, postId));
    const translator = fakeTranslator(() => Promise.reject(new Error("must not be called")));

    const page = await call(
      appRouter.post.list,
      { authorId: author.id, targetLocale: "fr" },
      { context: translatingContext(viewer, translator) },
    );

    expect(page.items[0]?.content).toBeNull();
    expect(page.items[0]?.translation).toBeNull();
    expect(translator.translateMock).not.toHaveBeenCalled();
  });
});
