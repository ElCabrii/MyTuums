import { and, eq, inArray, sql } from "drizzle-orm";
import type { Database } from "@my-tuums/db";
import { post, postTranslation } from "@my-tuums/db/schema";
import {
  GoogleTranslationTimeoutError,
  type TranslationTargetLocale,
  type Translator,
} from "./google-translation.js";

const TRANSLATION_BATCH_MAX_ITEMS = 100;
const TRANSLATION_BATCH_MAX_CHARACTERS = 25_000;
const TRANSLATION_MAX_RESULT_CHARACTERS = 2_000;

const protectedContentPattern =
  /\r\n|\r|\n|https?:\/\/[^\s<>"\p{Cc}]+|@[a-zA-Z0-9_]+|#[\p{L}\p{M}\p{N}_]+|\p{Regional_Indicator}{2}|[#*0-9]\uFE0F?\u20E3|\p{Extended_Pictographic}(?:\uFE0F|\u200D\p{Extended_Pictographic}\uFE0F?)*/gu;

export interface PostTranslationView {
  content: string;
  sourceLocale: TranslationTargetLocale;
}

/** Content-free counters emitted once for each translation overlay attempt. */
export interface TranslationObservation {
  type: "translation";
  requestId: string;
  targetLocale: TranslationTargetLocale;
  providerModel: string;
  cacheHits: number;
  cacheMisses: number;
  providerRequests: number;
  translatedCharacters: number;
  timeouts: number;
  providerFailures: number;
  invalidResults: number;
  cacheFailures: number;
  durationMs: number;
}

export type TranslationObserver = (observation: TranslationObservation) => void;

interface QuotedTranslationRow {
  id: string;
  content: string | null;
  translation?: PostTranslationView | null;
}

export interface PostTranslationRow {
  id: string;
  content: string | null;
  unavailable: boolean;
  private: boolean;
  translation?: PostTranslationView | null;
  quoted: QuotedTranslationRow | null;
}

interface ProtectedContent {
  content: string;
  restore: (translated: string) => string | null;
}

interface CacheValue {
  translatedContent: string | null;
  detectedSourceLocale: string;
}

interface TranslationWork {
  flightKey: string;
  postId: string;
  sourceContent: string;
  protected: ProtectedContent;
}

type TranslationFlightResult =
  { status: "resolved"; value: CacheValue | undefined } | { status: "failed" };

interface TranslationFlight {
  promise: Promise<TranslationFlightResult>;
  resolve: (result: TranslationFlightResult) => void;
}

function createTranslationFlight(): TranslationFlight {
  let resolveFlight: TranslationFlight["resolve"] | undefined;
  const promise = new Promise<TranslationFlightResult>((resolve) => {
    resolveFlight = resolve;
  });
  if (!resolveFlight) {
    throw new Error("Translation flight did not initialize synchronously.");
  }
  return { promise, resolve: resolveFlight };
}

/** Coalesces in-flight post versions without sharing viewer-specific post rows. */
export interface TranslationCoordinator {
  resolve(
    values: readonly TranslationWork[],
    operation: (owned: readonly TranslationWork[]) => Promise<ReadonlyMap<string, CacheValue>>,
  ): Promise<ReadonlyMap<string, CacheValue>>;
}

export function createTranslationCoordinator(): TranslationCoordinator {
  const active = new Map<string, TranslationFlight>();

  return {
    async resolve(values, operation) {
      const waiting: Array<{ postId: string; promise: Promise<TranslationFlightResult> }> = [];
      const owned: Array<{ work: TranslationWork; flight: TranslationFlight }> = [];

      for (const work of values) {
        let flight = active.get(work.flightKey);
        if (!flight) {
          flight = createTranslationFlight();
          active.set(work.flightKey, flight);
          owned.push({ work, flight });
        }
        waiting.push({ postId: work.postId, promise: flight.promise });
      }

      if (owned.length > 0) {
        const completion = Promise.resolve().then(() =>
          operation(owned.map((claim) => claim.work)),
        );
        void completion.then(
          (resolved) => {
            for (const claim of owned) {
              if (active.get(claim.work.flightKey) === claim.flight) {
                active.delete(claim.work.flightKey);
              }
              claim.flight.resolve({
                status: "resolved",
                value: resolved.get(claim.work.postId),
              });
            }
          },
          () => {
            for (const claim of owned) {
              if (active.get(claim.work.flightKey) === claim.flight) {
                active.delete(claim.work.flightKey);
              }
              claim.flight.resolve({ status: "failed" });
            }
          },
        );
      }

      const settled = await Promise.all(
        waiting.map(async ({ postId, promise }) => ({ postId, result: await promise })),
      );
      if (settled.some(({ result }) => result.status === "failed")) {
        throw new Error("Translation coordination failed.");
      }
      return new Map(
        settled.flatMap(({ postId, result }) =>
          result.status === "resolved" && result.value ? [[postId, result.value] as const] : [],
        ),
      );
    },
  };
}

function normalizeDetectedLocale(locale: string | null): string | null {
  const normalized = locale?.trim().toLowerCase().split("-")[0];
  return normalized && /^[a-z]{2,3}$/.test(normalized) ? normalized : null;
}

function supportedSourceLocale(locale: string): TranslationTargetLocale | null {
  return locale === "en" || locale === "fr" ? locale : null;
}

function protectContent(content: string): ProtectedContent {
  let salt = 0;
  while (content.includes(`__MYTUUMS_PROTECTED_${salt}_`)) salt += 1;

  const values: string[] = [];
  const prefix = `__MYTUUMS_PROTECTED_${salt}_`;
  const protectedContent = content.replace(protectedContentPattern, (value) => {
    const marker = `${prefix}${values.length}__`;
    values.push(value);
    return marker;
  });

  return {
    content: protectedContent,
    restore(translated) {
      let restored = translated;
      for (const [index, value] of values.entries()) {
        const marker = `${prefix}${index}__`;
        const first = restored.indexOf(marker);
        if (first === -1 || restored.indexOf(marker, first + marker.length) !== -1) return null;
        restored = `${restored.slice(0, first)}${value}${restored.slice(first + marker.length)}`;
      }
      if (restored.includes(prefix)) return null;
      const trimmed = restored.trim();
      if (trimmed.length === 0 || restored.length > TRANSLATION_MAX_RESULT_CHARACTERS) return null;
      return restored;
    },
  };
}

function translationView(
  value: CacheValue | undefined,
  targetLocale: TranslationTargetLocale,
): PostTranslationView | null {
  if (!value?.translatedContent) return null;
  const sourceLocale = supportedSourceLocale(value.detectedSourceLocale);
  if (!sourceLocale || sourceLocale === targetLocale) return null;
  return { content: value.translatedContent, sourceLocale };
}

function observeSafely(observer: TranslationObserver, observation: TranslationObservation): void {
  try {
    observer(observation);
  } catch {
    // Observability must never replace the original-post fallback.
  }
}

function characterCount(value: string): number {
  return [...value].length;
}

function translationFlightKey(
  providerModel: string,
  targetLocale: TranslationTargetLocale,
  postId: string,
  sourceContent: string,
): string {
  return JSON.stringify([providerModel, targetLocale, postId, sourceContent]);
}

function batches<T extends { protected: ProtectedContent }>(values: readonly T[]): T[][] {
  const result: T[][] = [];
  let batch: T[] = [];
  let characters = 0;

  for (const value of values) {
    const nextCharacters = characterCount(value.protected.content);
    if (
      batch.length > 0 &&
      (batch.length >= TRANSLATION_BATCH_MAX_ITEMS ||
        characters + nextCharacters > TRANSLATION_BATCH_MAX_CHARACTERS)
    ) {
      result.push(batch);
      batch = [];
      characters = 0;
    }
    batch.push(value);
    characters += nextCharacters;
  }
  if (batch.length > 0) result.push(batch);
  return result;
}

async function storeStableResults(
  db: Database,
  targetLocale: TranslationTargetLocale,
  providerModel: string,
  values: ReadonlyArray<{
    postId: string;
    sourceContent: string;
    cache: CacheValue;
  }>,
): Promise<void> {
  await db.transaction(async (tx) => {
    const liveRows = await tx
      .select({ id: post.id, content: post.content })
      .from(post)
      .where(
        inArray(
          post.id,
          values.map((value) => value.postId),
        ),
      )
      .for("share");
    const liveContent = new Map(liveRows.map((row) => [row.id, row.content]));
    const stable = values.filter((value) => liveContent.get(value.postId) === value.sourceContent);
    if (stable.length === 0) return;

    await tx
      .insert(postTranslation)
      .values(
        stable.map((value) => ({
          postId: value.postId,
          targetLocale,
          providerModel,
          translatedContent: value.cache.translatedContent,
          detectedSourceLocale: value.cache.detectedSourceLocale,
        })),
      )
      .onConflictDoUpdate({
        target: [
          postTranslation.postId,
          postTranslation.targetLocale,
          postTranslation.providerModel,
        ],
        set: {
          translatedContent: sql`excluded.translated_content`,
          detectedSourceLocale: sql`excluded.detected_source_locale`,
        },
      });
  });
}

/**
 * Adds cached or freshly resolved translations to rows that have already
 * passed post visibility filtering. Cache reads and provider failures leave
 * rows on their original text; a cache-write failure keeps a valid fresh
 * result for this response. Failed and malformed provider results are not cached.
 */
export async function withPostTranslations<T extends PostTranslationRow>(
  db: Database,
  translator: Translator | null,
  coordinator: TranslationCoordinator,
  targetLocale: TranslationTargetLocale | undefined,
  rows: readonly T[],
  requestId: string,
  observer: TranslationObserver,
): Promise<T[]> {
  if (!translator || !targetLocale || rows.length === 0) return [...rows];

  const sources = new Map<string, string>();
  for (const row of rows) {
    if (row.content && !row.unavailable && !row.private) sources.set(row.id, row.content);
    if (row.quoted?.content) sources.set(row.quoted.id, row.quoted.content);
  }
  if (sources.size === 0) return [...rows];

  const startedAt = performance.now();
  const metrics = {
    cacheHits: 0,
    cacheMisses: 0,
    providerRequests: 0,
    translatedCharacters: 0,
    timeouts: 0,
    providerFailures: 0,
    invalidResults: 0,
    cacheFailures: 0,
  };

  try {
    const cachedRows = await db
      .select({
        postId: postTranslation.postId,
        translatedContent: postTranslation.translatedContent,
        detectedSourceLocale: postTranslation.detectedSourceLocale,
      })
      .from(postTranslation)
      .where(
        and(
          inArray(postTranslation.postId, [...sources.keys()]),
          eq(postTranslation.targetLocale, targetLocale),
          eq(postTranslation.providerModel, translator.model),
        ),
      );
    const cache = new Map(
      cachedRows.map((row) => [
        row.postId,
        {
          translatedContent: row.translatedContent,
          detectedSourceLocale: row.detectedSourceLocale,
        },
      ]),
    );
    metrics.cacheHits = cache.size;
    const misses = [...sources]
      .filter(([postId]) => !cache.has(postId))
      .map(([postId, sourceContent]) => ({
        flightKey: translationFlightKey(translator.model, targetLocale, postId, sourceContent),
        postId,
        sourceContent,
        protected: protectContent(sourceContent),
      }));
    metrics.cacheMisses = misses.length;

    const fresh =
      misses.length === 0
        ? new Map<string, CacheValue>()
        : await coordinator.resolve(misses, async (owned) => {
            const resolvedForResponse = new Map<string, CacheValue>();
            await Promise.all(
              batches(owned).map(async (batch) => {
                let translated;
                metrics.providerRequests += 1;
                try {
                  translated = await translator.translate(
                    batch.map((value) => value.protected.content),
                    targetLocale,
                  );
                  metrics.translatedCharacters += batch.reduce(
                    (total, value) => total + characterCount(value.protected.content),
                    0,
                  );
                } catch (error) {
                  if (error instanceof GoogleTranslationTimeoutError) metrics.timeouts += 1;
                  else metrics.providerFailures += 1;
                  return;
                }

                const resolved = batch.flatMap((value, index) => {
                  const result = translated[index];
                  const detectedSourceLocale = normalizeDetectedLocale(
                    result?.detectedSourceLocale ?? null,
                  );
                  if (!result || !detectedSourceLocale) {
                    metrics.invalidResults += 1;
                    return [];
                  }

                  const sourceLocale = supportedSourceLocale(detectedSourceLocale);
                  const translatedContent =
                    sourceLocale && sourceLocale !== targetLocale
                      ? value.protected.restore(result.content)
                      : null;
                  if (sourceLocale && sourceLocale !== targetLocale && !translatedContent) {
                    metrics.invalidResults += 1;
                    return [];
                  }

                  return [
                    {
                      postId: value.postId,
                      sourceContent: value.sourceContent,
                      cache: { translatedContent, detectedSourceLocale },
                    },
                  ];
                });
                if (resolved.length === 0) return;

                // A cache outage must not discard a valid provider response from
                // this request. The live-content check still decides whether it is
                // safe to persist for later requests; either way it matches the
                // rows already selected for this response.
                for (const value of resolved) resolvedForResponse.set(value.postId, value.cache);
                try {
                  await storeStableResults(db, targetLocale, translator.model, resolved);
                } catch {
                  metrics.cacheFailures += 1;
                }
              }),
            );
            return resolvedForResponse;
          });
    for (const [postId, value] of fresh) cache.set(postId, value);

    return rows.map((row) => {
      return {
        ...row,
        translation: translationView(cache.get(row.id), targetLocale),
        quoted: row.quoted
          ? {
              ...row.quoted,
              translation: translationView(cache.get(row.quoted.id), targetLocale),
            }
          : null,
      };
    });
  } catch {
    metrics.cacheFailures += 1;
    return [...rows];
  } finally {
    observeSafely(observer, {
      type: "translation",
      requestId,
      targetLocale,
      providerModel: translator.model,
      ...metrics,
      durationMs: Math.round(performance.now() - startedAt),
    });
  }
}
