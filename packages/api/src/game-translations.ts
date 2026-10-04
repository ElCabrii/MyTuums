import { and, asc, gt, sql } from "drizzle-orm";
import type { Database } from "@my-tuums/db";
import { game, gameSummaryTranslation } from "@my-tuums/db/schema";
import type { LocalePreference } from "@my-tuums/auth/rules";
import { z } from "zod";
import { GAME_SUMMARY_MAX_LENGTH } from "./constants.js";

/** Both the read and the pending scan require an exact match to the English source. */
function currentTranslation(locale: LocalePreference) {
  return sql`(select ${gameSummaryTranslation.summary} from ${gameSummaryTranslation}
    where ${gameSummaryTranslation.gameId} = ${game.igdbId}
      and ${gameSummaryTranslation.locale} = ${locale}
      and ${gameSummaryTranslation.sourceSummary} = ${game.summary})`;
}

export function localizedGameSummary(locale: LocalePreference) {
  return locale === "en"
    ? game.summary
    : sql<string | null>`coalesce(${currentTranslation(locale)}, ${game.summary})`;
}

const translatedSummary = z
  .string()
  .trim()
  .min(1)
  .max(GAME_SUMMARY_MAX_LENGTH * 4);
const BATCH_SIZE = 25;

/** One bounded, restartable pass. Provider failures stay pending for the next sync. */
export async function translateGameSummaries({
  db,
  translate,
  afterGameId,
}: {
  db: Database;
  translate: (text: string) => Promise<string>;
  afterGameId: number;
}) {
  const candidates = await db
    .select({ id: game.igdbId, summary: game.summary })
    .from(game)
    .where(
      and(
        gt(game.igdbId, afterGameId),
        sql`length(trim(${game.summary})) > 0`,
        sql`${currentTranslation("fr")} is null`,
      ),
    )
    .orderBy(asc(game.igdbId))
    .limit(BATCH_SIZE + 1);
  const page = candidates.slice(0, BATCH_SIZE);
  let translated = 0;
  let failed = 0;
  for (const candidate of page) {
    if (candidate.summary === null) continue;
    let summary: string;
    try {
      summary = translatedSummary.parse(await translate(candidate.summary));
    } catch {
      failed += 1;
      continue;
    }
    // The provider call can outlive a catalog refresh. Compare again inside
    // the write so a late result cannot replace a newer source's translation.
    const saved = await db
      .insert(gameSummaryTranslation)
      .select(
        sql`select ${game.igdbId}, 'fr', ${candidate.summary}, ${summary}
        from ${game} where ${game.igdbId} = ${candidate.id} and ${game.summary} = ${candidate.summary}`,
      )
      .onConflictDoUpdate({
        target: [gameSummaryTranslation.gameId, gameSummaryTranslation.locale],
        set: { sourceSummary: candidate.summary, summary },
      })
      .returning({ id: gameSummaryTranslation.gameId });
    translated += saved.length;
  }
  return {
    translated,
    failed,
    afterGameId: page.at(-1)?.id ?? afterGameId,
    hasMore: candidates.length > BATCH_SIZE,
  };
}
